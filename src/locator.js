const { APP_USER_AGENT, ESI_BASE } = require('./app_ident');   // ESI_BASE/identity: one definition, src/shared/esi.js
// ─── locator.js ───────────────────────────────────────────────────────────────
// Centralised EVE location resolver.
//
// EVE has three ID ranges for locations:
//   < 100,000,000          → solar systems / constellations / regions (public ESI)
//   60,000,000–64,000,000  → NPC stations (public ESI /universe/stations/)
//   >= 1,000,000,000,000   → player-owned structures (Citadels, ECs, Refineries…)
//                            Resolution chain:
//                              1. Authenticated ESI (char has docking rights)
//                              2. Public ESI (structure has public market/services)
//                              3. Hammertime Structure API (community DB, no auth)
//                              4. Zkillboard structure lookup (reliable public index)
//                              5. adam4eve structure_history page (<title> tag)
//                              6. Graceful fallback: "Structure {id}"
//
// Usage:
//   const locator = require('./locator')({ httpGet, readCache, writeCache, getValidToken });
//
//   const meta = await locator.resolveLocation(locationId, characterId);
//   const info = await locator.resolveStructureName(structureId, characterId);
//
//   // Bulk-resolve an array of solar_system_ids → { id: name }
//   const nameMap = await locator.resolveSystemNames([30000142, 30002187]);
//
// resolveLocation() returns:
//   {
//     name:               string,
//     solar_system_id:    number|null,
//     solar_system_name:  string|null,
//     constellation_id:   number|null,
//     constellation_name: string|null,
//     region_id:          number|null,
//     region_name:        string|null,
//     security_status:    number|null,
//     owner_id:           number|null,
//     owner_name:         string|null,
//   }

'use strict';

const https = require('https');
const tls = require('tls');

const ADAM4EVE_BASE           = 'https://www.adam4eve.eu';
const ZKILLBOARD_BASE         = 'https://zkillboard.com';
const HAMMERTIME_BASE         = 'https://stop.hammerti.me.uk';
const PLAYER_STRUCTURE_MIN_ID = 1_000_000_000_000;

// Headroom a SPECULATIVE ESI call must leave behind. CCP allows 100 errors per
// window; a structure probe that 403s costs one. Structure resolution is a
// sweep — dozens of probes back to back — so it has to stop while there is still
// budget left for the calls that were going to succeed. Everything else in the
// app shares this budget, and at zero CCP 420s the lot.
const SPECULATIVE_MIN_BUDGET = 30;

// ── Circuit breaker for the free fallback sources ────────────────────────────
// Hammertime, zKillboard and adam4eve are community services that go down. When
// one does, it fails the SAME way for every structure — and a sweep over a few
// hundred assets then produces a few hundred identical failures and a few
// hundred identical log lines, which is how a real signal gets buried.
//
// (Observed 2026-08-04: stop.hammerti.me.uk began serving a self-signed
// "TRAEFIK DEFAULT CERT", so every request failed certificate validation. That
// is their proxy losing its certificate, not something this app can work around
// — and it must not be "fixed" by turning verification off.)
//
// After a few consecutive failures the host is left alone for a while and the
// reason is logged ONCE.
const HOST_TRIP_AFTER = 3;
const HOST_TRIP_MS    = 30 * 60 * 1000;
const _hostFail = new Map();   // host -> { count, until, reason }

function _hostIsDown(host) {
  const e = _hostFail.get(host);
  return !!(e && e.until > Date.now());
}

function _noteHostFailure(host, err) {
  const e = _hostFail.get(host) || { count: 0, until: 0, reason: '' };
  e.count++;
  e.reason = err && err.message ? err.message : String(err);
  if (e.count >= HOST_TRIP_AFTER && e.until <= Date.now()) {
    e.until = Date.now() + HOST_TRIP_MS;
    console.warn(`[locator] ${host} failed ${e.count}x (${e.reason}) — skipping it for ` +
                 `${Math.round(HOST_TRIP_MS / 60000)} min. Structure names will fall back to other sources.`);
  }
  _hostFail.set(host, e);
}

function _noteHostOk(host) {
  if (_hostFail.has(host)) _hostFail.delete(host);
}

const _hostOf = (url) => { try { return new URL(url).host; } catch { return String(url); } };

function _resetBreaker() { _hostFail.clear(); }

// Module-level ESI 420 cooldown tracker (shared across all locator instances)
let _esiErrorLimitUntil = 0;

// The main process's view of the ESI error budget, injected by createLocator.
// Without it this file kept its OWN 420 cooldown for the unauthenticated calls
// it makes through its own transport, while the authenticated reads went out
// through main's httpGet behind a different one — so a 420 observed on one path
// did nothing to stop the other, and the two kept refilling each other's holes.
let _esiHooks = null;

// True when a stored/cached "name" is not actually a real name: an ESI error
// body that leaked in from an older build, or a generic fallback. Such values
// must never be trusted — not from the local DB, not from the cache — or the
// poison ("No structure found with that ID!") keeps coming back on every sync.
function _isUnresolvedName(name) {
  if (!name) return true;
  const n = String(name).toLowerCase();
  return n.startsWith('structure ') ||
         n.startsWith('location ')  ||
         n.includes('no structure found') ||
         n.includes('not found')    ||
         n.includes('forbidden')    ||
         n.includes('error');
}

// ─── URL → https.request options ─────────────────────────────────────────────
// https.request() does NOT accept a plain string URL as the first arg in older
// Node versions bundled with Electron — always parse it into an options object.
function urlToOpts(rawUrl, extraHeaders = {}) {
  const u = new URL(rawUrl);
  return {
    hostname: u.hostname,
    port:     u.port || 443,
    path:     u.pathname + u.search,
    method:   'GET',
    headers: {
      'User-Agent': APP_USER_AGENT,
      ...extraHeaders,
    },
  };
}

