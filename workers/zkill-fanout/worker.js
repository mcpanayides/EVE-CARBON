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

import { BUCKET_SIZE, bucketOf, bucketRange, isComplete } from './bucket.js';

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

// Batched routes. See bucket.js for why blocks rather than `?since=`.
const FEED_SEQUENCE_PATH = '/feed/sequence.json';
const FEED_BUCKET_RE = /^\/feed\/(\d{1,20})\.json$/;
// A finished block never changes, so it is cached for a long time. This is what
// makes the whole design cheap: one fill, then served from cache to every
// client for the rest of the day.
const BUCKET_COMPLETE_TTL = 86400;
// The newest block is still filling. Caching it hard would freeze the feed for
// everyone at once — the same failure the direct client avoids by never caching
// sequence.json.
const BUCKET_PARTIAL_TTL = 15;

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

/**
 * The newest sequence upstream has.
 *
 * Re-parsed rather than streamed through: a malformed upstream body must not be
 * passed off as a valid cursor to every client at once. Both the mirror route
 * and the batched routes go through here, so there is one definition of what a
 * usable cursor is.
 */
async function fetchSequence(upstream, env) {
  const res = await fromUpstream(upstream + SEQUENCE_PATH, SEQUENCE_TTL, env);
  if (!res.ok) return { error: { error: 'upstream', status: res.status }, status: 502 };
  let seq;
  try {
    seq = Number((await res.json())?.sequence);
  } catch (_) {
    return { error: { error: 'upstream returned invalid JSON' }, status: 502 };
  }
  if (!Number.isFinite(seq) || seq <= 0) {
    return { error: { error: 'upstream returned no sequence' }, status: 502 };
  }
  return { value: seq };
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
      const seq = await fetchSequence(upstream, env);
      if (seq.error) return json(seq.error, seq.status, 0);
      return json({ sequence: seq.value }, 200, SEQUENCE_TTL);
    }

    // ── Batched feed ─────────────────────────────────────────────────────────
    // Same cursor, quantised into fixed blocks so every client asks for the
    // same URLs. Costs ~4.5 requests/minute per client instead of ~32, and the
    // blocks are shared, so the cost is per BLOCK rather than per client.
    if (url.pathname === FEED_SEQUENCE_PATH) {
      const seq = await fetchSequence(upstream, env);
      if (seq.error) return json(seq.error, seq.status, 0);
      return json({ sequence: seq.value, bucket: bucketOf(seq.value), bucketSize: BUCKET_SIZE },
        200, SEQUENCE_TTL);
    }

    const fb = FEED_BUCKET_RE.exec(url.pathname);
    if (fb) {
      const bucket = Number(fb[1]);
      const range = bucketRange(bucket);
      if (!range) return json({ error: 'bad bucket' }, 400, 0);

      // The newest sequence decides whether this block is finished, and so how
      // long it may be cached.
      const seq = await fetchSequence(upstream, env);
      if (seq.error) return json(seq.error, seq.status, 0);
      if (range.from > seq.value) return json({ error: 'bucket is in the future' }, 404, 0);

      const complete = isComplete(bucket, seq.value);
      const top = Math.min(range.to, seq.value);

      // One subrequest per id. They run concurrently and all but the leading
      // edge are edge-cache hits, so a block that anyone has already asked for
      // costs almost nothing to serve again.
      const ids = [];
      for (let id = range.from; id <= top; id++) ids.push(id);
      const settled = await Promise.all(ids.map(async (id) => {
        const res = await fromUpstream(`${upstream}/ephemeral/${id}.json`, KILLMAIL_TTL, env);
        if (res.status === 404) return null;          // gap in the sequence, or not published yet
        if (!res.ok) return null;
        try { return JSON.parse(await res.text()); } catch (_) { return null; }
      }));
      const kills = settled.filter(Boolean);

      return json({
        bucket, from: range.from, to: range.to, complete,
        // Present so a client can tell "this block has a hole" from "this block
        // is still filling" without guessing from the count.
        highest: top, count: kills.length, kills,
      }, 200, complete ? BUCKET_COMPLETE_TTL : BUCKET_PARTIAL_TTL);
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
