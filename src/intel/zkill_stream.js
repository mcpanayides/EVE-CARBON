'use strict';
//
// Live killmails from zKillboard — every kill in New Eden, seconds after it
// happens, with no client running and no authentication.
//
// This is the answer to "can we watch while the game is closed". EVE writes the
// chat logs, so no client means no chat intel — that part is physics. But a kill
// is recorded server-side and rebroadcast within seconds, so the tool can still
// tell you a fight started four jumps from your staging while you were at work.
//
// WHAT IT IS AND IS NOT. It reports fights that have already started. Chat intel
// warns you about a gang three systems out that has not shot anyone yet; this
// tells you something died. That is later — but it is objective, with nothing to
// parse and nothing to disbelieve, and it works with the client closed, which
// chat never can.
//
// ── The protocol, and why it is this one ─────────────────────────────────────
//
// zKillboard's old RedisQ long-poll (redisq.zkillboard.com, then
// zkillredisq.stream) was SUNSET ON 31 MAY 2026. Its replacement is R2Z2, and it
// is a different shape entirely — a sequence cursor over ordinary HTTP GETs:
//
//   GET /ephemeral/sequence.json   -> { "sequence": 96088891 }   the newest id
//   GET /ephemeral/<id>.json       -> one killmail, or 404 if not there yet
//
// You hold a cursor and walk it forward. There is no queue and no client id;
// the cursor is ours to keep, which is simpler than RedisQ and has no way for
// two installs to steal each other's killmails.
//
// ── Being a good citizen of somebody else's free service ─────────────────────
//
// zKillboard publish NO numeric rate limit (checked 2026-08-17: neither the API
// wiki nor the information page states one, only "do not hammer the server, be
// polite"). This header used to claim a hard 15/s with a one-hour ban; that
// number could not be sourced, and STEP_MS below was lowered once we stopped
// designing against it. Being unable to source a ceiling is a reason to stay
// well under any plausible one, not a licence. Everything below is shaped by
// that:
//
//   • 400ms between sequential fetches, so ~2.5/s at the very most;
//   • at least 15 seconds of quiet once we are caught up;
//   • one request in flight, ever;
//   • exponential backoff on errors;
//   • a real User-Agent — Cloudflare answers 403 to blank ones, and it is how
//     they identify and contact whoever is calling.
//
// ── Starting at the present, not the beginning ───────────────────────────────
//
// On start the cursor jumps straight to the newest sequence rather than
// replaying history. Two reasons, and both matter: walking a long backlog would
// be thousands of requests at exactly the moment we are least sure of our rate
// budget, and every one of those kills would be discarded downstream anyway for
// being older than the twenty minutes that says anything about who is near now.

const https = require('https');
const { APP_USER_AGENT } = require('../app_ident');
const broker = require('../request_broker');   // for reserve() — the rate gate only

const DEFAULT_BASE = 'https://r2z2.zkillboard.com';

/**
 * Where to walk the cursor.
 *
 * Everything else in this file bounds ONE client. It cannot touch the shape of
 * the problem: request volume against zKillboard scales with installs, and at
 * the growth target that is ~100x their entire stated traffic from this app
 * alone. `workers/zkill-fanout/` is the fix — one consumer that every client
 * reads through — and this is how a build points at it.
 *
 * Opt-in, and it must stay that way until a Worker is actually deployed and
 * verified: a default pointing at a Worker that does not exist takes the intel
 * feed down for every user at once. Once it is proven, change the fallback
 * here rather than asking users to set a variable.
 *
 * Only http(s) is accepted — a malformed value silently falling through to a
 * file:// or unsupported scheme would break the feed with no clue why.
 */
function resolveZkillBase(env = (typeof process !== 'undefined' ? process.env : {})) {
  const raw = String(env?.EVE_CARBON_ZKILL_BASE || '').trim();
  if (!raw) return DEFAULT_BASE;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    return raw.replace(/\/+$/, '');   // the caller appends /ephemeral/...
  } catch (_) {
    console.warn('[zkill] ignoring invalid EVE_CARBON_ZKILL_BASE:', raw);
    return DEFAULT_BASE;
  }
}

