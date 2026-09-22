'use strict';
//
// The zKill fan-out Worker's request handling.
//
// The Worker was written but never deployed, and until now nothing tested what
// it actually serves — zkill_fanout.test.js only covers the CLIENT's parsing of
// EVE_CARBON_ZKILL_BASE. Before it takes a single real request, these pin the
// properties it exists to have:
//
//   • it is NOT an open proxy — only the feed's routes are served, and nothing
//     else reaches upstream at all;
//   • it never hands a bad cursor to every client at once — a malformed or
//     empty upstream sequence is a 502, not something passed through;
//   • its cache lifetimes are the ones the fan-out arithmetic depends on — the
//     sequence short, a published killmail long, a not-yet-published one short;
//   • it identifies itself upstream, because Cloudflare 403s a blank User-Agent
//     and it is how zKillboard know whom to contact.
//
// The handler is the real worker.js default export, driven with real Request
// objects (Node has the same globals the Workers runtime does) and a faked
// upstream in place of global fetch.
const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const { pathToFileURL } = require('url');

const WORKER = pathToFileURL(path.join(__dirname, '..', 'workers', 'zkill-fanout', 'worker.js')).href;
const ENV = { UPSTREAM: 'https://upstream.test', UPSTREAM_USER_AGENT: 'EVE-Carbon-test' };

/**
 * Replace global fetch with a scripted upstream, recording every call.
 * `routes` maps a path to [status, body] or a function (url) => [status, body].
 */
function fakeUpstream(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const p = new URL(String(url)).pathname;
    let hit = routes[p];
    if (typeof hit === 'function') hit = hit(p);
    const [status, body] = hit || [404, '{"error":"not found"}'];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function worker() {
  return (await import(WORKER)).default;
}

async function call(pathname, { method = 'GET', env = ENV } = {}) {
  const w = await worker();
  return w.fetch(new Request(`https://fanout.test${pathname}`, { method }), env);
}

const maxAge = (res) => Number((/max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '') || [])[1]);

// ─── not an open proxy ───────────────────────────────────────────────────────

test('anything but the feed routes is refused without touching upstream', async () => {
  const up = fakeUpstream({});
  try {
    for (const p of ['/api/kills/', '/ephemeral/', '/ephemeral/abc.json',
                     '/ephemeral/1.json/extra', '/ephemeral/../secret.json', '/killID/1/']) {
      const res = await call(p);
      assert.strictEqual(res.status, 404, p);
    }
    assert.strictEqual(up.calls.length, 0, 'a refused path must never become an upstream request');
  } finally { up.restore(); }
});

test('only GET and HEAD are served', async () => {
  const up = fakeUpstream({ '/ephemeral/sequence.json': [200, { sequence: 5 }] });
  try {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await call('/ephemeral/sequence.json', { method: m });
      assert.strictEqual(res.status, 405, m);
      assert.match(res.headers.get('Allow'), /GET/);
    }
    assert.strictEqual(up.calls.length, 0);
  } finally { up.restore(); }
});

test('the health route answers without reaching upstream', async () => {
  const up = fakeUpstream({});
  try {
    const res = await call('/health');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.service, 'zkill-fanout');
    assert.strictEqual(body.upstream, 'https://upstream.test');
    assert.strictEqual(up.calls.length, 0, 'a deployment check must not cost an upstream request');
  } finally { up.restore(); }
});

// ─── the cursor ──────────────────────────────────────────────────────────────

test('the sequence is passed through with the short cache that bounds upstream', async () => {
  const up = fakeUpstream({ '/ephemeral/sequence.json': [200, { sequence: 96088891 }] });
  try {
    const res = await call('/ephemeral/sequence.json');
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).sequence, 96088891);
    // This single number is what caps upstream load regardless of client count.
    assert.strictEqual(maxAge(res), 5);
    assert.strictEqual(res.headers.get('X-Fanout'), 'eve-carbon');
  } finally { up.restore(); }
});

