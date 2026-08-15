'use strict';
//
// The post-sync rebuild trigger.
//
// A full sync writes assets once per character and signals once per character.
// At ninety characters that is ninety signals, and each rebuild is a complete
// pass over every asset in the database — measured at around fifteen seconds on
// a real profile. Ninety of those back to back would keep the disk busy for the
// entire sync while showing the user nothing new, so the coalescing here is not
// a nicety; it is the difference between a background job and a stampede.
//
// Tested with mock timers because the real intervals are twenty seconds and
// three minutes, and a test that actually waited for them would be useless.
const test   = require('node:test');
const assert = require('node:assert');

const { registerValuationHandlers,
        REBUILD_DEBOUNCE_MS, REBUILD_MAX_WAIT_MS } = require('../src/ipc/valuation_ipc');

// getCharDb returning null makes rebuildFromLocalData bail immediately, so
// counting its calls counts rebuild ATTEMPTS without needing a database.
function harness() {
  let dbCalls = 0;
  const api = registerValuationHandlers({
    ipcHandle: () => {},
    getCharDb: () => { dbCalls++; return null; },
    charInfoDb: { getCharacterAssets: async () => [] },
    httpGet: async () => [],
    fetchHubPrices: async () => ({}),
    fetchTypeMetadata: async () => ({}),
    loadDB: () => ({ accounts: {} }),
    esiBase: 'https://esi.example.invalid',
  });
  return { api, rebuilds: () => dbCalls };
}

// tick() is synchronous, so the rebuild it starts is still suspended at its
// first await when tick() returns — and the flag saying one is in progress is
// only cleared in a finally block. Real time always drains those microtasks;
// a test has to ask. setImmediate is not mocked, so it still works.
//
// Date is mocked alongside setTimeout because the three-minute ceiling is
// measured with Date.now(). Mocking only the timer advances the schedule
// while the clock stands still, and the ceiling can then never trip.
const settle = () => new Promise(r => setImmediate(r));

test('ninety sync completions produce one rebuild, not ninety', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { api, rebuilds } = harness();

  for (let i = 0; i < 90; i++) api.scheduleRebuild(`character ${i}`);
  assert.strictEqual(rebuilds(), 0, 'nothing should run while signals are still arriving');

  t.mock.timers.tick(REBUILD_DEBOUNCE_MS + 1);
  await settle();
  assert.strictEqual(rebuilds(), 1);
});

test('each new signal restarts the quiet period', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { api, rebuilds } = harness();

  api.scheduleRebuild('first');
  t.mock.timers.tick(REBUILD_DEBOUNCE_MS - 1000);
  api.scheduleRebuild('second');            // resets the clock
  t.mock.timers.tick(REBUILD_DEBOUNCE_MS - 1000);
  await settle();
  assert.strictEqual(rebuilds(), 0, 'the second signal should have deferred it');

  t.mock.timers.tick(2000);
  await settle();
  assert.strictEqual(rebuilds(), 1);
});

test('a long sync cannot defer the rebuild indefinitely', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { api, rebuilds } = harness();

  // A ninety-character sync runs far longer than the quiet period, and every
  // character that finishes restarts it. Without the ceiling the rebuild would
  // never happen until the whole sync did — which is exactly the case where the
  // user is most likely to be watching the Assets page.
  const step = REBUILD_DEBOUNCE_MS - 5000;
  for (let elapsed = 0; elapsed < REBUILD_MAX_WAIT_MS + step; elapsed += step) {
    api.scheduleRebuild('still syncing');
    t.mock.timers.tick(step);
    await settle();
  }
  assert.ok(rebuilds() >= 1, 'the ceiling should have forced a rebuild mid-sync');
});

test('the quiet period restarts cleanly after a rebuild has run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { api, rebuilds } = harness();

  api.scheduleRebuild('first sync');
  t.mock.timers.tick(REBUILD_DEBOUNCE_MS + 1);
  await settle();
  assert.strictEqual(rebuilds(), 1);

  // A later sync gets its own full quiet period rather than inheriting the
  // elapsed time of the previous one and firing immediately.
  api.scheduleRebuild('second sync');
  t.mock.timers.tick(REBUILD_DEBOUNCE_MS - 1000);
  await settle();
  assert.strictEqual(rebuilds(), 1, 'the second rebuild fired too early');

  t.mock.timers.tick(2000);
  await settle();
  assert.strictEqual(rebuilds(), 2);
});
