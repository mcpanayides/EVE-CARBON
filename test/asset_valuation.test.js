'use strict';
//
// Asset valuation — the price-resolution rules and the materialised values.
//
// The precedence tests are pure and offline. The rest run against a real SQLite
// database, because the container roll-up IS a recursive CTE and the BPO/BPC
// distinction IS a join — mocking either would test the mock.
//
// Measured context for the rules under test (TODO.md): CCP's map covers 91.4% of
// held types but runs ~18% low and misprices rares in both directions; Fuzzwork
// has no price at all for hulls that cannot be sold in highsec. Hence three
// sources with a strict precedence, and that precedence is what these assert.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const val = require('../src/asset_valuation');

// ─── Price resolution ─────────────────────────────────────────────────────────

test('a market price beats CCP for the same type', () => {
  const r = val.resolveUnitValues({
    ccp:    new Map([[100, 1_000_000]]),
    market: new Map([[100, 8_499_000]]),
  });
  // The Domination Control Tower case: CCP said 23% of the real price.
  assert.strictEqual(r.get(100).value, 8_499_000);
  assert.strictEqual(r.get(100).source, 'market');
});

test('CCP is the baseline where no market price was fetched', () => {
  const r = val.resolveUnitValues({ ccp: new Map([[200, 5_000]]), market: new Map() });
  assert.strictEqual(r.get(200).value, 5_000);
  assert.strictEqual(r.get(200).source, 'ccp');
});

test('a capital hull default outranks both price sources', () => {
  // The Wyvern case: Fuzzwork quoted 4.9M because supercapitals have no highsec
  // market at all. Whatever either source says, the hull default wins.
  const r = val.resolveUnitValues({
    ccp:    new Map([[23917, 27_000_000_000]]),
    market: new Map([[23917, 4_900_000]]),
    meta:   new Map([[23917, { group: 'Supercarrier' }]]),
  });
  assert.strictEqual(r.get(23917).value, 50e9);
  assert.strictEqual(r.get(23917).source, 'hull-default');
});

test('pirate-faction hulls are valued above their standard counterpart', () => {
  const faction = val.resolveUnitValues({ meta: new Map([[1, { group: 'Titan', metaGroup: 4 }]]) });
  const standard = val.resolveUnitValues({ meta: new Map([[2, { group: 'Titan' }]]) });
  assert.strictEqual(faction.get(1).value, 300e9);
  assert.strictEqual(standard.get(2).value, 165e9);
  assert.ok(faction.get(1).value > standard.get(2).value);
});

test('standard dreadnoughts are left to the market', () => {
  // They genuinely trade, so the default is 0 and the market price stands —
  // only faction dreads need the override.
  const r = val.resolveUnitValues({
    ccp:  new Map([[19722, 2_800_000_000]]),
    meta: new Map([[19722, { group: 'Dreadnought' }]]),
  });
  assert.strictEqual(r.get(19722).source, 'ccp');
  assert.strictEqual(r.get(19722).value, 2_800_000_000);
});

test('a type nothing can price is recorded as unknown, not dropped', () => {
  const r = val.resolveUnitValues({ ccp: new Map([[300, 0]]) });
  assert.strictEqual(r.get(300).value, 0);
  assert.strictEqual(r.get(300).source, 'unknown');
});

// ─── Choosing what to refine ──────────────────────────────────────────────────

test('refinement targets the types holding the value, not the most numerous', () => {
  const held = new Map([
    [34, 50_000_000],   // Tritanium: vast quantity, negligible each
    [23917, 1],         // one supercarrier
    [587, 3],
  ]);
  const ccp = new Map([[34, 5], [23917, 27_000_000_000], [587, 400_000]]);
  const picked = val.selectTypesToRefine(held, ccp, 2);
  assert.ok(picked.includes(23917), 'the supercarrier must be refined');
  // Tritanium still outranks a few frigates on total held value — the ranking is
  // value held, not unit price.
  assert.ok(picked.includes(34));
});

