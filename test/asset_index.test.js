'use strict';
//
// The asset index — the table the Assets page is queried from (Phase 2, TODO.md).
//
// Two kinds of test here, and the split is deliberate:
//
//   • The grouping rules are pure functions, tested directly. Getting a location
//     key wrong silently reshapes the whole page — items scatter across groups
//     that should be one station, or two different citadels merge — and nothing
//     throws. There is no error to notice, only a page that looks wrong to
//     somebody who knows their own hangar.
//
//   • Everything else runs against a real SQLite database. The queries ARE the
//     feature; a mocked db.all would assert that the mock returns what it was
//     told to.
const test    = require('node:test');
const assert  = require('node:assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const idx = require('../src/asset_index');
const val = require('../src/asset_valuation');

// ─── Grouping identity ────────────────────────────────────────────────────────

test('a named station groups by name and system', () => {
  const a = idx.locationIdentity({ location_name: 'Jita IV - Moon 4', solar_system_id: 30000142 });
  assert.strictEqual(a.key, 'Jita IV - Moon 4||30000142');
  assert.strictEqual(a.label, 'Jita IV - Moon 4');
  assert.strictEqual(a.unresolved, false);
});

test('two structures with the same name in different systems stay apart', () => {
  const a = idx.locationIdentity({ location_name: 'Home', solar_system_id: 1 });
  const b = idx.locationIdentity({ location_name: 'Home', solar_system_id: 2 });
  assert.notStrictEqual(a.key, b.key);
});

test('items nested in a container group with their station, not their container', () => {
  // This is the reason the key is the resolved NAME and not location_id. A
  // module inside a ship carries the ship's item_id as its location_id, so
  // keying on the id would split one station into one group per ship.
  const hangar = idx.locationIdentity({
    location_name: 'Jita IV - Moon 4', solar_system_id: 30000142, location_id: 60003760,
  });
  const inShip = idx.locationIdentity({
    location_name: 'Jita IV - Moon 4', solar_system_id: 30000142, location_id: 1039999888,
  });
  assert.strictEqual(hangar.key, inShip.key);
});

test('an unreadable structure keys on its id so two of them never merge', () => {
  const a = idx.locationIdentity({ location_name: null, location_id: 1001 });
  const b = idx.locationIdentity({ location_name: null, location_id: 1002 });
  assert.notStrictEqual(a.key, b.key);
  assert.strictEqual(a.unresolved, true);
});

test('an ESI error string is treated as no name at all', () => {
  // These have been cached as if they were names. A group called "No structure
  // found with that ID!" is worse than an honest "Unknown Structure".
  for (const name of ['Structure 1037123', 'No structure found with that ID!',
                      'Location 60003760', '', null]) {
    assert.strictEqual(idx.isUnresolvedLocName(name), true, `${name} should be unresolved`);
  }
  assert.strictEqual(idx.isUnresolvedLocName('Perimeter - Tranquility Trading Tower'), false);
});

test('an unnamed structure falls back to its solar system rather than a raw id', () => {
  const r = idx.locationIdentity({ location_name: null, location_id: 99, solar_system_name: 'Ahbazon' });
  assert.strictEqual(r.label, 'Unknown Structure — Ahbazon');
});

test('the search blob covers every field the old JS filter searched', () => {
  const blob = idx.searchBlob({
    type_name: 'Damage Control II', custom_name: 'Snowbird',
    location_name: 'Jita IV - Moon 4', owner_name: 'Caldari Navy',
    region_name: 'The Forge', solar_system_name: 'Jita',
  });
  for (const term of ['damage control', 'snowbird', 'jita iv', 'caldari navy', 'the forge']) {
    assert.ok(blob.includes(term), `blob should contain ${term}`);
  }
});

test('the blob carries the ship class and its plural, not just the item name', () => {
  const blob = idx.searchBlob({ type_name: 'Nyx' }, { group: 'Supercarrier', category: 'Ship' });
  // Group names are singular and people type plurals. Without the plural,
  // "supercarriers" finds nothing while "supercarrier" finds everything, which
  // reads as a broken search rather than as a grammar rule.
  for (const term of ['supercarrier', 'supercarriers', 'ship', 'ships']) {
    assert.ok(blob.includes(term), `blob should contain ${term}`);
  }
});

test('community names for a class are searchable, game names or not', () => {
  // Supercarriers have been called that for years; half of New Eden never
  // stopped saying mothership.
  assert.deepStrictEqual(idx.groupAliases('Supercarrier'), ['mothership', 'mom']);
  // Blueprint groups answer to the same names as their hulls.
  assert.deepStrictEqual(idx.groupAliases('Supercarrier Blueprints'), ['mothership', 'mom']);
  assert.deepStrictEqual(idx.groupAliases('Force Auxiliary'), ['fax']);
  assert.deepStrictEqual(idx.groupAliases('Frigate'), []);
});

test('aliases only exist for names the group does not already contain', () => {
  // "dread" already finds Dreadnought and "ceptor" already finds Interceptor,
  // because the match is a substring. An alias for either is dead weight in the
  // search column of every row — and this table sits inside a covering index,
  // so dead weight there is paid for on every keystroke.
  //
  // Reported all at once rather than failing on the first: the version of this
  // test that stopped at "dictor" hid that "recon" was redundant too.
  const expand = (source) => {
    const bare = source.replace(/[\^$]/g, '');
    const alt = bare.match(/\(([^)]*)\)/);
    return alt
      ? alt[1].split('|').map(a => bare.replace(alt[0], a))
      : [bare];
  };

  const redundant = [];
  for (const { match, terms } of idx.GROUP_ALIASES) {
    for (const sample of expand(match.source)) {
      for (const term of terms) {
        if (sample.toLowerCase().includes(term.toLowerCase())) {
          redundant.push(`"${term}" is already inside "${sample}"`);
        }
      }
    }
  }
  assert.deepStrictEqual(redundant, []);
});

