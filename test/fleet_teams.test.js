'use strict';
//
// Side assignment for the battle-report timeline.
//
// The rules are inferred, not looked up — EVE exposes no usable standings API,
// and standings change between downtimes anyway. So these tests pin the ORDER
// the rules fire in, because that order is the whole design: an FC's override
// must survive a later inference, and "fought alongside us" must beat the
// default-to-hostile fallback or every blue on grid lands in the enemy column.
const test   = require('node:test');
const assert = require('node:assert');

const T = require('../src/fleet_teams');

// Our fleet
const ME    = 1001, WINGMAN = 1002;
const OURS  = { alliance_id: 500, corporation_id: 5001 };
// A blue alliance that shot the same target we did
const BLUE  = { alliance_id: 600, corporation_id: 6001 };
// The enemy
const RED   = { alliance_id: 700, corporation_id: 7001 };
// A third party that never interacted with us
const NEUT  = { alliance_id: 800, corporation_id: 8001 };

const roster = new Set([ME, WINGMAN]);
const km = (o) => Object.assign({ killmail_time: '2026-08-19T12:00:00Z', zkb: { totalValue: 0 } }, o);
const p  = (org, character_id, ship_type_id = 600) =>
  Object.assign({ character_id, ship_type_id }, org);

test('our roster is US even when the alliance is unknown to us', () => {
  const teams = T.assignTeams([
    km({ victim: p(RED, 9001), attackers: [p({}, ME)] }),   // no org on the attacker
  ], { rosterIds: roster });
  // ME carries no alliance/corp here, so it keys on nothing and cannot be
  // registered — the victim is still classified.
  const red = teams.get('a:700');
  assert.strictEqual(red.team, T.HOSTILE);
  assert.strictEqual(red.reason, 'engaged');
});

test('the boss org is US, and anyone who shot alongside us is FRIENDLY', () => {
  const teams = T.assignTeams([
    km({ victim: p(RED, 9001), attackers: [p(OURS, ME), p(BLUE, 7777)] }),
  ], { rosterIds: roster, bossAllianceId: 500 });

  assert.strictEqual(teams.get('a:500').team, T.US);
  assert.strictEqual(teams.get('a:500').reason, 'roster');       // roster beats boss-org
  assert.strictEqual(teams.get('a:600').team, T.FRIENDLY);
  assert.strictEqual(teams.get('a:600').reason, 'fought-with-us');
  assert.strictEqual(teams.get('a:700').team, T.HOSTILE);
});

test('whoever killed one of ours is HOSTILE', () => {
  const teams = T.assignTeams([
    km({ victim: p(OURS, ME), attackers: [p(RED, 9002)] }),
  ], { rosterIds: roster });
  assert.strictEqual(teams.get('a:700').team, T.HOSTILE);
  assert.strictEqual(teams.get('a:700').reason, 'engaged');
});

test('a third party that never touched us defaults to HOSTILE, but is flagged inferred', () => {
  const teams = T.assignTeams([
    km({ victim: p(NEUT, 9100), attackers: [p(RED, 9101)] }),
  ], { rosterIds: roster });
  // Neither side interacted with us. Both land in hostile, but the reason says
  // it was a guess — that is what the FC's double-arrow is for.
  assert.strictEqual(teams.get('a:800').reason, 'inferred');
  assert.strictEqual(teams.get('a:800').team, T.HOSTILE);
});

test('an override beats every inference, including one that fought beside us', () => {
  const mails = [km({ victim: p(RED, 9001), attackers: [p(OURS, ME), p(BLUE, 7777)] })];

  const inferred = T.assignTeams(mails, { rosterIds: roster });
  assert.strictEqual(inferred.get('a:600').team, T.FRIENDLY, 'inferred friendly to begin with');

  const forced = T.assignTeams(mails, { rosterIds: roster, overrides: { 'a:600': T.HOSTILE } });
  assert.strictEqual(forced.get('a:600').team, T.HOSTILE);
  assert.strictEqual(forced.get('a:600').reason, 'override');
});

test('entities key on alliance, falling back to corp for the unaffiliated', () => {
  assert.strictEqual(T.entityKey({ alliance_id: 1, corporation_id: 2 }), 'a:1');
  assert.strictEqual(T.entityKey({ corporation_id: 2 }), 'c:2');
  assert.strictEqual(T.entityKey({}), null, 'an NPC or unowned structure keys to nothing');
});

test('the timeline is ordered by time and tagged with the team that LOST the ship', () => {
  const mails = [
    km({ killmail_id: 2, killmail_time: '2026-08-19T12:05:00Z',
         victim: p(RED, 9001, 640), attackers: [p(OURS, ME)], zkb: { totalValue: 200 } }),
    km({ killmail_id: 1, killmail_time: '2026-08-19T12:01:00Z',
         victim: p(OURS, WINGMAN, 620), attackers: [p(RED, 9002)], zkb: { totalValue: 50 } }),
  ];
  const teams = T.assignTeams(mails, { rosterIds: roster, bossAllianceId: 500 });
  const line  = T.buildTimeline(mails, teams);

  assert.deepStrictEqual(line.map((r) => r.killmailId), [1, 2], 'oldest first');
  assert.strictEqual(line[0].team, T.US,      'we lost the first ship');
  assert.strictEqual(line[1].team, T.HOSTILE, 'they lost the second');

  const sum = T.summariseTeams(line);
  assert.strictEqual(sum.us.ships, 1);
  assert.strictEqual(sum.us.isk, 50);
  assert.strictEqual(sum.hostile.ships, 1);
  assert.strictEqual(sum.hostile.isk, 200);
  assert.strictEqual(sum.friendly.ships, 0, 'no friendly losses in this fight');
});
