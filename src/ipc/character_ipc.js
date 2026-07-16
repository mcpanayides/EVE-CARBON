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
 * @param {function} deps.httpGetFull      - like httpGet but also returns the X-Pages header
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
  httpGetFull,
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

  // ─── IPC: Set a multi-stop autopilot ROUTE in the active EVE client ──────────
  // Sets each system in `systemIds` as an ordered waypoint (first one clears any
  // existing route, the rest append). The in-game autopilot routes gate segments
  // between them; wormhole/bridge hops aren't gate-connected, so the player flies
  // those manually. Requires esi-ui.write_waypoint.v1 + the character logged into a
  // running client. Returns { success, count }.
  ipcHandle('set-autopilot-route', async (_, { characterId, systemIds }) => {
    if (!Array.isArray(systemIds) || !systemIds.length) throw new Error('No route to send.');
    const token   = await getValidToken(characterId);
    const headers = { Authorization: `Bearer ${token}` };
    const sleep   = ms => new Promise(r => setTimeout(r, ms));
    let first = true, count = 0;
    for (const systemId of systemIds) {
      const url = `${ESI_BASE}/v2/ui/autopilot/waypoint/?add_to_beginning=false`
                + `&clear_other_waypoints=${first}&destination_id=${systemId}&datasource=tranquility`;
      const res = await fetch(url, { method: 'POST', headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 401 || /Client could not be found|not valid for|Unauthorized/.test(body)) {
          throw new Error(first
            ? 'Open EVE and log in this character first (and re-auth it if waypoints were never granted).'
            : `Set ${count} waypoint(s), then ESI errored: ${body}`);
        }
        throw new Error(`ESI waypoint ${res.status}: ${body}`);
      }
      first = false; count++;
      await sleep(150);   // be gentle on the UI endpoint
    }
    return { success: true, count };
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

      writeCache(cacheKey, result, 5 / 1440);     // 5-minute cache
      writeCache(`${cacheKey}_stale`, result, 30); // 30-day stale fallback for 429s
      return result;
    } catch (e) {
      // On a rate-limit (common during the cold-start ESI burst) return the last
      // known jobs rather than an empty list so the widget doesn't blank out.
      if (e.isRateLimit) {
        const stale = readCache(`${cacheKey}_stale`);
        if (stale) return stale;
      }
      console.warn('Failed to load active jobs:', e.message || e);
      return [];
    }
  });

  // ─── IPC: Corporation industry jobs (ESI, active) ────────────────────────────
  // Corp-hangar research/manufacturing jobs for the character's corporation, for
  // the active-jobs surfaces (Industry tab + dashboard widgets). ESI gates this
  // behind the esi-industry.read_corporation_jobs.v1 scope on the token AND the
  // in-game Factory Manager role; both are probed gracefully so characters
  // without corp access just contribute nothing:
  //   • scope missing from the token → skip silently, no ESI call at all
  //   • ESI 403 (no role)            → remember per-corp for 6h so the widget
  //     refresh loop doesn't drain the shared ESI error budget
  // Cached per-corporation (5 min + 30-day stale) so same-corp alts share one
  // fetch — the renderer may call this once per account at no extra ESI cost.
  ipcHandle('get-corp-active-jobs', async (_, characterId) => {
    const CORP_JOBS_SCOPE = 'esi-industry.read_corporation_jobs.v1';
    let corporationId = null;
    try {
      const token = await getValidToken(characterId);

      // Scope probe — the ESI access token is a JWT listing granted scopes in `scp`.
      let scopes = [];
      try {
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        scopes = Array.isArray(claims.scp) ? claims.scp : (claims.scp ? [claims.scp] : []);
      } catch (_) { /* unparseable token → treat as no scope */ }
      if (!scopes.includes(CORP_JOBS_SCOPE)) return [];

      // Character → corporation (public info; corp moves are rare, cache 24h).
      const corpKey = `corp_of_${characterId}`;
      corporationId = readCache(corpKey);
      if (!corporationId) {
        const info = await httpGet(
          `${ESI_BASE}/v5/characters/${characterId}/?datasource=tranquility`,
          { Authorization: `Bearer ${token}` }
        );
        corporationId = info && info.corporation_id;
        if (!corporationId) return [];
        writeCache(corpKey, corporationId, 1);   // 24 hours
      }

      if (readCache(`jobs_corp_noaccess_${corporationId}`)) return [];
      const cacheKey = `jobs_corp_active_${corporationId}`;
      const cached   = readCache(cacheKey);
      if (cached) return cached;

      // Paginated endpoint — follow X-Pages so a busy industry corp isn't cut off.
      const jobs = [];
      let page = 1, xPages = 1;
      do {
        const { data, xPages: xp } = await httpGetFull(
          `${ESI_BASE}/latest/corporations/${corporationId}/industry/jobs/?datasource=tranquility&page=${page}`,
          { Authorization: `Bearer ${token}` }
        );
        if (Array.isArray(data)) jobs.push(...data);
        xPages = xp || 1;
        page++;
      } while (page <= xPages && page <= 20);

      // Resolve system + installer names in one batch (/universe/names takes both).
      const systemIds    = [...new Set(jobs.filter(j => j.solar_system_id).map(j => j.solar_system_id))];
      const installerIds = [...new Set(jobs.filter(j => j.installer_id).map(j => j.installer_id))];
      const allIds       = [...systemIds, ...installerIds];
      const nameMap      = allIds.length ? await resolveNames(allIds) : {};
      const result = jobs.map(job => ({
        ...job,
        is_corp_job:       true,
        corporation_id:    corporationId,
        solar_system_name: nameMap[job.solar_system_id] || `System ${job.solar_system_id || 'Unknown'}`,
        installer_name:    nameMap[job.installer_id] || null,
      }));

      writeCache(cacheKey, result, 5 / 1440);      // 5-minute cache
      writeCache(`${cacheKey}_stale`, result, 30); // 30-day stale fallback for 429s
      return result;
    } catch (e) {
      if (/^HTTP 403\b/.test(e.message || '')) {
        // Scope present but no Factory Manager role — back off for 6 hours.
        if (corporationId) writeCache(`jobs_corp_noaccess_${corporationId}`, true, 0.25);
        return [];
      }
      if (e.isRateLimit && corporationId) {
        const stale = readCache(`jobs_corp_active_${corporationId}_stale`);
        if (stale) return stale;
      }
      console.warn('Failed to load corp jobs:', e.message || e);
      return [];
    }
  });

  // ─── IPC: Skill queue (ESI live) ─────────────────────────────────────────
  // Returns the character's training queue with skill names resolved.
  // Scope: esi-skills.read_skillqueue.v1 (already requested at auth time).
  // Short cache (5 min) — the queue only changes when the player edits it.
  ipcHandle('get-skill-queue', async (_, characterId) => {
    const cacheKey = `skillqueue_${characterId}`;
    const cached   = readCache(cacheKey);
    if (cached) return cached;

    try {
      const token = await getValidToken(characterId);
      const url   = `${ESI_BASE}/v2/characters/${characterId}/skillqueue/?datasource=tranquility`;
      const queue = await httpGet(url, { Authorization: `Bearer ${token}` });
      if (!Array.isArray(queue)) return [];

      const skillIds = [...new Set(queue.map(q => q.skill_id).filter(Boolean))];
      const nameMap  = skillIds.length ? await resolveNames(skillIds) : {};
      const result   = queue
        .sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0))
        .map(q => ({ ...q, skill_name: nameMap[q.skill_id] || `Skill ${q.skill_id}` }));

      writeCache(cacheKey, result, 5 / 1440);     // 5-minute cache
      writeCache(`${cacheKey}_stale`, result, 30); // 30-day stale fallback for 429s
      return result;
    } catch (e) {
      // Fall back to the last known queue on a rate-limit rather than blanking out.
      if (e.isRateLimit) {
        const stale = readCache(`${cacheKey}_stale`);
        if (stale) return stale;
      }
      console.warn(`get-skill-queue failed for ${characterId}:`, e.message || e);
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

  // ─── IPC: Character market orders ────────────────────────────────────────
  // Active buy + sell orders. Used by the dashboard escrow calc and the Market
  // Orders widget. Short cache (5 min) + stale fallback so a rate-limit doesn't
  // blank the widget.
  ipcHandle('get-character-orders', async (_, characterId) => {
    const cacheKey = `orders_active_${characterId}`;
    const cached   = readCache(cacheKey);
    if (cached) return cached;
    try {
      const token  = await getValidToken(characterId);
      const orders = await httpGet(
        `${ESI_BASE}/v2/characters/${characterId}/orders/?datasource=tranquility`,
        { Authorization: `Bearer ${token}` }
      );
      const result = Array.isArray(orders) ? orders : [];
      writeCache(cacheKey, result, 5 / 1440);      // 5-minute cache
      writeCache(`${cacheKey}_stale`, result, 30); // 30-day stale fallback
      return result;
    } catch (e) {
      if (e.isRateLimit) {
        const stale = readCache(`${cacheKey}_stale`);
        if (stale) return stale;
      }
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

  // ─── IPC: Wallet balance (ESI live, DB snapshot fallback) ────────────────
  // Falls back to the latest local wallet snapshot when the live ESI call fails
  // (e.g. the cold-start rate-limit burst) so callers never see a spurious 0.
  const _latestWalletSnapshot = async (characterId) => {
    try {
      const snap = await charInfoDb.getWalletBalanceBefore(characterId, Date.now());
      return typeof snap === 'number' ? snap : null;
    } catch (_) { return null; }
  };
  ipcHandle('get-wallet', async (_, characterId) => {
    try {
      const token         = await getValidToken(characterId);
      const url           = `${ESI_BASE}/v1/characters/${characterId}/wallet/?datasource=tranquility`;
      const walletBalance = await httpGet(url, { Authorization: `Bearer ${token}` });
      if (typeof walletBalance === 'number') return walletBalance;
      const snap = await _latestWalletSnapshot(characterId);
      return snap != null ? snap : 0;
    } catch (e) {
      console.warn(`Failed to fetch wallet for ${characterId}:`, e.message || e);
      const snap = await _latestWalletSnapshot(characterId);
      return snap != null ? snap : 0;
    }
  });

  // ─── IPC: Wallet journal / transactions / loyalty points (from CharDB) ───
  ipcHandle('get-wallet-journal', async (_, characterId) => {
    return charInfoDb.getWalletJournal(characterId);
  });

  // Wallet balance from the latest snapshot at/before `beforeTs` (24h-change ticker).
  ipcHandle('get-wallet-balance-before', async (_, characterId, beforeTs) => {
    return charInfoDb.getWalletBalanceBefore(characterId, beforeTs);
  });

  ipcHandle('get-wallet-transactions', async (_, characterId) => {
    return charInfoDb.getWalletTransactions(characterId);
  });

  ipcHandle('get-loyalty-points', async (_, characterId) => {
    return charInfoDb.getLoyaltyPoints(characterId);
  });
}

module.exports = { registerCharacterHandlers };