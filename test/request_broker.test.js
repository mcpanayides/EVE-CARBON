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

// ── Rate governor ────────────────────────────────────────────────────────────
// Concurrency is not rate: the lane limit above bounds how many requests are in
// flight, never how many go out per second. These guard the second property.
// Each uses its own host so the buckets cannot interfere, and its own rate so
// the assertion is sharp rather than inheriting a production number.

const uncached = () => ({ value: 1, headers: {} });          // never cached, never coalesced
const burstUrl = (host, p) => `https://${host}/${p}/${++n}/`;

test('a burst goes out immediately — the governor does not tax ordinary use', async () => {
  // The measured page-open peak is 34 requests. If the governor paced those, it
  // would have made every page feel slower to fix a problem nobody had.
  broker.setRate('burst.test', { perSec: 1, burst: 5 });
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => broker.get(burstUrl('burst.test', 'b'), {}, uncached)));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 150, `a full bucket must not be paced (took ${elapsed}ms at 1/s)`);
});

test('the sustained rate is enforced once the burst is spent', async () => {
  // 2 free, then 4 more at 20/s = 50ms apart => ~200ms floor.
  broker.setRate('paced.test', { perSec: 20, burst: 2 });
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 6 }, () => broker.get(burstUrl('paced.test', 'p'), {}, uncached)));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 150, `4 requests past a burst of 2 at 20/s should take ~200ms, took ${elapsed}ms`);
  assert.ok(elapsed < 2000, `but must not stall (took ${elapsed}ms)`);
});

test('everything queued still completes, in order', async () => {
  // A governor that dropped or reordered work would be worse than none: callers
  // would see sporadic failures that look like the network.
  broker.setRate('fifo.test', { perSec: 50, burst: 1 });
  const order = [];
  const runs = Array.from({ length: 8 }, (_, i) =>
    broker.get(burstUrl('fifo.test', 'f'), {}, async () => { order.push(i); return { value: i, headers: {} }; }));
  const out = await Promise.all(runs);
  assert.strictEqual(out.length, 8, 'nothing may be dropped');
  assert.deepStrictEqual(order, [0, 1, 2, 3, 4, 5, 6, 7], 'the queue must stay FIFO');
});

test('the zKillboard REST API is strictly limited as shipped', async () => {
  // Guards the actual production number, not a test-local one. zKillboard is a
  // free volunteer service that publishes no numeric limit at all — the "15/s"
  // our own code used to cite could not be sourced from their docs — so the
  // shipped ceiling is deliberately strict and must not drift upward unnoticed.
  // This host serves the fleet-AAR bulk pull: one page per system, once.
  broker.resetRates();
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 4 }, () =>
    broker.get(burstUrl('zkillboard.com', 'z'), {}, uncached)));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 800,
    `a 4th request should wait ~1s behind a burst of 3, took ${elapsed}ms`);
});

test('the live stream host is paced but not throttled into uselessness', async () => {
  // r2z2 carries the sequence cursor and has to keep pace with New Eden's kill
  // rate. Limiting it as hard as the REST host would not tune the feature, it
  // would break it: the cursor falls behind and kills get discarded at
  // MAX_CATCHUP. 2.5/s clears the ~0.3-1/s baseline with headroom.
  broker.resetRates();
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 10 }, () =>
    broker.get(burstUrl('r2z2.zkillboard.com', 'z'), {}, uncached)));
  const elapsed = Date.now() - t0;
  // 5 free, then 5 more at 2.5/s = 400ms apart => ~2s.
  assert.ok(elapsed >= 1500, `should be paced at 2.5/s, took ${elapsed}ms`);
  assert.ok(elapsed < 4000, `but must stay fast enough to follow the feed, took ${elapsed}ms`);
});

test('setRate retunes a bucket that is already running', async () => {
  broker.setRate('retune.test', { perSec: 1, burst: 1 });
  await broker.get(burstUrl('retune.test', 'r'), {}, uncached);   // spend the only token
  broker.setRate('retune.test', { perSec: 1000, burst: 50 });     // open it up
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => broker.get(burstUrl('retune.test', 'r'), {}, uncached)));
  assert.ok(Date.now() - t0 < 300, 'a raised limit must take effect without a restart');
  broker.resetRates();
});
