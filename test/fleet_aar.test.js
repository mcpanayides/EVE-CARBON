'use strict';
//
// The after action report (Phase 3, TODO.md).
//
// This is the deliverable — the thing that gets pasted into a forum thread and
// read by people who were not there. Two properties matter more than looks:
//
//   • THE THREE FORMATS MUST AGREE. They render one model, so a number cannot
//     exist in Markdown and be missing from BBCode. Tested by asserting the
//     same facts appear in all three.
//   • WHAT WE COULD NOT SEE MUST BE STATED. A report that silently under-counts
//     is worse than one admitting a gap: nobody can tell the difference between
//     a quiet fleet and a broken pull.
const test   = require('node:test');
const assert = require('node:assert');

const aar = require('../src/fleet_aar');

const T = Date.parse('2026-08-17T19:00:00Z');
const M = 60_000;

const OP = { name: 'Rorqual Hunt', doctrine: 'shield', started_at: T,
             ended_at: T + 120 * M, end_reason: 'stopped', notes: null };

const NAMES = {
  systems:    { 30000142: 'Jita', 30002187: 'Amarr' },
  types:      { 640: 'Raven', 11202: 'Sabre', 28352: 'Rorqual', 1230: 'Veldspar' },
  characters: { 1001: 'Alpha', 1002: 'Bravo' },
};

const DATA = {
  op: OP,
  roster: [
    { character_id: 1001, ship_type_id: 640,   first_seen: T, last_seen: T + 100 * M },
    { character_id: 1002, ship_type_id: 11202, first_seen: T, last_seen: T + 100 * M },
    { character_id: 1003, ship_type_id: 11202, first_seen: T, last_seen: T + 100 * M },
  ],
  movement: [
    { at: T,          solar_system_id: 30000142, members_total: 40, dwellMs: 40 * M },
    { at: T + 40 * M, solar_system_id: 30002187, members_total: 38, dwellMs: 80 * M },
  ],
  kills: [
    { killmail_id: 1, at: T + 50 * M, side: 'kill', isk: 2.1e9, victim_ship_type_id: 28352, solar_system_id: 30002187 },
    { killmail_id: 2, at: T + 55 * M, side: 'loss', isk: 3.4e8, victim_ship_type_id: 11202, solar_system_id: 30002187 },
    { killmail_id: 3, at: T + 56 * M, side: 'loss', isk: 1.0e8, victim_ship_type_id: 11202, solar_system_id: 30002187 },
  ],
  names: NAMES,
};

const all = (d = DATA) => aar.render(d);

// ─── The model ────────────────────────────────────────────────────────────────

test('the model totals kills, losses and efficiency', () => {
  const { model } = all();
  assert.strictEqual(model.kills, 1);
  assert.strictEqual(model.losses, 2);
  assert.strictEqual(model.iskDestroyed, 2.1e9);
  assert.strictEqual(model.iskLost, 4.4e8);
  assert.ok(Math.abs(model.efficiency - (2.1e9 / (2.1e9 + 4.4e8))) < 1e-9);
});

test('kills are folded into the system the fleet held at the time', () => {
  // The spine of the report: an FC narrates a fleet as a sequence of places.
  const { model } = all();
  const [jita, amarr] = model.timeline;
  assert.strictEqual(jita.system, 'Jita');
  assert.strictEqual(jita.kills, 0, 'nothing happened in Jita');
  assert.strictEqual(amarr.system, 'Amarr');
  assert.strictEqual(amarr.kills, 1);
  assert.strictEqual(amarr.losses, 2);
  assert.strictEqual(model.unplaced, 0);
});

test('peak on grid comes from the samples, not the roster', () => {
  // The roster is everyone who was EVER in fleet; over three hours that badly
  // overstates how many were actually on grid.
  assert.strictEqual(all().model.peak, 40);
  assert.strictEqual(all().model.pilots, 3, 'distinct pilots in the roster');
});

test('hulls are counted, not listed one per pilot', () => {
  const { model } = all();
  assert.deepStrictEqual(model.hulls.map((h) => `${h.count}x ${h.name}`), ['2x Sabre', '1x Raven']);
});

test('a kill outside every dwell window is counted but flagged', () => {
  // In transit, or the poll had a gap. Dropping it would make the per-system
  // numbers disagree with the totals.
  const d = { ...DATA, kills: [...DATA.kills,
    { killmail_id: 9, at: T + 500 * M, side: 'kill', isk: 1e6, victim_ship_type_id: 640 }] };
  const { model, markdown } = all(d);
  assert.strictEqual(model.kills, 2, 'still in the totals');
  assert.strictEqual(model.unplaced, 1);
  assert.match(markdown, /outside the recorded system windows/);
});

// ─── All three formats carry the same facts ───────────────────────────────────

