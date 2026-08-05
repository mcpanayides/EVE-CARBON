'use strict';
//
// Route and time-of-day patterns.
//
// Almost every test here is about a claim NOT being made. The tool's other
// failure mode is noise; this file's is confidence — "they always come through
// YPW-M4" derived from one busy evening. An operator who plans an op around a
// pattern that was really three sightings and a coincidence loses a fleet, and
// the tool deserves the blame. So the thresholds are the feature, and these
// tests exist to hold them.
const test   = require('node:test');
const assert = require('node:assert');
const {
  createPatternStore, bucketPattern, hourBlocks, buildWalks, routeStats, corridors,
  entryPoints, countOccasions, DEFAULTS, WEEKDAY_NAMES,
} = require('../src/intel/patterns');
const { createProximityTracker, buildAdjacency } = require('../src/intel/proximity');

const HOUR = 3600_000;
const DAY  = 24 * HOUR;
// Anchored to NOW, not to a fixed calendar date: loading a store prunes against
// the wall clock, so fixtures pinned to a real date would drift out of the
// 30-day window and start failing on their own months later. 29 days back, on a
// UTC midnight, leaves every day offset used below inside the window.
const BASE = Math.floor((Date.now() - 29 * DAY) / DAY) * DAY;
/** Timestamp on day `d` at UTC hour `h` — EVE time is UTC. */
const at = (d, h, m = 0) => BASE + d * DAY + h * HOUR + m * 60_000;

const store = (opts) => createPatternStore({ options: opts });
const sysSighting = (ts, systemId = 30000142) => ({ ts, kind: 'system', key: `s:${systemId}`, systemId });
const hop = (ts, key, from, to, adjacent = true) =>
  ({ ts, kind: 'pilot', key, systemId: to, prevSystemId: from, adjacent });

// ── Time of day ───────────────────────────────────────────────────────────────

test('an hour that repeats across days is a pattern', () => {
  const s = store();
  // Hostiles at 18:00 every day for a week, plus one unrelated sighting a day.
  for (let d = 0; d < 7; d++) {
    s.noteSighting(sysSighting(at(d, 18)));
    s.noteSighting(sysSighting(at(d, d)));       // a different hour each day
  }
  const a = s.analyse({ now: at(7, 0) });
  assert.strictEqual(a.ready, true, '7 days is enough to speak');
  const notable = a.hours.filter(h => h.notable).map(h => h.bucket);
  assert.deepStrictEqual(notable, [18], 'only the repeating hour');
  const h18 = a.hours[18];
  assert.strictEqual(h18.days, 7);
  assert.strictEqual(h18.share, 1);
  assert.ok(h18.lift > 2, `lift should be well above the baseline, got ${h18.lift}`);
});

test('ONE big night is not a pattern, however many sightings it produced', () => {
  // The trap this whole file is built around: a 40-man fleet on one evening
  // dumps sixty sightings into one hour and buries every other hour by count.
  const s = store();
  for (let i = 0; i < 60; i++) s.noteSighting(sysSighting(at(3, 20, i)));
  for (let d = 0; d < 7; d++) s.noteSighting(sysSighting(at(d, d + 1)));

  const a = s.analyse({ now: at(7, 0) });
  assert.strictEqual(a.hours[20].sightings, 60, 'the raw count is huge');
  assert.strictEqual(a.hours[20].days, 1, 'but it happened once');
  assert.strictEqual(a.hours[20].notable, false, 'so no pattern is claimed');
  assert.strictEqual(a.hours.filter(h => h.notable).length, 0);
});

test('in busy space, where every hour is active, no hour is notable', () => {
  // "Seen on 70% of days" means nothing if every hour scores that. Each hour is
  // judged against the observed baseline, so constant activity flags nothing.
  const s = store();
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) s.noteSighting(sysSighting(at(d, h)));
  const a = s.analyse({ now: at(7, 0) });
  assert.strictEqual(a.daysObserved, 7);
  assert.strictEqual(a.hourBaseline, 1, 'every bucket fires every day');
  assert.strictEqual(a.hours.filter(h => h.notable).length, 0);
});

