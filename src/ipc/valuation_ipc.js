// ─── valuation_ipc.js ─────────────────────────────────────────────────────────
// Owns the materialised assets layer: what everything is worth (Phase 1) and the
// flat, indexed table the Assets page is queried from (Phase 2).
//
// See src/asset_valuation.js for why prices come from two sources and what the
// precedence is, and src/asset_index.js for why the index materialises the
// output of the location walk rather than reimplementing it in SQL.
//
// ── Three entry points, deliberately different in cost ─────────────────────
//   refreshValuation()      prices (network) + values + index. Startup, manual.
//   rebuildFromLocalData()  values + index only. No network. After a sync.
//   scheduleRebuild()       debounced rebuildFromLocalData. What callers use.
//
// The split matters at ninety characters: a full sync completes ninety times,
// and prices do not change ninety times in ten minutes. Rebuilding against the
// prices already on disk is the cheap, correct answer.

const valuation  = require('../asset_valuation');
const assetIndex = require('../asset_index');

// Quiet period after the last asset write before the index is rebuilt. Long
// enough that a ninety-character sync coalesces into one rebuild, short enough
// that a single character's sync is reflected while the user is still looking
// at the page.
const REBUILD_DEBOUNCE_MS = 20_000;

// A sync of ninety characters takes far longer than the debounce, and each one
// restarts it — so without a ceiling the rebuild would never run until the whole
// thing finished. This is the promise that it happens anyway.
const REBUILD_MAX_WAIT_MS = 3 * 60_000;

/**
 * @param {object} deps
 * @param {Function} deps.getCharDb          () => the open character_information.db handle
 * @param {object}   deps.charInfoDb         character info DB module (for getCharacterAssets)
 * @param {Function} deps.httpGet
 * @param {Function} deps.fetchHubPrices     (typeIds, hub) => { typeId: {buy,sell} }
 * @param {Function} deps.fetchTypeMetadata  (typeIds) => { typeId: {group,category,slot,...} }
 * @param {Function} deps.loadDB             the accounts store
 * @param {string}   deps.esiBase
 */
