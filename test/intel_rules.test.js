'use strict';
//
// User-defined alert rules, and the contact-sheet standings they can match on.
//
// The failure this guards against is the same one the whole tool lives or dies
// by: an alert the operator did not ask for. A rule that fires on the wrong
// thing, or keeps firing about a contact it already reported, gets the tool
// muted — and then it is not there for the op it was built for.
const test   = require('node:test');
const assert = require('node:assert');
const { createRuleEngine, ruleMatches, normaliseRule, describeRule, STARTER_RULES } =
  require('../src/intel/alert_rules');
const { createStandingsResolver, mergeContactSheets } = require('../src/intel/standings');

const contact = (over = {}) => ({
  key: 'p:x', kind: 'pilot', label: 'Some Pilot', systemId: 2, systemName: '5M2-KP',
  jumps: 4, inbound: false, closing: 0, etaSeconds: 200, sightings: 2,
  roles: [], ships: [], size: 3, band: 'small', pilots: [], ...over,
});
const rule = (over = {}) => normaliseRule({ id: 'r', enabled: true, name: 't', ...over });

// ── Matching ──────────────────────────────────────────────────────────────────

test('a rule with no conditions matches anything in its jump range', () => {
  // "Tell me about anything within 5 jumps" must be expressible without
  // ticking a single box.
  const r = rule({ within: { minJumps: 0, maxJumps: 5 } });
  assert.strictEqual(ruleMatches(r, contact({ jumps: 4 })), true);
  assert.strictEqual(ruleMatches(r, contact({ jumps: 6 })), false, 'outside the range');
});

test('a disabled rule never matches', () => {
  assert.strictEqual(ruleMatches(rule({ enabled: false }), contact()), false);
});

test('watchlist pilots match the contact OR anyone reported alongside it', () => {
  // A known hot-dropper named in a system-level report must still fire, even
  // though that track is keyed on the system rather than on them.
  const r = rule({ match: { pilots: ['Hot Dropper'] } });
  assert.strictEqual(ruleMatches(r, contact({ label: 'Hot Dropper' })), true, 'as the contact');
  assert.strictEqual(
    ruleMatches(r, contact({ kind: 'system', label: '5M2-KP', pilots: ['Hot Dropper'] })), true,
    'as a pilot named in the report');
  assert.strictEqual(ruleMatches(r, contact({ label: 'hot dropper' })), true, 'case-insensitive');
  assert.strictEqual(ruleMatches(r, contact({ label: 'Someone Else' })), false);
});

test('standings match at or BELOW the threshold', () => {
  // -10 is worse than -5, so a rule asking for -5 must fire on -10 as well.
  const r = rule({ match: { maxStanding: -5 } });
  assert.strictEqual(ruleMatches(r, contact(), { standing: -10 }), true);
  assert.strictEqual(ruleMatches(r, contact(), { standing: -5 }),  true);
  assert.strictEqual(ruleMatches(r, contact(), { standing: -2 }),  false);
  assert.strictEqual(ruleMatches(r, contact(), { standing: 10 }),  false);
  // An unresolved name is NOT evidence of hostility.
  assert.strictEqual(ruleMatches(r, contact(), {}), false, 'unknown standing must not match');
  assert.strictEqual(ruleMatches(r, contact(), { standing: null }), false);
});

test('conditions are AND-ed, values within a condition are OR-ed', () => {
  const r = rule({ match: { roles: ['tackle', 'capital'], minSize: 5 } });
  assert.strictEqual(ruleMatches(r, contact({ roles: ['tackle'],  size: 6 })), true);
  assert.strictEqual(ruleMatches(r, contact({ roles: ['capital'], size: 6 })), true, 'either role');
  assert.strictEqual(ruleMatches(r, contact({ roles: ['tackle'],  size: 2 })), false, 'size must also pass');
  assert.strictEqual(ruleMatches(r, contact({ roles: ['cloaky'],  size: 9 })), false, 'role must also pass');
});

