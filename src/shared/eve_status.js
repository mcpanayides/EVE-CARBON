// eve_status.js — reading CCP's service status, and deciding when to interrupt.
//
// Loaded by BOTH processes:
//   • main     — require()d by the status poller that raises the OS notification
//   • renderer — a <script> tag; attaches window.EveStatus for the nav light
//
// Everything here is pure: a status payload in, a verdict out. No fetch, no
// Notification, no DOM — which is what lets "should this wake someone flying a
// Titan" be tested exhaustively without a network or a desktop.
//
// ── Where the signal comes from ──────────────────────────────────────────────
//
// ESI's /status/ answers { players, server_version, vip, start_time } and
// NOTHING about stability. It is binary: up, or VIP, or unreachable. There is no
// degraded state in it, so it cannot answer "is Tranquility wobbling".
//
// status.eveonline.com is an Atlassian Statuspage and DOES publish that, at
// /api/v2/summary.json: an overall `indicator` (none/minor/major/critical) plus
// a per-component status. `minor` is precisely the yellow on the status page.
//
// ── Why not every component matters ──────────────────────────────────────────
//
// The question this feature answers is "should I dock this supercapital", and
// most of what the status page tracks has no bearing on it. Client-update CDN
// degradation cannot get a Titan killed. Being woken for it teaches you to
// ignore the alert, and then it fails at the one thing it exists for.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EveStatus = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const STATUS_URL = 'https://status.eveonline.com/api/v2/summary.json';

  // Statuspage's component vocabulary, ranked by how much it should worry you.
  // `under_maintenance` deliberately ranks ZERO: planned work is not the server
  // misbehaving, and EVE takes a scheduled downtime every day. Alerting on it
  // would fire a false alarm every morning and train the alert away.
  const COMPONENT_SEVERITY = {
    operational:          0,
    under_maintenance:    0,
    degraded_performance: 1,
    partial_outage:       2,
    major_outage:         3,
  };

  // Overall page indicator, same scale.
  const INDICATOR_SEVERITY = { none: 0, maintenance: 0, minor: 1, major: 2, critical: 3 };

  const LEVELS = ['ok', 'degraded', 'down', 'down'];

  /**
   * The components that decide whether it is safe to be undocked.
   *
   * Game Server and Tranquility are obvious. Login is here for a less obvious
   * reason: if you disconnect while login is broken you cannot get back to the
   * ship, which is the entire risk being hedged against — a capital pilot needs
   * to know that even while the game server itself looks fine.
   *
   * Matched case-insensitively on a substring so a rename like "Tranquility
   * (EU)" still counts rather than silently dropping out of the alert set.
   */
  const FLIGHT_CRITICAL = ['game server', 'tranquility', 'login'];

  function isFlightCritical(name) {
    const n = String(name || '').toLowerCase();
    return FLIGHT_CRITICAL.some(k => n.includes(k));
  }

  function severityOf(componentStatus) {
    const s = COMPONENT_SEVERITY[String(componentStatus || '').toLowerCase()];
    return s == null ? 0 : s;
  }

  /**
   * Reduce a Statuspage summary to what this app acts on.
   *
   * Returns both an overall reading (what the nav light shows) and a
   * flight-critical one (what is allowed to raise a notification), because they
   * are genuinely different questions and conflating them is how an alert
   * becomes noise.
   */
  function classify(summary) {
    const comps = Array.isArray(summary && summary.components) ? summary.components : [];

    let worst = 0, flightWorst = 0;
    const affected = [];
    const flightAffected = [];

    for (const c of comps) {
      if (!c || !c.name) continue;
      const sev = severityOf(c.status);
      if (sev > worst) worst = sev;
      if (sev > 0) affected.push({ name: c.name, status: c.status, severity: sev });
      if (isFlightCritical(c.name)) {
        if (sev > flightWorst) flightWorst = sev;
        if (sev > 0) flightAffected.push({ name: c.name, status: c.status, severity: sev });
      }
    }

    // The page's own indicator is a floor, not the whole story: it can report
    // `minor` from an incident that has not yet been pinned to a component.
    const ind = INDICATOR_SEVERITY[String(summary?.status?.indicator || '').toLowerCase()] || 0;
    if (ind > worst) worst = ind;

    const maintenance = comps.some(c => String(c?.status).toLowerCase() === 'under_maintenance');

    return {
      level:        LEVELS[worst] || 'ok',
      severity:     worst,
      indicator:    summary?.status?.indicator || 'unknown',
      description:  summary?.status?.description || '',
      affected:     affected.sort((a, b) => b.severity - a.severity),
      // What the notification is allowed to fire on.
      flightLevel:  LEVELS[flightWorst] || 'ok',
      flightSeverity: flightWorst,
      flightAffected: flightAffected.sort((a, b) => b.severity - a.severity),
      maintenance,
      incidents: Array.isArray(summary?.incidents) ? summary.incidents.length : 0,
    };
  }

  /** A reading that means "we could not tell", which must never raise an alarm. */
  function unknown(reason) {
    return {
      level: 'unknown', severity: 0, indicator: 'unknown',
      description: reason || 'Status unavailable',
      affected: [], flightLevel: 'unknown', flightSeverity: 0, flightAffected: [],
      maintenance: false, incidents: 0, unreachable: true,
    };
  }

  const ALERT_COOLDOWN_MS = 20 * 60 * 1000;

  /**
   * Should this change interrupt the user, and with what?
   *
   * Rules, in the order they matter:
   *
   *  1. Only ESCALATION alerts. A sustained outage must not re-fire every poll;
   *     you already docked, and being told sixty more times is what makes people
   *     turn the feature off.
   *  2. Never alert on an unreachable status page. Our own connection dropping
   *     is not evidence about Tranquility, and crying wolf on it would fire
   *     every time the user's wifi hiccups.
   *  3. Never alert on scheduled maintenance. EVE has a downtime every day.
   *  4. Recovery gets ONE quiet notice, because "it is safe to undock again" is
   *     genuinely actionable and is the natural end of the story.
   *  5. A cooldown stops a component that is flapping between degraded and
   *     partial-outage from firing on every flap.
   */
  function shouldAlert(prev, next, opts) {
    const o    = opts || {};
    const now  = o.now || Date.now();
    const last = o.lastAlertAt || 0;

    if (!next || next.unreachable) return null;
    if (next.flightLevel === 'unknown') return null;

    const was = prev && !prev.unreachable ? prev.flightSeverity : 0;
    const is  = next.flightSeverity;

    // Recovery: only worth saying if we actually told them something was wrong.
    if (is === 0 && was > 0) {
      return {
        kind:  'recovery',
        level: 'ok',
        title: 'EVE service restored',
        body:  'Tranquility is reporting all systems operational again.',
      };
    }

    if (is <= was) return null;                       // rule 1
    if (next.maintenance && is <= 1) return null;     // rule 3
    if (now - last < ALERT_COOLDOWN_MS && was > 0) return null;  // rule 5

    const names = next.flightAffected.map(c => c.name).join(', ') || 'Tranquility';
    const worst = next.flightAffected[0];

    // Deliberately plain about what to DO. An alert that only reports a state
    // leaves the pilot to work out the implication while their ship is the
    // thing at risk.
    return is >= 2
      ? {
          kind:  'escalation',
          level: 'down',
          title: 'EVE server outage',
          body:  `${names} — ${worst ? String(worst.status).replace(/_/g, ' ') : 'outage'}. `
               + 'Get to a station or a safe now; a disconnect may not be recoverable.',
        }
      : {
          kind:  'escalation',
          level: 'degraded',
          title: 'EVE server instability',
          body:  `${names} reporting degraded performance. `
               + 'Consider docking anything you cannot afford to lose to a disconnect.',
        };
  }

  return {
    STATUS_URL, COMPONENT_SEVERITY, INDICATOR_SEVERITY, FLIGHT_CRITICAL,
    ALERT_COOLDOWN_MS,
    isFlightCritical, severityOf, classify, unknown, shouldAlert,
  };
});
