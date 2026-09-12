'use strict';
//
// The Planetary Interaction production model.
//
// Two pages read this — the Colonies shortfall banner and the PI Planner — so
// the arithmetic lives in one place and is tested without Electron, the SDE or a
// character. The fixtures below are a miniature but structurally real PI tree:
// two P0s, two P1s, one P2, one P3, with a shared input, because a shared input
// is where a naive solver goes wrong.
const test   = require('node:test');
const assert = require('node:assert');
const PM     = require('../src/shared/pi_model.js');

// ── Fixture: a small tree with a genuinely shared intermediate ───────────────
//   P0 100, 101
//   P1 200 (from 100)          P1 201 (from 101)
//   P2 300 (from 200 + 201)
//   P3 400 (from 300 + 200)    <- 200 feeds BOTH the P2 and the P3
const SCHEMATICS = [
  { schematicID: 1, schematicName: 'Widget P1 A', cycleTime: 1800 },
  { schematicID: 2, schematicName: 'Widget P1 B', cycleTime: 1800 },
  { schematicID: 3, schematicName: 'Widget P2',   cycleTime: 3600 },
  { schematicID: 4, schematicName: 'Widget P3',   cycleTime: 3600 },
];
const TYPEMAP = [
  { schematicID: 1, typeID: 100, quantity: 3000, isInput: 1 },
  { schematicID: 1, typeID: 200, quantity: 20,   isInput: 0 },
  { schematicID: 2, typeID: 101, quantity: 3000, isInput: 1 },
  { schematicID: 2, typeID: 201, quantity: 20,   isInput: 0 },
  { schematicID: 3, typeID: 200, quantity: 40,   isInput: 1 },
  { schematicID: 3, typeID: 201, quantity: 40,   isInput: 1 },
  { schematicID: 3, typeID: 300, quantity: 5,    isInput: 0 },
  { schematicID: 4, typeID: 300, quantity: 10,   isInput: 1 },
  { schematicID: 4, typeID: 200, quantity: 10,   isInput: 1 },
  { schematicID: 4, typeID: 400, quantity: 3,    isInput: 0 },
];
const idx = () => PM.indexSchematics(SCHEMATICS, TYPEMAP);

// ── The graph ────────────────────────────────────────────────────────────────

test('a schematic knows its inputs and its single output', () => {
  const i = idx();
  const s = i.byId.get(3);
  assert.strictEqual(s.output.id, 300);
  assert.strictEqual(s.inputs.length, 2);
  assert.strictEqual(i.producer.get(300).id, 3, 'the producer index points back to it');
  assert.strictEqual(i.producer.has(100), false, 'a raw material has no producer');
});

test('tier is derived from the graph, not hardcoded', () => {
  // So it stays right if CCP ever adds a tier, and so the model never depends on
  // group ids that mean nothing outside the SDE.
  const i = idx();
  assert.strictEqual(PM.tierOf(100, i), 0, 'extracted');
  assert.strictEqual(PM.tierOf(200, i), 1);
  assert.strictEqual(PM.tierOf(300, i), 2);
  assert.strictEqual(PM.tierOf(400, i), 3);
});

test('a 30-minute cycle is twice an hourly one', () => {
  const i = idx();
  assert.strictEqual(PM.runsPerHour(i.byId.get(1)), 2, 'P1 cycles are 1800s');
  assert.strictEqual(PM.runsPerHour(i.byId.get(3)), 1);
});

// ── Solving a target back to planets ────────────────────────────────────────

test('a shared input is solved ONCE against its total demand', () => {
  // The failure a naive solver makes: 200 feeds both the P2 and the P3, so
  // walking the tree branch-by-branch and adding factories per branch buys two
  // half-sized sets that neither meets the real demand. Demand is accumulated
  // first, then converted to factories.
  const i = idx();
  const plan = PM.planFor(400, 3, i);           // one P3 factory's worth
  const w200 = plan.steps.find(s => s.id === 200);

  // P3: 3/hr needs 1 factory. It eats 10x300 and 10x200 per hour.
  // P2: 10/hr of 300 -> ceil(10/5) = 2 factories, eating 80x200 and 80x201.
  // So 200 is wanted at 80 (from P2) + 10 (from P3) = 90/hr, NOT 80 or 10.
  assert.strictEqual(w200.wantPerHour, 90, 'both consumers must be counted');
  assert.strictEqual(w200.factories, Math.ceil(90 / 40), '40/hr per P1 factory');
});

