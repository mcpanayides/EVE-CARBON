'use strict';
//
// The intel early-warning engine.
//
// Every fixture line here is REAL — copied from east.imperium and
// fareast.imperium logs. The failure mode this guards against isn't a crash,
// it's a bad alert: a mining fleet pulled off grid for nothing learns to ignore
// the warning, and then it isn't there when it matters.
const test   = require('node:test');
const assert = require('node:assert');
const { buildSystemIndex } = require('../src/intel/system_index');
const { createChannelParser, parseLine } = require('../src/intel/intel_parser');
const { buildAdjacency, jumpDistances, createProximityTracker, shouldAlert } = require('../src/intel/proximity');

// A slice of Insmother/Detorid plus the decoys that broke earlier versions.
const SYSTEMS = [
  { id: 1, name: 'EKPB-3',  regionName: 'Insmother' },
  { id: 2, name: '5M2-KP',  regionName: 'Insmother' },
  { id: 3, name: 'TK-DLH',  regionName: 'Insmother' },
  { id: 4, name: 'AGCP-I',  regionName: 'Insmother' },
  { id: 5, name: 'YPW-M4',  regionName: 'Detorid'   },
  { id: 6, name: 'A-REKV',  regionName: 'Detorid'   },   // "are" used to match this
  { id: 7, name: 'Gateway', regionName: 'Genesis'   },   // "gate" used to match this
  { id: 8, name: 'Naga',    regionName: 'Detorid'   },   // also a ship hull
  { id: 9, name: 'UALX-3',  regionName: 'Tenerifis' },
];
const SHIPS = ['Naga', 'Thorax', 'Myrmidon', 'Sabre', 'Stiletto', 'Cheetah', 'Buzzard', 'Loki'];
const REGIONS = ['Insmother', 'Detorid'];

const idx = buildSystemIndex(SYSTEMS, SHIPS);
const mk  = () => createChannelParser(idx, { regions: REGIONS, channel: 'test.imperium' });
const line = (ts, author, body) => `[ ${ts} ] ${author} > ${body}`;

// ── System matching ───────────────────────────────────────────────────────────

test('exact system names resolve', () => {
  assert.strictEqual(idx.matchToken('EKPB-3').system.name, 'EKPB-3');
  assert.strictEqual(idx.matchToken('ekpb-3').system.name, 'EKPB-3', 'case-insensitive');
  assert.strictEqual(idx.matchToken('5M2-KP,').system.name, '5M2-KP', 'trailing punctuation stripped');
  assert.strictEqual(idx.matchToken('(X1-IZ0)'), null, 'unknown system is not invented');
});

test('English words never resolve to systems', () => {
  // "are" -> A-REKV was a real false positive from the first cut. Each of these
  // would have fired an alert on ordinary chatter.
  for (const word of ['are', 'the', 'and', 'gate', 'new', 'to', 'is', 'on', 'in']) {
    assert.strictEqual(idx.matchToken(word, { regions: REGIONS }), null, `"${word}" must not resolve`);
  }
});

test('ship names never resolve to systems', () => {
  for (const ship of ['thorax', 'sabre', 'stiletto', 'buzzard', 'loki']) {
    assert.strictEqual(idx.matchToken(ship, { regions: REGIONS }), null, `"${ship}" must not resolve`);
  }
});

test('a name that is both ship and system is only used when nothing else fits', () => {
  // "Naga" is the one collision in the SDE. Reading it as a system on every
  // ship report would alert on a system nobody mentioned.
  const solo = idx.matchMessage('Naga', { regions: REGIONS });
  assert.strictEqual(solo.length, 1, 'alone, it is at least a candidate');
  const withOther = idx.matchMessage('EKPB-3  Naga', { regions: REGIONS });
  assert.deepStrictEqual(withOther.map(m => m.system.name), ['EKPB-3'],
    'alongside a real system it is read as the hull');
});

test('abbreviations resolve only inside the channel regions, and only when unique', () => {
  assert.strictEqual(idx.matchToken('ualx', { regions: REGIONS }), null,
    'UALX-3 is in Tenerifis, which this channel does not cover');
  assert.strictEqual(idx.matchToken('ualx', { regions: ['Tenerifis'] })?.system.name, 'UALX-3');
  assert.strictEqual(idx.matchToken('ekpb', { regions: REGIONS }).system.name, 'EKPB-3');
  assert.strictEqual(idx.matchToken('ekpb', { regions: REGIONS }).confidence, 'abbrev');
});

// ── Parsing ───────────────────────────────────────────────────────────────────

test('parses EVE\'s chat-log line format', () => {
  const p = parseLine('[ 2026.08.01 18:00:54 ] Marvin Outamon > 5M2-KP +4 1 Thorax');
  assert.strictEqual(p.author, 'Marvin Outamon');
  assert.strictEqual(p.body, '5M2-KP +4 1 Thorax');
  assert.strictEqual(new Date(p.ts).toISOString(), '2026-08-01T18:00:54.000Z', 'logs are UTC');
  // Each line in a real log carries its own BOM.
  assert.ok(parseLine('﻿[ 2026.08.01 18:00:54 ] X > EKPB-3'), 'per-line BOM must be tolerated');
});

