// ─── valuation_ipc.js ─────────────────────────────────────────────────────────
// Refreshes the materialised asset valuation and exposes the queries it makes
// possible. See src/asset_valuation.js for why prices come from two sources and
// what the precedence is.
//
// Phase 1 of the assets rework (TODO.md): the value moves into the database. No
// UI change yet — but net worth becomes one query instead of a 100,000-row walk
// in the renderer, and prices stop vanishing on restart.

const { ipcMain } = require('electron');
const valuation = require('../asset_valuation');

/**
 * @param {object} deps
 * @param {Function} deps.getCharDb     () => the open character_information.db handle
 * @param {Function} deps.getSdeDb      () => the open SDE handle
 * @param {Function} deps.httpGet
 * @param {Function} deps.fetchHubPrices (typeIds, hub) => { typeId: {buy,sell} }
 * @param {Function} deps.loadDB        the accounts store
 * @param {string}   deps.esiBase
 */
function registerValuationHandlers({ ipcHandle, getCharDb, getSdeDb, httpGet,
                                     fetchHubPrices, loadDB, esiBase }) {

  // Every type held across every character, with total quantity — the input to
  // deciding which types are worth a real market lookup.
  async function heldQuantities(db) {
    const tables = (await db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'char\\_%\\_assets' ESCAPE '\\'"
    )).map(r => r.name);
    const held = new Map();
    for (const tn of tables) {
      const rows = await db.all(
        `SELECT type_id, SUM(COALESCE(quantity, 1)) q FROM ${tn}
          WHERE type_id IS NOT NULL GROUP BY type_id`);
      for (const r of rows) held.set(r.type_id, (held.get(r.type_id) || 0) + r.q);
    }
    return held;
  }

  // Group and metaGroup for the capital-hull overrides. Straight from the
  // bundled SDE — no network, and the only thing that can tell a Titan from a
  // shuttle before any price has loaded.
  async function typeMeta(typeIds) {
    const sde = getSdeDb();
    const out = new Map();
    if (!sde || !typeIds.length) return out;
    for (let i = 0; i < typeIds.length; i += 500) {
      const chunk = typeIds.slice(i, i + 500);
      const ph = chunk.map(() => '?').join(',');
      try {
        // metaGroupID lives in invMetaTypes, NOT on invTypes — assuming otherwise
        // threw "no such column: t.metaGroupID" on every chunk, which silently
        // left the hull overrides with no group to match and handed every
        // supercapital back to whatever stray market order was up.
        const rows = await sde.all(
          `SELECT t.typeID id, g.groupName grp, m.metaGroupID meta
             FROM invTypes t
             LEFT JOIN invGroups   g ON g.groupID = t.groupID
             LEFT JOIN invMetaTypes m ON m.typeID = t.typeID
            WHERE t.typeID IN (${ph})`, ...chunk);
        for (const r of rows) out.set(r.id, { group: r.grp, metaGroup: r.meta });
      } catch (e) {
        console.warn('[valuation] SDE metadata lookup failed:', e.message);
      }
    }
    return out;
  }

  /**
   * Refresh prices and rebuild the materialised values.
   *
   * Deliberately ordered cheapest-first: one CCP call covers everything, then a
   * single Fuzzwork batch refines only the types that carry the value. On a real
   * profile that is 1 + 1 calls where the old renderer path made 10.
   */
  async function refreshValuation({ refineLimit } = {}) {
    const db = getCharDb();
    if (!db) return { ok: false, error: 'character database not open' };

    const started = Date.now();
    const held = await heldQuantities(db);
    if (!held.size) return { ok: true, types: 0, items: 0, note: 'no assets' };

    // 1. CCP baseline — one call for every type in the game.
    const ccp = new Map();
    try {
      const data = await httpGet(`${esiBase}/markets/prices/?datasource=tranquility`);
      if (Array.isArray(data)) {
        for (const e of data) {
          const v = e.adjusted_price || e.average_price || 0;
          if (v > 0) ccp.set(e.type_id, v);
        }
      }
    } catch (e) {
      console.warn('[valuation] CCP price map unavailable:', e.message);
    }

    // 2. Real market prices for the types that actually carry the value.
    const refine = valuation.selectTypesToRefine(held, ccp, refineLimit);
    const market = new Map();
    try {
      const hub = await fetchHubPrices(refine, 'jita');
      for (const [typeId, p] of Object.entries(hub || {})) {
        const v = Number(p?.sell) || Number(p?.buy) || 0;
        if (v > 0) market.set(Number(typeId), v);
      }
    } catch (e) {
      console.warn('[valuation] market refinement failed:', e.message);
    }

    // 3. Hull overrides for what neither source can price.
    const meta = await typeMeta([...held.keys()]);

    const resolved = valuation.resolveUnitValues({ ccp, market, meta });
    await valuation.writeTypePrices(db, resolved);
    const built = await valuation.rebuildAssetValues(db);

    const bySource = {};
    for (const { source } of resolved.values()) bySource[source] = (bySource[source] || 0) + 1;

    const result = {
      ok: true, ms: Date.now() - started,
      types: resolved.size, refined: refine.length,
      items: built.items, containers: built.containers, bySource,
    };
    console.log(`[valuation] ${result.items} items, ${result.types} types ` +
                `(${result.refined} refined) in ${result.ms} ms`, bySource);
    return result;
  }

  ipcHandle('valuation-refresh', async (_, opts) => refreshValuation(opts || {}));

  ipcHandle('valuation-top-assets', async (_, opts = {}) => {
    const db = getCharDb();
    if (!db) return [];
    return valuation.getTopAssetsByValue(db, opts).catch(() => []);
  });

  ipcHandle('valuation-net-worth', async (_, characterId = null) => {
    const db = getCharDb();
    if (!db) return 0;
    return valuation.getAssetNetWorth(db, characterId).catch(() => 0);
  });

  ipcHandle('valuation-meta', async () => {
    const db = getCharDb();
    if (!db) return {};
    return valuation.getValuationMeta(db).catch(() => ({}));
  });

  return { refreshValuation };
}

module.exports = { registerValuationHandlers };
