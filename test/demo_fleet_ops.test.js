'use strict';
//
// The demo profile's fleet ops (Op History on camera).
//
// Two things are worth asserting and neither is cosmetic. The ops must WRITE
// THROUGH src/fleet_ops.js rather than raw SQL, so a schema change carries them
// along instead of leaving the demo silently out of shape. And the pass-through
// systems must stay out of the movement narrative — that distinction is the
// whole point of the tool, so the footage has to actually show it.
const test    = require('node:test');
const assert  = require('node:assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const ops  = require('../src/fleet_ops');
const demo = require('../src/demo_data');

async function seeded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-demoops-'));
  const db  = await open({ filename: path.join(dir, 'demo.db'), driver: sqlite3.Database });
  await ops.ensureFleetOpTables(db);
  await demo.seedFleetOps(db, Date.parse('2026-08-19T12:00:00Z'));
  return { db, dir };
}
const drop = async ({ db, dir }) => {
  await db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
};

test('the demo profile seeds three closed ops', async () => {
  const h = await seeded();
  try {
    const list = await ops.listOps(h.db, 20);
    assert.strictEqual(list.length, 3);
    for (const o of list) assert.ok(o.ended_at, o.name + ' must be closed — a live op cannot be deleted or replayed');
    assert.deepStrictEqual(
      list.map((o) => o.name).sort(),
      ['Delve Roam', 'Home Defence', 'Ore Run — R64 Belt'],
    );
  } finally { await drop(h); }
});

test('the roam keeps pass-through systems out of the movement narrative', async () => {
  const h = await seeded();
  try {
    const roam = (await ops.listOps(h.db, 20)).find((o) => o.name === 'Delve Roam');
    const full = await ops.getOp(h.db, roam.op_id);
    const seen = await ops.getOpSystems(h.db, roam.op_id);

    assert.strictEqual(full.movement.length, 4, 'four systems were held');
    assert.strictEqual(seen.length, 6, 'six were seen');

    const held = new Set(full.movement.map((m) => m.solar_system_id));
    for (const s of [30004777, 30004751]) {          // ZXB-VC, K-6K16
      assert.ok(seen.some((x) => x.solar_system_id === s), s + ' should be in systems-seen');
      assert.ok(!held.has(s), s + ' was only passed through and must not be in the narrative');
    }
  } finally { await drop(h); }
});

test('a refit shows as a second roster row, and one op ends on a handover', async () => {
  const h = await seeded();
  try {
    const list = await ops.listOps(h.db, 20);
    const roam = list.find((o) => o.name === 'Delve Roam');
    const full = await ops.getOp(h.db, roam.op_id);

    const scout = full.roster.filter((r) => r.character_id === 2118400003);
    assert.strictEqual(scout.length, 2, 'the scout refitted, so it holds two hull rows');

    assert.strictEqual(list.find((o) => o.name === 'Home Defence').end_reason, 'boss-handover');
    assert.ok(Number(list.find((o) => o.name === 'Ore Run — R64 Belt').isk_mined) > 0, 'the ore run has yield');
  } finally { await drop(h); }
});
