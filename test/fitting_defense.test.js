'use strict';
//
// The defence panel has to describe ONE ship.
//
// The resist row was handed the BOOSTED resonances while the hp and ehp beside
// it were the base ones, so a fit under command bursts printed base hp, base ehp
// and boosted resists on a single line. Three numbers that cannot all be true at
// once: the stated ehp does not follow from the stated hp and resists, and
// comparing the row against the game's own defence window silently compares two
// different ships — which is exactly how it was found.
//
// Nothing about that is visible without a second source to check against, so it
// is pinned here.
const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

function loadSim() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'func', 'fitting.js'), 'utf8');
  const noop = () => {};
  const doc = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop, addEventListener: noop }),
    addEventListener: noop, body: {}, documentElement: { style: {} }, head: {},
  };
  const sb = {
    document: doc, window: { addEventListener: noop, eveAPI: {} }, console,
    setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: noop,
    navigator: { clipboard: {} }, Image: function () {},
    localStorage: { getItem: () => null, setItem: noop },
    Math, Date, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseFloat, parseInt, fetch: () => Promise.reject(new Error('no net')),
  };
  sb.globalThis = sb; sb.window.document = doc;
  vm.runInContext(src + '\n;globalThis.__x = { _fitState };\n', vm.createContext(sb), { filename: 'fitting.js' });
  sb._fitState = sb.__x._fitState;
  return sb;
}

// Resonance, not resist: 0.18 resonance is an 82% resist.
const RES = (em, th, kin, exp) => ({ em, th, kin, exp });

// ── Rounding ─────────────────────────────────────────────────────────────────

test('a resist is rounded, the way the game rounds it', () => {
  const S = loadSim();
  assert.strictEqual(S._fitResistPct(0.18), 82);
  // Truncating here would print 61 where the game prints 62, which is precisely
  // the kind of one-off that reads as "our numbers are wrong" across the board.
  assert.strictEqual(S._fitResistPct(0.385), 62, '61.5 rounds up, it does not floor');
  assert.strictEqual(S._fitResistPct(0.386), 61);
  assert.strictEqual(S._fitResistPct(1), 0, 'no resist at all is 0%, not blank');
  assert.strictEqual(S._fitResistPct(null), null);
});

// ── Base vs boosted ──────────────────────────────────────────────────────────

test('with no boost, the cell shows the base resist and claims nothing else', () => {
  const S = loadSim();
  const html = S._fitResistCells(RES(0.18, 0.23, 0.23, 0.32));
  assert.match(html, /82%/);
  assert.match(html, /77%/);
  assert.match(html, /68%/);
  assert.doesNotMatch(html, /fit-res-up/, 'no delta when there is nothing to add');
  assert.doesNotMatch(html, /fit-res-boost/, 'and no second fill');
});

test('the NUMBER is the base resist, never the boosted one', () => {
  // The whole defect in one assertion: boosted resonance 0.15 is an 85% resist,
  // and printing 85 beside base hp and base ehp is what made the panel
  // self-contradictory.
  const S = loadSim();
  const html = S._fitResistCells(RES(0.18, 0.23, 0.23, 0.32), RES(0.15, 0.20, 0.20, 0.29));
  assert.match(html, /82%/, 'base');
  assert.doesNotMatch(html, />85%/, 'the boosted value is not the headline number');
});

test('the boost is shown as a delta, and both values are named', () => {
  const S = loadSim();
  const html = S._fitResistCells(RES(0.18, 0.23, 0.23, 0.32), RES(0.15, 0.20, 0.20, 0.29));
  assert.match(html, /class="fit-res-up">\+3</, '82 → 85 is +3');
  assert.match(html, /title="82% base, 85% with command bursts"/,
    'the tooltip carries both, so the row is checkable against the game');
  assert.match(html, /fit-res-boost/, 'and the bar shows the reach of the boost');
});

test('a boost that changes nothing adds no delta', () => {
  // Structure takes no Armor/Shield Harmonizing burst, so its boosted resonance
  // equals its base. A "+0" on those four cells would be noise.
  const S = loadSim();
  const same = RES(0.39, 0.39, 0.39, 0.39);
  const html = S._fitResistCells(same, { ...same });
  assert.doesNotMatch(html, /fit-res-up/);
});

test('a boost is never rendered as a loss', () => {
  // Defensive: if a "boosted" set ever came through weaker, showing "-4" in
  // green next to a burst legend would be worse than showing nothing.
  const S = loadSim();
  const html = S._fitResistCells(RES(0.18, 0.18, 0.18, 0.18), RES(0.22, 0.22, 0.22, 0.22));
  assert.doesNotMatch(html, /fit-res-up/);
  assert.match(html, /82%/);
});

// ── The row ties the two together ────────────────────────────────────────────

test('a layer row prints its own hp and its own base resists', () => {
  const S = loadSim();
  const row = S._fitLayerRow('Armor', 5454784.7, RES(0.18, 0.23, 0.23, 0.32), '', '', RES(0.15, 0.20, 0.20, 0.29));
  assert.match(row, /Armor/);
  // Against _fitNum's own output, not a literal "5,454,784.7": it formats with
  // toLocaleString(undefined, …), so the separators follow the host locale. This
  // runner reports 5 454 784,7 where Electron reports 5,454,784.7, and hard-coding
  // either one makes the suite pass or fail on the machine's regional settings.
  assert.ok(row.includes(S._fitNum(5454784.7)), row.slice(0, 160));
  assert.match(row, /82%/, 'the resist beside that hp is the base one that produced the base ehp');
});

// ── EHP follows from what is shown ───────────────────────────────────────────

test('layer ehp is hp over the AVERAGE resonance', () => {
  const S = loadSim();
  // 82/77/77/68 → resonances 0.18/0.23/0.23/0.32, mean 0.24.
  const ehp = S._fitLayerEHP(1_000_000, RES(0.18, 0.23, 0.23, 0.32));
  assert.ok(Math.abs(ehp - 1_000_000 / 0.24) < 1, `${ehp}`);
});

test('a layer with no resists at all is its own hp, not infinity', () => {
  const S = loadSim();
  assert.strictEqual(S._fitLayerEHP(350_000, RES(null, null, null, null)), 350_000);
  assert.strictEqual(S._fitLayerEHP(0, RES(0.5, 0.5, 0.5, 0.5)), 0);
});

test('the ehp shown and the resists shown are the same ship', () => {
  // The invariant the bug broke, stated directly: whatever resonances the row
  // prints must be the ones the headline ehp was divided by.
  const S = loadSim();
  const base = RES(0.18, 0.23, 0.23, 0.32);
  const boosted = RES(0.15, 0.20, 0.20, 0.29);
  const hp = 5_454_784.7;

  const shownPct = [...S._fitResistCells(base, boosted).matchAll(/fit-res-val">(\d+)%/g)].map(m => Number(m[1]));
  const fromShown = shownPct.reduce((sum, p) => sum + (1 - p / 100), 0) / 4;
  const ehp = S._fitLayerEHP(hp, base);

  assert.ok(Math.abs(hp / fromShown - ehp) / ehp < 0.01,
    `ehp ${Math.round(ehp)} must follow from the printed resists (${shownPct.join('/')}), got ${Math.round(hp / fromShown)}`);
});
