'use strict';
//
// Presence heartbeat — the state it reports about itself.
//
// The feature was invisible in every packaged build and nobody could tell why:
// initPresence() returned silently when PRESENCE_URL was empty, and every failed
// beat was swallowed. "Never configured", "endpoint down" and "working, nobody
// else online" all looked identical — a hidden counter. These tests cover the
// distinction, because that is what makes the next misconfiguration diagnosable.
const test   = require('node:test');
const assert = require('node:assert');

const presence = require('../src/presence');

test.afterEach(() => presence.stopPresence());

test('an empty PRESENCE_URL reports itself as unconfigured', () => {
  // Exactly what a release build gets when the repo secret is unset: the
  // workflow writes "PRESENCE_URL=" and dotenv hands back an empty string.
  presence.initPresence({ url: '', broadcast: () => {} });
  const st = presence.getPresenceState();
  assert.strictEqual(st.configured, false);
  assert.strictEqual(st.lastError, 'PRESENCE_URL not set');
  assert.strictEqual(st.beats, 0, 'nothing should be sent');
});

test('missing deps are treated the same way, not thrown', () => {
  presence.initPresence(undefined);
  assert.strictEqual(presence.getPresenceState().configured, false);
  presence.initPresence({ broadcast: () => {} });
  assert.strictEqual(presence.getPresenceState().configured, false);
});

test('a configured endpoint reports its host, not the whole URL', () => {
  // The state line is shown to users; a full URL with a path is noise, and the
  // host is what identifies which worker is being talked to.
  presence.initPresence({ url: 'https://presence.example.com/presence', broadcast: () => {} });
  const st = presence.getPresenceState();
  assert.strictEqual(st.configured, true);
  assert.strictEqual(st.url, 'presence.example.com');
  assert.strictEqual(st.lastError, null);
});

test('a malformed URL still counts as configured', () => {
  // Better to try and fail loudly than to silently disable on a typo.
  presence.initPresence({ url: 'not a url', broadcast: () => {} });
  assert.strictEqual(presence.getPresenceState().configured, true);
});

test('the count starts unknown rather than zero', () => {
  // Zero would render as "0 ONLINE"; unknown hides the counter, which is the
  // honest state before the first beat comes back.
  presence.initPresence({ url: 'https://presence.example.com/presence', broadcast: () => {} });
  assert.strictEqual(presence.getPresenceState().count, null);
  assert.strictEqual(presence.getPresenceCount(), null);
});
