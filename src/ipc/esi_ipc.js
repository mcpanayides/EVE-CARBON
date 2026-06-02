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

  // ─── IPC: Jita market prices (Jita 4-4, station 60003760) ────────────────
  ipcHandle('get-jita-prices', async (_, typeIds) => {
    const JITA_STATION_ID = 60003760; // Jita IV - Moon 4 (Caldari Navy Assembly Plant)
    const REGION_FORGE    = 10000002;
    const prices          = {};

    try {
      for (const typeId of typeIds) {
        const cacheKey = `jita_price_${typeId}`;
        const cached   = readCache(cacheKey);

        if (cached) {
          prices[typeId] = cached;
          continue;
        }

        try {
          let orderData = [];
          try {
            orderData = await httpGet(
              `${ESI_BASE}/v1/markets/${REGION_FORGE}/orders/?datasource=tranquility&type_id=${typeId}&order_type=all`
            );
          } catch (e) {
            orderData = [];
          }

          // Filter for Jita station orders only
          orderData = Array.isArray(orderData)
            ? orderData.filter(o => Number(o.location_id) === JITA_STATION_ID)
            : [];

          if (!orderData || orderData.length === 0) {
            prices[typeId] = { buy: 0, sell: 0 };
            writeCache(cacheKey, { buy: 0, sell: 0 }, 1); // cache misses for 1 day
            continue;
          }

          const buyOrders  = orderData.filter(o =>  o.is_buy_order);
          const sellOrders = orderData.filter(o => !o.is_buy_order);

          const bestBuyPrice  = buyOrders.length  > 0 ? Math.max(...buyOrders.map(o => o.price))  : 0;
          const bestSellPrice = sellOrders.length > 0 ? Math.min(...sellOrders.map(o => o.price)) : 0;

          const priceData    = { buy: bestBuyPrice, sell: bestSellPrice };
          prices[typeId]     = priceData;
          writeCache(cacheKey, priceData, 0.25); // cache 6 hours
        } catch (e) {
          console.log(`Failed to fetch Jita price for ${typeId}:`, e.message);
          prices[typeId] = { buy: 0, sell: 0 };
        }
      }
    } catch (e) {
      console.error('Market price lookup error:', e);
    }

    return prices;
  });

  // ─── IPC: Fuzzwork blueprint materials ───────────────────────────────────
  ipcHandle('get-blueprint-materials', async (_, typeId) => {
    if (bpCache[typeId]) return bpCache[typeId];
    try {
      const data = await httpGet(`${FUZZWORK_BASE}/api/blueprint.php?typeid=${typeId}&runs=1&me=0&pe=0`);
      bpCache[typeId] = data;
      return data;
    } catch (err) {
      console.warn(`Blueprint ${typeId} not found in Fuzzwork, returning empty materials:`, err.message);
      const emptyData    = { materials: [], blueprintTypeID: typeId };
      bpCache[typeId]    = emptyData;
      return emptyData;
    }
  });

  // ─── IPC: Find blueprint for a product (Fuzzwork) ────────────────────────
  ipcHandle('find-bp-for-product', async (_, productTypeId) => {
    const key = `prod_${productTypeId}`;
    if (bpCache[key]) return bpCache[key];
    try {
      const data  = await httpGet(`${FUZZWORK_BASE}/api/blueprint.php?producttypeid=${productTypeId}&runs=1&me=0&pe=0`);
      bpCache[key] = data;
      return data;
    } catch (err) {
      console.warn(`No blueprint found for product ${productTypeId}:`, err.message);
      return null;
    }
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

    return { materials, productTypeId, productName, productQty };
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