test('clears RETRACT rather than alerting', () => {
  // "clr" (1271x) and "nv" (1089x) are the 1st and 2nd most common intel tokens.
  // Treating either as a sighting would alert on systems just declared empty.
  for (const body of ['YPW-M4 clr', 'EKPB-3 clear', '5M2-KP nv', 'TK-DLH no visual']) {
    const r = mk().ingest(line('2026.08.01 18:00:00', 'Scout', body));
    assert.strictEqual(r.status, 'clear', `"${body}" must parse as a clear`);
  }
  const hostile = mk().ingest(line('2026.08.01 18:00:00', 'Scout', '5M2-KP +4 1 Thorax'));
  assert.strictEqual(hostile.status, 'hostile');
  assert.strictEqual(hostile.count, 4, '+N is the hostile count');
});

test('a bare ship tally is not read as a hostile count', () => {
  // "1 Thorax 4 Myrmydons" is four ships, not "+1".
  const r = mk().ingest(line('2026.08.01 18:00:00', 'Scout', '5M2-KP 1 Thorax 4 Myrmidons'));
  assert.strictEqual(r.count, null, 'only an explicit +N counts');
});

test('follow-ups inherit the reporter\'s last system', () => {
  // Straight from the corpus: Marvin Outamon names 5M2-KP, then posts ship
  // detail 5 minutes later with no system.
  const p = mk();
  const first = p.ingest(line('2026.08.01 18:02:17', 'Marvin Outamon', '5M2-KP +4 - 1 Thorax 3 Myrmidons'));
  assert.strictEqual(first.systemName, '5M2-KP');
  const followUp = p.ingest(line('2026.08.01 18:04:09', 'Marvin Outamon', '3 Myrmidon 1 thorax'));
  assert.strictEqual(followUp.systemName, '5M2-KP', 'inherits the system');
  assert.strictEqual(followUp.inherited, true);
  // But not forever, and not from someone else.
  const stale = p.ingest(line('2026.08.01 18:30:00', 'Marvin Outamon', 'still there'));
  assert.strictEqual(stale, null, 'context expires');
  assert.strictEqual(p.ingest(line('2026.08.01 18:02:30', 'Someone Else', 'ok')), null,
    'context is per-author');
});

test('pilot names split on double spaces, not single', () => {
  // Reporters separate names with 2+ spaces. Splitting on one space merged
  // neighbours into "Everett Rockefeller  Wilfred" — a pilot who never existed.
  const r = mk().ingest(line('2026.08.01 18:05:23', 'Livka', 'EKPB-3  Cormack Eto  KRISDOX  Tobias Za'));
  assert.deepStrictEqual(r.pilots, ['Cormack Eto', 'KRISDOX', 'Tobias Za']);
  assert.ok(!r.pilots.includes('EKPB-3'), 'the system is not a pilot');
});

test('hull names attached to a pilot are stripped from the name', () => {
  const r = mk().ingest(line('2026.08.01 18:06:01', 'Kylrik', 'TK-DLH  Mae Aivo thorax'));
  assert.deepStrictEqual(r.pilots, ['Mae Aivo']);
  assert.deepStrictEqual(r.ships, ['thorax']);
});

test('word order is free — the system can come last', () => {
  const r = mk().ingest(line('2026.08.01 18:06:20', 'Chantelle', 'Mae Aivo  TK-DLH jumped through ekpb'));
  assert.strictEqual(r.systemName, 'TK-DLH');
  assert.ok(r.allSystemIds.includes(1), 'the second system (ekpb) is recorded too');
});

// ── Proximity ─────────────────────────────────────────────────────────────────

// A chain: EKPB-3 - AGCP-I - 5M2-KP - TK-DLH - YPW-M4
const ADJ = buildAdjacency([
  { from: 1, to: 4 }, { from: 4, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 5 },
]);

test('jump distances are breadth-first over the gate graph', () => {
  const d = jumpDistances(ADJ, 1);
  assert.strictEqual(d.get(1), 0);
  assert.strictEqual(d.get(4), 1);
  assert.strictEqual(d.get(2), 2);
  assert.strictEqual(d.get(5), 4);
  assert.strictEqual(d.get(9), undefined, 'unreachable systems are absent, not Infinity');
  assert.strictEqual(jumpDistances(ADJ, 1, 2).get(5), undefined, 'maxJumps bounds the search');
});

test('a contact seen once is never called inbound', () => {
  // One sighting says where something IS, never which way it is pointed.
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  const [t] = tr.ingest({ systemId: 3, systemName: 'TK-DLH', status: 'hostile', pilots: ['Solo Roamer'], ts: 0 });
  assert.strictEqual(t.jumps, 3);
  assert.strictEqual(t.inbound, false);
  assert.strictEqual(t.closing, 0);
});

