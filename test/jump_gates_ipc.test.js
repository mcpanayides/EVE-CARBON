'use strict';
//
// Gates from EVE (src/ipc/jump_gates_ipc.js), with ESI, the token store and the
// structure cache faked: who may search, what the search asks ESI, what comes
// back, and that it stops while ESI's error budget still has room.
const test   = require('node:test');
const assert = require('node:assert');

const { createJumpGateSearch, createJumpGateSync, SEARCH_SCOPE, ANSIBLEX_TYPE_ID } = require('../src/ipc/jump_gates_ipc');

const BASE = 'https://esi.example';
const token = (scopes) => `h.${Buffer.from(JSON.stringify({ scp: scopes })).toString('base64url')}.s`;
const decode = (t) => {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')).scp; }
  catch (_) { return null; }
};

function setup({ accounts, structures = {}, searchIds = [], cache = {}, budget = { remain: 100, blockedFor: 0 }, searchError } = {}) {
  const calls = [];
  const store = { ...cache };
  const gates = createJumpGateSearch({
    loadDB: () => ({ accounts }),
    getValidToken: async (id) => accounts[id].accessToken,
    decodeTokenScopes: decode,
    esiAuthHeaders: (t) => ({ Authorization: `Bearer ${t}` }),
    esiBudget: () => (typeof budget === 'function' ? budget() : budget),
    readCache: (k) => store[k],
    writeCache: (k, v) => { store[k] = v; },
    ESI_BASE: BASE,
    httpGet: async (url) => {
      calls.push(url);
      if (url.includes('/search/')) { if (searchError) throw new Error(searchError); return { structure: searchIds }; }
      const id = Number(url.match(/structures\/(\d+)/)[1]);
      if (structures[id] === 403) throw new Error('HTTP 403');
      return structures[id] || null;
    },
  });
  return { gates, calls, store };
}

const ACCOUNTS = {
  1: { characterId: 1, characterName: 'Searcher', accessToken: token(['esi-universe.read_structures.v1', SEARCH_SCOPE]) },
  2: { characterId: 2, characterName: 'Plain',    accessToken: token(['esi-universe.read_structures.v1']) },
  3: { characterId: 3, characterName: 'Expired',  accessToken: token([SEARCH_SCOPE]), needsReauth: true },
  4: { characterId: 4, characterName: 'Demo',     accessToken: 'demo-token' },
};

test('which characters may search comes from the stored token, with no network', () => {
  const { gates, calls } = setup({ accounts: ACCOUNTS });
  assert.deepStrictEqual(gates.characters().map(c => [c.characterName, c.canSearch]),
    [['Searcher', true], ['Plain', false], ['Expired', false], ['Demo', true]]);   // an unreadable token is ESI's call
  assert.strictEqual(calls.length, 0);
});

test('the search asks for structures named " » " and keeps the Ansiblex ones', async () => {
  const { gates, calls, store } = setup({
    accounts: ACCOUNTS,
    searchIds: [11, 12, 13, 14, 11],
    structures: {
      11: { name: '1DQ1-A » T5ZI-S - Spur', solar_system_id: 30004759, owner_id: 9, type_id: ANSIBLEX_TYPE_ID },
      12: { name: 'T5ZI-S » 1DQ1-A - Spur', solar_system_id: 30004735, owner_id: 9, type_id: ANSIBLEX_TYPE_ID },
      13: { name: 'Market » Hub', solar_system_id: 30004759, owner_id: 9, type_id: 35832 },   // an Astrahus with an arrow in its name
      14: 403,
    },
  });
  const progress = [];
  const r = await gates.search(1, { onProgress: (p) => progress.push(p) });
  assert.match(calls[0], /\/characters\/1\/search\/\?datasource=tranquility&categories=structure&search=%20%C2%BB%20$/);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.characterName, 'Searcher');
  assert.strictEqual(r.total, 4);                                               // the repeated id is read once
  assert.deepStrictEqual(r.gates.map(g => g.structureId).sort(), [11, 12]);
  assert.deepStrictEqual(r.gates.find(g => g.structureId === 11), { structureId: 11, name: '1DQ1-A » T5ZI-S - Spur', systemId: 30004759 });
  assert.strictEqual(r.notGates, 1);
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(r.stoppedEarly, false);
  assert.deepStrictEqual(progress[0], { done: 0, total: 4 });
  assert.deepStrictEqual(progress[progress.length - 1], { done: 4, total: 4 });
  // What was read went into the locator's cache, in its shape.
  assert.deepStrictEqual(store.struct_name_11, { name: '1DQ1-A » T5ZI-S - Spur', solar_system_id: 30004759, owner_id: 9, type_id: ANSIBLEX_TYPE_ID });
});