test('types CCP cannot price at all are refined first', () => {
  // An unpriced type is far more likely to be a rare worth real money than a
  // mineral, so it must not sort to the bottom on a value of zero.
  const held = new Map([[999, 1], [34, 1_000_000]]);
  const ccp = new Map([[34, 5]]);            // 999 absent entirely
  assert.strictEqual(val.selectTypesToRefine(held, ccp, 1)[0], 999);
});

// ─── Materialised values ──────────────────────────────────────────────────────

let dir, db, charDb;
const CHAR = 90000001;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evecarbon-valuation-'));
  charDb = require('../src/character_info_db');
  await charDb.initCharacterDb(dir);
  await charDb.ensureCharacterTables(CHAR);

  db = await open({ filename: path.join(dir, 'character_information.db'), driver: sqlite3.Database });
  await val.ensureValuationTables(db);
});
test.after(async () => {
  await db?.close();
  await charDb?.closeCharacterDb();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
});

test('asset values are materialised per item, priced from the type table', async () => {
  await charDb.replaceAssets(CHAR, [
    { item_id: 1, type_id: 34,  quantity: 1000, location_id: 60003760, name: 'Tritanium' },
    { item_id: 2, type_id: 587, quantity: 1,    location_id: 60003760, name: 'Rifter' },
  ]);
  await val.writeTypePrices(db, new Map([
    [34,  { value: 5,       source: 'ccp' }],
    [587, { value: 400_000, source: 'market' }],
  ]));

  const { items } = await val.rebuildAssetValues(db);
  assert.strictEqual(items, 2);

  const rows = await val.getTopAssetsByValue(db, { limit: 10 });
  assert.strictEqual(rows[0].item_id, 2, 'the Rifter is worth more than 1000 Tritanium');
  assert.strictEqual(rows[0].total_value, 400_000);
  assert.strictEqual(rows[1].total_value, 5000);
});

test('a blueprint copy is nominal however valuable its type', async () => {
  await charDb.replaceAssets(CHAR, [
    { item_id: 10, type_id: 19723, quantity: 1, location_id: 60003760, name: 'Naglfar Blueprint' },
    { item_id: 11, type_id: 19723, quantity: 1, location_id: 60003760, name: 'Naglfar Blueprint' },
  ]);
  await charDb.replaceBlueprints(CHAR, [
    { item_id: 10, type_id: 19723, location_id: 60003760, quantity: 1, runs: -1, me: 10, te: 20, isBPC: false },
    { item_id: 11, type_id: 19723, location_id: 60003760, quantity: 1, runs: 5,  me: 10, te: 20, isBPC: true },
  ]);
  await val.writeTypePrices(db, new Map([[19723, { value: 1_943_000_000, source: 'ccp' }]]));
  await val.rebuildAssetValues(db);

  const byItem = new Map((await val.getTopAssetsByValue(db, { limit: 10 })).map(r => [r.item_id, r]));
  assert.strictEqual(byItem.get(10).own_value, 1_943_000_000, 'the original is worth its type price');
  assert.strictEqual(byItem.get(11).own_value, val.BPC_UNIT_VALUE, 'the copy is nominal');
});

test('a container is worth what is inside it, to any depth', async () => {
  await charDb.replaceBlueprints(CHAR, []);
  await charDb.replaceAssets(CHAR, [
    { item_id: 100, type_id: 3465, quantity: 1, location_id: 60003760, name: 'Asset Safety Wrap' },
    { item_id: 101, type_id: 587,  quantity: 1, location_id: 100, name: 'Rifter' },        // in the wrap
    { item_id: 102, type_id: 34,   quantity: 100, location_id: 101, name: 'Tritanium' },   // in the Rifter
  ]);
  await val.writeTypePrices(db, new Map([
    [3465, { value: 0,       source: 'ccp' }],      // the wrap itself is worthless
    [587,  { value: 400_000, source: 'market' }],
    [34,   { value: 5,       source: 'ccp' }],
  ]));
  const { containers } = await val.rebuildAssetValues(db);
  assert.ok(containers >= 2, 'both the wrap and the ship hold value');

  const rows = new Map((await val.getTopAssetsByValue(db, { limit: 10 })).map(r => [r.item_id, r]));
  // The wrap is worth nothing itself but holds a ship holding minerals.
  assert.strictEqual(rows.get(100).own_value, 0);
  assert.strictEqual(rows.get(100).contained_value, 400_500);
  assert.strictEqual(rows.get(100).total_value, 400_500);
  // Nesting is not double counted at the intermediate level.
  assert.strictEqual(rows.get(101).contained_value, 500);
  // And the wrap now outranks the ship it contains.
  assert.strictEqual((await val.getTopAssetsByValue(db, { limit: 1 }))[0].item_id, 100);
});

