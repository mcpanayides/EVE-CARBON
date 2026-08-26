'use strict';
// Guards which Jabber messages raise the full-screen ping window.
//
// The window is exclusive — createPingAlertWindow() closes the current alert to
// open the next — so a burst of structure alerts does not pile up windows, it
// DESTROYS whatever was on screen. During an attack wave that is the fleet ping
// an FC is waiting for. These cases pin both halves: the noise stays out, and
// nothing that could be a real ping is dropped.
const test   = require('node:test');
const assert = require('node:assert');
const { classifyPing, jidNode } = require('../src/intel/ping_classify');

const at = (from, body, type = 'chat') => classifyPing({ from, body, type });

test('a director broadcast pops', () => {
  const r = at('directors@example.test/bot', 'Strat op forming, undock now');
  assert.ok(r.isDirector);
  assert.ok(r.shouldPopup);
});

test('the word "director" in a 1:1 chat no longer pops', () => {
  // The old rule was /director/i against the body, so this opened a
  // full-screen alert over whatever the user was doing.
  const r = at('friend@example.test/desktop', 'ask the director when he is on', 'chat');
  assert.ok(r.isDirector, 'still flagged for the panel and the is_director column');
  assert.strictEqual(r.shouldPopup, false, 'a private chat is not a broadcast');
});

test('a broadcast whose only director signal is the body still pops', () => {
  // Headline is XMPP's broadcast type. Narrowing the body rule must not cost a
  // real ping from a server that names the sender something else.
  const r = at('announce@example.test', 'Directors: strat op in 10', 'headline');
  assert.ok(r.shouldPopup);
});

test('a director-ish domain or resource is not a director', () => {
  // The old rule tested the WHOLE JID, so both of these were fleet pings.
  assert.strictEqual(at('alerts@director.example.test/x', 'hello').isDirector, false,
    'domain must not count');
  assert.strictEqual(at('bob@example.test/director-console', 'hello').isDirector, false,
    'resource must not count');
});

test('director-like words are not directors', () => {
  for (const node of ['directory', 'redirector', 'directions']) {
    assert.strictEqual(at(`${node}@example.test`, 'hi').isDirector, false, node);
  }
});

test('underscored and hyphenated broadcast accounts still match', () => {
  for (const node of ['director_bot', 'alliance-directors', 'DIRECTOR']) {
    assert.ok(at(`${node}@example.test`, 'hi').isDirector, node);
  }
});

test('structure alerts do not pop, but are still recorded', () => {
  const cases = [
    'Athanor in J123456 is under attack',
    'Astrahus has entered its armor reinforcement timer',
    'Tatara fuel is low',
    'Raitaru has entered shield',
  ];
  for (const body of cases) {
    const r = at('directorbot@example.test', body);
    assert.ok(r.isDirector, body);
    assert.ok(r.isStructureAlert, body);
    assert.strictEqual(r.shouldPopup, false, `should not pop: ${body}`);
  }
});

test('a fleet call that mentions a structure still pops', () => {
  // The override that stops this classifier from eating a real ping.
  const r = at('directors@example.test',
    'Fortizar under attack — home defence fleet up, undock now');
  assert.ok(r.isStructureAlert === false, 'fleet signal beats structure suppression');
  assert.ok(r.shouldPopup);
});

test('suppression never applies to a non-director sender', () => {
  const r = at('randomguy@example.test', 'my tower is under attack');
  assert.strictEqual(r.isDirector, false);
  assert.strictEqual(r.isStructureAlert, false);
  assert.strictEqual(r.shouldPopup, false, 'was never going to pop anyway');
});

test('jidNode strips resource and domain', () => {
  assert.strictEqual(jidNode('a@b.test/c'), 'a');
  assert.strictEqual(jidNode('a@b.test'), 'a');
  assert.strictEqual(jidNode('bare'), 'bare');
  assert.strictEqual(jidNode(''), '');
  assert.strictEqual(jidNode(undefined), '');
});

test('malformed input does not throw', () => {
  for (const bad of [undefined, null, {}, { from: null, body: null }]) {
    assert.doesNotThrow(() => classifyPing(bad));
  }
});
