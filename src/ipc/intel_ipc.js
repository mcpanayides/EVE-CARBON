'use strict';
//
// IPC for the intel early-warning system.
//
// The service itself lives in the main process (src/intel/intel_service.js)
// because that's where the SDE is; this exposes it to the renderer and pushes
// reports and alerts out as they happen.
//
// Reports are BATCHED before being sent. A busy intel channel produces bursts —
// six people reporting one gang within a second — and one IPC message plus one
// DOM update per line would have the renderer re-rendering the feed dozens of
// times a second during exactly the fight where the UI needs to stay responsive.
// Alerts are NOT batched: those are the whole point and go straight through.

const { BrowserWindow } = require('electron');
const fs   = require('fs');
const path = require('path');

const REPORT_FLUSH_MS = 400;

// Pattern history: which gates hostiles use and when they turn up. Its own file
// rather than config.json — it is machine-written, grows to a megabyte, and a
// corrupt copy must never be able to take the app's settings down with it.
const PATTERN_FILE = 'intel-patterns.json';

function registerIntelHandlers({ ipcHandle, getSdeDb, loadConfig, saveConfig, loadDB, charInfoDb,
                                httpGet, httpPost, getZkillFeed, getAllianceContacts,
                                userDataPath }) {
  const { createIntelService } = require('../intel/intel_service');

  const patternPath = () => (userDataPath ? path.join(userDataPath, PATTERN_FILE) : null);

  function loadPatterns() {
    const p = patternPath();
    if (!p || !fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) {
      // Truncated by a hard shutdown mid-write, or hand-edited. Losing the
      // history is a nuisance; refusing to start the intel service is not.
      console.warn('[intel] pattern history unreadable, starting fresh:', e.message);
      return null;
    }
  }

  function savePatterns(snapshot) {
    const p = patternPath();
    if (!p) return;
    // Write-then-rename: the file is rewritten every 30s while watching, and a
    // crash partway through a plain write would leave exactly the truncated
    // JSON that loadPatterns has to defend against. rename is atomic, so the
    // file on disk is always a whole one.
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    fs.renameSync(tmp, p);
  }

  let service = null;
  let ready   = false;
  // Alliance-set standings, keyed by entity id. Refreshed when the monitored
  // set changes; ESI caches the source for an hour, so nothing is gained by
  // asking more often. Only the ALLIANCE sheet: personal contacts need
  // esi-characters.read_contacts.v1, which the app does not request, and adding
  // a scope would force every existing user to re-authenticate.
  let contactSheet = {};
  let pending = [];
  let flushTimer = null;

  const broadcast = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  function flush() {
    flushTimer = null;
    if (!pending.length) return;
    broadcast('intel-reports', pending);
    pending = [];
  }

  function queueReport(report) {
    pending.push(report);
    if (!flushTimer) {
      flushTimer = setTimeout(flush, REPORT_FLUSH_MS);
      if (flushTimer.unref) flushTimer.unref();
    }
  }

  const cfg = () => {
    const c = loadConfig() || {};
    return { ...(c.app && c.app.intel), };
  };

  function saveIntelConfig(patch) {
    const c = loadConfig() || {};
    c.app = c.app || {};
    c.app.intel = { ...(c.app.intel || {}), ...patch };
    saveConfig(c);
    return c.app.intel;
  }

  /** Build the service on first use — the SDE queries take a moment. */
  async function ensure() {
    if (ready) return service;
    service = createIntelService({
      getSdeDb,
      httpGet,
      httpPost,
      getZkillFeed,
      getRules:        () => (cfg().rules || []),
      getContactSheet: () => contactSheet,
      loadPatterns, savePatterns,
      // Only an override lands here; the module knows its own default host.
      zkillBase: cfg().zkillBase || undefined,
      onReport: queueReport,
      onAlert:  (alert) => broadcast('intel-alert', alert),
      onStatus: (status) => broadcast('intel-status', status),
    });
    const built = await service.init();
    ready = true;
    console.log(`[intel] index built: ${built.systems} systems, ${built.ships} ship hulls`);
    return service;
  }

  // ── Channel discovery ───────────────────────────────────────────────────────
  // What the settings picker offers: every channel EVE has actually logged,
  // most recently written first, so the intel channels the user is in are at
  // the top rather than buried among Local and Corp.
  ipcHandle('intel-discover-channels', async () => {
    const { discoverChannels, findChatlogDir } = require('../intel/chatlog_reader');
    const saved = cfg();
    return {
      dir: findChatlogDir(saved.logDir),
      channels: discoverChannels(saved.logDir),
      watching: Array.isArray(saved.channels) ? saved.channels : [],
    };
  });

  // ── Live position, from EVE's own Local log ────────────────────────────────
  // Every distance this feature reports is measured FROM the monitored
  // character, so a stale origin poisons the whole answer. The stored ESI
  // location is refreshed on a 30-minute stale gate from the dashboard and only
  // for the selected character — jump a super to a ratting system and nothing
  // re-read it at all. EVE writes "Channel changed to Local : <system>" the
  // moment you arrive, so that is the source of truth here and ESI is the
  // fallback for a character whose client has never run on this machine.
  let localPos = null;

  function ensureLocalWatcher() {
    if (localPos) return localPos;
    const { createLocalPositionWatcher } = require('../intel/local_position');
    localPos = createLocalPositionWatcher({
      dir: cfg().logDir,
      onChange: (changes) => { onPositionsChanged(changes).catch(() => {}); },
    });
    localPos.start();
    return localPos;
  }

  /**
   * A monitored character jumped.
   *
   * Origins are re-derived only when a system actually CHANGED, never on a
   * timer: setOrigins runs a BFS per origin and clears the alert suppressions,
   * so calling it every tick would burn the horizon rebuild and re-fire alerts
   * that were deliberately quietened. The renderer is told regardless, so the
   * dropdown stops showing where the character used to be.
   */
  async function onPositionsChanged(changes) {
    for (const c of changes) {
      console.log(`[intel] ${c.characterId} moved ${c.previous || '?'} -> ${c.systemName}`);
    }
    const monitored = new Set((cfg().monitor || []).map(Number));
    const moved = changes.filter(c => monitored.has(Number(c.characterId)));
    if (moved.length && ready && service) {
      const origins = await resolveOrigins([...monitored]);
      const reach = service.setOrigins(origins);
      broadcast('intel-origins', { origins, reach, moved });
    }
    broadcast('intel-characters', await monitorableCharacters());
  }

  // System name -> id, straight off the SDE and memoised. Deliberately NOT the
  // intel service's index: that needs the full build (5 000 systems, every
  // published hull), and the character dropdown must not pay for it just to
  // print where somebody is standing.
  const _sysIdCache = new Map();
  async function systemIdByName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    if (_sysIdCache.has(key)) return _sysIdCache.get(key);
    let id = null;
    try {
      const db = getSdeDb && getSdeDb();
      if (db) {
        const rows = await db.all(
          'SELECT solarSystemID id FROM mapSolarSystems WHERE LOWER(solarSystemName) = ? LIMIT 1', key);
        if (rows && rows.length) id = Number(rows[0].id);
      }
    } catch (_) { /* SDE missing — the ESI position still works */ }
    _sysIdCache.set(key, id);
    return id;
  }

  /**
   * Where a character is, best source first.
   *
   * `source` is returned rather than hidden because the two differ in kind: the
   * log is seconds old and needs no scope, the ESI row can be half an hour old.
   * The UI says which, so nobody has to guess whether the number is live.
   */
  async function characterPosition(characterId) {
    const id = Number(characterId);

    let log = null;
    const live = ensureLocalWatcher().positionFor(id);
    if (live && live.systemName) {
      const sysId = await systemIdByName(live.systemName);
      if (sysId != null) {
        log = { systemId: sysId, systemName: live.systemName, at: live.at, source: 'log',
                // How recently a client VOUCHED for this, which is not the same
                // as when the character last jumped: someone ratting in one
                // system for three hours has an old `at` and a live `seenAt`.
                vouchedAt: Math.max(live.seenAt || 0, live.at || 0) };
      } else {
        // A system the SDE doesn't know — a localized client whose wording
        // slipped past the pattern, or an Abyssal pocket. Say so rather than
        // silently trusting a name nothing can measure a distance from.
        console.warn(`[intel] Local log names an unknown system: ${live.systemName}`);
      }
    }

    let esi = null;
    try {
      const data = charInfoDb ? await charInfoDb.getCharacterData(id) : null;
      const loc  = data && data.location;
      if (loc && loc.solar_system_id != null) {
        esi = {
          systemId:   Number(loc.solar_system_id),
          systemName: loc.solar_system_name || null,
          at:         loc.synced_at || null,
          source:     'esi',
          vouchedAt:  loc.synced_at || 0,
        };
      }
    } catch (_) { /* no location on record yet */ }

    // Newest vouch wins, rather than "the log always" — see preferPosition.
    const { preferPosition } = require('../intel/local_position');
    return preferPosition(log, esi)
        || { systemId: null, systemName: null, at: null, source: null };
  }

  // ── Which characters can be monitored ──────────────────────────────────────
  // Every account the app knows, annotated with:
  //   • where it is       — from the local character DB, so no ESI call
  //   • whether it's ONLINE — inferred from the chat logs, because EVE only
  //     writes to a character's log file while that character is running. That
  //     beats /characters/{id}/online/, which needs a scope most people haven't
  //     granted and answers for one character per call.
  async function monitorableCharacters() {
    const { detectOnlineCharacters } = require('../intel/chatlog_reader');
    const saved = cfg();
    const online = new Map(detectOnlineCharacters(saved.logDir).map(c => [c.characterId, c]));
    const db = (loadDB && loadDB()) || { accounts: {} };
    const watching = new Set((saved.monitor || []).map(Number));

    const out = [];
    for (const acc of Object.values(db.accounts || {})) {
      const pos  = await characterPosition(acc.characterId);
      const seen = online.get(Number(acc.characterId));
      out.push({
        characterId: acc.characterId,
        name:        acc.characterName || `Character ${acc.characterId}`,
        systemId:    pos.systemId,
        systemName:  pos.systemName,
        // How the position was learned and AS OF WHEN it is believed. Shown,
        // not hidden: "read from the game as you jump" and "from ESI, 24m ago"
        // are different claims and the operator is entitled to know which one
        // they are acting on. positionAt is the vouch, not the jump — a ratter
        // parked for three hours is still being vouched for every second.
        positionSource: pos.source,
        positionAt:     pos.vouchedAt || pos.at,
        online:      !!seen,
        lastSeen:    seen ? seen.lastSeen : null,
        monitored:   watching.has(Number(acc.characterId)),
      });
    }
    // Online first, then anyone with a known position — the ones you can
    // actually monitor float to the top of the dropdown.
    out.sort((a, b) => (b.online - a.online) || ((b.systemId ? 1 : 0) - (a.systemId ? 1 : 0))
                       || String(a.name).localeCompare(String(b.name)));
    return out;
  }

  ipcHandle('intel-monitorable-characters', async () => monitorableCharacters());

  // Set the monitored set. Characters without a known position are accepted but
  // contribute nothing until one is synced — silently dropping them would make
  // the checkbox appear broken.
  /** Character IDs -> monitored origins, resolving each one's stored location. */
  async function resolveOrigins(ids) {
    const db = (loadDB && loadDB()) || { accounts: {} };
    const origins = [];
    for (const id of ids) {
      const acc = db.accounts[id] || db.accounts[String(id)];
      const pos = await characterPosition(id);
      if (pos.systemId == null) continue;
      origins.push({
        key: String(id), characterId: id,
        label: (acc && acc.characterName) || `Character ${id}`,
        systemId: Number(pos.systemId),
        systemName: pos.systemName,
        source: pos.source,
      });
    }
    return origins;
  }

  ipcHandle('intel-set-monitored', async (_e, characterIds) => {
    const ids = (characterIds || []).map(Number).filter(Number.isFinite);
    saveIntelConfig({ monitor: ids });
    const svc = await ensure();
    const origins = await resolveOrigins(ids);
    const reach = svc.setOrigins(origins);
    // Standings follow whoever is being monitored — fire-and-forget so the
    // toggle in the UI doesn't wait on a paginated ESI fetch.
    refreshContactSheet(ids)
      .then(sheet => console.log(`[intel] contact sheet: ${Object.keys(sheet).length} standings`))
      .catch(() => {});
    return { origins, reach, skipped: ids.length - origins.length };
  });

  /**
   * Start watching at app launch, without anyone opening the page.
   *
   * This is the whole point of an early-warning system: it has to be running
   * BEFORE you need it. A tool you must remember to switch on is a tool that is
   * off during the one op where it mattered.
   *
   * Guarded on explicit opt-in plus a configured channel list, so a fresh
   * install never silently starts reading chat logs.
   */
  async function autoStart() {
    const saved = cfg();
    if (!saved.autoStart) return { started: false, reason: 'not enabled' };
    // Channels OR the live kill feed is enough. The live feed needs no chat logs
    // and no running client, so somebody who only ever uses it — the case this
    // was added for — must not be turned away for having no channels.
    const hasChannels = Array.isArray(saved.channels) && saved.channels.length;
    const liveKills   = !!(saved.options && saved.options.liveKills);
    if (!hasChannels && !liveKills) {
      return { started: false, reason: 'no channels configured' };
    }
    try {
      const svc = await ensure();
      if (saved.options) svc.setOptions(saved.options);
      const origins = await resolveOrigins((saved.monitor || []).map(Number));
      const reach = svc.setOrigins(origins);
      refreshContactSheet((saved.monitor || []).map(Number)).catch(() => {});
      const status = svc.start(saved.channels || [], { dir: saved.logDir });
      console.log(`[intel] auto-started: ${hasChannels ? saved.channels.join(', ') : 'no channels'}` +
                  `${liveKills ? ' + live kills' : ''} · ` +
                  `${origins.length} character(s), ${reach} systems in range`);
      return { started: true, origins: origins.length, reach, reader: status };
    } catch (e) {
      // Never let this take the app down — it runs during boot.
      console.warn('[intel] auto-start failed:', e.message);
      return { started: false, reason: e.message };
    }
  }

  // ── Alert rules ─────────────────────────────────────────────────────────────
  // Stored in config so they survive restarts and are readable/editable by hand.
  ipcHandle('intel-get-rules', async () => {
    const saved = cfg();
    if (Array.isArray(saved.rules)) return saved.rules;
    // First run: seed the examples. They ship DISABLED — see STARTER_RULES.
    const { STARTER_RULES } = require('../intel/alert_rules');
    saveIntelConfig({ rules: STARTER_RULES });
    return STARTER_RULES;
  });

  ipcHandle('intel-set-rules', async (_e, rules) => {
    const list = Array.isArray(rules) ? rules : [];
    saveIntelConfig({ rules: list });
    return list;   // the service reads them live via getRules()
  });

  // Refresh the standings sheet from the monitored characters' alliances.
  async function refreshContactSheet(ids) {
    if (!getAllianceContacts) return contactSheet;
    const { mergeContactSheets } = require('../intel/standings');
    const alliance = {};
    const seen = new Set();
    for (const id of (ids || [])) {
      let allianceId = null;
      try {
        const data = charInfoDb ? await charInfoDb.getCharacterData(id) : null;
        allianceId = data?.info?.alliance_id ?? data?.alliance_id ?? null;
      } catch (_) {}
      if (!allianceId || seen.has(allianceId)) continue;
      seen.add(allianceId);
      try {
        const res = await getAllianceContacts(id, allianceId);
        if (res && res.ok && res.standings) Object.assign(alliance, res.standings);
      } catch (_) { /* no scope, or ESI unavailable — standings rules just won't match */ }
    }
    contactSheet = mergeContactSheets({ alliance });
    return contactSheet;
  }

  ipcHandle('intel-get-config', async () => cfg());

  ipcHandle('intel-set-config', async (_e, patch) => {
    const before = cfg().logDir;
    const next = saveIntelConfig(patch || {});
    // Point the position watcher at the new directory. Without this it goes on
    // tailing the old one — silently, and reporting positions that get older
    // every minute while looking exactly as live as they did before.
    if (next.logDir !== before && localPos) {
      localPos.stop();
      localPos = null;
      ensureLocalWatcher();
    }
    if (ready && service) {
      if (patch && patch.options) service.setOptions(patch.options);
      // Channel list changed → restart the reader against the new set.
      if (patch && patch.channels) service.start(next.channels || [], { dir: next.logDir });
    }
    return next;
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  ipcHandle('intel-start', async (_e, { channels, origin } = {}) => {
    const svc   = await ensure();
    const saved = cfg();
    const list  = channels || saved.channels || [];
    if (channels) saveIntelConfig({ channels });
    if (saved.options) svc.setOptions(saved.options);
    if (origin != null) svc.setOrigin(origin);
    const status = svc.start(list, { dir: saved.logDir });
    return { ...svc.status(), reader: status };
  });

  ipcHandle('intel-stop', async () => {
    if (service) service.stop();
    return { running: false };
  });

  // Demo mode is 'watching' out of 1DQ1-A with invented contacts, so the widget
  // shows its urgency banding instead of an idle 'Not watching' card.
  ipcHandle('intel-status', async () =>
    (require('../demo_mode').isEnabled() ? require('../demo_fixtures').intelStatus()
                                         : (ready && service ? service.status() : { running: false, systems: 0 })));

  /**
   * Where the fleet is. Everything is measured from here, so a wrong or stale
   * origin makes every distance wrong — the renderer sets it from the selected
   * character's live location, and again whenever that changes.
   */
  ipcHandle('intel-set-origin', async (_e, systemId) => {
    const svc = await ensure();
    return { reach: svc.setOrigin(systemId), origin: systemId };
  });

  ipcHandle('intel-contacts', async () =>
    (require('../demo_mode').isEnabled() ? require('../demo_fixtures').intelContacts()
                                         : (ready && service ? service.contacts() : [])));
  ipcHandle('intel-feed', async (_e, limit) => (ready && service ? service.feed(limit || 100) : []));

  // ── Patterns ────────────────────────────────────────────────────────────────
  // Builds the service if it isn't up yet: the history is on disk and worth
  // reading even when nothing is being watched right now — the operator asking
  // "when do they usually come?" before an op is the whole point.
  ipcHandle('intel-patterns', async () => {
    const svc = await ensure();
    return svc.patterns();
  });

  ipcHandle('intel-clear-patterns', async () => {
    if (!ready || !service) return { presence: 0, legs: 0 };
    return service.clearPatterns();
  });

  return {
    autoStart,
    stop() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (service) service.stop();   // also flushes the pattern history
    },
  };
}

module.exports = { registerIntelHandlers, REPORT_FLUSH_MS };
