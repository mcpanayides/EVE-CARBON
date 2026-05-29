const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const createLocator           = require('./src/locator');
const charInfoDb              = require('./src/character_info_db');
const jabberDataDb            = require('./src/jabber_data_db');
const { registerAccountHandlers }   = require('./src/ipc/accounts_ipc');
const { registerCharacterHandlers } = require('./src/ipc/character_ipc');
const { registerEsiHandlers }       = require('./src/ipc/esi_ipc');
const { registerBlueprintHandlers } = require('./src/ipc/blueprint_ipc');
const { registerAssetHandlers }     = require('./src/ipc/assets_ipc');
const { registerStationHandlers }   = require('./src/ipc/station_ipc');
const { registerConfigHandlers }    = require('./src/ipc/config_ipc');
const { registerPingFileHandlers }  = require('./src/ipc/ping_ipc');
const { registerPIHandlers, syncPIForCharacter } = require('./src/ipc/pi_ipc');

// Load environment variables from .env file in both development and production.
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

// Global reference to the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

if (typeof globalThis.crypto !== 'object' || typeof globalThis.crypto.randomUUID !== 'function') {
  globalThis.crypto = globalThis.crypto || {};
  globalThis.crypto.randomUUID = () => {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes].map((b, i) => {
      const hex = b.toString(16).padStart(2, '0');
      return [4, 6, 8, 10].includes(i) ? `-${hex}` : hex;
    }).join('');
  };
}

// ─── Prevent XMPP stream-race from crashing the main process ─────────────────
process.on('uncaughtException', (err) => {
  // @xmpp/client can throw "Cannot read properties of null (reading 'write')"
  // when the TCP socket is destroyed mid-stream. Log it but don't crash.
  if (err && err.message && err.message.includes("reading 'write'")) {
    console.warn('[XMPP] Suppressed stream race error:', err.message);
    return;
  }
  // Re-throw anything unrelated so real bugs still surface
  console.error('[Uncaught]', err);
});


// ─── Config ───────────────────────────────────────────────────────────────────
const SSO_AUTH_URL   = 'https://login.eveonline.com/v2/oauth/authorize/';
const SSO_TOKEN_URL  = 'https://login.eveonline.com/v2/oauth/token';
const SSO_VERIFY_URL = 'https://login.eveonline.com/oauth/verify';
const ESI_BASE       = 'https://esi.evetech.net';
const FUZZWORK_BASE  = 'https://www.fuzzwork.co.uk';
const CALLBACK_PORT  = 12500;
// Must match EXACTLY what is registered in the EVE developer portal
const CALLBACK_URL = 'http://127.0.0.1:12500/auth/callback/';
const CLIENT_ID      = process.env.EVE_CLIENT_ID;
const CLIENT_SECRET  = process.env.EVE_CLIENT_SECRET;
const SCOPES         = [
  'esi-characters.read_blueprints.v1',          // character blueprints + ME/PE/TE
  'esi-assets.read_assets.v1',                  // assets
  'esi-corporations.read_blueprints.v1',        // corp blueprints
  'esi-industry.read_character_jobs.v1',        // character industry jobs
  'esi-industry.read_corporation_jobs.v1',      // corp industry jobs (only returns jobs where the character is the installer, not all corp jobs)
  'esi-wallet.read_character_wallet.v1',        // wallet balance
  'esi-clones.read_clones.v1',                  // home location + jump clones + implants
  'esi-clones.read_implants.v1',                // implants 
  'esi-skills.read_skills.v1',                  // total skill points
  'esi-markets.read_character_orders.v1',       // active market orders (escrow)
  'esi-contracts.read_character_contracts.v1',  // contracts (escrow)
  'esi-location.read_location.v1',              // current solar system / station
  'esi-location.read_ship_type.v1',             // current ship type
  'esi-planets.manage_planets.v1',              // planetary interaction colonies
  'esi-characters.read_loyalty.v1',             // loyalty points per corporation
  'esi-skills.read_skills.v1',                  // total skill points 
  'esi-skills.read_skillqueue.v1',              // current skill queue (for estimating free time until next SP gain) 
  'esi-fleets.read_fleet.v1',                    // for fleet role tags in Jabber messages (e.g. FC, squad commander, etc.)


].join(' ');
// ─── Local DB ────────────────────────────────────────────────────────────────────
 
// Use sqlite3 (native) with the promise-based `sqlite` wrapper. This avoids
// relying on `better-sqlite3` native bindings which can be fragile when
// packaging Electron apps. The `sqlite` API is async and works well with
// `ipcRenderer.invoke` from the renderer.
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
 
// SDE DB handle (sqlite) if available
let sdeDb = null;
 
function getSdePath() {
  // In production, packaged apps should read from process.resourcesPath
  // (your extraResources / unpacked files end up there)
  const devPath  = path.join(__dirname, 'data', 'sde.sql');
  const prodPath = path.join(process.resourcesPath || __dirname, 'data', 'sde.sql');
 
  const sdePath = app.isPackaged ? prodPath : devPath;
  return sdePath;
}
 
async function initSde() {
  const sdePath = getSdePath();
  if (!fs.existsSync(sdePath)) {
    console.log('[SDE] not found at', sdePath);
    return;
  }
 
  try {
    sdeDb = await open({ filename: sdePath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    console.log('[SDE] opened:', sdePath);
  } catch (e) {
    console.log('[SDE] failed to open:', e.message);
    sdeDb = null;
  }
}
 
// ─── Paths ────────────────────────────────────────────────────────────────────
let userDataPath, dbPath, configPath, cacheDir, appDataDir;
// Shared state for ping file watcher — passed into registerPingFileHandlers
// so the app-quit handler can still close it without knowing the internals.
const pingWatcherState = { watcher: null, timer: null };
 
function initPaths() {
  userDataPath = app.getPath('userData');
  dbPath       = path.join(userDataPath, 'blueprints.json');
  configPath   = path.join(userDataPath, 'config.json');
  cacheDir     = path.join(userDataPath, 'cache');
  // character_information.db lives in the project /data folder (beside sde.sql)
  appDataDir   = app.isPackaged
    ? path.join(process.resourcesPath || __dirname, 'data')
    : path.join(__dirname, 'data');
  try { fs.mkdirSync(cacheDir,   { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(appDataDir, { recursive: true }); } catch (e) { /* ignore */ }
}
 
function getCachePath(key) {
  const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cacheDir || userDataPath || '.', `${safe}.json`);
}
 
function readCache(key) {
  try {
    const fullPath = getCachePath(key);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts) return null;
    if (Date.now() - parsed.ts > (parsed.ttl || 0)) {
      fs.unlinkSync(fullPath);
      return null;
    }
    return parsed.v;
  } catch (e) {
    return null;
  }
}
 
function writeCache(key, value, days = 7) {
  try {
    const fullPath = getCachePath(key);
    const payload = { ts: Date.now(), ttl: days * 24 * 60 * 60 * 1000, v: value };
    fs.writeFileSync(fullPath, JSON.stringify(payload), 'utf8');
  } catch (e) { /* ignore */ }
}
 
// ─── Safe IPC re-registration wrapper ───────────────────────────────────────
// Removes any existing handler first so calling register*Handlers() more than
// once (e.g. after a dev hot-reload) never throws "second handler" errors.
function ipcHandle(channel, fn) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, fn);
}

