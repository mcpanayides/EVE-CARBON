const { ipcMain } = require('electron');

const { ESI_BASE } = require('../app_ident');   // one definition — src/shared/esi.js

/**
 * registerBlueprintHandlers
 *
 * @param {object} deps
 * @param {function} deps.getValidToken - returns a valid ESI access token for a characterId
 * @param {function} deps.httpGet       - unauthenticated HTTP GET helper
 * @param {function} deps.resolveNames  - resolves an array of ids -> { id: name } map
 * @param {function} deps.loadDB        - loads the local JSON database
 * @param {function} deps.saveDB        - saves the local JSON database
 * @param {object}   deps.charInfoDb    - character info DB module (for get-all-blueprints-from-db)
 */
function registerBlueprintHandlers({
  ipcHandle,
  getValidToken,
  httpGet,
  resolveNames,
  loadDB,
  saveDB,
  charInfoDb,
}) {

  // ─── IPC: Get all blueprints across all characters (from JSON DB) ──────────
  ipcHandle('get-all-blueprints', () => {
    const db  = loadDB();
    const all = [];
    for (const [charId, data] of Object.entries(db.blueprints)) {
      const account = db.accounts[charId];
      if (data && data.items) {
        data.items.forEach(bp => all.push({
          ...bp,
          characterId,
          characterName: account?.characterName || 'Unknown',
        }));
      }
    }
    return all;
  });

}

module.exports = { registerBlueprintHandlers };