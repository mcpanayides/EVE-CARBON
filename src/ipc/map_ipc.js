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
// always consumed: { systemId: { allianceId, corporationId, factionId } }.
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
    };
  }
  writeCache(SOV_CACHE_KEY, sovMap, SOV_TTL_DAYS);
  return sovMap;
}

// Hand-curated Modern-map layout (the in-app layout editor writes this).
// When present it wins over the algorithmic layout wholesale.
const _modernLayoutPath = () => path.join(app.getPath('userData'), 'modern-map-layout.json');

function registerMapHandlers({ ipcHandle, httpGet, readCache, writeCache, getSdeDb, getSdeMd5Path }) {

  // ── Custom Modern-map layout: persist / load / reset ───────────────────────
  ipcHandle('modern-layout-get', async () => {
    try { return JSON.parse(fs.readFileSync(_modernLayoutPath(), 'utf8')); }
    catch (_) { return null; }   // no custom layout saved yet
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

    const [systems, jumps, regRows] = await Promise.all([
      db.all(
        `SELECT solarSystemID   AS id,
                solarSystemName AS name,
                x, y, z,
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
                regionName AS name
         FROM   mapRegions`
      ),
    ]);

    const regions = {};
    for (const r of regRows) regions[r.id] = r.name;

    _galaxyCache = { systems, jumps, regions };
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

module.exports = { registerMapHandlers };