test('too little history claims nothing at all', () => {
  const s = store();
  for (let d = 0; d < 3; d++) s.noteSighting(sysSighting(at(d, 19)));
  const a = s.analyse({ now: at(3, 0) });
  assert.strictEqual(a.ready, false);
  assert.strictEqual(a.daysObserved, 3);
  assert.strictEqual(a.minDaysObserved, DEFAULTS.minDaysObserved);
  assert.strictEqual(a.hours.filter(h => h.notable).length, 0,
    'a perfect 3-for-3 is still not evidence');
});

test('weekdays go through the same test as hours', () => {
  const s = store();
  // The same weekday five weeks running, and nothing else. Five is the most a
  // 30-day window can hold, which is itself the point: a weekly pattern is the
  // thinnest thing this window can see, and it is right at the limit.
  for (let w = 0; w < 5; w++) s.noteSighting(sysSighting(at(w * 7, 20)));
  const a = s.analyse({ now: at(29, 0) });
  const notable = a.weekdays.filter(d => d.notable);
  assert.strictEqual(notable.length, 1);
  assert.strictEqual(notable[0].label, WEEKDAY_NAMES[new Date(BASE).getUTCDay()]);
  assert.strictEqual(notable[0].days, 5);
});

test('an empty history is analysable and says nothing', () => {
  const a = store().analyse({ now: at(0, 0) });
  assert.strictEqual(a.ready, false);
  assert.strictEqual(a.daysObserved, 0);
  assert.strictEqual(a.hourBaseline, 0, 'no divide-by-zero');
  assert.deepStrictEqual(a.corridors, []);
  assert.deepStrictEqual(a.entries, []);
});

// ── Routes ────────────────────────────────────────────────────────────────────

test('a hop with no stargate between the systems is not a route', () => {
  // Reporters miss systems constantly. A contact seen in A and then in C, with
  // nobody covering B, is not evidence of an A–C gate.
  const s = store();
  for (let i = 0; i < 10; i++) s.noteSighting(hop(at(i, 12), 'p:x', 100, 300, false));
  assert.strictEqual(s.predictNext(100), null, 'gapped hops predict nothing');
  assert.strictEqual(s.analyse({ now: at(11, 0) }).gapped, 10, 'but they are still counted');
});

test('predictNext stays silent until it has seen enough, and unless there is a favourite', () => {
  const few = store();
  for (let i = 0; i < 4; i++) few.noteSighting(hop(at(i, 1), `p:${i}`, 100, 101));
  assert.strictEqual(few.predictNext(100), null, '4 transitions is not a habit');

  const split = store();
  for (let i = 0; i < 6; i++) split.noteSighting(hop(at(i, 1), `p:${i}`, 100, 101 + (i % 3)));
  assert.strictEqual(split.predictNext(100), null, 'three equally-used exits: no favourite');

  const clear = store();
  for (let i = 0; i < 5; i++) clear.noteSighting(hop(at(i, 1), `p:${i}`, 100, 101));
  clear.noteSighting(hop(at(6, 1), 'p:z', 100, 102));
  const p = clear.predictNext(100);
  assert.strictEqual(p.systemId, 101);
  assert.strictEqual(p.n, 5);
  assert.strictEqual(p.outOf, 6);
  assert.ok(Math.abs(p.share - 5 / 6) < 1e-9);
});

test('a gang moving together is ONE observation, not one per pilot', () => {
  // Found by replaying the real corpus. Six named pilots moving from A to B
  // produce six pilot tracks and therefore six transitions, and the first cut of
  // this reported "6 of 6 went to B — 100%" from a single gang moving once.
  const gang = store();
  for (let i = 0; i < 8; i++) gang.noteSighting(hop(at(0, 20, 0) + i * 400, `p:${i}`, 100, 101));
  assert.strictEqual(gang.predictNext(100), null, 'one fleet movement predicts nothing');

  // The same eight transitions, spread over eight days, IS a habit.
  const habit = store();
  for (let i = 0; i < 8; i++) habit.noteSighting(hop(at(i, 20), `p:${i}`, 100, 101));
  assert.strictEqual(habit.predictNext(100).systemId, 101);
});

