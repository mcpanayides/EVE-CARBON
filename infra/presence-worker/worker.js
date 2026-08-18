// EVE-Carbon presence worker — anonymous concurrent-user counter.
//
// Each running app POSTs {id: <random per-launch UUID>, v: "<app version>"}
// every ~5 minutes; the response carries the current count and a breakdown by
// version. Sessions carry a 7-minute TTL. No IPs or identities are stored — a
// session is a random per-launch UUID and a version string, nothing more. GET
// returns the counts without registering a session.
//
// ── Why sessions are written to storage, and why they must be ────────────────
//
// The first version kept sessions ONLY in `this.sessions`, a plain in-memory
// Map, on the reasoning that a memory-only counter stores nothing and therefore
// leaks nothing. That reasoning was fine; the assumption underneath it was not.
//
// A Durable Object is evicted from memory when idle, and MEASURED 2026-08-17 it
// happens within FIFTEEN SECONDS: two sessions registered with a 7-minute TTL
// read back as `count: 0` fifteen seconds later. With a 5-minute heartbeat, no
// two clients are ever in memory at the same time — every beat arrives at a
// freshly cold-started object holding nothing, registers itself, and is told
// `count: 1`. Three users on three machines each saw "1 online", which is
// exactly what that produces and looks precisely like a counter that works.
//
// The TTL was doing nothing. Eviction was collecting sessions long before it
// could. So the Map is now a read cache in front of DO storage, hydrated on
// wake — storage survives eviction, memory does not.
//
// Privacy is unchanged: the same UUID and version, now durable for the same 7
// minutes and pruned on every request. Nothing new is retained.
//
// ── Version reporting is deliberately optional ──────────────────────────────
// A client that sends no version is still counted; it simply lands in the
// "unknown" bucket. That is what keeps the counter agnostic across releases: a
// user who never upgrades past 3.3.0 stays visible in the total forever, and
// every client built before version reporting existed keeps working untouched.
// The count is the number of SESSIONS, never the sum of the buckets, so a
// version that fails validation can never make somebody disappear from it.

const SESSION_TTL_MS = 7 * 60 * 1000;   // > 5-min heartbeat + jitter + slack
const MAX_SESSIONS   = 100_000;         // memory guard against abuse

// Anything not a plain dotted release number is bucketed as unknown rather than
// stored. This response is public and the field is attacker-controlled, so it is
// never echoed back unvalidated — and the bound keeps one abusive client from
// inventing enough distinct "versions" to bloat the payload.
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,16})?$/;
const UNKNOWN = 'unknown';

function normaliseVersion(v) {
  return (typeof v === 'string' && VERSION_RE.test(v)) ? v : UNKNOWN;
}

// Platform is an ALLOWLIST, not a pattern. The set is tiny and fully known, so
// there is no reason to accept anything outside it — and unlike the version
// field, which must pass through arbitrary release numbers, nothing here is ever
// derived from what the client said. A client sending "win32" gets "Windows"
// because the worker decided that, not because it echoed the input.
//
// Keys are Node's `process.platform` values, sent raw by the client so the
// mapping lives in one place rather than in every app version.
const PLATFORMS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function normalisePlatform(p) {
  return (typeof p === 'string' && PLATFORMS[p]) || UNKNOWN;
}

const KEY = 's:';                       // storage key prefix for a session

export class PresenceCounter {
  /**
   * @param {DurableObjectState} [state] omitted only by the offline tests, which
   *   exercise the counting rules with no storage behind them.
   */
  constructor(state) {
    this.state = state || null;
    this.sessions = new Map();          // sessionId -> { seen, v } — cache over storage

    // Hydrate before ANY request is served. blockConcurrencyWhile is what makes
    // this safe: without it the first beat after a wake would be answered from
    // an empty map and report a count of 1 — the very bug this fixes, just
    // moved into a race.
    if (this.state && this.state.blockConcurrencyWhile) {
      this.state.blockConcurrencyWhile(async () => {
        const stored = await this.state.storage.list({ prefix: KEY });
        for (const [k, v] of stored) this.sessions.set(k.slice(KEY.length), v);
      });
    }
  }

  /** Drop expired sessions from the cache AND from storage, so neither grows. */
  async prune(now) {
    const dead = [];
    for (const [id, s] of this.sessions) {
      if (now - s.seen > SESSION_TTL_MS) { this.sessions.delete(id); dead.push(KEY + id); }
    }
    if (dead.length && this.state) await this.state.storage.delete(dead);
  }

  /**
   * { versions: {"3.3.0": 12, unknown: 5}, platforms: {Windows: 9, macOS: 8} }
   *
   * Counted fresh on every request so a pruned session leaves both tallies at
   * once — a bucket that outlived its session would make the breakdown add up
   * to more than the headline count.
   */
  tally() {
    const versions = {}, platforms = {};
    for (const s of this.sessions.values()) {
      versions[s.v] = (versions[s.v] || 0) + 1;
      platforms[s.p || UNKNOWN] = (platforms[s.p || UNKNOWN] || 0) + 1;
    }
    return { versions, platforms };
  }

  async fetch(request) {
    const now = Date.now();
    await this.prune(now);

    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (_) { /* ignore bad JSON */ }
      const id = body?.id;
      if (typeof id === 'string' && /^[0-9a-f-]{16,64}$/i.test(id)
          && (this.sessions.has(id) || this.sessions.size < MAX_SESSIONS)) {
        const rec = { seen: now, v: normaliseVersion(body?.v), p: normalisePlatform(body?.p) };
        this.sessions.set(id, rec);
        // Written through rather than cached and flushed later: the next beat
        // may well arrive at a different instance of this object, and anything
        // still only in memory at that point is gone.
        if (this.state) await this.state.storage.put(KEY + id, rec);
      }
    }

    // count stays a top-level number and `versions` keeps its exact old shape,
    // so every client that predates this change keeps reading what it always
    // did. `platforms` is purely additive — an old app ignores it.
    return Response.json({ count: this.sessions.size, ...this.tally() });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/presence' || !['GET', 'POST'].includes(request.method)) {
      return new Response('Not found', { status: 404 });
    }
    // One global counter object for the whole app — every client must land on
    // the same instance or each would count only itself.
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName('global'));
    return stub.fetch(request);
  },
};
