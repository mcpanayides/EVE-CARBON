'use strict';
//
// The kill pull — what the fleet killed and what it lost (Phase 2, TODO.md).
//
// The fixtures here use the shape of a REAL zKillboard response, captured from
// the live API on 2026-08-17 (system 30000142, pastSeconds 3600). Inventing a
// plausible shape is how you end up with a parser that works perfectly against
// your own imagination — the live stream in this project already shipped a
// version that looked only for `killmail` when R2Z2 had moved the body under
// `esi`, and it reported itself healthy while discarding every kill.
//
// Two failure modes get the most attention, because both are silent:
//   • counting a friendly-fire loss as a kill, which makes a fleet look BETTER
//     the more of its own it shoots;
//   • returning an empty result when we could not look, which prints as
//     "0 kills" in a report and reads as a quiet fleet rather than a broken one.
const test   = require('node:test');
const assert = require('node:assert');

const fk = require('../src/fleet_kills');

const T0 = Date.parse('2026-08-17T20:00:00Z');   // op start
const T1 = Date.parse('2026-08-17T23:00:00Z');   // op end
const WINDOW = { startedAt: T0, endedAt: T1 };

// Shaped exactly like the probed live response.
function km({ id = 1, time = '2026-08-17T21:00:00Z', system = 30000142,
              victim = 90013324, attackers = [2121724392], value = 152698263.68,
              npc = false } = {}) {
  return {
    killmail_id: id,
    killmail_time: time,
    solar_system_id: system,
    attackers: attackers.map((cid, i) => ({
      character_id: cid, corporation_id: 98513466, alliance_id: 99010089,
      damage_done: 1005, final_blow: i === 0, ship_type_id: 629, weapon_type_id: 2969,
    })),
    victim: {
      character_id: victim, corporation_id: 98381626, alliance_id: 99005338,
      damage_taken: 1005, ship_type_id: 3532, items: [], position: { x: 0, y: 0, z: 0 },
    },
    zkb: { hash: 'abc123', totalValue: value, destroyedValue: value, droppedValue: 0,
           points: 1, npc, solo: true, awox: false, labels: [] },
  };
}

// ─── pastSeconds ──────────────────────────────────────────────────────────────

test('pastSeconds rounds UP to the next hour', () => {
  // An op that ran 3h10m needs 4 hours of history. Asking for 3 would miss the
  // form-up, which is exactly where the first tackle tends to die.
  const start = Date.now() - (3 * 3600 + 600) * 1000;
  assert.strictEqual(fk.pastSecondsFor(start, Date.now()), 4 * 3600);
});

test('pastSeconds is always a multiple of 3600 — their API rejects anything else', () => {
  for (const mins of [1, 7, 59, 61, 179, 181, 1441]) {
    const v = fk.pastSecondsFor(Date.now() - mins * 60_000, Date.now());
    assert.strictEqual(v % 3600, 0, `${mins} minutes gave ${v}`);
    assert.ok(v >= 3600, 'never below the one-hour floor');
  }
});

test('an op older than 7 days cannot be pulled at all', () => {
  // Their documented ceiling. Returning a too-large value would just 400.
  assert.strictEqual(fk.pastSecondsFor(Date.now() - 8 * 86400_000, Date.now()), null);
  assert.ok(fk.pastSecondsFor(Date.now() - 6.9 * 86400_000, Date.now()) <= 604800);
});

test('the URL carries two modifiers, which their API requires', () => {
  assert.strictEqual(fk.systemUrl(30000142, 7200),
    'https://zkillboard.com/api/systemID/30000142/pastSeconds/7200/');
  assert.strictEqual(fk.systemUrl(30000142, 7200, 3),
    'https://zkillboard.com/api/systemID/30000142/pastSeconds/7200/page/3/');
});

// ─── Whose kill is it ─────────────────────────────────────────────────────────

const ROSTER = new Set([1001, 1002, 1003]);

