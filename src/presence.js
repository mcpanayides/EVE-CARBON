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

async function _beat() {
  if (!_deps) return;
  try {
    const res = await fetch(_deps.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: _sessionId }),
      signal:  AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (typeof data.count === 'number') {
      _lastCount = data.count;
      _deps.broadcast('presence-count', _lastCount);
      return;
    }
  } catch (_) { /* endpoint down — hide the counter, try again next beat */ }
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
  if (!deps || !deps.url) return;   // no endpoint configured — feature off
  _deps = deps;
  _sessionId = crypto.randomUUID();
  setTimeout(async () => { await _beat(); _schedule(); }, FIRST_BEAT_DELAY_MS);
}

function getPresenceCount() {
  return _lastCount;
}

function stopPresence() {
  clearTimeout(_timer);
  _timer = null;
}

module.exports = { initPresence, getPresenceCount, stopPresence };
