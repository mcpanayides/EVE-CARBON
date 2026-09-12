'use strict';
//
// One tally, two surfaces.
//
// The Planetary Networks status strip and the dashboard's PI tile both count
// colonies by state. They used to do it twice — the dashboard carried its own
// loop under a comment promising it matched "the same logic as the PI page",
// with nothing enforcing that. The two had already drifted: the dashboard parsed
// `storage_json` (how the character DB stores it) and the page only understood
// `storage` (how the live sync returns it), so the same colony could be "storage
// full" on one screen and "idle" on the other.
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
  return sb;
}

const NOW = Date.parse('2026-09-02T12:00:00Z');
const hours = (n) => NOW + n * 3_600_000;

test('a colony is counted once, in the state it is actually in', () => {
  const S = load();
  const t = S.piTally([
    { extractor_expires_at: hours(60) },                          // extracting
    { extractor_expires_at: hours(6) },                           // extracting AND expiring
    { extractor_expires_at: 0, storage: [{ fill_pct: 97 }] },     // storage full
    { extractor_expires_at: 0, storage: [{ fill_pct: 10 }] },     // idle
  ], NOW);
  assert.strictEqual(t.total, 4);
  assert.strictEqual(t.extracting, 2);
  assert.strictEqual(t.storageFull, 1);
  assert.strictEqual(t.idle, 1);
  // extracting + storageFull + idle accounts for every colony exactly once.
  assert.strictEqual(t.extracting + t.storageFull + t.idle, t.total);
});

test('expiring is a SUBSET of extracting, not a fourth bucket', () => {
  // A colony running out in six hours is still extracting. The four numbers
  // deliberately do not sum to the total, and a test that asserted they did
  // would be asserting the wrong model.
  const S = load();
  const t = S.piTally([{ extractor_expires_at: hours(6) }], NOW);
  assert.strictEqual(t.extracting, 1);
  assert.strictEqual(t.expiring, 1);
  assert.strictEqual(t.idle, 0);

  const far = S.piTally([{ extractor_expires_at: hours(48) }], NOW);
  assert.strictEqual(far.extracting, 1);
  assert.strictEqual(far.expiring, 0, '48h out is not expiring');
});

test('the 24-hour boundary is inclusive and does not drift', () => {
  const S = load();
  assert.strictEqual(S.piTally([{ extractor_expires_at: hours(24) }], NOW).expiring, 1);
  assert.strictEqual(S.piTally([{ extractor_expires_at: hours(24.1) }], NOW).expiring, 0);
});

test('an expired extractor is idle, not extracting', () => {
  const S = load();
  const t = S.piTally([{ extractor_expires_at: hours(-1) }], NOW);
  assert.strictEqual(t.extracting, 0);
  assert.strictEqual(t.idle, 1);
});

test('storage counts the same whichever shape the row arrived in', () => {
  // THE divergence this function exists to close. The PI page gets `storage` as
  // an array from the live sync; the dashboard gets `storage_json` as a string
  // from the character DB. Both are the same colony.
  const S = load();
  const asArray  = S.piTally([{ extractor_expires_at: 0, storage: [{ fill_pct: 92 }] }], NOW);
  const asJson   = S.piTally([{ extractor_expires_at: 0, storage_json: '[{"fill_pct":92}]' }], NOW);
  assert.strictEqual(asArray.storageFull, 1);
  assert.strictEqual(asJson.storageFull, 1, 'the DB shape must count too');
  assert.deepStrictEqual(Object.entries(asArray).map(String), Object.entries(asJson).map(String));
});

test('90% is the threshold, and below it is idle rather than full', () => {
  const S = load();
  assert.strictEqual(S.piTally([{ extractor_expires_at: 0, storage: [{ fill_pct: 90 }] }], NOW).storageFull, 1);
  assert.strictEqual(S.piTally([{ extractor_expires_at: 0, storage: [{ fill_pct: 89.9 }] }], NOW).storageFull, 0);
  assert.strictEqual(S.piTally([{ extractor_expires_at: 0, storage: [{ fill_pct: 89.9 }] }], NOW).idle, 1);
  // Any one full silo is enough; it does not need to be the first.
  assert.strictEqual(S.piTally([{ extractor_expires_at: 0,
    storage: [{ fill_pct: 3 }, { fill_pct: 99 }] }], NOW).storageFull, 1);
});

test('malformed or missing rows never throw and never miscount', () => {
  // Colony rows come from a DB and from ESI; neither is guaranteed well-formed,
  // and a status strip that throws takes the whole page with it.
  const S = load();
  const t = S.piTally([
    null,
    undefined,
    {},                                                   // no extractor, no storage -> idle
    { extractor_expires_at: 0, storage_json: 'not json' },// unparseable -> idle
    { extractor_expires_at: 0, storage: 'nonsense' },     // wrong type  -> idle
    { extractor_expires_at: 0, storage: [null] },         // null entry  -> idle
  ], NOW);
  assert.strictEqual(t.total, 4, 'null rows are not colonies');
  assert.strictEqual(t.idle, 4);
  assert.strictEqual(t.storageFull, 0);
  assert.strictEqual(S.piTally(null, NOW).total, 0);
  assert.strictEqual(S.piTally([], NOW).total, 0);
});

test('the strip renders a lamp per state and darkens the zeros', () => {
  const S = load();
  const html = S.piStatusStripHtml({ total: 12, extracting: 12, expiring: 0, storageFull: 0, idle: 0 });
  assert.match(html, /sig-light sig-go(?!.*is-off)/, 'green is lit when something is extracting');
  // A red lamp glowing beside a zero reads as an alarm when nothing is wrong.
  assert.match(html, /sig-light sig-stop is-off/, 'idle 0 must be dark');
  assert.match(html, /sig-light sig-hold is-off/);
  // Colour is never the only cue — every lamp carries its word.
  for (const word of ['EXTRACTING', 'EXPIRING 24H', 'STORAGE FULL', 'IDLE']) {
    assert.ok(html.includes(word), word);
  }
  assert.match(html, /12 colonies/);
});

test('one colony is not "1 colonies"', () => {
  const S = load();
  assert.match(S.piStatusStripHtml({ total: 1, extracting: 1, expiring: 0, storageFull: 0, idle: 0 }), /1 colony/);
});