// Locator: shared location resolver (player structures + NPC stations)
let locator = null;
function getLocator() {
  if (!locator) locator = createLocator({
    httpGet, readCache, writeCache, getValidToken,
    // Pass the shared station DB helpers so the locator checks local tables
    // before hitting any external network source (Step 0 fast-path).
    getStationById:         (...a) => charInfoDb.getStationById(...a),
    upsertNpcStations:      (...a) => charInfoDb.upsertNpcStations(...a),
    upsertUpwellStructures: (...a) => charInfoDb.upsertUpwellStructures(...a),
  });
  return locator;
}
 
app.whenReady().then(async () => {
  initPaths();
  await initSde();
  try {
    await charInfoDb.initCharacterDb(appDataDir);
  } catch (e) {
    console.error('[charInfoDb] init failed, continuing:', e.message);
  }
  try {
    await jabberDataDb.initJabberDb(appDataDir, userDataPath);
  } catch (e) {
    console.error('[jabberDataDb] init failed, continuing:', e.message);
  }
  registerAccountHandlers({
    ipcHandle,
    loadDB,
    saveDB,
    charInfoDb,
    httpPost,
    fullCharacterSync,
    callbackServerState,
  });
  registerCharacterHandlers({
    ipcHandle,
    charInfoDb,
    loadDB,
    getValidToken,
    httpGet,
    resolveNames,
    readCache,
    writeCache,
  });
  registerEsiHandlers({
    ipcHandle,
    httpGet,
    httpPost,
    resolveNames,
    readCache,
    writeCache,
    getLocator,
    bpCache,
    getSdeDb: () => sdeDb,
  });
  registerBlueprintHandlers({
    ipcHandle,
    getValidToken,
    httpGet,
    resolveNames,
    loadDB,
    saveDB,
    charInfoDb,
  });
  registerAssetHandlers({
    ipcHandle,
    getValidToken,
    httpGet,
    resolveNames,
    getLocator,
    loadDB,
    saveDB,
    readCache,
    writeCache,
    charInfoDb,
    coreCharacterSync,
  });
  registerStationHandlers({
    ipcHandle,
    charInfoDb,
    getLocator,
    httpPost,
  });
  registerConfigHandlers({
    ipcHandle,
    readCache,
    writeCache,
    loadConfig,
    saveConfig,
  });
  registerPingFileHandlers({
    ipcHandle,
    watcherState: pingWatcherState,
  });
  registerPIHandlers({
    ipcHandle,
    getValidToken,
    httpGet,
    resolveNames,
    charInfoDb,
    getSdeDb: () => sdeDb,
  });
  // Jabber must register AFTER initPaths() so configPath is set, and AFTER
  // registerConfigHandlers() so app-get-config is available when jabber_ipc
  // reads saved credentials on startup.
  const { registerJabberHandlers } = require('./src/jabber_ipc');
  registerJabberHandlers({ ipcHandle, jabberDataDb, createPingAlertWindow });
  // Open the window only after ALL IPC handlers are registered.
  // Previously createWindow() was called first, causing the renderer to invoke
  // channels (app-get-config, jabber-get-messages, etc.) before their handlers
  // existed — resulting in "No handler registered for 'x'" errors.
  createWindow();
});
 
 
// ─── Simple JSON "database" s
function loadDB() {
  try { return JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch { return { accounts: {}, blueprints: {}, assets: {} }; }
}
function saveDB(db) { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); }
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2)); }
 
// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: { 'User-Agent': 'EVE-BPC-Calculator/2.0', 'Accept': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) {
          // Surface the Retry-After header so callers can back off correctly
          const retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
          return reject(Object.assign(
            new Error(`HTTP 429: ${url}`),
            { retryAfter, isRateLimit: true }
          ));
        }
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}
 
function httpPost(url, body, headers = {}, formEncoded = false) {
  return new Promise((resolve, reject) => {
    const postData = formEncoded ? body : JSON.stringify(body);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'User-Agent': 'EVE-BPC-Calculator/2.0',
        'Content-Type': formEncoded ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'application/json',
        'Host': urlObj.hostname,
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP POST ${res.statusCode}: ${url} — ${data}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}
 
// ─── Caches ───────────────────────────────────────────────────────────────────
const nameCache = {};
const bpCache   = {};
 
// ─── Local callback HTTP server ───────────────────────────────────────────────
// Shared state object passed into registerAccountHandlers so main.js can still
// close the server on quit without knowing its internals.
const callbackServerState = { server: null, start: null };
 
// ─── Token refresh ────────────────────────────────────────────────────────────
async function getValidToken(characterId) {
  const db = loadDB();
  const account = db.accounts[characterId];
  if (!account) throw new Error('Account not found');
 
  // If token still valid (with 60s buffer), return it
  if (Date.now() < account.expiresAt - 60000) return account.accessToken;
 
  // Refresh it
  const cfg = loadConfig();
  const formBody = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: account.refreshToken,
    client_id:     CLIENT_ID,
  }).toString();
 
  const tokenData = await httpPost(SSO_TOKEN_URL, formBody, {}, true);
  account.accessToken  = tokenData.access_token;
  account.refreshToken = tokenData.refresh_token || account.refreshToken;
  account.expiresAt    = Date.now() + (tokenData.expires_in * 1000);
  db.accounts[characterId] = account;
  saveDB(db);
  return account.accessToken;
}
 
