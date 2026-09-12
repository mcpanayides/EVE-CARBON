'use strict';
//
// The Killfeed widget.
//
// A chronological feed of killmails for one of three subjects: your whole
// roster, one of your characters, or ANY corporation looked up by name. All of
// it comes from the same cached zKill fetch the Killboard page uses, so the
// interesting logic here is not the fetching — it is what a stored subject means
// and how several feeds become one.
const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

function load() {
  const noop = () => {};
  const store = {};
  const sb = {
    console, Math, Date, JSON, Map, Set, Promise, Object, Array, String, Number,
    Boolean, RegExp, Error, isNaN, parseFloat, parseInt, setTimeout, clearTimeout,
    setInterval, clearInterval,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { eveAPI: {}, addEventListener: noop },
    escHtml: (s) => String(s),
    formatISK: (n) => `${n} ISK`,
    Esi: { url: (p) => `https://esi.example/${p}` },
    fetch: () => Promise.reject(new Error('no net')),
  };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'func', 'dashboard-killfeed.js'), 'utf8'),
    ctx, { filename: 'dashboard-killfeed.js' });
  return sb;
}

const km = (id, iso, extra = {}) => ({
  killmailId: id, time: iso, totalValue: 1e6, isLoss: false,
  victimShipTypeId: 671, systemId: 30000142, victimCharId: 90000001,
  finalBlowCharId: 90000002, attackerCount: 3, ...extra,
});

// ── What a stored subject means ──────────────────────────────────────────────

const ACCOUNTS = [
  { characterId: 111, characterName: 'Pilot One' },
  { characterId: 222, characterName: 'Pilot Two' },
];

test('"all" fans out to every character on the roster', () => {
  const S = load();
  const e = S.kfEntities({ v: 'all' }, ACCOUNTS);
  assert.strictEqual(e.length, 2);
  assert.strictEqual(e.map(x => x.kind).join(','), 'character,character');
  assert.strictEqual(e.map(x => x.id).join(','), '111,222');
});

test('a character subject is one character, a corporation subject is one corp', () => {
  const S = load();
  const c = S.kfEntities({ v: 'char:222' }, ACCOUNTS);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].kind, 'character');
  assert.strictEqual(c[0].id, 222);

  const p = S.kfEntities({ v: 'corp:98388312' }, ACCOUNTS);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].kind, 'corporation');
  assert.strictEqual(p[0].id, 98388312);
});

test('a corporation subject does NOT depend on the roster', () => {
  // The whole point of the searchable third type: it is any corp in EVE, not one
  // of yours, so an empty account list must still produce an entity to fetch.
  const S = load();
  assert.strictEqual(S.kfEntities({ v: 'corp:98388312' }, []).length, 1);
  assert.strictEqual(S.kfEntities({ v: 'all' }, []).length, 0, 'but "all" of nothing is nothing');
});

test('a subject that cannot be read yields nothing rather than a bad fetch', () => {
  const S = load();
  for (const bad of [null, {}, { v: '' }, { v: 'corp:' }, { v: 'alliance:99' }, { v: 'nonsense' }]) {
    assert.strictEqual(S.kfEntities(bad, ACCOUNTS).length, 0, JSON.stringify(bad));
  }
});

// ── Merging several feeds into one ───────────────────────────────────────────

test('feeds merge newest-first regardless of the order they arrived in', () => {
  const S = load();
  const rows = S.kfMerge([
    [km(1, '2026-09-01T10:00:00Z'), km(2, '2026-09-01T08:00:00Z')],
    [km(3, '2026-09-01T11:00:00Z'), km(4, '2026-09-01T09:00:00Z')],
  ], 10);
  assert.strictEqual(rows.map(r => r.killmailId).join(','), '3,1,4,2');
});

test('one killmail two of your characters were on is ONE row', () => {
  // Both pilots on the same kill means zKill hands back the same killmail on
  // both feeds. Printing it twice would make a quiet evening look busy.
  const S = load();
  const rows = S.kfMerge([
    [km(7, '2026-09-01T10:00:00Z')],
    [km(7, '2026-09-01T10:00:00Z'), km(8, '2026-09-01T09:00:00Z')],
  ], 10);
  assert.strictEqual(rows.map(r => r.killmailId).join(','), '7,8');
});

test('the merge is capped, and survives a feed that failed', () => {
  const S = load();
  const many = Array.from({ length: 30 }, (_, i) =>
    km(i, new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString()));
  assert.strictEqual(S.kfMerge([many], 14).length, 14);
  // One character with no killboard returns null; the others still render.
  const mixed = S.kfMerge([null, [km(1, '2026-09-01T10:00:00Z')], undefined], 14);
  assert.strictEqual(mixed.length, 1);
  assert.strictEqual(S.kfMerge([], 14).length, 0);
  assert.strictEqual(S.kfMerge(null, 14).length, 0);
});

test('a killmail with no timestamp does not corrupt the ordering', () => {
  const S = load();
  const rows = S.kfMerge([[km(1, '2026-09-01T10:00:00Z'), km(2, undefined), km(3, '2026-09-01T12:00:00Z')]], 10);
  assert.strictEqual(rows[0].killmailId, 3, 'the newest real one still leads');
  assert.strictEqual(rows.length, 3, 'and nothing is dropped');
});

