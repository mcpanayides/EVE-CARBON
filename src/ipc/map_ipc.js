'use strict';

const { app } = require('electron');
const fs   = require('fs');
const path = require('path');

const ESI_BASE     = 'https://esi.evetech.net';
const IHUB_TYPE_ID = 35833; // Infrastructure Hub — proxy for jump bridge access

// In-process cache for SDE data (never changes at runtime)
let _galaxyCache = null;

// Hand-curated Modern-map layout (the in-app layout editor writes this).
// When present it wins over the algorithmic layout wholesale.
const _modernLayoutPath = () => path.join(app.getPath('userData'), 'modern-map-layout.json');

function registerMapHandlers({ ipcHandle, httpGet, readCache, writeCache, getSdeDb }) {

  // ── Custom Modern-map layout: persist / load / reset ───────────────────────
  ipcHandle('modern-layout-get', async () => {
    try { return JSON.parse(fs.readFileSync(_modernLayoutPath(), 'utf8')); }
    catch (_) { return null; }   // no custom layout saved yet
  });
  ipcHandle('modern-layout-save', async (_, layout) => {
    if (!layout || typeof layout !== 'object' || !layout.systems) return false;
    fs.writeFileSync(_modernLayoutPath(), JSON.stringify(layout));
    return true;
  });
  ipcHandle('modern-layout-reset', async () => {
    try { fs.unlinkSync(_modernLayoutPath()); } catch (_) {}
    return true;
  });

  // ── Alliance-space incursion alert (dashboard widget) ─────────────────────
  // Given the character's allianceId, returns every incursion-infested system
  // that falls within that alliance's sovereign space, with names resolved.
  // Returns null when the alliance holds no sov or there are no active incursions.
  ipcHandle('get-sov-incursion-alert', async (_, allianceId) => {
    if (!allianceId) return null;
    try {
      // Re-use the same cache keys as the map-page overlays
      let sovMap = readCache('map_sovereignty');
      if (!sovMap) {
        const data = await httpGet(`${ESI_BASE}/v1/sovereignty/map/?datasource=tranquility`);
        sovMap = {};
        if (Array.isArray(data)) {
          for (const e of data) {
            sovMap[e.system_id] = {
              allianceId:    e.alliance_id    || null,
              corporationId: e.corporation_id || null,
              factionId:     e.faction_id     || null,
            };
          }
        }
        writeCache('map_sovereignty', sovMap, 1 / 24);
      }

      // Full incursion objects (different key from the id-only list)
      let incursions = readCache('map_incursions_full');
      if (!incursions) {
        incursions = await httpGet(`${ESI_BASE}/v1/incursions/?datasource=tranquility`);
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

  // ── Alliance tickers (batch, cached 24 h) ──────────────────────────────────
  // Fetches /v3/alliances/{id}/ for each ID and returns { id: ticker }.
  // Called once after dominant-sov is computed — typically ~30–60 unique IDs.
  ipcHandle('map-get-alliance-tickers', async (_, allianceIds) => {
    if (!Array.isArray(allianceIds) || !allianceIds.length) return {};
    const result = {};
    await Promise.all(allianceIds.map(async id => {
      const key = `map_ticker_${id}`;
      const cached = readCache(key);
      if (cached) { result[id] = cached; return; }
      try {
        const data = await httpGet(
          `${ESI_BASE}/v3/alliances/${id}/?datasource=tranquility`
        );
        if (data && data.ticker) {
          writeCache(key, data.ticker, 1); // 24 h
          result[id] = data.ticker;
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

  // ── ESI: sovereignty map (cached 1 hour) ───────────────────────────────────
  ipcHandle('map-get-sovereignty', async () => {
    const key    = 'map_sovereignty';
    const cached = readCache(key);
    if (cached) return cached;
    try {
      const data   = await httpGet(`${ESI_BASE}/v1/sovereignty/map/?datasource=tranquility`);
      const result = {};
      if (Array.isArray(data)) {
        for (const e of data) {
          result[e.system_id] = {
            allianceId:    e.alliance_id    || null,
            corporationId: e.corporation_id || null,
            factionId:     e.faction_id     || null,
          };
        }
      }
      writeCache(key, result, 1 / 24); // 1 hour
      return result;
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
      const data = await httpGet(`${ESI_BASE}/v1/incursions/?datasource=tranquility`);
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

  // ── ESI: systems with IHUB (jump bridge proxy, cached 1 hour) ─────────────
  // Ansiblex Jump Gates aren't publicly queryable; IHUB ownership is the
  // standard prerequisite for jump bridge infrastructure in sov null.
  ipcHandle('map-get-jump-bridges', async () => {
    const key    = 'map_jump_bridges';
    const cached = readCache(key);
    if (cached) return cached;
    try {
      const data = await httpGet(
        `${ESI_BASE}/v1/sovereignty/structures/?datasource=tranquility`
      );
      const ids = [];
      if (Array.isArray(data)) {
        for (const s of data) {
          if (s.structure_type_id === IHUB_TYPE_ID) {
            ids.push(s.solar_system_id);
          }
        }
      }
      writeCache(key, ids, 1 / 24); // 1 hour
      return ids;
    } catch (e) {
      console.warn('[map] jump bridges fetch failed:', e.message);
      return [];
    }
  });
}

module.exports = { registerMapHandlers };
