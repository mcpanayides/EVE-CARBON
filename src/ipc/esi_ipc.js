const { APP_USER_AGENT, ESI_BASE } = require('../app_ident');   // ESI_BASE: one definition, src/shared/esi.js
const demoMode = require('../demo_mode');   // demo mode answers some ESI routes locally — see esi-fetch below
﻿const { ipcMain } = require('electron');

const FUZZWORK_BASE = 'https://www.fuzzwork.co.uk';

// ─── Fuzzwork blueprint API ───────────────────────────────────────────────────
// The endpoint is https://www.fuzzwork.co.uk/blueprint/api/blueprint.php?typeid=N
//
// It was previously called as /api/blueprint.php (no /blueprint prefix) with
// &runs=1&me=0&pe=0 appended. That path does not exist, so EVERY call 404'd —
// and because the SDE is only the *primary* source, an install without the SDE
// downloaded fell through to this for every blueprint and every component in a
// tree. Fuzzwork's operator got in touch about the volume of 404s; this is a
// free service run by one person, and we were the ones being rude.
//
// The parameters were meaningless too: the API returns BASE quantities and has
// no notion of runs, ME or PE. The ME maths already happens on our side
// (applyMEBonus in src/func/blueprints.js), so nothing is lost by dropping them.
//
// The response is NOT { materials: [...] } — it nests them per activity:
//   { requestedid, blueprintDetails: { productTypeID, productTypeName,
//     productQuantity, ... }, activityMaterials: { "1": [{typeid,name,quantity}],
//     "8": [...] }, blueprintSkills, decryptors }
// Activity 1 is manufacturing, 11 is reactions, 8 is invention. So even with the
// path corrected, reading `data.materials` would have found nothing.
const FUZZWORK_BLUEPRINT_URL = (typeId) =>
  `${FUZZWORK_BASE}/blueprint/api/blueprint.php?typeid=${typeId}`;

// Politeness, since this is somebody's free service: after this many consecutive
// failures, stop asking for a while rather than turning an outage on their end
// into a retry storm from ours.
const FUZZWORK_TRIP_AFTER = 5;
const FUZZWORK_TRIP_MS    = 30 * 60 * 1000;
let _fuzzFails = 0;
let _fuzzMuteUntil = 0;

/** Fuzzwork's shape -> ours, or null when it has nothing usable. */
function _fuzzworkMaterials(data, typeId) {
  const acts = data && data.activityMaterials;
  if (!acts || typeof acts !== 'object') return null;
  // Manufacturing first, then reactions. Invention (8) is not a build recipe.
  const rows = Array.isArray(acts['1']) && acts['1'].length ? acts['1']
             : Array.isArray(acts['11']) && acts['11'].length ? acts['11']
             : null;
  if (!rows) return null;
  const d = data.blueprintDetails || {};
  return {
    materials: rows
      .filter(m => m && m.typeid != null)
      .map(m => ({ typeid: m.typeid, quantity: m.quantity, name: m.name || `Type ${m.typeid}` })),
    blueprintTypeID: typeId,
    // The old call returned no product info at all; it comes free here.
    productTypeID:   d.productTypeID   ?? null,
    productTypeName: d.productTypeName ?? null,
    productQuantity: d.productQuantity ?? 1,
  };
}

async function fetchFuzzworkBlueprint(typeId, httpGet) {
  if (Date.now() < _fuzzMuteUntil) return null;
  try {
    const data = await httpGet(FUZZWORK_BLUEPRINT_URL(typeId));
    _fuzzFails = 0;
    return _fuzzworkMaterials(data, typeId);
  } catch (e) {
    if (++_fuzzFails >= FUZZWORK_TRIP_AFTER) {
      _fuzzMuteUntil = Date.now() + FUZZWORK_TRIP_MS;
      _fuzzFails = 0;
      console.warn(`[fuzzwork] ${FUZZWORK_TRIP_AFTER} consecutive failures (${e.message}) — ` +
                   `standing down for ${Math.round(FUZZWORK_TRIP_MS / 60000)} min.`);
    }
    return null;
  }
}

// Curated high-traffic market staples for the bottom ticker (minerals, PLEX/skill
// tokens, fuel blocks, popular hulls, ore). Type IDs resolved from the SDE.
const TICKER_TYPE_IDS = [
  34, 35, 36, 37, 38, 39, 40, 11399,                 // minerals
  44992, 40520, 45635, 40519,                        // PLEX + skill tokens
  4051, 4246, 4247, 4312,                            // fuel blocks
  17738, 17736, 17918, 17920, 17740, 33820, 33472,   // pirate battleships
  638, 641, 645, 642, 24692, 24688, 24694, 24690, 639, 643, // T1 battleships
  24698, 24702, 16229, 24700, 24696, 16227,          // battlecruisers
  621, 626, 623, 624, 622, 629, 17715, 12005, 11993, // cruisers
  587, 603, 593, 16240, 16236, 32872, 16238,         // frigates / destroyers
  1230, 1228, 18, 28668,                             // ore + nanite paste
];

/**
 * registerEsiHandlers
 *
 * @param {object} deps
 * @param {function} deps.httpGet      - unauthenticated HTTP GET helper
 * @param {function} deps.httpPost     - HTTP POST helper
 * @param {function} deps.resolveNames - resolves an array of ids -> { id: name } map
 * @param {function} deps.readCache    - reads from persistent cache
 * @param {function} deps.writeCache   - writes to persistent cache
 * @param {function} deps.getLocator   - returns the shared locator instance
 * @param {object}   deps.bpCache      - shared in-memory blueprint cache object
 * @param {function} deps.getSdeDb    - getter returning the live SDE SQLite db instance (or null)
 */