test('every format states the headline numbers', () => {
  const { markdown, bbcode, text } = all();
  for (const [name, out] of [['markdown', markdown], ['bbcode', bbcode], ['text', text]]) {
    assert.match(out, /Rorqual Hunt/,  `${name}: op name`);
    assert.match(out, /2\.10b/,        `${name}: ISK destroyed`);
    assert.match(out, /Amarr/,         `${name}: the system`);
    assert.match(out, /Jita/,          `${name}: and the other one`);
    assert.ok(/Sabre/.test(out),       `${name}: hulls fielded`);
  }
});

test('each format uses its own markup and never the others', () => {
  const { markdown, bbcode, text } = all();
  assert.match(markdown, /^# Rorqual Hunt/m);
  assert.ok(!markdown.includes('[/b]'), 'no BBCode leaking into Markdown');

  assert.match(bbcode, /\[b\]Rorqual Hunt\[\/b\]/);
  assert.ok(!/^#\s/m.test(bbcode), 'no Markdown headings in BBCode');
  assert.ok(!bbcode.includes('|---|'), 'no Markdown tables in BBCode — they paste as garbage');

  assert.ok(!text.includes('[/b]') && !/^#\s/m.test(text) && !text.includes('**'),
    'plain text carries no markup at all');
});

test('a fleet that never fought still reads as a report', () => {
  const quiet = { ...DATA, kills: [] };
  const { model, markdown, bbcode, text } = all(quiet);
  assert.strictEqual(model.efficiency, null, '0% would read as a slaughter; no fight is not a defeat');
  for (const out of [markdown, bbcode, text]) assert.match(out, /no engagements/i);
});

// ─── Mining, and the caveat it must never lose ────────────────────────────────

const MINING = {
  units: 4_200_000, isk: 8.4e8, fullyPriced: true,
  byType: [{ type_id: 1230, quantity: 4_200_000 }],
  bySystem: [{ solar_system_id: 30000142, quantity: 4_200_000 }],
  coverage: { pilotsInFleet: 41, pilotsMeasured: 3 },
};

test('a mining total NEVER appears without saying whose it is', () => {
  // The single most misreadable number in the report. "4.2m units" read as a
  // 41-pilot fleet total rather than 3 pilots' worth is not a small error.
  const { markdown, bbcode, text } = all({ ...DATA, mining: MINING });
  for (const [name, out] of [['markdown', markdown], ['bbcode', bbcode], ['text', text]]) {
    assert.match(out, /4,200,000/, `${name}: the quantity`);
    assert.match(out, /3 of 41 pilots/, `${name}: the coverage caveat must travel with it`);
    assert.match(out, /Veldspar/, `${name}: ore named`);
  }
});

test('a partly-priced haul says the ISK is a floor', () => {
  const { markdown } = all({ ...DATA, mining: { ...MINING, fullyPriced: false } });
  assert.match(markdown, /floor/i);
});

test('no mining section at all when there was no mining', () => {
  assert.ok(!all().markdown.includes('## Mined'));
});

// ─── Gaps are never silent ────────────────────────────────────────────────────

test('collection gaps are printed in every format', () => {
  const d = { ...DATA, gaps: ['2 systems were unreachable on zKillboard.'] };
  const { markdown, bbcode, text } = all(d);
  for (const out of [markdown, bbcode, text]) assert.match(out, /unreachable/);
});

test('an op that ended early says so', () => {
  const d = { ...DATA, op: { ...OP, end_reason: 'boss-handover' } };
  assert.match(all(d).markdown, /ended early \(boss-handover\)/);
});

test('a clean stop adds no scary caveat', () => {
  assert.ok(!all().markdown.includes('ended early'));
});

// ─── Formatting helpers ───────────────────────────────────────────────────────

test('ISK is readable at every scale', () => {
  assert.strictEqual(aar.fmtIsk(2.1e9), '2.10b');
  assert.strictEqual(aar.fmtIsk(3.4e8), '340.0m');
  assert.strictEqual(aar.fmtIsk(1.5e12), '1.50t');
  assert.strictEqual(aar.fmtIsk(null), '—', 'unknown is not zero');
});

test('duration reads the way an FC says it', () => {
  assert.strictEqual(aar.fmtDuration(21 * M), '21m');
  assert.strictEqual(aar.fmtDuration(134 * M), '2h 14m');
  assert.strictEqual(aar.fmtDuration(0), '0m');
});

test('repeated hulls are counted, not listed forty times', () => {
  const out = aar.summariseShips(['Sabre', 'Sabre', 'Sabre', 'Malediction']);
  assert.strictEqual(out, '3× Sabre, Malediction');
});

test('notes reach every format', () => {
  const d = { ...DATA, op: { ...OP, notes: 'Could not hold the Rorqual — no HICs.' } };
  const { markdown, bbcode, text } = all(d);
  for (const out of [markdown, bbcode, text]) assert.match(out, /no HICs/);
});
