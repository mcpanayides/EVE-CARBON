'use strict';
//
// One gate every outbound GET passes through, so "keep the UI live" stops
// meaning "open another socket".
//
// THE PROBLEM IT SOLVES, measured (net-log.csv, 2026-08-02):
//   • /latest/industry/systems/ fetched 30x in 10s — the identical URL, all in
//     flight together, response time degrading 4.4s -> 13.4s as they starved
//     each other. 263s of cumulative connection time for one payload.
//   • market.fuzzwork.co.uk/aggregates/ 22x, oauth/token 17x in the same window.
//   • Opening a page peaked at 34 concurrent requests.
// None of that is a polling bug. It's many independent callers each asking for
// the same thing at the same time, with nothing in between them and the socket.
//
// FOUR MECHANISMS, in the order they save work:
//
//  1. FRESH-CACHE HIT — no request at all. A response is kept for exactly as
//     long as the SERVER said it is good for (Cache-Control: max-age / Expires).
//     This is not a staleness trade: inside that window the origin is serving a
//     cached copy anyway, so a second request cannot return newer data. It's the
//     freshest answer obtainable, minus the round trip.
//
//  2. SINGLE-FLIGHT — one request, many awaiters. Concurrent callers for the
//     same key attach to the in-flight promise instead of starting their own.
//     This alone collapses the 30x above to 1x, and it needs no TTL guess: it is
//     always correct, because the answers would have been identical anyway.
//
//  3. LANE LIMIT — a per-host ceiling on concurrent requests. Everything still
//     runs; it just queues instead of stampeding, which is what keeps a page
//     open from putting 34 sockets on the wire and starving the game client
//     sharing the connection.
//
//  4. RATE GOVERNOR — a per-host token bucket, because CONCURRENCY IS NOT RATE.
//     A lane of 8 against fast responses is far more than 8 requests/second, so
//     the lane limit alone never bounded how hard we hit anyone. Measured
//     2026-08-17: steady state across the whole app is ~0.9 req/s, so this
//     never bites in normal use — it exists so that a runaway loop, a retry
//     storm, or a future feature cannot quietly become somebody else's outage.
//     Being polite per-feature was the alternative, and that is the pattern
//     that already failed three times on ESI versioning.
//
// Plus a short NEGATIVE CACHE: a 4xx is remembered briefly so 29 blueprint
// icons that 400 don't get re-requested four times each.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH:
//   • POSTs — not idempotent in general, so never coalesced or cached here.
//     (Token refresh gets its own single-flight in main.js, keyed by character.)
//   • The ESI error-limit gate, ETag/304 handling and the compat-date header —
//     those live inside the transport and still run for every REAL request. The
//     broker sits outside them, so a cache hit skips the lot and a miss gets all
//     of it unchanged.

const crypto = require('crypto');

const DEFAULT_LANE      = 6;        // concurrent requests per host
const LANES             = { 'esi.evetech.net': 8 };
const MAX_TTL_MS        = 60 * 60 * 1000;   // never trust a cache header beyond an hour
const NEGATIVE_TTL_MS   = 5 * 60 * 1000;    // how long a 4xx is remembered
const MAX_CACHE_ENTRIES = 500;              // bound the memory this can hold

// Per-host rate ceilings. `burst` is the bucket size — how many requests may go
// out back-to-back before the sustained rate starts pacing them.
//
// WHY THESE NUMBERS:
//  • ESI is CCP's, CDN-backed, and built for third-party apps; its published
//    constraint is the ERROR budget (100 errors/60s), not volume. The burst is
//    sized to the measured 34-request page-open peak so opening a page is not
//    made to feel slower — the governor is a backstop, not a throttle on
//    ordinary use.
//  • zKillboard is a free, volunteer-run service that publishes no numeric
//    limit at all, only "do not hammer the server, be polite". Their own scale
//    is described as "thousands of requests per minute" TOTAL, so a single
//    desktop client has no business anywhere near what we were doing.
//    Deliberately strict — and split, because the two hosts are used for
//    completely different things:
//      · zkillboard.com  — the REST API. Occasional bulk pulls (the fleet AAR
//        reads one page per system, once, at op close). Nothing needs speed.
//      · r2z2.zkillboard.com — the live sequence cursor. Must keep pace with
//        New Eden's actual kill rate (~0.3-1/s baseline, spiky) or it falls
//        behind and starts discarding kills, so 1/s here would break the
//        feature rather than tune it. Matches STEP_MS in zkill_stream.js; if
//        you change one, change the other or they fight.
const DEFAULT_RATE = { perSec: 5, burst: 10 };
const RATES = {
  'esi.evetech.net':     { perSec: 15,  burst: 30 },
  'zkillboard.com':      { perSec: 1,   burst: 3  },
  'r2z2.zkillboard.com': { perSec: 2.5, burst: 5  },
};
let _rates = { ...RATES };

const _fresh    = new Map();   // key -> { value, expires }
const _inflight = new Map();   // key -> Promise
const _negative = new Map();   // key -> { error, expires }
const _lanes    = new Map();   // host -> { active, max, queue: [] }
const _buckets  = new Map();   // host -> { tokens, burst, perSec, last, queue, timer }