test('factories are whole, so a plan slightly over-produces', () => {
  const i = idx();
  const plan = PM.planFor(400, 1, i);
  const p3 = plan.steps.find(s => s.id === 400);
  assert.strictEqual(p3.factories, 1);
  assert.strictEqual(p3.actualPerHour, 3, 'one factory makes 3/hr even if you asked for 1');
  assert.ok(p3.actualPerHour >= p3.wantPerHour);
});

test('the plan bottoms out in raw materials with the planets that yield them', () => {
  const i = idx();
  const plan = PM.planFor(400, 3, i);
  const raw = new Map(plan.raw.map(r => [r.id, r]));
  assert.ok(raw.has(100) && raw.has(101), 'both P0s appear');
  assert.ok(raw.get(100).perHour > 0);
  // Nothing that IS produced may appear as raw.
  for (const r of plan.raw) assert.strictEqual(i.producer.has(r.id), false, `${r.id} is produced, not raw`);
});

test('every step is ordered deepest-tier first, so the plan reads top-down', () => {
  const i = idx();
  const tiers = PM.planFor(400, 3, i).steps.map(s => s.tier);
  assert.deepStrictEqual(tiers, [...tiers].sort((a, b) => b - a));
});

// ── Reading an existing network ─────────────────────────────────────────────

const extractor = (typeId, qty) => ({
  pin_id: Math.random(), type_id: 3062,
  expiry_time: new Date(Date.now() + 86400000).toISOString(),
  extractor_details: { product_type_id: typeId, qty_per_cycle: qty, cycle_time: 3600, heads: [1, 2] },
});
const factory = (schematicId, pinId) => ({ pin_id: pinId || Math.random(), type_id: 2469, schematic_id: schematicId });

test('extraction and production net off against each other', () => {
  const i = idx();
  // One extractor of 100 at 6000/hr, one P1-A factory eating 3000/cycle x2.
  const r = PM.tallyNetwork([{ pins: [extractor(100, 6000), factory(1)] }], i);
  assert.strictEqual(r.balance.get(100), 0, '6000 extracted, 6000 consumed');
  assert.strictEqual(r.balance.get(200), 40, 'and 20 x 2 cycles produced');
  assert.strictEqual(r.extractors, 1);
  assert.strictEqual(r.factories, 1);
});

test('an EXPIRED extractor yields nothing', () => {
  // It is still a pin and still reports a qty_per_cycle. Counting it is how a
  // dead colony looks productive on a dashboard.
  const i = idx();
  const dead = extractor(100, 6000);
  dead.expiry_time = new Date(Date.now() - 1000).toISOString();
  const r = PM.tallyNetwork([{ pins: [dead] }], i);
  assert.strictEqual(r.balance.get(100), undefined);
  assert.strictEqual(r.expiredExtractors, 1);
  assert.strictEqual(r.extractors, 1, 'it is still counted as installed');
});

test('with routes known, an unfed factory does not count as producing', () => {
  // Installed capacity and running capacity are different questions. Routes are
  // what tells them apart; this is why they are now persisted.
  const i = idx();
  const fedPin = 11, starvedPin = 22;
  const col = {
    pins: [extractor(100, 6000), factory(1, fedPin), factory(1, starvedPin)],
    routes: [{ source_pin_id: 1, destination_pin_id: fedPin, content_type_id: 100 }],
  };
  const r = PM.tallyNetwork([col], i);
  assert.strictEqual(r.factories, 2);
  assert.strictEqual(r.unfedFactories, 1);
  assert.strictEqual(r.balance.get(200), 40, 'only the fed factory produces');
});

