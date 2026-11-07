// jump_gates_ipc.js — the pilot's jump gates, kept up to date from ESI.
//
// Every Ansiblex is named after the two systems it joins, "1DQ1-A » 8QT-H4 -
// Speedway". A character's structure search for " » " therefore finds the gates
// its alliance lets it use, and reading each one gives its name and the system it
// stands in. That works for any alliance and never goes out of date, unlike a
// pasted list.
//
// Once an hour (ESI caches both the search and a structure for 3600 s), and when
// the pilot allows a character or picks another, every character allowed to
// search is read:
//   • the picked character's gates are ours: the planner routes through them,
//     and the map draws them green;
//   • gates only the pilot's other characters can see (an alt or a scout in
//     another alliance) are theirs: drawn red and dashed, never routed through.
//     A hunter can see where a target's bridge comes out ahead of them.
// Each round folds into the two saved networks (JumpGateList.applyEsiRound): a
// gate ESI stops reporting comes out, while a pasted one stays.
//
// The search needs esi-search.search_structures.v1. The app asks for it only when
// the pilot presses "Allow a character" on the Jump Gates tab (OPTIONAL_SCOPES in
// accounts_ipc.js): asking on every login would make the whole roster sign in
// again, and a login asking for a scope the app isn't registered for fails
// outright. Reading a structure uses read_structures, which every login has.
//
// Search wants three characters at least, hence " » " rather than "»". Names
// already in the locator's structure cache are used as they are, and each one
// read here goes back into that cache for the locator.

const JumpGateList = require('../shared/jump_gate_list');

const SEARCH_SCOPE     = 'esi-search.search_structures.v1';
const ANSIBLEX_TYPE_ID = 35841;     // "Ansiblex Jump Bridge", group 1408 (Upwell Jump Bridge); checked in the SDE 2026-11-06
const MAX_STRUCTURES   = 2000;      // a coalition's network is a few hundred structures
const MIN_BUDGET       = 20;        // stop while ESI's error budget still has room for everything else
const WORKERS          = 4;         // as many at once as the other many-request jobs use
const HOUR             = 3_600_000; // ESI's cache time for the search and for a structure
const FIRST_READ_MS    = 90_000;    // after launch, once the startup syncs have had their turn

/**
 * One character's search, with everything it touches passed in so it can be
 * tested without Electron or the network.
 *
 * search(characterId, { onProgress }) answers
 *   { ok: true, characterName, total, gates: [{ structureId, name, systemId }],
 *     failed, notGates, stoppedEarly }
 * or { ok: false, reason: 'unknown' | 'reauth' | 'scope' | 'error', message? }.
 */
