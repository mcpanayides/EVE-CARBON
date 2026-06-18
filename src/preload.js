const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eveAPI', {

  // Full character sync → character_information.db (manual SYNC button)
  syncCharacterFull:        (characterId) => ipcRenderer.invoke('sync-character-full', characterId),

  // Frequent-cadence auto-refresh: core data only (no assets), plus a separate
  // asset sync that self-skips unless assets are older than ASSET_STALE_MS (6 h).
  syncCharacterCore:           (characterId) => ipcRenderer.invoke('sync-character-core', characterId),
  syncCharacterAssetsIfStale:  (characterId) => ipcRenderer.invoke('sync-character-assets-if-stale', characterId),

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
  getWalletTransactions:  (charId) => ipcRenderer.invoke('get-wallet-transactions', charId),
  getLoyaltyPoints:       (charId) => ipcRenderer.invoke('get-loyalty-points', charId),

  // Accounts
  getAccounts:   ()    => ipcRenderer.invoke('get-accounts'),
  removeAccount: (id)  => ipcRenderer.invoke('remove-account', id),
  startSSOLogin: ()    => ipcRenderer.invoke('start-sso-login'),

  // Dashboard data
  esiFetch:              (url)                      => ipcRenderer.invoke('esi-fetch', url),
  getCharacterInfo:      (characterId)              => ipcRenderer.invoke('get-character-info', characterId),
  getClones:             (characterId)              => ipcRenderer.invoke('get-clones', characterId),
  getMarketPrices:       ()                         => ipcRenderer.invoke('get-market-prices'),
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
  search:                (q)       => ipcRenderer.invoke('esi-search', q),
  getNames:              (ids)     => ipcRenderer.invoke('esi-names', ids),
  getBlueprintMaterials: (id)      => ipcRenderer.invoke('get-blueprint-materials', id),
  findBpForProduct:      (id)      => ipcRenderer.invoke('find-bp-for-product', id),
  getProductForBlueprint:(id)      => ipcRenderer.invoke('get-product-for-blueprint', id),
  getWalletBalance:      (charId)  => ipcRenderer.invoke('get-wallet', charId),
  getJitaPrices:         (typeIds) => ipcRenderer.invoke('get-jita-prices', typeIds),
  getTypeMetadata:       (typeIds) => ipcRenderer.invoke('get-type-metadata', typeIds),
  sdeGetPlanetRegions:   ()         => ipcRenderer.invoke('sde-get-planet-regions'),
  sdeGetRegionPlanets:   (regionId) => ipcRenderer.invoke('sde-get-region-planets', regionId),

  // Jobs
  getCharacterJobs:       (characterId) => ipcRenderer.invoke('get-character-jobs', characterId),
  getCharacterActiveJobs:    (characterId)             => ipcRenderer.invoke('get-character-active-jobs', characterId),
  setAutopilotDestination:   (characterId, systemId)   => ipcRenderer.invoke('set-autopilot-destination', { characterId, systemId }),

  // Assets
  syncAssets:    (charId) => ipcRenderer.invoke('sync-assets', charId),
  syncAllAssets: ()       => ipcRenderer.invoke('sync-all-assets'),
  repairStructureLocations: () => ipcRenderer.invoke('repair-structure-locations'),

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

  // Alliance packs
  getPacks:            ()       => ipcRenderer.invoke('get-packs'),
  importPack:          ()       => ipcRenderer.invoke('import-pack'),
  deletePack:          (id)     => ipcRenderer.invoke('delete-pack', id),

  // App metadata
  getAppVersion:       ()       => ipcRenderer.invoke('get-app-version'),

  // Theme / palette
  themeGetAll:         ()       => ipcRenderer.invoke('theme-get-all'),
  themeGet:            (id)     => ipcRenderer.invoke('theme-get', id),
  themeGetActive:      ()       => ipcRenderer.invoke('theme-get-active'),
  themeSetActive:      (id)     => ipcRenderer.invoke('theme-set-active', id),
  themeSaveCustom:     (data)   => ipcRenderer.invoke('theme-save-custom', data),
  themeDeleteCustom:   (id)     => ipcRenderer.invoke('theme-delete-custom', id),

  // Salvage Calculator
  salvageGetRigData:   ()       => ipcRenderer.invoke('salvage-get-rig-data'),

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