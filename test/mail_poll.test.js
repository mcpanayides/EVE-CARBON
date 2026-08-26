'use strict';
// Guards the unread-mail poll's request shape.
//
// This watcher starts at launch and runs on every page, for every character,
// forever. It was `Promise.all` over all accounts every 30s — at 20 characters
// the single largest burst the app makes, and the largest steady-state
// contributor at ~0.67 req/s. Concurrency limits do not help: the broker's lane
// bounds how many are IN FLIGHT, not how many start per second.
const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

// mail.js is a plain renderer script — no exports. Appending an exporter is the
// only way to reach its internals (same approach as fitting_sim.test.js).
function loadMail({ accounts = [], visible = true, focused = true } = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'func', 'mail.js'), 'utf8');
  const noop = () => {};
  const calls = [];   // { id, at } — when each request was issued

  // Virtual clock. A staggered walk sleeps for most of a 30s window and a test
  // must not, so a sleep ADVANCES the clock and resolves immediately. The walk
  // is sequential, so the cumulative sum is exactly the real issue time.
  let now = 0;
  const fakeSetTimeout = (fn, ms) => { now += (ms || 0); Promise.resolve().then(fn); return 0; };

  const doc = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop }),
    addEventListener: noop, body: {}, documentElement: { style: {} }, head: {},
    visibilityState: visible ? 'visible' : 'hidden',
    hasFocus: () => focused,
  };
  const eveAPI = {
    getAccounts: async () => accounts,
    mailGetLabels: async (id) => { calls.push({ id, at: now }); return { ok: true, totalUnread: 1 }; },
  };
  const sb = {
    document: doc, console,
    setTimeout: fakeSetTimeout, clearTimeout: noop,
    setInterval: (fn, ms) => ({ fn, ms }), clearInterval: noop,
    requestAnimationFrame: noop, navigator: {},
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    Math, Date, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseFloat, parseInt, fetch: () => Promise.reject(new Error('no net')),
  };
  sb.window = { addEventListener: noop, eveAPI, document: doc };
  sb.globalThis = sb;

  vm.runInContext(src + `
;globalThis.__x = {
  MAIL_UNREAD_POLL_MS, MAIL_IDLE_POLL_MS,
  gap: _mailStaggerGap,
  active: _mailWindowActive,
  poll: _mailPollUnread,
  cadence: () => _mailPollEveryMs,
  setCadence: _mailSetCadence,
  arm: () => { _mailUnreadTimer = { armed: true }; },
};
`, vm.createContext(sb), { filename: 'mail.js' });

  return { x: sb.__x, calls, clock: () => now };
}

test('requests are spread across the window, not fired together', async () => {
  const accounts = Array.from({ length: 20 }, (_, i) => ({ characterId: 100 + i }));
  const { x, calls } = loadMail({ accounts });
  x.arm();

  await x.poll();

  assert.strictEqual(calls.length, 20, 'every mailbox still polled');
  const at = calls.map(c => c.at);
  assert.ok(new Set(at).size > 1, 'not all issued at the same instant');
  // The whole point: the walk must finish inside its own 30s window.
  assert.ok(at[at.length - 1] < x.MAIL_UNREAD_POLL_MS,
    `last request at ${at[at.length - 1]}ms must land inside the ${x.MAIL_UNREAD_POLL_MS}ms window`);
  assert.ok(at[at.length - 1] > 0, 'and the burst is genuinely spread');
});

test('the gap shrinks as characters are added so the walk always fits', () => {
  const { x } = loadMail();
  const w = x.MAIL_UNREAD_POLL_MS;
  for (const n of [2, 5, 20, 90]) {
    const span = x.gap(n, w) * (n - 1);
    assert.ok(span < w, `${n} characters span ${span}ms, must fit in ${w}ms`);
  }
  assert.strictEqual(x.gap(1, w), 0, 'a single mailbox waits for nothing');
  assert.strictEqual(x.gap(0, w), 0);
});

test('a hidden window starts on the idle cadence', () => {
  const { x } = loadMail({ visible: false });
  assert.strictEqual(x.active(), false);
  const { x: shown } = loadMail({ visible: true, focused: true });
  assert.strictEqual(shown.active(), true);
});

test('an unfocused window counts as idle', () => {
  const { x } = loadMail({ visible: true, focused: false });
  assert.strictEqual(x.active(), false, 'visible but behind another window');
});

test('cadence changes re-arm the running timer', () => {
  const { x } = loadMail();
  x.arm();
  x.setCadence(x.MAIL_IDLE_POLL_MS);
  assert.strictEqual(x.cadence(), x.MAIL_IDLE_POLL_MS);
  x.setCadence(x.MAIL_UNREAD_POLL_MS);
  assert.strictEqual(x.cadence(), x.MAIL_UNREAD_POLL_MS);
});

test('idle polling is a large enough cut to be worth it', () => {
  const { x } = loadMail();
  assert.ok(x.MAIL_IDLE_POLL_MS >= x.MAIL_UNREAD_POLL_MS * 5,
    'idle cadence should be several times slower');
});

test('no accounts issues no requests', async () => {
  const { x, calls } = loadMail({ accounts: [] });
  x.arm();
  await x.poll();
  assert.strictEqual(calls.length, 0);
});