// The floor between our own sequential requests while catching up.
//
// This was 100ms — ~10 requests/second — justified by a comment claiming
// zKillboard "publishes a hard limit of 15/s". THAT NUMBER IS NOT IN THEIR
// DOCS (checked 2026-08-17: neither the API wiki nor the information page
// states any numeric limit, only "do not hammer the server, be polite"). We
// were pacing ourselves against a ceiling we could not source, and 10/s from
// one desktop client against a volunteer-run service is indefensible whatever
// the true number is.
//
// 400ms = 2.5/s, which still clears New Eden's baseline kill rate (~0.3-1/s)
// with headroom for spikes. Mirrored by the r2z2 entry in request_broker.js's
// rate table; change both or they fight.
const STEP_MS = 400;
// Their guidance on seeing a 404: we are current, so stop asking for a while.
// Raised from 6s: this is the single biggest driver of aggregate load, and at
// 100k users even this cadence is ~1000x zKillboard's stated total traffic. It
// costs up to 15s of intel latency on a feed that is already seconds behind the
// kill, which is a fair trade. The real fix is fanning out through our own
// Worker so there is ONE consumer instead of 100,000 — see TODO.md.
const IDLE_MS = 15_000;

const BACKOFF_MIN_MS = 10_000;
const BACKOFF_MAX_MS = 5 * 60_000;

// A 404 means "not published yet" — but it also means "this id will never
// exist" when the sequence skips one, and those look identical. Waiting forever
// on a gap would silently freeze the feed, so after this many idle rounds we ask
// what the newest sequence actually is and step over the hole if there is one.
const STALL_ROUNDS = 3;

// Too far behind to be worth walking. Everything in the gap is older than the
// relevance window anyway, so jump to the present instead of spending hundreds
// of requests to arrive at the same place.
//
// Lowered from 200 alongside the slower STEP_MS: 200 steps at 400ms is 80
// seconds of catching up to reach kills that were already too old to matter.
// At 50 it is 20 seconds, and the discarded remainder is by definition outside
// the relevance window.
const MAX_CATCHUP = 50;

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * A plain JSON GET, deliberately NOT the app's shared httpGet.
 *
 * The shared stack has three caching layers that would each break this feed
 * silently — the request broker serves anything inside the origin's max-age, it
 * remembers 4xx for five minutes, and _httpJsonRaw stores ETags for every URL
 * and replays the stored body on a 304. Here, a cached sequence.json means the
 * cursor never advances and no killmail ever arrives again, while the loop keeps
 * running and the status keeps saying connected. A 404 is a NORMAL answer on
 * this endpoint, so it is returned rather than thrown.
 *
 * It does, however, take a token from the broker's RATE GOVERNOR first. Skipping
 * the cache is necessary; skipping the ceiling was not, and this was the only
 * feature in the app fast enough to need one. `reserve()` exists for exactly
 * this: the rate gate without any of the caching.
 */
