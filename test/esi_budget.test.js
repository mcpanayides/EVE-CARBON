'use strict';
//
// Protecting the ESI error budget.
//
// CCP allows ~100 errors per rolling window ACROSS THE WHOLE APPLICATION. At
// zero it answers 420 to everything, so one feature that spends the budget
// carelessly silently blanks every other ESI feature in the app — assets,
// wallets, industry, the lot — and the user sees empty pages with no error.
//
// Structure name resolution is the dangerous one, because it is speculative by
// nature: reading a structure nobody has docking rights to 403s far more often
// than it succeeds, and a sync sweeps dozens of them back to back. These tests
// hold the three defences that stop that sweep taking the app down with it.
const test   = require('node:test');
const assert = require('node:assert');
const createLocator = require('../src/locator');

/** A locator wired to fakes, with a controllable budget. */
function makeLocator({ remain = 100, blockedFor = 0, tokens = ['1', '2', '3'] } = {}) {
  const calls = { auth: [], gateWaits: 0 };
  const cache = new Map();
  const loc = createLocator({
    httpGet: async (url) => {
      calls.auth.push(url);
      const e = new Error('HTTP 403: forbidden');
      e.status = 403;
      throw e;
    },
    readCache:  (k) => cache.get(k),
    writeCache: (k, v) => cache.set(k, v),
    getValidToken:      async (cid) => `token-${cid}`,
    getAllCharacterIds: () => tokens,
    getStationById:     async () => null,
    esiGateWait: async () => { calls.gateWaits++; },
    esiNote:     () => {},
    esiBudget:   () => ({ remain, blockedFor }),
  });
  return { loc, calls, cache };
}

test('a healthy budget allows the full cross-character sweep', async () => {
  // With headroom, trying every character is the right thing: any one of them
  // holding docking access resolves a name nothing else can.
  const { loc, calls } = makeLocator({ remain: 100 });
  await loc.resolveStructureName(1000000000001, '1', true);
  assert.ok(calls.auth.length >= 3, `expected a sweep, saw ${calls.auth.length} calls`);
});

test('a thin budget drops the sweep to the owning character alone', async () => {
  // The sweep costs one 403 per character without access — it is the single
  // biggest spender in the chain, so it is the first thing to give way.
  const { loc, calls } = makeLocator({ remain: 5 });
  await loc.resolveStructureName(1000000000002, '1', true);
  assert.strictEqual(calls.auth.length, 1,
    `a thin budget must not sweep every character, saw ${calls.auth.length}`);
});

test('a thin budget still tries the owning character', async () => {
  // Standing down entirely would mean a structure we CAN read stays unnamed
  // forever. One probe costs at most one point and has a real chance.
  const { loc, calls } = makeLocator({ remain: 1 });
  await loc.resolveStructureName(1000000000003, '7', true);
  assert.strictEqual(calls.auth.length, 1);
  assert.match(calls.auth[0], /1000000000003/);
});

test('an active 420 pause stops the sweep even with budget showing', async () => {
  // remain is a reading that can lag; an active pause is a fact.
  // A short pause here on purpose: the real one is ~45s and the locator really
  // does sleep it out, so a realistic value would make this test sleep too. What
  // is being asserted is the DECISION, not the duration.
  const { loc, calls } = makeLocator({ remain: 100, blockedFor: 40 });
  await loc.resolveStructureName(1000000000004, '1', true);
  assert.strictEqual(calls.auth.length, 1, 'no speculative sweep while paused');
});

test('the locator waits on the app-wide gate, not just its own', async () => {
  // The bug this guards: the locator kept a private 420 cooldown for the calls
  // it makes through its own transport, while authenticated reads went out
  // through main's gate behind a different one. A 420 seen on either path did
  // nothing to stop the other, and the two kept refilling each other's holes.
  const { loc, calls } = makeLocator({ remain: 100 });
  await loc.resolveStructureName(1000000000005, '1', true);
  assert.ok(calls.gateWaits > 0, 'every ESI call must pass the shared gate');
});

test('with no budget hooks wired, nothing is restricted', async () => {
  // The locator is constructed in tests and tools without the main process.
  const calls = [];
  const cache = new Map();
  const loc = createLocator({
    httpGet: async (url) => { calls.push(url); throw new Error('HTTP 403'); },
    readCache: (k) => cache.get(k), writeCache: (k, v) => cache.set(k, v),
    getValidToken: async (c) => `t-${c}`,
    getAllCharacterIds: () => ['1', '2', '3'],
    getStationById: async () => null,
  });
  await loc.resolveStructureName(1000000000006, '1', true);
  assert.ok(calls.length >= 3, 'unrestricted without a budget to consult');
});

// ── Fallback-source circuit breaker ──────────────────────────────────────────
//
// Tested directly rather than through resolveStructureName: those fetchers are
// not injectable, so driving them would mean real requests to community
// services — 12s timeouts each, and failing whenever one of them is up.

const { _breaker } = createLocator;

test('a dead fallback source trips after a few failures and is then skipped', () => {
  // Observed 2026-08-04: stop.hammerti.me.uk began serving a self-signed
  // "TRAEFIK DEFAULT CERT", so every request failed certificate validation. A
  // sweep then produced one identical failure per structure — hundreds of them.
  _breaker._resetBreaker();
  const host = 'stop.hammerti.me.uk';
  const err  = new Error('unable to verify the first certificate');

  for (let i = 1; i < _breaker.HOST_TRIP_AFTER; i++) {
    _breaker._noteHostFailure(host, err);
    assert.strictEqual(_breaker._hostIsDown(host), false,
      'one bad structure must not disable a working source');
  }
  _breaker._noteHostFailure(host, err);
  assert.strictEqual(_breaker._hostIsDown(host), true, 'consistent failure trips it');
  _breaker._resetBreaker();
});

test('the outage is reported once, not once per structure', (t) => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  t.after(() => { console.warn = realWarn; _breaker._resetBreaker(); });

  _breaker._resetBreaker();
  for (let i = 0; i < 200; i++) {
    _breaker._noteHostFailure('stop.hammerti.me.uk', new Error('unable to verify the first certificate'));
  }
  const tripped = warnings.filter(w => /skipping it for/.test(w));
  assert.strictEqual(tripped.length, 1, `expected one line, saw ${tripped.length}`);
  assert.match(tripped[0], /unable to verify the first certificate/, 'and it says why');
});

test('a source that recovers is used again immediately', () => {
  _breaker._resetBreaker();
  const host = 'zkillboard.com';
  for (let i = 0; i < _breaker.HOST_TRIP_AFTER; i++) _breaker._noteHostFailure(host, new Error('timeout'));
  assert.strictEqual(_breaker._hostIsDown(host), true);
  _breaker._noteHostOk(host);
  assert.strictEqual(_breaker._hostIsDown(host), false, 'one success clears it');
  _breaker._resetBreaker();
});

test('hosts trip independently', () => {
  // zKillboard being down must not disable adam4eve.
  _breaker._resetBreaker();
  for (let i = 0; i < _breaker.HOST_TRIP_AFTER; i++) {
    _breaker._noteHostFailure('zkillboard.com', new Error('timeout'));
  }
  assert.strictEqual(_breaker._hostIsDown('zkillboard.com'), true);
  assert.strictEqual(_breaker._hostIsDown('www.adam4eve.eu'), false);
  _breaker._resetBreaker();
});