test('a favoured exit seen on only one day is not yet a habit', () => {
  // Share and separate days are independent tests, and neither implies the
  // other: a whole evening of movement can be unanimous and still be one night.
  const s = store();
  for (let i = 0; i < 6; i++) s.noteSighting(hop(at(0, 10 + i), `p:${i}`, 100, 101));
  assert.strictEqual(s.predictNext(100), null, '6 separate occasions, but all one day');
  s.noteSighting(hop(at(1, 10), 'p:z', 100, 101));
  assert.strictEqual(s.predictNext(100).days, 2, 'a second day settles it');
});

test('a walk breaks at a reporting gap and at a long pause', () => {
  const legs = [
    { t: at(0, 1, 0),  a: 1, b: 2, k: 'p:a' },
    { t: at(0, 1, 5),  a: 2, b: 3, k: 'p:a', g: 1 },   // nobody saw what was between
    { t: at(0, 1, 10), a: 3, b: 4, k: 'p:a' },
    { t: at(0, 2, 30), a: 4, b: 5, k: 'p:a' },         // 80 minutes later: a new roam
  ];
  const walks = buildWalks(legs, DEFAULTS).map(w => w.systems);
  assert.deepStrictEqual(walks, [[1, 2], [3, 4], [4, 5]],
    'the gapped hop is never spliced into a route');
});

test('a corridor is a route that was actually flown end to end', () => {
  // Never assembled from "most likely next hop" chained together — that produces
  // plausible routes nobody ever flew.
  const s = store();
  const walk = (day, key) => {
    s.noteSighting(hop(at(day, 20, 0), key, 1, 2));
    s.noteSighting(hop(at(day, 20, 3), key, 2, 3));
    s.noteSighting(hop(at(day, 20, 6), key, 3, 4));
  };
  walk(0, 'p:a'); walk(1, 'p:a'); walk(2, 'p:b');

  const a = s.analyse({ now: at(3, 0) });
  assert.strictEqual(a.corridors.length, 1, 'sub-paths of the full route are folded in');
  assert.deepStrictEqual(a.corridors[0].systems, [1, 2, 3, 4]);
  assert.strictEqual(a.corridors[0].n, 3);
  assert.strictEqual(a.corridors[0].days, 3);
  assert.strictEqual(a.corridors[0].contacts, 2);
});

test('one gang going back and forth in an afternoon is not a corridor', () => {
  // Three passes, one contact, one day. Frequent, but it is one gang's evening —
  // not a route that others use or that recurs.
  const s = store();
  for (const m of [0, 40, 80]) {
    s.noteSighting(hop(at(0, 14, m),     'p:solo', 1, 2));
    s.noteSighting(hop(at(0, 14, m + 3), 'p:solo', 2, 3));
  }
  assert.deepStrictEqual(store().analyse({ now: at(1, 0) }).corridors, []);
  assert.deepStrictEqual(s.analyse({ now: at(1, 0) }).corridors, []);
});

test('containment pruning is not fooled by ids that share a suffix', () => {
  // "10>11>12" is a substring of "110>11>12". Matching without delimiters would
  // silently drop a real corridor whenever one id ended with another.
  const legs = [];
  for (let d = 0; d < 3; d++) {
    legs.push({ t: at(d, 1, 0), a: 110, b: 11, k: `p:${d}` });
    legs.push({ t: at(d, 1, 2), a: 11,  b: 12, k: `p:${d}` });
    legs.push({ t: at(d, 3, 0), a: 10,  b: 11, k: `p:${d}` });
    legs.push({ t: at(d, 3, 2), a: 11,  b: 12, k: `p:${d}` });
  }
  const found = corridors(buildWalks(legs, DEFAULTS), DEFAULTS).map(c => c.systems.join('>'));
  assert.deepStrictEqual(found.sort(), ['10>11>12', '110>11>12'], 'both survive');
});

test('entry points are where contacts first appear', () => {
  const s = store();
  for (let d = 0; d < 4; d++) {
    s.noteSighting(hop(at(d, 5), `p:${d}`, 900, 901));
    s.noteSighting(hop(at(d, 5, 2), `p:${d}`, 901, 902));
  }
  const a = s.analyse({ now: at(5, 0), systemNameFor: (id) => `SYS-${id}` });
  assert.strictEqual(a.entries.length, 1);
  assert.strictEqual(a.entries[0].systemId, 900);
  assert.strictEqual(a.entries[0].n, 4);
  assert.strictEqual(a.entries[0].name, 'SYS-900');
});

