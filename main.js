// ── Load .env FIRST — before any IPC modules that read process.env at load time ──
const path   = require('path');
const { app } = require('electron');
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath, quiet: true }); // quiet: suppress dotenv's startup tip line

// ── Now safe to require everything else ────────────────────────────────────────
const { BrowserWindow, ipcMain, shell, screen } = require('electron');
const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const fs    = require('fs');
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
const { registerMapHandlers }       = require('./src/ipc/map_ipc');
const { registerUpdaterHandlers }   = require('./src/ipc/updater_ipc');
const { registerThemeHandlers }     = require('./src/ipc/theme_ipc');

// Global reference to the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

// ─── Single-instance lock ─────────────────────────────────────────────────────
// Without this, launching the app a second time (or a leftover process from a
// previous run) spawns another Electron instance that fights the first over the
// same Chromium cache folder in userData, producing the
//   "Unable to move the cache: Access is denied (0x5)"
//   "Unable to create cache" / "Gpu Cache Creation failed"
// errors. Holding a single-instance lock means the second launch hands focus to
// the running window and exits instead of colliding on the cache.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

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
// Terminal logs are UTF-8; a Windows console in a non-UTF-8 code page renders
// glyphs like — ✓ ✗ … as mojibake (тАФ / тЬУ …). Strip to ASCII for stdout logs
// only — the in-app HTML console (renderer process) keeps the real glyphs.
const _ascii = (s) => String(s)
  .replace(/—/g, '-').replace(/…/g, '...')
  .replace(/✓/g, '[ok]').replace(/✗/g, '[x]').replace(/→/g, '->');
// Wrap console.* once so every main-process log is ASCII-safe regardless of the
// terminal's code page. Covers all modules (shared console) and future logs.
for (const _m of ['log', 'warn', 'error', 'info']) {
  const _orig = console[_m].bind(console);
  console[_m] = (...args) => _orig(...args.map(a => (typeof a === 'string' ? _ascii(a) : a)));
}
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
  'esi-characters.read_standings.v1',           // NPC faction/corp standings (broker-fee reduction in trade calc)
  'esi-skills.read_skills.v1',                  // total skill points 
  'esi-skills.read_skillqueue.v1',              // current skill queue (for estimating free time until next SP gain) 
  'esi-fleets.read_fleet.v1',                    // for fleet role tags in Jabber messages (e.g. FC, squad commander, etc.)
  'esi-ui.write_waypoint.v1',                    // set autopilot destination in active EVE client
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
let userDataPath, dbPath, configPath, cacheDir, appDataDir, userPacksDir, userThemesDir, userBackgroundsDir;
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
  userPacksDir  = path.join(userDataPath, 'packs');
  userThemesDir = path.join(userDataPath, 'themes');
  userBackgroundsDir = path.join(userDataPath, 'backgrounds');
  try { fs.mkdirSync(cacheDir,     { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(appDataDir,   { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(userPacksDir, { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(userThemesDir,{ recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(userBackgroundsDir, { recursive: true }); } catch (e) { /* ignore */ }
}

// ─── IPC: Background images ───────────────────────────────────────────────────
// Lets the user set a wallpaper behind the UI. Images come from two folders:
//   • bundled presets → assets/backgrounds/ (drop images here to ship them)
//   • user-added      → userData/backgrounds/ (copied in via the file picker)
// Both are returned as file:// URLs the renderer can use directly (the window
// is itself a file:// page, so there's no CSP/security barrier).
const _BG_IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

function _bundledBackgroundsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath || __dirname, 'assets', 'backgrounds')
    : path.join(__dirname, 'assets', 'backgrounds');
}

function _scanBackgroundDir(dir, source) {
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!_BG_IMG_EXT.has(path.extname(f).toLowerCase())) continue;
      const abs = path.join(dir, f);
      out.push({ id: `${source}:${f}`, name: path.parse(f).name, source, url: require('url').pathToFileURL(abs).href });
    }
  } catch (_) { /* folder may not exist yet */ }
  return out;
}

ipcHandle('list-backgrounds', async () => {
  const all = [
    ..._scanBackgroundDir(_bundledBackgroundsDir(), 'preset'),
    ..._scanBackgroundDir(userBackgroundsDir, 'user'),
  ];
  // Dedupe by filename so a user copy shadows a preset of the same name.
  const seen = new Map();
  for (const b of all) seen.set(b.name.toLowerCase(), b);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
});

ipcHandle('pick-background', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    title: 'Choose a background image',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const src      = result.filePaths[0];
  const fileName = path.basename(src);
  try {
    fs.mkdirSync(userBackgroundsDir, { recursive: true });
    const dest = path.join(userBackgroundsDir, fileName);
    fs.copyFileSync(src, dest);
    return { canceled: false, background: { id: `user:${fileName}`, name: path.parse(fileName).name, source: 'user', url: require('url').pathToFileURL(dest).href } };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});
 
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
    // SDE-first name resolution: region/system/type names come from disk so the
    // locator's bulk-name step skips ESI for everything except corps/alliances.
    resolveNamesFromSde:    (...a) => resolveNamesFromSde(...a),
    // Shared persistent cache for dynamic names (corps/alliances) so the locator
    // and main.js reuse each other's resolutions across restarts.
    getCachedNames:         (...a) => charInfoDb.getCachedNames(...a),
    putCachedNames:         (...a) => charInfoDb.putCachedNames(...a),
  });
  return locator;
}
 