test('ship, camp and inbound conditions', () => {
  assert.strictEqual(ruleMatches(rule({ match: { ships: ['Sabre'] } }), contact({ ships: ['sabre'] })), true);
  assert.strictEqual(ruleMatches(rule({ match: { ships: ['Sabre'] } }), contact({ ships: ['myrmidon'] })), false);
  assert.strictEqual(ruleMatches(rule({ match: { inbound: true } }), contact({ inbound: false })), false);
  assert.strictEqual(ruleMatches(rule({ match: { inbound: true } }), contact({ inbound: true })), true);
  assert.strictEqual(ruleMatches(rule({ match: { camp: true } }), contact({ camp: true })), true);
  assert.strictEqual(ruleMatches(rule({ match: { camp: true } }), contact({ camp: false })), false);
});

// ── Suppression ───────────────────────────────────────────────────────────────

test('each rule is suppressed independently, and per contact', () => {
  // One rule going quiet must not silence another, and a rule watching for
  // tackle must still fire for a second, different tackle contact.
  const rules = [
    rule({ id: 'a', name: 'A', quietForS: 60 }),
    rule({ id: 'b', name: 'B', quietForS: 60 }),
  ];
  const eng = createRuleEngine(() => rules);
  const t0 = 1_000_000;

  const first = eng.evaluate(contact({ key: 'p:1' }), {}, t0);
  assert.deepStrictEqual(first.map(h => h.rule.id).sort(), ['a', 'b'], 'both fire initially');

  assert.deepStrictEqual(eng.evaluate(contact({ key: 'p:1' }), {}, t0 + 5000), [],
    'same contact inside the window — silent');

  assert.strictEqual(eng.evaluate(contact({ key: 'p:2' }), {}, t0 + 5000).length, 2,
    'a DIFFERENT contact still fires both rules');

  assert.strictEqual(eng.evaluate(contact({ key: 'p:1' }), {}, t0 + 61_000).length, 2,
    'the window expired');
});

test('moving the fleet clears suppressions', () => {
  // Every distance changed, so "already told you about this" no longer holds.
  const eng = createRuleEngine(() => [rule({ id: 'a', quietForS: 600 })]);
  const t0 = 1_000_000;
  assert.strictEqual(eng.evaluate(contact(), {}, t0).length, 1);
  assert.strictEqual(eng.evaluate(contact(), {}, t0 + 1000).length, 0);
  eng.reset();
  assert.strictEqual(eng.evaluate(contact(), {}, t0 + 2000).length, 1);
});

// ── Defaults and durability ───────────────────────────────────────────────────

test('starter rules ship disabled', () => {
  // They are examples. Firing unasked-for alerts on first launch is exactly how
  // a warning tool gets muted before it has been trusted once.
  for (const r of STARTER_RULES) {
    assert.strictEqual(r.enabled, false, `${r.name} must ship disabled`);
  }
  assert.ok(STARTER_RULES.some(r => Number.isFinite(r.match.maxStanding)),
    'a standings example is included');
});

test('rules describe themselves as sentences', () => {
  const d = describeRule(rule({
    match:  { roles: ['tackle'], minSize: 10 },
    within: { minJumps: 0, maxJumps: 8 },
    then:   { notify: true, sound: true },
  }));
  assert.match(d, /tackle/);
  assert.match(d, /10\+ pilots/);
  assert.match(d, /within 8 jumps/);
  assert.match(d, /notify and play a sound/);
  assert.match(describeRule(rule({})), /anything/, 'an empty rule says so plainly');
});

test('a stored rule missing newer fields still works', () => {
  // Configs written before a field existed must not throw, and must not
  // silently widen into matching everything.
  const r = normaliseRule({ id: 'old', enabled: true, name: 'legacy' });
  assert.strictEqual(r.within.maxJumps, 15);
  assert.strictEqual(r.then.notify, true);
  assert.strictEqual(r.quietForS, 60);
  assert.strictEqual(ruleMatches(r, contact({ jumps: 4 })), true);
  assert.strictEqual(ruleMatches(r, contact({ jumps: 40 })), false);
});

// ── Contact-sheet standings ───────────────────────────────────────────────────