function createJumpGateSearch({ loadDB, getValidToken, decodeTokenScopes, httpGet, esiAuthHeaders,
                                esiBudget, readCache, writeCache, ESI_BASE }) {

  function hasSearchScope(scopes) {
    // A token that can't be read (demo mode's stand-in) isn't refused here; ESI
    // has the last word.
    return !Array.isArray(scopes) || scopes.includes(SEARCH_SCOPE);
  }

  /** Every character, and whether it can search, from the stored token alone (no network). */
  function characters() {
    return Object.values((loadDB().accounts) || {}).map(a => ({
      characterId:   a.characterId,
      characterName: a.characterName,
      needsReauth:   !!a.needsReauth,
      canSearch:     !a.needsReauth && hasSearchScope(decodeTokenScopes(a.accessToken)),
    }));
  }

  async function readGate(id, headers) {
    const cacheKey = `struct_name_${id}`;            // the locator's key and shape
    const cached = readCache(cacheKey);
    if (cached && cached.name && cached.solar_system_id) {
      if (cached.type_id && cached.type_id !== ANSIBLEX_TYPE_ID) return 'notGate';
      return { structureId: id, name: cached.name, systemId: cached.solar_system_id };
    }
    const data = await httpGet(`${ESI_BASE}/universe/structures/${id}/?datasource=tranquility`, headers);
    if (!data || !data.name) return null;
    writeCache(cacheKey, { name: data.name, solar_system_id: data.solar_system_id || null,
                           owner_id: data.owner_id || null, type_id: data.type_id || null }, 7);
    if (data.type_id && data.type_id !== ANSIBLEX_TYPE_ID) return 'notGate';
    return { structureId: id, name: data.name, systemId: data.solar_system_id || null };
  }

  async function search(characterId, { onProgress } = {}) {
    const account = ((loadDB().accounts) || {})[characterId];
    if (!account) return { ok: false, reason: 'unknown' };
    if (account.needsReauth) return { ok: false, reason: 'reauth' };

    let token;
    try { token = await getValidToken(String(characterId)); }
    catch (e) { return { ok: false, reason: e && e.needsReauth ? 'reauth' : 'error', message: e && e.message }; }
    if (!hasSearchScope(decodeTokenScopes(token))) return { ok: false, reason: 'scope' };
    const headers = esiAuthHeaders(token);

    let found;
    try {
      found = await httpGet(`${ESI_BASE}/characters/${characterId}/search/?datasource=tranquility`
        + `&categories=structure&search=${encodeURIComponent(' » ')}`, headers);
    } catch (e) {
      const message = (e && e.message) || String(e);
      return { ok: false, reason: /HTTP 403/.test(message) ? 'scope' : 'error', message };
    }
    const ids = [...new Set(((found && found.structure) || []).map(Number).filter(Boolean))].slice(0, MAX_STRUCTURES);

    const gates = [];
    let failed = 0, notGates = 0, done = 0, stoppedEarly = false;
    const report = () => { if (onProgress) try { onProgress({ done, total: ids.length }); } catch (_) {} };
    report();

    const queue = ids.slice();
    const worker = async () => {
      while (queue.length && !stoppedEarly) {
        const budget = esiBudget();
        if (budget.blockedFor > 0 || budget.remain < MIN_BUDGET) { stoppedEarly = true; return; }
        const id = queue.shift();
        try {
          const g = await readGate(id, headers);
          if (g === 'notGate') notGates++;
          else if (g) gates.push(g);
          else failed++;
        } catch (_) { failed++; }
        done++;
        if (done % 10 === 0 || done === ids.length) report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, ids.length) }, worker));

    return { ok: true, characterName: account.characterName, total: ids.length,
             gates, failed, notGates, stoppedEarly };
  }

  return { characters, search };
}

/**
 * The hourly read and what it saves, again with its world passed in.
 *
 *   gates        createJumpGateSearch()
 *   loadConfig / saveConfig   app.jumpGates.characterId: whose gates are ours
 *   systemIndex  async () => { lower-case system name: id }
 *   store        { loadFriendly, saveFriendly, loadOther, saveOther, loadState, saveState }
 *   broadcast    (channel, payload) to every window
 *   enabled      false under e2e: nothing is read, so no test reaches ESI
 */