test('with NO routes stored, every factory counts — the old behaviour', () => {
  // Colonies synced before routes were persisted must not silently read as
  // producing nothing.
  const i = idx();
  const r = PM.tallyNetwork([{ pins: [factory(1), factory(1)] }], i);
  assert.strictEqual(r.unfedFactories, 0);
  assert.strictEqual(r.balance.get(200), 80);
});

test('rows arrive as JSON strings from the DB and as arrays from the sync', () => {
  const i = idx();
  const asJson = PM.tallyNetwork([{ pins_json: JSON.stringify([factory(1)]), routes_json: '[]' }], i);
  const asArr  = PM.tallyNetwork([{ pins: [factory(1)] }], i);
  assert.strictEqual(asJson.balance.get(200), asArr.balance.get(200));
  // And malformed JSON is a colony with no pins, not a crash.
  assert.doesNotThrow(() => PM.tallyNetwork([{ pins_json: 'not json' }, null], i));
});

// ── Shortfalls ──────────────────────────────────────────────────────────────

test('a shortfall is something you MAKE too little of', () => {
  const i = idx();
  // A P3 factory with nothing feeding it: short on 300 and 200, not on 400.
  const r = PM.tallyNetwork([{ pins: [factory(4)] }], i);
  const short = PM.shortfalls(r.balance, i);
  const ids = short.map(s => s.id);
  assert.ok(ids.includes(300) && ids.includes(200));
  assert.ok(!ids.includes(400), 'the thing being produced is not a shortfall');
  assert.strictEqual(short[0].tier, 2, 'deepest tier first — fix the P2 before the P1');
});

test('a raw deficit is reported separately, with the planets that fix it', () => {
  // Being short of ore is not the same complaint as being short of a component:
  // one needs another factory, the other needs another extractor.
  const i = idx();
  const r = PM.tallyNetwork([{ pins: [factory(1)] }], i);   // eats 100, extracts nothing
  assert.deepStrictEqual(PM.shortfalls(r.balance, i).map(s => s.id), [], 'no MADE thing is short');
  const raw = PM.rawDeficits(r.balance, i);
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].id, 100);
  assert.ok(Array.isArray(raw[0].planetTypes));
});

test('a shortfall converts into a concrete number of factories and planets', () => {
  const i = idx();
  const fix = PM.fixFor({ id: 200, perHour: -90, tier: 1 }, i);
  assert.strictEqual(fix.perFactoryPerHour, 40);
  assert.strictEqual(fix.factories, 3, 'ceil(90/40)');
  assert.strictEqual(fix.planets, Math.ceil(3 / PM.PLANET_FACTORY_BUDGET));
  assert.ok(fix.inputs.length, 'and it says what those factories will then need');
});

// ── The planet table ────────────────────────────────────────────────────────

test('every planet type yields exactly five resources', () => {
  const types = Object.keys(PM.PLANET_RESOURCES);
  assert.strictEqual(types.length, 8, 'EVE has eight planet types');
  for (const t of types) {
    assert.strictEqual(PM.PLANET_RESOURCES[t].length, 5, t);
    assert.strictEqual(new Set(PM.PLANET_RESOURCES[t]).size, 5, `${t} lists a duplicate`);
  }
});

test('every raw resource is obtainable somewhere', () => {
  // A P0 no planet yields would make any plan needing it unsatisfiable, silently.
  const all = new Set(Object.values(PM.PLANET_RESOURCES).flat());
  assert.strictEqual(all.size, 15, 'fifteen P0 types exist');
  for (const id of all) assert.ok(PM.planetTypesFor(id).length > 0, `${id} has no source`);
});

test('the survey caveat is stated, because richness is not knowable', () => {
  // The single most important honesty constraint in this feature: no API
  // publishes planet richness, so no plan may imply it does.
  assert.match(PM.SURVEY_CAVEAT, /survey/i);
  assert.match(PM.SURVEY_CAVEAT, /richness|resource/i);
});