// ─── Tiny raw HTML fetcher (no JSON parse) ────────────────────────────────────
function fetchHtml(url, timeoutMs = 12000, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 3) return reject(new Error('too many redirects'));
    let opts;
    try { opts = urlToOpts(url, { 'Accept': 'text/html,application/xhtml+xml' }); }
    catch (e) { return reject(new Error(`Invalid URL: ${url}`)); }

    const req = https.request(opts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume();
        // Resolve relative redirects against the original host
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${opts.hostname}${res.headers.location}`;
        fetchHtml(next, timeoutMs, _redirects + 1).then(resolve).catch(reject);
        return;
      }
      let d = '';
      res.on('data', c => (d += c));
      res.on('end',  () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── Tiny raw JSON fetcher ────────────────────────────────────────────────────
// Goes through the SAME ESI gate as the rest of the app when one is wired in,
// so a pause anywhere is a pause everywhere.
async function fetchJson(url, timeoutMs = 12000, _redirects = 0) {
  if (_esiHooks && _esiHooks.esiGateWait) {
    try { await _esiHooks.esiGateWait(url); } catch { /* never block on the gate */ }
  }
  return _fetchJsonRaw(url, timeoutMs, _redirects);
}

function _fetchJsonRaw(url, timeoutMs = 12000, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 3) return reject(new Error('too many redirects'));
    let opts;
    try { opts = urlToOpts(url, { 'Accept': 'application/json' }); }
    catch (e) { return reject(new Error(`Invalid URL: ${url}`)); }

    const req = https.request(opts, (res) => {
      // Report EVERY ESI response — 403s included — to the shared budget
      // tracker. The 403s are the ones that actually drain it; by the time a 420
      // arrives the damage is already done.
      if (_esiHooks && _esiHooks.esiNote) {
        try { _esiHooks.esiNote(url, res); } catch { /* never break the fetch */ }
      }
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${opts.hostname}${res.headers.location}`;
        fetchJson(next, timeoutMs, _redirects + 1).then(resolve).catch(reject);
        return;
      }

      // ─── ESI Error Limit (HTTP 420) ───
      if (res.statusCode === 420) {
        const resetTime = res.headers['x-esi-error-limit-reset'] || 60;
        // Record the cooldown globally so other concurrent callers back off
        _esiErrorLimitUntil = Date.now() + (Number(resetTime) * 1000);
        console.error(`[ESI 420] Error limit reached on ${url}. Cooldown: ${resetTime}s`);
        reject(new Error(`HTTP 420: ${url}`));
        res.resume();
        return;
      }

      // ─── Reject on any non-2xx status ───────────────────────────────────────
      // This prevents ESI error bodies like {"error":"No structure found..."}
      // from being parsed and accidentally treated as valid data downstream.
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        res.resume();
        return;
      }

      let d = '';
      res.on('data', c => (d += c));
      res.on('end',  () => {
        try {
          const parsed = JSON.parse(d);
          // ESI sometimes returns 200 with an error body — reject those too
          if (parsed && typeof parsed.error === 'string' && Object.keys(parsed).length === 1) {
            reject(new Error(`ESI error: ${parsed.error}`));
          } else {
            resolve(parsed);
          }
        }
        catch { reject(new Error('JSON parse error')); }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const HAMMERTIME_PINNED_SHA256 =
  '80:58:09:6A:C4:60:03:EB:F6:F5:67:D8:04:C3:0E:28:D1:39:39:E0:DE:27:9F:86:3A:36:63:68:7C:26:21:C7';

function fetchJsonInsecure(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let opts;
    try { opts = urlToOpts(url, { 'Accept': 'application/json' }); }
    catch (e) { return reject(new Error(`Invalid URL: ${url}`)); }

    // Keep Node's default chain/hostname validation enabled and add
    // certificate pinning as an additional identity check.
    opts.checkServerIdentity = (host, cert) => {
      const err = tls.checkServerIdentity(host, cert);
      if (err) return err;
      if (!cert || !cert.fingerprint256) {
        return new Error('No certificate presented by server');
      }
      if (cert.fingerprint256 !== HAMMERTIME_PINNED_SHA256) {
        return new Error(
          `Refusing connection: certificate fingerprint mismatch for ${url} ` +
          `(got ${cert.fingerprint256}, expected ${HAMMERTIME_PINNED_SHA256}). ` +
          `Hammertime may have rotated or fixed their TLS cert — verify and update the pin.`
        );
      }
      return undefined;
    };

    const req = https.request(opts, (res) => {
      const cert = res.socket.getPeerCertificate();
      if (!cert || !cert.fingerprint256) {
        req.destroy();
        return reject(new Error('No certificate presented by server'));
      }
      if (cert.fingerprint256 !== HAMMERTIME_PINNED_SHA256) {
        req.destroy();
        return reject(new Error(
          `Refusing connection: certificate fingerprint mismatch for ${url} ` +
          `(got ${cert.fingerprint256}, expected ${HAMMERTIME_PINNED_SHA256}). ` +
          `Hammertime may have rotated or fixed their TLS cert — verify and update the pin.`
        ));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        res.resume();
        return;
      }
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
// ─── Factory ──────────────────────────────────────────────────────────────────
module.exports = function createLocator({ httpGet, readCache, writeCache, getValidToken,
                                          getAllCharacterIds,
                                          getStationById, upsertNpcStations, upsertUpwellStructures,
                                          resolveNamesFromSde, getCachedNames, putCachedNames,
                                          esiGateWait, esiNote, esiBudget, getSdeDb }) {
  // One shared view of the error budget — see the note on _esiHooks above.
  if (esiGateWait || esiNote || esiBudget) _esiHooks = { esiGateWait, esiNote, esiBudget };

  // ── In-memory name cache (survives the session, avoids redundant ESI calls) ─
  const _nameCache = {};

  // ── ESI error-limit guard ──────────────────────────────────
  // Set by fetchJson when HTTP 420 is received. Structure lookups wait
  // until the cooldown expires before hitting ESI again.
  // Logged once per cooldown window, not once per waiter. Every queued structure
  // lookup calls this, so the old line-per-caller made ten sleeping lookups read
  // like a hot loop hammering ESI — the opposite of what is happening. One line
  // when the hold starts, one when it lifts, with the number held.
  let _cooldownLoggedUntil = 0;
  let _cooldownHeld = 0;

  async function _waitForEsiCooldown() {
    // The longer of our own cooldown and the app-wide one: a 420 seen by any
    // other feature is just as much a reason for us to stand down.
    const shared = esiBudget ? esiBudget().blockedFor : 0;
    const wait   = Math.max(_esiErrorLimitUntil - Date.now(), shared);
    if (wait <= 0) return;

    const until = Date.now() + wait;
    _cooldownHeld++;
    if (until > _cooldownLoggedUntil + 1000) {
      _cooldownLoggedUntil = until;
      console.log(`[locator] ESI cooldown — holding structure lookups for ${Math.ceil(wait / 1000)}s`);
    }
    try {
      // Staggered, so a queue of structure lookups does not resume in lockstep
      // and drain the refilled budget the instant it comes back.
      await new Promise(r => setTimeout(r, wait + Math.floor(Math.random() * 2000)));
    } finally {
      _cooldownHeld--;
      if (_cooldownHeld === 0 && _cooldownLoggedUntil) {
        console.log('[locator] ESI cooldown lifted — resuming structure lookups');
        _cooldownLoggedUntil = 0;
      }
    }
  }

  /**
   * Is there enough error budget to spend on a request we EXPECT to fail?
   *
   * Reading a structure nobody has docking rights to is a guess: it 403s far
   * more often than it succeeds, and each 403 costs a point. Those guesses must
   * stand down long before the necessary calls do — the whole failure mode here
   * is a speculative sweep draining the budget to zero and taking every other
   * ESI feature in the app down with it.
   */
  function _canSpeculate() {
    if (!esiBudget) return true;
    const b = esiBudget();
    return b.blockedFor === 0 && b.remain > SPECULATIVE_MIN_BUDGET;
  }

  // ── _persistToStationDb ──────────────────────────────────────────────────────
  // After an external source resolves a structure/station name, write it back
  // into the shared local DB so future lookups skip the network entirely.
  // Uses ON CONFLICT(id) DO UPDATE inside upsertNpcStations / upsertUpwellStructures,
  // so duplicate IDs are handled safely — no extra check needed here.
  async function _persistToStationDb(id, result) {
    // A name we can trust: present, not an ESI error / "Structure {id}" fallback,
    // and sane length. (The fallback guard is what stops the structure cache
    // from being poisoned by "No structure found with that ID!" et al.)
    const nameOk = result.name
      && !_isUnresolvedName(result.name)
      && result.name.length <= 200;
    // Even when the NAME can't be read (e.g. 403 — no docking rights), the
    // SOLAR SYSTEM is often still recoverable from the scrape/geo chain. Cache
    // that on its own so the UI can show "Unknown Structure — {System}" instead
    // of a raw id. Nothing to persist only when we have neither.
    if (!nameOk && !result.solar_system_id) return;
    if (typeof upsertNpcStations !== 'function' || typeof upsertUpwellStructures !== 'function') return;
    const numId = Number(id);
    const row   = {
      id:                numId,
      name:              nameOk ? result.name : null, // null never clobbers an existing real name (COALESCE upsert)
      solar_system_id:   result.solar_system_id   || null,
      solar_system_name: result.solar_system_name || null,
      region_id:         result.region_id         || null,
      region_name:       result.region_name       || null,
      security_status:   result.security_status   != null ? result.security_status : null,
    };
    try {
      if (numId >= 60_000_000 && numId < 64_000_000) {
        await upsertNpcStations([row]);
      } else {
        await upsertUpwellStructures([row]);
      }
      console.log(`[locator] Persisted ${nameOk ? `name "${result.name}"` : `system-only (${result.solar_system_name || result.solar_system_id})`} (${numId}) to local DB.`);
    } catch (e) {
      console.warn(`[locator] Failed to persist ${numId} to local DB: ${e.message}`);
    }
  }

  // ── ESI bulk names POST ──────────────────────────────────────────────────────
  // Resolves any mix of character/corp/alliance/system/station IDs → { id: name }.
  async function esiNamesPost(ids) {
    const unique   = [...new Set(ids.map(Number).filter(Boolean))];
    let   uncached = unique.filter(id => !_nameCache[id]);

    // SDE-first: serve immutable names (regions, systems, types) from disk so
    // only dynamic IDs (corps/alliances/characters) reach ESI. Falls back
    // cleanly when the injected resolver is absent (e.g. SDE not loaded).
    if (uncached.length && typeof resolveNamesFromSde === 'function') {
      try {
        const sde = await resolveNamesFromSde(uncached);
        for (const id of Object.keys(sde)) if (sde[id]) _nameCache[id] = sde[id];
        uncached = uncached.filter(id => !_nameCache[id]);
      } catch (_) { /* fall through to ESI for all */ }
    }

    // Persistent cache next: dynamic names resolved in a prior session (shared
    // with main.js's resolveNames) avoid a repeat ESI round-trip.
    if (uncached.length && typeof getCachedNames === 'function') {
      try {
        const db = await getCachedNames(uncached);
        for (const id of Object.keys(db)) if (db[id]) _nameCache[id] = db[id];
        uncached = uncached.filter(id => !_nameCache[id]);
      } catch (_) { /* fall through to ESI */ }
    }

    if (uncached.length) {
      const chunks = [];
      for (let i = 0; i < uncached.length; i += 1000)
        chunks.push(uncached.slice(i, i + 1000));

      for (const chunk of chunks) {
        try {
          const body   = JSON.stringify(chunk);
          const urlObj = new URL(`${ESI_BASE}/universe/names/?datasource=tranquility`);
          const result = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: urlObj.hostname,
              path:     urlObj.pathname + urlObj.search,
              method:   'POST',
              headers:  {
                'User-Agent':     APP_USER_AGENT,
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Accept':         'application/json',
              },
            }, (res) => {
              let d = '';
              res.on('data', c => (d += c));
              res.on('end',  () => {
                try { resolve(JSON.parse(d)); }
                catch { reject(new Error('JSON parse error')); }
              });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
            req.write(body);
            req.end();
          });
          if (Array.isArray(result)) {
            const fresh = [];
            result.forEach(r => {
              _nameCache[r.id] = r.name;
              fresh.push({ id: r.id, name: r.name, category: r.category || null });
            });
            // Persist dynamic names so the next session / main.js reuse them.
            if (fresh.length && typeof putCachedNames === 'function') {
              putCachedNames(fresh).catch(() => {});
            }
          }
        } catch (e) {
          console.log(`[locator] esiNamesPost chunk failed: ${e.message}`);
        }
      }
    }

    return Object.fromEntries(unique.map(id => [id, _nameCache[id] || null]));
  }

  // ── resolveSystemNames ───────────────────────────────────────────────────────
  // Convenience wrapper: resolves an array of solar_system_ids to { id: name }.
  // Uses ESI /v3/universe/names/ which covers systems natively.
  async function resolveSystemNames(systemIds) {
    return esiNamesPost(systemIds);
  }

  // ── _structureLookupCandidates ───────────────────────────────────────────────
  // Character ids to try for an authenticated structure read, owning character
  // first (most likely to hold docking rights), then every other known
  // character. Structure names are global, so ANY character with docking ACL +
  // the esi-universe.read_structures.v1 scope can name a structure another
  // character merely owns assets in — this is what lets us resolve a Keepstar
  // for character A using character B's access.
  function _structureLookupCandidates(primaryCharacterId) {
    const ids = [];
    if (primaryCharacterId) ids.push(String(primaryCharacterId));
    if (typeof getAllCharacterIds === 'function') {
      try {
        for (const cid of (getAllCharacterIds() || [])) {
          const s = String(cid);
          if (s && !ids.includes(s)) ids.push(s);
        }
      } catch (_) { /* fall back to the owning character only */ }
    }
    return ids;
  }

  // ── _authStructureRead ───────────────────────────────────────────────────────
  // Authenticated ESI structure read, trying each candidate character's token
  // until one is permitted (has docking ACL + the read_structures scope).
  // Returns the raw ESI body (name + solar_system_id + owner_id) or null.
  // crossChar=false restricts the attempt to the owning character only, to keep
  // the ESI error budget low on secondary (geo-only) lookups and repeat syncs.
  async function _authStructureRead(id, primaryCharacterId, crossChar = true) {
    await _waitForEsiCooldown();
    // The cross-character sweep costs one 403 per character without access, so
    // it is the single biggest spender here. With the budget thin, fall back to
    // the owning character alone rather than abandoning the lookup entirely —
    // one probe still has a real chance and costs at most one point.
    if (crossChar && !_canSpeculate()) crossChar = false;
    const candidates = crossChar
      ? _structureLookupCandidates(primaryCharacterId)
      : (primaryCharacterId ? [String(primaryCharacterId)] : []);
    for (const cid of candidates) {
      try {
        const token = await getValidToken(cid);
        const data  = await httpGet(
          `${ESI_BASE}/universe/structures/${id}/?datasource=tranquility`,
          { Authorization: `Bearer ${token}` }
        );
        if (data && (data.name || data.solar_system_id)) return data;
      } catch (e) {
        // 403 = this character has no docking access to this structure (or its
        // token predates the read_structures scope) — silently try the next.
      }
    }
    return null;
  }

  // ── _maybeRefreshStructureName ───────────────────────────────────────────────
  // Passive, NON-BLOCKING freshness check for a name served from the local DB.
  // Players can rename their structures, so a name persisted long ago can drift.
  // Rather than make every lookup wait on the network (or expire the DB row and
  // re-run the slow chain), we hand back the cached name instantly and, only if
  // that row is old, re-read it from ESI in the background and quietly update the
  // DB if it changed. The user always sees most-correct info immediately; the
  // name self-heals on the next sync. Throttled to ~once/day per structure so a
  // structure we've lost access to isn't re-probed on every sync.
  const STRUCTURE_REVERIFY_MS = 14 * 24 * 60 * 60 * 1000; // re-check names older than 14 days

  function _maybeRefreshStructureName(id, characterId, dbRow) {
    const age = Date.now() - (dbRow.synced_at || 0);
    if (age < STRUCTURE_REVERIFY_MS) return;          // still fresh — nothing to do
    const throttleKey = `struct_reverify_${id}`;
    if (readCache(throttleKey)) return;               // re-checked recently — skip
    writeCache(throttleKey, 1, 1);                     // throttle to ~once per day
    // Fire-and-forget: never awaited by the caller.
    (async () => {
      try {
        // Owning character only — a cheap confirmation, not a cross-character sweep.
        const data = await _authStructureRead(id, characterId, false);
        if (data && data.name) {
          const fresh = {
            name:            data.name,
            solar_system_id: data.solar_system_id || dbRow.solar_system_id || null,
            owner_id:        data.owner_id         || null,
          };
          if (data.name !== dbRow.name) {
            console.log(`[locator] Structure ${id} renamed: "${dbRow.name}" → "${data.name}" — updating DB.`);
            writeCache(`struct_name_${id}`, fresh, 7);
          }
          // Re-persist either way so synced_at advances and we don't re-check
          // this structure again until it next goes stale.
          _persistToStationDb(id, fresh).catch(() => {});
        }
      } catch (_) { /* keep the existing name; try again after the throttle expires */ }
    })();
  }

  // ── _esiStructureGeo ─────────────────────────────────────────────────────────
  // Fetches { solar_system_id, owner_id } from ESI for a player structure.
  // Tries authenticated (owning character only) first, then public (unauthed).
  // Returns {} on failure.
  async function _esiStructureGeo(id, characterId) {
    // A SECOND speculative pair of ESI calls, on a structure whose name has
    // already failed to resolve — so by definition the reads it is about to
    // make have just failed. Caught by a test that expected one probe and saw
    // two: gating the name lookup alone left this one spending freely behind it.
    if (!_canSpeculate()) return {};
    const authData = await _authStructureRead(id, characterId, false);
    if (authData && authData.solar_system_id) {
      return {
        solar_system_id: authData.solar_system_id || null,
        owner_id:        authData.owner_id         || null,
      };
    }
    // Public (works for structures with an open market or service)
    if (!_canSpeculate()) return {};
    try {
      const data = await fetchJson(
        `${ESI_BASE}/universe/structures/${id}/?datasource=tranquility`
      );
      if (data && data.solar_system_id) {
        return {
          solar_system_id: data.solar_system_id || null,
          owner_id:        data.owner_id         || null,
        };
      }
    } catch { /* not public */ }
    return {};
  }

  // ── resolveStructureName ─────────────────────────────────────────────────────
  // For IDs >= PLAYER_STRUCTURE_MIN_ID.
  // Returns { name, solar_system_id, owner_id } using a multi-step fallback chain.
  //
  // KEY CHANGE: every path (including zkillboard / adam4eve name-only fallbacks)
  // now ends with a _esiStructureGeo() call to fill in solar_system_id and
  // owner_id so that resolveLocation() can walk the full hierarchy.
  async function resolveStructureName(structureId, characterId = null, skipScrapes = false, force = false) {
    const id       = Number(structureId);
    const cacheKey = `struct_name_${id}`;
    const cached   = readCache(cacheKey);
    // Accept cached entry only if it has a REAL name AND geo data. force skips
    // the cache entirely so a repair pass always re-resolves from scratch.
    if (!force && cached && !_isUnresolvedName(cached.name) && cached.solar_system_id) {
      return cached;
    }

    // ── Step 0: Local DB (npc_stations / upwell_structures) ─────────────────
    // Check our own DB before touching any network. Skipped on a forced repair
    // (we want fresh resolution, not a possibly-stale DB row).
    if (!force && typeof getStationById === 'function') {
      try {
        const dbRow = await getStationById(id);
        if (dbRow && !_isUnresolvedName(dbRow.name)) {
          const result = {
            name:            dbRow.name,
            solar_system_id: dbRow.solar_system_id || null,
            owner_id:        null, // station tables don't store owner_id
          };
          writeCache(cacheKey, result, 7);
          console.log(`[locator] Local DB hit for ${id}: "${dbRow.name}"`);
          // Player structures can be renamed — confirm an old name in the
          // background without making the caller wait (NPC stations never change).
          if (id >= PLAYER_STRUCTURE_MIN_ID) _maybeRefreshStructureName(id, characterId, dbRow);
          return result;
        }
      } catch (e) {
        console.log(`[locator] Local DB lookup failed for ${id}: ${e.message}`);
      }
    }

    // ── Step 1: Authenticated ESI (try every character with possible access) ──
    // The owning character is tried first; if it lacks docking ACL (or its token
    // predates the read_structures scope) we fall back to every other character.
    // The cross-character sweep is the expensive part (one 403 per character
    // without access), so once it has run and failed we remember that and skip
    // straight to the owning character on later syncs — a forced repair, or the
    // 7-day marker expiry, re-runs the full sweep in case access was granted.
    const crossKey       = `struct_xchar_${id}`;
    const allowCrossChar = force || !readCache(crossKey);
    const authData = await _authStructureRead(id, characterId, allowCrossChar);
    if (authData && authData.name) {
      const result = {
        name:            authData.name,
        solar_system_id: authData.solar_system_id || null,
        owner_id:        authData.owner_id         || null,
      };
      writeCache(cacheKey, result, 7);
      // Persist to the shared local DB so every future lookup — for this and any
      // OTHER character — skips the network entirely (Step 0 fast-path).
      _persistToStationDb(id, result).catch(() => {});
      return result;
    }
    // The cross-character sweep ran and still found nothing — record it so the
    // next sync doesn't re-try every character again until the marker expires.
    if (allowCrossChar) writeCache(crossKey, 1, 7);

    // ── Step 2: Public ESI (unauthed) ────────────────────────────────────────
    // Many structures with public market/services respond to unauthed requests.
    // Skipped while the error budget is thin: this is the most speculative call
    // in the chain (a structure the authenticated read just failed on rarely
    // answers unauthenticated) and the free sources below cost ESI nothing.
    if (_canSpeculate()) try {
      const data = await fetchJson(
        `${ESI_BASE}/universe/structures/${id}/?datasource=tranquility`
      );
      if (data && data.name) {
        const result = {
          name:            data.name,
          solar_system_id: data.solar_system_id || null,
          owner_id:        data.owner_id         || null,
        };
        writeCache(cacheKey, result, 7);
        // Persist so future lookups (incl. other characters) skip the network.
        _persistToStationDb(id, result).catch(() => {});
        return result;
      }
    } catch { /* fall through */ }

    // ── Step 3: Hammertime Structure API ─────────────────────────────────────
    // Community-sourced database for structures players can't dock at.
    // Returns name, solarSystemID, ownerID without any authentication.
    // Docs: https://stop.hammerti.me.uk/api/
    if (!_hostIsDown(_hostOf(HAMMERTIME_BASE))) try {
      const data = await fetchJsonInsecure(`${HAMMERTIME_BASE}/api/structure/${id}/`);
      _noteHostOk(_hostOf(HAMMERTIME_BASE));
      // Response: { "name": "...", "solarSystemID": 30000142, "ownerID": 1234, ... }
      if (data && (data.name || data.solarSystemID)) {
        const name = data.name || null;
        const result = {
          name:            name && name !== 'Unknown' ? name : null,
          solar_system_id: data.solarSystemID || null,
          owner_id:        data.ownerID        || null,
        };
        // Only return early if we have a real name; otherwise let the result
        // enrich _esiStructureGeo data in subsequent steps.
        if (result.name && result.solar_system_id) {
          writeCache(cacheKey, result, 7);
          // Persist to local DB so future lookups skip the network
          _persistToStationDb(id, result).catch(() => {});
          return result;
        }
        // Partial hit — we may have solar_system_id/owner_id even without a name.
        // Fall through so zkillboard/adam4eve can supply the name, but store geo.
        if (result.solar_system_id) {
          // stash partial so _esiStructureGeo doesn't need another round-trip
          Object.assign(_nameCache, { [`__ham_geo_${id}`]: result });
        }
      }
    } catch (e) {
      // Logged once per outage by the breaker rather than once per structure.
      _noteHostFailure(_hostOf(HAMMERTIME_BASE), e);
    }

    // ── Step 4: Zkillboard structure page ────────────────────────────────────
    // Zkillboard indexes most structures that have ever appeared in killmails.
    // Skipped for structures already known to be unresolvable — these HTML
    // scrapes carry 12 s timeouts and have failed repeatedly already.
    if (!skipScrapes && !_hostIsDown(_hostOf(ZKILLBOARD_BASE))) try {
      const html = await fetchHtml(`${ZKILLBOARD_BASE}/location/id/${id}/`);
      _noteHostOk(_hostOf(ZKILLBOARD_BASE));

      // ─── Suppress Cloudflare/Not Found Console Spam ───
      const rawTitleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (rawTitleMatch) {
        const rawTitle = rawTitleMatch[1].trim();
        if (rawTitle.includes('Home | zKillboard') || rawTitle.includes('Just a moment...')) {
          // Structure not found or Cloudflare blocked. Silently skip.
          throw new Error('SILENT_SKIP');
        }
      }

      // Try <title> first — most stable across zkillboard redesigns
      let match = html.match(/<title[^>]*>(?:zKillboard\s*[-–]\s*)([^<|]{5,120})(?:\s*\|\s*zKillboard)?<\/title>/i);
      if (!match) {
        // "Something | NAME | zKillboard" format
        match = html.match(/<title[^>]*>[^|<]*\|\s*([^|<]{5,120?})\s*\|\s*zKillboard\s*<\/title>/i);
      }
      if (match && match[1]) {
        const name = match[1].trim();
        // Reject generic/error titles
        if (name && name !== 'zKillboard' && !name.toLowerCase().includes('not found') && name.length > 3) {
          const hamGeo = _nameCache[`__ham_geo_${id}`] || {};
          const geo    = (hamGeo.solar_system_id) ? hamGeo : await _esiStructureGeo(id, characterId);
          const result = { name, solar_system_id: geo.solar_system_id || null, owner_id: geo.owner_id || null };
          writeCache(cacheKey, result, 7);
          // Persist to local DB so future lookups skip the network
          _persistToStationDb(id, result).catch(() => {});
          return result;
        }
      }

      // Try <h1> as secondary — zkillboard renders the entity name there
      const h1 = html.match(/<h1[^>]*>\s*<a[^>]*>([^<]{3,120})<\/a>\s*<\/h1>/i)
               || html.match(/<h1[^>]*>\s*([^<]{3,120})\s*<\/h1>/i);
      if (h1 && h1[1]) {
        const name = h1[1].trim();
        if (name && !name.toLowerCase().includes('zkillboard') && !name.toLowerCase().includes('location')) {
          const hamGeo = _nameCache[`__ham_geo_${id}`] || {};
          const geo    = (hamGeo.solar_system_id) ? hamGeo : await _esiStructureGeo(id, characterId);
          const result = { name, solar_system_id: geo.solar_system_id || null, owner_id: geo.owner_id || null };
          writeCache(cacheKey, result, 7);
          // Persist to local DB so future lookups skip the network
          _persistToStationDb(id, result).catch(() => {});
          return result;
        }
      }

      // Log a snippet so we can tune the regex if zkillboard changes their layout
      console.log(`[locator] Zkillboard parse miss for ${id}, title snippet: ${html.slice(html.indexOf('<title'), html.indexOf('<title') + 200)}`);
    } catch (e) {
      // A silent skip is "not indexed", not an outage — it must not trip the
      // breaker or one missing structure would disable the source for everyone.
      if (e.message !== 'SILENT_SKIP') _noteHostFailure(_hostOf(ZKILLBOARD_BASE), e);
    }

    // ── Step 5: adam4eve structure_history page ───────────────────────────────
    // Title format: "A4E - Structure history 'NAME'" or "A4E - Structure history for 'NAME'"
    if (!skipScrapes && !_hostIsDown(_hostOf(ADAM4EVE_BASE))) try {
      const html  = await fetchHtml(`${ADAM4EVE_BASE}/structure_history.php?id=${id}`);
      _noteHostOk(_hostOf(ADAM4EVE_BASE));
      // Match: history 'NAME'  or  history "NAME"  or  history for 'NAME'
      const match = html.match(/<title[^>]*>[^<]*[Hh]istory(?:\s+for)?\s+['"]([^'"]{3,120})['"]/);
      if (match && match[1]) {
        const hamGeo = _nameCache[`__ham_geo_${id}`] || {};
        const geo    = (hamGeo.solar_system_id) ? hamGeo : await _esiStructureGeo(id, characterId);
        const result = { name: match[1].trim(), solar_system_id: geo.solar_system_id || null, owner_id: geo.owner_id || null };
        writeCache(cacheKey, result, 7);
        // Persist to local DB so future lookups skip the network
        _persistToStationDb(id, result).catch(() => {});
        return result;
      }
      // Fallback: grab the first <h2> that isn't the page header
      const bodyMatch = html.match(/<h2[^>]*>\s*([^<]{5,120})\s*<\/h2>/i);
      if (bodyMatch && bodyMatch[1] && !bodyMatch[1].toLowerCase().includes('structure history')) {
        const hamGeo = _nameCache[`__ham_geo_${id}`] || {};
        const geo    = (hamGeo.solar_system_id) ? hamGeo : await _esiStructureGeo(id, characterId);
        const result = { name: bodyMatch[1].trim(), solar_system_id: geo.solar_system_id || null, owner_id: geo.owner_id || null };
        writeCache(cacheKey, result, 7);
        // Persist to local DB so future lookups skip the network
        _persistToStationDb(id, result).catch(() => {});
        return result;
      }
      console.log(`[locator] adam4eve parse miss for ${id}, title: ${html.slice(html.indexOf('<title'), html.indexOf('<title') + 200)}`);
    } catch (e) {
      _noteHostFailure(_hostOf(ADAM4EVE_BASE), e);
    }

    // ── Step 6: Give up gracefully — but still try to get geo data ───────────
    // A give-up that happens while the ESI error budget is exhausted (HTTP 420)
    // is TRANSIENT: the structure may be perfectly resolvable — we just couldn't
    // reach ESI this pass. resolveLocation() uses this to keep a rate-limit storm
    // from counting toward the permanent backoff streak (which would wrongly bury
    // a structure the character actually has access to). Skip the extra geo probe
    // while rate-limited so we don't block on the cooldown for a doomed call.
    const transient = _esiErrorLimitUntil > Date.now();
    console.warn(`[locator] All name-resolution attempts failed for structure ${id}${transient ? ' (ESI rate-limited — transient)' : ''}`);
    const hamGeo   = _nameCache[`__ham_geo_${id}`] || {};
    const geo      = (hamGeo.solar_system_id || transient) ? hamGeo : await _esiStructureGeo(id, characterId);
    const fallback = { name: `Structure ${id}`, solar_system_id: geo.solar_system_id || null, owner_id: geo.owner_id || null, transient };
    writeCache(cacheKey, fallback, transient ? 0.02 : 1); // retry soon if it was just a rate-limit
    return fallback;
  }

  // ── resolveLocation ──────────────────────────────────────────────────────────
  // Full resolution: name + system / constellation / region / sec / owner.
  // Works for player structures, NPC stations, and bare solar system IDs.
  async function resolveLocation(locationId, characterId = null, force = false) {
    const id       = Number(locationId);
    const cacheKey = `loc_full_${id}`;
    const cached   = readCache(cacheKey);
    // Accept a cached entry only if it has a real (non-fallback, non-error) name
    // and the geo a structure needs. force skips the cache for a repair pass.
    if (!force && cached && !_isUnresolvedName(cached.name) &&
        (id < PLAYER_STRUCTURE_MIN_ID || cached.solar_system_id)) {
      return cached;
    }

    // Negative-result backoff: count consecutive resolution failures so we can
    // stop re-running the slow external chain for structures that never resolve.
    // A forced repair ignores the streak and always runs the full chain.
    const failKey     = `loc_fail_${id}`;
    const failCount   = force ? 0 : Number(readCache(failKey) || 0);
    const skipScrapes = force ? false : (failCount >= 3);

    // ── Hard backoff for repeat offenders ────────────────────────────────────
    // A player structure that has already failed the full resolution chain ≥3
    // times won't resolve for us: no character holds docking access, and the
    // public scrape sources (Hammertime / zKillboard / adam4eve) don't index it.
    // Re-running the authenticated cross-character sweep + public ESI read on
    // every sync just burns the ESI error budget (the 403s trip HTTP 420, which
    // then stalls *legitimate* lookups behind a 46 s cooldown). Serve the last
    // cached outcome (it still carries any solar-system geo we managed to find)
    // and skip the network entirely. A forced repair, or the cached entry's
    // 7-day TTL expiring, gives the structure another chance later.
    if (!force && id >= PLAYER_STRUCTURE_MIN_ID && failCount >= 3 && cached) {
      return cached;
    }

    const result = {
      name:               null,
      solar_system_id:    null,
      solar_system_name:  null,
      constellation_id:   null,
      constellation_name: null,
      region_id:          null,
      region_name:        null,
      security_status:    null,
      owner_id:           null,
      owner_name:         null,
    };

    // True when a structure give-up was caused by an ESI rate-limit storm rather
    // than a genuine "no access / not found" — see the failure-streak logic below.
    let transient = false;

    try {
      if (id >= PLAYER_STRUCTURE_MIN_ID) {
        // ── Player-owned structure ──────────────────────────────────────────
        const info             = await resolveStructureName(id, characterId, skipScrapes, force);
        result.name            = info.name;
        result.solar_system_id = info.solar_system_id;
        result.owner_id        = info.owner_id || null;
        transient              = !!info.transient;

      } else if (id >= 60_000_000 && id < 64_000_000) {
        // ── NPC station ────────────────────────────────────────────────────
        // Step 1: Check local DB first (skip on a forced repair / poisoned name)
        let resolvedFromDb = false;
        if (!force && typeof getStationById === 'function') {
          try {
            const dbRow = await getStationById(id);
            if (dbRow && !_isUnresolvedName(dbRow.name)) {
              result.name            = dbRow.name;
              result.solar_system_id = dbRow.solar_system_id   || null;
              result.solar_system_name = dbRow.solar_system_name || null;
              result.region_id       = dbRow.region_id         || null;
              result.region_name     = dbRow.region_name       || null;
              result.security_status = dbRow.security_status   != null ? dbRow.security_status : null;
              resolvedFromDb = true;
              console.log(`[locator] Local DB hit for NPC station ${id}: "${dbRow.name}"`);
            }
          } catch (e) {
            console.log(`[locator] Local DB station lookup failed for ${id}: ${e.message}`);
          }
        }
        // Step 2: Fall back to ESI if not found locally
        if (!resolvedFromDb) {
          try {
            const st = await httpGet(
              `${ESI_BASE}/universe/stations/${id}/?datasource=tranquility`
            );
            result.name            = st.name                                 || null;
            result.solar_system_id = st.system_id || st.solar_system_id || null;
            result.owner_id        = st.owner                                || null;
            // Persist the freshly resolved station back to our local DB
            if (result.name) _persistToStationDb(id, result).catch(() => {});
          } catch (e) {
            console.log(`[locator] Station lookup failed for ${id}: ${e.message}`);
          }
        }

      } else {
        // ── Bare solar system (or constellation / region) ID ───────────────
        try {
          const sys = await httpGet(
            `${ESI_BASE}/universe/systems/${id}/?datasource=tranquility`
          );
          if (sys && sys.system_id) {
            result.solar_system_id = id;
            result.name            = sys.name || null;
          }
        } catch { /* not a system */ }
      }

      // ── Walk up the hierarchy: system → constellation → region ────────────
      if (result.solar_system_id) {
        try {
          const sys = await httpGet(
            `${ESI_BASE}/universe/systems/${result.solar_system_id}/?datasource=tranquility`
          );
          result.solar_system_name = sys.name             || null;
          result.security_status   = sys.security_status  ?? null;
          result.constellation_id  = sys.constellation_id || null;
        } catch { /* leave nulls */ }
      }

      if (result.constellation_id) {
        try {
          const con = await httpGet(
            `${ESI_BASE}/universe/constellations/${result.constellation_id}/?datasource=tranquility`
          );
          result.constellation_name = con.name      || null;
          result.region_id          = con.region_id || null;
        } catch { /* leave nulls */ }
      }

      // ── Bulk-resolve remaining IDs (region name, owner name) ─────────────
      const bulkIds = [result.region_id, result.owner_id].filter(Boolean);
      if (bulkIds.length) {
        const nameMap = await esiNamesPost(bulkIds);
        if (result.region_id) result.region_name = nameMap[result.region_id] || null;
        if (result.owner_id)  result.owner_name  = nameMap[result.owner_id]  || null;
      }

      // ── Best-effort display name ─────────────────────────────────────────
      if (!result.name) {
        result.name = result.solar_system_name || `Location ${id}`;
      }

    } catch (e) {
      console.warn(`[locator] resolveLocation(${id}) failed: ${e.message}`);
      result.name = `Location ${id}`;
    }

    // Cache the outcome, tracking a failure streak so persistently-unresolvable
    // structures back off instead of re-running the full chain every few hours.
    const failed = result.name.startsWith('Location ') || result.name.startsWith('Structure ');
    if (failed && transient) {
      // Rate-limited this pass (ESI 420), not a genuine dead end. DON'T touch the
      // failure streak — otherwise a temporary 420 storm buries structures the
      // character actually has access to. Cache briefly and retry soon.
      writeCache(cacheKey, result, 0.02);
    } else if (failed) {
      const nextCount = failCount + 1;
      writeCache(failKey, nextCount, 30); // remember the streak for 30 days
      // First couple of misses may be transient (ESI 420, structure just went
      // public) — retry soon. After that, treat it as dead and back off hard.
      writeCache(cacheKey, result, nextCount >= 3 ? 7 : 0.1);
    } else {
      if (failCount) writeCache(failKey, 0, 30); // resolved — clear the streak
      writeCache(cacheKey, result, 1);
    }
    return result;
  }

  // ── resolveLocations (batch, up to 8 concurrent) ────────────────────────────
  async function resolveLocations(locationIds, characterId = null) {
    const unique  = [...new Set(locationIds.map(Number).filter(Boolean))];
    const results = {};
    const CONCURRENCY = 8;
    let i = 0;

    async function worker() {
      while (i < unique.length) {
        const id    = unique[i++];
        results[id] = await resolveLocation(id, characterId);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, unique.length || 1) }, worker)
    );
    return results;
  }

  // ── resolveJobLocation ───────────────────────────────────────────────────────
  // Convenience helper specifically for industry jobs.
  // An industry job has `facility_id` (where it runs) and `solar_system_id`
  // (always present as a raw integer from ESI — but ESI does NOT send the name).
  //
  // Returns { systemName, facilityName, securityStatus, regionName }
  // so callers don't need to know which field to look at.
  async function resolveJobLocation(job, characterId = null) {
    // solar_system_id is always a plain integer on jobs from ESI
    const solarSystemId = job.solar_system_id || null;
    const facilityId    = job.facility_id     || null;

    let systemName     = null;
    let facilityName   = null;
    let securityStatus = null;
    let regionName     = null;

    // 1. Resolve the system name directly from the integer ID
    if (solarSystemId) {
      try {
        const nameMap  = await esiNamesPost([solarSystemId]);
        systemName     = nameMap[solarSystemId] || null;

        // Get sec status while we're here
        if (systemName) {
          const cacheKey = `loc_full_${solarSystemId}`;
          const cached   = readCache(cacheKey);
          if (cached && cached.security_status != null) {
            securityStatus = cached.security_status;
            regionName     = cached.region_name || null;
          } else {
            // Fire-and-forget full resolution so the cache is warm next time
            resolveLocation(solarSystemId, characterId).then(loc => {
              securityStatus = loc.security_status;
              regionName     = loc.region_name;
            }).catch(() => {});
          }
        }
      } catch { /* leave null */ }
    }

    // 2. Resolve the facility name (station or structure)
    if (facilityId) {
      try {
        const loc    = await resolveLocation(facilityId, characterId);
        facilityName = loc.name;
        // If system resolution above failed, use the facility's system
        if (!systemName && loc.solar_system_name) systemName = loc.solar_system_name;
        if (!securityStatus && loc.security_status != null) securityStatus = loc.security_status;
        if (!regionName && loc.region_name) regionName = loc.region_name;
      } catch { /* leave null */ }
    }

    return {
      systemName:     systemName     || `System ${solarSystemId || '?'}`,
      facilityName:   facilityName   || (facilityId ? `Facility ${facilityId}` : '—'),
      securityStatus: securityStatus || null,
      regionName:     regionName     || null,
    };
  }

  // ── syncStationDatabase ──────────────────────────────────────────────────────
  // Populates the local npc_stations and upwell_structures tables.
  //
  // NPC stations  — the LOCAL SDE (data/sde.sql, staStations joined to
  //                 mapSolarSystems/mapRegions). No network at all. The remote
  //                 mirrors this used to try are both 404 — see the note on the
  //                 constants below.
  //
  // Upwell structs — ESI removed the ?filter=public query parameter from
  //                 /v1/universe/structures/ so there is no longer a public
  //                 bulk-ID endpoint.  We instead resolve individual structure
  //                 IDs that the locator already knows about (from prior syncs
  //                 and from asset/location resolution) by walking the upwell_structures
  //                 table and re-resolving any rows missing geo data.
  //                 Any *new* Upwell structures are picked up naturally the first
  //                 time a character's assets/clones/wallet are synced — the locator
  //                 writes them back to the table via _persistToStationDb.
  //
  // Returns { npc, upwell } on success or { error: string } on fatal failure.
  // Accepts an optional { upsertNpcStations, upsertUpwellStructures,
  //   getStationById, getStationsLastSync, initStationTables } bag — falls back
  //   to the factory-injected helpers if not supplied.
  //
  // STATION_SYNC_TTL_MS and force are intentionally handled by the caller
  // (the IPC handler in main.js) so the UI can show "already fresh" without
  // having to duplicate the timestamp logic here.
  //
  // NPC stations come from OUR OWN SDE. There is nothing to fetch.
  //
  // This used to try sde.hoboleaks.space/tq/stastations.json and fall back to
  // fuzzwork.co.uk/dump/latest/staStations.json. Probed 2026-08-05: BOTH 404.
  // Hoboleaks answers NoSuchKey for the whole /tq/ prefix, and Fuzzwork's
  // /dump/latest/ directory listing contains only database dumps and a csv/
  // folder — no staStations.json, which suggests that URL was never right.
  // So the sync could not have worked in a long time: the fetch threw, the catch
  // logged, and zero stations were written. It just quietly cost two failed
  // requests a run, one of them a 404 at the service whose operator got in touch
  // about exactly that (see the note above fetchFuzzworkBlueprint in
  // src/ipc/esi_ipc.js).
  //
  // data/sde.sql already carries all 5 210 of them, indexed, with system and
  // region names and security from mapSolarSystems/mapRegions — which also
  // retires the ~6 ESI /universe/names/ POSTs this used to make to resolve those
  // names. Local, complete, offline, and free.

  async function syncStationDatabase({ httpPost: _httpPost } = {}) {
    // _httpPost is injected from main.js (it needs the full POST helper).
    // If not supplied we fall back to a minimal inline POST using node https.
    const doPost = _httpPost || function inlinePost(url, body) {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const u       = new URL(url);
        const req     = require('https').request({
          hostname: u.hostname,
          path:     u.pathname + u.search,
          method:   'POST',
          headers:  {
            'User-Agent':     APP_USER_AGENT,
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Accept':         'application/json',
          },
        }, (res) => {
          let d = '';
          res.on('data', c => (d += c));
          res.on('end',  () => {
            if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
            try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse error')); }
          });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(payload);
        req.end();
      });
    };

    let npcCount    = 0;
    let upwellCount = 0;

    // ── PART 1: NPC stations, straight from the local SDE ────────────────────
    console.log('[StationSync] Reading NPC stations from the local SDE...');
    try {
      const sdeDb = getSdeDb && getSdeDb();
      if (!sdeDb) throw new Error('SDE not available — station sync needs the static data');

      // The 60m-64m range is the NPC station block; everything above it is a
      // player structure and belongs to PART 2.
      const npcRows = await sdeDb.all(`
        SELECT s.stationID        AS id,
               s.stationName      AS name,
               s.solarSystemID    AS solar_system_id,
               sys.solarSystemName AS solar_system_name,
               sys.regionID       AS region_id,
               r.regionName       AS region_name,
               sys.security       AS security_status
          FROM staStations s
          LEFT JOIN mapSolarSystems sys ON sys.solarSystemID = s.solarSystemID
          LEFT JOIN mapRegions      r   ON r.regionID        = sys.regionID
         WHERE s.stationID >= 60000000 AND s.stationID < 64000000
           AND s.stationName IS NOT NULL`);

      // Upsert in 500-row chunks to stay within SQLite's parameter limits.
      const CHUNK = 500;
      for (let i = 0; i < npcRows.length; i += CHUNK) {
        await upsertNpcStations(npcRows.slice(i, i + CHUNK));
      }
      npcCount = npcRows.length;
      console.log(`[StationSync] NPC stations upserted: ${npcCount}`);
    } catch (e) {
      console.warn(`[StationSync] NPC station sync failed: ${e.message}`);
      // Non-fatal — continue to Upwell pass.
    }

    // ── PART 2: Upwell structures ─────────────────────────────────────────────
    // ESI no longer provides a public bulk-listing endpoint for structures.
    // Instead we re-resolve any structures already in our DB that are missing
    // geo data (solar_system_id IS NULL), which fills gaps from prior partial
    // syncs.  New structures are added to the table automatically whenever the
    // locator resolves one during asset/clone/wallet syncs (_persistToStationDb).
    //
    // This means the first sync after install may show upwell=0, which is
    // expected — structures accumulate as characters are synced.
    console.log('[StationSync] Re-resolving any Upwell structures with incomplete geo data...');
    try {
      // getStationById is injected; we need to query all rows with null geo.
      // We expose a helper via the injected charInfoDb if available.
      if (typeof getStationById === 'function') {
        // We don't have a "getAll" helper, so we skip the DB-scan pass here.
        // The locator's _persistToStationDb will fill the table as syncs run.
        console.log('[StationSync] Upwell re-resolve pass skipped (no bulk-query helper injected).');
        console.log('[StationSync] Structures are populated automatically during character syncs.');
      }
      upwellCount = 0; // honest — we didn't bulk-add any
    } catch (e) {
      console.warn(`[StationSync] Upwell pass error: ${e.message}`);
    }

    console.log(`[StationSync] Complete — ${npcCount} NPC, ${upwellCount} Upwell.`);
    return { npc: npcCount, upwell: upwellCount };
  }

  // True once a location has failed the full resolution chain enough times that
  // we've stopped retrying its slow external sources. Lets callers avoid queuing
  // doomed immediate re-resolves for structures that will only return a fallback.
  function isKnownUnresolvable(id) {
    return Number(readCache(`loc_fail_${Number(id)}`) || 0) >= 3;
  }

  return {
    resolveStructureName,
    resolveLocation,
    resolveLocations,
    resolveJobLocation,
    resolveSystemNames,
    esiNamesPost,
    syncStationDatabase,
    isKnownUnresolvable,
  };
};

// The fallback-source circuit breaker, exposed for tests. Pure module state, no
// network — the wiring into the fetch paths is by inspection, because those
// fetchers are not injectable and a test that exercised them would have to make
// real requests to community services that are sometimes down.
module.exports._breaker = { _hostIsDown, _noteHostFailure, _noteHostOk, _resetBreaker, _hostOf,
                            HOST_TRIP_AFTER, HOST_TRIP_MS };