function createJumpGateSync({ gates, loadConfig, saveConfig, systemIndex, store, broadcast = () => {},
                              enabled = true, now = () => Date.now() }) {
  let running = null, firstTimer = null, hourly = null;
  const same = (a, b) => a != null && b != null && String(a) === String(b);
  const chosenId = () => { try { return (loadConfig() || {}).app?.jumpGates?.characterId ?? null; } catch (_) { return null; } };
  const pick = (able) => able.find(c => same(c.characterId, chosenId())) || able[0] || null;

  /** Who may search, whose gates are ours, and how the last read went. */
  function status() {
    const characters = gates.characters();
    const chosen = pick(characters.filter(c => c.canSearch));
    const s = store.loadState() || {};
    return {
      enabled, running: !!running, characters,
      characterId: chosen ? chosen.characterId : null,
      checkedAt: s.checkedAt || null, characterName: s.characterName || null,
      mine: s.counts ? s.counts.mine : null, theirs: s.counts ? s.counts.theirs : null,
      complete: s.complete !== false, error: s.error || null,
    };
  }

  /** Whose gates are ours from now on; read straight away. */
  function setCharacter(characterId) {
    const cfg = loadConfig() || {};
    cfg.app = cfg.app || {};
    cfg.app.jumpGates = { ...(cfg.app.jumpGates || {}), characterId: characterId == null ? null : String(characterId) };
    saveConfig(cfg);
    return sync('character');
  }

  function sync(reason = 'schedule') {
    if (!enabled) return Promise.resolve({ ok: false, reason: 'disabled' });
    if (running) return running;
    running = (async () => {
      const able = gates.characters().filter(c => c.canSearch);
      if (!able.length) return { ok: false, reason: 'noCharacter' };
      const chosen = pick(able);
      const index = await systemIndex();
      if (!index || !Object.keys(index).length) return { ok: false, reason: 'noGalaxy' };

      let mine = null, mineFailure = null, complete = true, stoppedEarly = false;
      const theirs = [];
      for (const c of [chosen, ...able.filter(x => x !== chosen)]) {
        const r = await gates.search(c.characterId, {
          onProgress: (p) => broadcast('jump-gates-esi-progress', { ...p, characterName: c.characterName }),
        });
        if (!r.ok) { complete = false; if (c === chosen) mineFailure = r; continue; }
        if (r.stoppedEarly || r.failed) complete = false;
        const { pairs } = JumpGateList.gatePairs(r.gates, index);
        if (c === chosen) mine = pairs;
        else theirs.push(...pairs);
        if (r.stoppedEarly) { stoppedEarly = true; break; }
      }

      if (!mine) {
        // Ours couldn't be read: keep the networks as they are and say why.
        const failure = { reason: (mineFailure && mineFailure.reason) || 'error', message: (mineFailure && mineFailure.message) || null };
        store.saveState({ ...(store.loadState() || {}), error: { ...failure, at: now() } });
        const out = { ok: false, ...failure, characterName: chosen.characterName };
        broadcast('jump-gates-updated', out);
        return out;
      }

      const prev = store.loadState() || {};
      const res = JumpGateList.applyEsiRound({
        friendly: store.loadFriendly(), other: store.loadOther(),
        last: { mine: prev.mine, theirs: prev.theirs }, mine, theirs, complete,
      });
      store.saveFriendly(res.friendly);
      store.saveOther(res.other);
      const mineKeys = new Set(mine.map(([a, b]) => JumpGateList.pairKey(a, b)));
      const theirsCount = new Set(theirs.map(([a, b]) => JumpGateList.pairKey(a, b)).filter(k => !mineKeys.has(k))).size;
      const checkedAt = now();
      store.saveState({
        characterId: String(chosen.characterId), characterName: chosen.characterName, checkedAt,
        mine: res.last.mine, theirs: res.last.theirs,
        counts: { mine: mine.length, theirs: theirsCount }, complete, stoppedEarly, error: null,
      });
      const out = { ok: true, reason, characterName: chosen.characterName, mine: mine.length, theirs: theirsCount,
                    added: res.added, removed: res.removed, otherAdded: res.otherAdded, otherRemoved: res.otherRemoved,
                    complete, stoppedEarly, checkedAt };
      broadcast('jump-gates-updated', out);
      return out;
    })()
      .catch(e => ({ ok: false, reason: 'error', message: e && e.message }))
      .finally(() => { running = null; });
    return running;
  }

  /** The first read shortly after launch, then one an hour. */
  function start({ firstDelayMs = FIRST_READ_MS, intervalMs = HOUR } = {}) {
    if (!enabled || hourly) return;
    firstTimer = setTimeout(() => sync('startup'), firstDelayMs);
    hourly = setInterval(() => sync('schedule'), intervalMs);
    if (firstTimer.unref) firstTimer.unref();
    if (hourly.unref) hourly.unref();
  }
  function stop() { clearTimeout(firstTimer); clearInterval(hourly); firstTimer = hourly = null; }

  return { status, setCharacter, sync, start, stop };
}

function registerJumpGateHandlers(deps) {
  const { ipcHandle, store } = deps;
  const gates = createJumpGateSearch(deps);
  const sync = createJumpGateSync({ ...deps, gates });
  ipcHandle('jump-gates-esi-status', () => sync.status());
  ipcHandle('jump-gates-esi-set-character', (_e, characterId) => sync.setCharacter(characterId));
  ipcHandle('jump-gates-esi-sync', () => sync.sync('requested'));
  // Other alliances' gates: from the hourly read, and from pasted rows marked
  // not friendly. The map draws them; nothing routes through them.
  ipcHandle('get-jump-bridges-other', () => store.loadOther());
  ipcHandle('save-jump-bridges-other', (_e, arr) => {
    try { store.saveOther(Array.isArray(arr) ? arr : []); return { ok: true, count: Array.isArray(arr) ? arr.length : 0 }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  return sync;
}

module.exports = { createJumpGateSearch, createJumpGateSync, registerJumpGateHandlers, SEARCH_SCOPE, ANSIBLEX_TYPE_ID };