// ─── Filters ──────────────────────────────────────────────────────────────────

test('an empty filter set produces no WHERE clause', () => {
  assert.strictEqual(idx.buildWhere({}).sql, '');
  assert.strictEqual(idx.buildWhere({}).params.length, 0);
});

test('the unresolved-region bucket matches NULL and empty, and binds nothing', () => {
  // Without this bucket, assets whose region never resolved belong to no region
  // and no filter can reach them — they are simply invisible.
  const w = idx.buildWhere({ region: '__unresolved__' });
  assert.match(w.sql, /region_name IS NULL/);
  assert.strictEqual(w.params.length, 0);
});

test('search is lower-cased and wrapped, because the blob is stored lower-cased', () => {
  const w = idx.buildWhere({ search: '  NyX  ' });
  assert.deepStrictEqual(w.params, ['%nyx%']);
});

test('numeric columns sort descending by default, text ascending', () => {
  assert.ok(idx.isNumericSort('price'));
  assert.ok(idx.isNumericSort('qty'));
  assert.ok(!idx.isNumericSort('name'));
  assert.match(idx.itemOrderBy({ col: 'price', dir: -1 }), /total_value\s+DESC/);
  // Sorting by value uses TOTAL value, so a container ranks by what it holds.
  assert.ok(!idx.itemOrderBy({ col: 'price', dir: -1 }).includes('own_value'));
});

test('an unknown sort column falls back to name rather than injecting it', () => {
  const sql = idx.itemOrderBy({ col: 'DROP TABLE asset_index', dir: 1 });
  assert.strictEqual(sql, 'ORDER BY type_name COLLATE NOCASE ASC');
});

// ─── Against a real database ──────────────────────────────────────────────────

