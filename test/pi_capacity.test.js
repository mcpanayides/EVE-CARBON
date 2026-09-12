'use strict';
//
// Free planet slots.
//
// Max planets per character is 1 + Interplanetary Consolidation (2495), so
// 1..6. The whole feature turns on one distinction that is easy to get wrong:
// a character whose skills have never synced is NOT a character with no skills.
// Both arrive as an empty map, and reading that as level 0 gives a working
// six-colony alt a capacity of 1 — which renders as "-3 free", a number that
// cannot happen in the game. So the tests below spend most of their time on
// the ambiguous and clamped cases rather than the happy path.
const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

function load() {
  const noop = () => {};
  const sb = {
    console, Math, Date, JSON, Map, Set, Promise, Object, Array, String, Number,
    Boolean, RegExp, Error, isNaN, parseFloat, parseInt, setTimeout, clearTimeout,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { eveAPI: {}, addEventListener: noop },
    escHtml: (s) => String(s),
    localStorage: { getItem: () => null, setItem: noop },
    fetch: () => Promise.reject(new Error('no net')),
  };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'func', 'planetary-interaction.js'), 'utf8'),
    ctx, { filename: 'planetary-interaction.js' });
  // `let` bindings live in the context's global lexical scope rather than on the
  // sandbox object, so module state is reachable only by running code in the
  // same context — not by assigning through `sb`.
  sb.__set = (src) => vm.runInContext(src, ctx);
  return sb;
}

// ─── piSlotCapacity ──────────────────────────────────────────────────────────

test('an untrained pilot still gets the one planet everyone starts with', () => {
  const S = load();
  // A map with other skills in it proves the character HAS synced; 2495 simply
  // is not among them, which is a real level of zero.
  const c = S.piSlotCapacity({ 3380: 5, 3426: 5 }, 0);
  assert.strictEqual(c.known, true);
  assert.strictEqual(c.capacity, 1);
  assert.strictEqual(c.free, 1);
});

test('each level of Interplanetary Consolidation is one more planet', () => {
  const S = load();
  for (let lvl = 0; lvl <= 5; lvl++) {
    assert.strictEqual(S.piSlotCapacity({ 2495: lvl }, 0).capacity, lvl + 1, `level ${lvl}`);
  }
});

test('six colonies on a level V pilot is full, not over', () => {
  const S = load();
  const c = S.piSlotCapacity({ 2495: 5 }, 6);
  assert.strictEqual(c.capacity, 6);
  assert.strictEqual(c.used, 6);
  assert.strictEqual(c.free, 0);
});

test('never-synced skills read as unknown, not as zero', () => {
  const S = load();
  for (const empty of [null, undefined, {}]) {
    const c = S.piSlotCapacity(empty, 4);
    assert.strictEqual(c.known, false, String(empty));
    assert.strictEqual(c.capacity, null);
    assert.strictEqual(c.free, null);
    // The colony count is still real even when the ceiling is not.
    assert.strictEqual(c.used, 4);
  }
});

test('more colonies than capacity clamps to zero free, never negative', () => {
  const S = load();
  // Happens when the skill read is older than the colony read. "-3 free" is not
  // a state the game can be in, so it must not be a state we can render.
  const c = S.piSlotCapacity({ 2495: 0 }, 4);
  assert.strictEqual(c.free, 0);
  assert.ok(c.free >= 0);
});

test('a nonsense skill level cannot inflate the ceiling past six', () => {
  const S = load();
  assert.strictEqual(S.piSlotCapacity({ 2495: 99 }, 0).capacity, 6);
  assert.strictEqual(S.piSlotCapacity({ 2495: -3 }, 0).capacity, 1);
});

test('the batched read states syncedness instead of inferring it', () => {
  const S = load();
  // The per-character read can only infer "synced" from having rows; the
  // batched one knows. A profile carrying explicit levels but synced:false is a
  // character we have never read — it must not be reported as trained to zero.
  const unsynced = S.piSlotCapacity({ 2495: 0, 2505: 0 }, 0, false);
  assert.strictEqual(unsynced.known, false);
  assert.strictEqual(unsynced.capacity, null);

  const synced = S.piSlotCapacity({ 2495: 0, 2505: 0 }, 0, true);
  assert.strictEqual(synced.known, true);
  assert.strictEqual(synced.capacity, 1);
});

test('capacity carries the command centre level, not just the slot count', () => {
  const S = load();
  // Two different skills: 2495 buys more planets, 2505 buys a bigger one.
  const c = S.piSlotCapacity({ 2495: 5, 2505: 3 }, 2, true);
  assert.strictEqual(c.capacity, 6, 'six slots from Interplanetary Consolidation V');
  assert.strictEqual(c.ic, 5);
  assert.strictEqual(c.ccu, 3, 'and an Improved command centre');
  assert.strictEqual(c.free, 4);
});

// ─── piCapacitySummary ───────────────────────────────────────────────────────

test('the summary counts only what it actually knows', () => {
  const S = load();
  S.__set(`
    _piAllCharData = [
      { charId: 1, charName: 'Full',    colonies: [1,2,3,4,5,6] },
      { charId: 2, charName: 'Roomy',   colonies: [1,2] },
      { charId: 3, charName: 'Empty',   colonies: [] },
      { charId: 4, charName: 'Unknown', colonies: [1] },
    ];
    _piCapacities = {
      1: piSlotCapacity({ 2495: 5 }, 6),
      2: piSlotCapacity({ 2495: 5 }, 2),
      3: piSlotCapacity({ 2495: 5 }, 0),
      4: piSlotCapacity(null, 1),
    };
  `);
  const sum = S.piCapacitySummary();
  assert.strictEqual(sum.freeSlots, 10, '4 free + 6 free; the unknown adds nothing');
  assert.strictEqual(sum.freeChars, 2);
  assert.strictEqual(sum.unknown, 1);
});