// Resolve a pack YAML file path from a packId stored in config.
// packId formats:
//   undefined / 'gsf_sigs'   → built-in yaml/gsf_sigs.yaml
//   'some_id'                → built-in yaml/some_id.yaml
//   'user:filename.yaml'     → userData/packs/filename.yaml
function resolvePackFile(packId) {
  const cfg      = loadConfig();
  const activeId = packId || cfg?.app?.jabber?.pack || 'gsf_sigs';
  if (activeId.startsWith('user:')) {
    const fileName = activeId.slice(5);
    return { filePath: path.join(userPacksDir, fileName), baseDir: userPacksDir };
  }
  const yamlName = /\.(yaml|yml)$/.test(activeId) ? activeId : `${activeId}.yaml`;
  return {
    filePath: path.join(__dirname, 'yaml', yamlName),
    baseDir:  path.join(__dirname, 'yaml'),
  };
}

// Handlers that need no async init — register before app.whenReady() so they
// are always available regardless of what the async chain does later.
ipcMain.handle('open-external-url', (_, url) => {
  if (url && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
ipcMain.handle('get-app-version', () => app.getVersion());

// Trade-fee profile for the Ore/Ice/Gas calculators: Accounting + Broker
// Relations skill levels and NPC standings (keyed by from_id). Returns nulls if
// the character hasn't been synced yet so the renderer can fall back to defaults.
ipcMain.handle('get-trade-profile', async (_, characterId) => {
  if (!characterId) return null;
  try {
    const profile   = await charInfoDb.getTradeProfile(characterId);
    const standings = await charInfoDb.getStandings(characterId);
    return {
      accounting:      profile ? profile.accounting      : null,
      brokerRelations: profile ? profile.brokerRelations : null,
      standings:       standings || {},
    };
  } catch (e) {
    return { accounting: null, brokerRelations: null, standings: {} };
  }
});

// Skill levels for a character (e.g. the jump planner reads JDC/JFC/Jump
// Freighters). Returns { skillTypeId: level }; empty if the character isn't synced.
ipcMain.handle('get-skill-levels', async (_, characterId, typeIds) => {
  if (!characterId) return {};
  try { return await charInfoDb.getSkillLevels(characterId, typeIds); }
  catch (e) { return {}; }
});

// Moon ore reprocessing outputs from the local SDE (invTypeMaterials). Returns
// { [oreTypeId]: { name, volume, portionSize, outputs:[{id,name,quantity}] } }.
// Empty {} when the SDE isn't downloaded — the Moon Calculator falls back to its
// hardcoded primary-moon-material estimate.
ipcMain.handle('get-moon-reprocessing', async (_, typeIds) => {
  const out = {};
  if (!sdeDb || !Array.isArray(typeIds) || !typeIds.length) return out;
  try {
    const ph = typeIds.map(() => '?').join(',');
    const types = await sdeDb.all(
      `SELECT typeID, typeName, volume, portionSize FROM invTypes WHERE typeID IN (${ph})`, typeIds
    );
    for (const t of types) {
      out[t.typeID] = { name: t.typeName, volume: t.volume, portionSize: t.portionSize || 100, outputs: [] };
    }
    const mats = await sdeDb.all(
      `SELECT m.typeID AS oreId, m.materialTypeID AS matId, m.quantity AS qty, mt.typeName AS matName
         FROM invTypeMaterials m
         JOIN invTypes mt ON mt.typeID = m.materialTypeID
        WHERE m.typeID IN (${ph})`, typeIds
    );
    for (const m of mats) {
      if (out[m.oreId]) out[m.oreId].outputs.push({ id: m.matId, name: m.matName, quantity: m.qty });
    }
  } catch (e) {
    console.log('[moon] reprocessing query failed:', e.message);
    return {};
  }
  return out;
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;   // second instance is quitting — don't init/open
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
    httpGetFull,
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
  registerMapHandlers({
    ipcHandle,
    httpGet,
    readCache,
    writeCache,
    getSdeDb: () => sdeDb,
  });
  registerUpdaterHandlers({ ipcHandle, app, loadConfig, saveConfig });
  registerThemeHandlers({ ipcHandle, app, loadConfig, saveConfig, userThemesDir });
  // Jabber must register AFTER initPaths() so configPath is set, and AFTER
  // registerConfigHandlers() so app-get-config is available when jabber_ipc
  // reads saved credentials on startup.
  const { registerJabberHandlers } = require('./src/jabber_ipc');
  registerJabberHandlers({ ipcHandle, jabberDataDb, createPingAlertWindow });

  // Open a character's info window in the active EVE client.
  // Requires esi-ui.open_window.v1 scope. EVE shows "Find Fleet" in the info
  // card if that character has a fleet advert up — player clicks it in-game.
  ipcHandle('open-character-info-window', async (_, { characterId, targetId }) => {
    const token = await getValidToken(characterId);
    const url   = `https://esi.evetech.net/v1/ui/openwindow/information/?target_id=${targetId}&datasource=tranquility`;
    const res   = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => '');
      throw new Error(`ESI open window ${res.status}: ${body}`);
    }
    return { success: true };
  });

  // Resolve character names → character IDs via ESI /universe/ids/ (public, no auth)
  // Returns [{ name, id }] for matched characters; unmatched names are omitted.
  ipcHandle('resolve-character-ids', async (_, names) => {
    if (!Array.isArray(names) || !names.length) return [];
    try {
      const result = await httpPost(
        'https://esi.evetech.net/latest/universe/ids/?datasource=tranquility',
        names
      );
      return (result.characters || []).map(c => ({ name: c.name, id: c.id }));
    } catch (e) {
      console.warn('[resolve-character-ids] failed:', e.message);
      return [];
    }
  });

  // Resolve a solar system name → solarSystemID from the local SDE
  ipcHandle('sde-system-id-by-name', async (_, name) => {
    if (!sdeDb || !name) return null;
    const row = await sdeDb.get(
      `SELECT solarSystemID FROM mapSolarSystems WHERE LOWER(solarSystemName) = LOWER(?)`,
      [name.trim()]
    );
    return row?.solarSystemID ?? null;
  });

  // Comms channels — reads the active alliance pack (from config), returns comms_channels array
  ipcHandle('get-comms-channels', async () => {
    try {
      const yaml               = require('js-yaml');
      const { filePath }       = resolvePackFile();
      const raw                = fs.readFileSync(filePath, 'utf8');
      const data               = yaml.load(raw);
      return (data.comms_channels || []).map(c => ({
        name:  c.name,
        match: Array.isArray(c.match) ? c.match : [c.match],
        url:   c.url || '',
      }));
    } catch (e) {
      console.warn('[get-comms-channels] failed:', e.message);
      return [];
    }
  });

  // SIGs / Squads — reads the active alliance pack (from config), returns groups with icon URLs
  ipcHandle('get-sig-groups', async () => {
    try {
      const yaml               = require('js-yaml');
      const { pathToFileURL }  = require('url');
      const { filePath, baseDir } = resolvePackFile();
      const raw                = fs.readFileSync(filePath, 'utf8');
      const data               = yaml.load(raw);
      return (data.groups || []).map(g => ({
        name:    g.name,
        type:    g.type,
        color:   g.color,
        iconUrl: g.icon ? pathToFileURL(path.join(baseDir, g.icon)).href : null,
      }));
    } catch (e) {
      console.warn('[get-sig-groups] failed:', e.message);
      return [];
    }
  });

  // Alliance pack management ─────────────────────────────────────────────────

  // Returns all available packs: built-in (yaml/) + user-imported (userData/packs/)
  ipcHandle('get-packs', async () => {
    const jsy   = require('js-yaml');
    const packs = [];

    const scanDir = (dir, source) => {
      try {
        const files = fs.readdirSync(dir).filter(f => /\.(yaml|yml)$/.test(f));
        for (const file of files) {
          try {
            const raw  = fs.readFileSync(path.join(dir, file), 'utf8');
            const data = jsy.load(raw);
            if (!data || (!data.groups && !data.comms_channels)) continue;
            const id = source === 'user' ? `user:${file}` : file.replace(/\.(yaml|yml)$/, '');
            packs.push({
              id,
              source,
              file,
              name:        data.pack_info?.name        || file.replace(/\.(yaml|yml)$/, ''),
              alliance:    data.pack_info?.alliance     || '',
              description: data.pack_info?.description  || '',
              author:      data.pack_info?.author       || '',
              version:     data.pack_info?.version      || '',
            });
          } catch {}
        }
      } catch {}
    };

    scanDir(path.join(__dirname, 'yaml'), 'builtin');
    scanDir(userPacksDir, 'user');
    return packs;
  });

  // Opens a file-picker so the user can import a YAML pack into userData/packs/
  ipcHandle('import-pack', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      title: 'Import Alliance Pack',
      filters: [{ name: 'YAML Pack Files', extensions: ['yaml', 'yml'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };

    const srcPath = result.filePaths[0];
    const jsy     = require('js-yaml');
    try {
      const raw  = fs.readFileSync(srcPath, 'utf8');
      const data = jsy.load(raw);
      if (!data || (!data.groups && !data.comms_channels)) {
        return { success: false, error: 'Invalid pack: must contain groups or comms_channels sections' };
      }
      const fileName = path.basename(srcPath);
      fs.copyFileSync(srcPath, path.join(userPacksDir, fileName));
      return {
        success: true,
        pack: {
          id:          `user:${fileName}`,
          source:      'user',
          file:        fileName,
          name:        data.pack_info?.name        || fileName.replace(/\.(yaml|yml)$/, ''),
          alliance:    data.pack_info?.alliance     || '',
          description: data.pack_info?.description  || '',
          author:      data.pack_info?.author       || '',
          version:     data.pack_info?.version      || '',
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Deletes a user-imported pack (cannot delete built-in packs)
  ipcHandle('delete-pack', async (_, packId) => {
    if (!packId?.startsWith('user:')) return { success: false, error: 'Cannot delete built-in packs' };
    const fileName = packId.slice(5);
    const filePath = path.join(userPacksDir, fileName);
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: 'Pack file not found' };
      fs.unlinkSync(filePath);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ── Salvage Calculator — all rig blueprints with their salvage material requirements ──
  ipcHandle('salvage-get-rig-data', async () => {
    if (!sdeDb) return null;
    try {
      const rows = await sdeDb.all(`
        WITH rig_size AS (
          SELECT typeID, CAST(valueFloat AS INTEGER) AS rigSize
          FROM dgmTypeAttributes
          WHERE attributeID = 1547
        )
        SELECT
          p.typeID          AS blueprintTypeID,
          p.productTypeID   AS rigTypeID,
          rt.typeName       AS rigName,
          m.materialTypeID  AS matTypeID,
          mt.typeName       AS matName,
          m.quantity        AS matQty,
          COALESCE(rs.rigSize, 0) AS rigSize
        FROM industryActivityProducts p
        JOIN invTypes rt ON rt.typeID = p.productTypeID
        JOIN industryActivityMaterials m  ON m.typeID = p.typeID AND m.activityID = 1
        JOIN invTypes mt ON mt.typeID = m.materialTypeID
        LEFT JOIN rig_size rs ON rs.typeID = p.productTypeID
        WHERE p.activityID = 1
          AND mt.groupID = 754
        ORDER BY rt.typeName, mt.typeName
      `);

      const salvageMats = await sdeDb.all(`
        SELECT typeID, typeName
        FROM invTypes
        WHERE groupID = 754 AND published = 1
        ORDER BY typeName
      `);

      const rigMap = new Map();
      for (const row of rows) {
        if (!rigMap.has(row.rigTypeID)) {
          rigMap.set(row.rigTypeID, {
            blueprintTypeID: row.blueprintTypeID,
            rigTypeID:       row.rigTypeID,
            rigName:         row.rigName,
            rigSize:         row.rigSize,
            materials:       [],
          });
        }
        rigMap.get(row.rigTypeID).materials.push({
          typeID: row.matTypeID,
          name:   row.matName,
          qty:    row.matQty,
        });
      }

      return { rigs: Array.from(rigMap.values()), salvageMats };
    } catch (e) {
      console.error('[salvage-get-rig-data]', e.message);
      return null;
    }
  });

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
 
// Like httpGet but also returns the ESI X-Pages header.
// Use this for paginated ESI endpoints so we never stop early.
// Returns: { data: parsedBody, xPages: number }
function httpGetFull(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: { 'User-Agent': 'EVE-BPC-Calculator/2.0', 'Accept': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
          return reject(Object.assign(
            new Error(`HTTP 429: ${url}`),
            { retryAfter, isRateLimit: true }
          ));
        }
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        try {
          resolve({
            data:   JSON.parse(data),
            xPages: parseInt(res.headers['x-pages'] || '1', 10),
          });
        } catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── ESI retry wrapper ────────────────────────────────────────────────────────
// Wraps httpGetFull with up to 3 retries and proper Retry-After / back-off
// so a transient 429 or 5xx during asset pagination never silently drops a page.
// Pass authHdr so a fresh token can be fetched if a 401 occurs mid-sync.
async function httpGetFullWithRetry(url, headers = {}, maxRetries = 3) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let attempt = 0;
  while (true) {
    try {
      return await httpGetFull(url, headers);
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) throw err;

      if (err.isRateLimit) {
        // ESI told us exactly how long to wait
        const wait = ((err.retryAfter || 60) + 2) * 1000;
        console.warn(`[ESI] 429 on ${url} — waiting ${err.retryAfter}s (attempt ${attempt}/${maxRetries})`);
        await sleep(wait);
      } else if (err.message && err.message.includes('HTTP 5')) {
        // 5xx — brief exponential back-off
        const wait = Math.min(2 ** attempt * 1000, 30000);
        console.warn(`[ESI] transient error on ${url} — retry in ${wait}ms (attempt ${attempt}/${maxRetries})`);
        await sleep(wait);
      } else {
        throw err; // not retryable (4xx auth error, network down, etc.)
      }
    }
  }
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
    icon:            path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload:          path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
 
  // Set always-on-top at the highest level (screen-saver) so it floats over
  // other applications, not just other Electron windows.
  win.setAlwaysOnTop(true, 'screen-saver');
 
  win.loadFile(path.join(__dirname, 'src', 'html', 'ping-alert.html'));
 
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
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
 
  // DEVELOPER PANEL 
  //win.webContents.openDevTools();
 
  const url = require('url');
  win.loadURL(url.format({
    pathname: path.join(__dirname, 'src', 'index.html'),
    protocol: 'file:',
    slashes: true
  }));
  mainWindow = win;   // keep a reference so 'second-instance' can focus it
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
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
  // Re-fetch the token here — PI + implant resolution can take several minutes
  // and the original token (20-min lifetime) may have expired by now.
  try { Object.assign(authHdr, { Authorization: `Bearer ${await getValidToken(characterId)}` }); } catch (_) {}
  try {
    report('assets', 'Fetching assets (paginated)…');
    let allAssets = [];
    let page = 1;
    let totalPages = 1;
    while (true) {
      const { data, xPages } = await httpGetFullWithRetry(
        `${ESI_BASE}/v3/characters/${characterId}/assets/?page=${page}&datasource=tranquility`, authHdr
      );
      if (page === 1) {
        totalPages = xPages || 1;
        report('assets', `  ESI reports ${totalPages} page(s)`);
      }
      allAssets = allAssets.concat(data || []);
      report('assets', `  page ${page}/${totalPages}: ${allAssets.length} items so far…`);
      // Trust xPages exclusively — the last page legitimately has < 1000 items.
      if (page >= totalPages) break;
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
    // Run up to 10 in parallel; individual resolutions are capped at 5 s so one
    // dead structure can't stall the whole sync.
    const unresolved = await charInfoDb.getUnresolvedAssetLocations(characterId).catch(() => []);
    if (unresolved.length) {
      report('assets', `  Re-resolving ${unresolved.length} unresolved structure location(s)…`);
      const CONCURRENCY = 10;
      const LOCATION_TIMEOUT_MS = 5000;
      let fixed = 0;
      for (let i = 0; i < unresolved.length; i += CONCURRENCY) {
        const batch = unresolved.slice(i, i + CONCURRENCY);
        await Promise.allSettled(batch.map(async (locationId) => {
          // Skip structures already proven unresolvable — an immediate retry
          // yields the same fallback, so the displayed result is unchanged.
          if (getLocator().isKnownUnresolvable(locationId)) return;
          try {
            const raceResult = await Promise.race([
              getLocator().resolveLocation(locationId, characterId),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), LOCATION_TIMEOUT_MS)),
            ]);
            if (raceResult && (raceResult.name || raceResult.solar_system_id)) {
              await charInfoDb.updateAssetLocation(characterId, locationId, raceResult);
              fixed++;
            }
          } catch (e) {
            console.log(`[CharSync] Re-resolve failed for location ${locationId}: ${e.message}`);
          }
        }));
      }
      const stillUnresolved = await charInfoDb.getUnresolvedAssetLocations(characterId).catch(() => []);
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
    let totalBPPages = 1;
    while (true) {
      const { data, xPages } = await httpGetFullWithRetry(
        `${ESI_BASE}/v3/characters/${characterId}/blueprints/?page=${page}&datasource=tranquility`, authHdr
      );
      if (page === 1) totalBPPages = xPages || 1;
      allBPs = allBPs.concat(data || []);
      report('blueprints', `  page ${page}/${totalBPPages}: ${allBPs.length} blueprints so far…`);
      // Trust xPages — last page legitimately has < 1000 items.
      if (page >= totalBPPages) break;
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
// Called by the auto-refresh cadence. Assets are deliberately excluded so
// they can be governed by their own 6-hour staleness rule via
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
    let allBPs = [], page = 1, totalBPPages = 1;
    while (true) {
      const { data, xPages } = await httpGetFull(`${ESI_BASE}/v3/characters/${characterId}/blueprints/?page=${page}&datasource=tranquility`, authHdr);
      if (page === 1) totalBPPages = xPages || 1;
      allBPs = allBPs.concat(data);
      report('blueprints', `  page ${page}/${totalBPPages}: ${allBPs.length} blueprints…`);
      if (page >= totalBPPages || data.length < 1000) break;
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

  // 9. Market-fee profile — trade skills + NPC standings (for Ore/Ice/Gas calc)
  try {
    report('trade_profile', 'Fetching trade skills…');
    const ACCOUNTING_ID = 16622, BROKER_RELATIONS_ID = 3446;
    const skillsData = await httpGet(`${ESI_BASE}/v4/characters/${characterId}/skills/?datasource=tranquility`, authHdr);
    const skills = Array.isArray(skillsData?.skills) ? skillsData.skills : [];
    await charInfoDb.replaceSkills(characterId, skills);   // full list — used by jump planner etc.
    const lvl = (id) => (skills.find(s => s.skill_id === id)?.active_skill_level) || 0;
    const acct = lvl(ACCOUNTING_ID), broker = lvl(BROKER_RELATIONS_ID);
    await charInfoDb.replaceTradeProfile(characterId, { accounting: acct, brokerRelations: broker });
    summary.steps.trade_skills = `acct ${acct} / broker ${broker}`;
    report('trade_profile', `✓ Accounting ${acct}, Broker Relations ${broker}`);
  } catch (e) { summary.steps.trade_skills = `error: ${e.message}`; report('trade_profile', `✗ skills: ${e.message}`); }

  try {
    report('trade_profile', 'Fetching standings…');
    const standings = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/standings/?datasource=tranquility`, authHdr);
    if (Array.isArray(standings)) {
      await charInfoDb.replaceStandings(characterId, standings);
      summary.steps.standings = `${standings.length} entries`;
      report('trade_profile', `✓ ${standings.length} standings`);
    }
  } catch (e) {
    // Pre-re-auth tokens lack esi-characters.read_standings.v1 → 403; degrade gracefully.
    summary.steps.standings = `error: ${e.message}`;
    report('trade_profile', `✗ standings: ${e.message} (re-login to grant read_standings)`);
  }

  return summary;
}

// ─── SDE-first name resolution ────────────────────────────────────────────────
// Type IDs, solar systems, constellations and regions are immutable and already
// ship in the local SDE. Serving them from disk avoids an ESI round-trip for the
// bulk of name lookups. Returns a partial { id: name } map — only IDs found
// locally are included; everything else is left for the caller to fetch via ESI.
// Each ID space lives in its own table with non-overlapping ranges, so probing
// all four and merging is safe.
async function resolveNamesFromSde(ids) {
  if (!sdeDb) return {};
  const numIds = [...new Set(ids.map(Number).filter(Boolean))];
  if (!numIds.length) return {};

  const out = {};
  // Probe every static ID space. A query against a table this SDE build doesn't
  // have (e.g. invTypes vs invTypes_en) just throws and is skipped, so listing
  // both type-name variants is safe and captures whichever exists.
  const queries = [
    `SELECT typeID          AS id, typeName          AS name FROM invTypes          WHERE typeID          IN (__PH__)`,
    `SELECT typeID          AS id, typeName          AS name FROM invTypes_en       WHERE typeID          IN (__PH__)`,
    `SELECT solarSystemID   AS id, solarSystemName   AS name FROM mapSolarSystems   WHERE solarSystemID   IN (__PH__)`,
    `SELECT constellationID AS id, constellationName AS name FROM mapConstellations WHERE constellationID IN (__PH__)`,
    `SELECT regionID        AS id, regionName        AS name FROM mapRegions        WHERE regionID        IN (__PH__)`,
  ];

  // Chunk at 500 to stay well under SQLite's bound-parameter limit.
  for (let i = 0; i < numIds.length; i += 500) {
    const chunk = numIds.slice(i, i + 500);
    const ph    = chunk.map(() => '?').join(',');
    for (const q of queries) {
      try {
        const rows = await sdeDb.all(q.replace('__PH__', ph), chunk);
        rows.forEach(r => { if (r.id && r.name) out[r.id] = r.name; });
      } catch (_) { /* table absent in this SDE build — skip */ }
    }
  }
  return out;
}

async function resolveNames(ids) {
  const uncached = ids.filter(id => !nameCache[id]);
  if (uncached.length) {
    // 1. Static IDs (types/systems/constellations/regions) come from the SDE.
    const sdeNames = await resolveNamesFromSde(uncached).catch(() => ({}));
    for (const id of Object.keys(sdeNames)) nameCache[id] = sdeNames[id];

    // 2. Dynamic IDs (characters/corps/alliances/structures) the SDE can't
    //    supply may already be in the persistent cache from a prior session.
    let stillMissing = uncached.filter(id => !nameCache[id]);
    if (stillMissing.length) {
      const dbNames = await charInfoDb.getCachedNames(stillMissing).catch(() => ({}));
      for (const id of Object.keys(dbNames)) nameCache[id] = dbNames[id];
      stillMissing = stillMissing.filter(id => !nameCache[id]);
    }

    // 3. Whatever is still unknown is genuinely new — fetch from ESI, then
    //    persist so it survives the next restart.
    for (let i = 0; i < stillMissing.length; i += 1000) {
      const chunk = stillMissing.slice(i, i + 1000);
      try {
        const result = await httpPost(`${ESI_BASE}/v3/universe/names/?datasource=tranquility`, chunk);
        const fresh  = [];
        result.forEach(r => {
          nameCache[r.id] = r.name;
          fresh.push({ id: r.id, name: r.name, category: r.category || null });
        });
        if (fresh.length) charInfoDb.putCachedNames(fresh).catch(() => {});
      } catch { /* skip */ }
    }
  }
  return Object.fromEntries(ids.map(id => [id, nameCache[id] || `Type ${id}`]));
}
 
// ─── SDE update helpers ───────────────────────────────────────────────────────
// Fuzzwork now ships the SDE as a gzip'd sqlite db and no longer publishes a
// .md5 sidecar, so the up-to-date check uses the remote Last-Modified header as
// an opaque version token (stored in sde.md5 for path compatibility).
const SDE_DUMP_URL = 'https://www.fuzzwork.co.uk/dump/latest-sqlite.db.gz';

function getSdeMd5Path() {
  const devPath  = path.join(__dirname, 'data', 'sde.md5');
  const prodPath = path.join(process.resourcesPath || __dirname, 'data', 'sde.md5');
  return app.isPackaged ? prodPath : devPath;
}

async function fetchRemoteSdeMd5() {
  return new Promise((resolve, reject) => {
    https.request(SDE_DUMP_URL, {
      method: 'HEAD',
      headers: { 'User-Agent': 'EVE-Carbon/1.0' }
    }, (res) => {
      res.resume(); // drain
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      const token = res.headers['last-modified'] || res.headers['etag'] || null;
      if (!token) return reject(new Error('no version header'));
      resolve(token);
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

// sde-download-update — streams the gzip dump, decompresses, replaces sde.sql,
// saves the version token. Sends 'sde-update-progress' push events: { stage, percent }
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
      const zlib    = require('zlib');
      const tmpPath = sdePath + '.tmp';
      const writer  = fs.createWriteStream(tmpPath);

      https.request(SDE_DUMP_URL, {
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

        const gunzip = zlib.createGunzip();
        gunzip.on('error', (e) => { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } reject(e); });
        res.pipe(gunzip).pipe(writer);

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