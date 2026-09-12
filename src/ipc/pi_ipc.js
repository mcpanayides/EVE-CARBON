// ─── src/ipc/pi_ipc.js ────────────────────────────────────────────────────────
//
// Handles all Planetary Interaction IPC calls between main and renderer.
//
// Registered channels:
//   'sync-pi'            → syncPIForCharacter(characterId)
//   'get-pi-colonies'    → getColoniesWithStorage(characterId)
//
// ─────────────────────────────────────────────────────────────────────────────

const { ESI_BASE } = require('../app_ident');   // one definition — src/shared/esi.js

// The two skills that decide what a character can do with PI. Verified against
// the SDE rather than typed from memory: a name search for either also matches
// a Skill Accelerator booster, which is not a skill.
const IC_SKILL_ID  = 2495;   // Interplanetary Consolidation -> planets = 1 + level
const CCU_SKILL_ID = 2505;   // Command Center Upgrades      -> command centre tier

// ─── PI storage-type registry ─────────────────────────────────────────────────
// Built dynamically from the SDE at first sync so every planet-specific
// launchpad/storage-facility type ID is covered automatically.
// Hard-coded fallback used when the SDE is unavailable.
const PI_STORAGE_TYPES_FALLBACK = {
  2257: { name: 'Storage Facility', capacity: 12_000 },
  2848: { name: 'Launchpad',        capacity: 10_000 }, // Temperate
  3060: { name: 'Launchpad',        capacity: 10_000 }, // Barren
  3061: { name: 'Launchpad',        capacity: 10_000 }, // Gas
  3062: { name: 'Launchpad',        capacity: 10_000 }, // Ice
  3063: { name: 'Launchpad',        capacity: 10_000 }, // Lava
  3064: { name: 'Launchpad',        capacity: 10_000 }, // Oceanic
  3067: { name: 'Launchpad',        capacity: 10_000 }, // Plasma
  3068: { name: 'Launchpad',        capacity: 10_000 }, // Storm
};

let _storageTypesCache = null; // populated once from SDE, then reused

async function buildStorageTypes(sdeDb) {
  if (_storageTypesCache) return _storageTypesCache;
  if (!sdeDb) { _storageTypesCache = PI_STORAGE_TYPES_FALLBACK; return _storageTypesCache; }

  // Find whichever invTypes table the SDE uses
  let invTable = null;
  for (const t of [{ t: 'invTypes', id: 'typeID', name: 'typeName' },
                   { t: 'invTypes_en', id: 'typeID', name: 'typeName' }]) {
    try { await sdeDb.get(`SELECT ${t.id} FROM ${t.t} LIMIT 1`); invTable = t; break; }
    catch { /* try next */ }
  }
  if (!invTable) { _storageTypesCache = PI_STORAGE_TYPES_FALLBACK; return _storageTypesCache; }

  const rows = await sdeDb.all(
    `SELECT ${invTable.id} AS typeID, ${invTable.name} AS typeName
       FROM ${invTable.t}
      WHERE ${invTable.name} LIKE '%Launchpad%'
         OR ${invTable.name} LIKE '%Storage Facility%'`
  );

  const map = {};
  for (const { typeID, typeName } of rows) {
    if (typeName.includes('Launchpad')) {
      map[typeID] = { name: 'Launchpad',        capacity: 10_000 };
    } else if (typeName.includes('Storage Facility')) {
      map[typeID] = { name: 'Storage Facility', capacity: 12_000 };
    }
  }

  _storageTypesCache = Object.keys(map).length > 0 ? map : PI_STORAGE_TYPES_FALLBACK;
  console.log(`[PI] Storage type registry: ${Object.keys(_storageTypesCache).length} types from SDE`);
  return _storageTypesCache;
}

