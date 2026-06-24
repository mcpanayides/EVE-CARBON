const { ipcMain } = require('electron');

const ESI_BASE      = 'https://esi.evetech.net';
const FUZZWORK_BASE = 'https://www.fuzzwork.co.uk';

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
  ipcHandle('esi-fetch', async (_, url) => {
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
        headers: { 'User-Agent': 'EVE-Carbon/1.0', 'Accept': 'text/csv,text/plain,*/*' }
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

  // ─── IPC: ESI type search ─────────────────────────────────────────────────
  ipcHandle('esi-search', async (_, query) => {
    return httpGet(
      `${ESI_BASE}/v2/search/?categories=inventory_type&search=${encodeURIComponent(query)}&strict=false&datasource=tranquility`
    );
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
      const data = await httpGet(`${ESI_BASE}/v1/markets/prices/?datasource=tranquility`);
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
      writeCache(cacheKey, map, 0.5); // cache 12 hours
      return map;
    } catch (e) {
      console.warn('get-market-prices failed:', e.message);
      return {};
    }
  });

  // ─── IPC: Location / structure resolution ────────────────────────────────
  // All three use getLocator(), not a bare locator, so the shared instance
  // with its persistent station cache is always used.
  ipcHandle('get-structure-info', async (_, structureId, characterId) => {
    return getLocator().resolveLocation(structureId, characterId);
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

  // Best buy/sell per type for one hub, region-orders filtered to the hub station.
  async function fetchHubPrices(typeIds, hubKey) {
    const hub    = TRADE_HUBS[hubKey] ? hubKey : 'jita';
    const cfg    = TRADE_HUBS[hub];
    const prices = {};
    if (!Array.isArray(typeIds)) return prices;

    for (const typeId of typeIds) {
      const cacheKey = `hubprice_${hub}_${typeId}`;
      const cached   = readCache(cacheKey);
      if (cached) { prices[typeId] = cached; continue; }

      try {
        let orderData = [];
        try {
          orderData = await httpGet(
            `${ESI_BASE}/v1/markets/${cfg.regionId}/orders/?datasource=tranquility&type_id=${typeId}&order_type=all`
          );
        } catch (e) { orderData = []; }

        orderData = Array.isArray(orderData)
          ? orderData.filter(o => Number(o.location_id) === cfg.stationId)
          : [];

        if (!orderData.length) {
          prices[typeId] = { buy: 0, sell: 0 };
          writeCache(cacheKey, { buy: 0, sell: 0 }, 1); // cache misses for 1 day
          continue;
        }

        const buyOrders  = orderData.filter(o =>  o.is_buy_order);
        const sellOrders = orderData.filter(o => !o.is_buy_order);
        const priceData  = {
          buy:  buyOrders.length  ? Math.max(...buyOrders.map(o => o.price))  : 0,
          sell: sellOrders.length ? Math.min(...sellOrders.map(o => o.price)) : 0,
        };
        prices[typeId] = priceData;
        writeCache(cacheKey, priceData, 0.25); // cache 6 hours
      } catch (e) {
        console.log(`Failed to fetch ${hub} price for ${typeId}:`, e.message);
        prices[typeId] = { buy: 0, sell: 0 };
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

    // Fuzzwork fallback (may 404 for newer/capital BPs)
    try {
      const data = await httpGet(`${FUZZWORK_BASE}/api/blueprint.php?typeid=${typeId}&runs=1&me=0&pe=0`);
      bpCache[typeId] = data;
      return data;
    } catch (_) {}

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

    // Fuzzwork fallback
    try {
      const data = await httpGet(`${FUZZWORK_BASE}/api/blueprint.php?producttypeid=${productTypeId}&runs=1&me=0&pe=0`);
      bpCache[key] = data;
      return data;
    } catch (_) {}

    const noResult = { [productTypeId]: null };
    bpCache[key] = noResult;
    return noResult;
  });

  // ─── IPC: Get product typeId for a blueprint (SDE) ───────────────────────
  ipcHandle('get-product-for-blueprint', async (_, blueprintTypeId) => {
    const sdeDb = getSdeDb(); if (!sdeDb) return null;
    try {
      const result = await getSdeDb().get(
        'SELECT productTypeID FROM invBlueprintTypes WHERE blueprintTypeID = ?',
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
  ipcHandle('get-type-metadata', async (_, typeIds) => {
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
  });

  // ─── IPC: Planet Size Mapper (SDE, offline) ─────────────────────────────────
  // Planets are group 7 in mapDenormalize; radius is in metres. Diameter (km)
  // matters for PI — bigger planets give more room to spread extractor heads.
  ipcHandle('sde-get-planet-regions', async () => {
    const db = getSdeDb();
    if (!db) return [];
    try {
      return await db.all(`
        SELECT r.regionID AS id, r.regionName AS name
        FROM   mapRegions r
        WHERE  EXISTS (SELECT 1 FROM mapDenormalize d WHERE d.regionID = r.regionID AND d.groupID = 7)
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
               d.security        AS sec,
               d.solarSystemID   AS sysId,
               s.solarSystemName AS sys,
               d.constellationID AS conId,
               c.constellationName AS con
        FROM   mapDenormalize d
        LEFT JOIN invTypes         t ON t.typeID = d.typeID
        LEFT JOIN mapSolarSystems  s ON s.solarSystemID = d.solarSystemID
        LEFT JOIN mapConstellations c ON c.constellationID = d.constellationID
        WHERE  d.regionID = ? AND d.groupID = 7`, regionId);
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
}

module.exports = { registerEsiHandlers };