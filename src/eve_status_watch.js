// eve_status_watch.js — poll CCP's service status and raise an OS notification
// when Tranquility starts misbehaving.
//
// The point of this feature is narrow and worth stating: a capital pilot who is
// undocked wants to hear "the server is wobbling, dock up" BEFORE the socket
// closes, because a supercapital that logs off in space is one that can be
// found and killed while its owner cannot fly it. Everything here is shaped by
// that — what is worth interrupting for, and what interrupting is allowed to
// cost.
//
// ── GAME-SAFETY ──────────────────────────────────────────────────────────────
// This must NEVER take foreground focus. main.js already learned this the hard
// way for the Jabber ping popup: forcing a foreground change while a D3D title
// holds the display in exclusive fullscreen can drop the device and hard-crash
// the game. Alerting a pilot by crashing their client is worse than not
// alerting them at all.
//
// An OS notification is used precisely because it cannot do that — it is drawn
// by the shell's notification centre, not by us, and it appears whether or not
// the app is minimised to tray. It is also the thing the user actually asked
// for: the normal Windows/macOS toast.
const EveStatus = require('./shared/eve_status');

const POLL_MS  = 60 * 1000;   // the page itself caches ~10s; a minute is plenty
const FETCH_MS = 10 * 1000;

let _timer     = null;
let _last      = null;    // last classified reading
let _lastAlert = 0;

/** The most recent reading, for the nav light. Never throws, never null-refs. */
function currentStatus() {
  return _last || EveStatus.unknown('Not polled yet');
}

async function _fetchSummary(userAgent) {
  const res = await fetch(EveStatus.STATUS_URL, {
    headers: { 'User-Agent': userAgent || 'EVE-Carbon' },
    signal:  AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * One poll. Exported so a test can drive it without a timer.
 *
 * `deps` carries everything that touches the outside world, so the decision
 * logic above it stays pure and this stays the only part needing a fake.
 */
async function pollOnce(deps) {
  const { Notification, alertsEnabled, onChange, log, userAgent, now = Date.now } = deps || {};

  let next;
  try {
    next = EveStatus.classify(await _fetchSummary(userAgent));
  } catch (e) {
    // Our own connection failing says nothing about Tranquility. Record it as
    // unknown — which shouldAlert refuses to alarm on — rather than as an
    // outage, or every wifi hiccup becomes a false "dock now".
    next = EveStatus.unknown(e && e.message ? e.message : 'unreachable');
  }

  const prev = _last;
  _last = next;

  // Tell the renderer regardless of whether it is worth an interruption: the
  // nav light should track reality continuously even when the toast stays quiet.
  if (typeof onChange === 'function') {
    try { onChange(next); } catch (_) { /* a dead window must not break polling */ }
  }

  if (!alertsEnabled || !alertsEnabled()) return next;

  const verdict = EveStatus.shouldAlert(prev, next, { now: now(), lastAlertAt: _lastAlert });
  if (!verdict) return next;

  _lastAlert = now();
  try {
    if (Notification && Notification.isSupported && Notification.isSupported()) {
      const n = new Notification({
        title: verdict.title,
        body:  verdict.body,
        // Recovery is good news and does not need to make a sound at 3am.
        silent: verdict.kind === 'recovery',
      });
      // No show()-then-focus dance: the shell owns this window. Clicking it is
      // the user choosing to switch, which is the only safe way focus moves.
      if (typeof deps.onClick === 'function') n.on('click', deps.onClick);
      n.show();
    }
    if (typeof log === 'function') log('info', `EVE status ${verdict.kind}: ${verdict.title} — ${verdict.body}`);
  } catch (e) {
    if (typeof log === 'function') log('warn', `EVE status notification failed: ${e.message}`);
  }

  return next;
}

function startEveStatusWatch(deps) {
  stopEveStatusWatch();
  // Prime immediately so the light is right on launch, then settle into the
  // interval. A first reading that is ALREADY bad does warn — someone who opens
  // the app and undocks during an ongoing outage is exactly who this is for,
  // and staying quiet for want of an earlier reading to compare against would
  // fail them at the one moment it matters.
  pollOnce(deps).catch(() => {});
  _timer = setInterval(() => { pollOnce(deps).catch(() => {}); }, POLL_MS);
  if (_timer.unref) _timer.unref();
  return () => stopEveStatusWatch();
}

function stopEveStatusWatch() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** Test seam: forget everything learned so far. */
function _resetForTests() { _last = null; _lastAlert = 0; stopEveStatusWatch(); }

module.exports = {
  POLL_MS, startEveStatusWatch, stopEveStatusWatch, pollOnce, currentStatus, _resetForTests,
};
