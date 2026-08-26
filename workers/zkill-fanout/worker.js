/**
 * zKill fan-out — one consumer instead of one per install.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * The intel feed walks zKillboard's R2Z2 sequence cursor: ask for the newest
 * sequence, then fetch each id in turn. Every client doing that independently
 * means the request count scales with INSTALLS. zKillboard describe their own
 * scale as "thousands of requests per minute"; 100k clients at the feed's IDLE
 * cadence of one request per 15s is ~6,700 requests/second — around a hundred
 * times their entire stated traffic, from this app alone, against a service run
 * by volunteers who ask only that callers be polite.
 *
 * Rate-limiting the client (which we did) bounds ONE install. It cannot change
 * that arithmetic. Only fanning out does: this Worker polls upstream once and
 * serves everyone from cache.
 *
 * WHY IT MIRRORS THE UPSTREAM ROUTES EXACTLY
 *
 * It serves the same two paths with the same shapes:
 *
 *   GET /ephemeral/sequence.json  -> { "sequence": 96088891 }
 *   GET /ephemeral/<id>.json      -> one killmail, or 404 if not there yet
 *
 * so the client needs no protocol change at all — only a different base URL,
 * and it can be pointed back at zKillboard by unsetting one variable. A bespoke
 * protocol would have made this Worker a hard dependency; mirroring keeps it an
 * optimisation you can switch off.
 *
 * WHY THE FAN-OUT ACTUALLY WORKS
 *
 * Every client walks the SAME cursor, so they all ask for the same ids at
 * roughly the same time. Caching by URL therefore collapses N concurrent
 * clients onto one upstream fetch — the requests are naturally identical rather
 * than merely similar.
 *
 * A killmail is immutable once published, so it is cached hard. The sequence is
 * the only moving part, and it is refreshed at most once every SEQUENCE_TTL
 * seconds no matter how many clients ask — that single number is what bounds
 * upstream load, and it does not grow with users.
 */

const DEFAULT_UPSTREAM = 'https://r2z2.zkillboard.com';

// Upstream polling floor for the cursor. Ten thousand clients or one, upstream
// sees at most one sequence request per this interval per edge location.
const SEQUENCE_TTL = 5;
// A killmail never changes once published.
const KILLMAIL_TTL = 3600;
// A 404 means "not published yet", which is a normal part of walking the
// cursor. Cached briefly so a burst of clients on the leading edge does not
// become a burst upstream, but short enough that the kill appears promptly.
const NOT_FOUND_TTL = 5;

const SEQUENCE_PATH = '/ephemeral/sequence.json';
const KILLMAIL_RE = /^\/ephemeral\/(\d{1,20})\.json$/;

/** Identify ourselves upstream. Cloudflare answers 403 to a blank User-Agent,
 *  and it is how zKillboard identify and contact whoever is calling. */
function upstreamHeaders(env) {
  return {
    'User-Agent': env.UPSTREAM_USER_AGENT
      || 'EVE-Carbon-zkill-fanout (+https://github.com/mcpanayides/EVE-CARBON)',
    'Accept': 'application/json',
  };
}

function json(body, status, ttl, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Both the edge cache and the client honour this.
      'Cache-Control': `public, max-age=${ttl}`,
      'X-Fanout': 'eve-carbon',
      ...extra,
    },
  });
}

/**
 * Fetch upstream through the edge cache.
 *
 * `cf.cacheTtl` is what makes many clients one origin request: concurrent
 * requests for the same URL collapse, so the leading edge of the cursor — where
 * every client is at once — costs one fetch rather than one per client.
 */
async function fromUpstream(url, ttl, env) {
  return fetch(url, {
    headers: upstreamHeaders(env),
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method not allowed' }, 405, 0, { Allow: 'GET, HEAD' });
    }

    const url = new URL(request.url);
    const upstream = (env.UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, '');

    // Health/identity, so a deployment can be checked without touching upstream.
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'zkill-fanout', upstream }, 200, 60);
    }

    if (url.pathname === SEQUENCE_PATH) {
      const res = await fromUpstream(upstream + SEQUENCE_PATH, SEQUENCE_TTL, env);
      if (!res.ok) return json({ error: 'upstream', status: res.status }, 502, 0);
      // Re-serialised rather than streamed through, so a malformed upstream body
      // cannot be passed off as a valid cursor to every client at once.
      let seq;
      try {
        const body = await res.json();
        seq = Number(body?.sequence);
      } catch (_) {
        return json({ error: 'upstream returned invalid JSON' }, 502, 0);
      }
      if (!Number.isFinite(seq) || seq <= 0) {
        return json({ error: 'upstream returned no sequence' }, 502, 0);
      }
      return json({ sequence: seq }, 200, SEQUENCE_TTL);
    }

    const km = KILLMAIL_RE.exec(url.pathname);
    if (km) {
      const res = await fromUpstream(`${upstream}/ephemeral/${km[1]}.json`, KILLMAIL_TTL, env);
      if (res.status === 404) return json({ error: 'not found' }, 404, NOT_FOUND_TTL);
      if (!res.ok) return json({ error: 'upstream', status: res.status }, 502, 0);
      const text = await res.text();
      return json(text, 200, KILLMAIL_TTL);
    }

    // Deliberately NOT an open proxy: only the two routes the feed uses are
    // served, so this cannot be pointed at the rest of zKillboard's API.
    return json({ error: 'not found' }, 404, 0);
  },
};