test('personal contacts outrank alliance ones', () => {
  // EVE resolves it that way, and a pilot you personally blacklisted must not
  // be softened by an alliance that has not caught up.
  const merged = mergeContactSheets({ alliance: { 100: 5, 200: -5 }, personal: { 100: -10 } });
  assert.strictEqual(merged[100], -10, 'personal wins');
  assert.strictEqual(merged[200], -5,  'alliance-only entries survive');
});

test('a name resolves to a standing once its id is known', async () => {
  const resolver = createStandingsResolver({
    httpPost: async () => ({ characters: [{ id: 42, name: 'Red Pilot' }] }),
    getContactSheet: () => ({ 42: -10 }),
  });
  // The first sighting queues the lookup and returns null rather than making
  // the report wait on a network call.
  assert.strictEqual(resolver.standingFor('Red Pilot'), null);
  assert.strictEqual(resolver.queued, 1);
  await resolver.flush();
  assert.strictEqual(resolver.standingFor('Red Pilot'), -10, 'resolved by the next sighting');
  assert.strictEqual(resolver.standingFor('red pilot'), -10, 'case-insensitive');
});

test('unresolvable names are remembered as misses, not retried forever', async () => {
  // Most names in intel belong to line members nobody has set a standing for.
  // Re-resolving them on every sighting would be the bulk of the traffic.
  let calls = 0;
  const resolver = createStandingsResolver({
    httpPost: async () => { calls++; return { characters: [] }; },
    getContactSheet: () => ({}),
  });
  resolver.standingFor('Nobody Special');
  await resolver.flush();
  assert.strictEqual(calls, 1);
  for (let i = 0; i < 5; i++) resolver.standingFor('Nobody Special');
  await resolver.flush();
  assert.strictEqual(calls, 1, 'a known miss is never re-queued');
});

test('worstStanding takes the most hostile of a gang', () => {
  const resolver = createStandingsResolver({
    httpPost: async () => ({ characters: [] }),
    getContactSheet: () => ({ 1: 5, 2: -10, 3: 0 }),
  });
  resolver._seed({ a: 1, b: 2, c: 3 });
  assert.strictEqual(resolver.worstStanding(['A', 'B', 'C']), -10);
  assert.strictEqual(resolver.worstStanding(['A', 'C']), 0);
  assert.strictEqual(resolver.worstStanding(['Unknown']), null, 'unknown is not zero');
});

test('a failing name lookup never throws into the intel pipeline', async () => {
  const resolver = createStandingsResolver({
    httpPost: async () => { throw new Error('ESI is down'); },
    getContactSheet: () => ({}),
  });
  resolver.standingFor('Someone');
  await resolver.flush();               // must not throw
  assert.strictEqual(resolver.standingFor('Someone'), null);
});


test('an empty list condition fails CLOSED, an absent one does not', () => {
  // The trap this guards: a rule called "Watchlist pilot seen" with nobody on
  // the list yet would otherwise skip the check entirely and alert on every
  // contact in range — the opposite of what enabling it means.
  const empty   = rule({ match: { pilots: [] } });
  const absent  = rule({ match: {} });
  assert.strictEqual(ruleMatches(empty,  contact()), false, 'empty watchlist never fires');
  assert.strictEqual(ruleMatches(absent, contact()), true,  'no condition at all means anything');

  assert.strictEqual(ruleMatches(rule({ match: { ships: [] } }), contact({ ships: ['sabre'] })), false);
  assert.strictEqual(ruleMatches(rule({ match: { roles: [] } }), contact({ roles: ['tackle'] })), false);
});

test('the starter watchlist rule says it cannot fire yet', () => {
  // It ships with an empty list on purpose; the sentence has to admit that
  // rather than claiming it matches "anything".
  const starter = STARTER_RULES.find(r => Array.isArray(r.match.pilots));
  assert.ok(starter, 'a watchlist example exists');
  const d = describeRule(starter);
  assert.match(d, /never fires/i, `unhelpful description: ${d}`);
  assert.doesNotMatch(d, /^When anything/, 'must not imply it matches everything');
});