let dir;
async function freshDb() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-index-'));
  const db = await open({ filename: path.join(dir, 'test.db'), driver: sqlite3.Database });
  await val.ensureValuationTables(db);
  await idx.ensureAssetIndex(db);
  return db;
}
function cleanup(db) {
  return db.close().then(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
}

// One Titan in a hangar, a ship with two modules fitted, and loose ore. Enough
// shape to exercise nesting, stacking and the value roll-up.
const ROWS = [
  { characterId: 1, characterName: 'Alpha', item_id: 10, type_id: 671, type_name: 'Erebus',
    quantity: 1, is_singleton: 1, location_id: 60003760,
    location_name: 'Jita IV - Moon 4', solar_system_id: 30000142, solar_system_name: 'Jita',
    region_name: 'The Forge', security_status: 0.9, owner_name: 'Caldari Navy' },
  { characterId: 1, characterName: 'Alpha', item_id: 11, type_id: 24688, type_name: 'Rokh',
    custom_name: 'Snowbird', quantity: 1, is_singleton: 1, location_id: 60003760,
    location_name: 'Jita IV - Moon 4', solar_system_id: 30000142, solar_system_name: 'Jita',
    region_name: 'The Forge', security_status: 0.9, owner_name: 'Caldari Navy' },
  // Fitted to the Rokh — parent is item 11, not the station.
  { characterId: 1, characterName: 'Alpha', item_id: 12, type_id: 2048, type_name: 'Damage Control II',
    quantity: 1, is_singleton: 1, location_id: 11,
    location_name: 'Jita IV - Moon 4', solar_system_id: 30000142, solar_system_name: 'Jita',
    region_name: 'The Forge', security_status: 0.9 },
  { characterId: 1, characterName: 'Alpha', item_id: 13, type_id: 2048, type_name: 'Damage Control II',
    quantity: 1, is_singleton: 1, location_id: 11,
    location_name: 'Jita IV - Moon 4', solar_system_id: 30000142, solar_system_name: 'Jita',
    region_name: 'The Forge', security_status: 0.9 },
  { characterId: 2, characterName: 'Bravo', item_id: 20, type_id: 34, type_name: 'Tritanium',
    quantity: 1_000_000, location_id: 60003760,
    location_name: 'Jita IV - Moon 4', solar_system_id: 30000142, solar_system_name: 'Jita',
    region_name: 'The Forge', security_status: 0.9, owner_name: 'Caldari Navy' },
  { characterId: 2, characterName: 'Bravo', item_id: 21, type_id: 34, type_name: 'Tritanium',
    quantity: 500, location_id: 60011866,
    location_name: 'Dodixie IX - Moon 20', solar_system_id: 30002659, solar_system_name: 'Dodixie',
    region_name: 'Sinq Laison', security_status: 0.9 },
];

const PRICES = new Map([
  [671,   { value: 165e9, source: 'hull-default' }],
  [24688, { value: 90e6,  source: 'market' }],
  [2048,  { value: 500_000, source: 'market' }],
  [34,    { value: 5, source: 'ccp' }],
]);

const TYPE_INFO = new Map([
  [671,   { group: 'Titan', category: 'Ship' }],
  [24688, { group: 'Battleship', category: 'Ship' }],
  [2048,  { group: 'Damage Control', category: 'Module', slot: 'Low', metaLevel: 5, techLevel: 2 }],
  [34,    { group: 'Mineral', category: 'Material' }],
]);

async function seeded() {
  const db = await freshDb();
  await val.writeTypePrices(db, PRICES);
  // No asset_contained seeding: the index rolls containers up over its OWN rows
  // now, so the two Damage Control IIs fitted to the Rokh (item 11) are what
  // give it its contained value.
  await idx.rebuildAssetIndex(db, ROWS, TYPE_INFO);
  return db;
}

test('every row is indexed and grouped by station', async () => {
  const db = await seeded();
  const groups = await idx.getLocationGroups(db, {}, {});
  assert.strictEqual(groups.length, 2);
  const jita = groups.find(g => g.loc_label.startsWith('Jita'));
  // Five rows in Jita: the two ships, both fitted modules, and Bravo's ore.
  assert.strictEqual(jita.item_count, 5);
  await cleanup(db);
});

test('a group total is the sum of what is in it, counted once', async () => {
  const db = await seeded();
  const groups = await idx.getLocationGroups(db, {}, {});
  // Found by name, not by position: the default order is region then system, so
  // Sinq Laison sorts ahead of The Forge and groups[0] is Dodixie.
  const jita = groups.find(g => g.loc_label.startsWith('Jita'));
  // 165B Erebus + 90M Rokh + 2 x 500k modules + 1,000,000 Tritanium at 5 ISK.
  assert.strictEqual(jita.value, 165e9 + 90e6 + 1_000_000 + 5_000_000);
  await cleanup(db);
});

test('net worth does not double-count what is inside a container', async () => {
  const db = await seeded();
  const summary = await idx.getSummary(db, {});
  const groups  = await idx.getLocationGroups(db, {}, {});
  const fromGroups = groups.reduce((n, g) => n + g.value, 0);
  // The Rokh carries 1M ISK of contents. That 1M is already counted as the two
  // modules' own value, so adding contained_value on top would bill it twice.
  assert.strictEqual(summary.value, fromGroups);
  await cleanup(db);
});

// The invariant behind the reported bug: a Wyvern row read 57B while the
// character header above it read 50B. A header shows SUM(own_value); a
// top-level row shows own + contained. Those agree only if everything counted
// inside a container is also a row in the same group — so assert it directly,
// for every group, rather than trusting that it happens to hold.
async function assertHeadersMatchRows(db, label) {
  const groups = await db.all(
    'SELECT loc_key, character_id, SUM(own_value) header FROM asset_index GROUP BY loc_key, character_id');
  assert.ok(groups.length, 'no groups to check');
  for (const g of groups) {
    const all = await db.all(
      'SELECT item_id, location_id, total_value FROM asset_index WHERE loc_key = ? AND character_id = ?',
      g.loc_key, g.character_id);
    const present = new Set(all.map(r => r.item_id));
    const visible = all
      .filter(r => !present.has(r.location_id))     // the rows actually rendered at top level
      .reduce((sum, r) => sum + r.total_value, 0);
    assert.ok(Math.abs(visible - g.header) < 0.001,
      `${label}: ${g.loc_key} / ${g.character_id} — header ${g.header} vs visible rows ${visible}`);
  }
}

test('a group header always equals the rows shown beneath it', async () => {
  const db = await seeded();
  await assertHeadersMatchRows(db, 'seeded');
  await cleanup(db);
});

test('the header still matches when a container sits in a merged unknown group', async () => {
  // The merged bucket collects several unreadable structures into one header,
  // so it is the case most likely to credit a container with contents that are
  // filed elsewhere. It is also where the only real-data mismatch showed up.
  const db = await freshDb();
  await val.writeTypePrices(db, new Map([[2048, { value: 1_000_000, source: 'market' }]]));
  await idx.rebuildAssetIndex(db, [
    { characterId: 1, item_id: 1, type_id: 60, type_name: 'Container',
      quantity: 1, location_id: 5001, location_name: null },
    { characterId: 1, item_id: 2, type_id: 2048, type_name: 'Damage Control II',
      quantity: 3, location_id: 1, location_name: null },
    { characterId: 1, item_id: 3, type_id: 2048, type_name: 'Damage Control II',
      quantity: 1, location_id: 5002, location_name: null },
  ], new Map());
  await assertHeadersMatchRows(db, 'merged unknown');
  await cleanup(db);
});

test('a container is ranked by what it holds, not by its own hull', async () => {
  const db = await seeded();
  const { rows } = await idx.getGroupItems(db, 'Jita IV - Moon 4||30000142', 1, {},
    { col: 'price', dir: -1 });
  const rokh = rows.find(r => r.item_id === 11);
  assert.strictEqual(rokh.own_value, 90e6);
  assert.strictEqual(rokh.contained_value, 1_000_000);
  assert.strictEqual(rokh.total_value, 91_000_000);
  await cleanup(db);
});

test('sorting by value ranks across the whole portfolio, not one page of it', async () => {
  const db = await seeded();
  // The point of the whole design: a Titan in one hangar out of many is row one.
  const top = await idx.getTopItems(db, { limit: 1 });
  assert.strictEqual(top[0].type_name, 'Erebus');
  assert.strictEqual(top[0].loc_label, 'Jita IV - Moon 4');
  await cleanup(db);
});

test('a blueprint copy is nominal however expensive its type is', async () => {
  const db = await freshDb();
  await val.writeTypePrices(db, new Map([[841, { value: 2e9, source: 'ccp' }]]));
  await idx.rebuildAssetIndex(db, [
    { characterId: 1, item_id: 1, type_id: 841, type_name: 'Ragnarok Blueprint', is_bpc: 1,
      quantity: 1, location_id: 60003760, location_name: 'Jita IV - Moon 4' },
    { characterId: 1, item_id: 2, type_id: 841, type_name: 'Ragnarok Blueprint', is_bpc: 0,
      quantity: 1, location_id: 60003760, location_name: 'Jita IV - Moon 4' },
  ], new Map());
  const { rows } = await idx.getGroupItems(db, 'Jita IV - Moon 4||', 1, {}, {});
  const copy     = rows.find(r => r.item_id === 1);
  const original = rows.find(r => r.item_id === 2);
  assert.strictEqual(copy.own_value, 0.01);
  assert.strictEqual(original.own_value, 2e9);
  await cleanup(db);
});

test('filters narrow the groups, the totals and the items together', async () => {
  const db = await seeded();
  const filters = { characterId: 2 };
  const groups  = await idx.getLocationGroups(db, filters, {});
  const summary = await idx.getSummary(db, filters);
  // Bravo holds ore in two stations and nothing else.
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(summary.rows, 2);
  assert.strictEqual(summary.characters, 1);
  assert.ok(summary.filtered);
  await cleanup(db);
});

test('search matches on location and corp, not just item name', async () => {
  const db = await seeded();
  const byCorp   = await idx.getSummary(db, { search: 'caldari navy' });
  const byRegion = await idx.getSummary(db, { search: 'sinq' });
  assert.strictEqual(byCorp.rows, 3);     // the two ships and Bravo's Jita ore
  assert.strictEqual(byRegion.rows, 1);   // only the Dodixie stack
  await cleanup(db);
});

// ─── Searching by ship class ──────────────────────────────────────────────────
// Group names below are the real ones, checked against data/sde.sql: a Nyx is a
// Supercarrier, its blueprint is in "Supercarrier Blueprints" (plural, unlike
// "Carrier Blueprint"), and an Apostle is a Force Auxiliary.

const FLEET = [
  { characterId: 1, item_id: 1, type_id: 23757, type_name: 'Archon', quantity: 1,
    location_id: 60003760, location_name: 'Jita IV - Moon 4', solar_system_id: 30000142 },
  { characterId: 1, item_id: 2, type_id: 23913, type_name: 'Nyx', quantity: 1,
    location_id: 60003760, location_name: 'Jita IV - Moon 4', solar_system_id: 30000142 },
  { characterId: 1, item_id: 3, type_id: 19724, type_name: 'Moros', quantity: 1,
    location_id: 60003760, location_name: 'Jita IV - Moon 4', solar_system_id: 30000142 },
  { characterId: 1, item_id: 4, type_id: 19725, type_name: 'Moros Blueprint', is_bpc: 0,
    quantity: 1, location_id: 60003760, location_name: 'Jita IV - Moon 4', solar_system_id: 30000142 },
  { characterId: 1, item_id: 5, type_id: 23914, type_name: 'Nyx Blueprint', is_bpc: 0,
    quantity: 1, location_id: 60003760, location_name: 'Jita IV - Moon 4', solar_system_id: 30000142 },
  { characterId: 1, item_id: 6, type_id: 37604, type_name: 'Apostle', quantity: 1,
    location_id: 60003760, location_name: 'Jita IV - Moon 4', solar_system_id: 30000142 },
  { characterId: 1, item_id: 7, type_id: 587, type_name: 'Rifter', quantity: 1,
    location_id: 60003760, location_name: 'Jita IV - Moon 4', solar_system_id: 30000142 },
];

const FLEET_TYPES = new Map([
  [23757, { group: 'Carrier',                 category: 'Ship' }],
  [23913, { group: 'Supercarrier',            category: 'Ship' }],
  [19724, { group: 'Dreadnought',             category: 'Ship' }],
  [19725, { group: 'Dreadnought Blueprint',   category: 'Blueprint' }],
  [23914, { group: 'Supercarrier Blueprints', category: 'Blueprint' }],
  [37604, { group: 'Force Auxiliary',         category: 'Ship' }],
  [587,   { group: 'Frigate',                 category: 'Ship' }],
]);

async function fleet() {
  const db = await freshDb();
  await idx.rebuildAssetIndex(db, FLEET, FLEET_TYPES);
  return db;
}

/** The item names a search returns, sorted, so assertions read as a set. */
async function found(db, search) {
  const { rows } = await idx.getGroupItems(
    db, 'Jita IV - Moon 4||30000142', 1, { search }, {});
  return rows.map(r => r.type_name).sort();
}

test('searching a class name finds every hull of that class', async () => {
  const db = await fleet();
  assert.deepStrictEqual(await found(db, 'dreadnought'), ['Moros', 'Moros Blueprint']);
  await cleanup(db);
});

test('a broader class name includes the classes nested under it', async () => {
  const db = await fleet();
  // "carrier" is a substring of "Supercarrier", so the hierarchy comes for free:
  // asking for carriers gets the supers too, which is what a person means.
  assert.deepStrictEqual(await found(db, 'carrier'),
    ['Archon', 'Nyx', 'Nyx Blueprint']);
  await cleanup(db);
});

test('a narrower class name excludes the wider one', async () => {
  const db = await fleet();
  assert.deepStrictEqual(await found(db, 'supercarrier'), ['Nyx', 'Nyx Blueprint']);
  await cleanup(db);
});

test('plurals work as well as singulars', async () => {
  const db = await fleet();
  assert.deepStrictEqual(await found(db, 'supercarriers'), ['Nyx', 'Nyx Blueprint']);
  assert.deepStrictEqual(await found(db, 'dreadnoughts'), ['Moros', 'Moros Blueprint']);
  assert.deepStrictEqual(await found(db, 'carriers'), ['Archon', 'Nyx', 'Nyx Blueprint']);
  await cleanup(db);
});

test('a community name finds the class the game calls something else', async () => {
  const db = await fleet();
  assert.deepStrictEqual(await found(db, 'mothership'), ['Nyx', 'Nyx Blueprint']);
  assert.deepStrictEqual(await found(db, 'motherships'), ['Nyx', 'Nyx Blueprint']);
  assert.deepStrictEqual(await found(db, 'fax'), ['Apostle']);
  await cleanup(db);
});

test('naming the blueprint class returns the print, not the hull', async () => {
  const db = await fleet();
  assert.deepStrictEqual(await found(db, 'dreadnought blueprint'), ['Moros Blueprint']);
  // The category is in the blob too, so the whole print collection is reachable.
  assert.deepStrictEqual(await found(db, 'blueprint'),
    ['Moros Blueprint', 'Nyx Blueprint']);
  await cleanup(db);
});

test('searching by class still narrows the location list and the totals', async () => {
  const db = await fleet();
  // The class search has to reach the summary and the group headers too, or the
  // page would say "7 assets" above a list showing two.
  const summary = await idx.getSummary(db, { search: 'supercarrier' });
  assert.strictEqual(summary.rows, 2);
  assert.ok(summary.filtered);
  const groups = await idx.getLocationGroups(db, { search: 'supercarrier' }, {});
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].item_count, 2);
  await cleanup(db);
});

