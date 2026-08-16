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
