// EVE-Carbon presence worker — anonymous concurrent-user counter.
//
// Each running app POSTs {id: <random per-launch UUID>, v: "<app version>"}
// every ~5 minutes; the response carries the current count and a breakdown by
// version. Sessions live only in the Durable Object's memory with a 7-minute
// TTL — nothing is ever persisted, no IPs or identities are stored, and when
// the object idles out the data ceases to exist. GET returns the counts without
// registering a session.
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

export class PresenceCounter {
  constructor() {
    this.sessions = new Map();          // sessionId -> { seen, v }
  }

  prune(now) {
    for (const [id, s] of this.sessions) {
      if (now - s.seen > SESSION_TTL_MS) this.sessions.delete(id);
    }
  }

  /** { "3.3.0": 12, "unknown": 5 } — counted fresh so a pruned session leaves. */
  tally() {
    const versions = {};
    for (const s of this.sessions.values()) {
      versions[s.v] = (versions[s.v] || 0) + 1;
    }
    return versions;
  }

  async fetch(request) {
    const now = Date.now();
    this.prune(now);

    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (_) { /* ignore bad JSON */ }
      const id = body?.id;
      if (typeof id === 'string' && /^[0-9a-f-]{16,64}$/i.test(id)
          && (this.sessions.has(id) || this.sessions.size < MAX_SESSIONS)) {
        this.sessions.set(id, { seen: now, v: normaliseVersion(body?.v) });
      }
    }

    // count stays a top-level number so clients that predate this change keep
    // reading exactly the field they always did.
    return Response.json({ count: this.sessions.size, versions: this.tally() });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/presence' || !['GET', 'POST'].includes(request.method)) {
      return new Response('Not found', { status: 404 });
    }
    // One global counter object for the whole app.
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName('global'));
    return stub.fetch(request);
  },
};
