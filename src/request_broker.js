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
// THREE MECHANISMS, in the order they save work:
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

const _fresh    = new Map();   // key -> { value, expires }
const _inflight = new Map();   // key -> Promise
const _negative = new Map();   // key -> { error, expires }
const _lanes    = new Map();   // host -> { active, max, queue: [] }

const stats = { hits: 0, coalesced: 0, negative: 0, requests: 0, queued: 0 };

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
  };
}

module.exports = { get, invalidate, snapshot, ttlFromHeaders, cacheKey };