test('net worth counts each item once, never its container too', async () => {
  // own_value only. Adding contained_value would count the Rifter as itself and
  // again as part of the wrap.
  assert.strictEqual(await val.getAssetNetWorth(db), 400_500);
  assert.strictEqual(await val.getAssetNetWorth(db, CHAR), 400_500);
  assert.strictEqual(await val.getAssetNetWorth(db, 99999999), 0);
});

test('a rebuild replaces the previous valuation rather than adding to it', async () => {
  const before = await val.getAssetNetWorth(db);
  await val.rebuildAssetValues(db);
  assert.strictEqual(await val.getAssetNetWorth(db), before, 'values doubled — the rebuild appended');
});

test('paging walks a globally ordered result', async () => {
  const first = await val.getTopAssetsByValue(db, { limit: 1, offset: 0 });
  const second = await val.getTopAssetsByValue(db, { limit: 1, offset: 1 });
  assert.ok(first[0].total_value >= second[0].total_value,
    'page two must continue the ranking, not restart it');
});

test('refresh times are recorded so staleness can be shown', async () => {
  const meta = await val.getValuationMeta(db);
  assert.ok(meta.prices_updated_at, 'no price timestamp');
  assert.ok(meta.values_rebuilt_at, 'no rebuild timestamp');
  assert.ok(!isNaN(Date.parse(meta.values_rebuilt_at)));
});

// ─── ESI asset pagination ─────────────────────────────────────────────────────
// A real hangar lost a supercarrier to this. The sync loop stopped when a page
// returned fewer than 1000 items, guessing that a short page meant the last
// page — but ESI can return fewer and still have pages after it. One character
// came back with 999 on page one and everything from page two onwards was
// silently dropped, with no error anywhere.
//
// The loop is inline in assets_ipc's syncAssetsInternal (it needs a live token),
// so the exit RULE is modelled here rather than the function imported. If the
// rule in that file changes, this is the statement of what it must preserve.
function pagesFetched({ pageSizes, xPages }) {
  const fetched = [];
  let page = 1, totalPages = 1;
  while (true) {
    const data = pageSizes[page - 1] ?? [];
    if (page === 1) totalPages = xPages || 1;
    if (!Array.isArray(data) || !data.length) break;
    fetched.push(data.length);
    if (page >= totalPages) break;
    if (page >= 60) break;
    page++;
  }
  return fetched;
}
const page = (n) => new Array(n).fill(0);

test('a short first page does not end a multi-page fetch', () => {
  // The exact shape that lost the Nyx: 999 items, then more pages.
  const got = pagesFetched({ pageSizes: [page(999), page(412)], xPages: 2 });
  assert.deepStrictEqual(got, [999, 412],
    'page two was dropped because page one was under 1000');
  assert.strictEqual(got.reduce((a, b) => a + b, 0), 1411);
});

test('a full single page still stops at one', () => {
  assert.deepStrictEqual(pagesFetched({ pageSizes: [page(1000)], xPages: 1 }), [1000]);
});

test('every page is fetched when X-Pages says so', () => {
  const got = pagesFetched({ pageSizes: [page(1000), page(1000), page(37)], xPages: 3 });
  assert.deepStrictEqual(got, [1000, 1000, 37]);
});

test('an empty page ends the walk', () => {
  // Guards against paging forever when X-Pages overstates what exists.
  assert.deepStrictEqual(pagesFetched({ pageSizes: [page(500), []], xPages: 9 }), [500]);
});

test('a nonsense X-Pages cannot spin forever', () => {
  const got = pagesFetched({ pageSizes: new Array(200).fill(page(1000)), xPages: 9999 });
  assert.strictEqual(got.length, 60, 'the hard cap must hold');
});