test('system names fall back to an id when the SDE has no answer', () => {
  const s = store();
  for (let d = 0; d < 4; d++) {
    s.noteSighting(hop(at(d, 5), `p:${d}`, 900, 901));
    s.noteSighting(hop(at(d, 5, 2), `p:${d}`, 901, 902));
  }
  assert.strictEqual(s.analyse({ now: at(5, 0) }).entries[0].name, 'System 900');
});

// ── What gets recorded ────────────────────────────────────────────────────────

test('presence comes from system tracks, movement from pilot tracks', () => {
  // Both, and only these. Recording presence per pilot too would count an hour
  // as busy in proportion to how many names a reporter bothered to type.
  const s = store();
  s.noteSighting(sysSighting(at(0, 1)));
  s.noteSighting({ ts: at(0, 1), kind: 'pilot', key: 'p:a', systemId: 5, prevSystemId: null });
  s.noteSighting(hop(at(0, 2), 'p:a', 5, 6));
  assert.deepStrictEqual(s.size, { presence: 1, legs: 1 });
});

test('a pilot re-reported in the system it is already in records no movement', () => {
  const s = store();
  s.noteSighting(hop(at(0, 1), 'p:a', 5, 5));
  assert.deepStrictEqual(s.size, { presence: 0, legs: 0 });
});

test('malformed sightings are dropped rather than stored', () => {
  const s = store();
  s.noteSighting({});
  s.noteSighting({ ts: NaN, kind: 'system', systemId: 1 });
  s.noteSighting({ ts: at(0, 1), kind: 'system', systemId: undefined });
  assert.deepStrictEqual(s.size, { presence: 0, legs: 0 });
});

// ── Durability ────────────────────────────────────────────────────────────────

test('history older than the window is forgotten', () => {
  // Patterns go stale. The alliance that lived next door last quarter is not
  // evidence about tonight.
  const s = store();
  s.noteSighting(sysSighting(at(0, 20)));
  s.noteSighting(sysSighting(at(40, 20)));
  const a = s.analyse({ now: at(41, 0) });
  assert.strictEqual(a.sightings, 1, 'the 41-day-old sighting is gone');
});

test('the store is bounded, keeping the newest', () => {
  const s = store({ maxLegs: 3, maxPresence: 2 });
  for (let i = 0; i < 6; i++) s.noteSighting(hop(at(0, 1, i), 'p:a', 100 + i, 101 + i));
  for (let i = 0; i < 6; i++) s.noteSighting(sysSighting(at(0, 2, i), 200 + i));
  assert.deepStrictEqual(s.size, { presence: 2, legs: 3 });
  const snap = s.snapshot();
  assert.strictEqual(snap.legs[snap.legs.length - 1].a, 105, 'newest survived');
  assert.strictEqual(snap.presence[snap.presence.length - 1].s, 205);
});

test('history round-trips through save and load', () => {
  let saved = null;
  const a = createPatternStore({ save: (snap) => { saved = snap; } });
  for (let d = 0; d < 6; d++) a.noteSighting(sysSighting(at(d, 21)));
  a.flush();
  assert.ok(saved && saved.presence.length === 6);

  const b = createPatternStore({ load: () => saved });
  assert.strictEqual(b.analyse({ now: at(6, 0) }).hours[21].days, 6);
});

test('a corrupt or hand-edited history costs the history, not the launch', () => {
  const throws = createPatternStore({ load: () => { throw new Error('unexpected token'); } });
  assert.deepStrictEqual(throws.size, { presence: 0, legs: 0 });

  const junk = createPatternStore({ load: () => ({ presence: 'not an array', legs: [{ nope: 1 }] }) });
  assert.deepStrictEqual(junk.size, { presence: 0, legs: 0 });
  assert.doesNotThrow(() => junk.analyse({ now: at(0, 0) }));
});

