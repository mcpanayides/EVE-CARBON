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
  assert.strictEqual(presence.getPresenceCount().count, null);
});

// ─── Version breakdown ────────────────────────────────────────────────────────
// The counter has to stay agnostic across releases: somebody who never upgrades
// past 3.3.0 must keep being counted after 4.0 ships. So the version rides along
// as an optional extra and never gates the count.

const { summarisePresenceVersions } = presence;

test('the newest releases are named and the rest fold into Other', () => {
  const rows = summarisePresenceVersions({
    '4.0.0': 19, '3.7.0': 12, '3.3.0': 23, '3.0.0': 5, 'unknown': 2,
  });
  assert.deepStrictEqual(rows, [
    { label: '4.0.0', count: 19 },
    { label: '3.7.0', count: 12 },
    { label: '3.3.0', count: 23 },
    { label: 'Other', count: 7 },     // 3.0.0 + unknown
  ]);
});

test('rows are ranked by version, not by how many people are on them', () => {
  // The question is "have people moved to the current release", so a brand new
  // build with one user still gets a row of its own.
  const rows = summarisePresenceVersions({ '4.0.0': 1, '3.3.0': 900 });
  assert.strictEqual(rows[0].label, '4.0.0');
});

test('a client too old to report its version is still counted, under Other', () => {
  const rows = summarisePresenceVersions({ '3.3.0': 4, 'unknown': 11 });
  assert.deepStrictEqual(rows, [
    { label: '3.3.0', count: 4 },
    { label: 'Other', count: 11 },
  ]);
});

test('Other is omitted when every user is on a named release', () => {
  const rows = summarisePresenceVersions({ '3.3.0': 4, '3.2.0': 1 });
  assert.deepStrictEqual(rows.map(r => r.label), ['3.3.0', '3.2.0']);
});

test('version ordering is numeric, not alphabetical', () => {
  // "3.10.0" sorts before "3.9.0" as a string; it is the newer release.
  const rows = summarisePresenceVersions({ '3.9.0': 1, '3.10.0': 1, '3.2.0': 1 });
  assert.deepStrictEqual(rows.map(r => r.label), ['3.10.0', '3.9.0', '3.2.0']);
});

test('a junk version never becomes a row', () => {
  // The field is attacker-controlled and the response is public.
  const rows = summarisePresenceVersions({ '<script>': 5, '3.3.0': 2 });
  assert.deepStrictEqual(rows, [
    { label: '3.3.0', count: 2 },
    { label: 'Other', count: 5 },
  ]);
});

test('no breakdown at all is not an error', () => {
  // An older worker answers with a count and no versions map.
  assert.deepStrictEqual(summarisePresenceVersions(null), []);
  assert.deepStrictEqual(summarisePresenceVersions(undefined), []);
  assert.deepStrictEqual(summarisePresenceVersions({}), []);
});

test('the count is reported alongside the breakdown', () => {
  // Every field is null until the first heartbeat lands. `platforms` joined
  // `versions` when the tooltip started reporting Windows/macOS/Linux; it is
  // pinned here for the same reason `versions` is — the renderer destructures
  // this shape, and a field silently disappearing from it blanks part of the
  // tooltip with nothing thrown anywhere.
  presence.initPresence({ url: 'https://presence.example.com/presence', broadcast: () => {} });
  assert.deepStrictEqual(presence.getPresenceCount(),
    { count: null, versions: null, platforms: null });
});