test('a character with no colonies is counted, not dropped', () => {
  const S = load();
  // The whole point of the feature: this character used to be filtered out of
  // the page entirely, taking six free slots with them.
  S.__set(`
    _piAllCharData = [{ charId: 9, charName: 'Idle Alt', colonies: [] }];
    _piCapacities  = { 9: piSlotCapacity({ 2495: 5 }, 0) };
  `);
  const sum = S.piCapacitySummary();
  assert.strictEqual(sum.rows.length, 1);
  assert.strictEqual(sum.freeSlots, 6);
});

// ─── the load race ───────────────────────────────────────────────────────────

test('opening a tab mid-load still reads capacities', async () => {
  // loadPlanetaryInteraction assigns _piAllCharData and only THEN awaits the
  // skill read. Anything that guarded on "are there characters yet" would sail
  // through that window and render every row as unknown — which is exactly what
  // clicking Capacity while Colonies was still settling used to do.
  const S = load();
  let calls = 0;
  S.window.eveAPI.piCapacities = async (ids) => {
    calls++;
    return Object.fromEntries(ids.map(id => [id, { ic: 4, ccu: 3, synced: true }]));
  };
  S.__set(`
    _piAllCharData = [{ charId: 1, charName: 'Mid Load', colonies: [1, 2] }];
    _piCapacities  = {};
  `);

  await S._piEnsureNetwork();
  assert.strictEqual(calls, 1, 'characters present but capacities empty must still load');

  const sum = S.piCapacitySummary();
  assert.strictEqual(sum.rows[0].known, true);
  assert.strictEqual(sum.freeSlots, 3, 'five slots at IC IV, two used');

  // Already loaded — no second round-trip.
  await S._piEnsureNetwork();
  assert.strictEqual(calls, 1);
});

// ─── piCapacityRowHtml ───────────────────────────────────────────────────────

function summary(rows) {
  const known = rows.filter(r => r.known);
  return {
    rows,
    freeSlots: known.reduce((n, r) => n + r.free, 0),
    freeChars: known.filter(r => r.free > 0).length,
    unknown:   rows.length - known.length,
  };
}
const row = (charName, used, capacity) =>
  ({ charName, known: true, used, capacity, free: Math.max(0, capacity - used) });

test('chips are ordered by how much room there is, widest first', () => {
  const S = load();
  const html = S.piCapacityRowHtml(summary([
    row('OneFree', 5, 6), row('SixFree', 0, 6), row('ThreeFree', 3, 6),
  ]));
  const order = [...html.matchAll(/pi-cap-name">([^<]+)</g)].map(m => m[1]);
  assert.strictEqual(order.join(','), 'SixFree,ThreeFree,OneFree');
});

test('a character with nothing free gets no chip', () => {
  const S = load();
  const html = S.piCapacityRowHtml(summary([row('Full', 6, 6), row('Roomy', 1, 6)]));
  assert.ok(!html.includes('Full'), 'a full character is not an answer to "who?"');
  assert.ok(html.includes('Roomy'));
});

test('pips show every slot, filled for the ones in use', () => {
  const S = load();
  const html = S.piCapacityRowHtml(summary([row('Mixed', 2, 6)]));
  const chip = html.slice(html.indexOf('pi-cap-pips'));
  assert.strictEqual((chip.match(/class="pi-pip[ "]/g) || []).length, 6, 'one pip per slot');
  assert.strictEqual((chip.match(/pi-pip is-used/g) || []).length, 2, 'two of them used');
});

test('having no room at all says so rather than rendering an empty row', () => {
  const S = load();
  // An empty row reads as "not loaded yet" just as easily as "nothing free".
  const html = S.piCapacityRowHtml(summary([row('Full', 6, 6)]));
  assert.match(html, /Every planet slot is in use/);
});

test('unsynced characters are declared, not silently omitted', () => {
  const S = load();
  const html = S.piCapacityRowHtml(summary([
    row('Roomy', 1, 6),
    { charName: 'Stale', known: false, used: 2, capacity: null, free: null },
  ]));
  assert.match(html, /1 not synced/);
});

// ─── the strip headline ──────────────────────────────────────────────────────

test('the strip leads with free slots when there are any', () => {
  const S = load();
  const tally = { total: 12, extracting: 12, expiring: 0, storageFull: 0, idle: 0 };
  assert.match(S.piStatusStripHtml(tally, { freeSlots: 7, freeChars: 3, unknown: 0, rows: [] }),
               /7 slots free/);
  assert.match(S.piStatusStripHtml(tally, { freeSlots: 1, freeChars: 1, unknown: 0, rows: [] }),
               /1 slot free/, 'singular');
});

test('the strip is unchanged when capacity is unknown or nil', () => {
  const S = load();
  const tally = { total: 12, extracting: 12, expiring: 0, storageFull: 0, idle: 0 };
  // Guards the dashboard, which calls this with one argument.
  for (const cap of [undefined, { freeSlots: 0, freeChars: 0, unknown: 0, rows: [] }]) {
    const html = S.piStatusStripHtml(tally, cap);
    assert.ok(!/slots? free/.test(html), 'nothing free is not worth a headline');
    assert.match(html, /12 colonies/);
  }
});
