const { ipcMain, BrowserWindow } = require('electron');

const ESI_BASE = 'https://esi.evetech.net';

// Assets are considered stale after 6 hours. The ESI assets endpoint itself
// caches for 1 hour, so anything under that is guaranteed-identical data; 6h is
// a deliberate middle ground between freshness and ESI/locator load.
const ASSET_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * registerAssetHandlers
 *
 * @param {object} deps
 * @param {function} deps.getValidToken  - returns a valid ESI access token for a characterId
 * @param {function} deps.httpGet        - unauthenticated HTTP GET helper
 * @param {function} deps.resolveNames   - resolves an array of ids -> { id: name } map
 * @param {function} deps.getLocator     - returns the shared locator instance
 * @param {function} deps.loadDB         - loads the local JSON database
 * @param {function} deps.saveDB         - saves the local JSON database
 * @param {function} deps.readCache      - reads from persistent cache
 * @param {function} deps.writeCache     - writes to persistent cache
 * @param {object}   deps.charInfoDb        - character info DB module
 * @param {function} deps.coreCharacterSync  - runs the core (non-asset) character sync
 */
function registerAssetHandlers({
  ipcHandle,
  getValidToken,
  httpGet,
  httpGetFull,
  httpPost,
  resolveNames,
  getLocator,
  loadDB,
  saveDB,
  readCache,
  writeCache,
  charInfoDb,
  coreCharacterSync,
}) {

  // ─── Internal: full asset fetch + resolve + persist ──────────────────────
  async function syncAssetsInternal(characterId) {
    const token = await getValidToken(characterId);
    const authHdr = { Authorization: `Bearer ${token}` };
    let allAssets = [];
    let page = 1;
    let totalPages = 1;
    while (true) {
      const { data, xPages } = await httpGetFull(
        `${ESI_BASE}/v3/characters/${characterId}/assets/?page=${page}&datasource=tranquility`,
        authHdr
      );
      if (page === 1) totalPages = xPages || 1;
      allAssets = allAssets.concat(data);
      if (page >= totalPages || !data || data.length < 1000) break;
      page++;
    }

    const typeIds = [...new Set(allAssets.map(a => a.type_id).filter(Boolean))];
    const nameMap = await resolveNames(typeIds);

    // Build a Set of all item_ids so we can detect container-child rows.
    // Items whose location_id matches another item's item_id are nested inside
    // a container or fitted to a ship — their location is NOT a station/structure
    // and must NOT be sent to the locator (it will always fail for those IDs).
    // The getCharacterAssets() JOIN walk handles resolving their display location.
    const allItemIds      = new Set(allAssets.map(a => a.item_id));
    const rootLocationIds = [...new Set(
      allAssets
        .map(a => a.location_id)
        .filter(id => id && !allItemIds.has(id)) // keep only real station/structure IDs
    )];

    // Resolve all location metadata via the shared locator module.
    // Handles NPC stations, player structures (ESI auth -> Hammertime -> zKillboard -> adam4eve).
    const locationMeta = await getLocator().resolveLocations(rootLocationIds, characterId);

    const assets = allAssets.map(asset => {
      const loc = locationMeta[asset.location_id] || {};
      return {
        item_id:            asset.item_id,
        type_id:            asset.type_id,
        name:               nameMap[asset.type_id] || `Type ${asset.type_id}`,
        location_id:        asset.location_id,
        // Store null (not a placeholder string) so getUnresolvedAssetLocations() can find it
        location_name:      loc.name || null,
        quantity:           asset.is_singleton ? 1 : (asset.quantity || 1),
        volume:             asset.volume || 0,
        is_singleton:       asset.is_singleton,
        location_flag:      asset.location_flag || asset.flag || '',
        solar_system_id:    loc.solar_system_id    || null,
        solar_system_name:  loc.solar_system_name  || null,
        constellation_id:   loc.constellation_id   || null,
        constellation_name: loc.constellation_name || null,
        region_id:          loc.region_id          || null,
        region_name:        loc.region_name        || null,
        security_status:    typeof loc.security_status === 'number' ? loc.security_status : null,
        owner_id:           loc.owner_id           || null,
        owner_name:         loc.owner_name         || null,
      };
    });

    // ── Write to SQLite (character_information.db) ────────────────────────────
    // This is the primary store the assets page reads from. Always write here so
    // the 12-hour stale sync keeps the DB current, not just blueprints.json.
    await charInfoDb.ensureCharacterTables(characterId);
    await charInfoDb.replaceAssets(characterId, assets);

    // ── Custom item names (ships, named containers, asset-safety wraps) ───────
    // ESI POST /assets/names/ returns the character's own custom item names.
    // Stored in a side table and joined back by getCharacterAssets() to label
    // ships ("Snowbird") and unresolved container locations ("BOVRIL- DO NOT
    // USE"). Only nameable items (singletons: assembled ships/containers) are
    // sent; un-named items come back as "None" and are dropped.
    try {
      const nameable = [...new Set(allAssets.filter(a => a.is_singleton).map(a => a.item_id))];
      const customNames = [];
      for (let i = 0; i < nameable.length; i += 1000) {
        const chunk = nameable.slice(i, i + 1000);
        try {
          const res = await httpPost(
            `${ESI_BASE}/v1/characters/${characterId}/assets/names/?datasource=tranquility`,
            chunk, authHdr
          );
          if (Array.isArray(res)) {
            for (const r of res) {
              if (r && r.item_id && r.name && r.name !== 'None') {
                customNames.push({ item_id: r.item_id, name: r.name });
              }
            }
          }
        } catch (e) {
          console.warn(`[AssetSync] assets/names chunk failed: ${e.message}`);
        }
      }
      await charInfoDb.replaceAssetNames(characterId, customNames);
      console.log(`[AssetSync] Stored ${customNames.length} custom item name(s) for ${characterId}.`);
    } catch (e) {
      console.warn(`[AssetSync] custom-name fetch failed: ${e.message}`);
    }

    // ── Re-resolve any locations that came back null ───────────────────────────
    // Some Upwell structures fail on first pass (401, Hammertime miss, etc.).
    // After replaceAssets the DB has nulls for those rows. We do a second targeted
    // pass — the locator's internal cache + Hammertime will often succeed on a
    // retry now that external caches may have been primed.
    const unresolved = await charInfoDb.getUnresolvedAssetLocations(characterId).catch(() => []);
    if (unresolved.length) {
      console.log(`[AssetSync] Re-resolving ${unresolved.length} unresolved location(s) for character ${characterId}...`);
      for (const locationId of unresolved) {
        // Skip structures already proven unresolvable — an immediate retry just
        // re-runs the same chain that failed seconds ago and still yields a
        // fallback, so the displayed result is unchanged either way.
        if (getLocator().isKnownUnresolvable(locationId)) continue;
        try {
          const geo = await getLocator().resolveLocation(locationId, characterId);
          if (geo && (geo.name || geo.solar_system_id)) {
            await charInfoDb.updateAssetLocation(characterId, locationId, geo);
          }
        } catch (e) {
          console.log(`[AssetSync] Re-resolve failed for location ${locationId}: ${e.message}`);
        }
      }
      const stillUnresolved = await charInfoDb.getUnresolvedAssetLocations(characterId).catch(() => []);
      console.log(`[AssetSync] Re-resolve complete: ${unresolved.length - stillUnresolved.length} fixed, ${stillUnresolved.length} still unresolved.`);
    }

    // ── Also keep the legacy blueprints.json in sync ──────────────────────────
    const db = loadDB();
    db.assets = db.assets || {};
    db.assets[characterId] = { updatedAt: Date.now(), items: assets };
    saveDB(db);

    return { count: assets.length, items: assets };
  }

  // ─── IPC: Core-only auto-sync (20-min cadence, no assets) ────────────────
  ipcHandle('sync-character-core', async (event, characterId) => {
    const db = loadDB();
    const account = db.accounts[characterId];
    if (!account) throw new Error('Account not found');
    const characterName = account.characterName;
    const win = BrowserWindow.fromWebContents(event.sender);

    return coreCharacterSync(characterId, characterName, (step, detail) => {
      console.log(`[CoreSync] ${characterName} — ${step}: ${detail}`);
      if (win && !win.isDestroyed()) {
        win.webContents.send('char-sync-progress', { characterId, characterName, step, detail });
      }
    });
  });

  // ─── IPC: Asset-only sync — skips if synced within ASSET_STALE_MS (6 h) ──
  ipcHandle('sync-character-assets-if-stale', async (event, characterId) => {
    const db = loadDB();
    const account = db.accounts[characterId];
    if (!account) throw new Error('Account not found');
    const characterName = account.characterName;
    const win = BrowserWindow.fromWebContents(event.sender);

    const lastAssetSync = await charInfoDb.getAssetSyncedAt(characterId).catch(() => 0);
    const ageMs = Date.now() - (lastAssetSync || 0);

    if (lastAssetSync && ageMs < ASSET_STALE_MS) {
      const hoursOld = (ageMs / 3_600_000).toFixed(1);
      console.log(`[AssetSync] ${characterName}: assets fresh (${hoursOld}h old) — skipping.`);
      return { skipped: true, characterId, characterName, ageMs };
    }

    console.log(`[AssetSync] ${characterName}: assets stale — syncing…`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('char-sync-progress', { characterId, characterName, step: 'assets', detail: 'Fetching assets (paginated)…' });
    }

    try {
      const r = await syncAssetsInternal(characterId);
      console.log(`[AssetSync] ${characterName}: ✓ ${r.count} assets stored.`);
      if (win && !win.isDestroyed()) {
        win.webContents.send('char-sync-progress', { characterId, characterName, step: 'assets', detail: `✓ ${r.count} assets stored` });
      }
      return { skipped: false, characterId, characterName, count: r.count };
    } catch (e) {
      console.warn(`[AssetSync] ${characterName}: ✗ ${e.message}`);
      if (win && !win.isDestroyed()) {
        win.webContents.send('char-sync-progress', { characterId, characterName, step: 'assets', detail: `✗ ${e.message}` });
      }
      throw e;
    }
  });

  // ─── IPC: Sync assets for a single character ──────────────────────────────
  ipcHandle('sync-assets', async (_, characterId) => {
    return syncAssetsInternal(characterId);
  });

  // ─── IPC: Sync assets for all characters (concurrency-limited) ───────────
  ipcHandle('sync-all-assets', async () => {
    // Check cache first to avoid re-syncing too often (6-hour gate)
    try {
      const cached = readCache('sync_all_assets');
      if (cached && cached.updatedAt && (Date.now() - cached.updatedAt) < (1000 * 60 * 60 * 6)) {
        return cached.result;
      }
    } catch (e) { /* ignore cache errors */ }

    const db       = loadDB();
    const accounts = Object.values(db.accounts || {});
    const result   = { total: 0, characters: [] };

    // Limit concurrency to avoid hammering ESI
    const CONCURRENCY = 4;
    async function workerPool(list, fn) {
      const results = [];
      let i = 0;
      async function worker() {
        while (i < list.length) {
          const idx = i++;
          try {
            results[idx] = await fn(list[idx]);
          } catch (err) {
            results[idx] = { error: err.message };
          }
        }
      }
      const workers = Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker);
      await Promise.all(workers);
      return results;
    }

    const syncResults = await workerPool(accounts, async (account) => {
      try {
        const r = await syncAssetsInternal(account.characterId);
        return { characterId: account.characterId, characterName: account.characterName, count: r.count };
      } catch (err) {
        return { characterId: account.characterId, characterName: account.characterName, error: err.message };
      }
    });

    for (const s of syncResults) {
      if (s.count) result.total += s.count;
      result.characters.push(s);
    }

    try { writeCache('sync_all_assets', { updatedAt: Date.now(), result }, 0.25); } catch (e) {}

    return result;
  });

  // ─── IPC: Repair poisoned / unresolved structure names ───────────────────
  // Cleans up structures that show as "No structure found with that ID!" (an
  // ESI error an old build cached) or the generic "Structure {id}" fallback,
  // then force-re-resolves them through the full locator chain (incl. the
  // zKillboard / adam4eve scrapes that the normal backoff skips). Slow — runs
  // in the background and streams progress via 'repair-progress'.
  ipcHandle('repair-structure-locations', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const report = (msg, done) => {
      console.log(`[Repair] ${msg}`);
      if (win && !win.isDestroyed()) win.webContents.send('repair-progress', { msg, done: !!done });
    };

    // 1. Purge poisoned rows from the shared station cache so they can't be
    //    re-applied to assets on the next sync.
    const purged = await charInfoDb.purgePoisonedStations().catch(() => 0);
    report(`Cleared ${purged} bad cached structure name(s).`);

    const db       = loadDB();
    const accounts = Object.values(db.accounts || {});
    let attempted = 0, resolved = 0;

    for (const acc of accounts) {
      const cid = acc.characterId;
      // 2. Null poisoned / fallback asset location names → marks them unresolved.
      await charInfoDb.clearFallbackAssetLocations(cid).catch(() => {});
      const unresolved = await charInfoDb.getUnresolvedAssetLocations(cid).catch(() => []);
      if (!unresolved.length) continue;
      report(`${acc.characterName}: re-resolving ${unresolved.length} location(s)…`);

      // 3. Force-resolve, concurrency-limited so we don't hammer the scrapers.
      const CONCURRENCY = 6;
      let i = 0, fixed = 0;
      async function worker() {
        while (i < unresolved.length) {
          const id = unresolved[i++];
          attempted++;
          try {
            const geo = await getLocator().resolveLocation(id, cid, true); // force = full chain
            if (geo && (geo.name || geo.solar_system_id)) {
              await charInfoDb.updateAssetLocation(cid, id, geo);
              if (geo.name && !/^(Structure|Location) /.test(geo.name)) { fixed++; resolved++; }
            }
          } catch (_) { /* leave unresolved */ }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unresolved.length) }, worker));
      report(`${acc.characterName}: ✓ ${fixed} resolved.`);
    }

    report(`Done — ${resolved} of ${attempted} structures resolved a real name.`, true);
    return { purged, attempted, resolved };
  });

  // ─── IPC: Wipe ALL assets from the local database ─────────────────────────
  // Settings ▸ Database "Wipe Assets" action. Clears every character's SQLite
  // assets table (incl. orphaned remnants) AND the legacy blueprints.json asset
  // cache, so a stale/broken asset list can be rebuilt cleanly on the next sync.
  // Deliberately leaves the structure/station name caches untouched — those are
  // expensive to re-resolve and unaffected by bad asset rows.
  ipcHandle('wipe-assets', async () => {
    const result = await charInfoDb.wipeAllAssets();

    // Also clear the legacy JSON asset cache (get-all-assets / dashboard fallback).
    try {
      const db = loadDB();
      if (db.assets) { db.assets = {}; saveDB(db); }
    } catch (e) {
      console.warn('[Assets] Failed to clear legacy JSON asset cache:', e.message);
    }

    // Drop the 6-hour "synced all assets" gate so a fresh sync isn't skipped.
    try { writeCache('sync_all_assets', { updatedAt: 0, result: null }, 0.0001); } catch (e) {}

    console.log(`[Assets] Wipe complete — ${result.rows} row(s) across ${result.tables} table(s).`);
    return result;
  });

  // ─── IPC: Get saved assets for a single character (from JSON DB) ──────────
  ipcHandle('get-assets', (_, characterId) => {
    const db = loadDB();
    return db.assets?.[characterId] || null;
  });

  // ─── IPC: Get all assets across all characters (from JSON DB) ────────────
  ipcHandle('get-all-assets', () => {
    const db  = loadDB();
    const all = [];
    for (const [charId, data] of Object.entries(db.assets || {})) {
      const account = db.accounts[charId];
      if (data && data.items) {
        data.items.forEach(asset => all.push({
          ...asset,
          characterId: charId,
          characterName: account?.characterName || 'Unknown',
        }));
      }
    }
    return all;
  });
}

module.exports = { registerAssetHandlers };