async function directGet(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  await broker.reserve(url);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        // Mandatory: Cloudflare 403s blank user agents.
        'User-Agent': APP_USER_AGENT,
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve({ notFound: true });
        if (res.statusCode >= 400) {
          return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        }
        try { resolve({ body: JSON.parse(data) }); }
        catch { reject(new Error('bad JSON from zKillboard')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * @param {object} deps
 * @param {Function} deps.onKillmail  (pkg) => void — one killmail, raw
 * @param {Function} [deps.onStatus]  ({ connected, received, errors }) => void
 * @param {string}   [deps.base]      override, if zKillboard moves it again
 * @param {Function} [deps.httpGet]   TEST SEAM. (url) => { body } | { notFound }
 *                                    Never pass the app's shared httpGet — see above.
 */
function createZkillStream({ onKillmail, onStatus, base = resolveZkillBase(), httpGet } = {}) {
  const fetch_ = httpGet || directGet;

  let running   = false;
  let inFlight  = false;
  let timer     = null;
  let cursor    = null;   // last sequence id we have consumed
  let backoff   = 0;
  let idleRounds = 0;
  let received  = 0;
  let errors    = 0;
  let lastError = null;
  let connected = false;
  let skipped   = 0;      // sequence ids stepped over, for diagnosis

  const seqUrl  = () => `${base}/ephemeral/sequence.json`;
  const killUrl = (id) => `${base}/ephemeral/${id}.json`;

  const report = () => onStatus && onStatus({ connected, received, errors, lastError, cursor, skipped });

  function schedule(delayMs) {
    if (!running) return;
    timer = setTimeout(() => { timer = null; step(); }, delayMs);
    // Never hold the process open for a background nicety.
    if (timer.unref) timer.unref();
  }

  function ok() {
    backoff = 0;
    errors  = 0;
    lastError = null;
    if (!connected) { connected = true; report(); }
  }

  function fail(e) {
    errors++;
    lastError = e.message;
    if (connected) { connected = false; report(); }
    backoff = backoff ? Math.min(backoff * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
    if (errors === 1 || errors % 20 === 0) {
      console.warn(`[intel] zkill stream: ${e.message} — retrying in ${Math.round(backoff / 1000)}s`);
    }
    return backoff;
  }

  /** The newest sequence id zKillboard has, or null on failure. */
  async function newestSequence() {
    const res = await fetch_(seqUrl());
    const seq = res && res.body && Number(res.body.sequence);
    return Number.isFinite(seq) ? seq : null;
  }

  /**
   * One unit of work. Returns how long to wait before the next one.
   *
   * Split from the scheduling so a test can run exactly one step, and so the
   * rate discipline lives in one readable place.
   */
  async function cycle() {
    if (inFlight) return null;
    inFlight = true;
    try {
      // First run: start at the present. See the header on not replaying history.
      if (cursor == null) {
        const seq = await newestSequence();
        if (seq == null) throw new Error('no sequence from zKillboard');
        cursor = seq;
        ok();
        return IDLE_MS;
      }

      const res = await fetch_(killUrl(cursor + 1));

      if (res && res.notFound) {
        ok();   // 404 here is a healthy "nothing new", not a failure
        idleRounds++;
        // A gap in the sequence looks exactly like "not published yet", and
        // waiting on one would freeze the feed for good. So after a few quiet
        // rounds, ask where the front actually is.
        if (idleRounds >= STALL_ROUNDS) {
          idleRounds = 0;
          const seq = await newestSequence();
          if (seq != null && seq > cursor) {
            // Far behind: everything in between is already too old to matter.
            const next = (seq - cursor > MAX_CATCHUP) ? seq : cursor + 1;
            skipped += next - cursor;
            cursor = next;
            return STEP_MS;
          }
        }
        return IDLE_MS;
      }

      const pkg = res && res.body;
      if (!pkg) throw new Error('empty response');
      cursor++;
      idleRounds = 0;
      received++;
      ok();
      try { onKillmail && onKillmail(pkg); }
      catch (e) { console.warn('[intel] zkill consumer threw:', e.message); }
      return STEP_MS;
    } catch (e) {
      return fail(e);
    } finally {
      inFlight = false;
    }
  }

  async function step() {
    if (!running) return;
    const delay = await cycle();
    // Re-checked AFTER the await: stop() can land mid-request, and scheduling
    // another one on the way out is how a "stopped" feed keeps talking to
    // somebody else's server.
    if (delay != null && running) schedule(delay);
  }

  return {
    start() {
      if (running) return;
      running = true;
      step();
    },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      connected = false;
      // Dropped deliberately: on the next start we want the present, not
      // whatever was current whenever this was last switched off.
      cursor = null;
      idleRounds = 0;
    },
    status() { return { running, connected, received, errors, lastError, cursor, skipped }; },
    /** Test seam: run exactly one step, scheduling nothing. */
    _cycle: cycle,
    get _running() { return running; },
  };
}

module.exports = {
  createZkillStream, DEFAULT_BASE, resolveZkillBase,
  STEP_MS, IDLE_MS, BACKOFF_MIN_MS, BACKOFF_MAX_MS, STALL_ROUNDS, MAX_CATCHUP,
};