test('a broken upstream cursor is a 502, never a cursor handed to every client', async () => {
  // Every client walks this one number. Passing a bad one through would send
  // the whole install base somewhere wrong at once, so each of these must stop
  // at the Worker — and must not be cached, or the bad answer would stick.
  const cases = [
    [500, { sequence: 1 }],            // upstream down
    [200, 'not json at all'],          // malformed body
    [200, { sequence: 0 }],            // not a real sequence
    [200, { sequence: -4 }],
    [200, { nope: true }],             // missing field
  ];
  for (const [status, body] of cases) {
    const up = fakeUpstream({ '/ephemeral/sequence.json': [status, body] });
    try {
      const res = await call('/ephemeral/sequence.json');
      assert.strictEqual(res.status, 502, JSON.stringify(body));
      assert.strictEqual(maxAge(res), 0, 'an error must not be cached');
    } finally { up.restore(); }
  }
});

// ─── killmails ───────────────────────────────────────────────────────────────

test('a published killmail is served as-is and cached hard', async () => {
  const km = { killmail_id: 123, zkb: { totalValue: 1 } };
  const up = fakeUpstream({ '/ephemeral/123.json': [200, km] });
  try {
    const res = await call('/ephemeral/123.json');
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).killmail_id, 123);
    assert.strictEqual(maxAge(res), 3600, 'a killmail never changes once published');
  } finally { up.restore(); }
});

test('a killmail not yet published is a briefly-cached 404', async () => {
  // Walking the leading edge of the cursor hits these constantly. Cached a
  // little so a crowd of clients on the edge is one upstream request, but only
  // a little, so the kill still appears promptly once it exists.
  const up = fakeUpstream({});
  try {
    const res = await call('/ephemeral/999.json');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(maxAge(res), 5);
  } finally { up.restore(); }
});

test('an upstream failure on a killmail is a 502, not a cached 404', async () => {
  // Reporting "not found" for what was really an outage would cache a false
  // gap into every client's feed.
  const up = fakeUpstream({ '/ephemeral/7.json': [503, 'down'] });
  try {
    const res = await call('/ephemeral/7.json');
    assert.strictEqual(res.status, 502);
    assert.strictEqual(maxAge(res), 0);
  } finally { up.restore(); }
});

// ─── talking to upstream ─────────────────────────────────────────────────────

test('it identifies itself upstream and asks the edge to cache', async () => {
  const up = fakeUpstream({ '/ephemeral/sequence.json': [200, { sequence: 5 }] });
  try {
    await call('/ephemeral/sequence.json');
    const { url, init } = up.calls[0];
    assert.strictEqual(url, 'https://upstream.test/ephemeral/sequence.json');
    assert.strictEqual(init.headers['User-Agent'], 'EVE-Carbon-test');
    // The edge cache is what collapses concurrent clients onto one origin fetch.
    assert.strictEqual(init.cf.cacheEverything, true);
    assert.strictEqual(init.cf.cacheTtlByStatus['200-299'], 5);
  } finally { up.restore(); }
});

// ─── the layer the first deployment got wrong ───────────────────────────────
// The tests above check the headers the Worker sends to CLIENTS. What stalled
// the real feed was a different layer: the cache instruction on the UPSTREAM
// fetch. `cf.cacheTtl` applies its TTL whatever the status, so the 404 for a
// killmail that was not published yet was cached for the hour meant for a real
// one. The id every client was waiting on then read "not found" from this cache
// for an hour while zKillboard served it fine — and the client, whose cursor
// was ahead of zKillboard's edge-cached sequence, had no reason to skip past it.
// These pin the upstream instruction itself.

test('a killmail not published yet is never cached for a killmail lifetime', async () => {
  const up = fakeUpstream({});
  try {
    await call('/ephemeral/424242.json');
    const cf = up.calls[0].init.cf;
    assert.strictEqual(cf.cacheTtl, undefined,
      'a bare cacheTtl caches the 404 as long as a published killmail');
    assert.strictEqual(cf.cacheTtlByStatus['200-299'], 3600, 'a published killmail never changes');
    assert.ok(cf.cacheTtlByStatus['404'] <= 5, 'an unpublished one must reappear within seconds');
    assert.strictEqual(cf.cacheTtlByStatus['500-599'], 0, 'an upstream error is never cached');
  } finally { up.restore(); }
});