function registerEsiHandlers({
  ipcHandle,
  httpGet,
  httpPost,
  resolveNames,
  readCache,
  writeCache,
  getLocator,
  bpCache,
  getSdeDb,
}) {

  // ─── IPC: Generic ESI proxy (unauthenticated) ─────────────────────────────
  // options.method/'body' let callers hit POST-only routes (e.g. the new
  // /route/ endpoint — see cost-index.js) through the same gated/identified
  // path as everything else, without every call site needing its own POST
  // plumbing. Omit options (or pass a GET) for the original bare-URL behaviour.
  ipcHandle('esi-fetch', async (_, url, options) => {
    // In demo mode the cast are character ids that do not exist and there are no
    // tokens, so Mail, Notifications and Calendar would render empty — the half
    // of the app most worth showing. Answer those routes locally instead.
    // `undefined` means "no fixture", which is distinct from a fixture of null.
    if (demoMode.isEnabled()) {
      const canned = require('../demo_fixtures').match(url);
      if (canned !== undefined) return canned;
    }
    if (options?.method === 'POST') return httpPost(url, options.body ?? {});
    return httpGet(url);
  });

  // ─── IPC: Raw-text HTTP GET (follows redirects) ──────────────────────────
  // Used to pull a published Google Sheet as CSV — renderer fetch() is blocked
  // by Google's missing CORS headers, and httpGet() JSON-parses. Only https.
  ipcHandle('http-get-text', async (_, url) => {
    const https = require('https');
    const fetchText = (u, redirects = 0) => new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      if (!/^https:\/\//i.test(u)) return reject(new Error('Only https URLs are allowed'));
      const req = https.request(u, {
        headers: { 'User-Agent': APP_USER_AGENT, 'Accept': 'text/csv,text/plain,*/*' }
      }, (res) => {
        // Follow 3xx redirects (Google export → googleusercontent)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return resolve(fetchText(next, redirects + 1));
        }
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
    return fetchText(url);
  });

  // The public ESI /search/ endpoint is GONE — it is absent from
  // /meta/openapi.json at our pinned date; only the authenticated
  // /characters/{id}/search remains. The handler that called it was orphaned
  // anyway (exposed on preload as eveAPI.search, called by nothing), so it was
  // removed rather than repointed. Type search is served locally from the SDE —
  // see sde-type-search further down.

  // Batched blueprint → manufactured product lookup (LP store optimiser values
  // BPC offers by what they build). activityID 1 = manufacturing; `quantity` is
  // units produced per run. Returns { "<blueprintTypeId>": { product, qty } }.
  ipcHandle('sde-products-for-blueprints', async (_, blueprintTypeIds) => {
    const sdeDb = getSdeDb();
    if (!sdeDb || !Array.isArray(blueprintTypeIds) || !blueprintTypeIds.length) return {};
    const ids = [...new Set(blueprintTypeIds.map(Number).filter(Boolean))];
    const out = {};
    const CHUNK = 400;
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const rows = await sdeDb.all(
          `SELECT typeID AS bp, productTypeID AS product, quantity AS qty
             FROM industryActivityProducts
            WHERE activityID = 1 AND typeID IN (${slice.map(() => '?').join(',')})`,
          slice,
        );
        (rows || []).forEach(r => { if (r.product) out[r.bp] = { product: r.product, qty: r.qty || 1 }; });
      }
      return out;
    } catch (e) {
      console.warn('sde-products-for-blueprints failed:', e.message);
      return out;
    }
  });

  // ─── IPC: LP store offers for a corporation (public, no auth) ────────────
  // Powers the LP Store optimiser. Offers change rarely, so cache 6h with a long
  // stale fallback. Each offer: { offer_id, type_id, quantity, lp_cost, isk_cost,
  // required_items:[{type_id, quantity}] }.
  ipcHandle('lp-get-offers', async (_, corpId) => {
    if (!corpId) return [];
    const cacheKey = `lp_offers_${corpId}`;
    const cached   = readCache(cacheKey);
    if (cached) return cached;
    try {
      const offers = await httpGet(`${ESI_BASE}/loyalty/stores/${corpId}/offers/?datasource=tranquility`);
      const rows = (Array.isArray(offers) ? offers : []).map(o => ({
        offerId:  o.offer_id,
        typeId:   o.type_id,
        quantity: o.quantity || 1,
        lpCost:   o.lp_cost || 0,
        iskCost:  o.isk_cost || 0,
        required: (o.required_items || []).map(r => ({ typeId: r.type_id, quantity: r.quantity })),
      }));
      writeCache(cacheKey, rows, 0.25);          // 6-hour cache
      writeCache(`${cacheKey}_stale`, rows, 30); // 30-day stale fallback
      return rows;
    } catch (e) {
      const stale = readCache(`${cacheKey}_stale`);
      if (stale) return stale;
      console.warn(`lp-get-offers failed for ${corpId}:`, e.message);
      return [];
    }
  });

  // ─── IPC: ESI bulk name resolution ───────────────────────────────────────
  ipcHandle('esi-names', async (_, ids) => {
    if (!ids || !ids.length) return [];
    const map = await resolveNames(ids);
    return ids.map(id => ({ id, name: map[id] || `Type ${id}` }));
  });

  // ─── IPC: Global market prices (adjusted / average) ──────────────────────
  // Single public endpoint — no auth. Returns all tradeable items at once.
  // This is the same price source EVE uses for net worth calculations.
  // Cache aggressively: prices update ~daily.
  ipcHandle('get-market-prices', async () => {
    const cacheKey = 'market_prices_global';
    const cached   = readCache(cacheKey);
    if (cached) return cached;
    try {
      const data = await httpGet(`${ESI_BASE}/markets/prices/?datasource=tranquility`);
      // Convert array to map keyed by type_id for O(1) lookup
      const map = {};
      if (Array.isArray(data)) {
        data.forEach(item => {
          map[item.type_id] = {
            adjusted: item.adjusted_price || 0,
            average:  item.average_price  || 0,
          };
        });
      }
      // Only cache a non-empty map. An empty result here would otherwise stick for
      // 12 h and value every asset at 0.
      if (Object.keys(map).length) {
        writeCache(cacheKey, map, 0.5);          // 12-hour fresh cache
        writeCache(`${cacheKey}_stale`, map, 30); // 30-day stale fallback for rate-limits
      }
      return map;
    } catch (e) {
      // This call competes in the cold-start ESI burst and is easily rate-limited
      // (429/420). Returning {} would value every asset at 0, so fall back to the
      // last known price map when we have one.
      console.warn('get-market-prices failed:', e.message);
      const stale = readCache(`${cacheKey}_stale`);
      if (stale) return stale;
      return {};
    }
  });

  // ─── IPC: Market ticker — top movers among curated staples ───────────────
  // Day-over-day Jita average-price move per type (ESI market history). Per-type
  // moves cache 12h; the assembled top-50 payload caches 1h. Powers the bottom bar.
  async function _typeDailyMovePct(typeId) {
    const cacheKey = `mkt_move_${typeId}`;
    const cached   = readCache(cacheKey);
    if (cached) return cached.pct;          // may be null (no history) — still cached
    let pct = null;
    try {
      const hist = await httpGet(`${ESI_BASE}/markets/10000002/history/?type_id=${typeId}&datasource=tranquility`);
      if (Array.isArray(hist) && hist.length >= 2) {
        const today = Number(hist[hist.length - 1].average);
        const prev  = Number(hist[hist.length - 2].average);
        if (today > 0 && prev > 0) pct = ((today - prev) / prev) * 100;
      }
    } catch (_) { /* leave null */ }
    // Cache a real move for 12h; cache a miss for only 1h so a rate-limited fetch
    // retries soon instead of leaving the item flat for half a day.
    writeCache(cacheKey, { pct }, pct != null ? 0.5 : (1 / 24));
    return pct;
  }

  ipcHandle('get-market-movers', async () => {
    const cacheKey = 'market_movers';
    const cached   = readCache(cacheKey);
    if (cached) return cached;
    try {
      const ids     = TICKER_TYPE_IDS;
      const prices  = await fetchHubPrices(ids, 'jita');      // { id: { buy, sell } }
      const nameMap = await resolveNames(ids);                // { id: name }

      // Per-type history with limited concurrency so we don't hammer ESI.
      const pcts = {};
      const CONC = 6;
      for (let i = 0; i < ids.length; i += CONC) {
        const chunk = ids.slice(i, i + CONC);
        const res   = await Promise.all(chunk.map(id => _typeDailyMovePct(id)));
        chunk.forEach((id, j) => { pcts[id] = res[j]; });
      }

      // Keep any item we have a price for; unknown movement shows as flat (0) and
      // fills in on a later refresh once its history cache populates. Movers (known
      // pct) sort to the front.
      const items = ids.map(id => ({
        typeId: id,
        name:   nameMap[id] || `Type ${id}`,
        sell:   (prices[id] && prices[id].sell) || 0,
        pct:    typeof pcts[id] === 'number' ? pcts[id] : 0,
      })).filter(it => it.sell > 0);

      items.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
      const top = items.slice(0, 50);
      if (top.length) writeCache(cacheKey, top, 1 / 24);     // cache 1h only if non-empty
      return top;
    } catch (e) {
      console.warn('get-market-movers failed:', e.message);
      return [];
    }
  });

  ipcHandle('resolve-location', async (_, locationId, characterId) => {
    return getLocator().resolveLocation(locationId, characterId);
  });

  ipcHandle('resolve-system-names', async (_, systemIds) => {
    return getLocator().resolveSystemNames(systemIds);
  });

  // ─── IPC: Hub market prices (best buy/sell at a major trade hub) ──────────
  // The 4 main trade hubs. ownerCorpId + factionId are the station owner (from
  // ESI universe/stations) used by the renderer's broker-fee standing math.
  const TRADE_HUBS = {
    jita:    { stationId: 60003760, regionId: 10000002, ownerCorpId: 1000035, factionId: 500001 }, // Jita IV-4 · Caldari Navy
    amarr:   { stationId: 60008494, regionId: 10000043, ownerCorpId: 1000086, factionId: 500003 }, // Amarr VIII (Oris) EFA · Emperor Family
    dodixie: { stationId: 60011866, regionId: 10000032, ownerCorpId: 1000120, factionId: 500004 }, // Dodixie IX-20 FNAP · Federation Navy
    rens:    { stationId: 60004588, regionId: 10000030, ownerCorpId: 1000049, factionId: 500002 }, // Rens VI-8 BTT · Brutor Tribe
    hek:     { stationId: 60005686, regionId: 10000042, ownerCorpId: 1000057, factionId: 500002 }, // Hek VIII-12 BCF · Boundless Creation
  };

  // Best buy/sell per type for one hub. Cache hits are returned immediately; all
  // misses are fetched in BULK from Fuzzwork's station aggregates API (one request
  // per ~250 types) instead of a serial ESI order request per item. A cold
  // blueprint library went from hundreds of sequential round-trips to a couple of
  // batched ones. Per-type results are still cached (hubprice_{hub}_{typeId}) so
  // the format and TTLs are unchanged for callers.
  async function fetchHubPrices(typeIds, hubKey) {
    const hub    = TRADE_HUBS[hubKey] ? hubKey : 'jita';
    const cfg    = TRADE_HUBS[hub];
    const prices = {};
    if (!Array.isArray(typeIds)) return prices;

    const uniq   = [...new Set(typeIds.map(Number).filter(n => n > 0))];
    const misses = [];
    for (const typeId of uniq) {
      const cached = readCache(`hubprice_${hub}_${typeId}`);
      if (cached) prices[typeId] = cached;
      else misses.push(typeId);
    }
    if (!misses.length) return prices;

    // Fuzzwork aggregates: one call returns buy.max / sell.min for many types.
    const CHUNK = 250;
    for (let i = 0; i < misses.length; i += CHUNK) {
      const chunk = misses.slice(i, i + CHUNK);
      let data = null;
      try {
        data = await httpGet(`https://market.fuzzwork.co.uk/aggregates/?station=${cfg.stationId}&types=${chunk.join(',')}`);
      } catch (e) {
        console.log(`[prices] Fuzzwork batch failed (${hub}):`, e.message);
      }
      for (const typeId of chunk) {
        const d = data && (data[typeId] || data[String(typeId)]);
        if (d) {
          const priceData = { buy: Number(d.buy?.max) || 0, sell: Number(d.sell?.min) || 0 };
          prices[typeId] = priceData;
          // Cache real results 6h; all-zero (no orders) 1h so they refresh sooner.
          writeCache(`hubprice_${hub}_${typeId}`, priceData, (priceData.buy || priceData.sell) ? 0.25 : (1 / 24));
        } else {
          prices[typeId] = { buy: 0, sell: 0 };   // not returned this batch — don't cache the failure
        }
      }
    }
    return prices;
  }

  // Hub metadata (station/region/owner corp/faction) — single source of truth
  // for the renderer's broker-fee standing math.
  ipcHandle('get-hub-meta', async () => TRADE_HUBS);

  // Generalized hub prices: { typeId: { buy, sell } } for the chosen hub.
  ipcHandle('get-hub-prices', async (_, typeIds, hubKey) => {
    return fetchHubPrices(typeIds, hubKey || 'jita');
  });

  // Back-compat alias — existing callers keep getting Jita 4-4.
  ipcHandle('get-jita-prices', async (_, typeIds) => {
    return fetchHubPrices(typeIds, 'jita');
  });



  // ─── IPC: Blueprint materials — SDE primary, Fuzzwork fallback ──────────────
  // Returns { materials: [{ typeid, name, quantity }], blueprintTypeID }
  ipcHandle('get-blueprint-materials', async (_, typeId) => {
    if (bpCache[typeId]) return bpCache[typeId];

    const sdeDb = getSdeDb();
    if (sdeDb) {
      // Try manufacturing (1) then reactions (11)
      for (const activityID of [1, 11]) {
        try {
          const rows = await sdeDb.all(
            `SELECT m.materialTypeID AS typeid, m.quantity,
                    COALESCE(t.typeName, 'Type ' || m.materialTypeID) AS name
               FROM industryActivityMaterials m
               LEFT JOIN invTypes t ON t.typeID = m.materialTypeID
              WHERE m.typeID = ? AND m.activityID = ?`,
            typeId, activityID
          );
          if (rows.length) {
            const data = { materials: rows, blueprintTypeID: typeId };
            bpCache[typeId] = data;
            return data;
          }
        } catch (_) {}
      }
    }

    // Fuzzwork fallback. Only reached when the SDE has nothing — which, on an
    // install where the SDE hasn't downloaded, is every blueprint there is.
    const fuzz = await fetchFuzzworkBlueprint(typeId, httpGet);
    if (fuzz) {
      bpCache[typeId] = fuzz;
      return fuzz;
    }

    const emptyData = { materials: [], blueprintTypeID: typeId };
    bpCache[typeId] = emptyData;
    return emptyData;
  });

  // ─── IPC: Find blueprint for a product — SDE primary, Fuzzwork fallback ──────
  // Returns { [productTypeId]: { blueprintDetails: { blueprintTypeID, activityID } } }
  ipcHandle('find-bp-for-product', async (_, productTypeId) => {
    const key = `prod_${productTypeId}`;
    if (bpCache[key]) return bpCache[key];

    const sdeDb = getSdeDb();
    if (sdeDb) {
      try {
        // Prefer manufacturing (1) over reactions (11) over anything else.
        // `quantity` is the number of product units produced PER RUN — needed so
        // callers can convert "units required" into "runs required" (reactions
        // and ammo/charges produce large batches per run).
        const row = await sdeDb.get(
          `SELECT typeID AS blueprintTypeID, activityID, quantity AS productQty
             FROM industryActivityProducts
            WHERE productTypeID = ?
            ORDER BY CASE WHEN activityID = 1 THEN 0
                          WHEN activityID = 11 THEN 1
                          ELSE 2 END
            LIMIT 1`,
          productTypeId
        );
        if (row) {
          const result = {
            [productTypeId]: {
              blueprintDetails: {
                blueprintTypeID:    row.blueprintTypeID,
                activityID:         row.activityID,
                productQty:         row.productQty > 0 ? row.productQty : 1,
                maxProductionLimit: 1,
              }
            }
          };
          bpCache[key] = result;
          return result;
        }
      } catch (_) {}
    }

    // NO Fuzzwork fallback here. The API takes `typeid` (a blueprint) and has no
    // reverse product lookup: ?producttypeid=… answers 200 with an EMPTY body,
    // so every miss was a wasted request that could only ever fail to parse.
    // The SDE above is the only source for this, and it is a complete one.

    const noResult = { [productTypeId]: null };
    bpCache[key] = noResult;
    return noResult;
  });

  // ─── IPC: Get product typeId for a blueprint (SDE) ───────────────────────
  ipcHandle('get-product-for-blueprint', async (_, blueprintTypeId) => {
    const sdeDb = getSdeDb(); if (!sdeDb) return null;
    try {
      // industryActivityProducts (activityID 1 = manufacturing) — the SDE has no
      // invBlueprintTypes table, so the old query here silently returned null.
      const result = await getSdeDb().get(
        'SELECT productTypeID FROM industryActivityProducts WHERE activityID = 1 AND typeID = ?',
        blueprintTypeId
      );
      if (result && result.productTypeID) {
        console.log(`Blueprint ${blueprintTypeId} produces type ${result.productTypeID}`);
        return result.productTypeID;
      }
      return null;
    } catch (err) {
      console.warn(`Failed to look up product for blueprint ${blueprintTypeId}:`, err.message);
      return null;
    }
  });

  // ─── IPC: Reaction formulas list (SDE) ───────────────────────────────────
  // Returns every reaction formula (activityID 11) with its product and the
  // full input-material list, volumes included — everything the Reactions
  // Profit calculator needs in a single round-trip. Result is cached in-memory
  // (bpCache) since the SDE only changes on update.
  //
  // Shape: [{
  //   formulaTypeId, formulaName,
  //   productTypeId, productName, productQty, productVolume, groupName,
  //   materials: [{ typeId, name, quantity, volume }]
  // }]
  ipcHandle('reactions-list', async () => {
    if (bpCache.__reactionsList) return bpCache.__reactionsList;

    const sdeDb = getSdeDb();
    if (!sdeDb) return [];

    // 1. All reaction formulas + their products
    let formulaRows = [];
    try {
      formulaRows = await sdeDb.all(
        `SELECT iap.typeID        AS formulaTypeId,
                iap.productTypeID AS productTypeId,
                iap.quantity      AS productQty,
                bt.typeName       AS formulaName,
                pt.typeName       AS productName,
                pt.volume         AS productVolume,
                g.groupName       AS groupName
           FROM industryActivityProducts iap
           JOIN invTypes  bt ON bt.typeID  = iap.typeID
           JOIN invTypes  pt ON pt.typeID  = iap.productTypeID
           LEFT JOIN invGroups g ON g.groupID = pt.groupID
          WHERE iap.activityID = 11
            AND bt.published = 1
          ORDER BY bt.typeName`
      );
    } catch (e) {
      console.warn('[reactions-list] formula query failed:', e.message);
      return [];
    }
    if (!formulaRows.length) return [];

    // 2. All reaction input materials in one query, grouped by formula
    const matsByFormula = {};
    try {
      const matRows = await sdeDb.all(
        `SELECT m.typeID         AS formulaTypeId,
                m.materialTypeID AS typeId,
                m.quantity       AS quantity,
                t.typeName       AS name,
                t.volume         AS volume
           FROM industryActivityMaterials m
           LEFT JOIN invTypes t ON t.typeID = m.materialTypeID
          WHERE m.activityID = 11`
      );
      for (const r of matRows) {
        (matsByFormula[r.formulaTypeId] ||= []).push({
          typeId:   r.typeId,
          name:     r.name || `Type ${r.typeId}`,
          quantity: r.quantity,
          volume:   r.volume || 0,
        });
      }
    } catch (e) {
      console.warn('[reactions-list] materials query failed:', e.message);
    }

    const result = formulaRows.map(f => ({
      formulaTypeId: f.formulaTypeId,
      formulaName:   f.formulaName,
      productTypeId: f.productTypeId,
      productName:   f.productName || `Type ${f.productTypeId}`,
      productQty:    f.productQty || 1,
      productVolume: f.productVolume || 0,
      groupName:     f.groupName || 'Other',
      materials:     matsByFormula[f.formulaTypeId] || [],
    }));

    bpCache.__reactionsList = result;
    return result;
  });

  // ─── IPC: SDE blueprint materials with ME bonus applied ──────────────────
  // Queries the local SDE sqlite for the manufacturing activity of
  // blueprintTypeId, then applies the ME reduction formula:
  //   adjustedQty = max(1, ceil(baseQty × (1 − me/100)))
  //
  // Returns: { materials, productTypeId, productName, productQty } or null
  ipcHandle('sde-blueprint-materials', async (_, blueprintTypeId, me = 0) => {
    const sdeDb = getSdeDb(); if (!sdeDb) return null;

    const MANUFACTURING = 1; // activityID for manufacturing in SDE

    // ── 1. Fetch raw materials from industryActivityMaterials ────────────────
    let matRows = [];
    try {
      matRows = await getSdeDb().all(
        `SELECT materialTypeID, quantity
           FROM industryActivityMaterials
          WHERE typeID     = ?
            AND activityID = ?`,
        blueprintTypeId, MANUFACTURING
      );
    } catch (e) {
      console.warn('[sde-blueprint-materials] industryActivityMaterials query failed:', e.message);
      return null;
    }

    if (!matRows.length) return null;

    // ── 2. Resolve material type names ──────────────────────────────────────
    const matTypeIds = matRows.map(r => r.materialTypeID);
    const nameMap    = {};

    const nameTables = [
      { t: 'invTypes',    col: 'typeName', idcol: 'typeID' },
      { t: 'invtypes',    col: 'typeName', idcol: 'typeID' },
      { t: 'invTypes_en', col: 'typeName', idcol: 'typeID' },
      { t: 'types',       col: 'name',     idcol: 'id'     },
    ];

    // Detect which invTypes table exists once and reuse
    let invTypesTable = null;
    for (const q of nameTables) {
      try {
        await getSdeDb().get(`SELECT 1 FROM ${q.t} LIMIT 1`);
        invTypesTable = q;
        break;
      } catch (_) {}
    }

    if (invTypesTable) {
      // Batch fetch: SQLite supports up to ~999 params in IN clause
      for (let i = 0; i < matTypeIds.length; i += 900) {
        const chunk        = matTypeIds.slice(i, i + 900);
        const placeholders = chunk.map(() => '?').join(',');
        try {
          const rows = await getSdeDb().all(
            `SELECT ${invTypesTable.idcol} AS typeID, ${invTypesTable.col} AS typeName
               FROM ${invTypesTable.t}
              WHERE ${invTypesTable.idcol} IN (${placeholders})`,
            chunk
          );
          rows.forEach(r => { nameMap[r.typeID] = r.typeName; });
        } catch (_) {}
      }
    }

    // ── 3. Detect sub-components (types that are themselves manufactured) ────
    const componentSet = new Set();
    for (const typeId of matTypeIds) {
      try {
        const row = await getSdeDb().get(
          `SELECT 1 FROM industryActivityProducts
            WHERE activityID = ? AND productTypeID = ? LIMIT 1`,
          MANUFACTURING, typeId
        );
        if (row) componentSet.add(typeId);
      } catch (_) {}
    }

    // ── 4. Apply ME bonus ───────────────────────────────────────────────────
    const clampedME = Math.max(0, Math.min(10, me));

    const materials = matRows.map(row => {
      const baseQty     = row.quantity;
      const adjustedQty = baseQty <= 1
        ? 1
        : Math.max(1, Math.ceil(baseQty * (1 - clampedME / 100)));
      return {
        typeId:      row.materialTypeID,
        name:        nameMap[row.materialTypeID] || `Type ${row.materialTypeID}`,
        baseQty,
        adjustedQty,
        isComponent: componentSet.has(row.materialTypeID),
      };
    });

    // ── 5. Resolve product info from industryActivityProducts ────────────────
    let productTypeId = null;
    let productName   = null;
    let productQty    = 1;

    try {
      const prodRow = await getSdeDb().get(
        `SELECT productTypeID, quantity
           FROM industryActivityProducts
          WHERE typeID     = ?
            AND activityID = ?
          LIMIT 1`,
        blueprintTypeId, MANUFACTURING
      );
      if (prodRow) {
        productTypeId = prodRow.productTypeID;
        productQty    = prodRow.quantity || 1;
        if (invTypesTable) {
          try {
            const nameRow = await getSdeDb().get(
              `SELECT ${invTypesTable.col} AS typeName
                 FROM ${invTypesTable.t}
                WHERE ${invTypesTable.idcol} = ?`,
              productTypeId
            );
            productName = nameRow?.typeName || null;
          } catch (_) {}
        }
      }
    } catch (e) {
      console.warn('[sde-blueprint-materials] product lookup failed:', e.message);
    }

    // ── 6. Base manufacturing time (seconds per run, before TE/rigs/skills) ──
    let baseTime = 0;
    try {
      const timeRow = await getSdeDb().get(
        `SELECT time FROM industryActivity WHERE typeID = ? AND activityID = ? LIMIT 1`,
        blueprintTypeId, MANUFACTURING
      );
      if (timeRow && timeRow.time != null) baseTime = timeRow.time;
    } catch (e) {
      console.warn('[sde-blueprint-materials] base time lookup failed:', e.message);
    }

    return { materials, productTypeId, productName, productQty, baseTime };
  });

  // ─── IPC: SDE type metadata (group / category / slot / meta / tech) ─────────
  // Static SDE data backing the assets-table columns. Batch-resolved from the
  // local SDE — no ESI. Returns { [typeId]: { group, category, slot,
  // metaLevel, techLevel } }, with nulls where a field doesn't apply.
  // Named rather than inline so the asset-index rebuild can call the SAME
  // lookup. It was about to be reimplemented against invTypes.metaGroupID — a
  // column that does not exist there — which is exactly the kind of second copy
  // that drifts silently.
  async function fetchTypeMetadata(typeIds) {
    const sdeDb = getSdeDb();
    if (!sdeDb || !Array.isArray(typeIds) || !typeIds.length) return {};
    const ids = [...new Set(typeIds.map(Number).filter(Boolean))];
    const out = {};
    ids.forEach(id => { out[id] = { group: null, category: null, slot: null, metaLevel: null, techLevel: null, metaGroup: null }; });

    // Dogma effect IDs → fitting slot.
    const SLOT_BY_EFFECT = { 12: 'High', 13: 'Medium', 11: 'Low', 2663: 'Rig' };

    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const ph    = chunk.map(() => '?').join(',');

      // Group + category (invTypes → invGroups → invCategories)
      try {
        const rows = await sdeDb.all(
          `SELECT t.typeID AS id, g.groupName AS grp, c.categoryName AS cat
             FROM invTypes t
             LEFT JOIN invGroups     g ON g.groupID    = t.groupID
             LEFT JOIN invCategories c ON c.categoryID = g.categoryID
            WHERE t.typeID IN (${ph})`, chunk);
        rows.forEach(r => { if (out[r.id]) { out[r.id].group = r.grp || null; out[r.id].category = r.cat || null; } });
      } catch (_) { /* table layout differs — leave nulls */ }

      // Meta level (attr 633) + tech level (attr 422)
      try {
        const rows = await sdeDb.all(
          `SELECT typeID AS id, attributeID AS attr, COALESCE(valueInt, valueFloat) AS val
             FROM dgmTypeAttributes
            WHERE attributeID IN (422, 633) AND typeID IN (${ph})`, chunk);
        rows.forEach(r => {
          if (!out[r.id]) return;
          if (r.attr === 633) out[r.id].metaLevel = r.val != null ? Math.round(r.val) : null;
          if (r.attr === 422) out[r.id].techLevel = r.val != null ? Math.round(r.val) : null;
        });
      } catch (_) {}

      // Meta group (invMetaTypes): 1 Tech I · 2 Tech II · 4 Faction · 5 Officer …
      // Used to value pirate-faction supercapitals higher than their standard
      // hulls (none of which have a market price).
      try {
        const rows = await sdeDb.all(
          `SELECT typeID AS id, metaGroupID AS mg FROM invMetaTypes WHERE typeID IN (${ph})`, chunk);
        rows.forEach(r => { if (out[r.id]) out[r.id].metaGroup = r.mg != null ? r.mg : null; });
      } catch (_) {}

      // Fitting slot (dogma effects)
      try {
        const rows = await sdeDb.all(
          `SELECT typeID AS id, effectID AS eff
             FROM dgmTypeEffects
            WHERE effectID IN (11, 12, 13, 2663) AND typeID IN (${ph})`, chunk);
        rows.forEach(r => { if (out[r.id] && SLOT_BY_EFFECT[r.eff]) out[r.id].slot = SLOT_BY_EFFECT[r.eff]; });
      } catch (_) {}
    }
    return out;
  }

  ipcHandle('get-type-metadata', async (_, typeIds) => fetchTypeMetadata(typeIds));

  // ─── IPC: Planet Size Mapper (SDE, offline) ─────────────────────────────────
  // Planets are group 7 in mapDenormalize; radius is in metres. Diameter (km)
  // matters for PI — bigger planets give more room to spread extractor heads.
  //
  // Region and constellation MUST come from mapSolarSystems, not from the planet
  // row. mapDenormalize carries regionID/constellationID for some groups but they
  // are NULL on every one of the 68,407 planet rows, so the original
  // `d.regionID = r.regionID` filter matched nothing: the region dropdown came
  // back empty and the Planet Size Mapper could never load. Join through
  // d.solarSystemID (populated on all planet rows) instead. Same for security —
  // d.security is NULL here, s.security is the system's real status.
  ipcHandle('sde-get-planet-regions', async () => {
    const db = getSdeDb();
    if (!db) return [];
    try {
      return await db.all(`
        SELECT r.regionID AS id, r.regionName AS name
        FROM   mapRegions r
        WHERE  EXISTS (
                 SELECT 1
                 FROM   mapDenormalize d
                 JOIN   mapSolarSystems s ON s.solarSystemID = d.solarSystemID
                 WHERE  s.regionID = r.regionID AND d.groupID = 7)
        ORDER  BY r.regionName`);
    } catch (e) { console.warn('[sde] planet regions failed:', e.message); return []; }
  });

  ipcHandle('sde-get-region-planets', async (_, regionId) => {
    const db = getSdeDb();
    if (!db || !regionId) return [];
    try {
      const rows = await db.all(`
        SELECT d.itemID          AS id,
               d.itemName        AS name,
               t.typeName        AS ptype,
               d.radius          AS radius,
               s.security        AS sec,
               d.solarSystemID   AS sysId,
               s.solarSystemName AS sys,
               s.constellationID AS conId,
               c.constellationName AS con
        FROM   mapDenormalize d
        JOIN   mapSolarSystems  s ON s.solarSystemID = d.solarSystemID
        LEFT JOIN invTypes         t ON t.typeID = d.typeID
        LEFT JOIN mapConstellations c ON c.constellationID = s.constellationID
        WHERE  s.regionID = ? AND d.groupID = 7`, regionId);
      return rows.map(p => ({
        id:         p.id,
        name:       p.name,
        type:       (p.ptype || '').replace(/^Planet \(/, '').replace(/\)$/, '') || 'Planet',
        diameterKm: Math.round((p.radius || 0) * 2 / 1000),
        sec:        typeof p.sec === 'number' ? p.sec : 0,
        sysId:      p.sysId,  sys: p.sys || '',
        conId:      p.conId,  con: p.con || '',
      }));
    } catch (e) { console.warn('[sde] region planets failed:', e.message); return []; }
  });

  // ─── IPC: SDE solar system name lookup (offline, no ESI needed) ─────────────
  // Accepts solar_system_id values and returns { id: systemName }.
  ipcHandle('sde-get-system-names', async (_, systemIds) => {
    const sdeDb = getSdeDb();
    if (!sdeDb || !systemIds?.length) return {};
    const result = {};
    const ph = systemIds.map(() => '?').join(',');
    const tries = [
      `SELECT solarSystemID AS id, solarSystemName AS name FROM mapSolarSystems WHERE solarSystemID IN (${ph})`,
      `SELECT itemID        AS id, itemName        AS name FROM mapDenormalize  WHERE itemID        IN (${ph}) AND typeID = 5`,
    ];
    for (const q of tries) {
      try {
        const rows = await sdeDb.all(q, systemIds);
        rows.forEach(r => { if (r.id && r.name) result[r.id] = r.name; });
        if (Object.keys(result).length) break;
      } catch (_) {}
    }
    return result;
  });

  // ─── IPC: Resolve solar system name from facility/station ID ─────────────────
  // Used when solar_system_id = 0 (Upwell structures / some NPC stations).
  // Looks up the NPC station in staStations then joins mapSolarSystems for the name.
  // Returns { facilityId: solarSystemName }.
  ipcHandle('sde-facility-to-system', async (_, facilityIds) => {
    const sdeDb = getSdeDb();
    if (!sdeDb || !facilityIds?.length) return {};
    const result = {};
    // Only NPC stations have IDs < 1_000_000_000 in the SDE
    const npcIds = facilityIds.filter(id => id < 1_000_000_000);
    if (!npcIds.length) return {};
    const ph = npcIds.map(() => '?').join(',');
    const tries = [
      // SDE has staStations joined with mapSolarSystems
      `SELECT s.stationID AS fid, m.solarSystemName AS name
         FROM staStations s
         JOIN mapSolarSystems m ON s.solarSystemID = m.solarSystemID
        WHERE s.stationID IN (${ph})`,
      // Fallback: just station name if join unavailable
      `SELECT stationID AS fid, solarSystemName AS name FROM staStations WHERE stationID IN (${ph})`,
      `SELECT stationID AS fid, stationName     AS name FROM staStations WHERE stationID IN (${ph})`,
    ];
    for (const q of tries) {
      try {
        const rows = await sdeDb.all(q, npcIds);
        rows.forEach(r => { if (r.fid && r.name) result[r.fid] = r.name; });
        if (Object.keys(result).length) break;
      } catch (_) {}
    }
    return result;
  });

  // ─── IPC: SDE blueprint search — only returns blueprint types (categoryID=9) ──
  // ─── IPC: SDE market-item search (autocomplete) ───────────────────────────
  // Returns published, market-tradeable types (marketGroupID set) matching a name
  // substring. Replaces the removed public ESI /search/ endpoint. Ordered so exact
  // prefix matches and shorter names rank first. Returns [{ id, name }].
  ipcHandle('sde-search-market-types', async (_, query, limit = 10) => {
    const sdeDb = getSdeDb();
    if (!sdeDb || !query || !String(query).trim()) return [];
    const q = String(query).trim();
    try {
      const rows = await sdeDb.all(
        `SELECT typeID AS id, typeName AS name
           FROM invTypes
          WHERE typeName LIKE ? AND published = 1 AND marketGroupID IS NOT NULL
          ORDER BY CASE WHEN typeName LIKE ? THEN 0 ELSE 1 END, LENGTH(typeName), typeName
          LIMIT ?`,
        [`%${q}%`, `${q}%`, limit]
      );
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.warn('sde-search-market-types failed:', e.message);
      return [];
    }
  });

  // ─── Skill definitions (Skills page) ──────────────────────────────────────
  // Every published skill with the numbers the planner needs, in one query:
  //   275 = rank (training-time multiplier)
  //   180/181 = primary/secondary attribute ids (165..168 → int/mem/per/wil, 164 cha)
  //   182/183/184 = required skill ids, 277/278/279 = their required levels
  // ~511 rows, so the renderer caches the whole set once per session.
  ipcHandle('sde-get-skills', async () => {
    const sdeDb = getSdeDb();
    if (!sdeDb) return [];
    try {
      const rows = await sdeDb.all(`
        SELECT t.typeID AS id, t.typeName AS name, g.groupName AS grp,
          MAX(CASE WHEN a.attributeID=275 THEN COALESCE(a.valueInt,a.valueFloat) END) AS rank,
          MAX(CASE WHEN a.attributeID=180 THEN COALESCE(a.valueInt,a.valueFloat) END) AS primaryAttr,
          MAX(CASE WHEN a.attributeID=181 THEN COALESCE(a.valueInt,a.valueFloat) END) AS secondaryAttr,
          MAX(CASE WHEN a.attributeID=182 THEN COALESCE(a.valueInt,a.valueFloat) END) AS req1,
          MAX(CASE WHEN a.attributeID=277 THEN COALESCE(a.valueInt,a.valueFloat) END) AS req1lvl,
          MAX(CASE WHEN a.attributeID=183 THEN COALESCE(a.valueInt,a.valueFloat) END) AS req2,
          MAX(CASE WHEN a.attributeID=278 THEN COALESCE(a.valueInt,a.valueFloat) END) AS req2lvl,
          MAX(CASE WHEN a.attributeID=184 THEN COALESCE(a.valueInt,a.valueFloat) END) AS req3,
          MAX(CASE WHEN a.attributeID=279 THEN COALESCE(a.valueInt,a.valueFloat) END) AS req3lvl
        FROM invTypes t
        JOIN invGroups g ON g.groupID = t.groupID
        LEFT JOIN dgmTypeAttributes a ON a.typeID = t.typeID
        WHERE g.categoryID = 16 AND t.published = 1
        GROUP BY t.typeID
        ORDER BY t.typeName`);
      return (rows || []).map(r => ({
        id: r.id, name: r.name, group: r.grp,
        rank: r.rank || 1,
        primaryAttr: r.primaryAttr || null,
        secondaryAttr: r.secondaryAttr || null,
        prereqs: [
          r.req1 ? { id: r.req1, level: r.req1lvl || 1 } : null,
          r.req2 ? { id: r.req2, level: r.req2lvl || 1 } : null,
          r.req3 ? { id: r.req3, level: r.req3lvl || 1 } : null,
        ].filter(Boolean),
      }));
    } catch (e) {
      console.warn('sde-get-skills failed:', e.message);
      return [];
    }
  });

  // Attribute-boosting items for the planner's booster optimiser:
  //   • Learning implants (group "Cyber Learning") — permanent, one attribute
  //     each (+1..+5), in a fixed head slot.
  //   • Cerebral accelerators — temporary, +N to ALL five attributes for a set
  //     duration (attribute 330, milliseconds).
  // Blueprints/crates are excluded; the renderer further drops anything with no
  // Jita price, which cleanly removes the non-tradeable Serenity/expired/event
  // boosters that share these names.
  ipcHandle('sde-attribute-boosters', async () => {
    const sdeDb = getSdeDb();
    if (!sdeDb) return { implants: [], accelerators: [] };
    const ATTR = { 175: 'charisma', 176: 'intelligence', 177: 'memory', 178: 'perception', 179: 'willpower' };
    try {
      const impRows = await sdeDb.all(`
        SELECT t.typeID AS id, t.typeName AS name,
          MAX(CASE WHEN a.attributeID=331 THEN COALESCE(a.valueInt,a.valueFloat) END) AS slot,
          MAX(CASE WHEN a.attributeID=175 THEN COALESCE(a.valueInt,a.valueFloat) END) AS cha,
          MAX(CASE WHEN a.attributeID=176 THEN COALESCE(a.valueInt,a.valueFloat) END) AS intl,
          MAX(CASE WHEN a.attributeID=177 THEN COALESCE(a.valueInt,a.valueFloat) END) AS mem,
          MAX(CASE WHEN a.attributeID=178 THEN COALESCE(a.valueInt,a.valueFloat) END) AS per,
          MAX(CASE WHEN a.attributeID=179 THEN COALESCE(a.valueInt,a.valueFloat) END) AS wil
        FROM invTypes t JOIN invGroups g ON g.groupID = t.groupID
        LEFT JOIN dgmTypeAttributes a ON a.typeID = t.typeID
        WHERE t.published = 1 AND g.groupName = 'Cyber Learning'
        GROUP BY t.typeID`);
      const implants = [];
      (impRows || []).forEach(r => {
        const map = { charisma: r.cha, intelligence: r.intl, memory: r.mem, perception: r.per, willpower: r.wil };
        // A learning implant boosts exactly one attribute — find which.
        const attr = Object.keys(map).find(k => (map[k] || 0) > 0);
        if (!attr) return;
        implants.push({ id: r.id, name: r.name, attr, bonus: map[attr], slot: r.slot || null });
      });

      const accRows = await sdeDb.all(`
        SELECT t.typeID AS id, t.typeName AS name,
          MAX(CASE WHEN a.attributeID IN (175,176,177,178,179) THEN COALESCE(a.valueInt,a.valueFloat) END) AS bonus,
          MAX(CASE WHEN a.attributeID=330 THEN COALESCE(a.valueInt,a.valueFloat) END) AS durMs
        FROM invTypes t
        LEFT JOIN dgmTypeAttributes a ON a.typeID = t.typeID
        WHERE t.published = 1 AND t.typeName LIKE '%Cerebral Accelerator%'
          AND t.typeName NOT LIKE '%Blueprint%' AND t.typeName NOT LIKE '%Crate%'
        GROUP BY t.typeID`);
      const accelerators = (accRows || [])
        .filter(r => r.bonus > 0 && r.durMs > 0)
        .map(r => ({ id: r.id, name: r.name, bonus: r.bonus, durationHours: Math.round(r.durMs / 3600000) }));

      return { implants, accelerators };
    } catch (e) {
      console.warn('sde-attribute-boosters failed:', e.message);
      return { implants: [], accelerators: [] };
    }
  });

  // Skills required to USE a given type (ship, module, rig…), so the planner can
  // answer "what do I need to fly a Rifter?". Same dogma attributes the skill
  // prerequisites use (182/183/184 → required skill, 277/278/279 → its level);
  // the renderer expands each requirement's own prerequisite chain from the
  // skill definitions it already holds.
  ipcHandle('sde-type-requirements', async (_, typeId) => {
    const sdeDb = getSdeDb();
    if (!sdeDb || !typeId) return null;
    try {
      const t = await sdeDb.get(
        `SELECT t.typeID AS id, t.typeName AS name, g.groupName AS grp
           FROM invTypes t JOIN invGroups g ON g.groupID = t.groupID
          WHERE t.typeID = ?`, [typeId]);
      if (!t) return null;
      const rows = await sdeDb.all(
        `SELECT attributeID, COALESCE(valueInt, valueFloat) AS v
           FROM dgmTypeAttributes
          WHERE typeID = ? AND attributeID IN (182,183,184,277,278,279)`, [typeId]);
      const at = {};
      (rows || []).forEach(r => { at[r.attributeID] = r.v; });
      const reqs = [
        at[182] ? { id: at[182], level: at[277] || 1 } : null,
        at[183] ? { id: at[183], level: at[278] || 1 } : null,
        at[184] ? { id: at[184], level: at[279] || 1 } : null,
      ].filter(Boolean);
      return { id: t.id, name: t.name, group: t.grp, requirements: reqs };
    } catch (e) {
      console.warn('sde-type-requirements failed:', e.message);
      return null;
    }
  });

  // The inverse of sde-type-requirements: given skills a character is training,
  // what does finishing each level actually unlock? Answers "what is this queue
  // buying me" in ships and guns rather than skill names.
  //
  // Batched deliberately. A roster's combined queues run to a few hundred
  // (skill, level) pairs, and one query per pair would be a few hundred SQLite
  // round-trips through IPC. This is THREE queries total — one per required-skill
  // slot — regardless of queue size, bucketed in JS afterwards.
  //
  // published=1 drops the unpublished test/dev hulls that would otherwise pad
  // every list with items nobody can fly.
  ipcHandle('sde-skill-unlocks', async (_, pairs) => {
    const sdeDb = getSdeDb();
    if (!sdeDb || !Array.isArray(pairs) || !pairs.length) return {};

    const wanted = new Map();          // skillId -> Set(levels asked for)
    for (const p of pairs) {
      const id = Number(p?.skillId), lv = Number(p?.level);
      if (!id || !lv) continue;
      if (!wanted.has(id)) wanted.set(id, new Set());
      wanted.get(id).add(lv);
    }
    if (!wanted.size) return {};

    const skillIds = [...wanted.keys()];
    const SLOTS = [[182, 277], [183, 278], [184, 279]];
    const out = {};                    // "skillId:level" -> [{ id, name, group, category }]

    try {
      for (const [skillAttr, levelAttr] of SLOTS) {
        // Chunked against SQLite's variable limit; a roster can hold a lot of
        // distinct skills even though each queue is short.
        for (let i = 0; i < skillIds.length; i += 400) {
          const chunk = skillIds.slice(i, i + 400);
          const rows = await sdeDb.all(
            `SELECT CAST(COALESCE(sk.valueInt, sk.valueFloat) AS INT) AS skillId,
                    CAST(COALESCE(lv.valueInt, lv.valueFloat) AS INT) AS lvl,
                    t.typeID   AS id,
                    t.typeName AS name,
                    g.groupName    AS grp,
                    c.categoryName AS cat
               FROM dgmTypeAttributes sk
               JOIN dgmTypeAttributes lv ON lv.typeID = sk.typeID AND lv.attributeID = ?
               JOIN invTypes t ON t.typeID = sk.typeID
               LEFT JOIN invGroups     g ON g.groupID    = t.groupID
               LEFT JOIN invCategories c ON c.categoryID = g.categoryID
              WHERE sk.attributeID = ?
                AND t.published = 1
                AND CAST(COALESCE(sk.valueInt, sk.valueFloat) AS INT) IN (${chunk.map(() => '?').join(',')})`,
            [levelAttr, skillAttr, ...chunk],
          );
          for (const r of (rows || [])) {
            if (!wanted.get(r.skillId)?.has(r.lvl)) continue;
            const key = `${r.skillId}:${r.lvl}`;
            (out[key] = out[key] || []).push({
              id: r.id, name: r.name, group: r.grp || null, category: r.cat || null,
            });
          }
        }
      }
      // A type can require the same skill in more than one slot; dedupe and sort
      // so the renderer can just slice off the first few.
      for (const key of Object.keys(out)) {
        const seen = new Set();
        out[key] = out[key]
          .filter(x => (seen.has(x.id) ? false : seen.add(x.id)))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }
      return out;
    } catch (e) {
      console.warn('sde-skill-unlocks failed:', e.message);
      return {};
    }
  });

  // Attribute bonuses granted by implants (175=cha, 176=int, 177=mem, 178=per,
  // 179=wil). Needed so training estimates reflect the character's actual pod
  // rather than base attributes — a +5 set shifts times by ~20%.
  ipcHandle('sde-implant-attrs', async (_, typeIds) => {
    const sdeDb = getSdeDb();
    if (!sdeDb || !Array.isArray(typeIds) || !typeIds.length) return {};
    const ids = [...new Set(typeIds.map(Number).filter(Boolean))];
    const out = {};
    try {
      const rows = await sdeDb.all(
        `SELECT typeID, attributeID, COALESCE(valueInt, valueFloat) AS v
           FROM dgmTypeAttributes
          WHERE attributeID IN (175,176,177,178,179)
            AND typeID IN (${ids.map(() => '?').join(',')})`,
        ids,
      );
      const KEY = { 175: 'charisma', 176: 'intelligence', 177: 'memory', 178: 'perception', 179: 'willpower' };
      (rows || []).forEach(r => {
        const k = KEY[r.attributeID];
        if (!k) return;
        out[r.typeID] = out[r.typeID] || {};
        out[r.typeID][k] = r.v || 0;
      });
      return out;
    } catch (e) {
      console.warn('sde-implant-attrs failed:', e.message);
      return {};
    }
  });

  // Batched exact name → type lookup for the bulk appraisal tool. A pasted cargo
  // hold can be hundreds of lines, so this resolves them in one pass instead of
  // one search IPC per line. Matching is case-insensitive and exact (paste data
  // carries real type names); the volume comes along for the m³ total.
  // Returns { "<lowercased name>": { id, name, volume } }.
  ipcHandle('sde-types-by-names', async (_, names) => {
    const sdeDb = getSdeDb();
    if (!sdeDb || !Array.isArray(names) || !names.length) return {};
    const wanted = [...new Set(names.map(n => String(n || '').trim().toLowerCase()).filter(Boolean))];
    const out = {};
    // Chunked well under SQLite's default 999 bound-parameter limit.
    const CHUNK = 400;
    try {
      for (let i = 0; i < wanted.length; i += CHUNK) {
        const slice = wanted.slice(i, i + CHUNK);
        const rows = await sdeDb.all(
          `SELECT typeID AS id, typeName AS name, volume
             FROM invTypes
            WHERE lower(typeName) IN (${slice.map(() => '?').join(',')})
              AND published = 1`,
          slice,
        );
        (rows || []).forEach(r => { out[String(r.name).toLowerCase()] = { id: r.id, name: r.name, volume: r.volume || 0 }; });
      }
      return out;
    } catch (e) {
      console.warn('sde-types-by-names failed:', e.message);
      return out;
    }
  });

  ipcHandle('sde-search-types', async (_, query, limit = 15) => {
    const sdeDb = getSdeDb();
    if (!sdeDb) return [];

    // Try joined query first (invTypes + invGroups, blueprint category = 9)
    const joinedTables = [
      { types: 'invTypes', groups: 'invGroups', typeCol: 'typeName', typeId: 'typeID', groupId: 'groupID', catId: 'categoryID' },
      { types: 'invtypes', groups: 'invGroups', typeCol: 'typeName', typeId: 'typeID', groupId: 'groupID', catId: 'categoryID' },
    ];
    for (const q of joinedTables) {
      try {
        const rows = await sdeDb.all(
          `SELECT t.${q.typeId} AS id, t.${q.typeCol} AS name
             FROM ${q.types} t
             JOIN ${q.groups} g ON t.${q.groupId} = g.${q.groupId}
            WHERE t.${q.typeCol} LIKE ?
              AND t.published = 1
              AND g.${q.catId} = 9
            ORDER BY CASE WHEN t.${q.typeCol} LIKE ? THEN 0 ELSE 1 END,
                     t.${q.typeCol}
            LIMIT ?`,
          [`%${query}%`, `${query}%`, limit]
        );
        if (rows.length) return rows;
      } catch (_) {}
    }

    // Fallback: filter by name containing "Blueprint" if join tables differ
    const fallbackTables = [
      { t: 'invTypes', col: 'typeName', idcol: 'typeID' },
      { t: 'invtypes', col: 'typeName', idcol: 'typeID' },
    ];
    for (const { t, col, idcol } of fallbackTables) {
      try {
        const rows = await sdeDb.all(
          `SELECT ${idcol} AS id, ${col} AS name FROM ${t}
            WHERE ${col} LIKE ? AND ${col} LIKE '%Blueprint%' AND published = 1
            ORDER BY CASE WHEN ${col} LIKE ? THEN 0 ELSE 1 END, ${col}
            LIMIT ?`,
          [`%${query}%`, `${query}%`, limit]
        );
        if (rows.length) return rows;
      } catch (_) {}
    }
    return [];
  });

  // ─── IPC: SDE name lookup (best-effort fallback to local SDE sqlite) ──────
  ipcHandle('sde-get-name', async (_, typeId) => {
    const sdeDb = getSdeDb(); if (!sdeDb) return null;
    const tries = [
      { t: 'invTypes',    col: 'typeName', idcol: 'typeID' },
      { t: 'invtypes',    col: 'typeName', idcol: 'typeID' },
      { t: 'invTypes_en', col: 'typeName', idcol: 'typeID' },
      { t: 'types',       col: 'name',     idcol: 'id'     },
    ];
    for (const q of tries) {
      try {
        const row = await getSdeDb().get(
          `SELECT ${q.col} as name FROM ${q.t} WHERE ${q.idcol} = ?`,
          typeId
        );
        if (row && row.name) return row.name;
      } catch (_) {}
    }
    return null;
  });

  // Handed back so the valuation refresh reuses the SAME cached, batched path
  // rather than opening a second route to Fuzzwork, and the asset-index rebuild
  // reuses the same SDE metadata lookup the renderer gets.
  return { fetchHubPrices, fetchTypeMetadata };
}

module.exports = { registerEsiHandlers };
// Exposed for tests: the Fuzzwork URL builder and its response adapter. Both got
// this wrong for a long time without anything failing loudly — the URL 404'd and
// the adapter read a key that does not exist — so they are pinned here.
module.exports._fuzzwork = { FUZZWORK_BLUEPRINT_URL, _fuzzworkMaterials };