test('a pilot tracked across systems yields closing and an ETA', () => {
  // The measurement that matters: this is Abyssal Triglav in the real corpus,
  // 11 jumps closed at 1.3 j/min. Keying tracks by SYSTEM cannot express this
  // at all — A -> B -> C becomes three unrelated one-sighting tracks.
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  const M = 60000;
  tr.ingest({ systemId: 5, systemName: 'YPW-M4', status: 'hostile', pilots: ['Abyssal Triglav'], ts: 0 });
  tr.ingest({ systemId: 3, systemName: 'TK-DLH', status: 'hostile', pilots: ['Abyssal Triglav'], ts: 2 * M });
  const out = tr.ingest({ systemId: 2, systemName: '5M2-KP', status: 'hostile', pilots: ['Abyssal Triglav'], ts: 3 * M });

  const pilot = out.find(t => t.kind === 'pilot');
  assert.strictEqual(pilot.label, 'Abyssal Triglav');
  assert.strictEqual(pilot.jumps, 2, 'now 2 jumps out');
  assert.strictEqual(pilot.closing, 2, 'closed 2 jumps since first seen');
  assert.strictEqual(pilot.inbound, true);
  assert.ok(pilot.etaSeconds > 0 && pilot.etaSeconds < 300, `implausible ETA: ${pilot.etaSeconds}s`);
  assert.deepStrictEqual(pilot.path, ['YPW-M4', 'TK-DLH', '5M2-KP']);
});

test('a system clear does not erase the gang that left it', () => {
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  tr.ingest({ systemId: 2, systemName: '5M2-KP', status: 'hostile', pilots: ['Mae Aivo'], ts: 0 });
  tr.ingest({ systemId: 2, systemName: '5M2-KP', status: 'clear', pilots: [], ts: 60000 });
  const live = tr.active(60000);
  assert.ok(live.some(t => t.kind === 'pilot' && t.label === 'Mae Aivo'),
    'the pilot track survives — an empty system says nothing about where they went');
  assert.ok(!live.some(t => t.kind === 'system' && t.systemName === '5M2-KP'),
    'the system-level report is retracted');
});

test('duplicate reports of one contact do not fabricate movement', () => {
  // The same sighting echoed by six people in the same second is one contact,
  // not a gang sprinting toward us.
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  for (let i = 0; i < 6; i++) {
    tr.ingest({ systemId: 4, systemName: 'AGCP-I', status: 'hostile', pilots: ['Echo Pilot'], ts: i * 1000 });
  }
  const pilot = tr.active(6000).find(t => t.kind === 'pilot');
  assert.strictEqual(pilot.sightings, 1, 'echoes within the debounce collapse to one');
  assert.strictEqual(pilot.inbound, false);
});

test('alerts fire on proximity OR on a fast approach from further out', () => {
  const near   = { jumps: 3, inbound: false, etaSeconds: 999 };
  const closer = { jumps: 1, inbound: false, etaSeconds: 999 };
  const far    = { jumps: 9, inbound: true,  etaSeconds: 90  };
  const idle   = { jumps: 9, inbound: false, etaSeconds: 900 };

  assert.strictEqual(shouldAlert(near,   { alertJumps: 5 }).level, 'warning');
  assert.strictEqual(shouldAlert(closer, { alertJumps: 5 }).level, 'critical');
  // The case a fixed radius misses entirely: outside the ring, but arriving
  // sooner than something sitting inside it.
  assert.strictEqual(shouldAlert(far, { alertJumps: 5, etaSeconds: 120 }).reason, 'closing');
  assert.strictEqual(shouldAlert(idle, { alertJumps: 5, etaSeconds: 120 }), null, 'ratters are not alerts');
});

test('inbound contacts outrank nearer static ones', () => {
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  const M = 60000;
  tr.ingest({ systemId: 4, systemName: 'AGCP-I', status: 'hostile', pilots: ['Parked Ratter'], ts: 0 });
  tr.ingest({ systemId: 5, systemName: 'YPW-M4', status: 'hostile', pilots: ['Incoming Gang'], ts: 0 });
  tr.ingest({ systemId: 3, systemName: 'TK-DLH', status: 'hostile', pilots: ['Incoming Gang'], ts: M });
  tr.ingest({ systemId: 2, systemName: '5M2-KP', status: 'hostile', pilots: ['Incoming Gang'], ts: 2 * M });

  const top = tr.active(2 * M)[0];
  assert.strictEqual(top.label, 'Incoming Gang',
    'something closing from 2 jumps beats something parked at 1');
});

// ── Monitoring several characters at once ─────────────────────────────────────