test('an attacker in the roster makes it our kill', () => {
  const r = fk.classifyKillmail(km({ attackers: [1001, 55555], victim: 90013324 }), ROSTER, WINDOW);
  assert.strictEqual(r.side, 'kill');
  assert.strictEqual(r.involved, 1, 'one of ours was on the mail');
  assert.strictEqual(r.isk, 152698263.68, 'ISK comes from zkb, not from us');
  assert.strictEqual(r.finalBlowCharacterId, 1001);
});

test('a victim in the roster makes it our loss', () => {
  const r = fk.classifyKillmail(km({ attackers: [55555], victim: 1002 }), ROSTER, WINDOW);
  assert.strictEqual(r.side, 'loss');
  assert.strictEqual(r.victimCharacterId, 1002);
});

test('OURS ON BOTH SIDES IS A LOSS, NEVER A KILL', () => {
  // The one that flatters. Friendly fire — an awox, a smartbomb, a mistake — has
  // one of ours as victim AND attackers. Scored as a kill, a fleet would look
  // more successful the more of its own members it shot.
  const r = fk.classifyKillmail(km({ attackers: [1001, 1003], victim: 1002 }), ROSTER, WINDOW);
  assert.strictEqual(r.side, 'loss');
  assert.strictEqual(r.involved, 2, 'and the friendly fire is still visible');
});

test("somebody else's fight is not ours", () => {
  assert.strictEqual(fk.classifyKillmail(km({ attackers: [7], victim: 8 }), ROSTER, WINDOW), null);
});

test('kills outside the op window are excluded at both ends', () => {
  assert.strictEqual(fk.classifyKillmail(km({ time: '2026-08-17T19:59:59Z', attackers: [1001] }), ROSTER, WINDOW), null,
    'before form-up — the system is busy all day, that is not our fleet');
  assert.strictEqual(fk.classifyKillmail(km({ time: '2026-08-17T23:00:01Z', attackers: [1001] }), ROSTER, WINDOW), null,
    'after stand-down');
  assert.ok(fk.classifyKillmail(km({ time: '2026-08-17T20:00:00Z', attackers: [1001] }), ROSTER, WINDOW),
    'the boundary itself is inside the op');
});

test('malformed mails are dropped rather than thrown on', () => {
  for (const bad of [null, {}, { killmail_id: 5 }, { killmail_id: 5, killmail_time: 'nonsense' }]) {
    assert.strictEqual(fk.classifyKillmail(bad, ROSTER, WINDOW), null, JSON.stringify(bad));
  }
});

