'use strict';

const { app } = require('electron');
const fs   = require('fs');
const path = require('path');

const galaxyLayout = require('../galaxy_layout');

const { ESI_BASE } = require('../app_ident');   // one definition — src/shared/esi.js

// Sovereignty comes from ONE endpoint now. CCP retired /v1/sovereignty/map/ and
// /v1/sovereignty/structures/ in the compatibility-date snapshot of 2026-05-19
// (they 404 for anything pinned at or after that date — see ESI_COMPATIBILITY_DATE
// in src/app_ident.js); /sovereignty/systems replaces the first. Its per-system
// claim is a tagged union — { faction } | { alliance } | { unclaimed }.
//
// Nothing replaces the second, and nothing needs to: the map used to mark
// IHUB systems as a proxy for "a jump bridge could be anchored here", but under
// Equinox an alliance claim *is* a sovereignty hub — every one of the ~2700
// claimed systems carries one — so that proxy now selects the whole of null-sec
// and tells you nothing. The map marks the user's own saved bridge endpoints
// instead (see _loadSavedBridges in src/func/map.js); don't reinstate a
// sov-derived IHUB list here.
const SOV_SYSTEMS_URL = `${ESI_BASE}/sovereignty/systems`;
const SOV_CACHE_KEY   = 'map_sovereignty';
const SOV_TTL_DAYS    = 1 / 288;   // 5 min — the endpoint's own x-client-cache-ttl

// In-process cache for SDE data (never changes at runtime)
let _galaxyCache = null;

// Fetch + normalise /sovereignty/systems into the shape the map renderer has
// always consumed: { systemId: { allianceId, corporationId, factionId, isCapital } }.
//
// isCapital is the alliance's SOVEREIGNTY CAPITAL — the system an Ansiblex's
// capacitor fare is measured from. It was in this response all along and was
// being thrown away with everything else this normaliser does not copy; it
// costs no extra request, since this endpoint is already polled for the sov
// overlay. Exactly one system per capital-holding alliance carries it (67 of
// the 71 sov-holding alliances when checked live; the other 4 have none set).
async function _fetchSovSystems({ httpGet, writeCache }) {
  const body   = await httpGet(SOV_SYSTEMS_URL);
  const sovMap = {};
  for (const s of (body?.solar_systems || [])) {
    const claim = s.claim || {};
    const a     = claim.alliance;
    sovMap[s.solar_system_id] = {
      allianceId:    a?.alliance_id            || null,
      corporationId: a?.corporation_id         || null,
      factionId:     claim.faction?.faction_id || null,
      isCapital:     a?.is_capital_system === true,
    };
  }
  writeCache(SOV_CACHE_KEY, sovMap, SOV_TTL_DAYS);
  return sovMap;
}

// Hand-curated Modern-map layout. It wins over the algorithmic layout wholesale.
//
// It SHIPS WITH THE APP (src/data/, packaged into the asar by the build's
// files: ["**/*"]). It used to live only in userData, written by the in-app
// layout editor — which meant the curated map existed on exactly one machine
// and every install anywhere else silently fell back to the algorithm and drew
// a noticeably more spread-out galaxy. The editor is gone and the layout is
// finished, so the bundled copy is the canonical one.
//
// Deliberately NOT data/: that directory is gitignored (it holds the multi-
// hundred-MB SDE) and only reaches a build via extraResources, so a file placed
// there would ship from a local build and be MISSING from every CI release —
// which is the exact shape of the bug this fixes.
//
// A userData file is still honoured as a fallback, so an existing hand-saved
// layout keeps working if the bundled one is ever unreadable.
const _bundledLayoutPath = () => path.join(__dirname, '..', 'data', 'modern-map-layout.json');
const _modernLayoutPath  = () => path.join(app.getPath('userData'), 'modern-map-layout.json');


