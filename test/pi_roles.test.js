'use strict';
//
// Colony power budgets, planet roles, and planning against a live network.
//
// Two skills decide what a character is worth to a PI empire and they are
// constantly conflated: Interplanetary Consolidation buys MORE planets,
// Command Center Upgrades buys a BIGGER one. Only the second decides whether a
// planet can hold a reactor line, so a character with six free slots and a
// Basic command centre is not the one to put P4 on.
//
// Every number below was read out of the SDE (command centre powergrid/CPU from
// attributes 11/48 on the six published Command Center types, pin costs from
// attributes 15/49). They are pinned here because the whole role model is
// downstream of them, and because the Advanced/Elite CPU figures are widely
// quoted wrongly as 22294/27373.
const test   = require('node:test');
const assert = require('node:assert');
const PM     = require('../src/shared/pi_model.js');

// ─── the budget ladder ───────────────────────────────────────────────────────

test('the command centre ladder matches the SDE', () => {
  assert.strictEqual(PM.CC_BUDGET.length, 6, 'CCU 0..5');
  const pg  = PM.CC_BUDGET.map(b => b.pg).join(',');
  const cpu = PM.CC_BUDGET.map(b => b.cpu).join(',');
  assert.strictEqual(pg,  '6000,9000,12000,15000,17000,19000');
  assert.strictEqual(cpu, '1675,7057,12136,17215,21315,25415');
});

test('the command centre tier is the skill level', () => {
  // CCU is 1:1 with the tier, so the level indexes the table directly.
  assert.strictEqual(PM.colonyBudget(0).tier, 'Basic');
  assert.strictEqual(PM.colonyBudget(5).tier, 'Elite');
  // Out-of-range input clamps rather than returning undefined and crashing a
  // render three frames later.
  assert.strictEqual(PM.colonyBudget(99).tier, 'Elite');
  assert.strictEqual(PM.colonyBudget(-1).tier, 'Basic');
  assert.strictEqual(PM.colonyBudget(null).tier, 'Basic');
});

// ─── role costing ────────────────────────────────────────────────────────────

test('a role costs the sum of its pins plus its links', () => {
  const role = { pins: { launchpad: 1, advanced: 2 }, links: 3 };
  const c = PM.roleCost(role);
  // 700 + 2*700 + 3*10 powergrid; 3600 + 2*500 + 3*15 CPU
  assert.strictEqual(c.pg, 700 + 1400 + 30);
  assert.strictEqual(c.cpu, 3600 + 1000 + 45);
});

test('a Basic command centre cannot carry any working layout', () => {
  // 1675 CPU is the whole story: a single launchpad costs 3600. This is why a
  // CCU-0 character is a dead end rather than a smaller working one.
  assert.strictEqual(PM.rolesForCcu(0).length, 0);
  assert.ok(PM.PIN_COST.launchpad.cpu > PM.CC_BUDGET[0].cpu);
});

test('extraction is powergrid-hungry, not the cheap starter role', () => {
  // The usual assumption is that extraction is what you give a new alt. An
  // Extractor Control Unit is the most powergrid-expensive pin in the game at
  // 2600, so extraction costs MORE powergrid than refining does.
  const ext = PM.PLANET_ROLES.find(r => r.id === 'extraction');
  const ref = PM.PLANET_ROLES.find(r => r.id === 'refinery');
  assert.ok(PM.roleCost(ext).pg > PM.roleCost(ref).pg);
  // ...while refining is the CPU-hungry one, because of the launchpad.
  assert.ok(PM.roleCost(ref).cpu > PM.roleCost(ext).cpu);
});

test('the demanding roles need a Standard command centre', () => {
  const min = Object.fromEntries(PM.PLANET_ROLES.map(r => [r.id, PM.minCcuFor(r)]));
  assert.strictEqual(min.extraction, 1);
  assert.strictEqual(min.refinery,   1);
  assert.strictEqual(min.reactor,    2);
  assert.strictEqual(min.hitech,     2);
});

test('every role opens up by CCU 2; past that the gain is density', () => {
  assert.strictEqual(PM.rolesForCcu(1).length, 2);
  assert.strictEqual(PM.rolesForCcu(2).length, PM.PLANET_ROLES.length);
  // Nothing new unlocks above 2 — what grows is how much fits on one planet.
  assert.strictEqual(PM.rolesForCcu(5).length, PM.rolesForCcu(2).length);
  for (let l = 1; l < 5; l++) {
    assert.ok(PM.factoryCeiling(l + 1) > PM.factoryCeiling(l),
              `CCU ${l + 1} should fit more factories than ${l}`);
  }
  assert.strictEqual(PM.factoryCeiling(0), 0, 'nothing fits beside a launchpad at CCU 0');
});