test('a structure already in the cache is not read again', async () => {
  const { gates, calls } = setup({
    accounts: ACCOUNTS, searchIds: [21, 22],
    cache: {
      struct_name_21: { name: '8WA-Z6 » N-8YET - Hop', solar_system_id: 30004760 },
      struct_name_22: { name: 'Keepstar » Somewhere', solar_system_id: 30004760, type_id: 35834 },
    },
  });
  const r = await gates.search(1);
  assert.strictEqual(calls.length, 1);                                         // the search alone
  assert.deepStrictEqual(r.gates, [{ structureId: 21, name: '8WA-Z6 » N-8YET - Hop', systemId: 30004760 }]);
  assert.strictEqual(r.notGates, 1);
});

test('it stops while the error budget still has room, and says so', async () => {
  let reads = 0;
  const { gates } = setup({
    accounts: ACCOUNTS, searchIds: [31, 32, 33, 34, 35, 36],
    structures: Object.fromEntries([31, 32, 33, 34, 35, 36].map(id => [id, { name: `A${id} » B${id}`, solar_system_id: 1, type_id: ANSIBLEX_TYPE_ID }])),
    budget: () => ({ remain: reads++ < 4 ? 100 : 5, blockedFor: 0 }),
  });
  const r = await gates.search(1);
  assert.strictEqual(r.stoppedEarly, true);
  assert.ok(r.gates.length < 6 && r.gates.length > 0, String(r.gates.length));
});

test('characters that can’t search are answered without asking ESI', async () => {
  const { gates, calls } = setup({ accounts: ACCOUNTS });
  assert.deepStrictEqual(await gates.search(2), { ok: false, reason: 'scope' });
  assert.deepStrictEqual(await gates.search(3), { ok: false, reason: 'reauth' });
  assert.deepStrictEqual(await gates.search(99), { ok: false, reason: 'unknown' });
  assert.strictEqual(calls.length, 0);
});

test('a refused search reads as a missing permission; anything else as an error', async () => {
  assert.deepStrictEqual(await setup({ accounts: ACCOUNTS, searchError: 'HTTP 403 Forbidden' }).gates.search(1),
    { ok: false, reason: 'scope', message: 'HTTP 403 Forbidden' });
  assert.deepStrictEqual(await setup({ accounts: ACCOUNTS, searchError: 'HTTP 502' }).gates.search(1),
    { ok: false, reason: 'error', message: 'HTTP 502' });
  const none = await setup({ accounts: ACCOUNTS, searchIds: [] }).gates.search(1);
  assert.deepStrictEqual([none.ok, none.total, none.gates], [true, 0, []]);
});

// ─── the hourly read ──────────────────────────────────────────────────────────
// The main character's gates are ours (green, routed through); gates only the
// pilot's other characters can see are theirs (red, never routed through).

const found = (...names) => ({ ok: true, failed: 0, stoppedEarly: false,
  gates: names.map(([name, systemId]) => ({ name, systemId })) });

function round({ results, chosen = '1', enabled = true, friendly = [], other = [], state = null, able } = {}) {
  const cfg = { app: { jumpGates: chosen ? { characterId: chosen } : {} } };
  const disk = { friendly, other, state };
  const searched = [], events = [];
  const sync = createJumpGateSync({
    enabled, now: () => 1000,
    gates: {
      characters: () => able || [
        { characterId: 1, characterName: 'Main', canSearch: true },
        { characterId: 2, characterName: 'Scout', canSearch: true },
        { characterId: 3, characterName: 'Not allowed', canSearch: false },
      ],
      search: async (id, { onProgress } = {}) => {
        searched.push(id);
        if (onProgress) onProgress({ done: 0, total: 1 });
        await new Promise(r => setImmediate(r));
        return results[id];
      },
    },
    loadConfig: () => cfg,
    saveConfig: (c) => Object.assign(cfg, c),
    systemIndex: async () => ({ a1: 1, a2: 2, b1: 11, b2: 12 }),
    store: {
      loadFriendly: () => disk.friendly, saveFriendly: (v) => { disk.friendly = v; },
      loadOther:    () => disk.other,    saveOther:    (v) => { disk.other = v; },
      loadState:    () => disk.state,    saveState:    (v) => { disk.state = v; },
    },
    broadcast: (channel, payload) => events.push([channel, payload]),
  });
  return { sync, cfg, disk, searched, events };
}