// ─── Window ───────────────────────────────────────────────────────────────────
// ─── Ping Alert Window ────────────────────────────────────────────────────────
// Opens a frameless, always-on-top popup centred on the primary display
// whenever a director-bot broadcast is received.
 
let activePingAlertWin   = null;  // only one alert at a time
let pendingPingAlertData = null;  // stored BEFORE window creation so the pull IPC can return it

// IPC pull: renderer calls getPingAlertData() -> invoke('jabber-get-ping-alert-data')
// Registered here so it is available as soon as createPingAlertWindow could be called.
ipcHandle('jabber-get-ping-alert-data', () => pendingPingAlertData);

function createPingAlertWindow(msg) {
  // Store the payload BEFORE creating the window so that if the renderer's
  // getPingAlertData() invoke resolves before did-finish-load fires the push,
  // it still gets the correct data.
  pendingPingAlertData = msg;

  // Close any existing alert before opening a new one
  if (activePingAlertWin && !activePingAlertWin.isDestroyed()) {
    activePingAlertWin.close();
  }
 
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const W = 620;
  const H = 420;
 
  const win = new BrowserWindow({
    width:           W,
    height:          H,
    x:               Math.round((sw - W) / 2),
    y:               Math.round((sh - H) / 2),
    resizable:       false,
    movable:         true,
    minimizable:     false,
    maximizable:     false,
    fullscreenable:  false,
    alwaysOnTop:     true,
    skipTaskbar:     false,
    frame:           false,
    transparent:     false,
    backgroundColor: '#070b14',
    webPreferences: {
      preload:          path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
 
  // Set always-on-top at the highest level (screen-saver) so it floats over
  // other applications, not just other Electron windows.
  win.setAlwaysOnTop(true, 'screen-saver');
 
  win.loadFile(path.join(__dirname, 'src', 'ping-alert.html'));
 
  // Push the payload once the renderer is ready -- belt-and-suspenders alongside
  // the pull (getPingAlertData invoke) the renderer script also performs.
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('ping-alert-data', pendingPingAlertData);
  });
 
  activePingAlertWin = win;
  win.on('closed', () => { activePingAlertWin = null; });
}
 
// IPC: renderer close button calls this (ping-alert window closes itself via window.close())
 
function createWindow() {
  const win = new BrowserWindow({
    width: 1800,
    height: 1200,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#070b14',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#070b14', symbolColor: '#ab7ab8', height: 32 },
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
 
  // ADD THIS — remove once issue is resolved
  win.webContents.openDevTools();
 
  const url = require('url');
  win.loadURL(url.format({
    pathname: path.join(__dirname, 'src', 'index.html'),
    protocol: 'file:',
    slashes: true
  }));
  return win;
}
 
// ─── IPC: Config ──────────────────────────────────────────────────────────────
// Config is now hardcoded — no client-side config needed
 
// ─── Blueprint IPC handlers → src/ipc/blueprint_ipc.js ───────────────────────
 
// ─── Implant slot resolver ────────────────────────────────────────────────────
// ESI /v1/characters/{id}/implants/ returns type IDs in no guaranteed order.
// Dogma attribute 331 (implantSlot) holds the slot number (1-10) for stat implants.
// Hardwiring implants use the same attribute. Results cached in a dedicated map.
const implantSlotCache = {};
async function resolveImplantSlots(typeIds) {
  const slotMap = {};
  await Promise.all(typeIds.map(async (id) => {
    if (implantSlotCache[id] !== undefined) {
      slotMap[id] = implantSlotCache[id];
      return;
    }
    try {
      const typeData = await httpGet(
        `${ESI_BASE}/v3/universe/types/${id}/?datasource=tranquility`
      );
      const attrs = typeData?.dogma_attributes || [];
      // Attribute 331 = implantSlot (value 1-10)
      const slotAttr = attrs.find(a => a.attribute_id === 331);
      const slot = slotAttr && slotAttr.value >= 1 && slotAttr.value <= 10
        ? Math.round(slotAttr.value)
        : null;
      implantSlotCache[id] = slot;
      slotMap[id] = slot;
    } catch (_) {
      implantSlotCache[id] = null;
      slotMap[id] = null;
    }
  }));
  return slotMap;
}
 
// ─── Full character data sync ─────────────────────────────────────────────────
// Syncs everything: info, wallet, location, ship, implants, PI, assets, blueprints
// into character_information.db.  Called on first SSO login AND on manual re-sync.
async function fullCharacterSync(characterId, characterName, progressCb) {
  const report = (step, detail) => {
    if (progressCb) progressCb(step, detail);
  };
 
  await charInfoDb.ensureCharacterTables(characterId);
 
  const token = await getValidToken(characterId);
  const authHdr = { Authorization: `Bearer ${token}` };
  const summary = { characterId, characterName, steps: {} };
 
  // 1. Character sheet
  try {
    report('character_info', 'Fetching character sheet…');
    const info = await httpGet(`${ESI_BASE}/v5/characters/${characterId}/?datasource=tranquility`, authHdr);
    await charInfoDb.upsertCharacterInfo(characterId, info);
    summary.steps.info = 'ok';
    report('character_info', `✓ ${info.name || characterName}`);
  } catch (e) {
    summary.steps.info = `error: ${e.message}`;
    report('character_info', `✗ ${e.message}`);
  }
 
  // 2. Wallet balance
  try {
    report('wallet', 'Fetching wallet balance…');
    const balance = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/wallet/?datasource=tranquility`, authHdr);
    await charInfoDb.insertWalletSnapshot(characterId, typeof balance === 'number' ? balance : 0);
    summary.steps.wallet = `${balance} ISK`;
    report('wallet', `✓ ${(balance || 0).toLocaleString()} ISK`);
  } catch (e) {
    summary.steps.wallet = `error: ${e.message}`;
    report('wallet', `✗ ${e.message}`);
  }
 
  // 3. Current location
  try {
    report('location', 'Fetching current location…');
    const loc = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/location/?datasource=tranquility`, authHdr);
    let stationName = null;
    try {
      if (loc.station_id) {
        const sInfo = await getLocator().resolveLocation(loc.station_id, characterId);
        stationName = sInfo?.name || null;
      } else if (loc.structure_id) {
        const sInfo = await getLocator().resolveLocation(loc.structure_id, characterId);
        stationName = sInfo?.name || null;
      }
    } catch (_) {}
    // Resolve system name
    let sysName = null;
    if (loc.solar_system_id) {
      try {
        const nm = await resolveNames([loc.solar_system_id]);
        sysName = nm[loc.solar_system_id] || null;
      } catch (_) {}
    }
    await charInfoDb.upsertLocation(characterId, { ...loc, solar_system_name: sysName }, stationName);
    summary.steps.location = stationName || sysName || 'unknown';
    report('location', `✓ ${stationName || sysName || loc.solar_system_id}`);
  } catch (e) {
    summary.steps.location = `error: ${e.message}`;
    report('location', `✗ ${e.message}`);
  }
 
  // 4. Current ship
  try {
    report('ship', 'Fetching current ship…');
    const ship = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/ship/?datasource=tranquility`, authHdr);
    let typeName = '';
    if (ship.ship_type_id) {
      try {
        const nm = await resolveNames([ship.ship_type_id]);
        typeName = nm[ship.ship_type_id] || '';
      } catch (_) {}
    }
    await charInfoDb.upsertShip(characterId, ship, typeName);
    summary.steps.ship = ship.ship_name || typeName;
    report('ship', `✓ ${ship.ship_name || typeName}`);
  } catch (e) {
    summary.steps.ship = `error: ${e.message}`;
    report('ship', `✗ ${e.message}`);
  }
 
  // 5. Active implants (clones endpoint gives both active implants + jump clones)
  try {
    report('implants', 'Fetching implants & clones…');
    const cloneData = await httpGet(`${ESI_BASE}/v3/characters/${characterId}/clones/?datasource=tranquility`, authHdr);
 
    // Active implants require esi-clones.read_implants.v1 scope.
    // DO NOT silently swallow errors -- a 403/401 means the token is missing
    // the scope; the character must re-authenticate to get a new token.
    let activeImplants = [];
    let implantFetchError = null;
    try {
      const raw = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/implants/?datasource=tranquility`, authHdr);
      activeImplants = Array.isArray(raw) ? raw : [];
      console.log(`[CharSync] implants raw ESI for ${characterId}:`, JSON.stringify(activeImplants));
    } catch (implantErr) {
      implantFetchError = implantErr.message;
      console.error(`[CharSync] ✗ implants fetch FAILED for ${characterId}: ${implantErr.message}`);
      console.error(`[CharSync]   → Likely missing 'esi-clones.read_implants.v1' scope -- re-authenticate the character.`);
      report('implants', `✗ implant fetch failed: ${implantErr.message} (re-authenticate to fix)`);
    }
 
    // Resolve implant type names and real slot numbers (dogma attribute 331)
    const allImplantIds = [...new Set(activeImplants)];
    const implantNames = allImplantIds.length ? await resolveNames(allImplantIds) : {};
    const slotMap      = allImplantIds.length ? await resolveImplantSlots(allImplantIds) : {};
    const implants = allImplantIds.map(id => ({
      implant_id: id,
      type_name:  implantNames[id] || `Type ${id}`,
      slot:       slotMap[id] ?? null,
    }));
    // Only wipe+replace DB rows when the fetch succeeded -- preserve stale data on error.
    if (!implantFetchError) {
      await charInfoDb.replaceImplants(characterId, implants);
    }
    summary.steps.implants = implantFetchError ? `error: ${implantFetchError}` : `${implants.length} active`;
    if (!implantFetchError) {
      report('implants', `✓ ${implants.length} active implants`);
    }
 
    // Jump clones
    if (cloneData && Array.isArray(cloneData.jump_clones)) {
      // Resolve jump clone location names
      const locIds = cloneData.jump_clones.map(c => c.location_id).filter(Boolean);
      const locMeta = locIds.length ? await getLocator().resolveLocations(locIds, characterId) : {};
 
      // Collect all implant IDs from jump clones for batch resolve
      const jcImplantIds = [...new Set(cloneData.jump_clones.flatMap(c => c.implants || []))];
      const jcImplantNames = jcImplantIds.length ? await resolveNames(jcImplantIds) : {};
 
      const jumpClones = cloneData.jump_clones.map(c => ({
        jump_clone_id: c.jump_clone_id,
        location_id:   c.location_id,
        location_name: locMeta[c.location_id]?.name || `Location ${c.location_id}`,
        name:          c.name || null,
        implants:      (c.implants || []).map(id => ({
          type_id:   id,
          type_name: jcImplantNames[id] || `Type ${id}`,
        })),
      }));
      await charInfoDb.replaceJumpClones(characterId, jumpClones);
      summary.steps.jump_clones = `${jumpClones.length} clones`;
      report('implants', `✓ ${jumpClones.length} jump clones`);
    }
  } catch (e) {
    summary.steps.implants = `error: ${e.message}`;
    report('implants', `✗ ${e.message}`);
  }
 
  // 6. Planetary Interaction
  try {
    const count = await syncPIForCharacter(
      { characterId, accessToken: token, httpGet, resolveNames, charInfoDb, getSdeDb: () => sdeDb },
      report
    );
    summary.steps.pi = `${count} colonies`;
  } catch (e) {
    summary.steps.pi = `error: ${e.message}`;
    report('pi', `✗ ${e.message}`);
  }
 
  // 7. Assets (full paginated)
  try {
    report('assets', 'Fetching assets (paginated)…');
    let allAssets = [];
    let page = 1;
    while (true) {
      const data = await httpGet(
        `${ESI_BASE}/v3/characters/${characterId}/assets/?page=${page}&datasource=tranquility`, authHdr
      );
      allAssets = allAssets.concat(data);
      report('assets', `  page ${page}: ${allAssets.length} items so far…`);
      if (!data || data.length < 1000) break;
      page++;
    }
    const typeIds = [...new Set(allAssets.map(a => a.type_id).filter(Boolean))];
    const nameMap = await resolveNames(typeIds);
 
    // Only resolve IDs that are real stations/structures — not container item_ids.
    // Nested items (inside crates, fitted to ships) have location_id = parent item_id.
    // Sending those to the locator always fails; the getCharacterAssets() JOIN handles them.
    const allItemIds      = new Set(allAssets.map(a => a.item_id));
    const rootLocationIds = [...new Set(
      allAssets
        .map(a => a.location_id)
        .filter(id => id && !allItemIds.has(id))
    )];
    const locationMeta = await getLocator().resolveLocations(rootLocationIds, characterId);
 
    const assets = allAssets.map(asset => {
      const loc = locationMeta[asset.location_id] || {};
      return {
        item_id:           asset.item_id,
        type_id:           asset.type_id,
        name:              nameMap[asset.type_id] || `Type ${asset.type_id}`,
        location_id:       asset.location_id,
        // Store null (not a placeholder string) so getUnresolvedAssetLocations() can find it
        location_name:     loc.name || null,
        location_flag:     asset.location_flag || '',
        quantity:          asset.is_singleton ? 1 : (asset.quantity || 1),
        is_singleton:      asset.is_singleton,
        solar_system_id:   loc.solar_system_id   || null,
        solar_system_name: loc.solar_system_name || null,
        region_id:         loc.region_id         || null,
        region_name:       loc.region_name       || null,
        security_status:   typeof loc.security_status === 'number' ? loc.security_status : null,
        owner_id:          loc.owner_id          || null,
        owner_name:        loc.owner_name        || null,
      };
    });
 
    await charInfoDb.replaceAssets(characterId, assets);
    summary.steps.assets = `${assets.length} items`;
    report('assets', `✓ ${assets.length} assets stored`);
 
    // ── Re-resolve any locations that came back null ───────────────────────────
    // Upwell structures that 401'd or missed Hammertime get a second pass here.
    // The locator's file cache is now warm, so many will succeed this time.
    const unresolved = await charInfoDb.getUnresolvedAssetLocations(characterId).catch(() => []);
    if (unresolved.length) {
      report('assets', `  Re-resolving ${unresolved.length} unresolved structure location(s)…`);
      for (const locationId of unresolved) {
        try {
          const geo = await getLocator().resolveLocation(locationId, characterId);
          if (geo && (geo.name || geo.solar_system_id)) {
            await charInfoDb.updateAssetLocation(characterId, locationId, geo);
          }
        } catch (e) {
          console.log(`[CharSync] Re-resolve failed for location ${locationId}: ${e.message}`);
        }
      }
      const stillUnresolved = await charInfoDb.getUnresolvedAssetLocations(characterId).catch(() => []);
      const fixed = unresolved.length - stillUnresolved.length;
      report('assets', `  Location re-resolve: ${fixed} fixed, ${stillUnresolved.length} still pending.`);
    }
  } catch (e) {
    summary.steps.assets = `error: ${e.message}`;
    report('assets', `✗ ${e.message}`);
  }
 
  // 8. Blueprints (full paginated)
  try {
    report('blueprints', 'Fetching blueprints (paginated)…');
    let allBPs = [];
    let page = 1;
    while (true) {
      const data = await httpGet(
        `${ESI_BASE}/v3/characters/${characterId}/blueprints/?page=${page}&datasource=tranquility`, authHdr
      );
      allBPs = allBPs.concat(data);
      report('blueprints', `  page ${page}: ${allBPs.length} blueprints so far…`);
      if (data.length < 1000) break;
      page++;
    }
    const typeIds = [...new Set(allBPs.map(b => b.type_id))];
    const nameMap = await resolveNames(typeIds);
    const blueprints = allBPs.map(bp => ({
      item_id:       bp.item_id,
      type_id:       bp.type_id,
      name:          nameMap[bp.type_id] || `Type ${bp.type_id}`,
      location_id:   bp.location_id,
      location_flag: bp.location_flag,
      quantity:      bp.quantity,
      runs:          bp.runs,
      me:            bp.material_efficiency,
      te:            bp.time_efficiency,
      isBPC:         bp.quantity === -2,
    }));
    await charInfoDb.replaceBlueprints(characterId, blueprints);
    summary.steps.blueprints = `${blueprints.length} BPs`;
    report('blueprints', `✓ ${blueprints.length} blueprints stored`);
 
    // Also update the legacy blueprints.json so existing blueprint UI still works
    const db2 = loadDB();
    db2.blueprints[characterId] = { updatedAt: Date.now(), items: blueprints };
    saveDB(db2);
  } catch (e) {
    summary.steps.blueprints = `error: ${e.message}`;
    report('blueprints', `✗ ${e.message}`);
  }
 
  // 9. Wallet journal (most recent 2500 entries)
  try {
    report('wallet_journal', 'Fetching wallet journal…');
    const journal = await httpGet(
      `${ESI_BASE}/v6/characters/${characterId}/wallet/journal/?datasource=tranquility&page=1`,
      authHdr
    );
    if (Array.isArray(journal)) {
      await charInfoDb.replaceWalletJournal(characterId, journal);
      summary.steps.wallet_journal = `${journal.length} entries`;
      report('wallet_journal', `✓ ${journal.length} journal entries`);
    }
  } catch (e) {
    summary.steps.wallet_journal = `error: ${e.message}`;
    report('wallet_journal', `✗ ${e.message}`);
  }
 
  // 10. Wallet transactions (most recent 2500)
  try {
    report('wallet_transactions', 'Fetching wallet transactions…');
    const raw = await httpGet(
      `${ESI_BASE}/v1/characters/${characterId}/wallet/transactions/?datasource=tranquility`,
      authHdr
    );
    if (Array.isArray(raw)) {
      // Resolve type names and location names in batch
      const typeIds     = [...new Set(raw.map(t => t.type_id).filter(Boolean))];
      const locationIds = [...new Set(raw.map(t => t.location_id).filter(Boolean))];
      const nameMap     = typeIds.length     ? await resolveNames(typeIds)                               : {};
      const locMeta     = locationIds.length ? await getLocator().resolveLocations(locationIds, characterId) : {};
      const transactions = raw.map(t => ({
        ...t,
        type_name:     nameMap[t.type_id]             || `Type ${t.type_id}`,
        location_name: locMeta[t.location_id]?.name   || `Location ${t.location_id}`,
      }));
      await charInfoDb.replaceWalletTransactions(characterId, transactions);
      summary.steps.wallet_transactions = `${transactions.length} txns`;
      report('wallet_transactions', `✓ ${transactions.length} transactions`);
    }
  } catch (e) {
    summary.steps.wallet_transactions = `error: ${e.message}`;
    report('wallet_transactions', `✗ ${e.message}`);
  }
 
  // 11. Loyalty points
  try {
    report('loyalty_points', 'Fetching loyalty points…');
    const lpRaw = await httpGet(
      `${ESI_BASE}/v1/characters/${characterId}/loyalty/points/?datasource=tranquility`,
      authHdr
    );
    if (Array.isArray(lpRaw)) {
      // Resolve corporation names in batch
      const corpIds  = [...new Set(lpRaw.map(r => r.corporation_id).filter(Boolean))];
      const nameMap  = corpIds.length ? await resolveNames(corpIds) : {};
      const lpRows   = lpRaw.map(r => ({
        corporation_id:   r.corporation_id,
        loyalty_points:   r.loyalty_points || 0,
        corporation_name: nameMap[r.corporation_id] || `Corp ${r.corporation_id}`,
      }));
      await charInfoDb.replaceLoyaltyPoints(characterId, lpRows);
      summary.steps.loyalty_points = `${lpRows.length} corps`;
      report('loyalty_points', `✓ ${lpRows.length} LP entries`);
    }
  } catch (e) {
    summary.steps.loyalty_points = `error: ${e.message}`;
    report('loyalty_points', `✗ ${e.message}`);
  }
 
  return summary;
}
 
