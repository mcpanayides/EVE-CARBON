'use strict';
//
// The pure half of the tutorial: when it opens by itself, which steps apply,
// how they are counted, and where the spotlight, blockers and card go.
const test   = require('node:test');
const assert = require('node:assert');

const TM = require('../src/shared/tutorial_model');

// ─── first launch ─────────────────────────────────────────────────────────────

test('opens by itself on a first launch: never seen, no characters', () => {
  assert.strictEqual(TM.shouldAutoStart({ state: {}, accountCount: 0 }), true);
  assert.strictEqual(TM.shouldAutoStart({ state: undefined, accountCount: 0 }), true);
});

test('never opens by itself once seen, finished or not', () => {
  assert.strictEqual(TM.shouldAutoStart({ state: { seen: true }, accountCount: 0 }), false);
});

test('an upgrade with characters already added is not a first launch', () => {
  // Someone with a roster has set the app up already and did not ask for a tour.
  assert.strictEqual(TM.shouldAutoStart({ state: {}, accountCount: 3 }), false);
});

test('demo mode and e2e runs never open it by themselves', () => {
  assert.strictEqual(TM.shouldAutoStart({ state: {}, accountCount: 0, demo: true }), false);
  assert.strictEqual(TM.shouldAutoStart({ state: {}, accountCount: 0, suppress: true }), false);
});

// ─── which steps apply ────────────────────────────────────────────────────────

const STEPS = [
  { id: 'welcome' },
  { id: 'add',   chapter: 'Characters' },
  { id: 'sync',  chapter: 'Characters', when: ctx => !!ctx.added },
  { id: 'dash',  chapter: 'Dashboard' },
  { id: 'arrange', chapter: 'Dashboard', when: ctx => !!ctx.widget },
  { id: 'end' },
];

test('a step whose condition fails is skipped in both directions', () => {
  const ctx = { added: false, widget: false };
  assert.strictEqual(TM.nextIndex(STEPS, 1, +1, ctx), 3, 'no character added: sync is skipped');
  assert.strictEqual(TM.nextIndex(STEPS, 3, -1, ctx), 1, 'and Back skips it too');
  assert.strictEqual(TM.nextIndex(STEPS, 3, +1, ctx), 5);
  assert.strictEqual(TM.nextIndex(STEPS, 5, +1, ctx), -1, 'past the end is -1');
  assert.strictEqual(TM.nextIndex(STEPS, 0, -1, ctx), -1, 'before the start is -1');
});

test('conditions are asked again as the tour goes, not once at the start', () => {
  const ctx = { added: false };
  assert.strictEqual(TM.nextIndex(STEPS, 1, +1, ctx), 3);
  ctx.added = true;                       // the character arrived during the step
  assert.strictEqual(TM.nextIndex(STEPS, 1, +1, ctx), 2);
});

test('a condition that throws counts as not applying, instead of breaking the tour', () => {
  const steps = [{ id: 'a' }, { id: 'b', when: () => { throw new Error('no page'); } }, { id: 'c' }];
  assert.strictEqual(TM.nextIndex(steps, 0, +1, {}), 2);
});

// ─── counting ─────────────────────────────────────────────────────────────────

test('steps are counted within their chapter, and only steps that apply count', () => {
  const ctx = { added: true, widget: false };
  const p = TM.progress(STEPS, 2, ctx, [1]);
  assert.deepStrictEqual({ chapter: p.chapter, n: p.n, of: p.of }, { chapter: 'Characters', n: 2, of: 2 });
  const d = TM.progress(STEPS, 3, ctx, [1, 2]);
  assert.deepStrictEqual({ chapter: d.chapter, n: d.n, of: d.of }, { chapter: 'Dashboard', n: 1, of: 1 },
    'the arrange step does not apply, so the Dashboard chapter has one step');
});

test('the progress bar marks done, current and to do across every counted step', () => {
  const p = TM.progress(STEPS, 3, { added: true, widget: true }, [1, 2]);
  assert.deepStrictEqual(p.segments.map(s => s.state), ['done', 'done', 'current', 'todo']);
});

// The total must hold still while someone works through a chapter. Before this,
// the Dashboard chapter read 1 of 2, then 1 of 1, then 2 of 2 in one walk: a step
// that depends on the current page dropped out once the page opened, and a step
// that appears only after a widget is added dropped in afterwards.
const DASH = [
  { id: 'welcome' },
  { id: 'nav',     chapter: 'Dashboard', when: ctx => ctx.page !== 'dashboard' },
  { id: 'add',     chapter: 'Dashboard' },
  { id: 'arrange', chapter: 'Dashboard', when: ctx => !!ctx.widget, countWhen: ctx => !ctx.skippedWidget },
  { id: 'end' },
];

test('a visited step keeps counting after its own condition stops applying', () => {
  const ctx = { page: 'dashboard', widget: false };
  // The nav step was shown, then the page opened and its `when` turned false.
  const p = TM.progress(DASH, 2, ctx, [1]);
  assert.deepStrictEqual({ n: p.n, of: p.of }, { n: 2, of: 3 });
});