// ─── PI commodity volumes (m³ per unit) ──────────────────────────────────────
// These are the standard P0-P4 tier volumes from the EVE SDE.
// Used to compute fill % from contents[].amount when exact SDE is unavailable.
// If your app already has an SDE DB, replace getItemVolume() with an SDE lookup.
const PI_ITEM_VOLUMES = {
  // P0 — Raw resources (0.01 m³)
  2267: 0.01, 2268: 0.01, 2272: 0.01, 2073: 0.01, 2306: 0.01,
  2307: 0.01, 2308: 0.01, 2309: 0.01, 2310: 0.01, 2311: 0.01,
  2312: 0.01, 2313: 0.01, 2318: 0.01, 2319: 0.01, 2321: 0.01,
  2328: 0.01, 2329: 0.01, 2332: 0.01, 2333: 0.01, 2344: 0.01,
  2345: 0.01, 2346: 0.01, 2348: 0.01, 2349: 0.01, 2351: 0.01,
  2352: 0.01, 2360: 0.01, 2361: 0.01, 2362: 0.01, 2366: 0.01,
  2367: 0.01, 2385: 0.01, 2386: 0.01, 2390: 0.01, 2392: 0.01,
  2393: 0.01, 2396: 0.01, 2397: 0.01, 2398: 0.01, 2400: 0.01,
  2401: 0.01, 2413: 0.01,

  // P1 — Processed materials (0.38 m³)
  2389: 0.38, 2390: 0.38, 2392: 0.38, 2395: 0.38, 2399: 0.38,
  3779: 0.38, 3828: 0.38, 3830: 0.38, 3831: 0.38, 3832: 0.38,
  3833: 0.38, 3834: 0.38, 3835: 0.38, 3836: 0.38, 3837: 0.38,
  9828: 0.38,

  // P2 — Refined commodities (1.5 m³)
  2329: 1.5,  2463: 1.5,  2667: 1.5,  2868: 1.5,  2876: 1.5,
  2877: 1.5,  2878: 1.5,  2879: 1.5,  2880: 1.5,  2881: 1.5,
  2882: 1.5,  2886: 1.5,  2887: 1.5,  2888: 1.5,  2889: 1.5,
  2890: 1.5,  2891: 1.5,  2892: 1.5,  2893: 1.5,  2894: 1.5,
  2895: 1.5,  2896: 1.5,  2897: 1.5,  2898: 1.5,  2899: 1.5,
  2900: 1.5,  2901: 1.5,  2902: 1.5,  2903: 1.5,  2904: 1.5,

  // P3 — Specialized commodities (6 m³)
  2344: 6,    2345: 6,    2346: 6,    2348: 6,    2349: 6,
  2351: 6,    2352: 6,    2354: 6,    2355: 6,    2358: 6,
  2360: 6,    2361: 6,    2362: 6,    2366: 6,    2367: 6,
  17136: 6,   17392: 6,   17898: 6,   28974: 6,

  // P4 — Advanced commodities (100 m³)
  2867: 100,  12836: 100, 17040: 100, 33336: 100, 33337: 100,
  33338: 100, 33339: 100, 33340: 100,
};

/**
 * Best-effort volume lookup.  Falls back to 1 m³ (conservative) so fill bars
 * never show 0% for unknown items.
 */
function getItemVolume(typeId) {
  return PI_ITEM_VOLUMES[typeId] ?? 1;
}

/**
 * Given an array of ESI pin objects for one planet, return a summary of
 * ONLY launchpad and storage facility pins.  Processors, extractors and
 * command centres are excluded — they hold input buffers that would
 * otherwise appear as false LP bars.
 * @param {object[]} pins  - ESI pin objects
 * @param {object}   storageTypes - map of typeID → {name, capacity}
 */
function summariseStorage(pins, storageTypes) {
  const stores = [];
  for (const pin of (pins || [])) {
    const storeInfo = storageTypes[pin.type_id];
    if (!storeInfo) continue;   // skip extractors, processors, CCs, etc.

    const contents = (pin.contents || []).map(c => ({
      type_id:   c.type_id,
      amount:    c.amount,
      volume_m3: getItemVolume(c.type_id) * c.amount,
    }));
    const used_m3  = contents.reduce((s, c) => s + c.volume_m3, 0);
    const fill_pct = Math.min(100, Math.round((used_m3 / storeInfo.capacity) * 100));

    stores.push({
      pin_id:      pin.pin_id,
      type_id:     pin.type_id,
      label:       storeInfo.name,
      capacity_m3: storeInfo.capacity,
      used_m3:     Math.round(used_m3 * 100) / 100,
      fill_pct,
      contents,
    });
  }
  return stores;
}

// ─────────────────────────────────────────────────────────────────────────────