test('an NPC kill is flagged but still counted as a loss', () => {
  // Losing a ratting Rorqual to NPCs during a mining op is a real loss and the
  // report should say so — but an AAR reader needs to know nobody shot it.
  const r = fk.classifyKillmail(km({ attackers: [55555], victim: 1001, npc: true }), ROSTER, WINDOW);
  assert.strictEqual(r.side, 'loss');
  assert.strictEqual(r.npc, true);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

test('the summary is what an AAR opens with', () => {
  const rows = [
    { side: 'kill', isk: 2_000_000_000 },
    { side: 'kill', isk: 100_000_000 },
    { side: 'loss', isk: 300_000_000 },
  ];
  const s = fk.summarise(rows);
  assert.strictEqual(s.kills, 2);
  assert.strictEqual(s.losses, 1);
  assert.strictEqual(s.iskDestroyed, 2_100_000_000);
  assert.strictEqual(s.iskLost, 300_000_000);
  assert.ok(Math.abs(s.efficiency - 0.875) < 1e-9);
});

test('efficiency on a fleet that neither killed nor lost is null, not zero', () => {
  // 0% efficiency reads as "we got slaughtered". No engagement is not a defeat.
  assert.strictEqual(fk.summarise([]).efficiency, null);
});

// ─── The pull ─────────────────────────────────────────────────────────────────

const SYSTEMS = [{ solar_system_id: 30000142 }, { solar_system_id: 30002187 }];

test('every system the fleet was seen in is searched', async () => {
  const asked = [];
  const httpGet = async (url) => { asked.push(url); return []; };
  const out = await fk.pullOpKills({ systems: SYSTEMS, rosterIds: ROSTER,
    startedAt: T0, endedAt: T1, httpGet, now: T1 });
  assert.strictEqual(asked.length, 2);
  assert.strictEqual(out.systemsSearched, 2);
  assert.ok(asked[0].includes('systemID/30000142'));
});

test('the same killmail surfacing twice is only counted once', async () => {
  const httpGet = async () => [km({ id: 999, attackers: [1001] })];
  const out = await fk.pullOpKills({ systems: SYSTEMS, rosterIds: ROSTER,
    startedAt: T0, endedAt: T1, httpGet, now: T1 });
  assert.strictEqual(out.rows.length, 1, 'two systems returned it; it is one kill');
});

test('one unreachable system does not lose the others', async () => {
  const httpGet = async (url) => {
    if (url.includes('30000142')) throw new Error('HTTP 503');
    return [km({ id: 7, attackers: [1001] })];
  };
  const out = await fk.pullOpKills({ systems: SYSTEMS, rosterIds: ROSTER,
    startedAt: T0, endedAt: T1, httpGet, now: T1 });
  assert.strictEqual(out.rows.length, 1, 'the reachable system still reported');
  assert.strictEqual(out.failed.length, 1, 'and the failure is recorded, not swallowed');
  assert.strictEqual(out.failed[0].systemId, 30000142);
});

test('hitting the page ceiling is reported, never silently truncated', async () => {
  // A report that quietly drops kills is worse than one that says it is
  // incomplete: nobody can tell the difference between a quiet fleet and a
  // broken pull.
  const full = Array.from({ length: fk.PAGE_SIZE }, (_, i) => km({ id: i + 1, attackers: [1001] }));
  const httpGet = async () => full;
  const out = await fk.pullOpKills({ systems: [{ solar_system_id: 30000142 }], rosterIds: ROSTER,
    startedAt: T0, endedAt: T1, httpGet, now: T1 });
  assert.deepStrictEqual(out.truncated, [30000142]);
});

test('paging stops as soon as a short page arrives', async () => {
  let calls = 0;
  const httpGet = async () => { calls++; return [km({ id: calls, attackers: [1001] })]; };
  await fk.pullOpKills({ systems: [{ solar_system_id: 30000142 }], rosterIds: ROSTER,
    startedAt: T0, endedAt: T1, httpGet, now: T1 });
  assert.strictEqual(calls, 1, 'one short page means there is no page 2 to ask for');
});

test('an op too old to search says so instead of reporting zero kills', async () => {
  let called = false;
  const httpGet = async () => { called = true; return []; };
  const out = await fk.pullOpKills({ systems: SYSTEMS, rosterIds: ROSTER,
    startedAt: Date.now() - 9 * 86400_000, endedAt: Date.now(), httpGet });
  assert.strictEqual(called, false, 'no point asking for a window they cannot serve');
  assert.ok(out.reason && /7 days/.test(out.reason), 'the reason must reach the user');
  assert.strictEqual(out.rows.length, 0);
});

test('results come back in time order for the timeline', async () => {
  const httpGet = async () => [
    km({ id: 3, time: '2026-08-17T22:00:00Z', attackers: [1001] }),
    km({ id: 1, time: '2026-08-17T20:30:00Z', attackers: [1001] }),
    km({ id: 2, time: '2026-08-17T21:00:00Z', victim: 1002, attackers: [9] }),
  ];
  const out = await fk.pullOpKills({ systems: [{ solar_system_id: 30000142 }], rosterIds: ROSTER,
    startedAt: T0, endedAt: T1, httpGet, now: T1 });
  assert.deepStrictEqual(out.rows.map((r) => r.killmailId), [1, 2, 3]);
  assert.deepStrictEqual(out.rows.map((r) => r.side), ['kill', 'loss', 'kill']);
});
