'use strict';
//
// Deciding when to interrupt someone who is flying.
//
// This feature exists for one moment: a capital pilot undocked while Tranquility
// starts wobbling, who wants to hear about it before the socket closes rather
// than after. That makes the failure modes asymmetric and worth testing hard.
//
//   • A missed alert costs a supercapital.
//   • A false alert costs trust, and a warning people have learned to dismiss
//     is worth less than none at all — it fails at the one moment it matters.
//
// So most of what is pinned here is the REFUSALS: the cases where something
// looks alarming and must stay quiet anyway.
const test   = require('node:test');
const assert = require('node:assert');
const ES     = require('../src/shared/eve_status.js');

const summary = (indicator, components, extra) => Object.assign({
  status: { indicator, description: `indicator: ${indicator}` },
  components: components.map(([name, status]) => ({ name, status })),
  incidents: [],
}, extra || {});

const OK = ES.classify(summary('none', [['Game Server', 'operational'], ['Login', 'operational']]));

// ─── reading the status page ─────────────────────────────────────────────────

test('the page indicator maps onto our three lights', () => {
  assert.strictEqual(ES.classify(summary('none',     [])).level, 'ok');
  assert.strictEqual(ES.classify(summary('minor',    [])).level, 'degraded');
  assert.strictEqual(ES.classify(summary('major',    [])).level, 'down');
  assert.strictEqual(ES.classify(summary('critical', [])).level, 'down');
});

test('a component can be worse than the headline indicator', () => {
  // The indicator is a floor, not the whole story — an incident may not be
  // pinned to a component yet, or vice versa.
  const c = ES.classify(summary('none', [['Game Server', 'major_outage']]));
  assert.strictEqual(c.level, 'down');
  assert.strictEqual(c.flightLevel, 'down');
});

test('scheduled maintenance is not instability', () => {
  // EVE takes a downtime every single day. Ranking it as a fault would fire a
  // false alarm every morning and teach the user to ignore the real one.
  const c = ES.classify(summary('maintenance', [['Tranquility', 'under_maintenance']]));
  assert.strictEqual(c.severity, 0);
  assert.strictEqual(c.level, 'ok');
  assert.strictEqual(c.maintenance, true);
});

test('flight-critical components are matched by name, loosely', () => {
  assert.ok(ES.isFlightCritical('Game Server'));
  assert.ok(ES.isFlightCritical('Tranquility'));
  assert.ok(ES.isFlightCritical('TRANQUILITY (EU)'), 'a rename must not drop it silently');
  assert.ok(ES.isFlightCritical('Login'));
  assert.ok(!ES.isFlightCritical('Websites/Client Updates/CDN (AWS CloudFront)'));
  assert.ok(!ES.isFlightCritical('EVE Vanguard'));
});

test('login counts, because a disconnect you cannot undo is the actual risk', () => {
  const c = ES.classify(summary('minor', [['Game Server', 'operational'], ['Login', 'major_outage']]));
  assert.strictEqual(c.flightLevel, 'down');
});

// ─── when to interrupt ───────────────────────────────────────────────────────

test('degradation of the game server raises a warning that says what to do', () => {
  const bad = ES.classify(summary('minor', [['Game Server', 'degraded_performance']]));
  const a   = ES.shouldAlert(OK, bad, { now: 1_000 });
  assert.strictEqual(a.kind, 'escalation');
  assert.strictEqual(a.level, 'degraded');
  assert.match(a.body, /dock/i, 'an alert that only reports a state makes the pilot do the thinking');
});

test('an outage is worded more urgently than a wobble', () => {
  const down = ES.classify(summary('major', [['Game Server', 'major_outage']]));
  const a    = ES.shouldAlert(OK, down, { now: 1_000 });
  assert.strictEqual(a.level, 'down');
  assert.match(a.body, /now/i);
});

test('a sustained outage does not re-fire every poll', () => {
  // You already docked. Sixty more toasts is how a feature gets turned off.
  const bad = ES.classify(summary('major', [['Game Server', 'major_outage']]));
  assert.ok(ES.shouldAlert(OK, bad, { now: 1_000 }));
  assert.strictEqual(ES.shouldAlert(bad, bad, { now: 2_000 }), null);
});