test('P4 is restricted to the two planets that have a High-Tech plant', () => {
  // A game rule, not a preference: the SDE has High-Tech Production Plants for
  // Barren and Temperate only.
  const ht = PM.PLANET_ROLES.find(r => r.id === 'hitech');
  assert.strictEqual(ht.planetTypes.join(','), 'barren,temperate');
});

// ─── who should run what ─────────────────────────────────────────────────────

test('characters are ranked by command centre, not by planet count', () => {
  // The alt with six slots and a Basic command centre is NOT the one to put a
  // reactor on, however much room they have.
  const rows = PM.recommendRoles([
    { charId: 1, charName: 'Many Slots', ccu: 0, ic: 5, free: 6, used: 0 },
    { charId: 2, charName: 'Big Centre', ccu: 5, ic: 0, free: 1, used: 0 },
  ]);
  assert.strictEqual(rows[0].charName, 'Big Centre');
  assert.strictEqual(rows[0].best, 'hitech');
  assert.strictEqual(rows[1].best, null);
  assert.match(rows[1].note, /Command Center Upgrades 0/);
});

test('the suggested role is the most demanding one that fits', () => {
  const rows = PM.recommendRoles([
    { charId: 1, charName: 'Mid', ccu: 1, ic: 2, free: 1, used: 2 },
    { charId: 2, charName: 'Top', ccu: 4, ic: 5, free: 0, used: 6 },
  ]);
  const by = Object.fromEntries(rows.map(r => [r.charName, r]));
  assert.strictEqual(by.Mid.best, 'refinery');
  assert.strictEqual(by.Top.best, 'hitech');
  assert.ok(by.Mid.canRun.includes('extraction'));
  assert.ok(!by.Mid.canRun.includes('reactor'), 'a Limited centre cannot hold a reactor line');
});

test('an unsynced character is reported as unknown, never as CCU 0', () => {
  // The two must not look alike: one needs a sync, the other needs a skill.
  const [row] = PM.recommendRoles([{ charId: 1, charName: 'Stale', ccu: null, ic: null }]);
  assert.strictEqual(row.known, false);
  assert.strictEqual(row.best, null);
  assert.match(row.note, /never synced/i);
});

// ─── allocation, not just capability ─────────────────────────────────────────

const alloc = (chars) => PM.assignRoles(PM.recommendRoles(chars));

test('the allocation follows the shape of a P4 chain', () => {
  // Past CCU 2 every character CAN hold everything, so "what can it hold" stops
  // discriminating and the table needs an actual allocation instead. The shape
  // is the real one: one high-tech planet fed by about three reactors.
  const rows = alloc([1, 2, 3, 4].map(i =>
    ({ charId: i, charName: `Alt ${i}`, ccu: 5, ic: 5, used: 0, free: 6 })));
  assert.strictEqual(rows.map(r => r.suggested).join(','),
                     'hitech,reactor,reactor,reactor');
});

test('the cycle restarts, so a big account gets a second chain', () => {
  const rows = alloc([1, 2, 3, 4, 5].map(i =>
    ({ charId: i, charName: `Alt ${i}`, ccu: 5, ic: 5, used: 0, free: 6 })));
  assert.strictEqual(rows[4].suggested, 'hitech', 'the fifth starts the next chain');
});

test('a character who cannot hold the demanding role keeps the one they can', () => {
  // A Limited command centre cannot carry a reactor line, so it is given the
  // best thing it CAN hold rather than an instruction it cannot follow...
  const rows = alloc([
    { charId: 1, charName: 'Strong', ccu: 5, ic: 5, used: 0, free: 6 },
    { charId: 2, charName: 'Weak',   ccu: 1, ic: 2, used: 0, free: 3 },
  ]);
  const by = Object.fromEntries(rows.map(r => [r.charName, r]));
  assert.strictEqual(by.Strong.suggested, 'hitech');
  assert.strictEqual(by.Weak.suggested, 'refinery');
});

