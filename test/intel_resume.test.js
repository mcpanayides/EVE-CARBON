'use strict';
//
// Picking the picture back up after a restart.
//
// Closing the app used to lose everything: the tracks, the headings, the whole
// derivative. Reopening it meant starting blind, and the first sighting of a
// gang that had been closing for ten minutes read as a brand-new contact
// standing still.
//
// The fix is to replay the tail of the chat log rather than to persist the
// tracks, because the log is the source of truth AND it covers the gap while the
// app was shut — a persisted snapshot only knows what was true at shutdown.
//
// The hazard is the exact one the whole system is built to avoid: replaying old
// lines must not fire old alerts. The reader's own comment on opening at EOF
// says it — "replaying a whole session's backlog on startup would fire alerts
// for gangs that passed hours ago". So the backfill alerts on NOTHING, and a
// single capped sweep afterwards decides what is still worth saying.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { createChatlogReader, lineTimestamp } = require('../src/intel/chatlog_reader');
const { createProximityTracker, buildAdjacency } = require('../src/intel/proximity');
const { createIntelService } = require('../src/intel/intel_service');

// ── Reading a timestamp off a line ───────────────────────────────────────────

test('log timestamps are read as UTC — EVE time', () => {
  assert.strictEqual(lineTimestamp('[ 2026.08.01 18:00:54 ] X > EKPB-3'),
                     Date.UTC(2026, 7, 1, 18, 0, 54));
  assert.strictEqual(lineTimestamp('﻿[ 2026.08.01 18:00:54 ] X > Y'),
                     Date.UTC(2026, 7, 1, 18, 0, 54), 'per-line BOM tolerated');
  // A MOTD or join notice carries no time. Guessing one would corrupt the very
  // derivative this exists to preserve.
  assert.strictEqual(lineTimestamp('Channel MOTD: welcome'), null);
  assert.strictEqual(lineTimestamp(''), null);
});

// ── The backfill window ───────────────────────────────────────────────────────

/** A chat log written the way EVE writes them: UTF-16LE, one line per report. */
function writeLog(dir, channel, lines) {
  const file = path.join(dir, `${channel}_20260804_120000_95465499.txt`);
  const head = '﻿---------------------------------------------------------------\n' +
               `  Channel Name:    ${channel}\n  Listener:        Scout\n` +
               '---------------------------------------------------------------\n\n';
  fs.writeFileSync(file, Buffer.from(head + lines.join('\n') + '\n', 'utf16le'));
  return file;
}

