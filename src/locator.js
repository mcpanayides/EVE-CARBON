// ─── locator.js ───────────────────────────────────────────────────────────────
// Centralised EVE location resolver.
//
// EVE has three ID ranges for locations:
//   < 100,000,000          → solar systems / constellations / regions (public ESI)
//   60,000,000–64,000,000  → NPC stations (public ESI /universe/stations/)
//   >= 1,000,000,000,000   → player-owned structures (Citadels, ECs, Refineries…)
//                            ESI only returns these if the structure has public
//                            access OR the requesting character has docking rights.
//                            Fallback: adam4eve structure_history page (name in title).
//
// Usage in main.js:
//   const locator = require('./locator')({ httpGet, httpRaw, readCache, writeCache, getValidToken });
//   const meta    = await locator.resolveLocation(locationId, characterId);
//   const name    = await locator.resolveStructureName(structureId, characterId);
//
// resolveLocation() returns:
//   {
//     name:               string,   // best available display name
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

const ESI_BASE                  = 'https://esi.evetech.net';
const ADAM4EVE_BASE             = 'https://www.adam4eve.eu';
const PLAYER_STRUCTURE_MIN_ID   = 1_000_000_000_000;

// ─── Tiny raw HTML fetcher (no JSON parse) ────────────────────────────────────
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        'User-Agent': 'EVE-BPC-Calculator/2.0',
        'Accept':     'text/html',
      },
    }, (res) => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end',  () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── Factory ──────────────────────────────────────────────────────────────────