test('distance is measured to the NEAREST monitored character', () => {
  // A mining op is spread out. Measuring from one character reports the barge
  // in the belt as safe whenever the FC happens to be docked somewhere else.
  const tr = createProximityTracker({ adjacency: ADJ });
  const reach = tr.setOrigins([
    { key: 'fc',    label: 'Fleet Boss', systemId: 1 },   // EKPB-3
    { key: 'barge', label: 'Miner Alt',  systemId: 5 },   // YPW-M4, far end
  ]);
  assert.ok(reach >= 5, 'both origins contribute to reach');

  // 5M2-KP is 2 from EKPB-3 and 2 from YPW-M4; TK-DLH is 3 and 1.
  assert.strictEqual(tr.jumpsTo(3), 1, 'TK-DLH is 1 jump from the miner, 3 from the boss');
  assert.strictEqual(tr.nearestTo(3).origin.label, 'Miner Alt');
  assert.strictEqual(tr.nearestTo(4).origin.label, 'Fleet Boss', 'AGCP-I is the boss\'s side');
});

test('an alert names which character is in danger', () => {
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigins([
    { key: 'fc',    label: 'Fleet Boss', systemId: 1 },
    { key: 'barge', label: 'Miner Alt',  systemId: 5 },
  ]);
  const [t] = tr.ingest({ systemId: 3, systemName: 'TK-DLH', status: 'hostile', pilots: ['Roamer'], ts: 0 });
  assert.strictEqual(t.jumps, 1);
  assert.strictEqual(t.threatTo, 'Miner Alt', 'the operator needs to know WHO to warn');
});

test('monitoring nobody disables measurement rather than defaulting to the galaxy', () => {
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigins([]);
  assert.strictEqual(tr.jumpsTo(1), null);
  assert.deepStrictEqual(tr.ingest({ systemId: 1, systemName: 'EKPB-3', status: 'hostile', pilots: ['X'], ts: 0 }), []);
});

// ── Killmails as a second source ──────────────────────────────────────────────

const { createKillWatch, LOSS_RELEVANT_MS } = require('../src/intel/kill_watch');

function killFixture(now) {
  return [
    { killmailId: 1, isLoss: true,  systemId: 2, time: new Date(now - 60_000).toISOString(),  attackerCount: 4, totalValue: 1e8 },
    { killmailId: 2, isLoss: false, systemId: 3, time: new Date(now - 60_000).toISOString(),  attackerCount: 1, totalValue: 1e7 },
    { killmailId: 3, isLoss: true,  systemId: 4, time: new Date(now - LOSS_RELEVANT_MS - 60_000).toISOString(), attackerCount: 2, totalValue: 1e6 },
  ];
}

test('only our LOSSES count as hostile contact', async () => {
  // A kill means a hostile WAS there and is now dead — the opposite of a
  // warning. Only losses say something is still out there.
  const now = Date.now();
  const got = [];
  const kw = createKillWatch({
    httpGet: async () => [],
    getZkillFeed: async () => killFixture(now),
    onKillReport: (r) => got.push(r),
  });
  kw.setMonitored([{ characterId: 99, name: 'Miner Alt' }]);
  await kw.refresh(now);

  assert.strictEqual(got.length, 1, 'the kill and the stale loss are both excluded');
  assert.strictEqual(got[0].systemId, 2);
  assert.strictEqual(got[0].status, 'hostile');
  assert.strictEqual(got[0].count, 4, 'attacker count carries through as the hostile count');
  assert.strictEqual(got[0].source, 'killmail');
  assert.match(got[0].body, /Miner Alt lost a ship/);
});

test('a loss is reported once, not on every poll', async () => {
  const now = Date.now();
  const got = [];
  const kw = createKillWatch({
    httpGet: async () => [],
    getZkillFeed: async () => killFixture(now),
    onKillReport: (r) => got.push(r),
  });
  kw.setMonitored([{ characterId: 99, name: 'Miner Alt' }]);
  await kw.refresh(now);
  await kw.refresh(now);
  await kw.refresh(now);
  assert.strictEqual(got.length, 1, 'zKill returns the same rows every 10 minutes');
});

test('system kill activity separates NPC kills from ship kills', async () => {
  // A system full of NPC kills is a quiet ratting system. Summing them would
  // paint it as a warzone and send a mining fleet somewhere worse.
  const kw = createKillWatch({
    httpGet: async () => ([
      { system_id: 30000142, ship_kills: 3, pod_kills: 1, npc_kills: 812 },
      { system_id: 30004759, ship_kills: 0, pod_kills: 0, npc_kills: 0 },
    ]),
    getZkillFeed: async () => [],
    onKillReport: () => {},
  });
  await kw.refresh(Date.now());
  const jita = kw.activityFor(30000142);
  assert.strictEqual(jita.shipKills, 3);
  assert.strictEqual(jita.npcKills, 812);
  assert.strictEqual(kw.activityFor(999999), null, 'unknown systems report nothing, not zero');
});

