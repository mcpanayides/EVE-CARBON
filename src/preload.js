const { contextBridge, ipcRenderer } = require('electron');

// Main→renderer push channels the renderer is allowed to listen on.
const IPC_EVENT_CHANNELS = [
  'account-added',
  'auth-error',
  'char-sync-progress',
  'jabber-status',
  'jabber-message',
  'beehive-status',
  'presence-count',
  'ping-alert-data',
  'jabber-room-message',
  'jabber-room-subject',
  'jabber-room-occupants',
  'jabber-rooms',
  'repair-progress',
  'sde-update-progress',
  'updater-download-progress',
  'intel-reports',
  'intel-alert',
  'intel-status',
];

// caller fn → channel → [wrapper, …]. Weak so a handler going out of scope in
// the renderer doesn't pin an entry here; see the note on `on` below.
const _listenerRegistry = new WeakMap();

contextBridge.exposeInMainWorld('eveAPI', {

  // Full character sync → character_information.db (manual SYNC button)
  syncCharacterFull:        (characterId) => ipcRenderer.invoke('sync-character-full', characterId),

  // Frequent-cadence auto-refresh: core data only (no assets), plus a separate
  // asset sync that self-skips unless assets are older than ASSET_STALE_MS (6 h).
  syncCharacterCore:           (characterId) => ipcRenderer.invoke('sync-character-core', characterId),
  syncCharacterAssetsIfStale:  (characterId) => ipcRenderer.invoke('sync-character-assets-if-stale', characterId),
  // Live status only (location + ship + active implants) — used to keep the
  // dashboard banner current on every load, bypassing the implant stale-gate.
  syncCharacterStatus:         (characterId) => ipcRenderer.invoke('sync-character-status', characterId),

  // Read stored character data from CharDB
  getCharacterAssetsDb:     (characterId) => ipcRenderer.invoke('get-character-assets-db', characterId),
  getAssetSyncedAt:         (characterId) => ipcRenderer.invoke('get-asset-synced-at', characterId),

  // Aliases used by dashboard.js, characters.js, wallets, and PI
  getCharacterData:    (characterId) => ipcRenderer.invoke('get-character-info-db', characterId),
  getCharacterAssets:  (characterId) => ipcRenderer.invoke('get-character-assets-db', characterId),
  getPIColonies:       (characterId) => ipcRenderer.invoke('get-pi-colonies', { characterId }),
  syncPI:              (characterId) => ipcRenderer.invoke('sync-pi',        { characterId }),

  // Wallet journal, transactions and loyalty points (from CharDB, synced every 30 min)
  getWalletJournal:       (charId) => ipcRenderer.invoke('get-wallet-journal', charId),
  getWalletBalanceBefore: (charId, beforeTs) => ipcRenderer.invoke('get-wallet-balance-before', charId, beforeTs),
  getWalletTransactions:  (charId) => ipcRenderer.invoke('get-wallet-transactions', charId),
  getLoyaltyPoints:       (charId) => ipcRenderer.invoke('get-loyalty-points', charId),
  // Mining ledger (personal ledger synced to CharDB; corp observers + moon extractions live)
  syncMiningLedger:       (charId) => ipcRenderer.invoke('sync-mining-ledger', charId),
  getMiningLedgerDb:      (charId) => ipcRenderer.invoke('get-mining-ledger-db', charId),
  getCorpMiningObservers: (charId) => ipcRenderer.invoke('get-corp-mining-observers', charId),
  getCorpMiningExtractions:(charId) => ipcRenderer.invoke('get-corp-mining-extractions', charId),
  getCharacterFwStats:    (charId) => ipcRenderer.invoke('get-character-fw-stats', charId),
  lpGetOffers:            (corpId) => ipcRenderer.invoke('lp-get-offers', corpId),
  sdeProductsForBlueprints:(typeIds) => ipcRenderer.invoke('sde-products-for-blueprints', typeIds),

  // Accounts
  getAccounts:   ()    => ipcRenderer.invoke('get-accounts'),
  removeAccount: (id)  => ipcRenderer.invoke('remove-account', id),
  removeAllAccounts: () => ipcRenderer.invoke('remove-all-accounts'),
  startSSOLogin: ()    => ipcRenderer.invoke('start-sso-login'),

  // Dashboard data
  esiFetch:              (url, options)             => ipcRenderer.invoke('esi-fetch', url, options),
  httpGetText:           (url)                      => ipcRenderer.invoke('http-get-text', url),
  forumLogin:            (baseUrl)                  => ipcRenderer.invoke('forum-login', baseUrl),
  forumSessionStatus:    ()                         => ipcRenderer.invoke('forum-session-status'),
  forumFetchText:        (url)                      => ipcRenderer.invoke('forum-fetch-text', url),
  scrapeForumEvents:     (url)                      => ipcRenderer.invoke('forum-scrape-events', url),
  forumLogout:           ()                         => ipcRenderer.invoke('forum-logout'),
  getMarketPrices:       ()                         => ipcRenderer.invoke('get-market-prices'),
  getMarketMovers:       ()                         => ipcRenderer.invoke('get-market-movers'),
  resolveLocation:       (locationId, characterId)  => ipcRenderer.invoke('resolve-location', locationId, characterId),
  resolveSystemNames:    (systemIds)                => ipcRenderer.invoke('resolve-system-names', systemIds),
  getCharacterOrders:    (characterId)              => ipcRenderer.invoke('get-character-orders', characterId),

  // Blueprints
  getAllBlueprintsFromDb: () => ipcRenderer.invoke('get-all-blueprints-from-db'),

  // Public ESI / Fuzzwork
  searchTypes:           (q, lim)  => ipcRenderer.invoke('sde-search-types', q, lim),
  searchMarketTypes:     (q, lim)  => ipcRenderer.invoke('sde-search-market-types', q, lim),
  // Batched exact name → { id, name, volume } lookup (bulk appraisal).
  sdeTypesByNames:       (names)   => ipcRenderer.invoke('sde-types-by-names', names),
  getNames:              (ids)     => ipcRenderer.invoke('esi-names', ids),
  getBlueprintMaterials: (id)      => ipcRenderer.invoke('get-blueprint-materials', id),
  findBpForProduct:      (id)      => ipcRenderer.invoke('find-bp-for-product', id),
  getProductForBlueprint:(id)      => ipcRenderer.invoke('get-product-for-blueprint', id),
  getWalletBalance:      (charId)  => ipcRenderer.invoke('get-wallet', charId),
  getJitaPrices:         (typeIds) => ipcRenderer.invoke('get-jita-prices', typeIds),

  // Materialised asset valuation (src/asset_valuation.js). Value lives in the
  // database now, so these are queries rather than renderer arithmetic.
  valuationRefresh:      (opts)    => ipcRenderer.invoke('valuation-refresh', opts),
  valuationRebuild:      ()        => ipcRenderer.invoke('valuation-rebuild'),
  valuationTopAssets:    (opts)    => ipcRenderer.invoke('valuation-top-assets', opts),
  valuationNetWorth:     (charId)  => ipcRenderer.invoke('valuation-net-worth', charId),
  valuationMeta:         ()        => ipcRenderer.invoke('valuation-meta'),

  // The Assets page's query API (src/asset_index.js). One call per view, so the
  // renderer never holds more than what is on screen — the whole point of
  // Phase 2. filters = { characterId, region, corp, search }, sort = { col, dir }.
  assetsFilterOptions:   ()        => ipcRenderer.invoke('assets-filter-options'),
  assetsSummary:         (filters) => ipcRenderer.invoke('assets-summary', filters),
  assetsLocationGroups:  (filters, sort) => ipcRenderer.invoke('assets-location-groups', filters, sort),
  assetsGroupCharacters: (locKey, filters, sort) => ipcRenderer.invoke('assets-group-characters', locKey, filters, sort),
  assetsGroupItems:      (locKey, charId, filters, sort) => ipcRenderer.invoke('assets-group-items', locKey, charId, filters, sort),
  assetsTopItems:        (opts)    => ipcRenderer.invoke('assets-top-items', opts),
  getHubPrices:          (typeIds, hub) => ipcRenderer.invoke('get-hub-prices', typeIds, hub),
  getHubMeta:            ()       => ipcRenderer.invoke('get-hub-meta'),
  getTradeProfile:       (charId) => ipcRenderer.invoke('get-trade-profile', charId),
  getAllianceContacts:   (charId, allianceId) => ipcRenderer.invoke('get-alliance-contacts', charId, allianceId),
  getEveScoutConnections: ()      => ipcRenderer.invoke('get-eve-scout-connections'),
  getMoonReprocessing:   (typeIds) => ipcRenderer.invoke('get-moon-reprocessing', typeIds),
  reprocessFromNames:    (names)   => ipcRenderer.invoke('reprocess-from-names', names),
  getSkillLevels:        (charId, typeIds) => ipcRenderer.invoke('get-skill-levels', charId, typeIds),
  getSkillQueue:         (charId)  => ipcRenderer.invoke('get-skill-queue', charId),
  getTypeMetadata:       (typeIds) => ipcRenderer.invoke('get-type-metadata', typeIds),
  sdeGetPlanetRegions:   ()         => ipcRenderer.invoke('sde-get-planet-regions'),
  sdeGetRegionPlanets:   (regionId) => ipcRenderer.invoke('sde-get-region-planets', regionId),

  // Jobs
  getCharacterActiveJobs:    (characterId)             => ipcRenderer.invoke('get-character-active-jobs', characterId),
  getCorpActiveJobs:         (characterId)             => ipcRenderer.invoke('get-corp-active-jobs', characterId),
  // kind defaults to 'character' in main, so the banner's one-arg call is unchanged.
  getZkillStats:             (entityId, kind)          => ipcRenderer.invoke('get-zkill-stats', entityId, kind),
  getZkillFeed:              (kind, entityId, page)    => ipcRenderer.invoke('get-zkill-feed', kind, entityId, page),
  modernLayoutGet:           ()                        => ipcRenderer.invoke('modern-layout-get'),
  modernLayoutCacheGet:      ()                        => ipcRenderer.invoke('modern-layout-cache-get'),
  modernLayoutCachePut:      (layout)                  => ipcRenderer.invoke('modern-layout-cache-put', layout),
  mapBuildRegionLayouts:     (job)                     => ipcRenderer.invoke('map-build-region-layouts', job),
  setAutopilotDestination:   (characterId, systemId)   => ipcRenderer.invoke('set-autopilot-destination', { characterId, systemId }),
  setAutopilotRoute:         (characterId, systemIds)  => ipcRenderer.invoke('set-autopilot-route', { characterId, systemIds }),

  // Assets
  repairStructureLocations: () => ipcRenderer.invoke('repair-structure-locations'),
  wipeAssets:    ()       => ipcRenderer.invoke('wipe-assets'),

  // Background images
  listBackgrounds: () => ipcRenderer.invoke('list-backgrounds'),
  pickBackground:  () => ipcRenderer.invoke('pick-background'),

  // Jabber ping-alert sound (assets/audio + userData/ping-sounds)
  pingSoundList:    () => ipcRenderer.invoke('ping-sound-list'),
  pingSoundPick:    () => ipcRenderer.invoke('ping-sound-pick'),
  pingSoundCurrent: () => ipcRenderer.invoke('ping-sound-current'),

  // Reeded glass / Windows acrylic
  glassSupported:   ()         => ipcRenderer.invoke('glass-supported'),
  glassSetMaterial: (material) => ipcRenderer.invoke('glass-set-material', material),
  glassGetAccent:   ()         => ipcRenderer.invoke('glass-get-accent'),

  // Dashboard widget pop-outs (floating desktop widgets)
  widgetPopoutOpen:    (opts) => ipcRenderer.invoke('widget-popout-open', opts),
  widgetPopoutClose:   (id)   => ipcRenderer.invoke('widget-popout-close', id),
  widgetPopoutReady:   (id)   => ipcRenderer.invoke('widget-popout-ready', id),
  widgetPopoutContent: (data) => ipcRenderer.invoke('widget-popout-content', data),
  widgetPopoutPin:     (data) => ipcRenderer.invoke('widget-popout-pin', data),
  onWidgetContent:     (cb)   => ipcRenderer.on('widget-content',      (_e, data) => cb(data)),
  onWidgetPoppedIn:    (cb)   => ipcRenderer.on('widget-popped-in',    (_e, id)   => cb(id)),
  onWidgetPopoutReady: (cb)   => ipcRenderer.on('widget-popout-ready', (_e, id)   => cb(id)),

  // Station / structure database sync
  syncStationDatabase:     (opts) => ipcRenderer.invoke('sync-station-database', opts),
  syncUpwellDatabase:      (opts) => ipcRenderer.invoke('sync-upwell-database', opts),
  getStationSyncTimestamp: (opts) => ipcRenderer.invoke('get-station-sync-timestamp', opts),

  // SDE
  sdeGetName:        (id)  => ipcRenderer.invoke('sde-get-name', id),
  sdeGetSystemNames:    (ids) => ipcRenderer.invoke('sde-get-system-names', ids),
  sdeFacilityToSystem:  (ids) => ipcRenderer.invoke('sde-facility-to-system', ids),

  // SDE update (runtime check + download + restart)
  sdeCheckUpdate:   ()   => ipcRenderer.invoke('sde-check-update'),
  sdeDownloadUpdate: ()  => ipcRenderer.invoke('sde-download-update'),
  sdeRestartApp:    ()   => ipcRenderer.invoke('sde-restart-app'),

  // Persistent user data cache
  cacheGet: (key)              => ipcRenderer.invoke('cache-get', key),
  cacheSet: (key, value, days) => ipcRenderer.invoke('cache-set', key, value, days),

  // UI theme config

  // App settings
  getAppConfig:  ()       => ipcRenderer.invoke('app-get-config'),
  saveAppConfig: (config) => ipcRenderer.invoke('app-save-config', config),

  // App preferences (General tab): start-with-Windows + minimize-to-tray
  getAppPreferences: ()        => ipcRenderer.invoke('get-app-preferences'),

  // ── Diagnostic log ───────────────────────────────────────────────────────
  logGetState:   ()        => ipcRenderer.invoke('log-get-state'),
  logSetEnabled: (enabled) => ipcRenderer.invoke('log-set-enabled', enabled),
  logTail:       (opts)    => ipcRenderer.invoke('log-tail', opts),
  logClear:      ()        => ipcRenderer.invoke('log-clear'),
  logReveal:     ()        => ipcRenderer.invoke('log-reveal'),
  // Fire-and-forget: logging must never make the UI wait on the main process.
  logWrite:      (entry)   => ipcRenderer.send('log-write', entry),
  // ── Intel early-warning ──────────────────────────────────────────────────
  intelDiscoverChannels: ()          => ipcRenderer.invoke('intel-discover-channels'),
  intelGetConfig:        ()          => ipcRenderer.invoke('intel-get-config'),
  intelSetConfig:        (patch)     => ipcRenderer.invoke('intel-set-config', patch),
  intelStart:            (opts)      => ipcRenderer.invoke('intel-start', opts),
  intelStop:             ()          => ipcRenderer.invoke('intel-stop'),
  intelStatus:           ()          => ipcRenderer.invoke('intel-status'),
  intelSetOrigin:        (systemId)  => ipcRenderer.invoke('intel-set-origin', systemId),
  intelMonitorableCharacters: ()     => ipcRenderer.invoke('intel-monitorable-characters'),
  intelWidgetOpen:       ()          => ipcRenderer.invoke('intel-widget-open'),
  intelWidgetClose:      ()          => ipcRenderer.invoke('intel-widget-close'),
  intelWidgetPin:        (pinned)    => ipcRenderer.invoke('intel-widget-pin', pinned),
  intelWidgetState:      ()          => ipcRenderer.invoke('intel-widget-state'),
  intelGetRules:         ()          => ipcRenderer.invoke('intel-get-rules'),
  intelSetRules:         (rules)     => ipcRenderer.invoke('intel-set-rules', rules),
  intelSetMonitored:     (charIds)   => ipcRenderer.invoke('intel-set-monitored', charIds),
  intelContacts:         ()          => ipcRenderer.invoke('intel-contacts'),
  intelFeed:             (limit)     => ipcRenderer.invoke('intel-feed', limit),
  intelPatterns:         ()          => ipcRenderer.invoke('intel-patterns'),
  intelClearPatterns:    ()          => ipcRenderer.invoke('intel-clear-patterns'),
  getDemoMode:       ()        => ipcRenderer.invoke('get-demo-mode'),
  setDemoMode:       (enabled) => ipcRenderer.invoke('set-demo-mode', enabled),
  restartApp:        ()        => ipcRenderer.invoke('restart-app'),
  setLaunchAtLogin:  (enabled) => ipcRenderer.invoke('set-launch-at-login', enabled),
  setMinimizeToTray: (enabled) => ipcRenderer.invoke('set-minimize-to-tray', enabled),
  getPresenceState: () => ipcRenderer.invoke('presence-get-state'),
  getPresenceCount:   ()        => ipcRenderer.invoke('presence-get-count'),

  // Ping file watcher

  // GSF SIGs / Squads metadata (yaml/gsf_sigs.yaml)
  getSigGroups:     () => ipcRenderer.invoke('get-sig-groups'),
  getCommsChannels: () => ipcRenderer.invoke('get-comms-channels'),

  // Fleet join helpers
  openCharacterInfoWindow: (characterId, targetId) => ipcRenderer.invoke('open-character-info-window', { characterId, targetId }),
  systemIdByName: (name)                  => ipcRenderer.invoke('sde-system-id-by-name', name),
  openExternalUrl: (url)                  => ipcRenderer.invoke('open-external-url', url),

  // Jabber
  connectJabber:       (config) => ipcRenderer.invoke('jabber-connect', config),
  getJabberMessages:   (limit)  => ipcRenderer.invoke('jabber-get-messages', limit),
  wipeJabberData:      ()       => ipcRenderer.invoke('jabber-wipe-data'),
  openPingAlert:       (rowId)  => ipcRenderer.invoke('jabber-open-ping-alert', rowId),
  getLatestPing:       ()       => ipcRenderer.invoke('jabber-get-latest-ping'),

  // Jabber chat rooms (MUC): list/add/remove, read history, mark read, send.
  jabberListRooms:    ()               => ipcRenderer.invoke('jabber-list-rooms'),
  jabberAddRoom:      (room)           => ipcRenderer.invoke('jabber-add-room', room),
  jabberRemoveRoom:   (jid)            => ipcRenderer.invoke('jabber-remove-room', jid),
  jabberRoomMessages: (jid, limit)     => ipcRenderer.invoke('jabber-room-messages', jid, limit),
  jabberMarkRoomRead: (jid)            => ipcRenderer.invoke('jabber-mark-room-read', jid),
  jabberSendRoom:     (jid, body)      => ipcRenderer.invoke('jabber-send-room', jid, body),
  jabberDefaultConference: ()          => ipcRenderer.invoke('jabber-default-conference'),
  jabberDiscoverRooms: (serverJid)     => ipcRenderer.invoke('jabber-discover-rooms', serverJid),
  jabberLoadRoomHistory: (jid, pageSize) => ipcRenderer.invoke('jabber-load-room-history', jid, pageSize),
  jabberRoomState:    (jid)            => ipcRenderer.invoke('jabber-room-state', jid),
  getPingAlertData:    ()       => ipcRenderer.invoke('jabber-get-ping-alert-data'),
  getBeehiveStatus:    ()       => ipcRenderer.invoke('beehive-get-status'),

  // Alliance packs
  getPacks:            ()       => ipcRenderer.invoke('get-packs'),
  importPack:          ()       => ipcRenderer.invoke('import-pack'),
  deletePack:          (id)     => ipcRenderer.invoke('delete-pack', id),
  getPackDetail:       (id)     => ipcRenderer.invoke('get-pack-detail', id),
  savePack:            (data)   => ipcRenderer.invoke('save-pack', data),

  // App metadata
  getAppVersion:       ()       => ipcRenderer.invoke('get-app-version'),

  // Jump-bridge network (encrypted store in userData — not localStorage)
  getJumpBridges:      ()       => ipcRenderer.invoke('get-jump-bridges'),
  saveJumpBridges:     (arr)    => ipcRenderer.invoke('save-jump-bridges', arr),

  // Theme / palette
  themeGetAll:         ()       => ipcRenderer.invoke('theme-get-all'),
  themeGet:            (id)     => ipcRenderer.invoke('theme-get', id),
  themeGetActive:      ()       => ipcRenderer.invoke('theme-get-active'),
  themeSetActive:      (id)     => ipcRenderer.invoke('theme-set-active', id),
  themeSaveCustom:     (data)   => ipcRenderer.invoke('theme-save-custom', data),
  themeDeleteCustom:   (id)     => ipcRenderer.invoke('theme-delete-custom', id),

  // Salvage Calculator
  salvageGetRigData:   ()       => ipcRenderer.invoke('salvage-get-rig-data'),

  // Fleet Composition Tracker
  fcGetShipRoles:      ()                  => ipcRenderer.invoke('fc-get-ship-roles'),
  fcGetCharacterFleet: (characterId)       => ipcRenderer.invoke('fc-get-character-fleet', characterId),
  fcGetFleetMembers:   (characterId, fleetId) => ipcRenderer.invoke('fc-get-fleet-members', characterId, fleetId),
  fcInviteCharacters:  (bossId, fleetId, ids) => ipcRenderer.invoke('fc-invite-characters', bossId, fleetId, ids),

  // Fleet ops — the recorded outing behind the live composition view.
  fleetOpStart:   (opts)            => ipcRenderer.invoke('fleet-op-start', opts),
  fleetOpStop:    (opId, reason)    => ipcRenderer.invoke('fleet-op-stop', opId, reason),
  fleetOpRecord:  (opId, members)   => ipcRenderer.invoke('fleet-op-record', opId, members),
  fleetOpCurrent: ()                => ipcRenderer.invoke('fleet-op-current'),
  fleetOpList:    (limit)           => ipcRenderer.invoke('fleet-op-list', limit),
  fleetOpGet:     (opId)            => ipcRenderer.invoke('fleet-op-get', opId),
  fleetOpPullKills:  (opId)         => ipcRenderer.invoke('fleet-op-pull-kills', opId),
  fleetOpPullMining: (opId)         => ipcRenderer.invoke('fleet-op-pull-mining', opId),
  fleetOpReport:     (opId)         => ipcRenderer.invoke('fleet-op-report', opId),
  fleetOpSetNotes:   (opId, notes)  => ipcRenderer.invoke('fleet-op-set-notes', opId, notes),
  fleetOpSaveReport: (payload)      => ipcRenderer.invoke('fleet-op-save-report', payload),

  // Fitting tool
  fitSearch:        (query, kind, limit) => ipcRenderer.invoke('fit-search', query, kind, limit),
  fitBrowseTree:    (kind)               => ipcRenderer.invoke('fit-browse-tree', kind),
  fitAmmoFor:       (typeId)             => ipcRenderer.invoke('fit-ammo-for', typeId),
  fitGetHull:       (typeId)             => ipcRenderer.invoke('fit-get-hull', typeId),
  fitGetItems:      (typeIds)            => ipcRenderer.invoke('fit-get-items', typeIds),
  fitLookupNames:   (names)              => ipcRenderer.invoke('fit-lookup-names', names),
  fitGetFittings:   (characterId)        => ipcRenderer.invoke('fit-get-fittings', characterId),
  fitSaveFitting:   (characterId, fit)   => ipcRenderer.invoke('fit-save-fitting', characterId, fit),

  // EVE Mail (live-fetched via ESI, never stored locally — see main.js).
  mailGetHeaders:   (characterId, opts)          => ipcRenderer.invoke('mail-get-headers', characterId, opts),
  mailGetBody:      (characterId, mailId)        => ipcRenderer.invoke('mail-get-body', characterId, mailId),
  mailGetLabels:    (characterId)                => ipcRenderer.invoke('mail-get-labels', characterId),
  mailGetLists:     (characterId)                => ipcRenderer.invoke('mail-get-lists', characterId),
  mailSend:         (characterId, mail)          => ipcRenderer.invoke('mail-send', characterId, mail),
  mailUpdate:       (characterId, mailId, patch) => ipcRenderer.invoke('mail-update', characterId, mailId, patch),
  mailDelete:       (characterId, mailId)        => ipcRenderer.invoke('mail-delete', characterId, mailId),

  // In-game notification feed (read-only — ESI exposes no write route).
  notifGet:         (characterId)                => ipcRenderer.invoke('notif-get', characterId),

  // Contracts (Finances → Contracts). Scope was already granted.
  contractsGet:      (characterId)             => ipcRenderer.invoke('contracts-get', characterId),
  contractsGetItems: (characterId, contractId) => ipcRenderer.invoke('contracts-get-items', characterId, contractId),

  // Skills page / planner. skillsGetCharacter needs no new scope.
  skillsGetCharacter: (characterId)  => ipcRenderer.invoke('skills-get-character', characterId),
  sdeGetSkills:       ()             => ipcRenderer.invoke('sde-get-skills'),
  sdeImplantAttrs:    (typeIds)      => ipcRenderer.invoke('sde-implant-attrs', typeIds),
  sdeTypeRequirements:(typeId)       => ipcRenderer.invoke('sde-type-requirements', typeId),
  sdeSkillUnlocks:    (pairs)        => ipcRenderer.invoke('sde-skill-unlocks', pairs),
  sdeAttributeBoosters: ()           => ipcRenderer.invoke('sde-attribute-boosters'),

  // Reactions Profit — all reaction formulas + materials from the SDE
  reactionsList:       ()       => ipcRenderer.invoke('reactions-list'),

  // Updater
  updaterCheck:               ()    => ipcRenderer.invoke('updater-check'),
  updaterOpenDownload:        (url) => ipcRenderer.invoke('updater-open-download', url),
  updaterSkipVersion:         (ver) => ipcRenderer.invoke('updater-skip-version', ver),
  updaterDownloadAndInstall:  (url) => ipcRenderer.invoke('updater-download-and-install', url),

  // Queries SDE for manufacturing materials and applies the ME bonus.
  // Returns { materials, productTypeId, productName, productQty } or null.
  sdeBlueprintMaterials: (blueprintTypeId, me) =>
  ipcRenderer.invoke('sde-blueprint-materials', blueprintTypeId, me),

  // Map — galaxy data (SDE) + live ESI overlays
  mapGetGalaxy:          ()    => ipcRenderer.invoke('map-get-galaxy'),
  mapGetSovereignty:     ()    => ipcRenderer.invoke('map-get-sovereignty'),
  mapGetIncursions:      ()    => ipcRenderer.invoke('map-get-incursions'),
  mapGetAllianceTickers:   (ids)         => ipcRenderer.invoke('map-get-alliance-tickers', ids),
  getSovIncursionAlert:    (allianceId)  => ipcRenderer.invoke('get-sov-incursion-alert', allianceId),

  // ── IPC event listeners ───────────────────────────────────────────────────
  // Single `on` definition covering all allowed channels.
  // The callback receives (...args) — the ipcRenderer _event object is stripped.
  //
  // `on` RETURNS AN UNSUBSCRIBE FUNCTION — prefer it over `off`.
  //
  // The listener actually handed to ipcRenderer is a wrapper (it strips the
  // event object), never the caller's `fn`. So the old
  // `off: (ch, fn) => ipcRenderer.removeListener(ch, fn)` could never match:
  // removeListener compares by reference, and `fn` was never registered. Every
  // off() call in the app was a silent no-op and the listeners accumulated for
  // the life of the window — one more per structure repair, character sync, SDE
  // update or updater download, each re-running its handler forever.
  //
  // Keeping the wrapper in a registry fixes off(), but that still relies on the
  // caller's function arriving across contextBridge with a stable identity.
  // The returned unsubscribe closes over its own wrapper and needs no identity
  // at all, so it works regardless — use it.
  on: (channel, fn) => {
    if (!IPC_EVENT_CHANNELS.includes(channel)) return () => {};
    const wrapper = (_, ...args) => fn(...args);
    ipcRenderer.on(channel, wrapper);

    let bucket = _listenerRegistry.get(fn);
    if (!bucket) { bucket = new Map(); _listenerRegistry.set(fn, bucket); }
    let wrappers = bucket.get(channel);
    if (!wrappers) { wrappers = []; bucket.set(channel, wrappers); }
    wrappers.push(wrapper);

    // A channel quietly climbing past this is the signature of the bug above
    // coming back: a subscribe site being re-entered without a matching
    // unsubscribe. Warn rather than fail — it's a leak, not a crash.
    const n = ipcRenderer.listenerCount(channel);
    if (n > 20) console.warn(`[preload] ${n} listeners on "${channel}" — likely a missing unsubscribe`);

    let done = false;
    return () => {
      if (done) return;
      done = true;
      ipcRenderer.removeListener(channel, wrapper);
      const w = _listenerRegistry.get(fn)?.get(channel);
      if (w) {
        const i = w.indexOf(wrapper);
        if (i >= 0) w.splice(i, 1);
      }
    };
  },

  // Kept for callers that still pass the original function. Removes one wrapper
  // registered for that (fn, channel). Only works when `fn` arrives with a
  // stable identity across the bridge — the unsubscribe returned by `on` does
  // not have that caveat, so prefer it.
  off: (channel, fn) => {
    const wrappers = _listenerRegistry.get(fn)?.get(channel);
    const wrapper  = wrappers && wrappers.pop();
    if (wrapper) ipcRenderer.removeListener(channel, wrapper);
  },
});