// ─── IPC: Full character sync (manual re-sync button) ─────────────────────────
ipcHandle('sync-character-full', async (event, characterId) => {
  const db = loadDB();
  const account = db.accounts[characterId];
  if (!account) throw new Error('Account not found');
  const characterName = account.characterName;
  const win = BrowserWindow.fromWebContents(event.sender);
 
  const summary = await fullCharacterSync(characterId, characterName, (step, detail) => {
    console.log(`[CharSync] ${characterName} — ${step}: ${detail}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('char-sync-progress', { characterId, characterName, step, detail });
    }
  });
  return summary;
});
 
// ─── Core-only sync (everything except assets) ────────────────────────────────
// Called by the 20-minute auto-refresh. Assets are deliberately excluded so
// they can be governed by their own 12-hour staleness rule via
// 'sync-character-assets-if-stale'.
async function coreCharacterSync(characterId, characterName, progressCb) {
  const report = (step, detail) => { if (progressCb) progressCb(step, detail); };
 
  await charInfoDb.ensureCharacterTables(characterId);
  const token   = await getValidToken(characterId);
  const authHdr = { Authorization: `Bearer ${token}` };
  const summary = { characterId, characterName, steps: {} };
 
  // 1. Character sheet
  try {
    report('character_info', 'Fetching character sheet…');
    const info = await httpGet(`${ESI_BASE}/v5/characters/${characterId}/?datasource=tranquility`, authHdr);
    await charInfoDb.upsertCharacterInfo(characterId, info);
    summary.steps.info = 'ok';
    report('character_info', `✓ ${info.name || characterName}`);
  } catch (e) { summary.steps.info = `error: ${e.message}`; report('character_info', `✗ ${e.message}`); }
 
  // 2. Wallet balance
  try {
    report('wallet', 'Fetching wallet balance…');
    const balance = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/wallet/?datasource=tranquility`, authHdr);
    await charInfoDb.insertWalletSnapshot(characterId, typeof balance === 'number' ? balance : 0);
    summary.steps.wallet = `${balance} ISK`;
    report('wallet', `✓ ${(balance || 0).toLocaleString()} ISK`);
  } catch (e) { summary.steps.wallet = `error: ${e.message}`; report('wallet', `✗ ${e.message}`); }
 
  // 3. Current location
  try {
    report('location', 'Fetching current location…');
    const loc = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/location/?datasource=tranquility`, authHdr);
    let stationName = null;
    try {
      if (loc.station_id)  { const s = await getLocator().resolveLocation(loc.station_id,  characterId); stationName = s?.name || null; }
      else if (loc.structure_id) { const s = await getLocator().resolveLocation(loc.structure_id, characterId); stationName = s?.name || null; }
    } catch (_) {}
    let sysName = null;
    if (loc.solar_system_id) {
      try { const nm = await resolveNames([loc.solar_system_id]); sysName = nm[loc.solar_system_id] || null; } catch (_) {}
    }
    await charInfoDb.upsertLocation(characterId, { ...loc, solar_system_name: sysName }, stationName);
    summary.steps.location = stationName || sysName || 'unknown';
    report('location', `✓ ${stationName || sysName || loc.solar_system_id}`);
  } catch (e) { summary.steps.location = `error: ${e.message}`; report('location', `✗ ${e.message}`); }
 
  // 4. Current ship
  try {
    report('ship', 'Fetching current ship…');
    const ship = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/ship/?datasource=tranquility`, authHdr);
    let typeName = '';
    if (ship.ship_type_id) { try { const nm = await resolveNames([ship.ship_type_id]); typeName = nm[ship.ship_type_id] || ''; } catch (_) {} }
    await charInfoDb.upsertShip(characterId, ship, typeName);
    summary.steps.ship = ship.ship_name || typeName;
    report('ship', `✓ ${ship.ship_name || typeName}`);
  } catch (e) { summary.steps.ship = `error: ${e.message}`; report('ship', `✗ ${e.message}`); }
 
  // 5. Implants & jump clones (1-hour stale gate)
  // coreCharacterSync runs on every auto-refresh (every ~20 min). Implants change
  // very rarely so we skip the ESI call entirely if the DB data is under 1 hour old.
  const IMPLANT_STALE_MS = 60 * 60 * 1000; // 1 hour
  try {
    const lastImplantSync = await charInfoDb.getImplantsSyncedAt(characterId).catch(() => 0);
    const implantAge = Date.now() - lastImplantSync;
    if (implantAge < IMPLANT_STALE_MS) {
      summary.steps.implants = 'skipped (fresh)';
      report('implants', `⏩ implants fresh (${Math.round(implantAge / 60000)} min old), skipping ESI call`);
    } else {
      report('implants', 'Fetching implants & clones…');
      const cloneData = await httpGet(`${ESI_BASE}/v3/characters/${characterId}/clones/?datasource=tranquility`, authHdr);
      let activeImplants = [];
      let implantFetchError = null;
      try {
        const raw = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/implants/?datasource=tranquility`, authHdr);
        activeImplants = Array.isArray(raw) ? raw : [];
        console.log(`[CharSync] coreSync implants raw ESI for ${characterId}:`, JSON.stringify(activeImplants));
      } catch (implantErr) {
        implantFetchError = implantErr.message;
        console.error(`[CharSync] ✗ coreSync implants fetch FAILED for ${characterId}: ${implantErr.message}`);
        console.error(`[CharSync]   → Likely missing 'esi-clones.read_implants.v1' scope -- re-authenticate the character.`);
        report('implants', `✗ implant fetch failed: ${implantErr.message} (re-authenticate to fix)`);
      }
      const allImplantIds  = [...new Set(activeImplants)];
      const implantNames   = allImplantIds.length ? await resolveNames(allImplantIds) : {};
      const slotMap        = allImplantIds.length ? await resolveImplantSlots(allImplantIds) : {};
      const implants = allImplantIds.map(id => ({ implant_id: id, type_name: implantNames[id] || `Type ${id}`, slot: slotMap[id] ?? null }));
      if (!implantFetchError) {
        await charInfoDb.replaceImplants(characterId, implants);
      }
      summary.steps.implants = implantFetchError ? `error: ${implantFetchError}` : `${implants.length} active`;
      if (!implantFetchError) {
        report('implants', `✓ ${implants.length} active implants`);
      }
      if (cloneData && Array.isArray(cloneData.jump_clones)) {
        const locIds       = cloneData.jump_clones.map(c => c.location_id).filter(Boolean);
        const locMeta      = locIds.length ? await getLocator().resolveLocations(locIds, characterId) : {};
        const jcImplantIds = [...new Set(cloneData.jump_clones.flatMap(c => c.implants || []))];
        const jcNames      = jcImplantIds.length ? await resolveNames(jcImplantIds) : {};
        const jumpClones   = cloneData.jump_clones.map(c => ({
          jump_clone_id: c.jump_clone_id, location_id: c.location_id,
          location_name: locMeta[c.location_id]?.name || `Location ${c.location_id}`,
          name: c.name || null,
          implants: (c.implants || []).map(id => ({ type_id: id, type_name: jcNames[id] || `Type ${id}` })),
        }));
        await charInfoDb.replaceJumpClones(characterId, jumpClones);
        summary.steps.jump_clones = `${jumpClones.length} clones`;
        report('implants', `✓ ${jumpClones.length} jump clones`);
      }
    } // end stale-check else
  } catch (e) { summary.steps.implants = `error: ${e.message}`; report('implants', `✗ ${e.message}`); }
 
  // 6. Planetary Interaction
  try {
    const count = await syncPIForCharacter(
      { characterId, accessToken: token, httpGet, resolveNames, charInfoDb, getSdeDb: () => sdeDb },
      report
    );
    summary.steps.pi = `${count} colonies`;
  } catch (e) { summary.steps.pi = `error: ${e.message}`; report('pi', `✗ ${e.message}`); }
 
  // 7. Blueprints (full paginated) — kept in core; small payload, fast
  try {
    report('blueprints', 'Fetching blueprints…');
    let allBPs = [], page = 1;
    while (true) {
      const data = await httpGet(`${ESI_BASE}/v3/characters/${characterId}/blueprints/?page=${page}&datasource=tranquility`, authHdr);
      allBPs = allBPs.concat(data);
      report('blueprints', `  page ${page}: ${allBPs.length} blueprints…`);
      if (data.length < 1000) break;
      page++;
    }
    const typeIds = [...new Set(allBPs.map(b => b.type_id))];
    const nameMap = await resolveNames(typeIds);
    const blueprints = allBPs.map(bp => ({
      item_id: bp.item_id, type_id: bp.type_id, name: nameMap[bp.type_id] || `Type ${bp.type_id}`,
      location_id: bp.location_id, location_flag: bp.location_flag,
      quantity: bp.quantity, runs: bp.runs, me: bp.material_efficiency, te: bp.time_efficiency,
      isBPC: bp.quantity === -2,
    }));
    await charInfoDb.replaceBlueprints(characterId, blueprints);
    summary.steps.blueprints = `${blueprints.length} BPs`;
    report('blueprints', `✓ ${blueprints.length} blueprints stored`);
    const db2 = loadDB();
    db2.blueprints[characterId] = { updatedAt: Date.now(), items: blueprints };
    saveDB(db2);
  } catch (e) { summary.steps.blueprints = `error: ${e.message}`; report('blueprints', `✗ ${e.message}`); }
 
  // 8. Wallet journal (30-min cadence — skip if recently synced)
  const WALLET_JOURNAL_STALE_MS = 30 * 60 * 1000;
  try {
    const lastSync = await charInfoDb.getWalletJournalSyncedAt(characterId).catch(() => 0);
    if (Date.now() - lastSync >= WALLET_JOURNAL_STALE_MS) {
      report('wallet_journal', 'Fetching wallet journal…');
      const journal = await httpGet(
        `${ESI_BASE}/v6/characters/${characterId}/wallet/journal/?datasource=tranquility&page=1`,
        authHdr
      );
      if (Array.isArray(journal)) {
        await charInfoDb.replaceWalletJournal(characterId, journal);
        summary.steps.wallet_journal = `${journal.length} entries`;
        report('wallet_journal', `✓ ${journal.length} journal entries`);
      }
 
      // Wallet transactions (fetched alongside journal on same cadence)
      const raw = await httpGet(
        `${ESI_BASE}/v1/characters/${characterId}/wallet/transactions/?datasource=tranquility`,
        authHdr
      );
      if (Array.isArray(raw)) {
        const typeIds     = [...new Set(raw.map(t => t.type_id).filter(Boolean))];
        const locationIds = [...new Set(raw.map(t => t.location_id).filter(Boolean))];
        const nameMap     = typeIds.length     ? await resolveNames(typeIds)                                : {};
        const locMeta     = locationIds.length ? await getLocator().resolveLocations(locationIds, characterId) : {};
        const transactions = raw.map(t => ({
          ...t,
          type_name:     nameMap[t.type_id]           || `Type ${t.type_id}`,
          location_name: locMeta[t.location_id]?.name || `Location ${t.location_id}`,
        }));
        await charInfoDb.replaceWalletTransactions(characterId, transactions);
        summary.steps.wallet_transactions = `${transactions.length} txns`;
        report('wallet_transactions', `✓ ${transactions.length} transactions`);
      }
 
      // Loyalty points (same cadence)
      const lpRaw = await httpGet(
        `${ESI_BASE}/v1/characters/${characterId}/loyalty/points/?datasource=tranquility`,
        authHdr
      );
      if (Array.isArray(lpRaw)) {
        const corpIds = [...new Set(lpRaw.map(r => r.corporation_id).filter(Boolean))];
        const nameMap = corpIds.length ? await resolveNames(corpIds) : {};
        const lpRows  = lpRaw.map(r => ({
          corporation_id:   r.corporation_id,
          loyalty_points:   r.loyalty_points || 0,
          corporation_name: nameMap[r.corporation_id] || `Corp ${r.corporation_id}`,
        }));
        await charInfoDb.replaceLoyaltyPoints(characterId, lpRows);
        summary.steps.loyalty_points = `${lpRows.length} corps`;
        report('loyalty_points', `✓ ${lpRows.length} LP entries`);
      }
    } else {
      report('wallet_journal', 'wallet journal fresh — skipping');
    }
  } catch (e) {
    summary.steps.wallet_journal = `error: ${e.message}`;
    report('wallet_journal', `✗ ${e.message}`);
  }
 
  return summary;
}

async function resolveNames(ids) {
  const uncached = ids.filter(id => !nameCache[id]);
  if (uncached.length) {
    const chunks = [];
    for (let i = 0; i < uncached.length; i += 1000) chunks.push(uncached.slice(i, i + 1000));
    for (const chunk of chunks) {
      try {
        const result = await httpPost(`${ESI_BASE}/v3/universe/names/?datasource=tranquility`, chunk);
        result.forEach(r => { nameCache[r.id] = r.name; });
      } catch { /* skip */ }
    }
  }
  return Object.fromEntries(ids.map(id => [id, nameCache[id] || `Type ${id}`]));
}
 
// ─── SDE update helpers ───────────────────────────────────────────────────────
const SDE_MD5_URL = 'https://www.fuzzwork.co.uk/dump/sqlite-latest.sqlite.bz2.md5';
const SDE_BZ2_URL = 'https://www.fuzzwork.co.uk/dump/sqlite-latest.sqlite.bz2';

function getSdeMd5Path() {
  const devPath  = path.join(__dirname, 'data', 'sde.md5');
  const prodPath = path.join(process.resourcesPath || __dirname, 'data', 'sde.md5');
  return app.isPackaged ? prodPath : devPath;
}

async function fetchRemoteSdeMd5() {
  return new Promise((resolve, reject) => {
    https.request(SDE_MD5_URL, {
      headers: { 'User-Agent': 'EVE-Carbon/1.0' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        // Format: "<hash>  filename" — grab just the hash
        resolve(data.trim().split(/\s+/)[0]);
      });
    }).on('error', reject).end();
  });
}

// sde-check-update → { upToDate, remoteMd5, localMd5 }
ipcHandle('sde-check-update', async () => {
  try {
    const remoteMd5 = await fetchRemoteSdeMd5();
    let localMd5 = null;
    try { localMd5 = fs.readFileSync(getSdeMd5Path(), 'utf8').trim(); } catch { /* no local md5 yet */ }
    return { upToDate: remoteMd5 === localMd5, remoteMd5, localMd5 };
  } catch (e) {
    return { error: e.message };
  }
});

// sde-download-update — streams the bz2, decompresses, replaces sde.sql, saves md5
// Sends 'sde-update-progress' push events: { stage, percent }
ipcHandle('sde-download-update', async (event) => {
  const sdePath  = getSdePath();
  const md5Path  = getSdeMd5Path();
  const win      = BrowserWindow.fromWebContents(event.sender);
  const push     = (stage, percent) => {
    if (win && !win.isDestroyed()) win.webContents.send('sde-update-progress', { stage, percent });
  };

  try {
    push('Fetching version info…', 0);
    const remoteMd5 = await fetchRemoteSdeMd5();

    push('Downloading SDE…', 5);

    // Ensure data directory exists
    const dataDir = path.dirname(sdePath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // Download + decompress using Node's https (no axios at runtime)
    await new Promise((resolve, reject) => {
      const bz2 = require('unbzip2-stream');
      const tmpPath = sdePath + '.tmp';
      const writer  = fs.createWriteStream(tmpPath);

      https.request(SDE_BZ2_URL, {
        headers: { 'User-Agent': 'EVE-Carbon/1.0' }
      }, (res) => {
        if (res.statusCode >= 400) {
          writer.destroy();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded   = 0;
        let lastPct      = 5;

        res.on('data', chunk => {
          downloaded += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.round(5 + (downloaded / totalBytes) * 85);
            if (pct !== lastPct) { push('Downloading SDE…', pct); lastPct = pct; }
          }
        });

        res.pipe(bz2()).pipe(writer);

        writer.on('finish', () => {
          // Atomically replace the live file
          try { fs.renameSync(tmpPath, sdePath); } catch (e) {
            fs.copyFileSync(tmpPath, sdePath);
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          }
          resolve();
        });
        writer.on('error', (e) => { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } reject(e); });
        res.on('error', reject);
      }).on('error', reject).end();
    });

    push('Saving version info…', 92);
    fs.writeFileSync(md5Path, remoteMd5, 'utf8');

    push('Done', 100);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// sde-restart-app — relaunch so the new sde.sql is picked up by initSde()
ipcHandle('sde-restart-app', () => {
  app.relaunch();
  app.exit(0);
});

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.on('window-all-closed', () => {
  if (callbackServerState.server) callbackServerState.server.close();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});