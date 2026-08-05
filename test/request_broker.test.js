'use strict';
// Guards the behaviour that stopped the app stampeding ESI. Each case here maps
// to something that was measured happening in net-log.csv on 2026-08-02.
const test   = require('node:test');
const assert = require('node:assert');
const broker = require('../src/request_broker');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAXAGE = { 'cache-control': 'public, max-age=300' };

// Each test gets its own URL so entries can't leak between them.
let n = 0;
const url = (p = 'x') => `https://esi.evetech.net/test/${p}/${++n}/`;

test('concurrent callers for one URL make exactly one request', async () => {
  // The measured fault: /latest/industry/systems/ fetched 30x in 10s.
  let calls = 0;
  const u = url('industry');
  const perform = async () => { calls++; await sleep(20); return { value: { ok: 1 }, headers: MAXAGE }; };

  const results = await Promise.all(Array.from({ length: 30 }, () => broker.get(u, {}, perform)));

  assert.strictEqual(calls, 1, 'should collapse to a single request');
  assert.strictEqual(results.length, 30);
  assert.ok(results.every(r => r.ok === 1), 'every caller gets the value');
});

test('a response is reused for as long as the origin said it is valid', async () => {
  let calls = 0;
  const u = url('cached');
  const perform = async () => { calls++; return { value: calls, headers: MAXAGE }; };

  await broker.get(u, {}, perform);
  await broker.get(u, {}, perform);
  assert.strictEqual(calls, 1, 'second call inside max-age must not hit the network');
});

test('no-store and missing cache headers are never cached', async () => {
  for (const headers of [{ 'cache-control': 'no-store' }, {}]) {
    let calls = 0;
    const u = url('nocache');
    const perform = async () => { calls++; return { value: calls, headers }; };
    await broker.get(u, {}, perform);
    await broker.get(u, {}, perform);
    assert.strictEqual(calls, 2, `must refetch when headers are ${JSON.stringify(headers)}`);
  }
});

test('two characters never share a cached response', async () => {
  // The Authorization header is part of the key — otherwise one character's
  // wallet could be served to another.
  const u = url('wallet');
  const a = await broker.get(u, { Authorization: 'Bearer AAA' }, async () => ({ value: 'charA', headers: MAXAGE }));
  const b = await broker.get(u, { Authorization: 'Bearer BBB' }, async () => ({ value: 'charB', headers: MAXAGE }));
  assert.strictEqual(a, 'charA');
  assert.strictEqual(b, 'charB');
});

test('a 4xx is remembered briefly, a 5xx stays retryable', async () => {
  // 29 blueprint icons 400ing were re-requested ~4x each.
  let four = 0;
  const u4 = url('gone');
  for (let i = 0; i < 3; i++) {
    await assert.rejects(broker.get(u4, {}, async () => { four++; throw new Error('HTTP 400: bad'); }));
  }
  assert.strictEqual(four, 1, 'a client error should not be re-asked');

  let five = 0;
  const u5 = url('broken');
  for (let i = 0; i < 3; i++) {
    await assert.rejects(broker.get(u5, {}, async () => { five++; throw new Error('HTTP 500: oops'); }));
  }
  assert.strictEqual(five, 3, 'a server error is transient and must stay retryable');
});

test('a rate-limit answer is never memoised as a verdict', async () => {
  let calls = 0;
  const u = url('limited');
  const perform = async () => {
    calls++;
    throw Object.assign(new Error('HTTP 420: limited'), { isRateLimit: true });
  };
  for (let i = 0; i < 2; i++) await assert.rejects(broker.get(u, {}, perform));
  assert.strictEqual(calls, 2, 'caching a 420 would keep the app locked out after the limit cleared');
});

test('concurrency is capped per host and everything still completes', async () => {
  // Opening a page peaked at 34 concurrent requests.
  let live = 0, peak = 0, done = 0;
  const perform = async () => {
    live++; peak = Math.max(peak, live);
    await sleep(5);
    live--; done++;
    return { value: done, headers: {} };
  };
  await Promise.all(Array.from({ length: 40 }, () => broker.get(url('lane'), {}, perform)));

  assert.strictEqual(done, 40, 'queued requests must still run');
  assert.ok(peak <= 8, `peak concurrency ${peak} should stay within the lane limit`);
});

test('ttlFromHeaders reads what the origin actually said', () => {
  assert.strictEqual(broker.ttlFromHeaders({ 'cache-control': 'public, max-age=300' }), 300_000);
  assert.strictEqual(broker.ttlFromHeaders({ 'cache-control': 'max-age=300', age: '60' }), 240_000,
    'Age must be subtracted — the response is already partly spent');
  assert.strictEqual(broker.ttlFromHeaders({ 'cache-control': 'no-cache' }), 0);
  assert.strictEqual(broker.ttlFromHeaders({}), 0);
  assert.ok(broker.ttlFromHeaders({ 'cache-control': 'max-age=999999999' }) <= 60 * 60 * 1000,
    'an absurd max-age is clamped');
});

test('invalidate clears cached entries for a host', async () => {
  let calls = 0;
  const u = url('refresh');
  const perform = async () => { calls++; return { value: calls, headers: MAXAGE }; };
  await broker.get(u, {}, perform);
  broker.invalidate('esi.evetech.net');
  await broker.get(u, {}, perform);
  assert.strictEqual(calls, 2, 'an explicit refresh must go past the cache');
});