test('the batched feed fetches each id under the same rule', async () => {
  const up = fakeUpstream({ '/ephemeral/sequence.json': [200, { sequence: 1234 }] });
  try {
    await call(`/feed/${Math.floor(1234 / 50)}.json`);
    const idFetches = up.calls.filter(c => !/sequence\.json$/.test(c.url));
    assert.ok(idFetches.length > 0);
    for (const c of idFetches) {
      assert.strictEqual(c.init.cf.cacheTtl, undefined);
      assert.ok(c.init.cf.cacheTtlByStatus['404'] <= 5, c.url);
    }
  } finally { up.restore(); }
});

test('the cursor never caches an upstream failure', async () => {
  const up = fakeUpstream({ '/ephemeral/sequence.json': [200, { sequence: 5 }] });
  try {
    await call('/ephemeral/sequence.json');
    const byStatus = up.calls[0].init.cf.cacheTtlByStatus;
    assert.strictEqual(byStatus['404'], 0);
    assert.strictEqual(byStatus['500-599'], 0);
  } finally { up.restore(); }
});

test('an unset upstream falls back to zKillboard itself', async () => {
  const up = fakeUpstream({ '/ephemeral/sequence.json': [200, { sequence: 5 }] });
  try {
    await call('/ephemeral/sequence.json', { env: {} });
    assert.match(up.calls[0].url, /^https:\/\/r2z2\.zkillboard\.com\/ephemeral\/sequence\.json$/);
    // A blank User-Agent is answered 403 by Cloudflare, so there must be one.
    assert.ok(up.calls[0].init.headers['User-Agent']);
  } finally { up.restore(); }
});

// ─── the batched feed ────────────────────────────────────────────────────────

test('the feed cursor reports which block it falls in', async () => {
  const up = fakeUpstream({ '/ephemeral/sequence.json': [200, { sequence: 1234 }] });
  try {
    const res = await call('/feed/sequence.json');
    const body = await res.json();
    assert.strictEqual(body.sequence, 1234);
    assert.strictEqual(body.bucketSize, 50);
    assert.strictEqual(body.bucket, Math.floor(1234 / 50));
  } finally { up.restore(); }
});

test('a finished block is cached for a day, the filling one only briefly', async () => {
  // Caching the newest block hard would freeze the feed for everyone at once.
  const kill = (p) => [200, { killmail_id: Number(/(\d+)\.json/.exec(p)[1]) }];
  const routes = { '/ephemeral/sequence.json': [200, { sequence: 1234 }] };
  for (let id = 1000; id <= 1300; id++) routes[`/ephemeral/${id}.json`] = kill;
  const up = fakeUpstream(routes);
  try {
    const finished = await call(`/feed/${Math.floor(1100 / 50)}.json`);
    const fb = await finished.json();
    assert.strictEqual(fb.complete, true);
    assert.strictEqual(maxAge(finished), 86400);
    assert.strictEqual(fb.count, 50);

    const filling = await call(`/feed/${Math.floor(1234 / 50)}.json`);
    const pb = await filling.json();
    assert.strictEqual(pb.complete, false);
    assert.strictEqual(maxAge(filling), 15);
    assert.strictEqual(pb.highest, 1234, 'it stops at the newest published id');
  } finally { up.restore(); }
});

test('a block in the future is refused rather than fetched', async () => {
  const up = fakeUpstream({ '/ephemeral/sequence.json': [200, { sequence: 100 }] });
  try {
    const res = await call('/feed/999.json');
    assert.strictEqual(res.status, 404);
    // Only the cursor was read; no id in a block that cannot exist yet.
    assert.ok(up.calls.every(c => /sequence\.json$/.test(c.url)));
  } finally { up.restore(); }
});
