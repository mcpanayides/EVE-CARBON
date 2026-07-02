const { contextBridge, ipcRenderer } = require('electron');

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
  getCharacterInfoDb:       (characterId) => ipcRenderer.invoke('get-character-info-db', characterId),
  getCharacterAssetsDb:     (characterId) => ipcRenderer.invoke('get-character-assets-db', characterId),
  getAssetSyncedAt:         (characterId) => ipcRenderer.invoke('get-asset-synced-at', characterId),
  getCharacterBlueprintsDb: (characterId) => ipcRenderer.invoke('get-character-blueprints-db', characterId),

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

  // Accounts
  getAccounts:   ()    => ipcRenderer.invoke('get-accounts'),
  removeAccount: (id)  => ipcRenderer.invoke('remove-account', id),
  startSSOLogin: ()    => ipcRenderer.invoke('start-sso-login'),

  // Dashboard data
  esiFetch:              (url)                      => ipcRenderer.invoke('esi-fetch', url),
  httpGetText:           (url)                      => ipcRenderer.invoke('http-get-text', url),
  forumLogin:            (baseUrl)                  => ipcRenderer.invoke('forum-login', baseUrl),
  forumSessionStatus:    ()                         => ipcRenderer.invoke('forum-session-status'),
  forumFetchText:        (url)                      => ipcRenderer.invoke('forum-fetch-text', url),
  scrapeForumEvents:     (url)                      => ipcRenderer.invoke('forum-scrape-events', url),
  forumLogout:           ()                         => ipcRenderer.invoke('forum-logout'),
  getCharacterInfo:      (characterId)              => ipcRenderer.invoke('get-character-info', characterId),
  getClones:             (characterId)              => ipcRenderer.invoke('get-clones', characterId),
  getMarketPrices:       ()                         => ipcRenderer.invoke('get-market-prices'),
  getMarketMovers:       ()                         => ipcRenderer.invoke('get-market-movers'),
  getStructureInfo:      (structureId, characterId) => ipcRenderer.invoke('get-structure-info', structureId, characterId),
  resolveLocation:       (locationId, characterId)  => ipcRenderer.invoke('resolve-location', locationId, characterId),
  resolveSystemNames:    (systemIds)                => ipcRenderer.invoke('resolve-system-names', systemIds),
  getCharacterOrders:    (characterId)              => ipcRenderer.invoke('get-character-orders', characterId),
  getCharacterContracts: (characterId)              => ipcRenderer.invoke('get-character-contracts', characterId),

  // Blueprints
  syncBlueprints:    (charId) => ipcRenderer.invoke('sync-blueprints', charId),
  getBlueprints:     (charId) => ipcRenderer.invoke('get-blueprints', charId),
  getAllBlueprintsFromDb: () => ipcRenderer.invoke('get-all-blueprints-from-db'),

  // Public ESI / Fuzzwork
  searchTypes:           (q, lim)  => ipcRenderer.invoke('sde-search-types', q, lim),
  searchMarketTypes:     (q, lim)  => ipcRenderer.invoke('sde-search-market-types', q, lim),
  search:                (q)       => ipcRenderer.invoke('esi-search', q),
  getNames:              (ids)     => ipcRenderer.invoke('esi-names', ids),
  getBlueprintMaterials: (id)      => ipcRenderer.invoke('get-blueprint-materials', id),
  findBpForProduct:      (id)      => ipcRenderer.invoke('find-bp-for-product', id),
  getProductForBlueprint:(id)      => ipcRenderer.invoke('get-product-for-blueprint', id),
  getWalletBalance:      (charId)  => ipcRenderer.invoke('get-wallet', charId),
  getJitaPrices:         (typeIds) => ipcRenderer.invoke('get-jita-prices', typeIds),
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
  getCharacterJobs:       (characterId) => ipcRenderer.invoke('get-character-jobs', characterId),
  getCharacterActiveJobs:    (characterId)             => ipcRenderer.invoke('get-character-active-jobs', characterId),
  setAutopilotDestination:   (characterId, systemId)   => ipcRenderer.invoke('set-autopilot-destination', { characterId, systemId }),
  setAutopilotRoute:         (characterId, systemIds)  => ipcRenderer.invoke('set-autopilot-route', { characterId, systemIds }),

  // Assets
  syncAssets:    (charId) => ipcRenderer.invoke('sync-assets', charId),
  syncAllAssets: ()       => ipcRenderer.invoke('sync-all-assets'),
  repairStructureLocations: () => ipcRenderer.invoke('repair-structure-locations'),
  wipeAssets:    ()       => ipcRenderer.invoke('wipe-assets'),

  // Background images
  listBackgrounds: () => ipcRenderer.invoke('list-backgrounds'),
  pickBackground:  () => ipcRenderer.invoke('pick-background'),
  getAssets:     (charId) => ipcRenderer.invoke('get-assets', charId),
  getAllAssets:   ()       => ipcRenderer.invoke('get-all-assets'),

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
  getUIConfig:  ()       => ipcRenderer.invoke('ui-get-config'),
  saveUIConfig: (config) => ipcRenderer.invoke('ui-save-config', config),

  // App settings
  getAppConfig:  ()       => ipcRenderer.invoke('app-get-config'),
  saveAppConfig: (config) => ipcRenderer.invoke('app-save-config', config),

  // App preferences (General tab): start-with-Windows + minimize-to-tray
  getAppPreferences: ()        => ipcRenderer.invoke('get-app-preferences'),
  setLaunchAtLogin:  (enabled) => ipcRenderer.invoke('set-launch-at-login', enabled),
  setMinimizeToTray: (enabled) => ipcRenderer.invoke('set-minimize-to-tray', enabled),

  // Ping file watcher
  watchPingFile:   (path) => ipcRenderer.invoke('watch-ping-file', path),
  unwatchPingFile: ()     => ipcRenderer.invoke('unwatch-ping-file'),

  // GSF SIGs / Squads metadata (yaml/gsf_sigs.yaml)
  getSigGroups:     () => ipcRenderer.invoke('get-sig-groups'),
  getCommsChannels: () => ipcRenderer.invoke('get-comms-channels'),

  // Fleet join helpers
  openCharacterInfoWindow: (characterId, targetId) => ipcRenderer.invoke('open-character-info-window', { characterId, targetId }),
  resolveCharacterIds: (names)            => ipcRenderer.invoke('resolve-character-ids', names),
  systemIdByName: (name)                  => ipcRenderer.invoke('sde-system-id-by-name', name),
  openExternalUrl: (url)                  => ipcRenderer.invoke('open-external-url', url),
  setWaypoint: (characterId, systemId)    => ipcRenderer.invoke('set-autopilot-destination', { characterId, systemId }),

  // Jabber
  connectJabber:       (config) => ipcRenderer.invoke('jabber-connect', config),
  disconnectJabber:    ()       => ipcRenderer.invoke('jabber-disconnect'),
  getJabberMessages:   (limit)  => ipcRenderer.invoke('jabber-get-messages', limit),
  wipeJabberData:      ()       => ipcRenderer.invoke('jabber-wipe-data'),
  openPingAlert:       (rowId)  => ipcRenderer.invoke('jabber-open-ping-alert', rowId),
  getPingAlertData:    ()       => ipcRenderer.invoke('jabber-get-ping-alert-data'),
  getBeehiveStatus:    ()       => ipcRenderer.invoke('beehive-get-status'),

  // Alliance packs
  getPacks:            ()       => ipcRenderer.invoke('get-packs'),
  importPack:          ()       => ipcRenderer.invoke('import-pack'),
  deletePack:          (id)     => ipcRenderer.invoke('delete-pack', id),

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

  // Fitting tool
  fitSearch:        (query, kind, limit) => ipcRenderer.invoke('fit-search', query, kind, limit),
  fitBrowseTree:    (kind)               => ipcRenderer.invoke('fit-browse-tree', kind),
  fitGetHull:       (typeId)             => ipcRenderer.invoke('fit-get-hull', typeId),
  fitGetItems:      (typeIds)            => ipcRenderer.invoke('fit-get-items', typeIds),
  fitLookupNames:   (names)              => ipcRenderer.invoke('fit-lookup-names', names),
  fitGetFittings:   (characterId)        => ipcRenderer.invoke('fit-get-fittings', characterId),
  fitSaveFitting:   (characterId, fit)   => ipcRenderer.invoke('fit-save-fitting', characterId, fit),

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
  mapGetJumpBridges:     ()    => ipcRenderer.invoke('map-get-jump-bridges'),
  mapGetAllianceTickers:   (ids)         => ipcRenderer.invoke('map-get-alliance-tickers', ids),
  getSovIncursionAlert:    (allianceId)  => ipcRenderer.invoke('get-sov-incursion-alert', allianceId),

  // ── IPC event listeners ───────────────────────────────────────────────────
  // Single `on` definition covering all allowed channels.
  // The callback receives (...args) — the ipcRenderer _event object is stripped.
  on: (channel, fn) => {
    const allowed = [
      'account-added',
      'auth-error',
      'char-sync-progress',
      'jabber-status',
      'jabber-message',
      'beehive-status',
      'ping-file-updated',
      'ping-alert-data',
      'repair-progress',
      'sde-update-progress',
      'updater-download-progress',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_, ...args) => fn(...args));
    }
  },

  off: (channel, fn) => ipcRenderer.removeListener(channel, fn),
});