test('system kills are not re-fetched inside their own cache window', async () => {
  // CCP caches this endpoint for an hour; polling faster burns the error budget
  // for identical bytes.
  let calls = 0;
  const kw = createKillWatch({
    httpGet: async () => { calls++; return []; },
    getZkillFeed: async () => [],
    onKillReport: () => {},
  });
  const t0 = Date.now();
  await kw.refresh(t0);
  await kw.refresh(t0 + 60_000);
  await kw.refresh(t0 + 10 * 60_000);
  assert.strictEqual(calls, 1, 'one fetch per hour, however often refresh runs');
});

test('a failing kill source never breaks the chat pipeline', async () => {
  const kw = createKillWatch({
    httpGet: async () => { throw new Error('zkill is down'); },
    getZkillFeed: async () => { throw new Error('nope'); },
    onKillReport: () => { throw new Error('should not be called'); },
  });
  kw.setMonitored([{ characterId: 1, name: 'X' }]);
  await kw.refresh(Date.now());   // must not throw
  assert.strictEqual(kw.activityFor(30000142), null);
});

// ── Ship types and threat roles ───────────────────────────────────────────────

const ROLE_SHIPS = [
  { name: 'Sabre',     group: 'Interdictor' },
  { name: 'Devoter',   group: 'Heavy Interdiction Cruiser' },
  { name: 'Stiletto',  group: 'Interceptor' },
  { name: 'Myrmidon',  group: 'Battlecruiser' },
  { name: 'Thorax',    group: 'Cruiser' },
  { name: 'Buzzard',   group: 'Covert Ops' },
  { name: 'Revelation', group: 'Dreadnought' },
  { name: 'Guardian',  group: 'Logistics' },
  { name: 'Naga',      group: 'Attack Battlecruiser' },
];
const ridx = buildSystemIndex(SYSTEMS, ROLE_SHIPS);
const rmk  = () => createChannelParser(ridx, { regions: REGIONS, channel: 'test.imperium' });

test('hulls are classified by what they DO, from SDE group names', () => {
  assert.strictEqual(ridx.shipRole('sabre'),      'tackle',  'interdictor');
  assert.strictEqual(ridx.shipRole('devoter'),    'tackle',  'HIC');
  assert.strictEqual(ridx.shipRole('stiletto'),   'tackle',  'interceptor');
  assert.strictEqual(ridx.shipRole('buzzard'),    'cloaky');
  assert.strictEqual(ridx.shipRole('revelation'), 'capital');
  assert.strictEqual(ridx.shipRole('guardian'),   'logi');
  assert.strictEqual(ridx.shipRole('myrmidon'),   null, 'a plain combat ship has no special role');
});

test('intel role shorthand counts even with no hull named', () => {
  // "dictor", "hic" and especially "bubbled" (157 uses in the corpus) say
  // tackle without naming a ship.
  for (const w of ['dictor', 'dictors', 'hic', 'ceptor', 'bubble', 'bubbled']) {
    assert.strictEqual(ridx.shipRole(w), 'tackle', `"${w}" must read as tackle`);
  }
  assert.strictEqual(ridx.shipRole('bomber'), 'cloaky');
  assert.strictEqual(ridx.shipRole('dread'),  'capital');
});

test('plural hull names resolve, but nothing fuzzier', () => {
  assert.strictEqual(ridx.shipName('myrmidons'), 'myrmidon');
  assert.strictEqual(ridx.shipName('sabres'),    'sabre');
  assert.strictEqual(ridx.shipName('myrmidon'),  'myrmidon');
  // Rejected by measurement, not preference: prefix matching turned "here" into
  // Heretic, "are" into Ares and "red" into Redeemer across the real corpus.
  assert.strictEqual(ridx.shipName('myrm'),  null, 'a truncation is not a hull');
  assert.strictEqual(ridx.shipName('stil'),  null);
  assert.strictEqual(ridx.shipName('sab'),   null);
});

test('a report carries both the hulls and what they mean', () => {
  const r = rmk().ingest(line('2026.08.01 18:00:00', 'Scout', '5M2-KP +4 1 Thorax 3 Myrmidons'));
  assert.deepStrictEqual(r.ships.sort(), ['myrmidon', 'thorax']);
  assert.deepStrictEqual(r.roles, [], 'a brawling gang carries no special role');

  const t = rmk().ingest(line('2026.08.01 18:00:00', 'Scout', 'EKPB-3 sabre + 2 stilettos bubbled the gate'));
  assert.ok(t.ships.includes('sabre') && t.ships.includes('stiletto'));
  assert.deepStrictEqual(t.roles, ['tackle']);
});