test('a step that is expected later counts before it applies, so the total holds', () => {
  const ctx = { page: 'characters', widget: false };
  const atNav = TM.progress(DASH, 1, ctx, []);
  ctx.page = 'dashboard';
  const atAdd = TM.progress(DASH, 2, ctx, [1]);
  ctx.widget = true;
  const atArrange = TM.progress(DASH, 3, ctx, [1, 2]);
  assert.deepStrictEqual([atNav, atAdd, atArrange].map(p => `${p.n} of ${p.of}`), ['1 of 3', '2 of 3', '3 of 3']);
});

test('skipping what a later step depends on removes it from the count', () => {
  const ctx = { page: 'dashboard', widget: false, skippedWidget: true };
  const p = TM.progress(DASH, 2, ctx, [1]);
  assert.strictEqual(p.of, 2);
});

test('a step behind that was never visited was skipped, and is not counted', () => {
  // On a first launch the nav step never shows: the app opens on the page already.
  const p = TM.progress(DASH, 2, { page: 'dashboard', widget: false }, []);
  assert.deepStrictEqual({ n: p.n, of: p.of }, { n: 1, of: 2 });
});

test('the welcome and closing cards are not counted', () => {
  assert.strictEqual(TM.progress(STEPS, 0, {}), null);
  assert.strictEqual(TM.progress(STEPS, 5, {}), null);
});

// ─── geometry ─────────────────────────────────────────────────────────────────

const VP = { left: 0, top: 32, width: 1600, height: 868 };   // below a 32px title bar

test('the hole is the padded union of the targets, kept inside the viewport', () => {
  const button = { left: 300, top: 120, width: 120, height: 30 };
  const menu   = { left: 300, top: 156, width: 230, height: 300 };
  assert.deepStrictEqual(TM.holeRect([button, menu], 6, VP), { left: 294, top: 114, width: 242, height: 348 });
  // Against the title bar: clamped to the viewport's top, never over the window controls.
  const nav = { left: 10, top: 34, width: 200, height: 30 };
  assert.strictEqual(TM.holeRect([nav], 6, VP).top, 32);
});

test('hidden targets are ignored, and nothing visible means no hole', () => {
  const shown = { left: 10, top: 100, width: 50, height: 20 };
  const hidden = { left: 0, top: 0, width: 0, height: 0 };
  assert.deepStrictEqual(TM.holeRect([hidden, shown], 0, VP), shown);
  assert.strictEqual(TM.holeRect([hidden], 4, VP), null);
  assert.strictEqual(TM.holeRect([], 4, VP), null);
});

test('the four blockers tile the viewport around the hole, leaving the hole open', () => {
  const hole = { left: 100, top: 200, width: 300, height: 100 };
  const b = TM.blockers(hole, VP);
  const area = b.reduce((n, r) => n + r.width * r.height, 0);
  assert.strictEqual(area + hole.width * hole.height, VP.width * VP.height, 'nothing is double-covered or left out');
  const inside = (r, x, y) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
  assert.ok(!b.some(r => inside(r, 250, 250)), 'a click in the hole reaches the control');
  assert.ok(b.some(r => inside(r, 50, 50 + 32)), 'a click outside is held');
});

test('with no hole one blocker covers everything', () => {
  assert.deepStrictEqual(TM.blockers(null, VP), [VP]);
});

test('the card takes the first side with room, in the order given', () => {
  const card = { width: 340, height: 220 };
  const navItem = { left: 8, top: 300, width: 190, height: 36 };
  const r = TM.placeCard(navItem, card, VP);
  assert.strictEqual(r.side, 'right');
  assert.strictEqual(r.left, 8 + 190 + 14);
  // Asked for below first, a button with room underneath gets it.
  const btn = { left: 600, top: 120, width: 140, height: 32 };
  assert.strictEqual(TM.placeCard(btn, card, VP, { order: ['bottom', 'right'] }).side, 'bottom');
});

test('the card never leaves the viewport, and its pointer stays off the corners', () => {
  const card = { width: 340, height: 220 };
  const nearBottom = { left: 8, top: 840, width: 190, height: 40 };
  const r = TM.placeCard(nearBottom, card, VP);
  assert.ok(r.top + card.height <= VP.top + VP.height - 16, 'kept inside the bottom edge');
  assert.ok(r.arrow >= 18 && r.arrow <= card.height - 18, 'pointer off the rounded corners');
});

test('with no room anywhere the roomiest side wins, and no hole centres the card', () => {
  const card = { width: 340, height: 220 };
  const huge = { left: 20, top: 40, width: 1500, height: 800 };
  const r = TM.placeCard(huge, card, VP);
  assert.ok(['right', 'left', 'bottom', 'top'].includes(r.side));
  const c = TM.placeCard(null, card, VP);
  assert.deepStrictEqual({ side: c.side, left: c.left, top: c.top }, { side: 'center', left: 630, top: 356 });
});

// What an alliance pack offers, at the GEZ, jump gate and forum stops among
// other places, is tested with its module in test/alliance_pack.test.js.

test('sameRect tolerates sub-pixel jitter', () => {
  assert.ok(TM.sameRect({ left: 1, top: 2, width: 3, height: 4 }, { left: 1.2, top: 2.3, width: 3.1, height: 4.4 }));
  assert.ok(!TM.sameRect({ left: 1, top: 2, width: 3, height: 4 }, { left: 2, top: 2, width: 3, height: 4 }));
  assert.ok(TM.sameRect(null, null));
  assert.ok(!TM.sameRect(null, { left: 0, top: 0, width: 1, height: 1 }));
});
