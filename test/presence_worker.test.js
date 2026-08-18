'use strict';
//
// The presence worker's counting logic (infra/presence-worker/worker.js).
//
// This runs on Cloudflare and had no tests at all, which mattered when the
// counter went missing: with nothing pinning its behaviour, "is the worker
// broken?" could only be answered by poking the live endpoint — and a probe
// with a made-up session id answers "0" no matter how healthy the worker is,
// because ids that are not UUID-shaped are rejected on purpose. That looks
// exactly like a broken counter.
//
// The class is imported from the deployed source rather than copied, so these
// cannot drift away from what actually runs.
const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const { pathToFileURL } = require('url');

const WORKER = pathToFileURL(path.join(__dirname, '..', 'infra', 'presence-worker', 'worker.js')).href;

const post = (body) => new Request('https://x/presence', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const get = () => new Request('https://x/presence');
const uuid = () => crypto.randomUUID();

async function counter() {
  const { PresenceCounter } = await import(WORKER);
  return new PresenceCounter();
}

// ── A stand-in for Durable Object storage ────────────────────────────────────
//
// Enough of the real API to exercise the one property that matters: what
// survives when the object is evicted. `evict()` throws away the instance and
// builds a new one over the SAME storage, which is exactly what Cloudflare does
// when an idle object is reclaimed and later woken.
function fakeState() {
  const map = new Map();
  return {
    _map: map,
    blockConcurrencyWhile: (fn) => fn(),
    storage: {
      async put(k, v) { map.set(k, v); },
      async delete(keys) { for (const k of [].concat(keys)) map.delete(k); },
      async list({ prefix } = {}) {
        return new Map([...map].filter(([k]) => !prefix || k.startsWith(prefix)));
      },
    },
  };
}

async function durableCounter(state) {
  const { PresenceCounter } = await import(WORKER);
  const c = new PresenceCounter(state);
  // The real constructor's hydration is fire-and-forget behind
  // blockConcurrencyWhile; our fake runs it synchronously, so one tick settles it.
  await Promise.resolve();
  return c;
}

test('each distinct session adds one, and re-beating does not', async () => {
  const c = await counter();
  const a = uuid(), b = uuid();
  assert.strictEqual((await (await c.fetch(post({ id: a }))).json()).count, 1);
  assert.strictEqual((await (await c.fetch(post({ id: b }))).json()).count, 2);
  // A heartbeat every five minutes must refresh a session, not invent one.
  assert.strictEqual((await (await c.fetch(post({ id: a }))).json()).count, 2);
});

test('GET reports without registering the caller', async () => {
  const c = await counter();
  await c.fetch(post({ id: uuid() }));
  assert.strictEqual((await (await c.fetch(get())).json()).count, 1);
  assert.strictEqual((await (await c.fetch(get())).json()).count, 1);
});

test('an id that is not UUID-shaped is ignored', async () => {
  // Worth pinning: a hand-written probe id ("diag-session-1") is silently
  // dropped and the response reads 0, which is indistinguishable from a worker
  // that counts nothing at all.
  const c = await counter();
  for (const id of ['diag-session-1', '', 'x', null, 42, '../../etc/passwd']) {
    assert.strictEqual((await (await c.fetch(post({ id }))).json()).count, 0, `id ${id} was accepted`);
  }
});

test('sessions are counted by version', async () => {
  const c = await counter();
  await c.fetch(post({ id: uuid(), v: '3.3.0' }));
  await c.fetch(post({ id: uuid(), v: '3.3.0' }));
  await c.fetch(post({ id: uuid(), v: '4.0.0' }));
  const body = await (await c.fetch(get())).json();
  assert.strictEqual(body.count, 3);
  assert.deepStrictEqual(body.versions, { '3.3.0': 2, '4.0.0': 1 });
});

test('a client that sends no version is still counted, as unknown', async () => {
  // The agnostic requirement: every build that predates version reporting keeps
  // working and keeps appearing in the total.
  const c = await counter();
  await c.fetch(post({ id: uuid() }));
  await c.fetch(post({ id: uuid(), v: '3.3.0' }));
  const body = await (await c.fetch(get())).json();
  assert.strictEqual(body.count, 2);
  assert.deepStrictEqual(body.versions, { unknown: 1, '3.3.0': 1 });
});

test('a junk version is bucketed as unknown, never echoed back', async () => {
  // The field is attacker-controlled and the response is public.
  const c = await counter();
  for (const v of ['<script>alert(1)</script>', 'x'.repeat(500), 99, { a: 1 }, '3.3.0; DROP TABLE']) {
    await c.fetch(post({ id: uuid(), v }));
  }
  const body = await (await c.fetch(get())).json();
  assert.deepStrictEqual(Object.keys(body.versions), ['unknown']);
  assert.strictEqual(body.versions.unknown, 5);
});

test('a session that stops beating drops out after the TTL', async () => {
  const c = await counter();
  const stale = uuid();
  await c.fetch(post({ id: stale, v: '3.3.0' }));
  // Backdate it past the 7-minute TTL rather than waiting for one.
  c.sessions.get(stale).seen = Date.now() - (8 * 60 * 1000);
  const body = await (await c.fetch(get())).json();
  assert.strictEqual(body.count, 0);
  assert.deepStrictEqual(body.versions, {}, 'a pruned session left its version behind');
});

test('the count is the number of sessions, not the sum of the buckets', async () => {
  // Bucketing must never be able to lose somebody from the headline number.
  const c = await counter();
  await c.fetch(post({ id: uuid(), v: 'nonsense' }));
  await c.fetch(post({ id: uuid(), v: '4.0.0' }));
  const body = await (await c.fetch(get())).json();
  const summed = Object.values(body.versions).reduce((a, b) => a + b, 0);
  assert.strictEqual(body.count, 2);
  assert.strictEqual(summed, body.count);
});

test('the router answers only /presence, and only GET or POST', async () => {
  const { default: worker } = await import(WORKER);
  const env = { PRESENCE: { idFromName: () => 'id', get: () => ({ fetch: async () => Response.json({ ok: true }) }) } };
  assert.strictEqual((await worker.fetch(new Request('https://x/other'), env)).status, 404);
  assert.strictEqual((await worker.fetch(new Request('https://x/presence', { method: 'DELETE' }), env)).status, 404);
  assert.strictEqual((await worker.fetch(new Request('https://x/presence'), env)).status, 200);
});

// ── Surviving eviction ───────────────────────────────────────────────────────
//
// THE BUG THESE EXIST FOR, and the reason the nine tests above all passed while
// the counter was broken in production: every one of them uses a single
// long-lived object, which is the one condition under which a memory-only
// counter works perfectly.
//
// Cloudflare evicts an idle Durable Object within about fifteen seconds
// (measured against the live worker, 2026-08-17: two sessions with a 7-minute
// TTL read back as count 0). With a 5-minute heartbeat that means no two
// clients are ever resident together — each beat lands on a cold object, counts
// itself, and is told "1". Three users, three machines, each showing 1 online.

test('sessions survive the object being evicted and woken', async () => {
  const state = fakeState();
  const a = uuid(), b = uuid();

  let c = await durableCounter(state);
  assert.strictEqual((await (await c.fetch(post({ id: a, v: '3.4.0' }))).json()).count, 1);

  // Evicted between heartbeats — a new instance over the same storage.
  c = await durableCounter(state);
  const second = await (await c.fetch(post({ id: b, v: '3.4.0' }))).json();
  assert.strictEqual(second.count, 2,
    'the first client must still be counted after the object was reclaimed');
  assert.deepStrictEqual(second.versions, { '3.4.0': 2 });
});

test('a GET after eviction still reports everyone', async () => {
  const state = fakeState();
  let c = await durableCounter(state);
  await c.fetch(post({ id: uuid() }));
  await c.fetch(post({ id: uuid() }));

  c = await durableCounter(state);
  assert.strictEqual((await (await c.fetch(get())).json()).count, 2);
});

test('expiry still removes a session, and clears it from storage too', async () => {
  // The TTL has to keep working now that it is not the only thing collecting
  // sessions — otherwise storage grows forever with pilots who logged off.
  const state = fakeState();
  const c = await durableCounter(state);
  const old = uuid();
  await c.fetch(post({ id: old }));
  assert.strictEqual(state._map.size, 1);

  // Age the stored session past the 7-minute TTL.
  const rec = state._map.get('s:' + old);
  rec.seen -= 8 * 60 * 1000;
  c.sessions.get(old).seen = rec.seen;

  assert.strictEqual((await (await c.fetch(get())).json()).count, 0);
  assert.strictEqual(state._map.size, 0, 'storage must not keep the dead session');
});

test('a re-beat refreshes the stored record, not just the cached one', async () => {
  const state = fakeState();
  const c = await durableCounter(state);
  const id = uuid();
  await c.fetch(post({ id, v: '3.3.0' }));
  await c.fetch(post({ id, v: '3.4.0' }));   // same session, upgraded app

  const fresh = await durableCounter(state);
  const out = await (await fresh.fetch(get())).json();
  assert.strictEqual(out.count, 1, 'still one session, not two');
  assert.deepStrictEqual(out.versions, { '3.4.0': 1 }, 'the newer version must have been written through');
});

test('the counter still works with no storage behind it at all', async () => {
  // The offline path the other tests use. Passing no state must not throw —
  // it simply behaves as the old memory-only counter did.
  const c = await counter();
  assert.strictEqual((await (await c.fetch(post({ id: uuid() }))).json()).count, 1);
});

// ── Platform breakdown ───────────────────────────────────────────────────────

test('sessions are bucketed by platform under display names', async () => {
  const c = await counter();
  await c.fetch(post({ id: uuid(), v: '3.4.0', p: 'win32' }));
  await c.fetch(post({ id: uuid(), v: '3.4.0', p: 'darwin' }));
  await c.fetch(post({ id: uuid(), v: '3.4.0', p: 'darwin' }));
  const body = await (await c.fetch(get())).json();
  assert.strictEqual(body.count, 3);
  assert.deepStrictEqual(body.platforms, { Windows: 1, macOS: 2 });
});

test('a client that sends no platform still counts, as unknown', async () => {
  // Every build shipped before platform reporting existed. They must keep
  // counting exactly as before and simply not contribute to the breakdown.
  const c = await counter();
  await c.fetch(post({ id: uuid(), v: '3.4.0' }));
  await c.fetch(post({ id: uuid(), v: '3.4.0', p: 'linux' }));
  const body = await (await c.fetch(get())).json();
  assert.strictEqual(body.count, 2);
  assert.deepStrictEqual(body.platforms, { unknown: 1, Linux: 1 });
});

test('an unrecognised platform is never echoed back', async () => {
  // The field is attacker-controlled and the response is public. Unlike the
  // version field, which must pass arbitrary release numbers through, this is a
  // closed allowlist — nothing the client says can ever reach the response.
  const c = await counter();
  for (const p of ['<script>alert(1)</script>', 'sunos', 'x'.repeat(500), 42, { a: 1 }, null]) {
    await c.fetch(post({ id: uuid(), p }));
  }
  const body = await (await c.fetch(get())).json();
  assert.deepStrictEqual(Object.keys(body.platforms), ['unknown']);
  assert.strictEqual(body.platforms.unknown, 6);
});

test('platform buckets sum to the count, and drop with a pruned session', async () => {
  const c = await counter();
  const stale = uuid();
  await c.fetch(post({ id: stale, p: 'win32' }));
  await c.fetch(post({ id: uuid(), p: 'darwin' }));
  c.sessions.get(stale).seen = Date.now() - (8 * 60 * 1000);

  const body = await (await c.fetch(get())).json();
  assert.strictEqual(body.count, 1);
  assert.deepStrictEqual(body.platforms, { macOS: 1 }, 'a pruned session must leave no bucket behind');
  assert.strictEqual(Object.values(body.platforms).reduce((a, b) => a + b, 0), body.count);
});

test('platform survives eviction along with the session', async () => {
  const state = fakeState();
  let c = await durableCounter(state);
  await c.fetch(post({ id: uuid(), v: '3.4.0', p: 'win32' }));

  c = await durableCounter(state);
  const body = await (await c.fetch(post({ id: uuid(), v: '3.4.0', p: 'darwin' }))).json();
  assert.strictEqual(body.count, 2);
  assert.deepStrictEqual(body.platforms, { Windows: 1, macOS: 1 });
});
