'use strict';
//
// Fleet ops — the FC's record of an outing (Phase 1, TODO.md).
//
// The movement logic gets the most attention here, because it is the part that
// fails QUIETLY. A wrong roster row is visible the moment someone reads the
// report; a movement log that records a fleet bouncing between two systems four
// times while it was taking one gate looks plausible, and the only person who
// can tell it is wrong is the FC who was there — weeks later, writing an AAR.
//
// Everything touching the database runs against a real SQLite file. The queries
// ARE the feature; a mocked db.run would only assert that the mock was called.
const test    = require('node:test');
const assert  = require('node:assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const ops = require('../src/fleet_ops');

// A roster poll: `n` pilots in `sys`. Ship ids only matter where stated.
const at = (sys, n, startId = 1) =>
  Array.from({ length: n }, (_, i) => ({
    characterId: startId + i, shipTypeId: 640, solarSystemId: sys,
  }));

// ─── Where the fleet is ───────────────────────────────────────────────────────

test('the modal system is where most of the fleet is, not where the FC is', () => {
  // The FC (character 99) is alone in the next system over, scouting. The fleet
  // is not "in" that system just because the boss is.
  const members = [...at(30000142, 20), { characterId: 99, shipTypeId: 11202, solarSystemId: 30002187 }];
  const m = ops.modalSystem(members);
  assert.strictEqual(m.systemId, 30000142);
  assert.strictEqual(m.there, 20);
  assert.strictEqual(m.total, 21);
});

test('a tie breaks deterministically, or the debounce could never settle', () => {
  // An even split must not flap between polls. Lowest id wins — arbitrary, but
  // the same answer every time is the property that matters.
  const members = [...at(30000142, 5), ...at(30002187, 5, 100)];
  assert.strictEqual(ops.modalSystem(members).systemId, 30000142);
  assert.strictEqual(ops.modalSystem([...members].reverse()).systemId, 30000142,
    'the answer must not depend on member order');
});

test('pilots with no readable position are skipped, not counted', () => {
  const members = [...at(30000142, 3), { characterId: 50, shipTypeId: 640, solarSystemId: null }];
  const m = ops.modalSystem(members);
  assert.strictEqual(m.total, 3, 'total counts positions we actually have');
});

test('an empty or positionless roster is "no information", not a position', () => {
  // This is the dangerous one. If this returned a system, a fleet that briefly
  // read empty would be recorded as having moved somewhere.
  assert.strictEqual(ops.modalSystem([]), null);
  assert.strictEqual(ops.modalSystem(null), null);
  assert.strictEqual(ops.modalSystem([{ characterId: 1, shipTypeId: 640 }]), null);
});

// ─── The debounce ─────────────────────────────────────────────────────────────

test('the first position is committed immediately', () => {
  // Nothing to debounce against, and a log that starts three polls late claims
  // the fleet formed up somewhere it did not.
  const t = ops.createMovementTracker();
  const move = t.observe(at(30000142, 10));
  assert.ok(move, 'the opening position must be recorded at once');
  assert.strictEqual(move.solarSystemId, 30000142);
});

test('a fleet spread mid-warp does not register as moving', () => {
  // The measured shape of the problem: 40 pilots taking a gate are split across
  // two systems for several polls. Recording each flip would say the fleet
  // bounced back and forth, which is unreadable and untrue.
  const t = ops.createMovementTracker({ holdPolls: 3 });
  t.observe(at(30000142, 40));                       // formed up

  assert.strictEqual(t.observe([...at(30002187, 21), ...at(30000142, 19)]), null, 'poll 1 of the crossing');
  assert.strictEqual(t.observe([...at(30000142, 22), ...at(30002187, 18)]), null, 'it flips back');
  assert.strictEqual(t.observe([...at(30002187, 25), ...at(30000142, 15)]), null, 'and again');
  assert.strictEqual(t.currentSystem, 30000142, 'still recorded as where it started');
});

test('a real move is recorded once it holds', () => {
  const t = ops.createMovementTracker({ holdPolls: 3 });
  t.observe(at(30000142, 40));
  assert.strictEqual(t.observe(at(30002187, 40)), null, 'not yet — one poll');
  assert.strictEqual(t.observe(at(30002187, 40)), null, 'not yet — two polls');
  const move = t.observe(at(30002187, 40));
  assert.ok(move, 'three consecutive polls is a move');
  assert.strictEqual(move.solarSystemId, 30002187);
  assert.strictEqual(t.currentSystem, 30002187);
});

test('a half-formed move is abandoned if the fleet stays put', () => {
  const t = ops.createMovementTracker({ holdPolls: 3 });
  t.observe(at(30000142, 40));
  t.observe(at(30002187, 40));                        // streak 1
  t.observe(at(30002187, 40));                        // streak 2
  t.observe(at(30000142, 40));                        // back home — streak must reset
  assert.strictEqual(t.observe(at(30002187, 40)), null, 'the old streak must not carry over');
  assert.strictEqual(t.observe(at(30002187, 40)), null);
  assert.ok(t.observe(at(30002187, 40)), 'a fresh three-poll hold still counts');
});

test('a blank roster read never moves the fleet', () => {
  // The fleet endpoint can answer with nothing mid-reform. Holding the last
  // known position is right; recording "nowhere" is not.
  const t = ops.createMovementTracker({ holdPolls: 2 });
  t.observe(at(30000142, 40));
  assert.strictEqual(t.observe([]), null);
  assert.strictEqual(t.observe([]), null);
  assert.strictEqual(t.currentSystem, 30000142, 'position survives an empty read');
});

test('alternating systems never accumulate a streak', () => {
  const t = ops.createMovementTracker({ holdPolls: 3 });
  t.observe(at(30000142, 40));
  for (let i = 0; i < 6; i++) {
    assert.strictEqual(t.observe(at(i % 2 ? 30002187 : 30045321, 40)), null,
      'two systems trading the lead is not a move to either');
  }
});

// ─── Dwell ────────────────────────────────────────────────────────────────────

test('dwell is the gap to the next system, and the last one runs to the end', () => {
  const rows = [
    { at: 1000, solar_system_id: 1 },
    { at: 3000, solar_system_id: 2 },
    { at: 8000, solar_system_id: 3 },
  ];
  const out = ops.withDwell(rows, 10_000);
  assert.deepStrictEqual(out.map((r) => r.dwellMs), [2000, 5000, 2000]);
});

test('dwell sorts by time rather than trusting the caller', () => {
  const out = ops.withDwell([{ at: 3000, solar_system_id: 2 }, { at: 1000, solar_system_id: 1 }], 4000);
  assert.deepStrictEqual(out.map((r) => r.solar_system_id), [1, 2]);
  assert.deepStrictEqual(out.map((r) => r.dwellMs), [2000, 1000]);
});

// ─── Against a real database ──────────────────────────────────────────────────

let dir;
async function freshDb() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-fleetops-'));
  const db = await open({ filename: path.join(dir, 'test.db'), driver: sqlite3.Database });
  await ops.ensureFleetOpTables(db);
  return db;
}
const cleanup = (db) =>
  db.close().then(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

test('an op runs, ends once, and is found while open', async () => {
  const db = await freshDb();
  try {
    assert.strictEqual(await ops.openOp(db), null, 'nothing open to begin with');

    const opId = await ops.startOp(db, {
      name: 'Home Defence', doctrine: 'shield', bossCharacterId: 7, fleetId: 123, at: 1000 });
    const open = await ops.openOp(db);
    assert.strictEqual(open.op_id, opId);
    assert.strictEqual(open.name, 'Home Defence');

    await ops.endOp(db, opId, { at: 5000, reason: 'stopped' });
    assert.strictEqual(await ops.openOp(db), null, 'a closed op is not open');

    // A second stop must not move the end time — it would silently extend the op.
    await ops.endOp(db, opId, { at: 9000, reason: 'stopped again' });
    const { op } = await ops.getOp(db, opId);
    assert.strictEqual(op.ended_at, 5000, 'the first end time stands');
    assert.strictEqual(op.end_reason, 'stopped');
  } finally { await cleanup(db); }
});

test('a pilot who swaps hulls is recorded as both, not overwritten', async () => {
  const db = await freshDb();
  try {
    const opId = await ops.startOp(db, { name: 'Roam', bossCharacterId: 7, at: 0 });
    await ops.recordRoster(db, opId, [{ characterId: 1, shipTypeId: 640 }], 1000);
    await ops.recordRoster(db, opId, [{ characterId: 1, shipTypeId: 640 }], 2000);
    await ops.recordRoster(db, opId, [{ characterId: 1, shipTypeId: 11202 }], 3000);

    const { roster } = await ops.getOp(db, opId);
    assert.strictEqual(roster.length, 2, 'a refit is a second row, not a lost one');
    const first = roster.find((r) => r.ship_type_id === 640);
    assert.strictEqual(first.first_seen, 1000, 'first_seen must not drift forward');
    assert.strictEqual(first.last_seen, 2000, 'last_seen tracks the most recent sighting');
  } finally { await cleanup(db); }
});

test('joining late and leaving early are both visible', async () => {
  const db = await freshDb();
  try {
    const opId = await ops.startOp(db, { name: 'Roam', bossCharacterId: 7, at: 0 });
    await ops.recordRoster(db, opId, at(30000142, 2), 1000);            // pilots 1,2
    await ops.recordRoster(db, opId, at(30000142, 3), 2000);            // 3 joins
    await ops.recordRoster(db, opId, [{ characterId: 3, shipTypeId: 640 }], 3000);   // 1,2 leave

    const { roster } = await ops.getOp(db, opId);
    const byChar = Object.fromEntries(roster.map((r) => [r.character_id, r]));
    assert.strictEqual(byChar[1].last_seen, 2000, 'a pilot who left stops being seen');
    assert.strictEqual(byChar[3].first_seen, 2000, 'a late joiner is not backdated to form-up');
  } finally { await cleanup(db); }
});

test('an empty roster poll writes nothing rather than clearing the record', async () => {
  const db = await freshDb();
  try {
    const opId = await ops.startOp(db, { name: 'Roam', bossCharacterId: 7, at: 0 });
    await ops.recordRoster(db, opId, at(30000142, 3), 1000);
    assert.strictEqual(await ops.recordRoster(db, opId, [], 2000), 0);
    const { roster } = await ops.getOp(db, opId);
    assert.strictEqual(roster.length, 3, 'a blank read must not erase who was there');
  } finally { await cleanup(db); }
});

test('a whole op records end to end, with dwell', async () => {
  const db = await freshDb();
  try {
    const opId = await ops.startOp(db, { name: 'Rorqual Hunt', bossCharacterId: 7, at: 0 });
    const tracker = ops.createMovementTracker({ holdPolls: 2 });

    let clock = 0;
    for (const [sys, polls] of [[30000142, 3], [30002187, 4]]) {
      for (let i = 0; i < polls; i++) {
        clock += 6000;
        const members = at(sys, 10);
        await ops.recordRoster(db, opId, members, clock);
        const move = tracker.observe(members);
        if (move) await ops.recordMovement(db, opId, move, clock);
      }
    }
    await ops.endOp(db, opId, { at: clock });

    const { movement, roster } = await ops.getOp(db, opId);
    assert.strictEqual(movement.length, 2, 'two systems held, two entries');
    assert.strictEqual(movement[0].solar_system_id, 30000142);
    assert.strictEqual(movement[1].solar_system_id, 30002187);
    assert.strictEqual(movement[0].dwellMs, movement[1].at - movement[0].at);
    assert.strictEqual(roster.length, 10);
  } finally { await cleanup(db); }
});

test('ensure is idempotent and never drops recorded ops', async () => {
  // The failure this guards is specific and has already cost this project two
  // shipped upgrades: CREATE TABLE IF NOT EXISTS does nothing to an existing
  // table. asset_index answers a shape mismatch by DROPping, which is right for
  // a rebuildable cache and would be data loss here.
  const db = await freshDb();
  try {
    const opId = await ops.startOp(db, { name: 'Keep me', bossCharacterId: 7, at: 0 });
    await ops.recordRoster(db, opId, at(30000142, 4), 1000);

    await ops.ensureFleetOpTables(db);          // WeakSet short-circuits
    _forceReEnsure();
    await ops.ensureFleetOpTables(db);          // and again for real

    const { op, roster } = await ops.getOp(db, opId);
    assert.strictEqual(op.name, 'Keep me', 'the op survives a re-ensure');
    assert.strictEqual(roster.length, 4);
  } finally { await cleanup(db); }
});

// The module memoises per-connection with a WeakSet, so calling ensure twice on
// one handle proves nothing on its own. Reloading the module clears that memo
// and makes the second call actually execute against the existing tables.
function _forceReEnsure() {
  delete require.cache[require.resolve('../src/fleet_ops')];
  Object.assign(ops, require('../src/fleet_ops'));
}

test('ops are listed newest first, with pilot and system counts', async () => {
  const db = await freshDb();
  try {
    const a = await ops.startOp(db, { name: 'Older', bossCharacterId: 7, at: 1000 });
    await ops.recordRoster(db, a, at(30000142, 5), 1000);
    await ops.recordMovement(db, a, { solarSystemId: 30000142, membersThere: 5, membersTotal: 5 }, 1000);
    await ops.endOp(db, a, { at: 2000 });

    const b = await ops.startOp(db, { name: 'Newer', bossCharacterId: 7, at: 9000 });

    const list = await ops.listOps(db);
    assert.deepStrictEqual(list.map((o) => o.name), ['Newer', 'Older']);
    assert.strictEqual(list[1].pilots, 5);
    assert.strictEqual(list[1].systems, 1);
    assert.strictEqual(list[0].ended_at, null, 'the running op is still open');
    assert.strictEqual(b, list[0].op_id);
  } finally { await cleanup(db); }
});
