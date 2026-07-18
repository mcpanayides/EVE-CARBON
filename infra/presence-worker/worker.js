// EVE-Carbon presence worker — anonymous concurrent-user counter.
//
// Each running app POSTs {id: <random per-launch UUID>} every ~5 minutes; the
// response carries the current count. Sessions live only in the Durable
// Object's memory with a 7-minute TTL — nothing is ever persisted, no IPs or
// identities are stored, and when the object idles out the data ceases to
// exist. GET returns the count without registering a session.

const SESSION_TTL_MS = 7 * 60 * 1000;   // > 5-min heartbeat + jitter + slack
const MAX_SESSIONS   = 100_000;         // memory guard against abuse

export class PresenceCounter {
  constructor() {
    this.sessions = new Map();          // sessionId -> lastSeen (ms)
  }

  prune(now) {
    for (const [id, seen] of this.sessions) {
      if (now - seen > SESSION_TTL_MS) this.sessions.delete(id);
    }
  }

  async fetch(request) {
    const now = Date.now();
    this.prune(now);

    if (request.method === 'POST') {
      let id = null;
      try { id = (await request.json()).id; } catch (_) { /* ignore bad JSON */ }
      if (typeof id === 'string' && /^[0-9a-f-]{16,64}$/i.test(id)
          && (this.sessions.has(id) || this.sessions.size < MAX_SESSIONS)) {
        this.sessions.set(id, now);
      }
    }
    return Response.json({ count: this.sessions.size });
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
