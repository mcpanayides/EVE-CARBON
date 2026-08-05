'use strict';
//
// User-defined alert rules for the intel early-warning system.
//
// The built-in proximity alert answers one question — "is something close or
// closing?" — and it answers it for everyone the same way. That is the right
// default and the wrong ceiling. Real fleets care about specifics:
//
//   • a named pilot who is known to bring a hot drop, anywhere in the region
//   • anything with a standing of -10 on the contact sheet, within 10 jumps
//   • a single interdictor, even solo, even far out
//   • a fleet of 30+, at any distance worth knowing about
//
// None of those are expressible as "N jumps". So rules are data, evaluated
// against the same assessments the built-in alert sees, and they ADD to it
// rather than replacing it — switching every rule off leaves the tool behaving
// exactly as it did before rules existed.
//
// A rule reads as a sentence, which is how the UI renders it:
//
//   When intel reports  a pilot on my watchlist  within 0–15 jumps
//   then notify and play a sound, at most once a minute.

/**
 * @typedef {object} AlertRule
 * @property {string}  id
 * @property {boolean} enabled
 * @property {string}  name          what the operator called it
 * @property {object}  match         conditions; every populated one must pass
 * @property {string[]} [match.pilots]   exact character names (case-insensitive)
 * @property {string[]} [match.ships]    hull names
 * @property {string[]} [match.roles]    tackle | cloaky | ewar | capital | logi
 * @property {number}  [match.minSize]   gang size at least this
 * @property {number}  [match.maxStanding] contact-sheet standing at or BELOW this
 * @property {boolean} [match.camp]      bubbles / gate camp reported
 * @property {boolean} [match.inbound]   only when measurably closing
 * @property {object}  within        { minJumps, maxJumps }
 * @property {object}  then          { notify, sound, level }
 * @property {number}  quietForS     suppression window per contact
 */

const DEFAULT_RULE = {
  enabled: true,
  name: 'New alert',
  match: {},
  within: { minJumps: 0, maxJumps: 15 },
  then: { notify: true, sound: false, level: 'warning' },
  quietForS: 60,
};

/** Rules a new install starts with — examples that are useful and obvious. */
const STARTER_RULES = [
  {
    id: 'starter-tackle',
    enabled: false,
    name: 'Tackle within 10 jumps',
    match: { roles: ['tackle'] },
    within: { minJumps: 0, maxJumps: 10 },
    then: { notify: true, sound: true, level: 'critical' },
    quietForS: 90,
  },
  {
    id: 'starter-fleet',
    enabled: false,
    name: 'Fleet of 30+ anywhere in range',
    match: { minSize: 31 },
    within: { minJumps: 0, maxJumps: 15 },
    then: { notify: true, sound: true, level: 'critical' },
    quietForS: 120,
  },
  {
    id: 'starter-reds',
    enabled: false,
    name: 'Terrible standing (-5 or worse) nearby',
    match: { maxStanding: -5 },
    within: { minJumps: 0, maxJumps: 8 },
    then: { notify: true, sound: false, level: 'warning' },
    quietForS: 90,
  },
  {
    id: 'starter-watchlist',
    enabled: false,
    name: 'Watchlist pilot seen',
    // Deliberately empty: it does nothing until names are added, which is what
    // makes it a safe example rather than a source of mystery alerts.
    match: { pilots: [] },
    within: { minJumps: 0, maxJumps: 15 },
    then: { notify: true, sound: true, level: 'critical' },
    quietForS: 60,
  },
];

const lower = (a) => (Array.isArray(a) ? a.map(x => String(x).toLowerCase()) : []);

/** Fill in anything a stored rule is missing, so old configs keep working. */
function normaliseRule(r, i = 0) {
  const rule = {
    ...DEFAULT_RULE, ...r,
    id:     r.id || `rule-${i}-${Math.random().toString(36).slice(2, 8)}`,
    match:  { ...(r.match  || {}) },
    within: { ...DEFAULT_RULE.within, ...(r.within || {}) },
    then:   { ...DEFAULT_RULE.then,   ...(r.then   || {}) },
  };
  rule.quietForS = Number.isFinite(rule.quietForS) ? rule.quietForS : 60;
  return rule;
}

/**
 * Does one rule match this contact?
 *
 * Conditions are AND-ed; the values within one condition are OR-ed.
 *
 * ABSENT means "don't care" — a rule with nothing set matches everything in
 * range, which is exactly what "alert me about anything within 5 jumps" means.
 * PRESENT BUT EMPTY means the opposite, and never matches; see the note at the
 * list checks below for why those two cases have to differ.
 *
 * @param {AlertRule} rule
 * @param {object} threat  a proximity assessment (jumps, roles, ships, size…)
 * @param {object} [ctx]   { standing } resolved for this contact, if known
 */
