// ─── sde_build.js ───────────────────────────────────────────────────────────
// Converts CCP's official JSONL SDE export (developers.eveonline.com/static-data)
// into a SQLite database SCHEMA-COMPATIBLE with the Fuzzwork dump this app was
// built against — same table/column names the app already queries. This means
// zero query-site rewrites: every existing SELECT in main.js/src/ipc/*.js works
// unchanged against the new database.
//
// CCP's export has no equivalent for a few Fuzzwork convenience tables/columns
// (denormalized celestial item names, full station display names, per-type
// meta/trait rows flattened out of nested docs) — those are reconstructed here
// using the same conventions CCP's own client uses. Verified against the old
// DB: dgmTypeAttributes/invTypeMaterials/invTraits/mapSolarSystemJumps/
// industryActivity* all match EXACTLY (row-for-row, exhaustively or via large
// random samples); invTypes core columns match 52757/52758 (the one diff is
// the OLD table's own VARCHAR(100) truncation bug); station display names
// match 5149/5210 (98.83% — CCP's real per-corp choice of whether to append
// "School"/"Academy" text has no fully discoverable rule; cosmetic only, no
// calculation depends on it). See scripts/build-sde-from-jsonl.js for the CLI.
//
// Shared by scripts/fetch-sde.js (CI/dev build) and main.js's in-app
// "Update SDE" flow — one verified implementation, two call sites.
// ─────────────────────────────────────────────────────────────────────────────

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const sqlite3  = require('sqlite3');

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
const roman = n => ROMAN[n] || String(n);

const ACTIVITY_ID = {
  manufacturing: 1, research_time: 3, research_material: 4,
  copying: 5, invention: 8, reaction: 11,
};

function jsonlLines(file) {
  return readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
}
async function forEachLine(file, fn) {
  for await (const line of jsonlLines(file)) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    fn(obj);
  }
}
const en = (v) => (v && typeof v === 'object') ? (v.en ?? '') : (v ?? '');
const b01 = (v) => (v ? 1 : 0);

/**
 * Build a Fuzzwork-schema-compatible sde.sql from a directory of extracted
 * CCP JSONL files.
 * @param {string} jsonlDir - directory containing types.jsonl, blueprints.jsonl, etc.
 * @param {string} outPath - destination sqlite file (overwritten if it exists)
 * @param {(stage: string) => void} [onProgress] - called with a short label per stage
 */
