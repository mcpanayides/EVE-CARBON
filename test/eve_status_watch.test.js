'use strict';
//
// The wiring between the status page and the desktop toast.
//
// The decision logic lives in shared/eve_status.js and is tested there. What is
// pinned here is everything the poller must survive: a dead network, a platform
// with no notification support, a renderer that has gone away mid-poll. This
// runs while the app is minimised to tray for hours at a time, so anything that
// can throw here stops the warning arriving at all — which is the one outcome
// the feature cannot have.
const test   = require('node:test');
const assert = require('node:assert');
const W      = require('../src/eve_status_watch.js');

const summary = (indicator, components) => ({
  status: { indicator, description: `indicator: ${indicator}` },
  components: components.map(([name, status]) => ({ name, status })),
  incidents: [],
});

const OK  = summary('none',  [['Game Server', 'operational']]);
const BAD = summary('major', [['Game Server', 'major_outage']]);

/** Stand in for electron's Notification, recording what would have been shown. */
function fakeNotifier() {
  const shown = [];
  class N {
    constructor(opts) { this.opts = opts; }
    static isSupported() { return true; }
    on() { return this; }
    show() { shown.push(this.opts); }
  }
  return { N, shown };
}

function withFetch(payloads) {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async () => {
    const p = payloads[Math.min(i++, payloads.length - 1)];
    if (p instanceof Error) throw p;
    return { ok: true, json: async () => p };
  };
  return () => { globalThis.fetch = original; };
}

test.beforeEach(() => W._resetForTests());

test('a healthy poll updates the light and says nothing', async () => {
  const restore = withFetch([OK]);
  const { N, shown } = fakeNotifier();
  const seen = [];
  await W.pollOnce({ Notification: N, alertsEnabled: () => true, onChange: (s) => seen.push(s) });
  restore();

  assert.strictEqual(seen.length, 1, 'the light is told on every poll');
  assert.strictEqual(seen[0].level, 'ok');
  assert.strictEqual(shown.length, 0);
});

test('an outage raises exactly one toast, then stays quiet', async () => {
  const restore = withFetch([BAD, BAD, BAD]);
  const { N, shown } = fakeNotifier();
  const deps = { Notification: N, alertsEnabled: () => true };
  await W.pollOnce(deps);
  await W.pollOnce(deps);
  await W.pollOnce(deps);
  restore();

  assert.strictEqual(shown.length, 1, 'a sustained outage must not re-fire');
  assert.match(shown[0].title, /outage/i);
  assert.match(shown[0].body, /station|safe/i);
});

test('a dead network is recorded as unknown, never as an outage', async () => {
  // The important half: a failed fetch must not be mistaken for a broken server.
  // It fires at exactly the moment the user's own connection is struggling,
  // which is when a false "the server is dying" is most damaging.
  const restore = withFetch([new Error('ETIMEDOUT')]);
  const { N, shown } = fakeNotifier();
  const seen = [];
  await W.pollOnce({ Notification: N, alertsEnabled: () => true, onChange: (s) => seen.push(s) });
  restore();

  assert.strictEqual(seen[0].unreachable, true);
  assert.strictEqual(seen[0].level, 'unknown');
  assert.strictEqual(shown.length, 0);
});

test('with alerts switched off the light still tracks reality', async () => {
  // Opting out of being interrupted is not opting out of being informed.
  const restore = withFetch([BAD]);
  const { N, shown } = fakeNotifier();
  const seen = [];
  await W.pollOnce({ Notification: N, alertsEnabled: () => false, onChange: (s) => seen.push(s) });
  restore();

  assert.strictEqual(shown.length, 0);
  assert.strictEqual(seen[0].level, 'down');
});

test('a platform without notifications degrades quietly', async () => {
  const restore = withFetch([BAD]);
  class Unsupported {
    static isSupported() { return false; }
    show() { throw new Error('should never be constructed'); }
  }
  await W.pollOnce({ Notification: Unsupported, alertsEnabled: () => true });
  restore();   // reaching here without throwing is the assertion
  assert.ok(true);
});

test('a renderer that has gone away does not stop the poll', async () => {
  // onChange reaches into a BrowserWindow that may have been destroyed between
  // the poll starting and finishing. If that took the poller down, the watch
  // would silently die for the rest of the session.
  const restore = withFetch([BAD]);
  const { N, shown } = fakeNotifier();
  await W.pollOnce({
    Notification: N,
    alertsEnabled: () => true,
    onChange: () => { throw new Error('window destroyed'); },
  });
  restore();

  assert.strictEqual(shown.length, 1, 'the toast still went out');
});

test('currentStatus is safe to read before the first poll', async () => {
  const s = W.currentStatus();
  assert.strictEqual(s.level, 'unknown');
  assert.strictEqual(s.unreachable, true);
});

test('recovery is announced after an outage, and is silent', async () => {
  const restore = withFetch([BAD, OK]);
  const { N, shown } = fakeNotifier();
  const deps = { Notification: N, alertsEnabled: () => true };
  await W.pollOnce(deps);
  await W.pollOnce(deps);
  restore();

  assert.strictEqual(shown.length, 2);
  assert.match(shown[1].title, /restored/i);
  assert.strictEqual(shown[1].silent, true, 'good news should not make a noise at 3am');
});
