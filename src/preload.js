const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eveAPI', {
  // Accounts
  getAccounts:   ()     => ipcRenderer.invoke('get-accounts'),
  removeAccount: (id)   => ipcRenderer.invoke('remove-account', id),
  startSSOLogin: ()     => ipcRenderer.invoke('start-sso-login'),

  // Blueprints
  syncBlueprints:    (charId) => ipcRenderer.invoke('sync-blueprints', charId),
  getBlueprints:     (charId) => ipcRenderer.invoke('get-blueprints', charId),
  getAllBlueprints:   ()       => ipcRenderer.invoke('get-all-blueprints'),

  // Public ESI / Fuzzwork
  search:                (q)  => ipcRenderer.invoke('esi-search', q),
  getNames:              (ids) => ipcRenderer.invoke('esi-names', ids),
  getBlueprintMaterials: (id)  => ipcRenderer.invoke('get-blueprint-materials', id),
  findBpForProduct:      (id)  => ipcRenderer.invoke('find-bp-for-product', id),

  // Events from main
  on: (channel, fn) => {
    const allowed = ['account-added', 'auth-error'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, ...args) => fn(...args));
  },
  off: (channel, fn) => ipcRenderer.removeListener(channel, fn),
});
