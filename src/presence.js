// ─── presence.js ──────────────────────────────────────────────────────────────
// Anonymous concurrent-user heartbeat (main process).
//
// Every ~5 minutes (±30s jitter) POST a random per-launch session UUID to the
// presence worker (infra/presence-worker); the response carries how many
// copies of EVE-Carbon are running right now, which we broadcast to the
// renderer for the status-bar counter. Nothing identifying is ever sent —
// just the UUID, which changes every launch and is never written to disk.
//
// Always on when PRESENCE_URL is configured — no user opt-out. Silently OFF
// only when PRESENCE_URL isn't configured at all.
// ──────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const HEARTBEAT_MS = 5 * 60 * 1000;
const FIRST_BEAT_DELAY_MS = 10 * 1000;   // let the app settle before the first ping

let _timer = null;
let _sessionId = null;
let _lastCount = null;
let _deps = null;   // { url, broadcast(channel, payload) }
// Why the counter is not showing. Three states used to look identical from the
// outside — never configured, configured but unreachable, and working but alone
// — because init returned silently and every beat swallowed its error. That is
// what made a missing build secret impossible to tell from a broken worker.
let _state = { configured: false, url: null, lastError: null, beats: 0, lastBeatAt: null };

async function _beat() {
  if (!_deps) return;
  _state.beats++;
  _state.lastBeatAt = new Date().toISOString();
  try {
    const res = await fetch(_deps.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: _sessionId }),
      signal:  AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (typeof data.count === 'number') {
      _state.lastError = null;
      _lastCount = data.count;
      _deps.broadcast('presence-count', _lastCount);
      return;
    }
  } catch (e) {
    // Log the first failure only: a dead endpoint beats every 5 minutes forever
    // and would otherwise fill the log with the same line.
    _state.lastError = e?.message || String(e);
    if (_state.beats === 1) console.warn('[presence] heartbeat failed:', _state.lastError);
  }
  _lastCount = null;
  _deps.broadcast('presence-count', null);
}

function _schedule() {
  clearTimeout(_timer);
  // ±30s jitter so a fleet of clients restarting after an update doesn't
  // thundering-herd the worker on a synchronized cadence.
  const jitter = Math.floor(Math.random() * 60000) - 30000;
  _timer = setTimeout(async () => { await _beat(); _schedule(); }, HEARTBEAT_MS + jitter);
}

function initPresence(deps) {
  if (!deps || !deps.url) {
    // The usual cause in a packaged build: PRESENCE_URL was empty in the .env
    // baked in at release time, because the repo secret of that name is unset.
    // Said out loud, because the only visible symptom is a counter that never
    // appears — which looks identical to the feature not existing.
    console.warn('[presence] disabled — PRESENCE_URL is not set '
               + '(packaged builds read it from the .env bundled in resources).');
    _state = { configured: false, url: null, lastError: 'PRESENCE_URL not set', beats: 0, lastBeatAt: null };
    return;
  }
  let host = deps.url;
  try { host = new URL(deps.url).host; } catch (_) { /* log whatever was configured */ }
  console.log('[presence] enabled — heartbeat to', host);
  _state = { configured: true, url: host, lastError: null, beats: 0, lastBeatAt: null };
  _deps = deps;
  _sessionId = crypto.randomUUID();
  // Held in _timer like every later beat: this handle used to be dropped on the
  // floor, so stopPresence() could not cancel the FIRST heartbeat — quitting
  // within ten seconds of launch still fired a request during teardown, and a
  // test that called stop() still hung until the beat went out.
  clearTimeout(_timer);
  _timer = setTimeout(async () => { await _beat(); _schedule(); }, FIRST_BEAT_DELAY_MS);
}

function getPresenceCount() {
  return _lastCount;
}

/** Why the counter is or is not showing — surfaced in the app's console strip. */
function getPresenceState() {
  return { ..._state, count: _lastCount };
}

function stopPresence() {
  clearTimeout(_timer);
  _timer = null;
}

module.exports = { initPresence, getPresenceCount, getPresenceState, stopPresence };