test('tackle escalates the alert and widens the tripwire', () => {
  // The decision this whole feature turns on: a Myrmidon can kill a barge, a
  // Sabre means the barge never leaves. By the time a dictor is inside the
  // normal ring it is already too late to break siege.
  const brawler = { jumps: 4, inbound: false, etaSeconds: 999, roles: [] };
  const dictor  = { jumps: 4, inbound: false, etaSeconds: 999, roles: ['tackle'] };
  assert.strictEqual(shouldAlert(brawler, { alertJumps: 5 }).level, 'warning');
  assert.strictEqual(shouldAlert(dictor,  { alertJumps: 5 }).level, 'critical');
  assert.strictEqual(shouldAlert(dictor,  { alertJumps: 5 }).reason, 'tackle');

  // Outside the ordinary ring, tackle still trips it.
  const farBrawler = { jumps: 7, inbound: false, etaSeconds: 999, roles: [] };
  const farDictor  = { jumps: 7, inbound: false, etaSeconds: 999, roles: ['tackle'] };
  assert.strictEqual(shouldAlert(farBrawler, { alertJumps: 5 }), null);
  assert.ok(shouldAlert(farDictor, { alertJumps: 5 }), 'a dictor at 7 jumps still warrants a warning');
});

test('roles accumulate across a contact\'s whole track', () => {
  // A gang reported as "sabre" once and "3 myrms" later is still a tackle gang.
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  tr.ingest({ systemId: 5, systemName: 'YPW-M4', status: 'hostile', pilots: ['Gang Lead'],
              roles: ['tackle'], ships: ['sabre'], ts: 0 });
  const out = tr.ingest({ systemId: 3, systemName: 'TK-DLH', status: 'hostile', pilots: ['Gang Lead'],
                          roles: [], ships: ['myrmidon'], ts: 120000 });
  const pilot = out.find(t => t.kind === 'pilot');
  assert.deepStrictEqual(pilot.roles, ['tackle'], 'the earlier tackle sighting still counts');
  assert.deepStrictEqual(pilot.ships.sort(), ['myrmidon', 'sabre']);
});

test('an ETA says whether it was measured or guessed', () => {
  // Warp speed varies several-fold between hulls and systems differ in size, so
  // a confident time would be a number the tool cannot stand behind. Callers
  // need to know which kind of estimate they are showing.
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  const [first] = tr.ingest({ systemId: 3, systemName: 'TK-DLH', status: 'hostile', pilots: ['X'], ts: 0 });
  assert.strictEqual(first.etaMeasured, false, 'one sighting cannot establish a speed');
  assert.strictEqual(first.jumpsPerMin, null);

  tr.ingest({ systemId: 2, systemName: '5M2-KP', status: 'hostile', pilots: ['X'], ts: 60000 });
  const [later] = tr.ingest({ systemId: 4, systemName: 'AGCP-I', status: 'hostile', pilots: ['X'], ts: 120000 });
  assert.strictEqual(later.etaMeasured, true, 'a track with movement has a measured rate');
  assert.ok(later.jumpsPerMin > 0);
});

test('multi-word faction hulls match whole, not in pieces', () => {
  // "Omen Navy Issue" used to match only "omen", leaving "Navy" behind — which
  // the pilot extractor then reported as a hostile called Navy. That word
  // appears 211 times across the corpus, so it was a steady stream of ghosts.
  const idx2 = buildSystemIndex(SYSTEMS, [
    { name: 'Omen',            group: 'Cruiser' },
    { name: 'Omen Navy Issue', group: 'Cruiser' },
    { name: 'Sabre',           group: 'Interdictor' },
  ]);
  const hit = idx2.matchShips('EKPB-3  Omen Navy Issue and a sabre');
  assert.deepStrictEqual(hit.hulls.sort(), ['omen navy issue', 'sabre'],
    'the long name wins over the short one it contains');
  assert.ok(hit.claimed.has('navy') && hit.claimed.has('issue'),
    'the faction words are consumed so they cannot become a pilot');

  const p = createChannelParser(idx2, { regions: REGIONS, channel: 't' });
  const r = p.ingest(line('2026.08.01 18:00:00', 'Scout', 'EKPB-3  Omen Navy Issue  Real Pilot'));
  assert.ok(!r.pilots.includes('Navy'), 'no ghost pilot');
  assert.ok(!r.pilots.includes('Issue'), 'no ghost pilot');
  assert.deepStrictEqual(r.pilots, ['Real Pilot']);
});

test('a bare hull still matches when it is not part of a longer name', () => {
  const idx2 = buildSystemIndex(SYSTEMS, [
    { name: 'Omen',            group: 'Cruiser' },
    { name: 'Omen Navy Issue', group: 'Cruiser' },
  ]);
  assert.deepStrictEqual(idx2.matchShips('EKPB-3 omen').hulls, ['omen']);
});

// ── Gang sizing ───────────────────────────────────────────────────────────────

const { gangBand } = require('../src/intel/proximity');