// ── Turning ESI snapshots into history ────────────────────────────────────────
//
// /universe/system_jumps and /universe/system_kills report ONE number each: what
// happened in the last hour. There is no historical endpoint, anywhere, so the
// question "why does this system say 240 jumps — is that normal?" cannot be
// answered from ESI at all. The only way to have a curve is to keep the
// snapshots we already fetch.
//
// Shape is a shared timestamp axis plus one aligned array per system:
//
//   { t: [t0..tN], traffic: { sysId: [v0..vN] }, ship: {...}, npc: {...} }
//
// rather than a list of whole snapshots, because the system id is then stored
// once instead of once per sample — about 750 KB for a full day across 5 000
// systems, against several megabytes the naive way.
//
// A system that appears late is back-padded with zeros so every array stays the
// same length as `t`; a system that drops out of a snapshot records a real zero,
// because "no jumps this hour" IS the measurement.
const HISTORY_SLOTS = 24;          // one day at ESI's hourly cadence

function _historyAppend(store, field, values, now) {
  const series = store[field] || (store[field] = {});
  const len = store.t.length;                 // BEFORE this sample is pushed
  const seen = new Set();
  for (const [id, v] of Object.entries(values)) {
    let arr = series[id];
    if (!arr) { arr = new Array(len).fill(0); series[id] = arr; }
    arr.push(v);
    seen.add(id);
  }
  // Everything that did not report this hour genuinely saw nothing.
  for (const id of Object.keys(series)) if (!seen.has(id)) series[id].push(0);
}

function _historyTrim(store) {
  while (store.t.length > HISTORY_SLOTS) {
    store.t.shift();
    for (const field of ['traffic', 'ship', 'npc']) {
      const series = store[field];
      if (!series) continue;
      for (const id of Object.keys(series)) {
        series[id].shift();
        // Drop a system that has been silent for the whole window, so the file
        // does not grow a permanent tail of dead entries.
        if (series[id].every(v => !v)) delete series[id];
      }
    }
  }
}

/**
 * Record one fresh sample. Called only when a fetch actually hit ESI — a cache
 * hit is the same hour's number and would flatten the curve with duplicates.
 */
function _recordHistory(readCache, writeCache, fields) {
  const KEY = 'map_layer_history';
  let store = readCache(KEY);
  if (!store || !Array.isArray(store.t)) store = { t: [], traffic: {}, ship: {}, npc: {} };
  const now = Date.now();
  // Guard against double-recording inside one ESI window.
  if (store.t.length && now - store.t[store.t.length - 1] < 30 * 60 * 1000) return;
  for (const [field, values] of Object.entries(fields)) {
    _historyAppend(store, field, values, now);
  }
  store.t.push(now);
  // Fields not in this sample still need their arrays kept aligned.
  for (const field of ['traffic', 'ship', 'npc']) {
    if (fields[field]) continue;
    const series = store[field];
    if (!series) continue;
    for (const id of Object.keys(series)) {
      while (series[id].length < store.t.length) series[id].push(0);
    }
  }
  _historyTrim(store);
  writeCache(KEY, store, 30);        // 30 days; it is trimmed by slot count, not age
}