function registerPIHandlers({
  ipcHandle,
  getValidToken,
  httpGet,
  resolveNames,
  charInfoDb,
  getSdeDb,
}) {

  // ── sync-pi ─────────────────────────────────────────────────────────────────
  ipcHandle('sync-pi', async (_event, { characterId }) => {
    const accessToken = await getValidToken(characterId);
    return syncPIForCharacter({ characterId, accessToken, httpGet, resolveNames, charInfoDb, getSdeDb });
  });

  // ── get-pi-colonies ──────────────────────────────────────────────────────────
  // Returns the cached PI colonies from the DB, including parsed storage_json.
  // The renderer uses this to build storage bars without a fresh ESI call.

  ipcHandle('get-pi-colonies', async (_event, { characterId }) => {
    const rows = await charInfoDb.getCharacterPIColonies(characterId);
    return rows.map(row => ({
      ...row,
      storage: row.storage_json ? JSON.parse(row.storage_json) : [],
    }));
  });

  // ── pi-capacities ───────────────────────────────────────────────────────────
  // Planet slots and command-centre tier for MANY characters in one call.
  //
  // Deliberately batched. The renderer used to ask per character and pull the
  // whole skill list each time, to tell "trained to zero" from "never synced" by
  // the row count. Correct, but it is one IPC round-trip and ~300 rows per
  // character on every visit to the page -- and people run PI on dozens of alts.
  // This asks once and returns four numbers each.
  //
  //   ic     Interplanetary Consolidation  -> planets = 1 + level
  //   ccu    Command Center Upgrades       -> command centre tier, so what a
  //                                           planet can physically hold
  //   synced false when the character has no skill rows at all, which the page
  //          must show as unknown rather than guessing zero
  ipcHandle('pi-capacities', async (_event, characterIds) => {
    const ids = Array.isArray(characterIds) ? characterIds : [];
    const out = {};
    await Promise.all(ids.map(async (id) => {
      const cid = Number(id);
      if (!Number.isFinite(cid)) return;
      const { levels, total } = await charInfoDb.getSkillProfile(cid, [IC_SKILL_ID, CCU_SKILL_ID]);
      out[cid] = {
        ic:     levels[IC_SKILL_ID]  || 0,
        ccu:    levels[CCU_SKILL_ID] || 0,
        synced: total > 0,
      };
    }));
    return out;
  });

  // ── pi-schematics ───────────────────────────────────────────────────────────
  // The P0→P4 recipe graph. Small (68 schematics, ~200 rows) and immutable
  // between SDE updates, so it is sent whole and indexed once in the renderer.
  //
  // Returns null when the tables are absent, which is the state every install
  // is in until its next SDE update — the pages check for that and say so
  // rather than rendering an empty production model as though it were the truth.
  ipcHandle('pi-schematics', async () => {
    const sde = getSdeDb ? getSdeDb() : null;
    if (!sde) return null;
    try {
      const [schematics, typeMap] = await Promise.all([
        sde.all('SELECT schematicID, schematicName, cycleTime FROM planetSchematics'),
        sde.all('SELECT schematicID, typeID, quantity, isInput FROM planetSchematicsTypeMap'),
      ]);
      if (!schematics.length) return null;
      return { schematics, typeMap };
    } catch (_) {
      return null;    // pre-schematics SDE: the table does not exist yet
    }
  });

  // ── pi-planet-candidates ────────────────────────────────────────────────────
  // Planets of the requested types within N jumps of an origin system.
  //
  // The jump graph is walked LOCALLY, from mapSolarSystemJumps. The PI page's
  // existing distance helper asks ESI /route/ once per destination, which is
  // fine for the dozen systems you already have colonies in and hopeless here:
  // a five-jump radius is hundreds of systems, and the planner would spend the
  // shared ESI error budget to compute something the SDE can answer offline.
  //
  // What this CANNOT do is say whether a planet is rich. Nothing can — see
  // PiModel.SURVEY_CAVEAT. It answers "the right kind of planet, near you".
  ipcHandle('pi-planet-candidates', async (_event, { originSystemId, maxJumps = 5, planetTypes = [] }) => {
    const sde = getSdeDb ? getSdeDb() : null;
    if (!sde || !originSystemId) return [];

    const jumps = await getJumpGraph(sde);
    const dist = new Map([[Number(originSystemId), 0]]);
    let frontier = [Number(originSystemId)];
    for (let d = 1; d <= maxJumps && frontier.length; d++) {
      const next = [];
      for (const sys of frontier) {
        for (const nb of (jumps.get(sys) || [])) {
          if (dist.has(nb)) continue;
          dist.set(nb, d);
          next.push(nb);
        }
      }
      frontier = next;
    }
    if (!dist.size) return [];

    // "Planet (Temperate)" is how the SDE names them; match on the word.
    const wanted = planetTypes.map(t => String(t).toLowerCase());
    const ids = [...dist.keys()];
    const rows = await sde.all(
      `SELECT d.itemID AS planetId, d.itemName AS planetName, d.solarSystemID AS systemId,
              s.solarSystemName AS systemName, s.security, t.typeName AS planetType
         FROM mapDenormalize d
         JOIN invTypes t        ON t.typeID = d.typeID
         JOIN mapSolarSystems s ON s.solarSystemID = d.solarSystemID
        WHERE d.groupID = 7 AND d.solarSystemID IN (${ids.map(() => '?').join(',')})`,
      ids
    );

    return rows
      .map(r => ({ ...r, planetType: String(r.planetType).replace(/^Planet \(|\)$/g, '').toLowerCase(),
                   jumps: dist.get(r.systemId) }))
      .filter(r => !wanted.length || wanted.includes(r.planetType))
      .sort((a, b) => a.jumps - b.jumps || a.systemName.localeCompare(b.systemName));
  });
}