function ruleMatches(rule, threat, ctx = {}) {
  if (!rule || !rule.enabled || !threat) return false;

  const { minJumps = 0, maxJumps = 15 } = rule.within || {};
  if (threat.jumps < minJumps || threat.jumps > maxJumps) return false;

  const m = rule.match || {};

  if (m.inbound && !threat.inbound) return false;
  if (m.camp    && !threat.camp)    return false;

  if (Number.isFinite(m.minSize)) {
    if (!Number.isFinite(threat.size) || threat.size < m.minSize) return false;
  }

  // Standings are "at or below": -10 is worse than -5, so a rule asking for
  // -5 must also fire on -10. Unknown standing never satisfies it — an
  // unresolved pilot is not evidence of hostility.
  if (Number.isFinite(m.maxStanding)) {
    const s = ctx.standing;
    if (!Number.isFinite(s) || s > m.maxStanding) return false;
  }

  // A list condition that is PRESENT BUT EMPTY fails closed — it never matches.
  //
  // The alternative reading (skip it, like an absent condition) is a trap: a
  // rule called "Watchlist pilot seen" with nobody on the list yet would
  // describe itself as matching "anything" and alert on every contact in range.
  // Somebody enabling that rule means "tell me about these pilots", and the
  // honest answer when there are none is silence. Genuinely wanting everything
  // is expressed by not setting the field at all.
  if (Array.isArray(m.pilots)) {
    if (!m.pilots.length) return false;
    const want = new Set(lower(m.pilots));
    // Match the contact's own label AND anyone reported alongside it, so a
    // watchlist name still fires when the track is keyed on the system.
    const names = lower([threat.label, ...(threat.pilots || [])]);
    if (!names.some(n => want.has(n))) return false;
  }

  if (Array.isArray(m.ships)) {
    if (!m.ships.length) return false;
    const want = new Set(lower(m.ships));
    if (!lower(threat.ships || []).some(s => want.has(s))) return false;
  }

  if (Array.isArray(m.roles)) {
    if (!m.roles.length) return false;
    const want = new Set(lower(m.roles));
    if (!lower(threat.roles || []).some(r => want.has(r))) return false;
  }

  return true;
}

/**
 * Evaluate every rule, honouring each rule's own suppression window.
 *
 * Suppression is per rule AND per contact: one rule going quiet about a gang it
 * already reported must not silence a different rule, and a rule watching for
 * tackle must still fire for a second, different tackle contact.
 *
 * @returns {Array} [{ rule, level, sound, reason: 'rule' }]
 */
function createRuleEngine(getRules) {
  const lastFired = new Map();   // `${ruleId}|${contactKey}` -> ts

  function evaluate(threat, ctx = {}, now = Date.now()) {
    const out = [];
    for (const raw of (getRules() || [])) {
      const rule = normaliseRule(raw);
      if (!ruleMatches(rule, threat, ctx)) continue;
      const key = `${rule.id}|${threat.key || threat.systemId}`;
      const prev = lastFired.get(key);
      if (prev && now - prev < rule.quietForS * 1000) continue;
      lastFired.set(key, now);
      out.push({
        rule:    { id: rule.id, name: rule.name },
        level:   rule.then.level || 'warning',
        sound:   !!rule.then.sound,
        notify:  rule.then.notify !== false,
        reason:  'rule',
      });
    }
    return out;
  }

  return {
    evaluate,
    /** Positions moved, so old suppressions are about distances that no longer hold. */
    reset() { lastFired.clear(); },
    get pending() { return lastFired.size; },
  };
}

/** One-line description, used by the UI so the rule list reads as sentences. */
function describeRule(rule) {
  const r = normaliseRule(rule);
  const m = r.match || {};
  const bits = [];
  if (Array.isArray(m.pilots)) {
    bits.push(m.pilots.length ? `a watchlist pilot (${m.pilots.length})`
                              : 'a watchlist pilot — NONE ADDED YET, so this never fires');
  }
  if (Array.isArray(m.ships)) bits.push(m.ships.length ? m.ships.join(' / ') : 'a ship — none listed yet');
  if (Array.isArray(m.roles)) bits.push(m.roles.length ? m.roles.join(' / ') : 'a role — none picked yet');
  if (Number.isFinite(m.minSize))  bits.push(`${m.minSize}+ pilots`);
  if (Number.isFinite(m.maxStanding)) bits.push(`standing ${m.maxStanding} or worse`);
  if (m.camp)    bits.push('bubbles / gate camp');
  if (m.inbound) bits.push('closing on us');
  const what = bits.length ? bits.join(' and ') : 'anything';

  const { minJumps = 0, maxJumps = 15 } = r.within;
  const where = minJumps === 0 ? `within ${maxJumps} jumps` : `${minJumps}–${maxJumps} jumps out`;
  const acts = [r.then.notify !== false ? 'notify' : null, r.then.sound ? 'play a sound' : null]
    .filter(Boolean).join(' and ') || 'do nothing';
  return `When ${what} is reported ${where} — ${acts}.`;
}

module.exports = {
  createRuleEngine, ruleMatches, normaliseRule, describeRule,
  DEFAULT_RULE, STARTER_RULES,
};
