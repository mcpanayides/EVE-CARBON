#!/usr/bin/env node
// Phase 2 at real-user scale: 90 characters, ~100k assets.
//
// Measures what the Assets page will actually do — build the index once, then
// answer the queries a person makes while browsing. The numbers that matter are
// the query ones: those run on every keystroke and every expand.
//
//   npm run stress:index
//
// Expects the fixture from `npm run stress:data --keep`.

const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const charInfoDb = require('../src/character_info_db');
const valuation  = require('../src/asset_valuation');
const assetIndex = require('../src/asset_index');

const DIR = process.argv[2]
  || path.join(process.env.TEMP || '/tmp', 'eve-carbon-stress', '90c-100000a');

const ms = (t) => `${String(Date.now() - t).padStart(6)} ms`;

(async () => {
  await charInfoDb.initCharacterDb(DIR);
  const db = charInfoDb.getDb();
  await valuation.ensureValuationTables(db);

  const ids = (await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'char\\_%\\_assets' ESCAPE '\\'"
  )).map(r => Number(r.name.match(/char_(\d+)_assets/)[1]));
  console.log(`fixture: ${ids.length} characters at ${DIR}\n`);

  // ── Prices ─────────────────────────────────────────────────────────────────
  // Stand in for the tiered resolution so the rebuild has something to value
  // against; the real precedence is covered by test/asset_valuation.test.js.
  let t = Date.now();
  const types = new Set();
  for (const id of ids) {
    for (const r of await db.all(`SELECT DISTINCT type_id FROM char_${id}_assets WHERE type_id IS NOT NULL`)) {
      types.add(r.type_id);
    }
  }
  const ccp = new Map(), meta = new Map();
  for (const ty of types) {
    ccp.set(ty, (ty % 97) * 1_250_000 + 1000);
    if (ty % 997 === 0) meta.set(ty, { group: 'Titan' });
  }
  await valuation.writeTypePrices(db, valuation.resolveUnitValues({ ccp, market: new Map(), meta }));
  console.log(`prices for ${types.size} types            ${ms(t)}`);

  // ── Build ──────────────────────────────────────────────────────────────────
  t = Date.now();
  const built = await valuation.rebuildAssetValues(db);
  console.log(`rebuild values + roll-up            ${ms(t)}   (${built.items.toLocaleString()} items)`);

  t = Date.now();
  const rows = [];
  for (const id of ids) {
    for (const r of await charInfoDb.getCharacterAssets(id)) {
      r.characterId = id; r.characterName = `Char ${id}`;
      rows.push(r);
    }
  }
  console.log(`resolve locations (90 characters)   ${ms(t)}   (${rows.length.toLocaleString()} rows)`);

  // Real SDE groups and categories, so the search column is the size it will be
  // in production. Searching by ship class widens every row's blob, and the blob
  // lives inside the covering index — measuring against empty metadata would
  // flatter the search timings below.
  t = Date.now();
  const typeInfo = new Map();
  try {
    const sde = await open({ filename: path.join(__dirname, '..', 'data', 'sde.sql'),
                             driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    const ids = [...new Set(rows.map(r => Number(r.type_id)).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const got = await sde.all(
        `SELECT t.typeID id, g.groupName grp, c.categoryName cat
           FROM invTypes t
           LEFT JOIN invGroups     g ON g.groupID    = t.groupID
           LEFT JOIN invCategories c ON c.categoryID = g.categoryID
          WHERE t.typeID IN (${chunk.map(() => '?').join(',')})`, ...chunk);
      for (const r of got) typeInfo.set(r.id, { group: r.grp, category: r.cat });
    }
    await sde.close();
  } catch (e) {
    console.log(`  (no SDE — class search unmeasured: ${e.message})`);
  }
  console.log(`SDE groups for ${typeInfo.size} types        ${ms(t)}`);

  t = Date.now();
  const idx = await assetIndex.rebuildAssetIndex(db, rows, typeInfo);
  console.log(`build index                         ${ms(t)}   (${idx.rows.toLocaleString()} rows, ${idx.groups} groups)`);

  // ── The queries the page actually makes ────────────────────────────────────
  console.log('\n─ per-view queries ─────────────────────────────────');
  const groups = await assetIndex.getLocationGroups(db, {}, {});
  const biggest = [...groups].sort((a, b) => b.item_count - a.item_count)[0];
  const chars = await assetIndex.getGroupCharacters(db, biggest.loc_key, {});
  const fattest = [...chars].sort((a, b) => b.item_count - a.item_count)[0];

  const cases = [
    ['filter options (3 dropdowns)', () => assetIndex.getFilterOptions(db)],
    ['summary line',                 () => assetIndex.getSummary(db, {})],
    ['location groups, default',     () => assetIndex.getLocationGroups(db, {}, {})],
    ['location groups, by value',    () => assetIndex.getLocationGroups(db, {}, { col: 'price', dir: -1 })],
    ['location groups, search',      () => assetIndex.getLocationGroups(db, { search: 'tritanium' }, {})],
    ['search by ship class',         () => assetIndex.getLocationGroups(db, { search: 'cruiser' }, {})],
    ['search by class, one char',    () => assetIndex.getLocationGroups(db, { search: 'cruisers', characterId: ids[0] }, {})],
    ['location groups, one char',    () => assetIndex.getLocationGroups(db, { characterId: ids[0] }, {})],
    ['characters in biggest group',  () => assetIndex.getGroupCharacters(db, biggest.loc_key, {})],
    ['items: biggest hangar',        () => assetIndex.getGroupItems(db, biggest.loc_key, fattest.character_id, {}, { col: 'price', dir: -1 })],
    ['top 50 across everything',     () => assetIndex.getTopItems(db, { limit: 50 })],
  ];
  for (const [label, fn] of cases) {
    const s = Date.now();
    const r = await fn();
    const n = Array.isArray(r) ? r.length : (r.rows?.length ?? '');
    console.log(`${label.padEnd(30)} ${ms(s)}   ${n === '' ? '' : `(${n} rows)`}`);
  }

  console.log('\n─ shape ────────────────────────────────────────────');
  console.log(`location groups: ${groups.length}`);
  console.log(`biggest group:   ${biggest.loc_label} — ${biggest.item_count.toLocaleString()} items, ${chars.length} characters`);
  console.log(`fattest hangar:  ${fattest.item_count.toLocaleString()} items (cap is ${assetIndex.GROUP_ITEM_CAP.toLocaleString()})`);
  const top = await assetIndex.getTopItems(db, { limit: 3 });
  console.log(`top three:       ${top.map(r => `${r.type_name} ${(r.total_value / 1e9).toFixed(1)}B`).join(' · ')}`);

  await charInfoDb.closeCharacterDb();
})().catch(e => { console.error(e.stack); process.exit(1); });