test('an item name still wins where it always did', async () => {
  const db = await fleet();
  assert.deepStrictEqual(await found(db, 'rifter'), ['Rifter']);
  assert.deepStrictEqual(await found(db, 'nyx'), ['Nyx', 'Nyx Blueprint']);
  await cleanup(db);
});

test('unreadable structures with no system collapse into one group', async () => {
  const db = await freshDb();
  const rows = [1001, 1002, 1003].map((id, i) => ({
    characterId: 1, item_id: 100 + i, type_id: 34, type_name: 'Tritanium',
    quantity: 1, location_id: id, location_name: null,
  }));
  await idx.rebuildAssetIndex(db, rows, new Map());
  const groups = await idx.getLocationGroups(db, {}, {});
  // Three "Location {id}" headers would be three rows of noise saying nothing.
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].loc_key, '__unknown_structures__');
  assert.match(groups[0].subtitle, /3 structures/);
  await cleanup(db);
});

test('a single unreadable structure is left alone rather than merged', async () => {
  const db = await freshDb();
  await idx.rebuildAssetIndex(db, [{
    characterId: 1, item_id: 1, type_id: 34, type_name: 'Tritanium',
    quantity: 1, location_id: 1001, location_name: null,
  }], new Map());
  const groups = await idx.getLocationGroups(db, {}, {});
  assert.strictEqual(groups[0].loc_key, '1001');
  await cleanup(db);
});