test('the main character’s gates are ours and the other characters’ are theirs', async () => {
  const { sync, disk, searched, events } = round({ results: {
    1: found(['A1 » A2 - Spur', 1]),
    2: found(['B1 » B2', 11], ['A2 » A1 - Spur', 2]),               // the scout sees ours too
  } });
  const r = await sync.sync();
  assert.deepStrictEqual(searched, [1, 2]);                       // never the character that isn't allowed
  assert.deepStrictEqual(disk.friendly, [[1, 2]]);
  assert.deepStrictEqual(disk.other, [[11, 12]]);
  assert.deepStrictEqual([r.ok, r.mine, r.theirs, r.characterName], [true, 1, 1, 'Main']);
  assert.ok(events.some(([ch, p]) => ch === 'jump-gates-esi-progress' && p.characterName === 'Scout'));
  assert.deepStrictEqual(events[events.length - 1][0], 'jump-gates-updated');
  const s = sync.status();
  assert.deepStrictEqual([s.characterId, s.mine, s.theirs, s.checkedAt, s.characterName], [1, 1, 1, 1000, 'Main']);
});

test('a new main makes its gates ours and is remembered; the same main again reads nothing', async () => {
  const { sync, cfg, disk, searched } = round({
    friendly: [[1, 2]], other: [[11, 12]], state: { mine: [[1, 2]], theirs: [[11, 12]] },
    results: { 1: found(['A1 » A2', 1]), 2: found(['B1 » B2', 11]) },
  });
  await sync.setCharacter(2);
  assert.strictEqual(cfg.app.jumpGates.characterId, '2');
  assert.deepStrictEqual(searched, [2, 1]);                       // ours first
  assert.deepStrictEqual(disk.friendly, [[11, 12]]);              // the old network has left ours…
  assert.deepStrictEqual(disk.other, [[1, 2]]);                   // …and shows as theirs
  // Told on every launch who the main is: only a change reads.
  assert.deepStrictEqual(await sync.setCharacter('2'), { ok: true, reason: 'same' });
  assert.deepStrictEqual(searched, [2, 1]);
});

test('a main that can’t search is never stood in for: nothing is read, nothing changes, and it says why', async () => {
  // A scout in another alliance standing in would have had the planner routing through enemy gates.
  const { sync, disk, searched } = round({
    friendly: [[1, 2]], other: [[11, 12]], state: { mine: [[1, 2]], theirs: [[11, 12]], checkedAt: 5 },
    able: [{ characterId: 1, characterName: 'Main', canSearch: false },
           { characterId: 2, characterName: 'Scout', canSearch: true }],
    results: { 2: found(['B1 » B2', 11]) },
  });
  const r = await sync.sync();
  assert.deepStrictEqual([r.ok, r.reason, r.characterName], [false, 'scope', 'Main']);
  assert.deepStrictEqual(searched, []);
  assert.deepStrictEqual([disk.friendly, disk.other], [[[1, 2]], [[11, 12]]]);
  assert.deepStrictEqual([disk.state.error.reason, disk.state.checkedAt], ['scope', 5]);
  assert.deepStrictEqual(sync.status().main, { characterId: 1, characterName: 'Main', canSearch: false, needsReauth: false });
});

test('when ours can’t be read, nothing changes and the reason is kept', async () => {
  const { sync, disk } = round({
    friendly: [[1, 2]], other: [[11, 12]], state: { mine: [[1, 2]], theirs: [[11, 12]], checkedAt: 5 },
    results: { 1: { ok: false, reason: 'scope' }, 2: found(['B1 » B2', 11]) },
  });
  const r = await sync.sync();
  assert.deepStrictEqual([r.ok, r.reason], [false, 'scope']);
  assert.deepStrictEqual(disk.friendly, [[1, 2]]);
  assert.deepStrictEqual(disk.other, [[11, 12]]);
  assert.strictEqual(disk.state.error.reason, 'scope');
  assert.strictEqual(disk.state.checkedAt, 5);
});

test('switched off under e2e, nothing is read', async () => {
  const { sync, searched } = round({ enabled: false, results: {} });
  assert.deepStrictEqual(await sync.sync(), { ok: false, reason: 'disabled' });
  assert.deepStrictEqual(searched, []);
});

test('a request while a round runs gets that round, and no main means no round', async () => {
  const { sync, searched } = round({ results: { 1: found(['A1 » A2', 1]), 2: found() } });
  const [a, b] = await Promise.all([sync.sync(), sync.sync('requested')]);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(searched, [1, 2]);
  const noMain = round({ chosen: null, results: {} });
  assert.deepStrictEqual(await noMain.sync.sync(), { ok: false, reason: 'noMain' });
  assert.deepStrictEqual(noMain.searched, []);
});
