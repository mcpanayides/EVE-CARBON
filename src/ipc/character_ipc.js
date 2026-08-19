const { ipcMain } = require('electron');

const { ESI_BASE, Esi } = require('../app_ident');   // one definition — src/shared/esi.js
// Esi.headers({ token }) is the full set: bearer token, identity, and the
// compatibility date. The two raw fetch() calls below sent only the token, so
// they reached CCP anonymous and unpinned — httpGet's wrapper adds the compat
// header for the calls that go through it, and these two do not.

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
// Populated during registration so main.js can hand specific fetchers to other
// subsystems without re-implementing them.
const registered = {};

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

  // ─── IPC: Set autopilot destination in active EVE client ─────────────────────
  // Requires esi-ui.write_waypoint.v1 scope — character must re-auth if missing.
  // clear_other_waypoints=true sets this as the sole destination.
  ipcHandle('set-autopilot-destination', async (_, { characterId, systemId }) => {
    const token = await getValidToken(characterId);
    const url   = `${ESI_BASE}/ui/autopilot/waypoint/?add_to_beginning=false`
                + `&clear_other_waypoints=true&destination_id=${systemId}&datasource=tranquility`;
    const res   = await fetch(url, {
      method:  'POST',
      headers: Esi.headers({ token }),
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
    const headers = Esi.headers({ token });
    const sleep   = ms => new Promise(r => setTimeout(r, ms));
    let first = true, count = 0;
    for (const systemId of systemIds) {
      const url = `${ESI_BASE}/ui/autopilot/waypoint/?add_to_beginning=false`
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
      const url    = `${ESI_BASE}/characters/${characterId}/industry/jobs/?datasource=tranquility`;
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
          `${ESI_BASE}/characters/${characterId}/?datasource=tranquility`,
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
          `${ESI_BASE}/corporations/${corporationId}/industry/jobs/?datasource=tranquility&page=${page}`,
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

  // ─── Mining Ledger ─────────────────────────────────────────────────────────
  const _tokenScopes = (token) => {
    try {
      const c = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      return Array.isArray(c.scp) ? c.scp : (c.scp ? [c.scp] : []);
    } catch (_) { return []; }
  };
  const _corpOf = async (characterId, token) => {
    const key = `corp_of_${characterId}`;
    let id = readCache(key);
    if (!id) {
      const info = await httpGet(`${ESI_BASE}/characters/${characterId}/?datasource=tranquility`,
                                 { Authorization: `Bearer ${token}` });
      id = info && info.corporation_id;
      if (id) writeCache(key, id, 1);   // 24h — corp moves are rare
    }
    return id;
  };

  // Personal mining ledger (ESI /v1/characters/{id}/mining/ — paginated, ~30 days).
  // Scope: esi-industry.read_character_mining.v1. We UPSERT into the local ledger
  // (which outlives ESI's window) and return the merged history.
  ipcHandle('sync-mining-ledger', async (_, characterId) => {
    try {
      const token = await getValidToken(characterId);
      if (!_tokenScopes(token).includes('esi-industry.read_character_mining.v1')) {
        const ledger = await charInfoDb.getMiningLedger(characterId).catch(() => []);
        return { ok: false, reason: 'scope', ledger,
          message: 'Re-authenticate this character to grant mining-ledger access (esi-industry.read_character_mining.v1).' };
      }
      // ESI caches this endpoint for 3600s — hitting it more often just returns the
      // same payload. Self-throttle to that window so callers can poll freely.
      if (readCache(`mining_sync_at_${characterId}`)) {
        const ledger = await charInfoDb.getMiningLedger(characterId);
        return { ok: true, ledger, throttled: true };
      }
      const rows = [];
      let page = 1, xPages = 1;
      do {
        const { data, xPages: xp } = await httpGetFull(
          `${ESI_BASE}/characters/${characterId}/mining/?datasource=tranquility&page=${page}`,
          { Authorization: `Bearer ${token}` }
        );
        if (Array.isArray(data)) rows.push(...data);
        xPages = xp || 1; page++;
      } while (page <= xPages && page <= 20);

      await charInfoDb.upsertMiningLedger(characterId, rows);
      writeCache(`mining_sync_at_${characterId}`, Date.now(), 1 / 24);   // 1-hour ESI cadence
      const ledger = await charInfoDb.getMiningLedger(characterId);
      return { ok: true, ledger, syncedAt: Date.now(), fetched: rows.length };
    } catch (e) {
      const msg    = e.message || String(e);
      const ledger = await charInfoDb.getMiningLedger(characterId).catch(() => []);
      if (/^HTTP 403\b/.test(msg)) {
        return { ok: false, reason: 'scope', ledger,
          message: 'Re-authenticate this character to grant mining-ledger access (esi-industry.read_character_mining.v1).' };
      }
      return { ok: false, reason: 'error', message: msg, ledger };
    }
  });

  // Stored ledger only (no ESI) — fast path for switching characters.
  ipcHandle('get-mining-ledger-db', async (_, characterId) => {
    return charInfoDb.getMiningLedger(characterId);
  });

  // Corp mining observers + their per-character pull ledgers (moon drills).
  // NOTE: the corp mining routes use singular "/corporation/" (an ESI quirk),
  // unlike most corp endpoints. Scope: esi-industry.read_corporation_mining.v1 +
  // in-game Station Manager/Accountant role (else 403 → back off 6h).
  ipcHandle('get-corp-mining-observers', async (_, characterId) => {
    let corporationId = null;
    try {
      const token = await getValidToken(characterId);
      if (!_tokenScopes(token).includes('esi-industry.read_corporation_mining.v1')) return { ok: false, reason: 'scope' };
      corporationId = await _corpOf(characterId, token);
      if (!corporationId) return { ok: false, reason: 'error', message: 'No corporation.' };
      if (readCache(`mining_obs_noaccess_${corporationId}`)) return { ok: false, reason: 'role' };
      const cacheKey = `mining_observers_${corporationId}`;
      const cached   = readCache(cacheKey);
      if (cached) return cached;

      const observers = [];
      let page = 1, xPages = 1;
      do {
        const { data, xPages: xp } = await httpGetFull(
          `${ESI_BASE}/corporation/${corporationId}/mining/observers/?datasource=tranquility&page=${page}`,
          { Authorization: `Bearer ${token}` }
        );
        if (Array.isArray(data)) observers.push(...data);
        xPages = xp || 1; page++;
      } while (page <= xPages && page <= 20);

      const entries = [];
      for (const obs of observers.slice(0, 50)) {   // cap to keep the ESI budget sane
        let p2 = 1, xp2 = 1;
        do {
          const { data, xPages: xx } = await httpGetFull(
            `${ESI_BASE}/corporation/${corporationId}/mining/observers/${obs.observer_id}/?datasource=tranquility&page=${p2}`,
            { Authorization: `Bearer ${token}` }
          );
          if (Array.isArray(data)) data.forEach(d => entries.push({
            ...d, observer_id: obs.observer_id, observer_type: obs.observer_type, observer_last_updated: obs.last_updated,
          }));
          xp2 = xx || 1; p2++;
        } while (p2 <= xp2 && p2 <= 20);
      }

      const charIds = [...new Set(entries.map(e => e.character_id).filter(Boolean))];
      const nameMap = charIds.length ? await resolveNames(charIds) : {};
      const result  = { ok: true, corporationId, observers,
        entries: entries.map(e => ({ ...e, character_name: nameMap[e.character_id] || `Char ${e.character_id}` })) };
      writeCache(cacheKey, result, 30 / 1440);   // 30-minute cache
      return result;
    } catch (e) {
      const msg = e.message || String(e);
      if (/^HTTP 403\b/.test(msg)) { if (corporationId) writeCache(`mining_obs_noaccess_${corporationId}`, true, 0.25); return { ok: false, reason: 'role' }; }
      return { ok: false, reason: 'error', message: msg };
    }
  });

  // Upcoming/past moon extractions (chunk arrival times) for the corp.
  ipcHandle('get-corp-mining-extractions', async (_, characterId) => {
    let corporationId = null;
    try {
      const token = await getValidToken(characterId);
      if (!_tokenScopes(token).includes('esi-industry.read_corporation_mining.v1')) return { ok: false, reason: 'scope' };
      corporationId = await _corpOf(characterId, token);
      if (!corporationId) return { ok: false, reason: 'error', message: 'No corporation.' };
      if (readCache(`mining_ext_noaccess_${corporationId}`)) return { ok: false, reason: 'role' };
      const cacheKey = `mining_extractions_${corporationId}`;
      const cached   = readCache(cacheKey);
      if (cached) return cached;

      const rows = [];
      let page = 1, xPages = 1;
      do {
        const { data, xPages: xp } = await httpGetFull(
          `${ESI_BASE}/corporation/${corporationId}/mining/extractions/?datasource=tranquility&page=${page}`,
          { Authorization: `Bearer ${token}` }
        );
        if (Array.isArray(data)) rows.push(...data);
        xPages = xp || 1; page++;
      } while (page <= xPages && page <= 20);

      const moonIds = [...new Set(rows.map(r => r.moon_id).filter(Boolean))];
      const nameMap = moonIds.length ? await resolveNames(moonIds) : {};
      const result  = { ok: true, corporationId,
        extractions: rows.map(r => ({ ...r, moon_name: nameMap[r.moon_id] || `Moon ${r.moon_id}` })) };
      writeCache(cacheKey, result, 30 / 1440);   // 30-minute cache
      return result;
    } catch (e) {
      const msg = e.message || String(e);
      if (/^HTTP 403\b/.test(msg)) { if (corporationId) writeCache(`mining_ext_noaccess_${corporationId}`, true, 0.25); return { ok: false, reason: 'role' }; }
      return { ok: false, reason: 'error', message: msg };
    }
  });

  // ─── IPC: Personal Faction Warfare stats ─────────────────────────────────
  // /v1/characters/{id}/fw/stats/ — scope esi-characters.read_fw_stats.v1. Returns
  // faction_id (0 = not enlisted), current/highest rank, kills and victory points.
  ipcHandle('get-character-fw-stats', async (_, characterId) => {
    try {
      const token = await getValidToken(characterId);
      if (!_tokenScopes(token).includes('esi-characters.read_fw_stats.v1')) {
        return { ok: false, reason: 'scope',
          message: 'Re-authenticate this character to grant Faction Warfare stats (esi-characters.read_fw_stats.v1).' };
      }
      const cacheKey = `fw_char_stats_${characterId}`;
      const cached   = readCache(cacheKey);
      if (cached) return cached;
      const stats = await httpGet(
        `${ESI_BASE}/characters/${characterId}/fw/stats/?datasource=tranquility`,
        { Authorization: `Bearer ${token}` }
      );
      const result = { ok: true, stats: stats || {} };
      writeCache(cacheKey, result, 30 / 1440);   // 30-minute cache
      return result;
    } catch (e) {
      const msg = e.message || String(e);
      if (/^HTTP 403\b/.test(msg)) return { ok: false, reason: 'scope',
        message: 'Re-authenticate this character to grant Faction Warfare stats (esi-characters.read_fw_stats.v1).' };
      return { ok: false, reason: 'error', message: msg };
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
      const url   = `${ESI_BASE}/characters/${characterId}/skillqueue/?datasource=tranquility`;
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

  // ─── IPC: zKillboard PvP stats (public API, no auth) ─────────────────────
  // Compact all-time stats + ranks for the dashboard banner. zKill asks
  // consumers to cache aggressively — ranks only recalculate daily, so 1 hour
  // fresh + a long stale fallback keeps us polite and the banner instant.
  // Returns null when the character has no killboard presence or zKill is
  // unreachable; the banner section simply stays hidden.
  // `kind` is 'character' (default, so the dashboard banner's one-arg call still
  // works) or 'corporation' — the Killboard's corp overviews reuse this.
  ipcHandle('get-zkill-stats', async (_, entityId, kind = 'character') => {
    const characterId = entityId;                         // URL/id below reads this
    const ek = kind === 'corporation' ? 'corporation' : 'character';
    const cacheKey = `zkill_stats_v4_${ek}_${entityId}`;
    const cached   = readCache(cacheKey);
    if (cached) return cached;
    try {
      // The bare .../stats/characterID/{id}/ URL now 302s to .../kills/, and
      // httpGet doesn't follow redirects — it just failed to parse the empty
      // body and returned null, which silently blanked this everywhere it's
      // used (the dashboard banner's rank column simply stayed hidden).
      // Request the redirect target directly; the payload is unchanged and
      // still carries shipsDestroyed / iskDestroyed / rankings / rankHistory.
      const raw = require('../demo_mode').isEnabled()
        ? require('../demo_fixtures').zkillStats(ek, characterId)
        : await httpGet(`https://zkillboard.com/api/stats/${ek}ID/${characterId}/kills/`);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

      // Rank trend: current rank vs the oldest snapshot in zKill's rankHistory
      // window (~the past week). Lower rank number = better placing.
      //   +1 climbing · -1 falling · 0 flat/unknown
      const trendOf = (cur, prev) =>
        (typeof cur !== 'number' || typeof prev !== 'number' || cur === prev) ? 0 : (cur < prev ? 1 : -1);

      // One period ("alltime" | "recent" 90d | "weekly" 7d) → compact ranks +
      // trends, or null when zKill has no ranking for it (e.g. no kills this week
      // — zKill then encodes the period as an empty array).
      const periodOf = (name) => {
        const p     = raw.rankings && raw.rankings[name] && raw.rankings[name].all;
        const ranks = p && p.ranks;
        if (!ranks || typeof ranks.overall !== 'number') return null;
        let prevRanks = null, prevMetrics = null;
        const hist = raw.rankHistory && raw.rankHistory[name] && raw.rankHistory[name].all;
        if (hist && typeof hist === 'object' && !Array.isArray(hist)) {
          const days = Object.keys(hist).sort();
          if (days.length) {
            const oldest = hist[days[0]] || {};
            prevRanks   = oldest.ranks   || null;
            prevMetrics = oldest.metrics || null;
          }
        }
        // Ship efficiency at display precision (0.1%) — the trend arrow should
        // only appear when the figure the user actually sees has moved.
        const effOf = m => (m && (m.shipsDestroyed || 0) + (m.shipsLost || 0) > 0)
          ? Math.round(((m.shipsDestroyed || 0) / ((m.shipsDestroyed || 0) + (m.shipsLost || 0))) * 1000) / 10
          : null;
        const eff = effOf(p.metrics), prevEff = effOf(prevMetrics);
        return {
          overall:        ranks.overall,
          shipsDestroyed: ranks.shipsDestroyed ?? null,
          shipsLost:      ranks.shipsLost ?? null,
          efficiency:     eff,
          trend: {
            overall:        trendOf(ranks.overall,        prevRanks && prevRanks.overall),
            shipsDestroyed: trendOf(ranks.shipsDestroyed, prevRanks && prevRanks.shipsDestroyed),
            shipsLost:      trendOf(ranks.shipsLost,      prevRanks && prevRanks.shipsLost),
            // Efficiency: higher = better (opposite sense to ranks, where lower wins).
            efficiency:     (eff == null || prevEff == null || eff === prevEff) ? 0 : (eff > prevEff ? 1 : -1),
          },
        };
      };

      const result = {
        shipsDestroyed: raw.shipsDestroyed || 0,
        shipsLost:      raw.shipsLost      || 0,
        iskDestroyed:   raw.iskDestroyed   || 0,
        iskLost:        raw.iskLost        || 0,
        soloKills:      raw.soloKills      || 0,
        dangerRatio:    raw.dangerRatio ?? null,
        gangRatio:      raw.gangRatio   ?? null,
        periods: {
          alltime: periodOf('alltime'),
          recent:  periodOf('recent'),    // 90 days
          weekly:  periodOf('weekly'),    // 7 days
        },
      };
      writeCache(cacheKey, result, 1 / 24);        // 1-hour cache
      writeCache(`${cacheKey}_stale`, result, 30); // 30-day stale fallback
      return result;
    } catch (e) {
      const stale = readCache(`${cacheKey}_stale`);
      if (stale) return stale;
      console.warn(`get-zkill-stats failed for ${characterId}:`, e.message || e);
      return null;
    }
  });

  // ─── IPC: zKillboard killmail feed (public API, no auth) ─────────────────
  // The character's recent kills and losses. zKill returns the whole killmail
  // inline these days (victim, attackers, ship, system, time) alongside its own
  // `zkb` value block, so one request covers the entire feed — no follow-up ESI
  // call per killmail. No scope needed either, which is why the Killboard works
  // without re-authenticating a character.
  //
  // We normalise here and deliberately drop victim.items: a 200-entry feed with
  // full fitting lists is megabytes of IPC payload for data the list never shows.
  // Cached 10 minutes (zKill asks consumers to cache aggressively) with a long
  // stale fallback so the page still renders if zKill is having a moment.
  // `kind` is 'character' or 'corporation'. Corp feeds show every kill/loss the
  // corp was on (not just the logged-in pilot), which is what powers the
  // Killboard's corp overviews. isLoss is judged against the matching id field.
  // Extracted so the intel early-warning service can reuse this EXACT path —
  // same cache key, same 10-minute TTL, same stale fallback. Opening a second
  // route to zKillboard would double the request rate against an API that
  // explicitly asks consumers to cache hard.
  async function fetchZkillFeed(kind, entityId, page = 1) {
    if (!entityId) return null;
    const ek = kind === 'corporation' ? 'corporation' : 'character';
    const cacheKey = `zkill_feed_v2_${ek}_${entityId}_p${page}`;
    const cached   = readCache(cacheKey);
    if (cached) return cached;
    try {
      const url = `https://zkillboard.com/api/${ek}ID/${entityId}/page/${page}/`;
      // Demo mode answers with canned RAW killmails, not finished rows: the
      // mapping below then runs for real, so the fixture exercises the same code
      // a live feed would. A screenshot of a real killboard publishes what its
      // owner flies and loses, which is why this page is faked at all.
      const raw = require('../demo_mode').isEnabled()
        ? require('../demo_fixtures').zkillFeed(ek, entityId, page)
        : await httpGet(url);
      if (!Array.isArray(raw)) return null;

      const numId = Number(entityId);
      const rows = raw.map(k => {
        const v         = k.victim || {};
        const attackers = Array.isArray(k.attackers) ? k.attackers : [];
        const zkb       = k.zkb || {};
        // A loss when the matching id is the victim; otherwise it's a kill.
        const isLoss    = ek === 'corporation'
          ? Number(v.corporation_id) === numId
          : Number(v.character_id) === numId;
        const finalBlow = attackers.find(a => a.final_blow) || attackers[0] || {};
        // On a kill, "who we shot" is the victim; on a loss, the notable other
        // party is whoever landed the final blow.
        return {
          killmailId:   k.killmail_id,
          hash:         zkb.hash || null,
          time:         k.killmail_time,
          systemId:     k.solar_system_id,
          isLoss,
          victimCharId:     v.character_id     || null,
          victimCorpId:     v.corporation_id   || null,
          victimAllianceId: v.alliance_id      || null,
          victimShipTypeId: v.ship_type_id     || null,
          finalBlowCharId:     finalBlow.character_id  || null,
          finalBlowShipTypeId: finalBlow.ship_type_id  || null,
          attackerCount: attackers.length,
          totalValue:    Number(zkb.totalValue) || 0,
          points:        Number(zkb.points) || 0,
          npc:           !!zkb.npc,
          solo:          !!zkb.solo,
          awox:          !!zkb.awox,
        };
      });
      writeCache(cacheKey, rows, 1 / 144);          // ~10 minutes
      writeCache(`${cacheKey}_stale`, rows, 30);    // 30-day stale fallback
      return rows;
    } catch (e) {
      const stale = readCache(`${cacheKey}_stale`);
      if (stale) return stale;
      console.warn(`get-zkill-feed failed for ${ek} ${entityId}:`, e.message || e);
      return null;
    }
  }

  ipcHandle('get-zkill-feed', (_, kind, entityId, page = 1) => fetchZkillFeed(kind, entityId, page));
  registered.fetchZkillFeed = fetchZkillFeed;

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
        `${ESI_BASE}/characters/${characterId}/orders/?datasource=tranquility`,
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
      const url           = `${ESI_BASE}/characters/${characterId}/wallet/?datasource=tranquility`;
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

module.exports = { registerCharacterHandlers, registered };