// Adjacency built once per session — 13,978 edges, and the planner re-queries it
// on every parameter change.
let _jumpGraph = null;
async function getJumpGraph(sde) {
  if (_jumpGraph) return _jumpGraph;
  const rows = await sde.all('SELECT fromSolarSystemID f, toSolarSystemID t FROM mapSolarSystemJumps');
  const g = new Map();
  for (const { f, t } of rows) {
    if (!g.has(f)) g.set(f, []);
    g.get(f).push(t);
  }
  _jumpGraph = g;
  return g;
}

// ─── Core sync logic (also exported for use by main.js sync functions) ────────
async function syncPIForCharacter(
  { characterId, accessToken, httpGet, resolveNames, charInfoDb, getSdeDb },
  report = () => {}
) {
  report('pi', 'Fetching PI colonies…');
  const authHdr    = { Authorization: `Bearer ${accessToken}` };
  const storageTypes = await buildStorageTypes(getSdeDb ? getSdeDb() : null);
  const colonies = await httpGet(
    `${ESI_BASE}/characters/${characterId}/planets/?datasource=tranquility`,
    authHdr
  );

  if (!Array.isArray(colonies)) return 0;

  const sysIds   = [...new Set(colonies.map(c => c.solar_system_id).filter(Boolean))];
  const sysNames = sysIds.length ? await resolveNames(sysIds) : {};

  const piData = await Promise.all(colonies.map(async c => {
    let extractor_expires_at = null;
    let storage_json         = null;
    let pins_json            = null;
    let routes_json          = null;

    try {
      const detail = await httpGet(
        `${ESI_BASE}/characters/${characterId}/planets/${c.planet_id}/?datasource=tranquility`,
        authHdr
      );

      // ── Extractor expiry ──────────────────────────────────────────────────
      const now      = Date.now();
      const expiries = (detail.pins || [])
        .filter(p => p.expiry_time)
        .map(p    => new Date(p.expiry_time).getTime())
        .filter(t => t > now);
      extractor_expires_at = expiries.length ? Math.min(...expiries) : null;

      // ── Storage summary ───────────────────────────────────────────────────
      const stores = summariseStorage(detail.pins, storageTypes);
      storage_json = JSON.stringify(stores);

      // ── Full pin list (for View All panel in UI) ──────────────────────────
      pins_json = JSON.stringify(detail.pins || []);

      // ── Routes ────────────────────────────────────────────────────────────
      // Already in this response; it was being thrown away. Without it a factory
      // pin tells you what it COULD make and nothing about whether anything
      // feeds it — so a network analysis can only report installed capacity,
      // never what is actually running. Costs no extra call.
      routes_json = JSON.stringify(detail.routes || []);
    } catch {
      // Detail call failed — leave all null; colony still visible as Idle
    }

    return {
      planet_id:            c.planet_id,
      planet_type:          c.planet_type          || null,
      solar_system_id:      c.solar_system_id,
      solar_system_name:    sysNames[c.solar_system_id] || null,
      upgrade_level:        c.upgrade_level         || 0,
      num_pins:             c.num_pins              || 0,
      last_update:          c.last_update ? new Date(c.last_update).getTime() : null,
      extractor_expires_at,
      storage_json,
      pins_json,
      routes_json,
    };
  }));

  await charInfoDb.replacePiColonies(characterId, piData);
  report('pi', `✓ ${piData.length} PI colonies`);
  return piData.length;
}

module.exports = { registerPIHandlers, syncPIForCharacter, summariseStorage };