module.exports = function createLocator({ httpGet, readCache, writeCache, getValidToken }) {

  // ── Internal: ESI name bulk-resolver ────────────────────────────────────────
  // Accepts an array of integer IDs; returns { id: name } map.
  // Uses ESI /v3/universe/names/ which covers systems, stations, corps, etc.
  const _nameCache = {};

  async function resolveNames(ids) {
    const unique   = [...new Set(ids.map(Number).filter(Boolean))];
    const uncached = unique.filter(id => !_nameCache[id]);

    if (uncached.length) {
      const chunks = [];
      for (let i = 0; i < uncached.length; i += 1000)
        chunks.push(uncached.slice(i, i + 1000));

      for (const chunk of chunks) {
        try {
          const results = await httpGet(
            `${ESI_BASE}/v3/universe/names/?datasource=tranquility`,
            {},
            chunk          // POST body — httpGet in main.js is GET-only so we use a workaround below
          );
          results.forEach(r => { _nameCache[r.id] = r.name; });
        } catch { /* skip bad chunks */ }
      }
    }
    return Object.fromEntries(unique.map(id => [id, _nameCache[id] || null]));
  }

  // resolveNames needs POST — wire it to httpGet's underlying https module directly
  // so locator.js stays self-contained without needing httpPost injected.
  async function esiNamesPost(ids) {
    const unique   = [...new Set(ids.map(Number).filter(Boolean))];
    const uncached = unique.filter(id => !_nameCache[id]);

    if (uncached.length) {
      const chunks = [];
      for (let i = 0; i < uncached.length; i += 1000)
        chunks.push(uncached.slice(i, i + 1000));

      for (const chunk of chunks) {
        try {
          const body    = JSON.stringify(chunk);
          const urlObj  = new URL(`${ESI_BASE}/v3/universe/names/?datasource=tranquility`);
          const result  = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: urlObj.hostname,
              path:     urlObj.pathname + urlObj.search,
              method:   'POST',
              headers:  {
                'User-Agent':    'EVE-BPC-Calculator/2.0',
                'Content-Type':  'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Accept':        'application/json',
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
          result.forEach(r => { _nameCache[r.id] = r.name; });
        } catch { /* skip */ }
      }
    }
    return Object.fromEntries(unique.map(id => [id, _nameCache[id] || null]));
  }

  // ── resolveStructureName ──────────────────────────────────────────────────
  // For IDs >= PLAYER_STRUCTURE_MIN_ID.
  // Returns { name, solar_system_id } with best-effort fallback chain.
  async function resolveStructureName(structureId, characterId = null) {
    const cacheKey = `struct_name_${structureId}`;
    const cached   = readCache(cacheKey);
    if (cached) return cached;

    // 1. Authenticated ESI (works if char has docking access)
    if (characterId) {
      try {
        const token = await getValidToken(characterId);
        const data  = await httpGet(
          `${ESI_BASE}/v2/universe/structures/${structureId}/?datasource=tranquility`,
          { Authorization: `Bearer ${token}` }
        );
        if (data && data.name) {
          const result = { name: data.name, solar_system_id: data.solar_system_id || null };
          writeCache(cacheKey, result, 7);
          return result;
        }
      } catch (e) {
        console.log(`[locator] ESI auth lookup failed for ${structureId}: ${e.message}`);
      }
    }

    // 2. Public ESI (works for structures with public market/services enabled)
    try {
      const data = await httpGet(
        `${ESI_BASE}/v2/universe/structures/${structureId}/?datasource=tranquility`
      );
      if (data && data.name) {
        const result = { name: data.name, solar_system_id: data.solar_system_id || null };
        writeCache(cacheKey, result, 7);
        return result;
      }
    } catch { /* fall through */ }

    // 3. adam4eve structure_history page — name lives in the <title> tag
    //    Title format: "A4E - Structure history 'Boystin - Gravity Well'"
    try {
      const html  = await fetchHtml(`${ADAM4EVE_BASE}/structure_history.php?id=${structureId}`);
      const match = html.match(/<title[^>]*>[^<]*Structure history(?:\s+for)?\s+'([^']+)'/i);
      if (match && match[1]) {
        const result = { name: match[1].trim(), solar_system_id: null };
        writeCache(cacheKey, result, 7);
        return result;
      }
    } catch (e) {
      console.log(`[locator] adam4eve fallback failed for ${structureId}: ${e.message}`);
    }

    // 4. Give up — cache failure briefly so we don't hammer external sites
    const fallback = { name: `Structure ${structureId}`, solar_system_id: null };
    writeCache(cacheKey, fallback, 1);
    return fallback;
  }

  // ── resolveLocation ────────────────────────────────────────────────────────
  // Full resolution: name + system/constellation/region/sec/owner.
  // Accepts a single location ID (station, structure, or system).
  async function resolveLocation(locationId, characterId = null) {
    const id       = Number(locationId);
    const cacheKey = `loc_full_${id}`;
    const cached   = readCache(cacheKey);
    if (cached) return cached;

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
        const info          = await resolveStructureName(id, characterId);
        result.name         = info.name;
        result.solar_system_id = info.solar_system_id;

      } else {
        // ── NPC station (60,000,000–64,000,000) ────────────────────────────
        try {
          const st = await httpGet(
            `${ESI_BASE}/v2/universe/stations/${id}/?datasource=tranquility`
          );
          result.name            = st.name             || null;
          result.solar_system_id = st.system_id        || st.solar_system_id || null;
          result.owner_id        = st.owner            || null;
        } catch { /* not a station — try system ID */ }

        // ── Bare solar system ID ────────────────────────────────────────────
        if (!result.solar_system_id) {
          try {
            const sys = await httpGet(
              `${ESI_BASE}/v4/universe/systems/${id}/?datasource=tranquility`
            );
            if (sys && sys.system_id) {
              result.solar_system_id = id;
              result.name            = sys.name || null;
            }
          } catch { /* not a system either */ }
        }
      }

      // ── Walk up the hierarchy: system → constellation → region ─────────────
      if (result.solar_system_id) {
        try {
          const sys = await httpGet(
            `${ESI_BASE}/v4/universe/systems/${result.solar_system_id}/?datasource=tranquility`
          );
          result.solar_system_name  = sys.name              || null;
          result.security_status    = sys.security_status   ?? null;
          result.constellation_id   = sys.constellation_id  || null;
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

      // ── Bulk-resolve remaining names (region, owner) ──────────────────────
      const bulkIds = [result.region_id, result.owner_id].filter(Boolean);
      if (bulkIds.length) {
        const nameMap = await esiNamesPost(bulkIds);
        if (result.region_id)  result.region_name  = nameMap[result.region_id]  || null;
        if (result.owner_id)   result.owner_name   = nameMap[result.owner_id]   || null;
      }

      // ── Fallback display name if still missing ────────────────────────────
      if (!result.name) {
        result.name = result.solar_system_name || `Location ${id}`;
      }

    } catch (e) {
      console.warn(`[locator] resolveLocation(${id}) failed: ${e.message}`);
      result.name = `Location ${id}`;
    }

    // Cache for 24 hours (structures already have their own 7-day struct_name cache)
    writeCache(cacheKey, result, 1);
    return result;
  }

  // ── resolveLocations (batch) ───────────────────────────────────────────────
  // Resolves an array of location IDs concurrently (max 8 at a time).
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

  return { resolveStructureName, resolveLocation, resolveLocations, esiNamesPost };
};