// ── Age ──────────────────────────────────────────────────────────────────────

test('age reads in the largest unit that still means something', () => {
  const S = load();
  const now = Date.parse('2026-09-01T12:00:00Z');
  const at  = (ms) => S.kfAgo(new Date(now - ms).toISOString(), now);
  assert.strictEqual(at(30 * 1000), '30s');
  assert.strictEqual(at(5 * 60_000), '5m');
  assert.strictEqual(at(4 * 3600_000), '4h');
  assert.strictEqual(at(6 * 86400_000), '6d');
  assert.strictEqual(at(70 * 86400_000), '2mo');
});

test('age never runs backwards or throws', () => {
  const S = load();
  const now = Date.parse('2026-09-01T12:00:00Z');
  // A killmail stamped slightly in the future (clock skew) reads as "now", not
  // as a negative age.
  assert.strictEqual(S.kfAgo(new Date(now + 60_000).toISOString(), now), '0s');
  assert.strictEqual(S.kfAgo(undefined, now), '');
  assert.strictEqual(S.kfAgo('not a date', now), '');
});

// ── Per-instance subject + title ─────────────────────────────────────────────

test('each feed titles itself after its subject', () => {
  const S = load();
  S.kfSetSubject('killFeed~a', 'all');
  S.kfSetSubject('killFeed~b', 'char:222', 'Pilot Two');
  S.kfSetSubject('killFeed~c', 'corp:98388312', 'Pandemic Horde Inc.');
  const [a, b, c] = ['a', 'b', 'c'].map(k => S.kfTitle(`killFeed~${k}`));
  assert.match(a, /ALL CHARACTERS/);
  assert.match(b, /PILOT TWO/);
  assert.match(c, /PANDEMIC HORDE INC\./);
  assert.strictEqual(new Set([a, b, c]).size, 3, 'three feeds side by side must be tellable apart');
});

test('an unset or unreadable subject still yields a usable title', () => {
  const S = load();
  assert.strictEqual(S.kfTitle('killFeed~never'), 'KILLFEED');
  S.kfSetSubject('killFeed~y', 'corp:98388312');       // no label
  assert.match(S.kfTitle('killFeed~y'), /CORP 98388312/);
});

test('removing a feed forgets its subject, and only its own', () => {
  const S = load();
  S.kfSetSubject('killFeed~keep', 'char:111', 'Pilot One');
  S.kfSetSubject('killFeed~drop', 'corp:98388312', 'Pandemic Horde Inc.');
  S.kfForgetSubject('killFeed~drop');
  assert.strictEqual(S.kfTitle('killFeed~drop'), 'KILLFEED');
  assert.match(S.kfTitle('killFeed~keep'), /PILOT ONE/);
  // A different widget's instance id must pass straight through.
  assert.doesNotThrow(() => S.kfForgetSubject('fwTug~1'));
  assert.match(S.kfTitle('killFeed~keep'), /PILOT ONE/);
});

// ── Corporation search ───────────────────────────────────────────────────────

test('a too-short query is not sent at all', async () => {
  // Guards a free endpoint from a request per keystroke.
  const S = load();
  let calls = 0;
  S.fetch = () => { calls++; return Promise.reject(new Error('should not run')); };
  assert.strictEqual((await S.kfSearchCorps('go')).length, 0);
  assert.strictEqual((await S.kfSearchCorps('')).length, 0);
  assert.strictEqual((await S.kfSearchCorps(null)).length, 0);
  assert.strictEqual(calls, 0);
});

test('a corporation hit becomes a pickable subject', async () => {
  const S = load();
  S.fetch = async () => ({ ok: true, json: async () => ({ corporations: [{ id: 667531913, name: 'GoonWaffe' }] }) });
  const r = await S.kfSearchCorps('goonwaffe');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].value, 'corp:667531913');
  assert.strictEqual(r[0].label, 'GoonWaffe');
});

test('an alliance name explains itself instead of returning nothing', async () => {
  // "Goonswarm Federation" is an alliance. Typing the most famous name in the
  // game and getting silence reads as a broken search, so it says what happened.
  const S = load();
  S.fetch = async () => ({ ok: true, json: async () => ({ alliances: [{ id: 1354830081, name: 'Goonswarm Federation' }] }) });
  const r = await S.kfSearchCorps('goonswarm federation');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].disabled, true, 'it must not be addable');
  assert.match(r[0].label, /alliance, not a corporation/i);
});

test('a failed or empty search is empty, never a crash', async () => {
  const S = load();
  S.fetch = async () => ({ ok: false, json: async () => ({}) });
  assert.strictEqual((await S.kfSearchCorps('whatever')).length, 0);
  S.fetch = async () => { throw new Error('offline'); };
  assert.strictEqual((await S.kfSearchCorps('whatever')).length, 0);
  S.fetch = async () => ({ ok: true, json: async () => ({}) });
  assert.strictEqual((await S.kfSearchCorps('whatever')).length, 0);
  S.fetch = async () => ({ ok: true, json: async () => ({ characters: [{ id: 1, name: 'Someone' }] }) });
  assert.strictEqual((await S.kfSearchCorps('someone')).length, 0, 'a character is not a corporation');
});