const stats = { hits: 0, coalesced: 0, negative: 0, requests: 0, queued: 0, throttled: 0 };

// SHA-256, and 32 hex characters of it rather than 16.
//
// This hashes an ESI access token, so a collision is not a hash-academia
// problem — it is two different characters sharing a cache entry, which means
// one pilot being served another's authenticated response. The old SHA-1/64-bit
// pair was weak on both counts: SHA-1 has practical collision attacks, and 64
// bits puts a birthday collision at roughly 2^32 tokens, which is closer than
// it sounds for a value that changes on every token refresh.
//
// Not a password hash — the input is high-entropy and short-lived, so a plain
// digest is the right tool; only its strength and width needed fixing.
function _hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
}

// The Authorization header is part of the identity of a GET: two characters
// asking for the same URL must never share a response. Hashed, not stored.
function cacheKey(url, headers) {
  const auth = (headers && (headers.Authorization || headers.authorization)) || '';
  return url + '|' + (auth ? _hash(auth) : '-');
}

function _hostOf(url) {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

// How long the ORIGIN says this response is good for. Falls back to 0 (do not
// cache) rather than guessing — a wrong guess here would show stale data.
function ttlFromHeaders(headers) {
  if (!headers) return 0;
  const cc = String(headers['cache-control'] || '');
  if (/\bno-store\b|\bno-cache\b/i.test(cc)) return 0;
  const m = /\bmax-age\s*=\s*(\d+)/i.exec(cc);
  if (m) {
    const age = parseInt(headers['age'] || '0', 10) || 0;
    return Math.max(0, Math.min(MAX_TTL_MS, (parseInt(m[1], 10) - age) * 1000));
  }
  const exp = headers['expires'];
  if (exp) {
    const t = Date.parse(exp);
    if (!Number.isNaN(t)) return Math.max(0, Math.min(MAX_TTL_MS, t - Date.now()));
  }
  return 0;
}

function _prune(map) {
  const now = Date.now();
  for (const [k, v] of map) if (v.expires <= now) map.delete(k);
  // Still oversized after dropping the expired? Evict oldest-inserted (Map
  // preserves insertion order) — a bounded cache that never grows without limit.
  while (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}

function _lane(host) {
  let l = _lanes.get(host);
  if (!l) { l = { active: 0, max: LANES[host] || DEFAULT_LANE, queue: [] }; _lanes.set(host, l); }
  return l;
}

// Acquire a slot in the host's lane, waiting if it's full.
function _acquire(host) {
  const l = _lane(host);
  if (l.active < l.max) { l.active++; return Promise.resolve(); }
  stats.queued++;
  return new Promise(resolve => l.queue.push(resolve));
}

function _release(host) {
  const l = _lane(host);
  const next = l.queue.shift();
  if (next) next();          // hand the slot straight over — active stays put
  else l.active = Math.max(0, l.active - 1);
}

// ── Rate governor ────────────────────────────────────────────────────────────
// A token bucket per host. Tokens accrue continuously at `perSec` and cap at
// `burst`, so an idle host has a full bucket ready and a busy one is paced.

function _bucket(host) {
  let b = _buckets.get(host);
  if (!b) {
    const cfg = _rates[host] || DEFAULT_RATE;
    b = { tokens: cfg.burst, burst: cfg.burst, perSec: cfg.perSec,
          last: Date.now(), queue: [], timer: null };
    _buckets.set(host, b);
  }
  return b;
}

// Accrue tokens for the time that has passed. Fractional on purpose: rounding
// down here would leak budget on every call and drift the effective rate below
// the configured one.
function _refill(b, now) {
  const elapsed = now - b.last;
  if (elapsed <= 0) return;
  b.tokens = Math.min(b.burst, b.tokens + (elapsed / 1000) * b.perSec);
  b.last   = now;
}

// Milliseconds until the bucket holds a whole token.
function _waitFor(b) {
  return Math.max(10, Math.ceil(((1 - b.tokens) / b.perSec) * 1000));
}

function _pump(b) {
  if (b.timer) return;
  const step = () => {
    b.timer = null;
    _refill(b, Date.now());
    while (b.queue.length && b.tokens >= 1) {
      b.tokens -= 1;
      b.queue.shift()();
    }
    if (b.queue.length) {
      b.timer = setTimeout(step, _waitFor(b));
      if (b.timer.unref) b.timer.unref();
    }
  };
  b.timer = setTimeout(step, _waitFor(b));
  // unref, so a queue of throttled background polls can never delay app quit —
  // at zKillboard's 1/s a backlog of 20 would otherwise hold the process open
  // for 20 seconds on exit.
  //
  // THE CONSEQUENCE, verified rather than assumed: if nothing else is holding
  // the event loop open, the process exits and a queued promise NEVER SETTLES —
  // it does not reject, it simply never resolves. In Electron main the app
  // itself holds the loop, so this only shows up in bare `node -e` probes and
  // in tests. Do not `await` a broker call from a shutdown path and expect it
  // to come back.
  if (b.timer.unref) b.timer.unref();
}

// Spend a token, waiting if the bucket is empty.
function _token(host) {
  const b = _bucket(host);
  _refill(b, Date.now());
  // The empty-queue check is what keeps this FIFO: without it a request
  // arriving on a briefly-refilled bucket would overtake everything already
  // waiting, and under sustained load the queue would never drain.
  if (b.tokens >= 1 && !b.queue.length) { b.tokens -= 1; return Promise.resolve(); }
  stats.throttled++;
  return new Promise(resolve => { b.queue.push(resolve); _pump(b); });
}

/**
 * Run an idempotent GET through the broker.
 *
 * @param {string}   url
 * @param {object}   headers   request headers (Authorization participates in the key)
 * @param {Function} perform   () => Promise<{ value, headers }> — the real request
 * @returns {Promise<*>} the response value
 */
async function get(url, headers, perform) {
  const key = cacheKey(url, headers);
  const now = Date.now();

  const hit = _fresh.get(key);
  if (hit && hit.expires > now) { stats.hits++; return hit.value; }

  const bad = _negative.get(key);
  if (bad && bad.expires > now) { stats.negative++; throw bad.error; }

  const running = _inflight.get(key);
  if (running) { stats.coalesced++; return running; }

  const host = _hostOf(url);
  const p = (async () => {
    await _acquire(host);
    try {
      // Rate gate sits INSIDE the lane slot, so a request waiting on a token is
      // holding its slot and the lane stays honest about what is outstanding.
      // Taking the token first would spend budget on a request that then sits in
      // the lane queue, pacing departures slower than configured.
      await _token(host);
      stats.requests++;
      const { value, headers: resHeaders } = await perform();
      const ttl = ttlFromHeaders(resHeaders);
      if (ttl > 0) { _fresh.set(key, { value, expires: Date.now() + ttl }); _prune(_fresh); }
      return value;
    } catch (e) {
      // Only client errors are worth remembering — a 4xx will keep being a 4xx
      // for this URL. 5xx and network failures are transient, so they stay
      // retryable, and a rate-limit answer must never be cached as a verdict.
      if (/HTTP 4\d\d/.test(e.message || '') && !e.isRateLimit) {
        _negative.set(key, { error: e, expires: Date.now() + NEGATIVE_TTL_MS });
        _prune(_negative);
      }
      throw e;
    } finally {
      _release(host);
      _inflight.delete(key);
    }
  })();

  _inflight.set(key, p);
  return p;
}

// Drop everything for a host (or all of it). For "refresh now" actions, where
// the user is explicitly asking to go past the cache.
function invalidate(hostOrUrl) {
  if (!hostOrUrl) { _fresh.clear(); _negative.clear(); return; }
  for (const map of [_fresh, _negative]) {
    for (const k of map.keys()) if (k.includes(hostOrUrl)) map.delete(k);
  }
}

function snapshot() {
  return {
    ...stats,
    cached: _fresh.size,
    inflight: _inflight.size,
    negative: _negative.size,
    lanes: [..._lanes].map(([h, l]) => `${h}:${l.active}/${l.max}${l.queue.length ? '+' + l.queue.length : ''}`),
    rates: [..._buckets].map(([h, b]) =>
      `${h}:${b.tokens.toFixed(1)}/${b.burst}@${b.perSec}/s${b.queue.length ? '+' + b.queue.length : ''}`),
  };
}

/**
 * Take a rate token for a URL's host, with none of the caching.
 *
 * For callers that MUST bypass the cache but must NOT bypass the ceiling.
 * `src/intel/zkill_stream.js` is the case this exists for: every caching layer
 * in the normal path breaks that feed silently — a cached `sequence.json` means
 * the cursor never advances and no killmail ever arrives again, while the loop
 * reports itself perfectly healthy. So it does its own GETs, and without this it
 * was the one feature the governor could not reach, which was also the only
 * feature fast enough to need it.
 */
async function reserve(url) {
  await _token(_hostOf(url));
}

/**
 * Override a host's rate ceiling. Exists so the limits can be tuned without a
 * release, and so tests can pick a rate that makes their assertion sharp rather
 * than inheriting a production number they do not care about.
 */
function setRate(host, { perSec, burst }) {
  _rates[host] = { perSec, burst };
  const b = _buckets.get(host);
  if (b) {                       // retune a live bucket in place
    if (b.timer) { clearTimeout(b.timer); b.timer = null; }
    b.perSec = perSec;
    b.burst  = burst;
    b.tokens = Math.min(b.tokens, burst);
    if (b.queue.length) _pump(b);
  }
}

/** Restore the shipped rate table and drop all bucket state. */
function resetRates() {
  for (const b of _buckets.values()) if (b.timer) clearTimeout(b.timer);
  _buckets.clear();
  _rates = { ...RATES };
}

module.exports = { get, reserve, invalidate, snapshot, ttlFromHeaders, cacheKey, setRate, resetRates };