test('gang size bands match the thresholds an FC actually calls', () => {
  assert.strictEqual(gangBand(1),  'solo');
  assert.strictEqual(gangBand(2),  'small');
  assert.strictEqual(gangBand(14), 'small', 'under 15 is a small gang');
  assert.strictEqual(gangBand(15), 'large', '15 and up is a large gang');
  assert.strictEqual(gangBand(30), 'large');
  assert.strictEqual(gangBand(31), 'fleet', 'over 30 is a fleet');
  assert.strictEqual(gangBand(0),    null, 'no report is not a size of zero');
  assert.strictEqual(gangBand(null), null);
});

test('size takes the larger of the reported count and the named pilots', () => {
  // The two sources undercount in different ways: reporters who give "+12"
  // rarely list names, and reporters who list names rarely give a count.
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  tr.ingest({ systemId: 2, systemName: '5M2-KP', status: 'hostile', count: 12, pilots: [], ts: 0 });
  let sys = tr.active(0).find(t => t.kind === 'system');
  assert.strictEqual(sys.size, 12, 'from the explicit count');
  assert.strictEqual(sys.band, 'small');

  // Now four names arrive — fewer than the count, so the count stands.
  tr.ingest({ systemId: 2, systemName: '5M2-KP', status: 'hostile',
              pilots: ['A One', 'B Two', 'C Three', 'D Four'], ts: 60000 });
  sys = tr.active(60000).find(t => t.kind === 'system');
  assert.strictEqual(sys.size, 12, 'a shorter name list does not shrink the gang');
});

test('naming more pilots than the count raises the estimate', () => {
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  tr.ingest({ systemId: 2, systemName: '5M2-KP', status: 'hostile', count: 2, pilots: [], ts: 0 });
  const names = Array.from({ length: 18 }, (_, i) => `Pilot ${i}`);
  tr.ingest({ systemId: 2, systemName: '5M2-KP', status: 'hostile', pilots: names, ts: 60000 });
  const sys = tr.active(60000).find(t => t.kind === 'system');
  assert.strictEqual(sys.size, 18);
  assert.strictEqual(sys.band, 'large');
});

test('a fleet escalates and widens the ring, like tackle does', () => {
  // 30+ hostiles inside the ordinary ring means the op is already over.
  const gang  = { jumps: 6, inbound: false, etaSeconds: 999, roles: [], band: 'small', size: 8 };
  const fleet = { jumps: 6, inbound: false, etaSeconds: 999, roles: [], band: 'fleet', size: 44 };
  assert.strictEqual(shouldAlert(gang, { alertJumps: 5 }), null, 'a small gang at 6 is outside the ring');
  const v = shouldAlert(fleet, { alertJumps: 5 });
  assert.ok(v, 'a fleet at 6 still trips it');
  assert.strictEqual(v.level, 'critical');
  assert.strictEqual(v.reason, 'fleet');
  assert.strictEqual(v.size, 44);
});

test('a solo roamer is never escalated on numbers alone', () => {
  const solo = { jumps: 4, inbound: false, etaSeconds: 999, roles: [], band: 'solo', size: 1 };
  const v = shouldAlert(solo, { alertJumps: 5 });
  assert.strictEqual(v.level, 'warning', 'still worth knowing, not worth panicking over');
  assert.strictEqual(v.fleet, false);
});

test('size is carried on the alert so the operator sees the number', () => {
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  const [t] = tr.ingest({ systemId: 4, systemName: 'AGCP-I', status: 'hostile',
                          count: 40, pilots: [], ts: 0 });
  assert.strictEqual(t.size, 40);
  assert.strictEqual(t.band, 'fleet');
  const v = shouldAlert(t, { alertJumps: 5 });
  assert.strictEqual(v.size, 40);
  assert.strictEqual(v.band, 'fleet');
});

test('a pilot whose name contains a hull word survives intact', () => {
  // Plenty of EVE hulls are ordinary words. "Wolf Eyes" came through as "Eyes"
  // and tracked as a separate hostile, because Wolf is an assault frigate.
  // A hull name in the MIDDLE of a chunk is part of somebody's name; only a
  // TRAILING one is a ship report appended to it.
  const idx2 = buildSystemIndex(SYSTEMS, [
    { name: 'Wolf',   group: 'Assault Frigate' },
    { name: 'Thorax', group: 'Cruiser' },
    { name: 'Sabre',  group: 'Interdictor' },
  ]);
  const p = createChannelParser(idx2, { regions: REGIONS, channel: 't' });

  const r = p.ingest(line('2026.08.01 18:00:00', 'Scout', 'EKPB-3  Wolf Eyes  Mae Aivo thorax  sabre'));
  assert.ok(r.pilots.includes('Wolf Eyes'), `expected "Wolf Eyes", got ${JSON.stringify(r.pilots)}`);
  assert.ok(!r.pilots.includes('Eyes'), 'must not be truncated to the tail word');
  assert.ok(r.pilots.includes('Mae Aivo'), 'a trailing hull is still stripped');
  assert.ok(!r.pilots.includes('Mae Aivo thorax'));
  assert.ok(!r.pilots.some(n => /^sabre$/i.test(n)), 'a chunk that is only a hull is not a pilot');
  assert.ok(r.ships.includes('wolf') && r.ships.includes('thorax') && r.ships.includes('sabre'),
    'all three still register as ships');
});