test('an unreachable status page never raises an alarm', () => {
  // Our own connection dropping is not evidence about Tranquility. Crying wolf
  // on it would fire every time the user's wifi hiccups — and worse, it would
  // fire at exactly the moment their client is also disconnecting for local
  // reasons, which is when a false "the server is dying" is most damaging.
  assert.strictEqual(ES.shouldAlert(OK, ES.unknown('timeout'), { now: 1_000 }), null);
  // ...and coming back from unknown is not treated as recovery either.
  assert.strictEqual(ES.shouldAlert(ES.unknown('timeout'), OK, { now: 1_000 }), null);
});

test('a CDN outage does not wake someone flying a Titan', () => {
  // The whole reason flight-critical is a separate reading. This turns the nav
  // light red, honestly, and says nothing out loud.
  const cdn = ES.classify(summary('major', [
    ['Game Server', 'operational'],
    ['Client Updates/CDN (Cloudflare R2)', 'major_outage'],
  ]));
  assert.strictEqual(cdn.level, 'down', 'the light still tells the truth');
  assert.strictEqual(cdn.flightLevel, 'ok');
  assert.strictEqual(ES.shouldAlert(OK, cdn, { now: 1_000 }), null);
});

test('maintenance windows stay silent, but a real outage during one does not', () => {
  const dt = ES.classify(summary('maintenance', [['Tranquility', 'under_maintenance']]));
  assert.strictEqual(ES.shouldAlert(OK, dt, { now: 1_000 }), null);

  // Degraded *and* under maintenance is still only a wobble — suppressed.
  const wobble = ES.classify(summary('minor', [
    ['Tranquility', 'under_maintenance'],
    ['Game Server', 'degraded_performance'],
  ]));
  assert.strictEqual(ES.shouldAlert(OK, wobble, { now: 1_000 }), null);
});

test('recovery is announced once, and only if we raised the alarm first', () => {
  const bad = ES.classify(summary('major', [['Game Server', 'major_outage']]));
  const rec = ES.shouldAlert(bad, OK, { now: 5_000 });
  assert.strictEqual(rec.kind, 'recovery');
  // Nothing was wrong, so there is nothing to announce.
  assert.strictEqual(ES.shouldAlert(OK, OK, { now: 6_000 }), null);
});

test('a flapping component is held down by the cooldown', () => {
  const deg  = ES.classify(summary('minor', [['Game Server', 'degraded_performance']]));
  const part = ES.classify(summary('major', [['Game Server', 'partial_outage']]));
  assert.ok(ES.shouldAlert(OK, deg, { now: 0, lastAlertAt: 0 }));
  // Worse, but seconds later — the pilot has already been told to dock.
  assert.strictEqual(ES.shouldAlert(deg, part, { now: 30_000, lastAlertAt: 0 }), null);
  // Past the cooldown, a genuine escalation gets through.
  assert.ok(ES.shouldAlert(deg, part, { now: ES.ALERT_COOLDOWN_MS + 1, lastAlertAt: 0 }));
});

test('launching into an outage still warns, rather than starting quiet', () => {
  // Deliberate, and the opposite of what "only alert on change" would give you.
  // Someone who opens the app and undocks a capital during an ongoing outage is
  // exactly the person this exists for, and the alternative — staying silent
  // because we have no earlier reading to compare against — fails them at the
  // one moment it matters. A restart during a long outage re-warning is a much
  // cheaper mistake than a missed warning.
  const bad = ES.classify(summary('major', [['Game Server', 'major_outage']]));
  const a   = ES.shouldAlert(null, bad, { now: 1_000 });
  assert.strictEqual(a.kind, 'escalation');
  assert.strictEqual(a.level, 'down');

  // A healthy first reading is still silent — there is nothing to say.
  assert.strictEqual(ES.shouldAlert(null, OK, { now: 1_000 }), null);
});

test('an unrecognised component status is treated as fine, not as an outage', () => {
  // Statuspage could add a vocabulary word. Guessing "unknown means broken"
  // would turn a CCP wording change into a false alarm for every user at once.
  const c = ES.classify(summary('none', [['Game Server', 'something_new']]));
  assert.strictEqual(c.severity, 0);
  assert.strictEqual(ES.shouldAlert(OK, c, { now: 1_000 }), null);
});

test('a malformed payload degrades to "we do not know"', () => {
  for (const junk of [null, undefined, {}, { components: 'nope' }]) {
    const c = ES.classify(junk);
    assert.strictEqual(c.level, 'ok');
    assert.strictEqual(c.flightSeverity, 0);
  }
});
