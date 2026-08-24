'use strict';
// Pins the not-in-fleet poll backoff.
//
// `/characters/{id}/fleet` answers 404 for a character who is not in a fleet.
// At the in-fleet cadence of 6s that is 600 4xx an hour, spent entirely on
// learning that nothing changed — against a shared budget of 100 errors per 60s
// that EVERY ESI feature in the app draws on. Draining it does not just slow the
// FC page down, it blanks unrelated features (see the esi-error-limit-drain
// note): a 420 makes the whole app go quiet.
//
// The behaviour shipped in 9440af7 with no test, so nothing stopped a later
// refactor from quietly restoring the 6s cadence. These cases assert the effect
// rather than the constant: setting a variable changes nothing on its own, so
// what matters is that the live interval is re-armed at the new period.
const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

// fc.js is a plain renderer script — no exports, and its top-level `let`/`const`
// bindings live in the script's own lexical scope rather than on the context
// global. Appending an exporter is the only way to reach them (same approach as
// fitting_sim.test.js).
function loadFc(fleetReplies) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'func', 'fc.js'), 'utf8');
  const noop = () => {};

  // Fake timers that RECORD their period, so a test can tell a re-armed
  // interval from an untouched one.
  const intervals = [];
  const setIntervalSpy = (fn, ms) => {
    const h = { fn, ms, cleared: false };
    intervals.push(h);
    return h;
  };
  const clearIntervalSpy = (h) => { if (h) h.cleared = true; };

  const doc = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop, addEventListener: noop }),
    addEventListener: noop, body: {}, documentElement: { style: {} }, head: {},
  };
  const eveAPI = {
    // The route under test. Each call shifts the next scripted reply.
    fcGetCharacterFleet: async () => fleetReplies.shift(),
    // Stopping here keeps the test on the cadence decision: the cadence is set
    // before the roster is read, so an unhappy roster reply exercises the
    // in-fleet branch without needing the whole render path stubbed.
    fcGetFleetMembers: async () => ({ ok: false, error: 'stubbed' }),
    getNames: async () => [],
  };
  const sb = {
    document: doc, console,
    setTimeout, clearTimeout, setInterval: setIntervalSpy, clearInterval: clearIntervalSpy,
    requestAnimationFrame: noop, navigator: { clipboard: {} },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    Math, Date, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseFloat, parseInt, fetch: () => Promise.reject(new Error('no net')),
  };
  sb.window = { addEventListener: noop, eveAPI, document: doc };
  sb.globalThis = sb;

  vm.runInContext(src + `
;globalThis.__x = {
  FC_POLL_MS, FC_IDLE_POLL_MS,
  poll: _fcPoll,
  setCadence: _fcSetCadence,
  cadence: () => _fcPollEveryMs,
  arm:   () => { _fcPollTimer = setInterval(_fcPoll, _fcPollEveryMs); },
  begin: (id) => { _fcTracking = true; _fcCharId = id; _fcPollEveryMs = FC_POLL_MS; },
};
`, vm.createContext(sb), { filename: 'fc.js' });

  const x = sb.__x;
  x.live = () => intervals.filter(h => !h.cleared);
  return x;
}

test('not in a fleet backs the poll off to the idle cadence', async () => {
  const fc = loadFc([{ inFleet: false }]);
  fc.begin(1001);
  fc.arm();
  assert.strictEqual(fc.live()[0].ms, fc.FC_POLL_MS, 'starts at the in-fleet cadence');

  await fc.poll();

  assert.strictEqual(fc.cadence(), fc.FC_IDLE_POLL_MS, 'cadence backed off');
  const live = fc.live();
  assert.strictEqual(live.length, 1, 'exactly one timer is still running');
  assert.strictEqual(live[0].ms, fc.FC_IDLE_POLL_MS,
    'the RUNNING interval was re-armed — changing the variable alone would keep polling every 6s');
});

test('rejoining a fleet restores the fast cadence', async () => {
  const fc = loadFc([
    { inFleet: false },
    { inFleet: true, fleetId: 42, fleetBossId: 1001 },
  ]);
  fc.begin(1001);
  fc.arm();

  await fc.poll();
  assert.strictEqual(fc.cadence(), fc.FC_IDLE_POLL_MS);

  await fc.poll();
  assert.strictEqual(fc.cadence(), fc.FC_POLL_MS, 'back to the in-fleet cadence');
  assert.strictEqual(fc.live()[0].ms, fc.FC_POLL_MS, 'and the running interval followed');
});

test('an unchanged cadence does not churn the timer', async () => {
  // _fcPoll runs every tick; re-arming on each one would reset the interval
  // forever and, at the idle cadence, could starve the poll entirely.
  const fc = loadFc([{ inFleet: false }, { inFleet: false }]);
  fc.begin(1001);
  fc.arm();

  await fc.poll();
  const armed = fc.live()[0];
  await fc.poll();

  assert.strictEqual(fc.live()[0], armed, 'second idle poll left the timer alone');
});

test('the idle cadence is slow enough to matter to the error budget', () => {
  const fc = loadFc([]);
  // The point of the backoff is the shared 100-errors-per-60s ESI budget, so
  // pin the arithmetic that justifies it rather than the literal 30000.
  const perHour = (ms) => 3600_000 / ms;
  assert.ok(perHour(fc.FC_IDLE_POLL_MS) <= 150,
    `idle polling would spend ${perHour(fc.FC_IDLE_POLL_MS)} 404s an hour`);
  assert.ok(fc.FC_IDLE_POLL_MS >= fc.FC_POLL_MS * 4,
    'idle cadence should be several times slower than the in-fleet one');
});
