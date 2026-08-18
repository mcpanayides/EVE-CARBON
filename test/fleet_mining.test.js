'use strict';
//
// The mining delta (Phase 3, TODO.md).
//
// `/characters/{id}/mining` is a DAILY RUNNING TOTAL with no timestamp, so the
// only way to score an op is to photograph the counter at the start and
// subtract. Everything that can go wrong with that is arithmetic that produces
// a plausible number: too high because pre-op mining leaked in, too low because
// a negative artefact cancelled a real gain, or right but presented as a fleet
// total when it only covers three of forty pilots.
const test   = require('node:test');
const assert = require('node:assert');

const fm = require('../src/fleet_mining');

const row = (date, sys, type, qty) =>
  ({ date, solar_system_id: sys, type_id: type, quantity: qty });

const VELD = 1230, SCORD = 1228;
const A = 30000142, B = 30002187;

test('an unchanged ledger means nothing was mined', () => {
  const led = [row('2026-08-17', A, VELD, 5000)];
  assert.deepStrictEqual(fm.computeDelta(led, led), []);
});

test('only what was added since the baseline counts', () => {
  // The pilot had already mined 5,000 Veldspar before form-up. Reporting the
  // running total would credit the fleet with somebody's afternoon.
  const before = [row('2026-08-17', A, VELD, 5000)];
  const after  = [row('2026-08-17', A, VELD, 12000)];
  assert.deepStrictEqual(fm.computeDelta(before, after),
    [{ solar_system_id: A, type_id: VELD, quantity: 7000 }]);
});

test('an ore type absent from the baseline is entirely new', () => {
  const out = fm.computeDelta([row('2026-08-17', A, VELD, 100)],
                              [row('2026-08-17', A, VELD, 100), row('2026-08-17', A, SCORD, 4000)]);
  assert.deepStrictEqual(out, [{ solar_system_id: A, type_id: SCORD, quantity: 4000 }]);
});

test('an op crossing downtime still totals correctly', () => {
  // The ledger keys by DATE, so a fleet running through 00:00 gets a fresh row
  // with a new date. Both days belong to the same op.
  const before = [row('2026-08-17', A, VELD, 9000)];
  const after  = [row('2026-08-17', A, VELD, 11000), row('2026-08-18', A, VELD, 3000)];
  assert.deepStrictEqual(fm.computeDelta(before, after),
    [{ solar_system_id: A, type_id: VELD, quantity: 5000 }], '2000 on day one plus 3000 on day two');
});

test('a negative delta is dropped, never subtracted', () => {
  // A running total should not fall. When it does — the 30-day window rolled, or
  // the baseline came from staler data — letting it offset a real gain elsewhere
  // would silently under-report the op.
  const before = [row('2026-08-17', A, VELD, 9000), row('2026-08-17', B, SCORD, 5000)];
  const after  = [row('2026-08-17', A, VELD, 1000), row('2026-08-17', B, SCORD, 8000)];
  assert.deepStrictEqual(fm.computeDelta(before, after),
    [{ solar_system_id: B, type_id: SCORD, quantity: 3000 }], 'the real 3000 gain survives intact');
});

test('the same ore in two systems stays separated', () => {
  const out = fm.computeDelta([], [row('2026-08-17', A, VELD, 100), row('2026-08-17', B, VELD, 400)]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].quantity, 400, 'biggest first');
});

test('running the pull twice corrects rather than doubles', () => {
  // The ledger is up to an hour behind, so an FC will re-run this. Both runs
  // measure from the SAME baseline, so the second simply supersedes the first.
  const before = [row('2026-08-17', A, VELD, 1000)];
  const firstPull  = fm.computeDelta(before, [row('2026-08-17', A, VELD, 3000)]);
  const secondPull = fm.computeDelta(before, [row('2026-08-17', A, VELD, 5000)]);
  assert.strictEqual(firstPull[0].quantity, 2000);
  assert.strictEqual(secondPull[0].quantity, 4000, 'total since baseline, not 4000 on top of 2000');
});

test('mining outside the fleet\'s systems is excluded', () => {
  // An alt ratting a belt at home all evening must not land in the fleet total.
  const rows = [{ solar_system_id: A, type_id: VELD, quantity: 100 },
                { solar_system_id: 30099999, type_id: VELD, quantity: 999999 }];
  const out = fm.restrictToSystems(rows, new Set([A, B]));
  assert.deepStrictEqual(out.map((r) => r.solar_system_id), [A]);
});

test('with no system list nothing is filtered out', () => {
  const rows = [{ solar_system_id: A, type_id: VELD, quantity: 100 }];
  assert.strictEqual(fm.restrictToSystems(rows, new Set()).length, 1);
});

test('unpriced ore leaves isk null rather than zero', () => {
  // Zero would sum into a total and quietly understate the haul.
  const out = fm.priceRows([{ solar_system_id: A, type_id: VELD, quantity: 100 },
                            { solar_system_id: A, type_id: SCORD, quantity: 50 }],
                           new Map([[VELD, 10]]));
  assert.strictEqual(out[0].isk, 1000);
  assert.strictEqual(out[1].isk, null);
});

test('a partly-priced haul is flagged as a floor', () => {
  const s = fm.summarise([{ solar_system_id: A, type_id: VELD, quantity: 100, isk: 1000 },
                          { solar_system_id: A, type_id: SCORD, quantity: 50, isk: null }]);
  assert.strictEqual(s.units, 150);
  assert.strictEqual(s.isk, 1000);
  assert.strictEqual(s.fullyPriced, false, 'the report must be able to say the ISK is a floor');
});

test('coverage is carried so a total is never read as the whole fleet', () => {
  // The number most likely to be misread. 41 pilots mined; we can see 3.
  const s = fm.summarise([{ solar_system_id: A, type_id: VELD, quantity: 100, isk: 1 }],
                         { pilotsInFleet: 41, pilotsMeasured: 3 });
  assert.deepStrictEqual(s.coverage, { pilotsInFleet: 41, pilotsMeasured: 3 });
});

test('an empty haul has a null ISK, not zero', () => {
  const s = fm.summarise([]);
  assert.strictEqual(s.units, 0);
  assert.strictEqual(s.isk, null, 'nothing mined is not "worth 0 ISK"');
});