test('a weak character does not consume a demanding slot in the chain', () => {
  // ...and crucially does not advance the cycle, or a single weak alt would
  // silently cost the chain one of its three reactor planets.
  const rows = alloc([
    { charId: 1, charName: 'A Strong', ccu: 5, ic: 5, used: 0, free: 6 },
    { charId: 2, charName: 'B Weak',   ccu: 1, ic: 5, used: 0, free: 6 },
    { charId: 3, charName: 'C Strong', ccu: 5, ic: 5, used: 0, free: 6 },
  ]);
  const by = Object.fromEntries(rows.map(r => [r.charName, r]));
  assert.strictEqual(by['A Strong'].suggested, 'hitech');
  assert.strictEqual(by['C Strong'].suggested, 'reactor', 'still the next link in the chain');
});

test('a full character is skipped rather than given work', () => {
  const rows = alloc([
    { charId: 1, charName: 'Full',  ccu: 5, ic: 5, used: 6, free: 0 },
    { charId: 2, charName: 'Roomy', ccu: 5, ic: 5, used: 0, free: 6 },
  ]);
  const by = Object.fromEntries(rows.map(r => [r.charName, r]));
  assert.strictEqual(by.Full.suggested, null);
  assert.match(by.Full.suggestedNote, /No free slots/);
  // The full character must not have eaten the high-tech slot on the way past.
  assert.strictEqual(by.Roomy.suggested, 'hitech');
});

test('a CCU-0 character is given no role at all', () => {
  const [row] = alloc([{ charId: 1, charName: 'Fresh', ccu: 0, ic: 5, used: 0, free: 6 }]);
  assert.strictEqual(row.suggested, null);
  assert.match(row.note, /Command Center Upgrades 0/);
});

// ─── planning against what already exists ────────────────────────────────────

const SCHEMATICS = [
  { schematicID: 1, schematicName: 'P1 A', cycleTime: 1800 },
  { schematicID: 2, schematicName: 'P1 B', cycleTime: 1800 },
  { schematicID: 3, schematicName: 'P2',   cycleTime: 3600 },
  { schematicID: 4, schematicName: 'P3',   cycleTime: 3600 },
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

test('with no surplus supplied the plan is unchanged', () => {
  const i = idx();
  const a = PM.planFor(400, 3, i);
  const b = PM.planFor(400, 3, i, new Map());
  assert.strictEqual(a.factories, b.factories);
  assert.strictEqual(a.raw.length, b.raw.length);
});

test('existing surplus is subtracted, and the saving cascades down the tree', () => {
  const i = idx();
  const from0 = PM.planFor(400, 3, i);
  // Already making 5/hr of the P2 and 40/hr of one P1.
  const delta = PM.planFor(400, 3, i, new Map([[300, 5], [200, 40]]));

  assert.ok(delta.factories < from0.factories, 'fewer factories to build');
  const p2 = delta.steps.find(s => s.id === 300);
  assert.strictEqual(p2.fromStock, 5, 'the P2 surplus is credited');
  // The point of cascading: a P2 you no longer build is also P1 you no longer
  // make and P0 you no longer extract.
  const raw0 = from0.raw.find(r => r.id === 100).perHour;
  const rawD = delta.raw.find(r => r.id === 100).perHour;
  assert.ok(rawD < raw0, 'raw extraction drops too');
});

test('a shortfall is not stock: a negative balance is ignored', () => {
  const i = idx();
  const plain = PM.planFor(400, 3, i);
  // tallyNetwork returns negatives for the things you are ALREADY short of.
  // Reading those as inventory would understate the build by exactly the amount
  // you are missing — the worst possible direction to be wrong in.
  const withNeg = PM.planFor(400, 3, i, new Map([[300, -5], [200, -100]]));
  assert.strictEqual(withNeg.factories, plain.factories);
});

test('surplus larger than the requirement zeroes a step without going negative', () => {
  const i = idx();
  const plan = PM.planFor(400, 3, i, new Map([[300, 10_000], [200, 10_000], [201, 10_000]]));
  const p2 = plan.steps.find(s => s.id === 300);
  assert.strictEqual(p2.factories, 0);
  assert.strictEqual(p2.wantPerHour, 0);
  assert.ok(plan.steps.every(s => s.factories >= 0));
  // Nothing below a fully covered step should still be demanded.
  assert.strictEqual(plan.raw.reduce((n, r) => n + r.perHour, 0), 0);
});