function registerMapHandlers({ ipcHandle, httpGet, readCache, writeCache, getSdeDb, getSdeMd5Path }) {

  // ── Custom Modern-map layout: persist / load / reset ───────────────────────
  ipcHandle('modern-layout-get', async () => {
    // Bundled first, so every install draws the same galaxy.
    try {
      const bundled = JSON.parse(fs.readFileSync(_bundledLayoutPath(), 'utf8'));
      if (bundled && bundled.systems && Object.keys(bundled.systems).length) return bundled;
    } catch (_) { /* fall through to a locally saved layout */ }
    try { return JSON.parse(fs.readFileSync(_modernLayoutPath(), 'utf8')); }
    catch (_) { return null; }   // neither present → algorithmic layout
  });

  // ── Hand-curated per-region layouts ───────────────────────────────────────
  //
  // Positions traced off the in-game map for regions somebody has actually sat
  // down and matched. Identity and gates always come from the SDE; only the
  // arrangement comes from the trace, and even that is a SEED for the usual
  // relaxation rather than a final answer — so a region gains the in-game
  // shape without needing pixel-accurate transcription of 110 systems.
  //
  // A region with no entry is laid out exactly as before, so this file can grow
  // one region at a time and never has to be complete.
  ipcHandle('region-layouts-get', async () => {
    try {
      return JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'data', 'region-layouts.json'), 'utf8'));
    } catch (_) { return null; }     // absent → every region stays algorithmic
  });

  // ── Computed Modern-map layout cache ──────────────────────────────────────
  // Building the flat galaxy layout costs ~1.6s of solid CPU on the renderer's
  // only thread — 67 per-region force relaxations over 5 500 systems. It is
  // also a PURE FUNCTION of the SDE: no randomness anywhere in the layout path,
  // so the same static data always yields the same positions. There is
  // therefore no reason to compute it more than once per SDE version.
  //
  // Keyed on the SDE build number in data/sde.md5, which the SDE updater
  // rewrites whenever the static data changes — a new SDE invalidates the cache
  // automatically, and a corrupt/absent key just means "recompute", never
  // "serve a wrong map".
  //
  // Distinct from modern-map-layout.json above: that one is HAND-CURATED and
  // outranks both this cache and the algorithm.
  const _autoLayoutPath = () => path.join(app.getPath('userData'), 'modern-map-layout.auto.json');

  function _sdeVersion() {
    try {
      const v = fs.readFileSync(getSdeMd5Path(), 'utf8').trim();
      return v || null;
    } catch (_) { return null; }
  }

  ipcHandle('modern-layout-cache-get', async () => {
    const version = _sdeVersion();
    if (!version) return null;          // can't prove freshness → recompute
    try {
      const saved = JSON.parse(fs.readFileSync(_autoLayoutPath(), 'utf8'));
      if (!saved || saved.sdeVersion !== version || !saved.systems) return null;
      return saved;
    } catch (_) { return null; }
  });

  ipcHandle('modern-layout-cache-put', async (_e, layout) => {
    const version = _sdeVersion();
    if (!version || !layout || !layout.systems) return false;
    try {
      fs.writeFileSync(_autoLayoutPath(),
        JSON.stringify({ ...layout, sdeVersion: version, builtAt: Date.now() }));
      return true;
    } catch (e) {
      console.warn('[map] could not cache the computed layout:', e.message);
      return false;   // a failed cache write must never break the map
    }
  });
  // Relax the per-region gate graphs on a worker pool (see src/galaxy_layout.js)
  // so the renderer doesn't spend ~1.4s of its only thread on them. Whatever
  // comes back is used; whatever doesn't, map.js lays out itself.
  ipcHandle('map-build-region-layouts', async (_e, job) => {
    try {
      return await galaxyLayout.buildRegionLayouts(job || {});
    } catch (e) {
      console.warn('[map] parallel region layout failed:', e.message);
      return { layouts: {}, ms: 0, workers: 0, failed: -1 };
    }
  });

  // ── Alliance-space incursion alert (dashboard widget) ─────────────────────
  // Given the character's allianceId, returns every incursion-infested system
  // that falls within that alliance's sovereign space, with names resolved.
  // Returns null when the alliance holds no sov or there are no active incursions.
  ipcHandle('get-sov-incursion-alert', async (_, allianceId) => {
    if (!allianceId) return null;
    try {
      // Re-use the same cache keys as the map-page overlays
      let sovMap = readCache(SOV_CACHE_KEY);
      if (!sovMap) sovMap = await _fetchSovSystems({ httpGet, writeCache });

      // Full incursion objects (different key from the id-only list)
      let incursions = readCache('map_incursions_full');
      if (!incursions) {
        incursions = await httpGet(`${ESI_BASE}/incursions/?datasource=tranquility`);
        if (!Array.isArray(incursions)) incursions = [];
        writeCache('map_incursions_full', incursions, 1 / 48);
      }

      // Systems where this alliance holds sov
      const allianceSysIds = new Set();
      for (const [sysId, sov] of Object.entries(sovMap)) {
        if (sov.allianceId === allianceId) {
          allianceSysIds.add(parseInt(sysId, 10));
        }
      }
      if (!allianceSysIds.size) return null;

      // Intersect with infested systems
      const infested = [];
      for (const inc of incursions) {
        const stagingId = inc.staging_solar_system_id || null;
        for (const sysId of (inc.infested_solar_systems || [])) {
          if (allianceSysIds.has(sysId)) {
            infested.push({
              systemId: sysId,
              state:    inc.state || 'Unknown',
              hasBoss:  !!inc.has_boss,
              isHQ:     sysId === stagingId,
            });
          }
        }
      }
      if (!infested.length) return null;

      // Resolve names from SDE
      const db = getSdeDb();
      if (!db) {
        return { systems: infested.map(s => ({
          ...s, systemName: `System ${s.systemId}`, regionName: 'Unknown', security: 0,
        })) };
      }

      const ids     = infested.map(s => s.systemId);
      const ph      = ids.map(() => '?').join(',');
      const sysRows = await db.all(
        `SELECT solarSystemID AS id, solarSystemName AS name,
                security, regionID AS regionId
         FROM   mapSolarSystems WHERE solarSystemID IN (${ph})`, ids
      );
      const sysMap = {};
      for (const r of sysRows) sysMap[r.id] = r;

      const regionIds = [...new Set(sysRows.map(r => r.regionId).filter(Boolean))];
      const regMap    = {};
      if (regionIds.length) {
        const rph     = regionIds.map(() => '?').join(',');
        const regRows = await db.all(
          `SELECT regionID AS id, regionName AS name FROM mapRegions WHERE regionID IN (${rph})`,
          regionIds
        );
        for (const r of regRows) regMap[r.id] = r.name;
      }

      return {
        systems: infested.map(s => {
          const sys = sysMap[s.systemId] || {};
          return {
            systemId:   s.systemId,
            systemName: sys.name     || `System ${s.systemId}`,
            security:   typeof sys.security === 'number' ? sys.security : 0,
            regionName: regMap[sys.regionId] || 'Unknown',
            state:      s.state,
            hasBoss:    s.hasBoss,
            isHQ:       s.isHQ,
          };
        }),
      };
    } catch (e) {
      console.warn('[map] sov incursion alert failed:', e.message);
      return null;
    }
  });

  // ── Alliance identities (batch, cached 24 h) ───────────────────────────────
  // Fetches /v3/alliances/{id}/ for each ID and returns { id: { ticker, name } }.
  // Region labels want the ticker, the influence field's territory titles want
  // the full name, and both come from the same call — so fetch once, return both.
  // Called after dominant-sov is computed and when the influence field rebuilds;
  // typically ~30–60 unique IDs.
  //
  // Deliberately a new cache key: entries under the old `map_ticker_*` are bare
  // ticker STRINGS, and handing one of those back where an object is expected
  // would silently drop every name until the old entries aged out.
  ipcHandle('map-get-alliance-tickers', async (_, allianceIds) => {
    if (!Array.isArray(allianceIds) || !allianceIds.length) return {};
    const result = {};
    await Promise.all(allianceIds.map(async id => {
      const key = `map_alliance_${id}`;
      const cached = readCache(key);
      if (cached) { result[id] = cached; return; }
      try {
        const data = await httpGet(
          `${ESI_BASE}/alliances/${id}/?datasource=tranquility`
        );
        if (data && (data.ticker || data.name)) {
          const ident = { ticker: data.ticker || null, name: data.name || null };
          writeCache(key, ident, 1); // 24 h
          result[id] = ident;
        }
      } catch (_) { /* ignore individual failures */ }
    }));
    return result;
  });

  // ── Galaxy data from SDE (systems + stargate jumps + region names) ─────────
  // Heavy query but SDE is local SQLite — typically < 200 ms.
  // Cached in process memory after first call (SDE is read-only at runtime).
  ipcHandle('map-get-galaxy', async () => {
    if (_galaxyCache) return _galaxyCache;
    const db = getSdeDb();
    if (!db) throw new Error('SDE database not available — check Settings > Database');

    // x2d/y2d are CCP's own schematic positions. They only exist in databases
    // built after the converter learned to carry position2D through, and an
    // install that has not refreshed its SDE still has the old schema — so the
    // columns are probed rather than assumed. Selecting a missing column throws
    // and would take the whole map down with it.
    let has2d = false;
    try {
      const cols = await db.all('PRAGMA table_info(mapSolarSystems)');
      has2d = cols.some(c => c.name === 'x2d') && cols.some(c => c.name === 'y2d');
    } catch { has2d = false; }
    // Same story for each region's skybox file, added to the builder later still.
    let hasNebula = false;
    try {
      hasNebula = (await db.all('PRAGMA table_info(mapRegions)')).some(c => c.name === 'nebulaFile');
    } catch { hasNebula = false; }

    const [systems, jumps, regRows, conRows, starRows] = await Promise.all([
      db.all(
        `SELECT solarSystemID   AS id,
                solarSystemName AS name,
                x, y, z,
                ${has2d ? 'x2d, y2d,' : ''}
                security        AS sec,
                regionID        AS regionId,
                constellationID AS constellationId,
                factionID       AS factionId
         FROM   mapSolarSystems`
      ),
      db.all(
        `SELECT fromSolarSystemID AS "from",
                toSolarSystemID   AS "to"
         FROM   mapSolarSystemJumps`
      ),
      db.all(
        `SELECT regionID   AS id,
                ${hasNebula ? 'nebulaFile,' : ''}
                regionName AS name
         FROM   mapRegions`
      ),
      // Constellation names, for the map's middle aggregation level. The ids
      // already ride along on every system; only the labels were missing.
      db.all(
        `SELECT constellationID   AS id,
                constellationName AS name
         FROM   mapConstellations`
      ),
      // Each system's star, for the map's Natural overlay: its own row in
      // mapDenormalize, group 6 (Sun). Not via mapSolarSystems.sunTypeID - that
      // column means different things by SDE vintage: our builder stores CCP's
      // starID there (an ITEM id), the old Fuzzwork dump a real type id. The
      // group-6 row is the same in both. Its own query, and allowed to fail:
      // without it the map still loads, and Natural draws every star plain white.
      db.all(
        `SELECT d.solarSystemID AS id,
                t.typeName      AS star,
                d.radius        AS starRadius
         FROM   mapDenormalize d
         LEFT JOIN invTypes t ON t.typeID = d.typeID
         WHERE  d.groupID = 6`
      ).catch(() => []),
    ]);

    const regions = {};
    const regionNebulae = {};
    for (const r of regRows) {
      regions[r.id] = r.name;
      if (r.nebulaFile) regionNebulae[r.id] = r.nebulaFile;
    }
    const constellations = {};
    for (const c of conRows) constellations[c.id] = c.name;
    const starOf = new Map(starRows.map(r => [r.id, r]));
    for (const sy of systems) {
      const st = starOf.get(sy.id);
      if (st) { sy.star = st.star; sy.starRadius = st.starRadius; }
    }

    _galaxyCache = { systems, jumps, regions, constellations, has2d, regionNebulae };
    if (!hasNebula) console.log('[map] SDE predates region skyboxes — the map draws its backdrop without region nebulae');
    if (has2d) {
      const n = systems.filter(sy => sy.x2d !== null && sy.x2d !== undefined).length;
      console.log(`[map] SDE carries CCP schematic positions for ${n} systems`);
    } else {
      console.log('[map] SDE predates position2D — flat map falls back to the reconstructed layout');
    }
    return _galaxyCache;
  });

  // ── ESI: sovereignty map (cached 5 min, the endpoint's own TTL) ────────────
  ipcHandle('map-get-sovereignty', async () => {
    const cached = readCache(SOV_CACHE_KEY);
    if (cached) return cached;
    try {
      return await _fetchSovSystems({ httpGet, writeCache });
    } catch (e) {
      console.warn('[map] sovereignty fetch failed:', e.message);
      return {};
    }
  });


  // ── ESI: live map layers ───────────────────────────────────────────────────
  //
  // Five public endpoints that the map never used, each cached for the window
  // ESI itself serves it on. Fetching faster than that window cannot return
  // anything new - it just spends the shared error budget - and fetching slower
  // shows stale numbers on a layer whose whole value is being current. The TTLs
  // below were read off the live `expires` headers rather than recalled.
  //
  // All five are PUBLIC: no scope, no token, nothing tied to a character. They
  // work on a fresh install with nobody logged in.
  //
  // Every one returns a plain object keyed by system id, because a Map does not
  // survive structured-clone across IPC in a useful shape.

  // Ship jumps through each system in the last hour. ESI caches this for an
  // hour; it is the "where is everybody" layer.
  ipcHandle('map-get-traffic', async () => {
    const key = 'map_traffic';
    const cached = readCache(key);
    if (cached) return cached;
    const out = {};
    try {
      const rows = await httpGet(`${ESI_BASE}/universe/system_jumps/?datasource=tranquility`);
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (r && r.system_id != null) out[r.system_id] = r.ship_jumps || 0;
        }
      }
      writeCache(key, out, 1 / 24);   // 1 hour
      _recordHistory(readCache, writeCache, { traffic: out });
    } catch (e) {
      console.warn('[map] traffic fetch failed:', e.message);
    }
    return out;
  });

  // Ship, pod and NPC kills in the last hour. One fetch feeds two layers -
  // player danger (ship + pod) and ratting activity (npc) - so they are kept
  // together rather than pulling the same endpoint twice.
  ipcHandle('map-get-kills', async () => {
    const key = 'map_kills';
    const cached = readCache(key);
    if (cached) return cached;
    const out = {};
    try {
      const rows = await httpGet(`${ESI_BASE}/universe/system_kills/?datasource=tranquility`);
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (r && r.system_id != null) {
            out[r.system_id] = {
              ship: r.ship_kills || 0,
              pod:  r.pod_kills  || 0,
              npc:  r.npc_kills  || 0,
            };
          }
        }
      }
      writeCache(key, out, 1 / 24);   // 1 hour
      const ship = {}, npc = {};
      for (const [sid, k] of Object.entries(out)) { ship[sid] = k.ship + k.pod; npc[sid] = k.npc; }
      _recordHistory(readCache, writeCache, { ship, npc });
    } catch (e) {
      console.warn('[map] kills fetch failed:', e.message);
    }
    return out;
  });

  // Sovereignty campaigns are keyed by CONSTELLATION, not system, so the
  // renderer has to map them back through the SDE. Returned as-is, with the
  // event time, because a timer is the useful part.
  //
  // ESI serves this on a 5-second window, which is a cadence for a client
  // watching a live timer tick - not for a map layer. Five minutes is the
  // honest compromise: a campaign's schedule is set hours ahead, and polling
  // 720 times an hour to watch a number that moves on the hour would spend the
  // shared error budget for nothing.
  ipcHandle('map-get-sov-campaigns', async () => {
    const key = 'map_sov_campaigns';
    const cached = readCache(key);
    if (cached) return cached;
    let out = [];
    try {
      const rows = await httpGet(`${ESI_BASE}/sovereignty/campaigns/?datasource=tranquility`);
      if (Array.isArray(rows)) {
        out = rows.map(r => ({
          campaignId:      r.campaign_id,
          constellationId: r.constellation_id,
          solarSystemId:   r.solar_system_id,
          structureId:     r.structure_id,
          eventType:       r.event_type,
          startTime:       r.start_time,
          defenderId:      r.defender_id,
          defenderScore:   r.defender_score,
          attackersScore:  r.attackers_score,
        }));
      }
      writeCache(key, out, 1 / 288);   // 5 minutes
    } catch (e) {
      console.warn('[map] sov campaign fetch failed:', e.message);
    }
    return out;
  });

  // Faction-warfare system ownership and contested state. Already fetched for
  // the FW page; this is the same data shaped for the map.
  ipcHandle('map-get-fw-systems', async () => {
    const key = 'map_fw_systems';
    const cached = readCache(key);
    if (cached) return cached;
    const out = {};
    try {
      const rows = await httpGet(`${ESI_BASE}/fw/systems/?datasource=tranquility`);
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (r && r.solar_system_id != null) {
            out[r.solar_system_id] = {
              owner:     r.owner_faction_id,
              occupier:  r.occupier_faction_id,
              contested: r.contested,
              progress:  r.victory_points_threshold
                ? (r.victory_points || 0) / r.victory_points_threshold : 0,
            };
          }
        }
      }
      writeCache(key, out, 1 / 48);   // 30 minutes
    } catch (e) {
      console.warn('[map] fw systems fetch failed:', e.message);
    }
    return out;
  });

  // Industry cost indices per system. The map only wants the manufacturing
  // index - the other activities are a research question, not a spatial one.
  ipcHandle('map-get-industry-indices', async () => {
    const key = 'map_industry_idx';
    const cached = readCache(key);
    if (cached) return cached;
    const out = {};
    try {
      const rows = await httpGet(`${ESI_BASE}/industry/systems/?datasource=tranquility`);
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (!r || r.solar_system_id == null) continue;
          const man = (r.cost_indices || []).find(c => c.activity === 'manufacturing');
          out[r.solar_system_id] = man ? man.cost_index : 0;
        }
      }
      writeCache(key, out, 1 / 24);   // 1 hour
    } catch (e) {
      console.warn('[map] industry index fetch failed:', e.message);
    }
    return out;
  });


  // ── zKillboard: what actually died in one system ───────────────────────────
  //
  // ESI's kill count says THIRTEEN and nothing else — not what, not whose, and
  // crucially not WHEN inside the hour. Thirteen kills spread over an hour is a
  // camp you might still fly into; thirteen in ninety seconds is a brawl that
  // ended before you opened the map. Same number, opposite decision.
  //
  // zKillboard is the only public source for that detail. It is volunteer-run
  // and free, so this is fetched ONLY when a person clicks a system — never on
  // a timer, never speculatively for what is on screen — and cached per system.
  ipcHandle('map-get-system-kill-log', async (_e, systemId) => {
    const id = Number(systemId);
    if (!Number.isFinite(id)) return [];
    const key = `map_killlog_${id}`;
    const cached = readCache(key);
    if (cached) return cached;
    let out = [];
    try {
      const rows = await httpGet(`https://zkillboard.com/api/systemID/${id}/`);
      if (Array.isArray(rows)) {
        // Trimmed hard: the panel needs a time, a hull, a victim and a value.
        // Shipping whole killmails across IPC would be ~200x the payload.
        out = rows.slice(0, 120).map(r => ({
          id:        r.killmail_id,
          t:         r.killmail_time,
          shipId:    r.victim && r.victim.ship_type_id,
          charId:    r.victim && r.victim.character_id,
          corpId:    r.victim && r.victim.corporation_id,
          allianceId: r.victim && r.victim.alliance_id,
          attackers: Array.isArray(r.attackers) ? r.attackers.length : 0,
          value:     (r.zkb && r.zkb.totalValue) || 0,
          npc:       !!(r.zkb && r.zkb.npc),
          solo:      !!(r.zkb && r.zkb.solo),
        }));
      }
      writeCache(key, out, 1 / 288);      // 5 minutes
    } catch (e) {
      console.warn(`[map] kill log for ${id} failed:`, e.message);
    }
    return out;
  });

  // The recorded curve for one system — traffic, player kills and NPC kills.
  ipcHandle('map-get-system-history', async (_e, systemId) => {
    const id = String(Number(systemId));
    const store = readCache('map_layer_history');
    if (!store || !Array.isArray(store.t) || !store.t.length) {
      return { t: [], traffic: [], ship: [], npc: [] };
    }
    const pick = (f) => (store[f] && store[f][id]) || new Array(store.t.length).fill(0);
    return { t: store.t, traffic: pick('traffic'), ship: pick('ship'), npc: pick('npc') };
  });

  // ── ESI: active incursions (cached 30 min) ─────────────────────────────────
  ipcHandle('map-get-incursions', async () => {
    const key    = 'map_incursions';
    const cached = readCache(key);
    if (cached) return cached;
    try {
      const data = await httpGet(`${ESI_BASE}/incursions/?datasource=tranquility`);
      const ids  = [];
      if (Array.isArray(data)) {
        for (const inc of data) {
          if (Array.isArray(inc.infested_solar_systems)) {
            ids.push(...inc.infested_solar_systems);
          }
        }
      }
      writeCache(key, ids, 1 / 48); // 30 minutes
      return ids;
    } catch (e) {
      console.warn('[map] incursions fetch failed:', e.message);
      return [];
    }
  });

}

// _fetchSovSystems is exported for its test: the field it maps (is_capital_system)
// is the one that was silently dropped, and only a real-shape response pins it.
module.exports = { registerMapHandlers, _fetchSovSystems };