test('a failing save never propagates into the intel pipeline', () => {
  const s = createPatternStore({ save: () => { throw new Error('disk full'); } });
  s.noteSighting(sysSighting(at(0, 1)));
  assert.doesNotThrow(() => s.flush());
});

test('clearing forgets everything — for a move to new space', () => {
  const s = store();
  for (let d = 0; d < 6; d++) s.noteSighting(sysSighting(at(d, 21)));
  s.clear();
  assert.deepStrictEqual(s.size, { presence: 0, legs: 0 });
});

// ── Wiring into the tracker ───────────────────────────────────────────────────

test('the tracker reports each accepted sighting, with adjacency resolved', () => {
  // 1–2–3 in a line, 9 off on its own. The tracker owns the gate graph, so it
  // is the only place that can tell a jump from a gap in reporting.
  const adjacency = buildAdjacency([{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 9 }]);
  const seen = [];
  const t = createProximityTracker({ adjacency, onSighting: (s) => seen.push(s) });
  t.setOrigin(1);

  const report = (ts, systemId, pilots) =>
    t.ingest({ ts, systemId, systemName: `S${systemId}`, pilots, status: 'hostile' });

  report(at(0, 1, 0), 3, ['Roamer']);
  report(at(0, 1, 1), 2, ['Roamer']);          // 3 -> 2 is a real gate
  const moves = seen.filter(s => s.kind === 'pilot' && s.prevSystemId != null);
  assert.strictEqual(moves.length, 1);
  assert.deepStrictEqual(
    { from: moves[0].prevSystemId, to: moves[0].systemId, adjacent: moves[0].adjacent },
    { from: 3, to: 2, adjacent: true });

  seen.length = 0;
  report(at(0, 1, 3), 9, ['Roamer']);          // 2 -> 9 shares no gate
  const gap = seen.find(s => s.kind === 'pilot' && s.prevSystemId != null);
  assert.strictEqual(gap.adjacent, false, 'a two-jump gap is not a transition');

  assert.ok(seen.some(s => s.kind === 'system'), 'the system track reports too');
});

test('echoed reports do not become sightings', () => {
  // Six people reporting one gang across four channels is one sighting. Feeding
  // the raw lines to the history would make an hour look busy in proportion to
  // how many people were awake to type.
  const adjacency = buildAdjacency([{ from: 1, to: 2 }]);
  const seen = [];
  const t = createProximityTracker({ adjacency, onSighting: (s) => seen.push(s) });
  t.setOrigin(1);
  for (let i = 0; i < 6; i++) {
    t.ingest({ ts: at(0, 1, 0) + i * 1000, systemId: 2, systemName: 'S2',
               pilots: ['Roamer'], status: 'hostile' });
  }
  assert.strictEqual(seen.filter(s => s.kind === 'system').length, 1);
});

// ── End to end, through the real service ──────────────────────────────────────

// A small slice of null, wired the way intel_service expects the SDE to answer.
const SDE = {
  async all(sql) {
    if (/mapSolarSystemJumps/.test(sql)) {
      return [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }];
    }
    if (/invTypes/.test(sql)) return [{ n: 'Sabre', grp: 'Interdictor' }];
    return [
      { id: 1, name: 'EKPB-3', regionId: 10, regionName: 'Insmother' },
      { id: 2, name: '5M2-KP', regionId: 10, regionName: 'Insmother' },
      { id: 3, name: 'TK-DLH', regionId: 10, regionName: 'Insmother' },
      { id: 4, name: 'AGCP-I', regionId: 10, regionName: 'Insmother' },
    ];
  },
};

/** A history in which anything leaving TK-DLH goes to 5M2-KP — toward home. */
function seededHistory() {
  const legs = [];
  for (let d = 0; d < 6; d++) legs.push({ t: at(d, 20), a: 3, b: 2, k: `p:roamer${d}` });
  return { version: 1, presence: [], legs };
}

/**
 * A chat line dated just now, in EVE's log format (UTC).
 *
 * Live contacts age out after 15 minutes, so a fixture line dated to a fixed
 * calendar day is pruned the instant it lands and contacts() comes back empty —
 * which reads as "the pipeline is broken" rather than "the fixture is stale".
 */