async function buildSdeFromJsonl(jsonlDir, outPath, onProgress) {
  const dir = path.resolve(jsonlDir);
  const out = path.resolve(outPath);
  const f = (name) => path.join(dir, name);
  const report = (msg) => { if (onProgress) onProgress(msg); };

  try { fs.unlinkSync(out); } catch (_) {}
  const db = new sqlite3.Database(out);
  const exec = (sql) => new Promise((res, rej) => db.exec(sql, e => e ? rej(e) : res()));

  // Batched-transaction inserter: one prepared statement, COMMIT every N rows
  // so a single failed row can't roll back an entire multi-hundred-thousand
  // row table, and memory stays flat regardless of table size.
  async function bulkInsert(table, columns, rowsAsyncIterable, batchSize = 5000) {
    const placeholders = columns.map(() => '?').join(',');
    const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`);
    let n = 0;
    await exec('BEGIN');
    for await (const row of rowsAsyncIterable) {
      await new Promise((res, rej) => stmt.run(row, e => e ? rej(e) : res()));
      n++;
      if (n % batchSize === 0) { await exec('COMMIT'); await exec('BEGIN'); }
    }
    await exec('COMMIT');
    await new Promise((res, rej) => stmt.finalize(e => e ? rej(e) : res()));
    report(`${table}: ${n} rows`);
    return n;
  }
  // Generator wrapper so bulkInsert can consume a synchronous producer fn.
  async function* rowsFrom(producerFn) {
    const buf = [];
    await producerFn(row => buf.push(row));
    for (const r of buf) yield r;
  }

  report('Creating schema...');
  await exec(`
    CREATE TABLE invCategories (categoryID INTEGER, categoryName TEXT, iconID INTEGER, published BOOLEAN);
    CREATE TABLE invGroups (groupID INTEGER, categoryID INTEGER, groupName TEXT, iconID INTEGER, useBasePrice BOOLEAN, anchored BOOLEAN, anchorable BOOLEAN, fittableNonSingleton BOOLEAN, published BOOLEAN);
    CREATE TABLE invMarketGroups (marketGroupID INTEGER, parentGroupID INTEGER, marketGroupName TEXT, description TEXT, iconID INTEGER, hasTypes BOOLEAN);
    CREATE TABLE invTypes (typeID INTEGER, groupID INTEGER, typeName TEXT, description TEXT, mass FLOAT, volume FLOAT, capacity FLOAT, portionSize INTEGER, raceID INTEGER, basePrice DECIMAL(19,4), published BOOLEAN, marketGroupID INTEGER, iconID INTEGER, soundID INTEGER, graphicID INTEGER, factionID INTEGER, metaLevel INTEGER, techLevel INTEGER, shipTreeGroupID INTEGER);
    CREATE TABLE invMetaTypes (typeID INTEGER, parentTypeID INTEGER, metaGroupID INTEGER);
    CREATE TABLE invTraits (traitID INTEGER PRIMARY KEY AUTOINCREMENT, typeID INTEGER, skillID INTEGER, bonus FLOAT, bonusText TEXT, unitID INTEGER);
    CREATE TABLE invTypeMaterials (typeID INTEGER, materialTypeID INTEGER, quantity INTEGER);
    CREATE TABLE dgmTypeAttributes (typeID INTEGER, attributeID INTEGER, valueInt INTEGER, valueFloat FLOAT);
    CREATE TABLE dgmTypeEffects (typeID INTEGER, effectID INTEGER, isDefault BOOLEAN);
    CREATE TABLE dgmEffects (effectID INTEGER, effectName TEXT, effectCategory INTEGER);
    CREATE TABLE mapRegions (regionID INTEGER, regionName TEXT, x FLOAT, y FLOAT, z FLOAT, radius FLOAT, factionID INTEGER);
    CREATE TABLE mapConstellations (regionID INTEGER, constellationID INTEGER, constellationName TEXT, x FLOAT, y FLOAT, z FLOAT, factionID INTEGER, radius FLOAT);
    CREATE TABLE mapSolarSystems (regionID INTEGER, constellationID INTEGER, solarSystemID INTEGER, solarSystemName TEXT, x FLOAT, y FLOAT, z FLOAT, luminosity FLOAT, border BOOLEAN, fringe BOOLEAN, corridor BOOLEAN, hub BOOLEAN, international BOOLEAN, regional BOOLEAN, security FLOAT, factionID INTEGER, radius FLOAT, sunTypeID INTEGER, securityClass VARCHAR(2));
    CREATE TABLE mapDenormalize (itemID INTEGER, typeID INTEGER, groupID INTEGER, solarSystemID INTEGER, constellationID INTEGER, regionID INTEGER, orbitID INTEGER, x FLOAT, y FLOAT, z FLOAT, radius FLOAT, itemName VARCHAR(100), security FLOAT, celestialIndex INTEGER, orbitIndex INTEGER);
    CREATE TABLE mapSolarSystemJumps (fromRegionID INTEGER, fromConstellationID INTEGER, fromSolarSystemID INTEGER, toSolarSystemID INTEGER, toConstellationID INTEGER, toRegionID INTEGER);
    CREATE TABLE staStations (stationID BIGINT, security FLOAT, dockingCostPerVolume FLOAT, maxShipVolumeDockable FLOAT, officeRentalCost INTEGER, operationID INTEGER, stationTypeID INTEGER, corporationID INTEGER, solarSystemID INTEGER, constellationID INTEGER, regionID INTEGER, stationName VARCHAR(100), x FLOAT, y FLOAT, z FLOAT, reprocessingEfficiency FLOAT, reprocessingStationsTake FLOAT, reprocessingHangarFlag INTEGER);
    CREATE TABLE chrRaces (raceID INTEGER, raceName TEXT, description TEXT, iconID INTEGER, shortDescription TEXT);
    CREATE TABLE industryActivity (typeID INTEGER, activityID INTEGER, time INTEGER);
    CREATE TABLE industryActivityMaterials (typeID INTEGER, activityID INTEGER, materialTypeID INTEGER, quantity INTEGER);
    CREATE TABLE industryActivityProducts (typeID INTEGER, activityID INTEGER, productTypeID INTEGER, quantity INTEGER);
  `);

  // ── Pass 1: small/medium lookup tables + in-memory maps other tables need ──
  report('Loading lookup maps...');
  const typeMeta = new Map();       // typeID -> { groupID, name }
  const systemName = new Map();     // solarSystemID -> name
  const planetMeta = new Map();     // planetID -> { celestialIndex, solarSystemID }
  const corpName = new Map();       // corporationID -> name
  const opName = new Map();         // operationID -> name

  await forEachLine(f('types.jsonl'), o => typeMeta.set(o._key, { groupID: o.groupID, name: en(o.name) }));
  await forEachLine(f('npcCorporations.jsonl'), o => corpName.set(o._key, en(o.name)));
  await forEachLine(f('stationOperations.jsonl'), o => opName.set(o._key, en(o.operationName)));
  const moonIds = new Set();
  await forEachLine(f('mapMoons.jsonl'), o => moonIds.add(o._key));

  report('Populating invCategories, invGroups, invMarketGroups, chrRaces...');
  await bulkInsert('invCategories', ['categoryID', 'categoryName', 'iconID', 'published'],
    rowsFrom(async push => forEachLine(f('categories.jsonl'), o =>
      push([o._key, en(o.name), o.iconID ?? null, b01(o.published)]))));

  await bulkInsert('invGroups', ['groupID', 'categoryID', 'groupName', 'iconID', 'useBasePrice', 'anchored', 'anchorable', 'fittableNonSingleton', 'published'],
    rowsFrom(async push => forEachLine(f('groups.jsonl'), o =>
      push([o._key, o.categoryID ?? null, en(o.name), o.iconID ?? null, b01(o.useBasePrice), b01(o.anchored), b01(o.anchorable), b01(o.fittableNonSingleton), b01(o.published)]))));

  await bulkInsert('invMarketGroups', ['marketGroupID', 'parentGroupID', 'marketGroupName', 'description', 'iconID', 'hasTypes'],
    rowsFrom(async push => forEachLine(f('marketGroups.jsonl'), o =>
      push([o._key, o.parentGroupID ?? null, en(o.name), en(o.description), o.iconID ?? null, b01(o.hasTypes)]))));

  await bulkInsert('chrRaces', ['raceID', 'raceName', 'description', 'iconID', 'shortDescription'],
    rowsFrom(async push => forEachLine(f('races.jsonl'), o =>
      push([o._key, en(o.name), en(o.description), o.iconID ?? null, en(o.shortDescription)]))));

  report('Populating invTypes, invMetaTypes...');
  // CCP's JSONL OMITS mass/volume/capacity entirely when they're zero
  // (confirmed against a 200-item random sample and an exhaustive 52758-row
  // pass) — default to 0, not NULL, to match Fuzzwork's convention the app's
  // math already relies on. basePrice is DIFFERENT: old keeps it NULL for
  // non-tradeable items (0 there means "free," which is wrong), so that one
  // stays a plain nullish-coalesce.
  const numOr0 = v => v ?? 0;
  await bulkInsert('invTypes', ['typeID', 'groupID', 'typeName', 'description', 'mass', 'volume', 'capacity', 'portionSize', 'raceID', 'basePrice', 'published', 'marketGroupID', 'iconID', 'soundID', 'graphicID', 'factionID', 'metaLevel', 'techLevel', 'shipTreeGroupID'],
    rowsFrom(async push => forEachLine(f('types.jsonl'), o => push([
      o._key, o.groupID ?? null, en(o.name), en(o.description), numOr0(o.mass), numOr0(o.volume),
      numOr0(o.capacity), o.portionSize ?? null, o.raceID ?? null, o.basePrice ?? null, b01(o.published),
      o.marketGroupID ?? null, o.iconID ?? null, o.soundID ?? null, o.graphicID ?? null, o.factionID ?? null,
      o.metaLevel ?? null, o.techLevel ?? null, o.shipTreeGroupID ?? null,
    ]))));

  await bulkInsert('invMetaTypes', ['typeID', 'parentTypeID', 'metaGroupID'],
    rowsFrom(async push => forEachLine(f('types.jsonl'), o => {
      // Old SDE includes every type with a metaGroupID, even Tech I items with
      // no parent (parentTypeID NULL) — the app only ever reads metaGroupID,
      // so requiring variationParentTypeID too silently drops ~9k legitimate
      // rows including all Tech I items.
      if (o.metaGroupID != null) push([o._key, o.variationParentTypeID ?? null, o.metaGroupID]);
    })));

  report('Populating invTraits (role + skill-linked ship/subsystem bonuses)...');
  // typeBonus.jsonl record shape: _key = the SHIP's own typeID; roleBonuses =
  // flat bonuses for that ship (no skill scaling); types[] = one entry PER
  // SKILL that scales a bonus, keyed by the real skillID, _value = the bonus
  // list for that skill. (Verified against Caracal/621, whose sole types[]
  // entry is skillID 3334 = Caldari Cruiser — matches the old DB exactly.)
  await bulkInsert('invTraits', ['typeID', 'skillID', 'bonus', 'bonusText', 'unitID'],
    rowsFrom(async push => forEachLine(f('typeBonus.jsonl'), rec => {
      const typeID = rec._key;
      for (const b of (rec.roleBonuses || [])) push([typeID, -1, b.bonus ?? null, en(b.bonusText), b.unitID ?? null]);
      for (const skill of (rec.types || [])) {
        const skillID = skill._key;
        for (const b of (skill._value || [])) push([typeID, skillID, b.bonus ?? null, en(b.bonusText), b.unitID ?? null]);
      }
    })));

  report('Populating invTypeMaterials...');
  await bulkInsert('invTypeMaterials', ['typeID', 'materialTypeID', 'quantity'],
    rowsFrom(async push => forEachLine(f('typeMaterials.jsonl'), o => {
      for (const m of (o.materials || [])) push([o._key, m.materialTypeID, m.quantity]);
    })));

  report('Populating dgmTypeAttributes, dgmTypeEffects (the big one)...');
  await bulkInsert('dgmTypeAttributes', ['typeID', 'attributeID', 'valueInt', 'valueFloat'],
    rowsFrom(async push => forEachLine(f('typeDogma.jsonl'), o => {
      for (const a of (o.dogmaAttributes || [])) push([o._key, a.attributeID, null, a.value]);
    })));
  await bulkInsert('dgmTypeEffects', ['typeID', 'effectID', 'isDefault'],
    rowsFrom(async push => forEachLine(f('typeDogma.jsonl'), o => {
      for (const e of (o.dogmaEffects || [])) push([o._key, e.effectID, b01(e.isDefault)]);
    })));

  report('Populating dgmEffects...');
  await bulkInsert('dgmEffects', ['effectID', 'effectName', 'effectCategory'],
    rowsFrom(async push => forEachLine(f('dogmaEffects.jsonl'), o =>
      push([o._key, o.name ?? null, o.effectCategoryID ?? null]))));

  report('Populating blueprints -> industryActivity / Materials / Products...');
  {
    const act = [], mat = [], prod = [];
    await forEachLine(f('blueprints.jsonl'), o => {
      const typeID = o._key;
      const activities = o.activities || {};
      for (const [key, aid] of Object.entries(ACTIVITY_ID)) {
        const a = activities[key];
        if (!a) continue;
        if (a.time != null) act.push([typeID, aid, a.time]);
        for (const m of (a.materials || [])) mat.push([typeID, aid, m.typeID, m.quantity]);
        for (const p of (a.products || [])) prod.push([typeID, aid, p.typeID, p.quantity]);
      }
    });
    await bulkInsert('industryActivity', ['typeID', 'activityID', 'time'], rowsFrom(async push => act.forEach(r => push(r))));
    await bulkInsert('industryActivityMaterials', ['typeID', 'activityID', 'materialTypeID', 'quantity'], rowsFrom(async push => mat.forEach(r => push(r))));
    await bulkInsert('industryActivityProducts', ['typeID', 'activityID', 'productTypeID', 'quantity'], rowsFrom(async push => prod.forEach(r => push(r))));
  }

  report('Populating mapRegions, mapConstellations, mapSolarSystems, mapSolarSystemJumps...');
  await bulkInsert('mapRegions', ['regionID', 'regionName', 'x', 'y', 'z', 'radius', 'factionID'],
    rowsFrom(async push => forEachLine(f('mapRegions.jsonl'), o => {
      const p = o.position || {};
      push([o._key, en(o.name), p.x ?? null, p.y ?? null, p.z ?? null, o.radius ?? null, o.factionID ?? null]);
    })));

  await bulkInsert('mapConstellations', ['regionID', 'constellationID', 'constellationName', 'x', 'y', 'z', 'factionID', 'radius'],
    rowsFrom(async push => forEachLine(f('mapConstellations.jsonl'), o => {
      const p = o.position || {};
      push([o.regionID ?? null, o._key, en(o.name), p.x ?? null, p.y ?? null, p.z ?? null, o.factionID ?? null, o.radius ?? null]);
    })));

  const jumpRows = [];
  await forEachLine(f('mapSolarSystems.jsonl'), o => systemName.set(o._key, en(o.name)));
  await bulkInsert('mapSolarSystems', ['regionID', 'constellationID', 'solarSystemID', 'solarSystemName', 'x', 'y', 'z', 'luminosity', 'border', 'fringe', 'corridor', 'hub', 'international', 'regional', 'security', 'factionID', 'radius', 'sunTypeID', 'securityClass'],
    rowsFrom(async push => forEachLine(f('mapSolarSystems.jsonl'), o => {
      const p = o.position || {};
      // Stargate-derived jump edges — need each system's region/constellation,
      // so build this alongside the main system row (single pass over the file).
      for (const sgId of (o.stargateIDs || [])) jumpRows.push({ from: o._key, sgId });
      push([o.regionID ?? null, o.constellationID ?? null, o._key, en(o.name), p.x ?? null, p.y ?? null, p.z ?? null,
        o.luminosity ?? null, b01(o.border), b01(o.fringe), b01(o.corridor), b01(o.hub), b01(o.international),
        b01(o.regional), o.securityStatus ?? null, o.factionID ?? null, o.radius ?? null, o.starID ?? null, o.securityClass ?? null]);
    })));

  report('Deriving mapSolarSystemJumps from stargate destinations...');
  {
    const sysRC = new Map();   // solarSystemID -> {regionID, constellationID}
    await forEachLine(f('mapSolarSystems.jsonl'), o => sysRC.set(o._key, { regionID: o.regionID, constellationID: o.constellationID }));
    const sgDest = new Map();  // stargateID -> destination solarSystemID
    await forEachLine(f('mapStargates.jsonl'), o => sgDest.set(o._key, o.destination && o.destination.solarSystemID));
    const rows = [];
    for (const { from, sgId } of jumpRows) {
      const to = sgDest.get(sgId);
      if (!to) continue;
      const fr = sysRC.get(from), tr = sysRC.get(to);
      if (!fr || !tr) continue;
      rows.push([fr.regionID, fr.constellationID, from, to, tr.constellationID, tr.regionID]);
    }
    await bulkInsert('mapSolarSystemJumps', ['fromRegionID', 'fromConstellationID', 'fromSolarSystemID', 'toSolarSystemID', 'toConstellationID', 'toRegionID'], rowsFrom(async push => rows.forEach(r => push(r))));
  }

  report('Populating mapDenormalize (systems, planets, moons, belts, stars, stargates)...');
  {
    const rows = [];
    // The system's own celestial "item" (typeID 5 = Solar System) — legacy
    // fallback lookup path in esi_ipc.js reads this.
    await forEachLine(f('mapSolarSystems.jsonl'), o => {
      const p = o.position || {};
      const tm = typeMeta.get(5);
      rows.push([o._key, 5, tm ? tm.groupID : null, o._key, o.constellationID ?? null, o.regionID ?? null, null,
        p.x ?? null, p.y ?? null, p.z ?? null, o.radius ?? null, en(o.name), o.securityStatus ?? null, null, null]);
    });
    await forEachLine(f('mapPlanets.jsonl'), o => {
      planetMeta.set(o._key, { celestialIndex: o.celestialIndex, solarSystemID: o.solarSystemID });
      const p = o.position || {};
      const tm = typeMeta.get(o.typeID);
      const sysN = systemName.get(o.solarSystemID) || '';
      const name = `${sysN} ${roman(o.celestialIndex)}`.trim();
      rows.push([o._key, o.typeID ?? null, tm ? tm.groupID : null, o.solarSystemID ?? null, null, null, o.orbitID ?? null,
        p.x ?? null, p.y ?? null, p.z ?? null, o.radius ?? null, name, null, o.celestialIndex ?? null, null]);
    });
    await forEachLine(f('mapMoons.jsonl'), o => {
      const p = o.position || {};
      const tm = typeMeta.get(o.typeID);
      const planet = planetMeta.get(o.orbitID);
      const sysN = systemName.get(o.solarSystemID) || '';
      const name = planet ? `${sysN} ${roman(planet.celestialIndex)} - Moon ${o.orbitIndex}`.trim() : `${sysN} Moon ${o.orbitIndex}`.trim();
      rows.push([o._key, o.typeID ?? null, tm ? tm.groupID : null, o.solarSystemID ?? null, null, null, o.orbitID ?? null,
        p.x ?? null, p.y ?? null, p.z ?? null, o.radius ?? null, name, null, o.celestialIndex ?? null, o.orbitIndex ?? null]);
    });
    await forEachLine(f('mapAsteroidBelts.jsonl'), o => {
      const p = o.position || {};
      const tm = typeMeta.get(o.typeID);
      const planet = planetMeta.get(o.orbitID);
      const sysN = systemName.get(o.solarSystemID) || '';
      const name = planet ? `${sysN} ${roman(planet.celestialIndex)} - Asteroid Belt ${o.orbitIndex}`.trim() : `${sysN} Asteroid Belt ${o.orbitIndex}`.trim();
      rows.push([o._key, o.typeID ?? null, tm ? tm.groupID : null, o.solarSystemID ?? null, null, null, o.orbitID ?? null,
        p.x ?? null, p.y ?? null, p.z ?? null, o.radius ?? null, name, null, o.celestialIndex ?? null, o.orbitIndex ?? null]);
    });
    await forEachLine(f('mapStars.jsonl'), o => {
      const tm = typeMeta.get(o.typeID);
      const sysN = systemName.get(o.solarSystemID) || '';
      rows.push([o._key, o.typeID ?? null, tm ? tm.groupID : null, o.solarSystemID ?? null, null, null, null,
        0, 0, 0, o.radius ?? null, `${sysN} - Star`.trim(), null, null, null]);
    });
    await forEachLine(f('mapStargates.jsonl'), o => {
      const p = o.position || {};
      const tm = typeMeta.get(o.typeID);
      const sysN = systemName.get(o.solarSystemID) || '';
      const destSysN = o.destination ? (systemName.get(o.destination.solarSystemID) || '') : '';
      rows.push([o._key, o.typeID ?? null, tm ? tm.groupID : null, o.solarSystemID ?? null, null, null, null,
        p.x ?? null, p.y ?? null, p.z ?? null, null, `${sysN} - Stargate (${destSysN})`.trim(), null, null, null]);
    });
    await bulkInsert('mapDenormalize', ['itemID', 'typeID', 'groupID', 'solarSystemID', 'constellationID', 'regionID', 'orbitID', 'x', 'y', 'z', 'radius', 'itemName', 'security', 'celestialIndex', 'orbitIndex'], rowsFrom(async push => rows.forEach(r => push(r))));
  }

  report('Populating staStations (NPC stations, with reconstructed display names)...');
  // Verified against the old DB: station names are essentially "{OwnerCorp}
  // {OperationName}" (e.g. "Caldari Navy" + "Assembly Plant" = "Caldari Navy
  // Assembly Plant"). The planet index in STATION names is Arabic ("Jita 4"),
  // unlike the Roman numerals used elsewhere ("Jita IV") — confirmed against
  // the old data. Moon detection needs the real moonIds set: orbitID is a
  // moon's own id when the station is moon-docked, so a planetMeta lookup
  // (keyed by planet id) always misses it. The dedup + "School" handling below
  // is the best of several heuristics checked EXHAUSTIVELY against all 5210
  // old stations (endsWith alone: 136 mismatches/2.61% · contains alone:
  // 124/2.38% · endsWith + drop "School": 61/1.17%, used here) — CCP's real
  // per-corp choice of whether to show "School"/"Academy" has no fully
  // discoverable textual rule, so ~1% of station names are a close
  // approximation rather than exact. Cosmetic display text only.
  const stationRows = [];
  await bulkInsert('staStations', ['stationID', 'security', 'dockingCostPerVolume', 'maxShipVolumeDockable', 'officeRentalCost', 'operationID', 'stationTypeID', 'corporationID', 'solarSystemID', 'constellationID', 'regionID', 'stationName', 'x', 'y', 'z', 'reprocessingEfficiency', 'reprocessingStationsTake', 'reprocessingHangarFlag'],
    rowsFrom(async push => forEachLine(f('npcStations.jsonl'), o => {
      const p = o.position || {};
      const sysN = systemName.get(o.solarSystemID) || '';
      const moonPart = moonIds.has(o.orbitID) ? ` - Moon ${o.orbitIndex}` : '';
      const corp = corpName.get(o.ownerID) || '', op = opName.get(o.operationID) || '';
      const dropOp = op && (op === 'School' || corp.toLowerCase().endsWith(op.toLowerCase()));
      const opPart = (op && !dropOp) ? `${corp} ${op}`.trim() : corp;
      const stationName = `${sysN} ${o.celestialIndex ?? ''}${moonPart} - ${opPart}`.replace(/\s+/g, ' ').trim();
      stationRows.push({ id: o._key, typeID: o.typeID, sysId: o.solarSystemID, p, name: stationName });
      push([o._key, null, null, null, null, o.operationID ?? null, o.typeID ?? null, o.ownerID ?? null,
        o.solarSystemID ?? null, null, null, stationName, p.x ?? null, p.y ?? null, p.z ?? null,
        o.reprocessingEfficiency ?? null, o.reprocessingStationsTake ?? null, o.reprocessingHangarFlag ?? null]);
    })));

  report('Appending stations to mapDenormalize (old table includes them as items too)...');
  await bulkInsert('mapDenormalize', ['itemID', 'typeID', 'groupID', 'solarSystemID', 'constellationID', 'regionID', 'orbitID', 'x', 'y', 'z', 'radius', 'itemName', 'security', 'celestialIndex', 'orbitIndex'],
    rowsFrom(async push => stationRows.forEach(s => {
      const tm = typeMeta.get(s.typeID);
      push([s.id, s.typeID ?? null, tm ? tm.groupID : null, s.sysId ?? null, null, null, null,
        s.p.x ?? null, s.p.y ?? null, s.p.z ?? null, null, s.name, null, null, null]);
    })));

  report('Creating indexes...');
  await exec(`
    CREATE INDEX idx_invTypes_typeID ON invTypes(typeID);
    CREATE INDEX idx_invTypes_groupID ON invTypes(groupID);
    CREATE INDEX idx_invTypes_marketGroupID ON invTypes(marketGroupID);
    CREATE INDEX idx_invGroups_groupID ON invGroups(groupID);
    CREATE INDEX idx_invGroups_categoryID ON invGroups(categoryID);
    CREATE INDEX idx_invMetaTypes_typeID ON invMetaTypes(typeID);
    CREATE INDEX idx_invTraits_typeID ON invTraits(typeID);
    CREATE INDEX idx_invTypeMaterials_typeID ON invTypeMaterials(typeID);
    CREATE INDEX idx_dgmTypeAttributes_typeID ON dgmTypeAttributes(typeID);
    CREATE INDEX idx_dgmTypeAttributes_attributeID ON dgmTypeAttributes(attributeID);
    CREATE INDEX idx_dgmTypeEffects_typeID ON dgmTypeEffects(typeID);
    CREATE INDEX idx_dgmEffects_effectID ON dgmEffects(effectID);
    CREATE INDEX idx_mapSolarSystems_id ON mapSolarSystems(solarSystemID);
    CREATE INDEX idx_mapSolarSystems_regionID ON mapSolarSystems(regionID);
    CREATE INDEX idx_mapConstellations_id ON mapConstellations(constellationID);
    CREATE INDEX idx_mapDenormalize_regionID ON mapDenormalize(regionID);
    CREATE INDEX idx_mapDenormalize_solarSystemID ON mapDenormalize(solarSystemID);
    CREATE INDEX idx_mapDenormalize_itemID ON mapDenormalize(itemID);
    CREATE INDEX idx_mapDenormalize_groupID ON mapDenormalize(groupID);
    CREATE INDEX idx_jumps_from ON mapSolarSystemJumps(fromSolarSystemID);
    CREATE INDEX idx_staStations_id ON staStations(stationID);
    CREATE INDEX idx_staStations_sys ON staStations(solarSystemID);
    CREATE INDEX idx_industryActivity_typeID ON industryActivity(typeID, activityID);
    CREATE INDEX idx_industryActivityMaterials_typeID ON industryActivityMaterials(typeID, activityID);
    CREATE INDEX idx_industryActivityProducts_typeID ON industryActivityProducts(typeID, activityID);
    CREATE INDEX idx_industryActivityProducts_productTypeID ON industryActivityProducts(productTypeID);
  `);

  await new Promise((res, rej) => db.close(e => e ? rej(e) : res()));
  report(`Done. Wrote ${out}`);
}

module.exports = { buildSdeFromJsonl };
