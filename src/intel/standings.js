'use strict';

const { ESI_BASE } = require('../app_ident');   // one base, one place — see src/shared/esi.js
//
// Turning a name in a chat channel into a standing on the contact sheet.
//
// This is what lets "a -10 is two jumps out" be an alert rather than a name
// nobody recognises. It is also the awkward join in the whole system: intel is
// written in NAMES, and every standing source — personal contacts, alliance
// contacts — is keyed by ENTITY ID.
//
// So there are two lookups chained:
//
//   name  ->  characterId     ESI /universe/ids/ (POST, up to 500 names)
//   id    ->  standing        the merged contact sheets
//
// Both are cached hard, for different reasons. Names repeat relentlessly — the
// same 2 000 reporters and hostiles appear across 12 000 messages — so an
// unbounded lookup would be thousands of redundant calls. And NEGATIVE results
// are cached too: most names in intel are line members nobody has ever set a
// standing for, and re-resolving them forever would be the bulk of the traffic.
//
// PERSONAL contacts outrank ALLIANCE ones, matching how EVE itself resolves
// standings: a pilot you have personally set to -10 is -10 to you regardless of
// what the alliance thinks.

// ESI takes up to 500 names per POST, but intel arrives in a trickle, so a
// smaller batch flushed on a short timer keeps latency down without spamming.
const BATCH_MAX = 100;
const BATCH_MS  = 1500;

// A name that resolved to nothing is unlikely to start resolving. Long TTL, but
// not infinite — new characters are created constantly.
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

const IDS_URL = `${ESI_BASE}/universe/ids/?datasource=tranquility`;

/**
 * @param {object} deps
 * @param {Function} deps.httpPost        (url, body) => parsed JSON
 * @param {Function} deps.getContactSheet () => ({ [entityId]: standing })
 */
function createStandingsResolver({ httpPost, getContactSheet } = {}) {
  const idByName = new Map();   // lowercased name -> characterId | null (miss)
  const missAt   = new Map();   // lowercased name -> ts of the miss
  const queue    = new Set();   // names awaiting resolution
  let timer = null;
  let inFlight = false;

  function sheet() {
    try { return (getContactSheet && getContactSheet()) || {}; } catch (_) { return {}; }
  }

  /**
   * Standing for a reported name, or null when unknown.
   *
   * Never blocks: if the name hasn't been resolved yet it is queued and null is
   * returned. Intel arrives continuously and the same pilot is reported many
   * times over, so the second sighting has the answer the first one queued —
   * which matters more than making the first report wait on a network call.
   */
  function standingFor(name) {
    const key = String(name || '').toLowerCase();
    if (!key) return null;
    if (idByName.has(key)) {
      const id = idByName.get(key);
      if (id == null) return null;                 // known miss
      const s = sheet()[id];
      return Number.isFinite(s) ? s : null;
    }
    // Expired miss, or never seen — queue it.
    const missed = missAt.get(key);
    if (missed && Date.now() - missed < MISS_TTL_MS) return null;
    queue.add(String(name));
    schedule();
    return null;
  }

  /** The worst standing among a set of names — what a gang is judged on. */
  function worstStanding(names) {
    let worst = null;
    for (const n of (names || [])) {
      const s = standingFor(n);
      if (Number.isFinite(s) && (worst === null || s < worst)) worst = s;
    }
    return worst;
  }

  /**
   * The same, for entities already identified by id.
   *
   * Killmails carry the attackers' corporation and alliance ids outright, so
   * this skips the whole name→id problem the rest of this file exists to solve:
   * no queue, no batch, no cache miss, and an answer on the FIRST sighting
   * rather than the second.
   */
  function worstForIds(ids) {
    const sheet_ = sheet();
    let worst = null;
    for (const id of (ids || [])) {
      const s = sheet_[id];
      if (Number.isFinite(s) && (worst === null || s < worst)) worst = s;
    }
    return worst;
  }

  function schedule() {
    if (timer || inFlight) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, BATCH_MS);
    if (timer.unref) timer.unref();
  }

  async function flush() {
    if (inFlight || !queue.size || !httpPost) return;
    const batch = [...queue].slice(0, BATCH_MAX);
    for (const n of batch) queue.delete(n);
    inFlight = true;
    try {
      const res = await httpPost(IDS_URL, batch);
      const chars = (res && res.characters) || [];
      const found = new Map(chars.map(c => [String(c.name).toLowerCase(), c.id]));
      for (const n of batch) {
        const key = String(n).toLowerCase();
        if (found.has(key)) { idByName.set(key, found.get(key)); missAt.delete(key); }
        else { idByName.set(key, null); missAt.set(key, Date.now()); }
      }
    } catch (e) {
      // Requeue nothing: a failed batch is usually a malformed name in it (ESI
      // 400s the whole POST for one bad entry), and retrying forever would jam
      // the queue behind it. They'll be re-queued naturally on the next sighting.
      console.warn('[intel] name resolution failed:', e.message);
    } finally {
      inFlight = false;
      if (queue.size) schedule();
    }
  }

  return {
    standingFor, worstStanding, worstForIds, flush,
    get resolved() { return [...idByName.values()].filter(v => v != null).length; },
    get queued()   { return queue.size; },
    /** Test seam — inject known name→id pairs without touching the network. */
    _seed(pairs) { for (const [n, id] of Object.entries(pairs)) idByName.set(n.toLowerCase(), id); },
  };
}

/**
 * Merge contact sheets into one id → standing map.
 *
 * Personal wins over alliance for the reason in the header: EVE resolves it
 * that way, and a pilot you've personally blacklisted should not be softened by
 * an alliance that hasn't got round to it.
 */
function mergeContactSheets({ alliance = {}, personal = {} } = {}) {
  const out = {};
  for (const [id, s] of Object.entries(alliance)) if (Number.isFinite(Number(s))) out[id] = Number(s);
  for (const [id, s] of Object.entries(personal)) if (Number.isFinite(Number(s))) out[id] = Number(s);
  return out;
}

module.exports = {
  createStandingsResolver, mergeContactSheets,
  BATCH_MAX, BATCH_MS, MISS_TTL_MS, IDS_URL,
};