const evLine = (body, secondsAgo = 0) => {
  const d = new Date(Date.now() - secondsAgo * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `[ ${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ] Scout > ${body}`;
};
const CHAN = { channel: 'test.imperium', regions: ['Insmother'] };

test('a live contact carries where it has historically gone next', async () => {
  const { createIntelService } = require('../src/intel/intel_service');
  const svc = createIntelService({
    getSdeDb: () => SDE,
    loadPatterns: () => seededHistory(),
    savePatterns: () => {},
  });
  await svc.init();
  svc.setOrigin(1);   // home is EKPB-3

  svc._handleLine(evLine('TK-DLH Roamer sabre'), CHAN);

  const contact = svc.contacts().find(c => c.kind === 'pilot');
  assert.ok(contact, 'the pilot was tracked');
  assert.strictEqual(contact.predict.systemName, '5M2-KP');
  assert.strictEqual(contact.predict.days, 6);
  assert.strictEqual(contact.predict.share, 1);
  // The only version of this that changes a decision: the habit points at us.
  assert.strictEqual(contact.predict.jumps, 1);
  assert.strictEqual(contact.predict.closer, true, 'TK-DLH is 2 out, 5M2-KP is 1');
});

test('a system nothing is known about gets no prediction at all', async () => {
  const { createIntelService } = require('../src/intel/intel_service');
  const svc = createIntelService({ getSdeDb: () => SDE, loadPatterns: () => seededHistory() });
  await svc.init();
  svc.setOrigin(1);

  svc._handleLine(evLine('AGCP-I Someone'), CHAN);
  const contacts = svc.contacts();
  assert.ok(contacts.length, 'the contact was tracked — it just has no history');
  for (const c of contacts) {
    assert.strictEqual(c.predict, undefined, `${c.label} should have no heading`);
  }
});

test('watching feeds the history, and the history survives a restart', async () => {
  const { createIntelService } = require('../src/intel/intel_service');
  let disk = null;
  const first = createIntelService({
    getSdeDb: () => SDE, loadPatterns: () => disk, savePatterns: (s) => { disk = s; },
  });
  await first.init();
  first.setOrigin(1);
  first._handleLine(evLine('TK-DLH Roamer', 60), CHAN);
  first._handleLine(evLine('5M2-KP Roamer', 0),  CHAN);
  first.stop();     // flushes

  assert.ok(disk && disk.legs.length === 1, 'the move was recorded');
  assert.strictEqual(disk.legs[0].a, 3);
  assert.strictEqual(disk.legs[0].b, 2);

  const second = createIntelService({ getSdeDb: () => SDE, loadPatterns: () => disk });
  await second.init();
  assert.strictEqual(second.patterns().movements, 1, 'a restart keeps what was learned');
});

// ── The pure helpers, directly ────────────────────────────────────────────────

test('bucketPattern reports every bucket, flagging only the ones that clear the bar', () => {
  const rows = [];
  for (let d = 0; d < 8; d++) rows.push({ t: at(d, 6) });
  const { buckets, daysObserved, baseline } = bucketPattern(rows, (ts) => new Date(ts).getUTCHours(), 24, DEFAULTS);
  assert.strictEqual(buckets.length, 24, 'the whole distribution, for the chart');
  assert.strictEqual(daysObserved, 8);
  assert.ok(Math.abs(baseline - 1 / 24) < 1e-9);
  assert.strictEqual(buckets[6].notable, true);
  assert.strictEqual(buckets.filter(b => b.notable).length, 1);
});

// ── Grouping the flagged hours ────────────────────────────────────────────────

const hourRow = (bucket, days, notable) =>
  ({ bucket, days, notable, label: `${String(bucket).padStart(2, '0')}:00` });

test('consecutive flagged hours become one block, loudest first', () => {
  // 19:00-21:00 is one evening, not three findings.
  const rows = Array.from({ length: 24 }, (_, h) => hourRow(h, 0, false));
  for (const h of [19, 20, 21]) Object.assign(rows[h], { days: 10, notable: true });
  Object.assign(rows[16], { days: 6, notable: true });

  const blocks = hourBlocks(rows);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].label, '19:00–21:00', 'the busiest block leads');
  assert.deepStrictEqual(blocks[0].hours, [19, 20, 21]);
  assert.strictEqual(blocks[0].daysLo, 10);
  assert.strictEqual(blocks[1].label, '16:00', 'a lone hour keeps a single label');
});

