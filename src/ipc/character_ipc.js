const { ipcMain } = require('electron');

const ESI_BASE = 'https://esi.evetech.net';

/**
 * registerCharacterHandlers
 *
 * @param {object} deps
 * @param {object}   deps.charInfoDb       - character SQLite helper module
 * @param {function} deps.loadDB           - loads the JSON database
 * @param {function} deps.getValidToken    - returns a valid ESI access token for a characterId
 * @param {function} deps.httpGet          - authenticated HTTP GET helper
 * @param {function} deps.resolveNames     - resolves typeIds/systemIds to name map
 * @param {function} deps.readCache        - reads from persistent cache
 * @param {function} deps.writeCache       - writes to persistent cache
 */
function registerCharacterHandlers({
  ipcHandle,
  charInfoDb,
  loadDB,
  getValidToken,
  httpGet,
  resolveNames,
  readCache,
  writeCache,
}) {

  // ─── IPC: CharDB reads (SQLite — no ESI call) ─────────────────────────────
  ipcHandle('get-character-info-db', async (_, characterId) => {
    return charInfoDb.getCharacterData(characterId);
  });

  ipcHandle('get-character-assets-db', async (_, characterId) => {
    return charInfoDb.getCharacterAssets(characterId);
  });

  // Cheap freshness probe — one MAX(synced_at) query, no full asset read.
  // The dashboard uses this to decide whether a character's cached asset value
  // is still valid without re-reading (and re-pricing) every asset row.
  ipcHandle('get-asset-synced-at', async (_, characterId) => {
    return charInfoDb.getAssetSyncedAt(characterId);
  });

  ipcHandle('get-character-blueprints-db', async (_, characterId) => {
    return charInfoDb.getCharacterBlueprints(characterId);
  });

  // ─── IPC: All blueprints from DB (all synced characters) ─────────────────
  // Reads char_{id}_blueprints tables directly from character_information.db.
  // Returns a flat array of blueprint rows, each augmented with characterId
  // and characterName from the accounts store.
  // Called by: loadBlueprintLibrary() in blueprints.js
  ipcHandle('get-all-blueprints-from-db', async () => {
    const db       = loadDB();
    const accounts = db.accounts || {};
    const all      = [];

    for (const [charIdStr, account] of Object.entries(accounts)) {
      const characterId   = Number(charIdStr);
      const characterName = account.characterName || 'Unknown';

      try {
        const rows = await charInfoDb.getCharacterBlueprints(characterId);
        if (Array.isArray(rows)) {
          rows.forEach(row => all.push({ ...row, characterId, characterName }));
        }
      } catch (e) {
        console.warn(`[get-all-blueprints-from-db] Skipped character ${characterId}: ${e.message}`);
      }
    }

    return all;
  });

  // ─── IPC: Character jobs ──────────────────────────────────────────────────
  // Completed jobs never change — cache aggressively to avoid hammering ESI.
  // This is the single biggest source of 429s in the dashboard refresh loop.
  ipcHandle('get-character-jobs', async (_, characterId) => {
    const cacheKey = `jobs_completed_${characterId}`;
    const cached   = readCache(cacheKey);
    if (cached) return cached;

    try {
      const token  = await getValidToken(characterId);
      const url    = `${ESI_BASE}/latest/characters/${characterId}/industry/jobs/?datasource=tranquility&status=completed`;
      const jobs   = await httpGet(url, { Authorization: `Bearer ${token}` });
      if (!Array.isArray(jobs)) return [];

      const systemIds = [...new Set(jobs.filter(j => j.solar_system_id).map(j => j.solar_system_id))];
      const nameMap   = systemIds.length ? await resolveNames(systemIds) : {};
      const result    = jobs.map(job => ({
        ...job,
        solar_system_name: nameMap[job.solar_system_id] || `System ${job.solar_system_id || 'Unknown'}`,
      }));

      writeCache(cacheKey, result, 1);           // 24 hours — completed jobs never change
      writeCache(`${cacheKey}_stale`, result, 30); // 30-day stale fallback for 429 situations
      return result;
    } catch (e) {
      if (e.isRateLimit) {
        // On a 429, return whatever stale cache we have rather than an empty array
        // so the dashboard doesn't blank out the jobs table.
        const stale = readCache(`${cacheKey}_stale`);
        if (stale) return stale;
      }
      console.warn('Failed to load character jobs:', e.message || e);
      return [];
    }
  });

  // ─── IPC: Set autopilot destination in active EVE client ─────────────────────
  // Requires esi-ui.write_waypoint.v1 scope — character must re-auth if missing.
  // clear_other_waypoints=true sets this as the sole destination.
  ipcHandle('set-autopilot-destination', async (_, { characterId, systemId }) => {
    const token = await getValidToken(characterId);
    const url   = `${ESI_BASE}/v2/ui/autopilot/waypoint/?add_to_beginning=false`
                + `&clear_other_waypoints=true&destination_id=${systemId}&datasource=tranquility`;
    const res   = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const desc = (parsed?.error_description || parsed?.error || body).toString();
      if (
        desc.includes('Client could not be found') ||
        desc.includes('not valid for') ||
        desc.includes('Unauthorized') ||
        res.status === 401
      ) {
        throw new Error('Re-authenticate this character to enable autopilot control: Characters page → remove the character → re-add via SSO.');
      }
      throw new Error(`ESI waypoint ${res.status}: ${body}`);
    }
    return { success: true };
  });

  // ─── IPC: Active industry jobs (ESI, no ?status=completed) ──────────────────
  // Returns jobs with status active | ready | paused — never delivered.
  // Short cache (5 min) so the progress bars stay reasonably accurate.
  ipcHandle('get-character-active-jobs', async (_, characterId) => {
    const cacheKey = `jobs_active_${characterId}`;
    const cached   = readCache(cacheKey);
    if (cached) return cached;

    try {
      const token  = await getValidToken(characterId);
      const url    = `${ESI_BASE}/latest/characters/${characterId}/industry/jobs/?datasource=tranquility`;
      const jobs   = await httpGet(url, { Authorization: `Bearer ${token}` });
      if (!Array.isArray(jobs)) return [];

      const systemIds = [...new Set(jobs.filter(j => j.solar_system_id).map(j => j.solar_system_id))];
      const nameMap   = systemIds.length ? await resolveNames(systemIds) : {};
      const result    = jobs.map(job => ({
        ...job,
        solar_system_name: nameMap[job.solar_system_id] || `System ${job.solar_system_id || 'Unknown'}`,
      }));

      writeCache(cacheKey, result, 5 / 1440); // 5-minute cache
      return result;
    } catch (e) {
      if (e.isRateLimit) {
        const stale = readCache(`${cacheKey}_stale`);
        if (stale) return stale;
      }
      console.warn('Failed to load active jobs:', e.message || e);
      return [];
    }
  });

  // ─── IPC: Character public info (ESI) ────────────────────────────────────
  ipcHandle('get-character-info', async (_, characterId) => {
    try {
      const token = await getValidToken(characterId);
      return await httpGet(
        `${ESI_BASE}/v5/characters/${characterId}/?datasource=tranquility`,
        { Authorization: `Bearer ${token}` }
      );
    } catch (e) {
      console.warn(`get-character-info failed for ${characterId}:`, e.message);
      return null;
    }
  });

  // ─── IPC: Clones / home location ─────────────────────────────────────────
  ipcHandle('get-clones', async (_, characterId) => {
    try {
      const token = await getValidToken(characterId);
      return await httpGet(
        `${ESI_BASE}/v3/characters/${characterId}/clones/?datasource=tranquility`,
        { Authorization: `Bearer ${token}` }
      );
    } catch (e) {
      console.warn(`get-clones failed for ${characterId}:`, e.message);
      return null;
    }
  });

  // ─── IPC: PI colonies (from CharDB) ──────────────────────────────────────
  ipcHandle('get-pi-colonies', async (_, characterId) => {
    return charInfoDb.getCharacterPIColonies(characterId);
  });

  // ─── IPC: Character market orders (for escrow) ───────────────────────────
  // Returns active buy orders — their 'escrow' field is ISK locked up.
  ipcHandle('get-character-orders', async (_, characterId) => {
    try {
      const token  = await getValidToken(characterId);
      const orders = await httpGet(
        `${ESI_BASE}/v2/characters/${characterId}/orders/?datasource=tranquility`,
        { Authorization: `Bearer ${token}` }
      );
      return Array.isArray(orders) ? orders : [];
    } catch (e) {
      console.warn(`get-character-orders failed for ${characterId}:`, e.message);
      return [];
    }
  });

  // ─── IPC: Character contracts (for escrow) ───────────────────────────────
  // Returns all contracts; we sum 'price' on outstanding buyer contracts.
  ipcHandle('get-character-contracts', async (_, characterId) => {
    try {
      const token     = await getValidToken(characterId);
      const contracts = await httpGet(
        `${ESI_BASE}/v1/characters/${characterId}/contracts/?datasource=tranquility`,
        { Authorization: `Bearer ${token}` }
      );
      return Array.isArray(contracts) ? contracts : [];
    } catch (e) {
      console.warn(`get-character-contracts failed for ${characterId}:`, e.message);
      return [];
    }
  });

  // ─── IPC: Wallet balance (ESI live) ──────────────────────────────────────
  ipcHandle('get-wallet', async (_, characterId) => {
    try {
      const token         = await getValidToken(characterId);
      const url           = `${ESI_BASE}/v1/characters/${characterId}/wallet/?datasource=tranquility`;
      const walletBalance = await httpGet(url, { Authorization: `Bearer ${token}` });
      return typeof walletBalance === 'number' ? walletBalance : 0;
    } catch (e) {
      console.warn(`Failed to fetch wallet for ${characterId}:`, e.message || e);
      return 0;
    }
  });

  // ─── IPC: Wallet journal / transactions / loyalty points (from CharDB) ───
  ipcHandle('get-wallet-journal', async (_, characterId) => {
    return charInfoDb.getWalletJournal(characterId);
  });

  ipcHandle('get-wallet-transactions', async (_, characterId) => {
    return charInfoDb.getWalletTransactions(characterId);
  });

  ipcHandle('get-loyalty-points', async (_, characterId) => {
    return charInfoDb.getLoyaltyPoints(characterId);
  });
}

module.exports = { registerCharacterHandlers };