function registerValuationHandlers({ ipcHandle, getCharDb, charInfoDb, httpGet,
                                     fetchHubPrices, fetchTypeMetadata, loadDB, esiBase }) {

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

  // Group, category, slot, meta and tech for every held type — the capital-hull
  // overrides need group + metaGroup, and the index carries the rest so the
  // renderer no longer makes a separate metadata round-trip per page load.
  async function typeMetadata(typeIds) {
    if (typeof fetchTypeMetadata !== 'function') return new Map();
    try {
      const raw = await fetchTypeMetadata(typeIds) || {};
      return new Map(Object.entries(raw).map(([id, m]) => [Number(id), m]));
    } catch (e) {
      console.warn('[valuation] type metadata lookup failed:', e.message);
      return new Map();
    }
  }

  // ── The index input: resolved rows for every character ─────────────────────
  // getCharacterAssets does the location walk, the stacking and the custom-name
  // join. Reusing it is the whole reason the index can be trusted to group
  // exactly the way the page always has.
  async function resolvedRows() {
    const accounts = Object.values(loadDB().accounts || {});
    const out = [];
    for (const acc of accounts) {
      try {
        const rows = await charInfoDb.getCharacterAssets(acc.characterId);
        if (!Array.isArray(rows)) continue;
        for (const r of rows) {
          r.characterId   = acc.characterId;
          r.characterName = acc.characterName;
          out.push(r);
        }
      } catch (e) {
        console.warn(`[valuation] asset read failed for ${acc.characterName}:`, e.message);
      }
    }
    return out;
  }

  /**
   * Rebuild values and the index from what is already on disk. No network.
   *
   * If no prices have ever been written, this cannot produce anything useful —
   * every row would be worth zero — so it escalates to a full refresh once
   * rather than quietly materialising a portfolio worth nothing.
   */
  async function rebuildFromLocalData({ allowPriceFetch = true } = {}) {
    const db = getCharDb();
    if (!db) return { ok: false, error: 'character database not open' };

    await valuation.ensureValuationTables(db);
    const priced = (await db.get('SELECT COUNT(*) c FROM type_prices')).c || 0;
    if (!priced && allowPriceFetch) {
      console.log('[valuation] no prices on disk yet — running a full refresh instead');
      return refreshValuation();
    }

    const started = Date.now();
    const built = await valuation.rebuildAssetValues(db);

    const rows = await resolvedRows();
    const typeIds = [...new Set(rows.map(r => Number(r.type_id)).filter(Boolean))];
    const meta = await typeMetadata(typeIds);
    const idx = await assetIndex.rebuildAssetIndex(db, rows, meta);

    const result = {
      ok: true, ms: Date.now() - started,
      items: built.items, containers: built.containers,
      indexRows: idx.rows, groups: idx.groups,
    };
    console.log(`[valuation] rebuilt ${result.indexRows.toLocaleString()} indexed rows ` +
                `across ${result.groups} location(s) in ${result.ms} ms`);
    return result;
  }

  /**
   * Refresh prices and rebuild everything.
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
    const meta = await typeMetadata([...held.keys()]);

    const resolved = valuation.resolveUnitValues({ ccp, market, meta });
    await valuation.writeTypePrices(db, resolved);

    const bySource = {};
    for (const { source } of resolved.values()) bySource[source] = (bySource[source] || 0) + 1;

    // allowPriceFetch:false — prices were just written; escalating again here
    // would recurse.
    const rebuilt = await rebuildFromLocalData({ allowPriceFetch: false });

    const result = {
      ok: true, ms: Date.now() - started,
      types: resolved.size, refined: refine.length,
      items: rebuilt.items, containers: rebuilt.containers,
      indexRows: rebuilt.indexRows, groups: rebuilt.groups,
      bySource,
    };
    console.log(`[valuation] ${result.items} items, ${result.types} types ` +
                `(${result.refined} refined) in ${result.ms} ms`, bySource);
    return result;
  }

  // ── Debounced rebuild ──────────────────────────────────────────────────────
  // Called once per character whose assets were just written. Ninety of those
  // must produce one rebuild, not ninety — each is a full pass over every asset
  // in the database, and running them back to back would keep the disk busy for
  // the entire sync while showing the user nothing new.

  let timer = null;
  // null, not 0. A timestamp is a value where zero is legitimate, so testing it
  // for truthiness conflates "never set" with "set at epoch" — the same defect
  // as the refusedAt check that treated a real timestamp of 0 as absent. Here it
  // meant the ceiling below could never trip, because firstRequestAt was reset
  // on every call instead of held from the first one.
  let firstRequestAt = null;
  let running = false;
  let queuedWhileRunning = false;

  async function runRebuild() {
    if (running) { queuedWhileRunning = true; return; }
    running = true;
    timer = null;
    firstRequestAt = null;
    try {
      await rebuildFromLocalData();
    } catch (e) {
      console.warn('[valuation] scheduled rebuild failed:', e.message);
    } finally {
      running = false;
      if (queuedWhileRunning) {
        queuedWhileRunning = false;
        scheduleRebuild('changes arrived mid-rebuild');
      }
    }
  }

  function scheduleRebuild(reason = '') {
    const now = Date.now();
    if (firstRequestAt === null) firstRequestAt = now;

    // Past the ceiling, stop deferring: a long sync must not postpone the
    // rebuild indefinitely just by continuing to make progress.
    if (now - firstRequestAt >= REBUILD_MAX_WAIT_MS) {
      if (timer) clearTimeout(timer);
      runRebuild();
      return;
    }

    if (timer) clearTimeout(timer);
    timer = setTimeout(runRebuild, REBUILD_DEBOUNCE_MS);
    if (timer.unref) timer.unref();   // never hold the process open on its own
    if (reason) console.log(`[valuation] rebuild scheduled (${reason})`);
  }

  // ── IPC ────────────────────────────────────────────────────────────────────

  ipcHandle('valuation-refresh', async (_, opts) => refreshValuation(opts || {}));
  ipcHandle('valuation-rebuild', async () => rebuildFromLocalData());

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

  // ── The Assets page's query API ────────────────────────────────────────────
  // One handler per view. Each returns only what is on screen; none of them can
  // return the whole portfolio.

  const withDb = (fn, fallback) => async (...args) => {
    const db = getCharDb();
    if (!db) return fallback;
    try { return await fn(db, ...args); }
    catch (e) { console.warn('[assets] query failed:', e.message); return fallback; }
  };

  ipcHandle('assets-filter-options', withDb(
    (db) => assetIndex.getFilterOptions(db),
    { characters: [], regions: [], corps: [], unresolvedCount: 0 }));

  ipcHandle('assets-summary', withDb(
    (db, _e, filters) => assetIndex.getSummary(db, filters),
    { rows: 0, characters: 0, value: 0, totalRows: 0, filtered: false }));

  ipcHandle('assets-location-groups', withDb(
    (db, _e, filters, sort) => assetIndex.getLocationGroups(db, filters, sort), []));

  ipcHandle('assets-group-characters', withDb(
    (db, _e, locKey, filters, sort) => assetIndex.getGroupCharacters(db, locKey, filters, sort), []));

  ipcHandle('assets-group-items', withDb(
    (db, _e, locKey, characterId, filters, sort) =>
      assetIndex.getGroupItems(db, locKey, characterId, filters, sort),
    { rows: [], total: 0, truncated: false }));

  ipcHandle('assets-top-items', withDb(
    (db, _e, opts) => assetIndex.getTopItems(db, opts || {}), []));

  // Kept for the dashboard's top-kills-style widgets, which rank raw items.
  ipcHandle('valuation-top-assets', withDb(
    (db, _e, opts) => valuation.getTopAssetsByValue(db, opts || {}), []));

  return { refreshValuation, rebuildFromLocalData, scheduleRebuild };
}

module.exports = { registerValuationHandlers, REBUILD_DEBOUNCE_MS, REBUILD_MAX_WAIT_MS };
