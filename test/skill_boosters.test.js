'use strict';
//
// The accelerators the skill planner's boosters table can offer.
//
// The rows here are the SDE's own values for each kind. The Serenity festival
// accelerators carry a "bonus" of 2021 and last 20 minutes; they won the table
// as strongest and printed "+2026 · NaN × 0h". Expired ones can still have a
// price, and one won as fastest.
const test   = require('node:test');
const assert = require('node:assert');
const { usableAccelerators } = require('../src/ipc/esi_ipc')._boosters;

const DAY = 86400000;
const ROWS = [
  { id: 57301, name: 'Serenity Spring Festival Cerebral Accelerator VI', bonus: 2021, durMs: 1_260_000, lastDay: 18717.67 },
  { id: 47481, name: 'Expired CDIA SPACE Cerebral Accelerator', bonus: 12, durMs: 259_200_000, lastDay: 17652.46 },
  { id: 96544, name: "Extended 'Radiance' Cerebral Accelerator", bonus: 6, durMs: 259_200_000, lastDay: 20767.46 },
  { id: 9947,  name: 'Expert Cerebral Accelerator', bonus: 8, durMs: 1_080_000_000, lastDay: null },
  { id: 10144, name: 'Standard Cerebral Accelerator', bonus: 5, durMs: 1_000_000, lastDay: null },
];

test('drops expired accelerators, festival data and anything under an hour', () => {
  const now = Date.UTC(2026, 10, 3);
  const got = usableAccelerators(ROWS, now);
  assert.deepStrictEqual(got.map(a => a.name), ["Extended 'Radiance' Cerebral Accelerator", 'Expert Cerebral Accelerator']);
  assert.deepStrictEqual(got.map(a => a.durationHours), [72, 300]);
});

test('an accelerator goes once its last injection date has passed', () => {
  // Attribute 2422 is days since 1970: 20767.46 is the 10th of November 2026.
  const after = 20767.46 * DAY + DAY;
  assert.deepStrictEqual(usableAccelerators(ROWS, after).map(a => a.id), [9947]);
});

test('every accelerator offered has a whole number of hours to divide by', () => {
  for (const a of usableAccelerators(ROWS, Date.UTC(2026, 10, 3))) {
    assert.ok(Number.isFinite(a.durationHours) && a.durationHours >= 1, a.name);
  }
});