// ── Pricing a raw deficit in extractors ──────────────────────────────────────
//
// A missing P1 is answered in factories, which is a fixed recipe. A missing P0
// cannot be: yield depends on the planet's resource richness, which EVE
// generates server-side and publishes nowhere, and it varies by an order of
// magnitude. There is no published average worth borrowing — so the estimate is
// built from the player's OWN live extractors instead.

const perPlanet = (...rows) => rows.map(rates =>
  ({ extracts: rates.map(([perHour, heads]) => ({ id: 100, perHour, heads })) }));

test('the yield basis is the median extractor, not the mean', () => {
  // One freshly-installed extractor on a rich planet would drag a mean upward
  // and understate how many more are needed — the wrong direction to err in.
  const p = PM.extractorProfile(perPlanet([[10_000, 10]], [[12_000, 10]], [[500_000, 10]]));
  assert.strictEqual(p.perEcu, 12_000);
  assert.strictEqual(p.ecus, 3);
});

test('an even number of extractors averages the middle pair', () => {
  const p = PM.extractorProfile(perPlanet([[10_000, 10], [20_000, 10]]));
  assert.strictEqual(p.perEcu, 15_000);
});

test('planets without extractors do not dilute the per-planet figure', () => {
  // A pure factory planet has no ECU on it and must not count as an extraction
  // planet, or the estimate would spread extractors across rocks that cannot
  // hold them.
  const p = PM.extractorProfile([
    ...perPlanet([[10_000, 10], [10_000, 10]]),
    { extracts: [] },
    { extracts: [] },
  ]);
  assert.strictEqual(p.planets, 1);
  assert.strictEqual(p.ecusPerPlanet, 2);
});

test('a deficit becomes extractors, then planets at the observed density', () => {
  const p   = PM.extractorProfile(perPlanet([[50_000, 10], [50_000, 10]], [[50_000, 10], [50_000, 10]]));
  const fix = PM.rawFixFor({ id: 100, perHour: -250_000 }, p);
  assert.strictEqual(fix.ecus, 5, '250k at 50k each');
  assert.strictEqual(fix.ecusPerPlanet, 2);
  assert.strictEqual(fix.planets, 3, 'five extractors do not fit on two planets');
});

test('the deficit sign does not matter', () => {
  // rawDeficits reports negatives; nothing downstream should depend on that.
  const p = PM.extractorProfile(perPlanet([[10_000, 10]]));
  assert.strictEqual(PM.rawFixFor({ id: 100, perHour: -30_000 }, p).ecus,
                     PM.rawFixFor({ id: 100, perHour:  30_000 }, p).ecus);
});

test('with nothing running there is no estimate, rather than a made-up one', () => {
  const empty = PM.extractorProfile([]);
  assert.strictEqual(empty.perEcu, null);
  assert.strictEqual(PM.rawFixFor({ id: 100, perHour: -1000 }, empty), null);
  assert.strictEqual(PM.rawFixFor({ id: 100, perHour: -1000 }, null), null);
});

test('a dead extractor never reaches the yield basis', () => {
  // tallyNetwork drops expired extractors before they are recorded. If they
  // survived they would enter the median as a genuine low reading and roughly
  // halve the estimated yield of every planet.
  const i = idx();
  const dead = {
    pin_id: 9, type_id: 3062,
    expiry_time: new Date(Date.now() - 86_400_000).toISOString(),
    extractor_details: { product_type_id: 100, qty_per_cycle: 6000, cycle_time: 3600, heads: [1, 2] },
  };
  const net = PM.tallyNetwork([{ planet_id: 1, pins: [extractor(100, 6000), dead] }], i);
  const p   = PM.extractorProfile(net.perPlanet);
  assert.strictEqual(net.expiredExtractors, 1);
  assert.strictEqual(p.ecus, 1, 'only the live one is measured');
  assert.strictEqual(p.perEcu, 6000);
});
