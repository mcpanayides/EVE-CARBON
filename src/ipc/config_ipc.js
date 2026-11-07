const { ipcMain } = require('electron');

/**
 * registerConfigHandlers
 *
 * @param {object} deps
 * @param {function} deps.readCache   - reads from persistent file cache
 * @param {function} deps.writeCache  - writes to persistent file cache
 * @param {function} deps.loadConfig  - loads the JSON app config
 * @param {function} deps.saveConfig  - saves the JSON app config
 */
function registerConfigHandlers({
  ipcHandle,
  readCache,
  writeCache,
  loadConfig,
  saveConfig,
}) {

  // ─── IPC: Persistent user data cache ──────────────────────────────────────
  ipcHandle('cache-get', (_, key) => {
    return readCache(key);
  });

  ipcHandle('cache-set', (_, key, value, days = 7) => {
    writeCache(key, value, days);
    return true;
  });

  // ─── IPC: App settings ────────────────────────────────────────────────────
  ipcHandle('app-get-config', () => {
    const cfg = loadConfig();
    return cfg || {};
  });

  ipcHandle('app-save-config', (_, appConfig) => {
    const cfg = loadConfig();
    cfg.app = cfg.app || {};
    cfg.app = { ...cfg.app, ...appConfig };
    saveConfig(cfg);
    return true;
  });

  // ─── IPC: Tutorial ────────────────────────────────────────────────────────
  // What the guided tour remembers (seen, basicDone, advancedDone; written back
  // through app-save-config), plus one fact only this process knows: an e2e run
  // never opens the tour by itself, or it would sit over every test that removes
  // its last character and reloads.
  ipcHandle('tutorial-get-state', () => ({
    ...(loadConfig()?.app?.tutorial || {}),
    suppressAutoStart: process.env.EVE_CARBON_E2E === '1',
  }));
}

module.exports = { registerConfigHandlers };