test('a trailing count is stripped but an interior number is not a name-breaker', () => {
  const idx2 = buildSystemIndex(SYSTEMS, [{ name: 'Sabre', group: 'Interdictor' }]);
  const p = createChannelParser(idx2, { regions: REGIONS, channel: 't' });
  const r = p.ingest(line('2026.08.01 18:00:00', 'Scout', 'EKPB-3  Wolf Eyes +2'));
  assert.deepStrictEqual(r.pilots, ['Wolf Eyes']);
});

// ── Track and trace: one gang, one row ───────────────────────────────────────

const { groupContacts, GANG_WINDOW_MS } = require('../src/intel/proximity');

test('a gang in one system is ONE contact, not one per named pilot', () => {
  // Straight from a real screenshot: U104-3 produced four rows for one gang —
  // three named pilots and the system they were standing in. The same gang
  // counted four times reads as four threats, and each one alerts separately.
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  const t0 = Date.now();
  tr.ingest({ systemId: 4, systemName: 'AGCP-I', status: 'hostile', ts: t0,
              pilots: ['Fashion c', 'Makilunn'], ships: ['sabre'], roles: ['tackle'] });
  tr.ingest({ systemId: 4, systemName: 'AGCP-I', status: 'hostile', ts: t0 + 30_000,
              pilots: ['Third Pilot'], count: 5 });

  const live = tr.active(t0 + 40_000);
  assert.strictEqual(live.length, 1, `expected one gang, got ${live.length}`);
  const gang = live[0];
  assert.deepStrictEqual(gang.pilots.sort(), ['Fashion c', 'Makilunn', 'Third Pilot']);
  assert.strictEqual(gang.size, 5, 'the largest count wins over the names counted');
  assert.deepStrictEqual(gang.roles, ['tackle'], 'roles pool across the members');
  assert.strictEqual(gang.members, 4, 'three pilots plus the system track');
});

test('the gang keeps its identity as it moves — the "trace" half', () => {
  // Keyed on membership, not location, so suppression follows the gang instead
  // of resetting at every gate.
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  const t0 = Date.now();
  // The chain runs EKPB-3(1) - AGCP-I(4) - 5M2-KP(2) - TK-DLH(3), so walking
  // TK-DLH -> 5M2-KP is a step TOWARD the origin.
  tr.ingest({ systemId: 3, systemName: 'TK-DLH', status: 'hostile', ts: t0, pilots: ['Alpha', 'Beta'] });
  const first = tr.active(t0 + 1000)[0];

  tr.ingest({ systemId: 2, systemName: '5M2-KP', status: 'hostile', ts: t0 + 60_000, pilots: ['Alpha', 'Beta'] });
  const moved = tr.active(t0 + 61_000).find(c => c.systemName === '5M2-KP');

  assert.strictEqual(moved.key, first.key, 'same gang, same key');
  assert.strictEqual(moved.inbound, true, 'and it is now measurably closing');
  assert.strictEqual(moved.closing, 1);
});

test('two visits hours apart are not the same contact', () => {
  // The window has to gather one gang's scattered reports without sweeping in a
  // later, unrelated visitor.
  const t0 = Date.now();
  const mk = (label, last) => ({
    key: 'p:' + label.toLowerCase(), kind: 'pilot', label, systemId: 4, systemName: 'AGCP-I',
    jumps: 3, closing: 0, inbound: false, sightings: 1, size: 1, roles: [], ships: [],
    path: ['AGCP-I'], first: last, last,
  });
  const grouped = groupContacts([mk('Early', t0), mk('Later', t0 + GANG_WINDOW_MS * 3)]);
  assert.strictEqual(grouped.length, 2, 'separated by the window');
});

test('the list leads with the nearest contact', () => {
  // Distance is the only exact number here; inbound and closing are inferred,
  // so they break ties rather than setting the order.
  const tr = createProximityTracker({ adjacency: ADJ });
  tr.setOrigin(1);
  const t0 = Date.now();
  // Something far out but closing — YPW-M4(4j) then TK-DLH(3j)…
  tr.ingest({ systemId: 5, systemName: 'YPW-M4', status: 'hostile', ts: t0,     pilots: ['Runner'] });
  tr.ingest({ systemId: 3, systemName: 'TK-DLH', status: 'hostile', ts: t0 + 60_000, pilots: ['Runner'] });
  // …and something sitting one jump out, not moving at all.
  tr.ingest({ systemId: 4, systemName: 'AGCP-I', status: 'hostile', ts: t0 + 61_000, pilots: ['Camper'] });

  const live = tr.active(t0 + 62_000);
  assert.strictEqual(live[0].label, 'Camper', 'the nearest leads, even though it is static');
  assert.ok(live[0].jumps < live[1].jumps);
});