test('a block that straddles midnight stays one block', () => {
  // UTC prime time crosses midnight for a good part of the playerbase, and a
  // 23:00–01:00 run split in two reads as two unrelated findings.
  const rows = Array.from({ length: 24 }, (_, h) => hourRow(h, 0, false));
  for (const h of [23, 0, 1]) Object.assign(rows[h], { days: 7, notable: true });

  const blocks = hourBlocks(rows);
  assert.strictEqual(blocks.length, 1);
  assert.deepStrictEqual(blocks[0].hours, [23, 0, 1]);
  assert.strictEqual(blocks[0].label, '23:00–01:00');
});

test('hourBlocks copes with none flagged and with every hour flagged', () => {
  const none = Array.from({ length: 24 }, (_, h) => hourRow(h, 1, false));
  assert.deepStrictEqual(hourBlocks(none), []);
  assert.deepStrictEqual(hourBlocks([]), []);

  // Can't happen through the significance test, but the wrap-around rewind must
  // still terminate rather than circling the clock forever.
  const all = Array.from({ length: 24 }, (_, h) => hourRow(h, 9, true));
  const blocks = hourBlocks(all);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].hours.length, 24);
});

test('analyse hands the UI the blocks already grouped', () => {
  const s = store();
  for (let d = 0; d < 8; d++) {
    for (const h of [19, 20]) s.noteSighting(sysSighting(at(d, h)));
    s.noteSighting(sysSighting(at(d, (d * 3) % 12)));
  }
  const a = s.analyse({ now: at(9, 0) });
  assert.strictEqual(a.hourBlocks[0].label, '19:00–20:00');
  assert.strictEqual(a.hourBlocks[0].daysHi, 8);
});

test('routeStats counts gate transitions and ignores gapped ones', () => {
  const stats = routeStats([
    { t: at(0, 1), a: 1, b: 2, k: 'p:a' },
    { t: at(0, 2), a: 1, b: 2, k: 'p:b' },
    { t: at(0, 3), a: 1, b: 3, k: 'p:c' },
    { t: at(0, 4), a: 1, b: 9, k: 'p:d', g: 1 },
  ], DEFAULTS);
  assert.strictEqual(stats.get(1).occasions, 3, 'the gapped hop is not a transition');
  assert.strictEqual(stats.get(1).to.get(2).occasions, 2);
  assert.strictEqual(stats.get(1).to.get(2).keys.size, 2);
  assert.strictEqual(stats.get(1).to.has(9), false);
});

test('countOccasions collapses movements that happened together', () => {
  const t0 = at(0, 12);
  assert.strictEqual(countOccasions([], DEFAULTS.occasionGapMs), 0);
  assert.strictEqual(countOccasions([t0, t0 + 1000, t0 + 2000], DEFAULTS.occasionGapMs), 1,
    'one gang moving is one event');
  assert.strictEqual(countOccasions([t0, t0 + 10 * 60_000], DEFAULTS.occasionGapMs), 2);
  // Clustered by gap rather than bucketed by the clock: a gang that moves across
  // a round-number boundary must not split into two events.
  const boundary = Math.ceil(t0 / DEFAULTS.occasionGapMs) * DEFAULTS.occasionGapMs;
  assert.strictEqual(countOccasions([boundary - 2000, boundary + 2000], DEFAULTS.occasionGapMs), 1);
  assert.strictEqual(countOccasions([t0 + 5000, t0], DEFAULTS.occasionGapMs), 1, 'order does not matter');
});

test('entryPoints needs repetition before naming a way in', () => {
  const walks = [{ key: 'p:a', ts: at(0, 1), systems: [1, 2] },
                 { key: 'p:b', ts: at(1, 1), systems: [1, 2] }];
  assert.deepStrictEqual(entryPoints(walks, DEFAULTS), [], 'twice is not a habit');
  walks.push({ key: 'p:c', ts: at(2, 1), systems: [1, 2] });
  assert.strictEqual(entryPoints(walks, DEFAULTS)[0].systemId, 1);
});