const stamp = (msAgo) => {
  const d = new Date(Date.now() - msAgo);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

function readerOver(lines, backfillMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-resume-'));
  writeLog(dir, 'test.imperium', lines);
  const seen = [];
  const reader = createChatlogReader({
    dir, channels: ['test.imperium'], knownRegions: ['Insmother'],
    backfillMs,
    onLine: (line, meta) => seen.push({ line, backfill: !!meta.backfill }),
  });
  return { reader, seen, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('without backfill, an existing log is not replayed at all', () => {
  // The long-standing behaviour, and it must stay the default for anyone who
  // does not want it: opening at EOF is what stops a session's whole backlog
  // firing alerts for gangs that passed hours ago.
  const { reader, seen, cleanup } = readerOver([
    `[ ${stamp(60_000)} ] Scout > EKPB-3 Roamer`,
  ], 0);
  try {
    reader.start();
    assert.deepStrictEqual(seen, []);
  } finally { reader.stop(); cleanup(); }
});

test('backfill replays only lines inside the window, flagged as backfill', () => {
  const { reader, seen, cleanup } = readerOver([
    `[ ${stamp(60 * 60_000)} ] Scout > EKPB-3 AncientGang`,   // an hour ago
    `[ ${stamp(9 * 60_000)}  ] Scout > 5M2-KP StaleGang`,     // 9 minutes ago
    `[ ${stamp(120_000)}     ] Scout > TK-DLH RecentGang`,    // 2 minutes ago
    `[ ${stamp(30_000)}      ] Scout > AGCP-I FreshGang`,     // 30 seconds ago
  ], 5 * 60_000);
  try {
    reader.start();
    const bodies = seen.map(s => s.line);
    assert.ok(bodies.some(l => /RecentGang/.test(l)), 'inside the window');
    assert.ok(bodies.some(l => /FreshGang/.test(l)),  'inside the window');
    assert.ok(!bodies.some(l => /StaleGang/.test(l)),  '9 minutes is outside a 5 minute window');
    assert.ok(!bodies.some(l => /AncientGang/.test(l)), 'an hour is long gone');
    assert.ok(seen.every(s => s.backfill), 'every replayed line is flagged');
  } finally { reader.stop(); cleanup(); }
});

test('backfill happens once, and live reading carries on from the end', () => {
  const { reader, seen, cleanup } = readerOver([
    `[ ${stamp(30_000)} ] Scout > TK-DLH RecentGang`,
  ], 5 * 60_000);
  try {
    reader.start();
    const afterOpen = seen.length;
    assert.strictEqual(afterOpen, 1);
    reader.tick();
    reader.tick();
    assert.strictEqual(seen.length, afterOpen, 'not replayed again on every poll');
  } finally { reader.stop(); cleanup(); }
});

test('undated lines are dropped rather than guessed at', () => {
  const { reader, seen, cleanup } = readerOver([
    'Some join notice with no timestamp',
    `[ ${stamp(30_000)} ] Scout > TK-DLH RecentGang`,
  ], 5 * 60_000);
  try {
    reader.start();
    assert.strictEqual(seen.length, 1);
    assert.match(seen[0].line, /RecentGang/);
  } finally { reader.stop(); cleanup(); }
});

// ── Through the service ───────────────────────────────────────────────────────

const SDE = {
  async all(sql) {
    if (/mapSolarSystemJumps/.test(sql)) {
      return [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }];
    }
    if (/invTypes/.test(sql)) return [{ id: 22456, n: 'Sabre', grp: 'Interdictor' }];
    return [
      { id: 1, name: 'EKPB-3', security: -0.4, regionId: 10, regionName: 'Insmother' },
      { id: 2, name: '5M2-KP', security: -0.4, regionId: 10, regionName: 'Insmother' },
      { id: 3, name: 'TK-DLH', security: -0.4, regionId: 10, regionName: 'Insmother' },
      { id: 4, name: 'AGCP-I', security: -0.4, regionId: 10, regionName: 'Insmother' },
    ];
  },
};

function serviceOver(lines, { origin = 1, backfillMs = 5 * 60_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-resume-'));
  writeLog(dir, 'test.imperium', lines);
  const alerts = [];
  const svc = createIntelService({
    getSdeDb: () => SDE,
    onAlert: (a) => alerts.push(a),
    zkillFetch: async () => ({ notFound: true }),
  });
  return {
    dir, alerts, svc,
    async run() {
      await svc.init();
      svc.setOptions({ backfillMs });
      svc.setOrigin(origin);
      return svc.start(['test.imperium'], { dir });
    },
    cleanup: () => { svc.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a relaunch rebuilds the track, heading and all', async () => {
  // The whole point. Three sightings walking a gang toward home; after a restart
  // the contact must still read as INBOUND, not as a fresh sighting standing
  // still — that difference is what decides whether a mining fleet moves.
  const h = serviceOver([
    `[ ${stamp(200_000)} ] Scout > AGCP-I Roamer sabre`,   // 4 jumps out
    `[ ${stamp(140_000)} ] Scout > TK-DLH Roamer sabre`,   // 3
    `[ ${stamp(80_000)}  ] Scout > 5M2-KP Roamer sabre`,   // 2
  ]);
  try {
    await h.run();
    const contact = h.svc.contacts().find(c => c.kind === 'pilot');
    assert.ok(contact, 'the pilot track came back');
    assert.strictEqual(contact.systemName, '5M2-KP', 'at its most recent position');
    assert.strictEqual(contact.sightings, 3, 'with its whole history');
    assert.strictEqual(contact.inbound, true, 'and it still knows which way it is pointed');
    assert.strictEqual(contact.closing, 2);
  } finally { h.cleanup(); }
});

test('the replay itself raises no alerts', async () => {
  // A dozen replayed lines must not become a dozen warnings about gangs that
  // have already been and gone.
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push(`[ ${stamp(240_000 - i * 1000)} ] Scout > AGCP-I Pilot${i}`);
  const h = serviceOver(lines);
  try {
    await h.run();
    // AGCP-I is 3 jumps from home and none of these are closing, so nothing here
    // should have tripped the ordinary alert either — but the assertion that
    // matters is that no alert carries a non-resumed flag.
    assert.ok(h.alerts.every(a => a.resumed), 'every alert came from the sweep, not the replay');
  } finally { h.cleanup(); }
});

test('a contact still dangerous on resume is reported, but only the worst few', async () => {
  // Relaunching in the middle of an incident and hearing nothing is its own
  // failure. One sweep, capped, so it is a briefing rather than a storm.
  const lines = [];
  for (let i = 0; i < 10; i++) {
    lines.push(`[ ${stamp(100_000 - i * 2000)} ] Scout > 5M2-KP Camper${i} sabre`);
  }
  const h = serviceOver(lines);
  try {
    const status = await h.run();
    assert.ok(h.alerts.length > 0, 'silence during an incident is not an option');
    assert.ok(h.alerts.length <= 3, `capped — saw ${h.alerts.length}`);
    assert.ok(h.alerts.every(a => a.resumed), 'and marked as a resume, not a live sighting');
    assert.strictEqual(status.resumed, h.alerts.length);
  } finally { h.cleanup(); }
});

test('the resume sweep hands over to ordinary suppression', async () => {
  // Having just warned about a gang, the next live report about it must be quiet
  // — otherwise every relaunch costs an extra alert.
  const h = serviceOver([
    `[ ${stamp(60_000)} ] Scout > 5M2-KP Camper sabre`,
  ]);
  try {
    await h.run();
    const fromResume = h.alerts.length;
    assert.ok(fromResume > 0);
    // The same contact, reported again, no closer.
    h.svc._handleLine(`[ ${stamp(0)} ] Scout > 5M2-KP Camper sabre`,
                      { channel: 'test.imperium', regions: ['Insmother'] });
    assert.strictEqual(h.alerts.length, fromResume, 'already warned — stays quiet');
  } finally { h.cleanup(); }
});

test('with backfill off, a relaunch starts blind — the old behaviour', async () => {
  const h = serviceOver([
    `[ ${stamp(60_000)} ] Scout > 5M2-KP Camper sabre`,
  ], { backfillMs: 0 });
  try {
    await h.run();
    assert.deepStrictEqual(h.svc.contacts(), []);
    assert.deepStrictEqual(h.alerts, []);
  } finally { h.cleanup(); }
});

// ── Moving the fleet ─────────────────────────────────────────────────────────

test('moving re-measures existing tracks instead of mixing two rulers', () => {
  // A sighting records distance from where the fleet stood AT THE TIME. Move the
  // fleet and those numbers are in the old frame while new ones arrive in the
  // new one — and `closing`, being just first minus last, then compares two
  // different rulers. This matters far more now: distances survive a restart,
  // and the character has usually moved while the app was shut.
  const adjacency = buildAdjacency([{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }]);
  const t = createProximityTracker({ adjacency });
  t.setOrigin(1);

  const now = Date.now();
  t.ingest({ ts: now - 60_000, systemId: 4, systemName: 'AGCP-I', pilots: ['Roamer'], status: 'hostile' });
  assert.strictEqual(t.assess('p:roamer').jumps, 3);

  // The fleet jumps to 5M2-KP (2), which is one closer to the contact.
  t.setOrigin(2);
  const after = t.assess('p:roamer');
  assert.strictEqual(after.jumps, 2, 'the old sighting is re-measured from the new position');
  assert.strictEqual(after.closing, 0, 'WE moved — the contact did not close on us');
});

test('a track that moving puts out of range is dropped', () => {
  const adjacency = buildAdjacency([{ from: 1, to: 2 }, { from: 9, to: 8 }]);
  const t = createProximityTracker({ adjacency, maxJumps: 3 });
  t.setOrigin(1);
  t.ingest({ ts: Date.now(), systemId: 2, systemName: '5M2-KP', pilots: ['Roamer'], status: 'hostile' });
  assert.ok(t.assess('p:roamer'));
  t.setOrigin(9);                       // a different pocket entirely
  assert.strictEqual(t.assess('p:roamer'), null);
});