test('an unnamed location full of planetary goods is named as what it is', async () => {
  const db = await freshDb();
  const rows = Array.from({ length: 10 }, (_, i) => ({
    characterId: 1, item_id: 200 + i, type_id: 2268, type_name: 'Aqueous Liquids',
    quantity: 100, location_id: 40001, location_name: null, solar_system_name: 'Ahbazon',
  }));
  await idx.rebuildAssetIndex(db, rows,
    new Map([[2268, { category: 'Planetary Commodities' }]]));
  const groups = await idx.getLocationGroups(db, {}, {});
  // A Customs Office or Skyhook is the only thing that holds PI out in space.
  assert.strictEqual(groups[0].loc_label, 'Customs Office / Skyhook');
  await cleanup(db);
});

test('the merged unknown group sorts last whatever the column', async () => {
  const db = await freshDb();
  await idx.rebuildAssetIndex(db, [
    ...[1001, 1002].map((id, i) => ({
      characterId: 1, item_id: 300 + i, type_id: 34, type_name: 'Tritanium',
      quantity: 1, location_id: id, location_name: null,
    })),
    { characterId: 1, item_id: 400, type_id: 34, type_name: 'Tritanium', quantity: 1,
      location_id: 60003760, location_name: 'Zzz Station', solar_system_id: 1 },
  ], new Map());
  for (const sort of [{}, { col: 'name', dir: 1 }, { col: 'price', dir: -1 }]) {
    const groups = await idx.getLocationGroups(db, sort.col ? {} : {}, sort);
    assert.strictEqual(groups[groups.length - 1].loc_key, '__unknown_structures__',
      `unknown group should be last for sort ${JSON.stringify(sort)}`);
  }
  await cleanup(db);
});

