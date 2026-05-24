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
//                              3. ESI /v1/universe/structures/{id}/ (unauthed, works for
//                                 many public-access structures)
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

const ESI_BASE                = 'https://esi.evetech.net';
const ADAM4EVE_BASE           = 'https://www.adam4eve.eu';
const ZKILLBOARD_BASE         = 'https://zkillboard.com';
const PLAYER_STRUCTURE_MIN_ID = 1_000_000_000_000;

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
      'User-Agent': 'EVE-BPC-Calculator/2.0',
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
function fetchJson(url, timeoutMs = 12000, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 3) return reject(new Error('too many redirects'));
    let opts;
    try { opts = urlToOpts(url, { 'Accept': 'application/json' }); }
    catch (e) { return reject(new Error(`Invalid URL: ${url}`)); }

    const req = https.request(opts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${opts.hostname}${res.headers.location}`;
        fetchJson(next, timeoutMs, _redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode === 403 || res.statusCode === 401) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let d = '';
      res.on('data', c => (d += c));
      res.on('end',  () => {
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
module.exports = function createLocator({ httpGet, readCache, writeCache, getValidToken }) {

  // ── In-memory name cache (survives the session, avoids redundant ESI calls) ─
  const _nameCache = {};

  // ── ESI bulk names POST ──────────────────────────────────────────────────────
  // Resolves any mix of character/corp/alliance/system/station IDs → { id: name }.
  async function esiNamesPost(ids) {
    const unique   = [...new Set(ids.map(Number).filter(Boolean))];
    const uncached = unique.filter(id => !_nameCache[id]);

    if (uncached.length) {
      const chunks = [];
      for (let i = 0; i < uncached.length; i += 1000)
        chunks.push(uncached.slice(i, i + 1000));

      for (const chunk of chunks) {
        try {
          const body   = JSON.stringify(chunk);
          const urlObj = new URL(`${ESI_BASE}/v3/universe/names/?datasource=tranquility`);
          const result = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: urlObj.hostname,
              path:     urlObj.pathname + urlObj.search,
              method:   'POST',
              headers:  {
                'User-Agent':     'EVE-BPC-Calculator/2.0',
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
            result.forEach(r => { _nameCache[r.id] = r.name; });
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

  // ── resolveStructureName ─────────────────────────────────────────────────────
  // For IDs >= PLAYER_STRUCTURE_MIN_ID.
  // Returns { name, solar_system_id } using a 5-step fallback chain.
  async function resolveStructureName(structureId, characterId = null) {
    const id       = Number(structureId);
    const cacheKey = `struct_name_${id}`;
    const cached   = readCache(cacheKey);
    if (cached && cached.name && !cached.name.startsWith('Structure ')) return cached;

    // ── Step 1: Authenticated ESI ────────────────────────────────────────────
    if (characterId) {
      try {
        const token = await getValidToken(characterId);
        const data  = await httpGet(
          `${ESI_BASE}/v2/universe/structures/${id}/?datasource=tranquility`,
          { Authorization: `Bearer ${token}` }
        );
        if (data && data.name) {
          const result = { name: data.name, solar_system_id: data.solar_system_id || null };
          writeCache(cacheKey, result, 7);
          return result;
        }
      } catch (e) {
        console.log(`[locator] ESI auth lookup failed for ${id}: ${e.message}`);
      }
    }

    // ── Step 2: Public ESI (unauthed) ────────────────────────────────────────
    // Many structures with public market/services respond to unauthed requests.
    try {
      const data = await fetchJson(
        `${ESI_BASE}/v2/universe/structures/${id}/?datasource=tranquility`
      );
      if (data && data.name) {
        const result = { name: data.name, solar_system_id: data.solar_system_id || null };
        writeCache(cacheKey, result, 7);
        return result;
      }
    } catch { /* fall through */ }

    // ── Step 3: Zkillboard structure page ────────────────────────────────────
    // Zkillboard indexes most structures that have ever appeared in killmails.
    // URL: https://zkillboard.com/location/id/{id}/
    // Title format: "zKillboard - {Structure Name}" or "{Name} | zKillboard"
    try {
      const html = await fetchHtml(`${ZKILLBOARD_BASE}/location/id/${id}/`);

      // Try <title> first — most stable across zkillboard redesigns
      // Common formats:
      //   "zKillboard - C-J6MT - 1stTaj MahGoon"
      //   "Structure | C-J6MT - 1stTaj MahGoon | zKillboard"
      let match = html.match(/<title[^>]*>(?:zKillboard\s*[-–]\s*)([^<|]{5,120})(?:\s*\|\s*zKillboard)?<\/title>/i);
      if (!match) {
        // "Something | NAME | zKillboard" format
        match = html.match(/<title[^>]*>[^|<]*\|\s*([^|<]{5,120?})\s*\|\s*zKillboard\s*<\/title>/i);
      }
      if (match && match[1]) {
        const name = match[1].trim();
        // Reject generic/error titles
        if (name && name !== 'zKillboard' && !name.toLowerCase().includes('not found') && name.length > 3) {
          const result = { name, solar_system_id: null };
          writeCache(cacheKey, result, 7);
          return result;
        }
      }

      // Try <h1> as secondary — zkillboard renders the entity name there
      const h1 = html.match(/<h1[^>]*>\s*<a[^>]*>([^<]{3,120})<\/a>\s*<\/h1>/i)
               || html.match(/<h1[^>]*>\s*([^<]{3,120})\s*<\/h1>/i);
      if (h1 && h1[1]) {
        const name = h1[1].trim();
        if (name && !name.toLowerCase().includes('zkillboard') && !name.toLowerCase().includes('location')) {
          const result = { name, solar_system_id: null };
          writeCache(cacheKey, result, 7);
          return result;
        }
      }

      // Log a snippet so we can tune the regex if zkillboard changes their layout
      console.log(`[locator] Zkillboard parse miss for ${id}, title snippet: ${html.slice(html.indexOf('<title'), html.indexOf('<title') + 200)}`);
    } catch (e) {
      console.log(`[locator] Zkillboard fallback failed for ${id}: ${e.message}`);
    }

    // ── Step 4: adam4eve structure_history page ───────────────────────────────
    // Title format: "A4E - Structure history 'NAME'" or "A4E - Structure history for 'NAME'"
    // Quotes in the real HTML are plain ASCII ' or " — not Unicode curly quotes.
    try {
      const html  = await fetchHtml(`${ADAM4EVE_BASE}/structure_history.php?id=${id}`);
      // Match: history 'NAME'  or  history "NAME"  or  history for 'NAME'
      const match = html.match(/<title[^>]*>[^<]*[Hh]istory(?:\s+for)?\s+['"]([^'"]{3,120})['"]/);
      if (match && match[1]) {
        const result = { name: match[1].trim(), solar_system_id: null };
        writeCache(cacheKey, result, 7);
        return result;
      }
      // Fallback: grab the first <h2> that isn't the page header
      const bodyMatch = html.match(/<h2[^>]*>\s*([^<]{5,120})\s*<\/h2>/i);
      if (bodyMatch && bodyMatch[1] && !bodyMatch[1].toLowerCase().includes('structure history')) {
        const result = { name: bodyMatch[1].trim(), solar_system_id: null };
        writeCache(cacheKey, result, 7);
        return result;
      }
      console.log(`[locator] adam4eve parse miss for ${id}, title: ${html.slice(html.indexOf('<title'), html.indexOf('<title') + 200)}`);
    } catch (e) {
      console.log(`[locator] adam4eve fallback failed for ${id}: ${e.message}`);
    }

    // ── Step 5: Give up gracefully ───────────────────────────────────────────
    console.warn(`[locator] All resolution attempts failed for structure ${id}`);
    const fallback = { name: `Structure ${id}`, solar_system_id: null };
    writeCache(cacheKey, fallback, 1); // short TTL so we retry tomorrow
    return fallback;
  }

  // ── resolveLocation ──────────────────────────────────────────────────────────
  // Full resolution: name + system / constellation / region / sec / owner.
  // Works for player structures, NPC stations, and bare solar system IDs.
  async function resolveLocation(locationId, characterId = null) {
    const id       = Number(locationId);
    const cacheKey = `loc_full_${id}`;
    const cached   = readCache(cacheKey);
    // Reject stale "unknown" entries so they get re-resolved on next call
    if (cached && cached.name && !cached.name.startsWith('Location ') && !cached.name.startsWith('Structure ')) {
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

    try {
      if (id >= PLAYER_STRUCTURE_MIN_ID) {
        // ── Player-owned structure ──────────────────────────────────────────
        const info             = await resolveStructureName(id, characterId);
        result.name            = info.name;
        result.solar_system_id = info.solar_system_id;

      } else if (id >= 60_000_000 && id < 64_000_000) {
        // ── NPC station ────────────────────────────────────────────────────
        try {
          const st = await httpGet(
            `${ESI_BASE}/v2/universe/stations/${id}/?datasource=tranquility`
          );
          result.name            = st.name                           || null;
          result.solar_system_id = st.system_id || st.solar_system_id || null;
          result.owner_id        = st.owner                          || null;
        } catch (e) {
          console.log(`[locator] Station lookup failed for ${id}: ${e.message}`);
        }

      } else {
        // ── Bare solar system (or constellation / region) ID ───────────────
        try {
          const sys = await httpGet(
            `${ESI_BASE}/v4/universe/systems/${id}/?datasource=tranquility`
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
            `${ESI_BASE}/v4/universe/systems/${result.solar_system_id}/?datasource=tranquility`
          );
          result.solar_system_name = sys.name             || null;
          result.security_status   = sys.security_status  ?? null;
          result.constellation_id  = sys.constellation_id || null;
        } catch { /* leave nulls */ }
      }

      if (result.constellation_id) {
        try {
          const con = await httpGet(
            `${ESI_BASE}/v1/universe/constellations/${result.constellation_id}/?datasource=tranquility`
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

    // Cache for 24 h; short-lived if name resolution failed
    const ttlDays = result.name.startsWith('Location ') || result.name.startsWith('Structure ') ? 0.1 : 1;
    writeCache(cacheKey, result, ttlDays);
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

  return {
    resolveStructureName,
    resolveLocation,
    resolveLocations,
    resolveJobLocation,
    resolveSystemNames,
    esiNamesPost,
  };
};