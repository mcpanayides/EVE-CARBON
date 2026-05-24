const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eveAPI', {

  // Full character sync → character_information.db
  syncCharacterFull:        (characterId) => ipcRenderer.invoke('sync-character-full', characterId),

  // Read stored character data from CharDB
  getCharacterInfoDb:       (characterId) => ipcRenderer.invoke('get-character-info-db', characterId),
  getCharacterAssetsDb:     (characterId) => ipcRenderer.invoke('get-character-assets-db', characterId),
  getCharacterBlueprintsDb: (characterId) => ipcRenderer.invoke('get-character-blueprints-db', characterId),

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
  getAllBlueprints:   ()       => ipcRenderer.invoke('get-all-blueprints'),

  // Public ESI / Fuzzwork
  search:                (q)       => ipcRenderer.invoke('esi-search', q),
  getNames:              (ids)     => ipcRenderer.invoke('esi-names', ids),
  getBlueprintMaterials: (id)      => ipcRenderer.invoke('get-blueprint-materials', id),
  findBpForProduct:      (id)      => ipcRenderer.invoke('find-bp-for-product', id),
  getProductForBlueprint:(id)      => ipcRenderer.invoke('get-product-for-blueprint', id),
  getWalletBalance:      (charId)  => ipcRenderer.invoke('get-wallet', charId),
  getJitaPrices:         (typeIds) => ipcRenderer.invoke('get-jita-prices', typeIds),

  // Jobs
  getCharacterJobs: (characterId) => ipcRenderer.invoke('get-character-jobs', characterId),

  // Assets
  syncAssets:    (charId) => ipcRenderer.invoke('sync-assets', charId),
  syncAllAssets: ()       => ipcRenderer.invoke('sync-all-assets'),
  getAssets:     (charId) => ipcRenderer.invoke('get-assets', charId),
  getAllAssets:   ()       => ipcRenderer.invoke('get-all-assets'),

  // SDE
  sdeGetName: (id) => ipcRenderer.invoke('sde-get-name', id),

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

  // Jabber
  connectJabber:    (config) => ipcRenderer.invoke('jabber-connect', config),
  disconnectJabber: ()       => ipcRenderer.invoke('jabber-disconnect'),

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
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_, ...args) => fn(...args));
    }
  },

  off: (channel, fn) => ipcRenderer.removeListener(channel, fn),
});