test('a rebuild replaces the index rather than appending to it', async () => {
  const db = await seeded();
  await idx.rebuildAssetIndex(db, ROWS, TYPE_INFO);
  const summary = await idx.getSummary(db, {});
  assert.strictEqual(summary.totalRows, ROWS.length);
  await cleanup(db);
});

test('a table left behind by an older version is rebuilt, not written to', async () => {
  // CREATE TABLE IF NOT EXISTS does nothing to an existing table, which has
  // shipped as "no such column" twice in this project. These two tables are a
  // derived cache, so the shape is asserted and the table dropped when it drifts.
  const db = await freshDb();
  const file = path.join(dir, 'test.db');
  await db.exec('DROP TABLE asset_index');
  await db.exec('CREATE TABLE asset_index (character_id INTEGER, item_id INTEGER, loc_key TEXT)');
  await db.close();

  // A SEPARATE handle, because that is the real scenario: the stale table was
  // written by a previous run of the app, and the check happens once when the
  // new one opens the database.
  const reopened = await open({ filename: file, driver: sqlite3.Database });
  await idx.ensureAssetIndex(reopened);
  const cols = (await reopened.all('PRAGMA table_info(asset_index)')).map(c => c.name);
  assert.ok(cols.includes('own_value'), 'the stale table should have been rebuilt');
  assert.ok(cols.includes('search_blob'));
  await cleanup(reopened);
});

test('a very large hangar is capped, keeps the most valuable, and says so', async () => {
  const db = await freshDb();
  await val.writeTypePrices(db, new Map([[34, { value: 1, source: 'ccp' }]]));
  const rows = Array.from({ length: 120 }, (_, i) => ({
    characterId: 1, item_id: 1000 + i, type_id: 34, type_name: 'Tritanium',
    quantity: i + 1, location_id: 60003760, location_name: 'Jita IV - Moon 4',
  }));
  await idx.rebuildAssetIndex(db, rows, new Map());
  const res = await idx.getGroupItems(db, 'Jita IV - Moon 4||', 1, {}, {}, 50);
  assert.strictEqual(res.total, 120);
  assert.strictEqual(res.rows.length, 50);
  assert.ok(res.truncated);
  // If the list has to be cut, the cut keeps what matters.
  assert.strictEqual(res.rows[0].quantity, 120);
  await cleanup(db);
});
