// ── Load .env FIRST — before any IPC modules that read process.env at load time ──
const path   = require('path');
const { app } = require('electron');
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath, quiet: true }); // quiet: suppress dotenv's startup tip line

// ── Now safe to require everything else ────────────────────────────────────────
const { BrowserWindow, ipcMain, shell, screen, Tray, Menu, safeStorage, nativeImage } = require('electron');
const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const fs    = require('fs');

// Keep the embedded forum <webview> from spawning separate app windows: deny
// popups / target=_blank and route genuine external links to the OS browser, so
// browsing stays inside the main window.
app.on('web-contents-created', (_evt, contents) => {
  try {
    if (typeof contents.getType === 'function' && contents.getType() === 'webview') {
      contents.setWindowOpenHandler(({ url }) => {
        if (url && /^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
      });
    }
  } catch (_) {}
});

const { APP_USER_AGENT, ESI_COMPATIBILITY_DATE } = require('./src/app_ident');
const resfileBackgrounds      = require('./src/resfile_backgrounds');
const sdeFetch                = require('./src/sde_fetch');
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
const { registerForumHandlers }     = require('./src/ipc/forum_ipc');
const { initPresence, pokePresence, getPresenceCount } = require('./src/presence');

// Global reference to the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

// System-tray icon — only created while the "Minimize to tray" setting is on.
// minimizeToTrayEnabled mirrors config.app.minimizeToTray so the window's
// 'minimize' handler can decide synchronously whether to hide to the tray.
let tray = null;
let minimizeToTrayEnabled = false;

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
// v2 verify — the unversioned /oauth/verify is legacy; CCP's 2026 "spring
// cleaning" names /v2/oauth/verify as the drop-in replacement (same payload).
const SSO_VERIFY_URL = 'https://login.eveonline.com/v2/oauth/verify';
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
const SCOPES         = [
  'esi-characters.read_blueprints.v1',          // character blueprints + ME/PE/TE
  'esi-assets.read_assets.v1',                  // assets
  'esi-corporations.read_blueprints.v1',        // corp blueprints
  'esi-industry.read_character_jobs.v1',        // character industry jobs
  'esi-industry.read_corporation_jobs.v1',      // corp industry jobs (all corp jobs — but ESI also requires the in-game Factory Manager role, else 403)
  'esi-wallet.read_character_wallet.v1',        // wallet balance
  'esi-clones.read_clones.v1',                  // home location + jump clones + implants
  'esi-clones.read_implants.v1',                // implants 
  'esi-skills.read_skills.v1',                  // total skill points
  'esi-markets.read_character_orders.v1',       // active market orders (escrow)
  'esi-contracts.read_character_contracts.v1',  // contracts (escrow)
  'esi-location.read_location.v1',              // current solar system / station
  'esi-location.read_ship_type.v1',             // current ship type
  'esi-universe.read_structures.v1',            // resolve player-owned structure (Citadel/Keepstar) names where the char has docking access
  'esi-planets.manage_planets.v1',              // planetary interaction colonies
  'esi-characters.read_loyalty.v1',             // loyalty points per corporation
  'esi-characters.read_standings.v1',           // NPC faction/corp standings (broker-fee reduction in trade calc)
  'esi-alliances.read_contacts.v1',             // alliance-set standings (blue/red entities) for jump routing
  'esi-skills.read_skills.v1',                  // total skill points
  'esi-skills.read_skillqueue.v1',              // current skill queue (for estimating free time until next SP gain)
  'esi-fleets.read_fleet.v1',                    // for fleet role tags in Jabber messages (e.g. FC, squad commander, etc.)
  'esi-fleets.write_fleet.v1',                   // invite the user's own alts into the fleet (Fleet Composition tool)
  'esi-fittings.read_fittings.v1',               // import saved ship fits from the game (Fitting tool)
  'esi-fittings.write_fittings.v1',              // push fits from the Fitting tool back to the game
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
let userDataPath, dbPath, configPath, cacheDir, appDataDir, userPacksDir, userThemesDir, userBackgroundsDir, resfileCacheDir, etagCacheDir;
// Shared state for ping file watcher — passed into registerPingFileHandlers
// so the app-quit handler can still close it without knowing the internals.
const pingWatcherState = { watcher: null, timer: null };
 
function initPaths() {
  userDataPath = app.getPath('userData');
  dbPath       = path.join(userDataPath, 'blueprints.json');
  configPath   = path.join(userDataPath, 'config.json');
  cacheDir     = path.join(userDataPath, 'cache');
  // character_information.db lives in the project /data folder (beside sde.sql).
  // EVE_CARBON_DATA_DIR overrides this — used ONLY by the e2e suite (see
  // e2e/support/electron-app.js) so tests read/write a throwaway fixture DB
  // instead of the real dev data/ folder. Unset for every normal launch.
  appDataDir = process.env.EVE_CARBON_DATA_DIR || (app.isPackaged
    ? path.join(process.resourcesPath || __dirname, 'data')
    : path.join(__dirname, 'data'));
  userPacksDir  = path.join(userDataPath, 'packs');
  userThemesDir = path.join(userDataPath, 'themes');
  userBackgroundsDir = path.join(userDataPath, 'backgrounds');
  resfileCacheDir    = path.join(userDataPath, 'resfile-cache');
  etagCacheDir       = path.join(cacheDir, 'esi-etag');
  try { fs.mkdirSync(cacheDir,     { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(appDataDir,   { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(userPacksDir, { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(userThemesDir,{ recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(userBackgroundsDir, { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(resfileCacheDir,    { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(etagCacheDir,       { recursive: true }); } catch (e) { /* ignore */ }
}

// ─── App icon ─────────────────────────────────────────────────────────────────
// Resolve the .ico at runtime instead of hard-coding one path. Packaged builds
// ship assets/ beside the asar (extraResources in package.json — note that the
// buildResources dir "assets" is EXCLUDED from the asar by electron-builder, so
// an asar-relative assets path never exists when packaged). Dev reads the repo
// folder; build/icon.ico (packed inside the asar) is the last-resort copy so
// windows and the tray are never left iconless.
function appIconPath() {
  const candidates = [
    ...(app.isPackaged ? [path.join(process.resourcesPath || __dirname, 'assets', 'icon.ico')] : []),
    path.join(__dirname, 'assets', 'icon.ico'),
    path.join(__dirname, 'build', 'icon.ico'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  console.error('[icon] no app icon found — checked:', candidates.join(' | '));
  return null;
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
  // Resfile-sourced presets (see src/resfile_backgrounds.js) are fetched from
  // CCP's CDN and cached under userData/resfile-cache/ on first use instead of
  // being duplicated in the app bundle. Fetched lazily right here (not
  // prefetched at startup — that measurably slowed early app init, see
  // resfile_backgrounds.js) so this call can take a few seconds the very
  // first time Settings → Background is opened; every call after that is a
  // pure disk read. Never throws.
  let resfilePresets = [];
  try {
    resfilePresets = await resfileBackgrounds.listResfileBackgrounds({
      userAgent: APP_USER_AGENT,
      cacheDir:  resfileCacheDir,
    });
  } catch (e) { console.warn('[resfile] listResfileBackgrounds failed:', e.message); }

  const all = [
    ..._scanBackgroundDir(_bundledBackgroundsDir(), 'preset'),
    ...resfilePresets,
    ..._scanBackgroundDir(userBackgroundsDir, 'user'),
  ];
  // Dedupe by filename so a user copy shadows a preset of the same name.
  const seen = new Map();
  for (const b of all) seen.set(b.name.toLowerCase(), b);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
});

// ─── Reeded glass / acrylic IPC ──────────────────────────────────────────────
// glass-supported  → renderer asks whether the OS can do acrylic at all.
// glass-set-material → runtime toggle from Settings ('acrylic' | 'none').
ipcHandle('glass-supported', async () => acrylicSupported());

// System accent colour (Windows accent / macOS highlight) → '#rrggbb' or null.
// Lets the glass tint follow the OS colourway instead of a hand-picked colour.
ipcHandle('glass-get-accent', async () => {
  try {
    const { systemPreferences } = require('electron');
    const hex = systemPreferences.getAccentColor?.();   // 'rrggbbaa'
    return hex ? `#${hex.slice(0, 6)}` : null;
  } catch {
    return null;
  }
});

ipcHandle('glass-set-material', async (_e, material) => {
  if (!acrylicSupported()) return { success: false, error: 'Acrylic requires Windows 11 22H2+' };
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: 'No window' };
  try {
    const on = material === 'acrylic';
    mainWindow.setBackgroundMaterial(on ? 'acrylic' : 'none');
    mainWindow.setBackgroundColor(on ? '#00000000' : '#070b14');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
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
    // Every known character id. The locator falls back to OTHER characters'
    // tokens when the owning character can't read a structure's name — any
    // character with docking ACL (and the read_structures scope) can resolve
    // a structure another character merely owns assets in.
    getAllCharacterIds:     () => Object.keys(loadDB().accounts || {}),
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

// Jump-bridge network — encrypted store (see loadJumpBridges/saveJumpBridges).
ipcMain.handle('get-jump-bridges',  () => loadJumpBridges());
ipcMain.handle('save-jump-bridges', (_, arr) => {
  try { saveJumpBridges(arr); return { ok: true, count: Array.isArray(arr) ? arr.length : 0 }; }
  catch (e) { console.error('[jump-bridges] save failed:', e.message); return { ok: false, error: e.message }; }
});

// ── App preferences: "Start with Windows" + "Minimize to tray" (Settings ▸ General) ──
// launchAtLogin lives in the OS (a per-user Run registry entry on Windows), so
// app.getLoginItemSettings() is the source of truth. minimizeToTray is ours,
// persisted in config.json.
ipcMain.handle('get-app-preferences', () => {
  let minimizeToTray = false, presenceEnabled = true;
  try {
    const cfg = loadConfig();
    minimizeToTray  = !!(cfg.app && cfg.app.minimizeToTray);
    presenceEnabled = !(cfg.app && cfg.app.presenceEnabled === false);   // default on
  } catch (_) {}
  return { launchAtLogin: app.getLoginItemSettings().openAtLogin, minimizeToTray, presenceEnabled };
});

ipcMain.handle('set-launch-at-login', (_, enabled) => {
  const opts = { openAtLogin: !!enabled };
  // In a packaged build process.execPath is EVE-Carbon.exe, so the default
  // registration launches the real app. In development it's the bare
  // node_modules electron.exe; registering that WITHOUT the app path makes
  // Windows launch Electron's built-in "welcome" window at login instead of
  // our app. Point it back at this project so the dev login item still works.
  if (!app.isPackaged) {
    opts.path = process.execPath;
    opts.args = [path.resolve(process.argv[1] || __dirname)];
  }
  app.setLoginItemSettings(opts);
  // Read back from the OS so the UI reflects what actually took effect.
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('set-minimize-to-tray', (_, enabled) => {
  const cfg = loadConfig();
  cfg.app = cfg.app || {};
  cfg.app.minimizeToTray = !!enabled;
  saveConfig(cfg);
  applyMinimizeToTray(cfg.app.minimizeToTray);
  return cfg.app.minimizeToTray;
});

// ── Anonymous presence counter (status-bar "N online") — see src/presence.js ──
ipcMain.handle('set-presence-enabled', (_, enabled) => {
  const cfg = loadConfig();
  cfg.app = cfg.app || {};
  cfg.app.presenceEnabled = !!enabled;
  saveConfig(cfg);
  pokePresence();   // ping (or clear the counter) immediately, not in 5 minutes
  return cfg.app.presenceEnabled;
});
ipcMain.handle('presence-get-count', () => getPresenceCount());

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

// Alliance contacts — the standings the character's ALLIANCE has set toward other
// entities (characters/corps/alliances/factions). Used by the jump planner & map to
// classify blue (+5/+10) vs red (-5/-10). Requires esi-alliances.read_contacts.v1;
// a token predating that scope returns { ok:false, needsReauth:true }. Cached per
// alliance for 1 hour. Returns { ok, allianceId, standings:{ contactId: standing } }.
ipcMain.handle('get-alliance-contacts', async (_, characterId, allianceId) => {
  if (!characterId || !allianceId) return { ok: false, error: 'no alliance' };
  const cacheKey = `alliance_contacts_${allianceId}`;
  const cached = readCache(cacheKey);
  if (cached) return { ok: true, allianceId, standings: cached };
  try {
    const token   = await getValidToken(characterId);
    const authHdr = { Authorization: `Bearer ${token}` };
    const standings = {};
    let page = 1, totalPages = 1;
    while (true) {
      const { data, xPages } = await httpGetFull(
        `${ESI_BASE}/v2/alliances/${allianceId}/contacts/?datasource=tranquility&page=${page}`, authHdr
      );
      if (page === 1) totalPages = xPages || 1;
      if (Array.isArray(data)) for (const c of data) standings[c.contact_id] = c.standing;
      if (page >= totalPages) break;
      page++;
    }
    writeCache(cacheKey, standings, 1 / 24); // 1 hour
    return { ok: true, allianceId, standings };
  } catch (e) {
    const msg = e.message || '';
    if (/HTTP 403/.test(msg)) {
      return { ok: false, needsReauth: true, error: 'Re-authenticate this character to grant alliance-contacts access.' };
    }
    return { ok: false, error: msg };
  }
});

// EvE-Scout public wormhole map (Thera + Turnur connections). No auth needed.
// Returns [{ inId, inName, inClass, outId, outName, inSig, outSig, whType, maxShip,
// remainingHours }]. Cached ~10 min since holes spawn/die constantly.
ipcMain.handle('get-eve-scout-connections', async () => {
  const cacheKey = 'eve_scout_connections';
  const cached = readCache(cacheKey);
  if (cached) return cached;
  try {
    const data = await httpGet('https://api.eve-scout.com/v2/public/signatures');
    const conns = (Array.isArray(data) ? data : [])
      .filter(s => s && s.signature_type === 'wormhole' && s.in_system_id && s.out_system_id)
      .map(s => ({
        inId:  s.in_system_id,  inName:  s.in_system_name,  inClass: s.in_system_class || null,
        outId: s.out_system_id, outName: s.out_system_name,
        inSig: s.in_signature || null, outSig: s.out_signature || null,
        whType: s.wh_type || null, maxShip: s.max_ship_size || null,
        remainingHours: (s.remaining_hours != null) ? s.remaining_hours : null,
      }));
    writeCache(cacheKey, conns, 1 / 144); // ~10 minutes
    return conns;
  } catch (e) {
    console.warn('[eve-scout] fetch failed:', e.message);
    return [];
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

// Reprocessing outputs resolved BY NAME (for the Orehold Minerals calc, which
// parses a pasted ore-hold). Takes an array of item names (as copied from EVE)
// and returns, keyed by lower-cased input name, the canonical type plus its
// per-batch reprocessing materials from the local SDE:
//   { [lowerName]: { name, typeId, portionSize, volume,
//                    materials:[{ id, name, quantity }] } }
// Unresolved names are simply omitted so the renderer can flag them. Empty {}
// when the SDE isn't available. Handles ore, ice, and moon ore uniformly since
// invTypeMaterials carries the reprocessing yield for all of them.
ipcMain.handle('reprocess-from-names', async (_, names) => {
  const out = {};
  if (!sdeDb || !Array.isArray(names) || !names.length) return out;

  // De-dupe on the lower-cased name so repeated paste lines hit the DB once.
  const wanted = [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))];
  if (!wanted.length) return out;

  // invTypes vs invTypes_en differs between SDE builds — try the plain table
  // first, fall back to the localized one (mirrors resolveNamesFromSde).
  async function lookupTypes(lowerNames) {
    const ph = lowerNames.map(() => '?').join(',');
    for (const tbl of ['invTypes', 'invTypes_en']) {
      try {
        return await sdeDb.all(
          `SELECT typeID, typeName, volume, portionSize
             FROM ${tbl} WHERE LOWER(typeName) IN (${ph})`,
          lowerNames
        );
      } catch (_) { /* table absent in this build — try the next */ }
    }
    return [];
  }

  try {
    const lowerNames = wanted.map(n => n.toLowerCase());
    const types = await lookupTypes(lowerNames);
    if (!types.length) return out;

    const byTypeId = new Map();
    for (const t of types) {
      const entry = {
        name:        t.typeName,
        typeId:      t.typeID,
        volume:      t.volume,
        portionSize: t.portionSize || 100,
        materials:   [],
      };
      out[t.typeName.toLowerCase()] = entry;
      byTypeId.set(t.typeID, entry);
    }

    const typeIds = [...byTypeId.keys()];
    const ph = typeIds.map(() => '?').join(',');
    const mats = await sdeDb.all(
      `SELECT m.typeID AS oreId, m.materialTypeID AS matId, m.quantity AS qty, mt.typeName AS matName
         FROM invTypeMaterials m
         JOIN invTypes mt ON mt.typeID = m.materialTypeID
        WHERE m.typeID IN (${ph})`, typeIds
    );
    for (const m of mats) {
      const entry = byTypeId.get(m.oreId);
      if (entry) entry.materials.push({ id: m.matId, name: m.matName, quantity: m.qty });
    }
  } catch (e) {
    console.log('[reprocess-from-names] query failed:', e.message);
    return {};
  }
  return out;
});

// ─── Fleet Composition Tracker ────────────────────────────────────────────────
// Roles are assigned by SDE ship-group membership. Group IDs verified against the
// local SDE (the architecture doc's 83/1587 were wrong — Interceptor is 831,
// Logistics Frigate is 1527). Edit FC_ROLE_GROUPS to add/retag ship classes.
const FC_ROLE_GROUPS = {
  831:  'Tackle',           // Interceptor
  541:  'Tackle',           // Interdictor
  894:  'Tackle',           // Heavy Interdiction Cruiser
  832:  'Logistics',        // Logistics (Cruiser)
  1527: 'Logistics',        // Logistics Frigate
  540:  'Command Links',    // Command Ship (subcap boosts)
  1534: 'Command Links',    // Command Destroyer (subcap boosts)
  5120: 'Capital Command',  // Command Carrier (Salvation/Simurgh/Gaia/Ymir — capital boosts)
  4902: 'Capital Command',  // Expedition Command Ship (Odysseus)
  1538: 'Capital Support',  // Force Auxiliary (FAX)
};

// Returns a lookup table for EVERY published ship (SDE category 6), keyed by
// ship_type_id for O(1) classification during the polling loop:
//   { [typeId]: { name, group_id, group_name, tactical_role|null, tank } }
// • tactical_role comes from FC_ROLE_GROUPS (null for plain DPS/other hulls).
// • tank ('shield' | 'armor' | null) is derived from the hull's slot layout —
//   more mid than low slots = shield-tanked, more low than mid = armor-tanked.
//   Verified against known hulls (Armageddon→armor, Rokh→shield, Guardian→armor,
//   Basilisk→shield, Damnation→armor, Claymore→shield). This powers doctrine
//   mismatch ("false flag") detection in the renderer. Empty {} without the SDE.
ipcMain.handle('fc-get-ship-roles', async () => {
  const out = {};
  if (!sdeDb) return out;
  try {
    // attributeID 12 = low slots, 13 = mid slots.
    const rows = await sdeDb.all(
      `SELECT t.typeID, t.typeName, t.groupID, g.groupName,
              (SELECT COALESCE(da.valueInt, da.valueFloat) FROM dgmTypeAttributes da
                 WHERE da.typeID = t.typeID AND da.attributeID = 12) AS lowSlots,
              (SELECT COALESCE(da.valueInt, da.valueFloat) FROM dgmTypeAttributes da
                 WHERE da.typeID = t.typeID AND da.attributeID = 13) AS medSlots
         FROM invTypes t JOIN invGroups g ON g.groupID = t.groupID
        WHERE g.categoryID = 6 AND t.published = 1`
    );
    for (const r of rows) {
      const low = r.lowSlots || 0;
      const med = r.medSlots || 0;
      const tank = med > low ? 'shield' : (low > med ? 'armor' : null);
      out[r.typeID] = {
        name:          r.typeName,
        group_id:      r.groupID,
        group_name:    r.groupName,
        tactical_role: FC_ROLE_GROUPS[r.groupID] || null,
        tank,
      };
    }
  } catch (e) {
    console.warn('[fc] ship-roles query failed:', e.message);
  }
  return out;
});

// The fleet the character is currently in. ESI returns 404 when the character is
// not in a fleet — surfaced as { inFleet:false } rather than an error. A token
// predating esi-fleets.read_fleet.v1 returns 403 → { needsReauth:true }.
// Returns { inFleet, fleetId, role, wingId, squadId } on success.
ipcMain.handle('fc-get-character-fleet', async (_, characterId) => {
  if (!characterId) return { inFleet: false };
  try {
    const token = await getValidToken(characterId);
    const data  = await httpGet(
      `${ESI_BASE}/v1/characters/${characterId}/fleet/?datasource=tranquility`,
      { Authorization: `Bearer ${token}` }
    );
    return {
      inFleet: true,
      fleetId: data.fleet_id,
      role:    data.role,
      wingId:  data.wing_id,
      squadId: data.squad_id,
    };
  } catch (e) {
    const msg = e.message || '';
    if (/HTTP 404/.test(msg)) return { inFleet: false };
    if (/HTTP 403/.test(msg)) return { inFleet: false, needsReauth: true, error: 'Re-authenticate this character to grant fleet access.' };
    return { inFleet: false, error: msg };
  }
});

// Fleet roster. Requires the authenticated character to be the fleet boss
// (ESI restriction). Returns { ok, members:[{ characterId, shipTypeId, role,
// roleName, joinTime, solarSystemId, takesFleetWarp }] }.
ipcMain.handle('fc-get-fleet-members', async (_, characterId, fleetId) => {
  if (!characterId || !fleetId) return { ok: false, error: 'missing character or fleet id' };
  try {
    const token = await getValidToken(characterId);
    const data  = await httpGet(
      `${ESI_BASE}/v1/fleets/${fleetId}/members/?datasource=tranquility`,
      { Authorization: `Bearer ${token}` }
    );
    const members = (Array.isArray(data) ? data : []).map(m => ({
      characterId:    m.character_id,
      shipTypeId:     m.ship_type_id,
      role:           m.role,
      roleName:       m.role_name,
      joinTime:       m.join_time,
      solarSystemId:  m.solar_system_id,
      takesFleetWarp: m.takes_fleet_warp,
    }));
    return { ok: true, members };
  } catch (e) {
    const msg = e.message || '';
    // 404 = fleet closed/changed since we read the id; let the renderer reset.
    if (/HTTP 404/.test(msg)) return { ok: false, fleetGone: true };
    if (/HTTP 403/.test(msg)) return { ok: false, notBoss: true, error: 'Only the fleet boss can read the roster. Authenticate as the fleet boss.' };
    return { ok: false, error: msg };
  }
});

// Invite a batch of characters (the user's own alts) into the fleet. Requires the
// authenticated character to be the fleet boss and esi-fleets.write_fleet.v1.
// ESI sends a normal in-game invite each alt must ACCEPT — this never force-joins
// anyone, keeping it within sanctioned ESI use (not input automation / botting).
// Ensures a wing+squad exists, then invites each id as a squad_member, paced to
// stay well under ESI error limits. Returns { ok, results:[{ id, ok, error }] }.
ipcMain.handle('fc-invite-characters', async (_, bossId, fleetId, inviteIds) => {
  if (!bossId || !fleetId || !Array.isArray(inviteIds) || !inviteIds.length) {
    return { ok: false, error: 'missing boss, fleet, or invite list' };
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let token;
  try { token = await getValidToken(bossId); }
  catch (e) { return { ok: false, error: 'token: ' + e.message }; }

  const authHdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base    = `${ESI_BASE}/v1/fleets/${fleetId}`;

  const esiGet = async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  };
  const esiPost = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: authHdr, body: JSON.stringify(body) });
    if (r.status === 204 || r.ok) { try { return await r.json(); } catch { return {}; } }
    const t = await r.text().catch(() => '');
    const e = new Error(`HTTP ${r.status}${t ? ': ' + t : ''}`); e.status = r.status; throw e;
  };

  // Resolve (or create) a wing + squad to invite squad_members into.
  let wingId = null, squadId = null;
  try {
    const wings = await esiGet(`${base}/wings/?datasource=tranquility`);
    for (const w of (wings || [])) {
      if (w.squads && w.squads.length) { wingId = w.id; squadId = w.squads[0].id; break; }
      if (wingId == null) wingId = w.id;          // a wing with no squad — remember as fallback
    }
    if (wingId == null)  { const w = await esiPost(`${base}/wings/?datasource=tranquility`, {});               wingId  = w.wing_id; }
    if (squadId == null) { const s = await esiPost(`${base}/wings/${wingId}/squads/?datasource=tranquility`, {}); squadId = s.squad_id; }
  } catch (e) {
    if (e.status === 403) return { ok: false, needsReauth: true, error: 'Re-authenticate the fleet boss to grant fleet-write access.' };
    return { ok: false, error: 'fleet setup: ' + (e.message || 'failed') };
  }

  const results = [];
  for (const id of inviteIds) {
    if (String(id) === String(bossId)) continue;  // boss is already in the fleet
    try {
      await esiPost(`${base}/members/?datasource=tranquility`, {
        character_id: Number(id), role: 'squad_member', wing_id: wingId, squad_id: squadId,
      });
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
    await sleep(350);                              // gentle pacing
  }
  return { ok: true, results };
});

// ─── Fitting tool ─────────────────────────────────────────────────────────────
// Slot/hardpoint determined by dogma EFFECTS; CPU/PG/HP by ATTRIBUTES (all local
// SDE — exact). Effect ids: loPower 11, hiPower 12, medPower 13, rigSlot 2663,
// subSystem 3772, launcherFitted 40, turretFitted 42. Attr ids: cpu 50, power 30
// (module usage); cpuOutput 48, powerOutput 11 (hull output); shieldCapacity 263,
// armorHP 265, hp 9 (structure); rig/slot counts 12/13/14/1137.
const FIT_SLOT_EFFECT = { 12: 'high', 13: 'med', 11: 'low', 2663: 'rig', 3772: 'subsystem' };
// 'module' includes subsystems; 'charge' includes drones AND fighters (cat 87) —
// one browser tab covers everything that goes in a bay.
const FIT_CATS = { ship: [6], module: [7, 32], charge: [8, 18, 87], drone: [18], subsystem: [32], implant: [20] };

// Per-type fitting facts used by the renderer to place & cost a module.
async function _fitItemFacts(typeId) {
  if (!sdeDb) return null;
  const row = await sdeDb.get(
    `SELECT t.typeID, t.typeName, t.groupID, t.volume, g.groupName, g.categoryID
       FROM invTypes t JOIN invGroups g ON g.groupID = t.groupID WHERE t.typeID = ?`, [typeId]);
  if (!row) return null;
  const effs = await sdeDb.all(
    `SELECT te.effectID, e.effectName, e.effectCategory
       FROM dgmTypeEffects te JOIN dgmEffects e ON e.effectID = te.effectID
      WHERE te.typeID = ?`, [typeId]);
  const effIds = new Set(effs.map(e => e.effectID));
  let slot = null;
  for (const [eid, s] of Object.entries(FIT_SLOT_EFFECT)) if (effIds.has(Number(eid))) { slot = s; break; }
  const hardpoint = effIds.has(42) ? 'turret' : (effIds.has(40) ? 'launcher' : null);
  // Activatable = has an active/targeted/area effect (category 1/2/3) beyond the
  // universal 'online' effect every fittable module carries. (The old duration-
  // attribute test missed guns — their cycle comes from attr 51, not 73.)
  // Overloadable = activatable AND has an overload (category 5) effect — passive
  // modules (plates, membranes, rigs) can never be overheated.
  const activatableEff = effs.some(e => [1, 2, 3].includes(e.effectCategory) && e.effectName !== 'online');
  const overloadableEff = activatableEff && effs.some(e => e.effectCategory === 5);
  // All attribute IDs verified against this SDE (dgmAttributeTypes):
  //   50 cpu, 30 power(pg), 64 damageMultiplier, 51 speed(rateOfFire ms),
  //   114/118/117/116 em/therm/kin/exp damage, 73 duration (activatable),
  //   54 maxRange, 158 falloff, 160 trackingSpeed (weapons),
  //   604 chargeGroup1, 128 chargeSize (what a module can load — incl. scripts),
  //   37 maxVelocity, 281 explosionDelay(ms) (missiles → range ≈ vel × time),
  //   120 weaponRangeMultiplier, 517 fallofMultiplier (ammo range effects),
  //   351 maxRangeBonus, 349 falloffBonus, 767 trackingSpeedBonus (TC/TE/rigs, %),
  //   547 missileVelocityBonus, 596 explosionDelayBonus, 20 speedFactor (MGC/rigs, %),
  //   204 speedMultiplier (damage-mod RoF mult), 213 missileDamageMultiplierBonus (BCS),
  //   202 cpuMultiplier, 145 powerOutputMultiplier (Co-Proc / RCU / PDS),
  //   424 cpuOutputBonus2, 313 powerEngineeringOutputBonus (fitting rigs, %),
  //   1210 overloadDamageModifier, 1205 overloadRofBonus,
  //   1935 overloadTrackingModuleStrengthBonus, 1211 heatDamage, 6 capacitorNeed.
  const attrRows = await sdeDb.all(
    `SELECT attributeID, COALESCE(valueInt, valueFloat) AS v FROM dgmTypeAttributes
      WHERE typeID = ? AND attributeID IN (50,30,64,51,114,118,117,116,73,
        54,158,160,604,128,37,281,120,517,351,349,767,547,596,20,204,213,
        202,145,424,313,1210,1205,1935,1211,6,605,606,609,1153)`, [typeId]);
  const a = {}; attrRows.forEach(r => { a[r.attributeID] = r.v; });
  // Full raw attribute map — the renderer's ship-stats engine reads shield/armor/
  // resist/velocity/cap/sensor modifiers from here so fitted modules affect the
  // stats panel live (attr IDs verified against this SDE, see fitting.js).
  const allAttrRows = await sdeDb.all(
    `SELECT attributeID, COALESCE(valueInt, valueFloat) AS v FROM dgmTypeAttributes WHERE typeID = ?`, [typeId]);
  const attrs = {}; allAttrRows.forEach(r => { attrs[r.attributeID] = r.v; });
  // Subsystems carry the T3 hull's trait bonuses (invTraits rows keyed by the
  // subsystem skill); implants need their effect names so the renderer can scope
  // their bonuses (e.g. "…RequiringGunnery" → turrets only).
  let traits = null;
  if (row.categoryID === 32) {
    traits = await sdeDb.all(
      `SELECT skillID, bonus, unitID, bonusText FROM invTraits WHERE typeID = ?`, [typeId]).catch(() => []);
  }
  return {
    id: row.typeID, name: row.typeName, groupName: row.groupName,
    groupId: row.groupID, categoryId: row.categoryID, attrs,
    effects: effs.map(e => e.effectName),
    traits,
    volume: row.volume || 0,   // m³ (drone-bay accounting)
    slot, hardpoint, cpu: a[50] || 0, pg: a[30] || 0,
    dmgMult: a[64] || 0, rof: a[51] || 0,
    dmg: { em: a[114] || 0, th: a[118] || 0, kin: a[117] || 0, exp: a[116] || 0 },
    activatable: activatableEff,
    overloadable: overloadableEff,
    // Weapon geometry (guns)
    optimal: a[54] || 0, falloff: a[158] || 0, tracking: a[160] || 0,
    chargeGroup: a[604] || null, chargeSize: a[128] || null,
    chargeGroups: [a[604], a[605], a[606], a[609]].filter(Boolean),   // all accepted charge groups
    calCost: a[1153] || 0,                                            // rig calibration cost
    // Missile geometry (on the charge)
    missileVel: a[37] || 0, flightMs: a[281] || 0,
    // Ammo range multipliers (on the charge)
    rangeMult: a[120] != null ? a[120] : null, falloffMult: a[517] != null ? a[517] : null,
    // % bonuses carried by TC / TE / MGC / MGE / weapon rigs
    bonus: {
      optimal: a[351] || 0, falloff: a[349] || 0, tracking: a[767] || 0,
      mslVel: a[547] || 0, mslFlight: a[596] || 0, mslVelRig: a[20] || 0,
    },
    // Damage-mod multipliers (Gyro/Heat Sink/Mag Stab: 64+204; BCS: 213+204)
    dmgMultMod: a[64] && slot === 'low' ? a[64] : null,
    mslDmgMult: a[213] || null, rofMult: a[204] || null,
    // Fitting resource modifiers (Co-Proc / RCU / PDS / fitting rigs)
    cpuMult: a[202] || null, pgMult: a[145] || null,
    cpuOutBonus: a[424] || 0, pgOutBonus: a[313] || 0,
    // Heat
    heat: {
      dmgMod: a[1210] || 0, rofBonus: a[1205] || 0,
      trackModBonus: a[1935] || 0, selfDamage: a[1211] || 0,
    },
    capNeed: a[6] || 0,
  };
}

// Search the SDE by name within a fitting "kind" (ship/module/charge/drone).
ipcMain.handle('fit-search', async (_, query, kind, limit = 60) => {
  if (!sdeDb || !query || String(query).trim().length < 2) return [];
  const cats = FIT_CATS[kind] || FIT_CATS.module;
  const ph = cats.map(() => '?').join(',');
  try {
    const rows = await sdeDb.all(
      `SELECT t.typeID, t.typeName, t.groupID, g.groupName
         FROM invTypes t JOIN invGroups g ON g.groupID = t.groupID
        WHERE t.published = 1 AND g.categoryID IN (${ph}) AND LOWER(t.typeName) LIKE ?
        ORDER BY (LOWER(t.typeName) = ?) DESC, length(t.typeName), t.typeName
        LIMIT ?`,
      [...cats, `%${String(query).toLowerCase()}%`, String(query).toLowerCase(), limit]
    );
    return rows.map(r => ({ id: r.typeID, name: r.typeName, groupName: r.groupName }));
  } catch (e) { console.warn('[fit-search]', e.message); return []; }
});

// Full hull layout + base stats for the fitting canvas. Everything here is the
// hull's intrinsic (pre-skill, pre-module) value from the SDE — exact. Resists
// are returned as resonances (resist% = (1 - resonance) × 100, computed renderer-
// side); EHP/align/cap-regen are derived there too.
ipcMain.handle('fit-get-hull', async (_, typeId) => {
  if (!sdeDb || !typeId) return null;
  try {
    const row = await sdeDb.get(
      `SELECT t.typeID, t.typeName, t.mass, t.capacity, g.groupName, g.categoryID
         FROM invTypes t JOIN invGroups g ON g.groupID = t.groupID WHERE t.typeID = ?`, [typeId]);
    if (!row || row.categoryID !== 6) return null;
    const attrRows = await sdeDb.all(
      `SELECT attributeID, COALESCE(valueInt, valueFloat) AS v FROM dgmTypeAttributes
        WHERE typeID = ? AND attributeID IN (
          14,13,12,1137,1367,102,101,48,11,263,265,9,482,55,479,
          271,274,273,272,267,270,269,268,113,110,109,111,
          76,564,192,208,209,210,211,37,70,600,552,1132,283,1271,2055,2216,2217,2218,2219)`, [typeId]);
    const a = {}; attrRows.forEach(r => { a[r.attributeID] = r.v; });

    // Sensor strength = the single non-zero sensor type (ships have exactly one).
    const sensors = { Radar: a[208] || 0, Ladar: a[209] || 0, Magnetometric: a[210] || 0, Gravimetric: a[211] || 0 };
    let sensorType = 'Gravimetric', sensorStrength = 0;
    for (const [k, v] of Object.entries(sensors)) if (v > sensorStrength) { sensorStrength = v; sensorType = k; }

    // T3 hulls: the SDE's maxSubSystems (1367) can be stale — the truth is the
    // number of DISTINCT subsystem slots (attr 1366) among the subsystems built
    // for this hull (attr 1380 fitsToShipType).
    let subCount = a[1367] || 0;
    if (subCount > 0) {
      const sub = await sdeDb.get(
        `SELECT COUNT(DISTINCT COALESCE(s.valueInt, s.valueFloat)) c
           FROM dgmTypeAttributes f
           JOIN dgmTypeAttributes s ON s.typeID = f.typeID AND s.attributeID = 1366
           JOIN invTypes t ON t.typeID = f.typeID AND t.published = 1
          WHERE f.attributeID = 1380 AND COALESCE(f.valueInt, f.valueFloat) = ?`, [typeId]);
      if (sub && sub.c > 0) subCount = sub.c;
    }

    return {
      id: row.typeID, name: row.typeName, groupName: row.groupName,
      slots: { high: a[14] || 0, med: a[13] || 0, low: a[12] || 0, rig: a[1137] || 0, subsystem: subCount },
      hardpoints: { turret: a[102] || 0, launcher: a[101] || 0 },
      output: { cpu: a[48] || 0, pg: a[11] || 0, calibration: a[1132] || 0 },
      cargo: row.capacity || 0,                                        // cargo hold m³
      drone: { bay: a[283] || 0, bandwidth: a[1271] || 0 },            // drone bay m³ / Mbit
      // Fighter bay m³ / launch tubes / squadron-slot limits by fighter type.
      fighter: { bay: a[2055] || 0, tubes: a[2216] || 0, light: a[2217] || 0, support: a[2218] || 0, heavy: a[2219] || 0 },
      base: {
        shieldHp: a[263] || 0, armorHp: a[265] || 0, structureHp: a[9] || 0,
        capacitor: a[482] || 0, rechargeMs: a[55] || 0,
        shieldRechargeMs: a[479] || 0,                                 // passive shield regen

        // resonances (lower = more resist). Order em, therm, kin, exp.
        shieldRes: { em: a[271], th: a[274], kin: a[273], exp: a[272] },
        armorRes:  { em: a[267], th: a[270], kin: a[269], exp: a[268] },
        hullRes:   { em: a[113], th: a[110], kin: a[109], exp: a[111] },
      },
      targeting: { lockRange: a[76] || 0, scanRes: a[564] || 0, maxTargets: a[192] || 0, sensorType, sensorStrength },
      nav: { maxVel: a[37] || 0, mass: row.mass || 0, agility: a[70] || 0, warpMult: a[600] || 0, sig: a[552] || 0 },
      // Hull trait bonuses (invTraits): skillID -1 = role bonus (flat), otherwise
      // %-per-level of that skill. bonusText's showinfo links carry the skill ids
      // the affected weapons/charges/drones/modules must require — the renderer's
      // trait engine matches on those.
      traits: await sdeDb.all(
        `SELECT skillID, bonus, unitID, bonusText FROM invTraits WHERE typeID = ?`, [typeId]).catch(() => []),
    };
  } catch (e) { console.warn('[fit-get-hull]', e.message); return null; }
});

// Batch fitting facts for a set of type ids (rendering fitted modules / EFT import).
ipcMain.handle('fit-get-items', async (_, typeIds) => {
  const out = {};
  if (!sdeDb || !Array.isArray(typeIds)) return out;
  for (const id of [...new Set(typeIds)]) {
    const f = await _fitItemFacts(id).catch(() => null);
    if (f) out[id] = f;
  }
  return out;
});

// ─── Fitting browser trees ────────────────────────────────────────────────────
// EVE-style grouped browsing, built from the SDE and cached per kind:
//   ship   → ship class (invGroups) → race (chrRaces) → hulls
//   module → the market-group tree under Ship Equipment (9) + Rigs/Subsystems (955)
//   charge → Ammunition & Charges (11) + Drones (157) in one tab
// Each type row carries slot / hardpoint / cpu / pg / required skills so the
// renderer can run the EVE-style filter row without extra IPC round-trips.
const _fitTreeCache = new Map();

async function _fitBuildTree(kind) {
  if (_fitTreeCache.has(kind)) return _fitTreeCache.get(kind);
  if (!sdeDb) return null;

  if (kind === 'ship') {
    const races = {};
    (await sdeDb.all(`SELECT raceID, raceName FROM chrRaces`)).forEach(r => { races[r.raceID] = r.raceName; });
    // Pirate hulls (Cynabal, Orthrus, Ashimmu…) carry an EMPIRE raceID in the SDE
    // (Angel = Minmatar, etc.) — the reliable signal is their market-group ancestry,
    // which ends in a "Pirate Faction" node. Build the set once.
    const mgAll = await sdeDb.all(`SELECT marketGroupID id, parentGroupID p, marketGroupName n FROM invMarketGroups`);
    const mgParent = new Map(mgAll.map(m => [m.id, m.p]));
    const mgName   = new Map(mgAll.map(m => [m.id, m.n]));
    const isPirateMg = (mgId) => {
      for (let cur = mgId, hops = 0; cur != null && hops < 12; cur = mgParent.get(cur), hops++) {
        if ((mgName.get(cur) || '').startsWith('Pirate Faction')) return true;
      }
      return false;
    };
    const rows = await sdeDb.all(
      `SELECT t.typeID id, t.typeName n, t.raceID race, t.marketGroupID mg, g.groupName cls
         FROM invTypes t JOIN invGroups g ON g.groupID = t.groupID
        WHERE g.categoryID = 6 AND t.published = 1
        ORDER BY g.groupName, t.typeName`);
    const byClass = new Map();
    for (const r of rows) {
      if (!byClass.has(r.cls)) byClass.set(r.cls, new Map());
      const raceName = isPirateMg(r.mg) ? 'Pirate' : (races[r.race] || 'Other');
      const byRace = byClass.get(r.cls);
      if (!byRace.has(raceName)) byRace.set(raceName, []);
      byRace.get(raceName).push({ id: r.id, name: r.n });
    }
    const sections = [...byClass.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([cls, byRace]) => ({
      name: cls,
      count: [...byRace.values()].reduce((s, t) => s + t.length, 0),
      kids: [...byRace.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([race, types]) => ({
        name: race, count: types.length, kids: [], types,
      })),
      types: [],
    }));
    const tree = { sections };
    _fitTreeCache.set(kind, tree);
    return tree;
  }

  // Market-group kinds — bulk-load everything once, then assemble the subtree.
  const mgRows = await sdeDb.all(`SELECT marketGroupID id, parentGroupID p, marketGroupName n FROM invMarketGroups`);
  const mgById = new Map(mgRows.map(m => [m.id, m]));
  const mgKids = new Map();
  for (const m of mgRows) {
    if (m.p == null) continue;
    if (!mgKids.has(m.p)) mgKids.set(m.p, []);
    mgKids.get(m.p).push(m.id);
  }
  const typeRows = await sdeDb.all(
    `SELECT typeID id, typeName n, marketGroupID mg FROM invTypes WHERE published = 1 AND marketGroupID IS NOT NULL`);
  const typesByMg = new Map();
  for (const t of typeRows) {
    if (!typesByMg.has(t.mg)) typesByMg.set(t.mg, []);
    typesByMg.get(t.mg).push(t);
  }
  // Slot / hardpoint / cpu / pg / required skills for the filter row.
  const effByType = new Map();
  for (const e of await sdeDb.all(`SELECT typeID t, effectID e FROM dgmTypeEffects WHERE effectID IN (11,12,13,2663,3772,40,42)`)) {
    if (!effByType.has(e.t)) effByType.set(e.t, []);
    effByType.get(e.t).push(e.e);
  }
  const attrByType = new Map();
  for (const a of await sdeDb.all(`SELECT typeID t, attributeID a, COALESCE(valueInt, valueFloat) v FROM dgmTypeAttributes WHERE attributeID IN (50,30,182,277,183,278,184,279)`)) {
    if (!attrByType.has(a.t)) attrByType.set(a.t, {});
    attrByType.get(a.t)[a.a] = a.v;
  }
  const decorate = (t) => {
    const effs = effByType.get(t.id) || [];
    let slot = null;
    for (const [eid, s] of Object.entries(FIT_SLOT_EFFECT)) if (effs.includes(Number(eid))) { slot = s; break; }
    const hp = effs.includes(42) ? 'turret' : (effs.includes(40) ? 'launcher' : null);
    const a = attrByType.get(t.id) || {};
    const sk = [];
    if (a[182] && a[277]) sk.push([a[182], a[277]]);
    if (a[183] && a[278]) sk.push([a[183], a[278]]);
    if (a[184] && a[279]) sk.push([a[184], a[279]]);
    return { id: t.id, name: t.n, slot, hp, cpu: a[50] || 0, pg: a[30] || 0, sk };
  };
  const buildNode = (mgId) => {
    const mg = mgById.get(mgId);
    if (!mg) return null;
    const kids = (mgKids.get(mgId) || []).map(buildNode).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    const types = (typesByMg.get(mgId) || []).map(decorate)
      .sort((a, b) => a.name.localeCompare(b.name));
    const count = types.length + kids.reduce((s, k) => s + k.count, 0);
    if (!count) return null;
    return { name: mg.n, count, kids, types };
  };
  const findChildByName = (parentId, name) =>
    (mgKids.get(parentId) || []).find(id => mgById.get(id)?.n === name);

  let sections = [];
  if (kind === 'module') {
    sections = (mgKids.get(9) || []).map(buildNode).filter(Boolean);
    for (const name of ['Rigs', 'Subsystems']) {
      const id = findChildByName(955, name);
      const node = id ? buildNode(id) : null;
      if (node) sections.push(node);
    }
  } else if (kind === 'charge') {
    sections = (mgKids.get(11) || []).map(buildNode).filter(Boolean);
    const drones = buildNode(157);
    if (drones) sections.push(drones);
  }
  sections.sort((a, b) => a.name.localeCompare(b.name));
  const tree = { sections };
  _fitTreeCache.set(kind, tree);
  return tree;
}

ipcMain.handle('fit-browse-tree', async (_, kind) => {
  try { return await _fitBuildTree(kind); }
  catch (e) { console.warn('[fit-browse-tree]', e.message); return null; }
});

// ─── Compatible ammo for a module ─────────────────────────────────────────────
// Charges (category 8) in the module's chargeGroup1-4, matching chargeSize when
// both sides declare one. Each row carries its meta group (Tech I / Tech II /
// Storyline / Faction / Officer / Deadspace) so the renderer can build the
// grouped right-click "load ammo" menu. Cached per module type.
const _fitAmmoCache = new Map();
ipcMain.handle('fit-ammo-for', async (_, typeId) => {
  if (!sdeDb || !typeId) return [];
  if (_fitAmmoCache.has(typeId)) return _fitAmmoCache.get(typeId);
  try {
    const rows = await sdeDb.all(
      `SELECT attributeID, COALESCE(valueInt, valueFloat) AS v FROM dgmTypeAttributes
        WHERE typeID = ? AND attributeID IN (604,605,606,609,128)`, [typeId]);
    const a = {}; rows.forEach(r => { a[r.attributeID] = r.v; });
    const groups = [a[604], a[605], a[606], a[609]].filter(Boolean);
    if (!groups.length) { _fitAmmoCache.set(typeId, []); return []; }
    const size = a[128] || null;
    const ph = groups.map(() => '?').join(',');
    const ammo = await sdeDb.all(
      `SELECT t.typeID id, t.typeName name, mt.metaGroupID meta,
              (SELECT COALESCE(cs.valueInt, cs.valueFloat) FROM dgmTypeAttributes cs
                WHERE cs.typeID = t.typeID AND cs.attributeID = 128) AS csize
         FROM invTypes t
         JOIN invGroups g ON g.groupID = t.groupID
         LEFT JOIN invMetaTypes mt ON mt.typeID = t.typeID
        WHERE t.groupID IN (${ph}) AND t.published = 1 AND g.categoryID = 8
        ORDER BY t.typeName`, groups);
    const out = ammo
      .filter(r => size == null || r.csize == null || r.csize === size)
      .map(r => ({ id: r.id, name: r.name, meta: r.meta || 1 }));
    _fitAmmoCache.set(typeId, out);
    return out;
  } catch (e) { console.warn('[fit-ammo-for]', e.message); return []; }
});

// Resolve fit lines (ship + module names from an EFT paste) to type facts.
// Returns { byName: { lowerName: facts } } so the renderer can rebuild a fit.
ipcMain.handle('fit-lookup-names', async (_, names) => {
  const byName = {};
  if (!sdeDb || !Array.isArray(names)) return { byName };
  const wanted = [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))];
  for (const name of wanted) {
    try {
      const row = await sdeDb.get(
        `SELECT t.typeID FROM invTypes t JOIN invGroups g ON g.groupID = t.groupID
          WHERE LOWER(t.typeName) = ? AND g.categoryID IN (6,7,8,18,32) LIMIT 1`, [name.toLowerCase()]);
      if (row) { const f = await _fitItemFacts(row.typeID); if (f) byName[name.toLowerCase()] = f; }
    } catch (_) { /* skip unresolved */ }
  }
  return { byName };
});

// Import the character's saved fits from the game (ESI). Requires
// esi-fittings.read_fittings.v1. Returns { ok, fittings:[{ fittingId, name,
// description, shipTypeId, items:[{ typeId, flag, quantity }] }] }.
ipcMain.handle('fit-get-fittings', async (_, characterId) => {
  if (!characterId) return { ok: false, error: 'no character' };
  let token;
  try { token = await getValidToken(characterId); }
  catch (e) { return { ok: false, error: 'token: ' + e.message }; }
  const hdr = { Authorization: `Bearer ${token}` };
  // The fittings route version has changed over time — try v2 then v1 so a 404
  // on the wrong version doesn't look like a failure.
  for (const ver of ['v2', 'v1']) {
    try {
      const res = await fetch(`${ESI_BASE}/${ver}/characters/${characterId}/fittings/?datasource=tranquility`, { headers: hdr });
      if (res.status === 404) continue;                 // wrong version — try the other
      if (res.status === 403) return { ok: false, needsReauth: true, error: 'Re-authenticate this character to grant fittings access (esi-fittings.read_fittings.v1).' };
      if (!res.ok) { const t = await res.text().catch(() => ''); return { ok: false, error: `ESI ${res.status}${t ? ': ' + t : ''}` }; }
      const data = await res.json();
      const fittings = (Array.isArray(data) ? data : []).map(f => ({
        fittingId: f.fitting_id, name: f.name, description: f.description, shipTypeId: f.ship_type_id,
        items: (f.items || []).map(i => ({ typeId: i.type_id, flag: i.flag, quantity: i.quantity })),
      }));
      return { ok: true, fittings };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: 'Fittings endpoint returned 404 on both v1 and v2.' };
});

// Save a fit to the game (ESI). Requires esi-fittings.write_fittings.v1.
// fitting = { name, description, shipTypeId, items:[{ typeId, flag, quantity }] }.
ipcMain.handle('fit-save-fitting', async (_, characterId, fitting) => {
  if (!characterId || !fitting) return { ok: false, error: 'missing character or fit' };
  try {
    const token = await getValidToken(characterId);
    const body = {
      name: fitting.name || 'EVE Carbon Fit', description: fitting.description || '',
      ship_type_id: fitting.shipTypeId,
      items: (fitting.items || []).map(i => ({ type_id: i.typeId, flag: i.flag, quantity: i.quantity })),
    };
    const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (const ver of ['v2', 'v1']) {
      const res = await fetch(`${ESI_BASE}/${ver}/characters/${characterId}/fittings/?datasource=tranquility`, {
        method: 'POST', headers: hdr, body: JSON.stringify(body),
      });
      if (res.status === 404) continue;                 // wrong version — try the other
      if (res.status === 403) return { ok: false, needsReauth: true, error: 'Re-authenticate this character to grant fittings write access (esi-fittings.write_fittings.v1).' };
      if (!res.ok) { const t = await res.text().catch(() => ''); return { ok: false, error: `ESI ${res.status}${t ? ': ' + t : ''}` }; }
      const j = await res.json().catch(() => ({}));
      return { ok: true, fittingId: j.fitting_id };
    }
    return { ok: false, error: 'Fittings endpoint returned 404 on both v1 and v2.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;   // second instance is quitting — don't init/open
  initPaths();

  // Anonymous "N online" heartbeat — off unless PRESENCE_URL is configured
  // (see infra/presence-worker) and the user hasn't opted out in Settings.
  initPresence({
    url: process.env.PRESENCE_URL || '',
    isEnabled: () => {
      try { const cfg = loadConfig(); return !(cfg.app && cfg.app.presenceEnabled === false); }
      catch (_) { return true; }
    },
    broadcast: (channel, payload) => {
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      });
    },
  });

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
    httpGetFull,
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
    httpPost,
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
  registerForumHandlers({ ipcHandle });
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

  // Restore the saved "Minimize to tray" preference now that the window exists.
  try {
    const cfg = loadConfig();
    applyMinimizeToTray(!!(cfg.app && cfg.app.minimizeToTray));
  } catch (_) { /* config not readable yet — defaults to off */ }
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

// ─── Jump-bridge network store (encrypted at rest) ─────────────────────────────
// The user's Ansiblex / jump-gate network can be sensitive alliance intel, so it
// is NOT kept in renderer localStorage. It lives in a file under userData,
// encrypted with the OS keychain via Electron safeStorage when available (falls
// back to plaintext only on platforms without an OS secret store, e.g. some Linux
// setups). Shape on disk: { enc:bool, data:base64 }. Decrypted value is [[idA,idB],…].
function jumpBridgesPath() { return path.join(userDataPath, 'jump_network.dat'); }

function loadJumpBridges() {
  try {
    const wrap = JSON.parse(fs.readFileSync(jumpBridgesPath(), 'utf8'));
    const buf  = Buffer.from(wrap.data, 'base64');
    const json = (wrap.enc && safeStorage.isEncryptionAvailable())
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8');
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function saveJumpBridges(arr) {
  const json = JSON.stringify(Array.isArray(arr) ? arr : []);
  let wrap;
  if (safeStorage.isEncryptionAvailable()) {
    wrap = { enc: true,  data: safeStorage.encryptString(json).toString('base64') };
  } else {
    wrap = { enc: false, data: Buffer.from(json, 'utf8').toString('base64') };
  }
  fs.writeFileSync(jumpBridgesPath(), JSON.stringify(wrap), 'utf8');
}
 
// ─── HTTP helpers ─────────────────────────────────────────────────────────────
// ESI compliance gate (best practices + rate-limiting docs):
//   • 420 anywhere = the legacy 100-errors/min limit tripped — ALL ESI requests
//     are discarded until X-Esi-Error-Limit-Reset. We hard-pause instead of
//     burning 5-token 4XXs into the bucket limiter.
//   • When the error budget runs low (Remain ≤ 10) we pause proactively.
//   • When a bucket (X-Ratelimit-Remaining) runs dry we back off briefly.
let _esiBlockUntil = 0;   // ms epoch — no ESI requests before this

// Pin ESI requests to a known-good compatibility date (see app_ident.js) —
// scoped to esi.evetech.net only, same as the gate above, so it never leaks
// onto unrelated hosts (resfile CDN, SSO, etc.) that don't understand it.
function _esiCompatHeader(url) {
  return /esi\.evetech\.net/i.test(String(url)) ? { 'X-Compatibility-Date': ESI_COMPATIBILITY_DATE } : {};
}

function _esiGateWait(url) {
  if (!/esi\.evetech\.net/i.test(String(url))) return Promise.resolve();
  const wait = _esiBlockUntil - Date.now();
  if (wait <= 0) return Promise.resolve();
  return new Promise(r => setTimeout(r, Math.min(wait, 65000)));
}

// Shared by both response shapes below: Node's http.IncomingMessage
// (res.headers['x-foo'], res.statusCode) and the Fetch API's Response
// (res.headers.get('x-foo'), res.status) — getHeader()/statusCode abstract
// over that so the actual gating logic is written once.
function _esiNoteResponseCore(url, statusCode, getHeader) {
  if (!/esi\.evetech\.net/i.test(String(url))) return;
  const remain = parseInt(getHeader('x-esi-error-limit-remain') ?? '', 10);
  const reset  = parseInt(getHeader('x-esi-error-limit-reset')  ?? '', 10);
  if (statusCode === 420) {
    const pause = (isFinite(reset) ? reset : 60) + 1;
    _esiBlockUntil = Math.max(_esiBlockUntil, Date.now() + pause * 1000);
    console.warn(`[ESI] 420 — error-limited; pausing ALL ESI for ${pause}s`);
    return;
  }
  if (isFinite(remain) && isFinite(reset) && remain <= 10 && statusCode >= 400) {
    _esiBlockUntil = Math.max(_esiBlockUntil, Date.now() + (reset + 1) * 1000);
    console.warn(`[ESI] error budget low (${remain} left) — pausing ESI ${reset}s`);
  }
  const rlRemain = parseInt(getHeader('x-ratelimit-remaining') ?? '', 10);
  if (isFinite(rlRemain) && rlRemain <= 2) {
    _esiBlockUntil = Math.max(_esiBlockUntil, Date.now() + 10000);
    console.warn(`[ESI] bucket nearly empty (${getHeader('x-ratelimit-group') || 'route'}) — 10s cooloff`);
  }
}
function _esiNoteResponse(url, res) {   // Node http.IncomingMessage (httpGet/httpGetFull)
  _esiNoteResponseCore(url, res.statusCode, (h) => res.headers[h]);
}
function _esiNoteFetchResponse(url, res) {   // Fetch API Response (global fetch wrapper below)
  _esiNoteResponseCore(url, res.status, (h) => res.headers.get(h));
}

// ─── ESI conditional-request (ETag) cache ────────────────────────────────────
// Best practices: re-fetching before `expires` "wastes resources on both
// sides" and in the worst case "may count as circumventing the ESI caching…
// [which] can get you banned." 3XX (304 Not Modified) responses also cost
// only 1 token vs 2 for a full 2XX, so this is the cheap path CCP explicitly
// wants used. Stores the raw response body alongside its ETag, keyed by a
// hash of the full URL; sends It back as If-None-Match next time, and on a
// 304 returns the previously-stored body instead of re-parsing an empty one.
function _etagCachePathFor(url) {
  const hash = crypto.createHash('sha1').update(String(url)).digest('hex');
  return path.join(etagCacheDir || cacheDir || '.', `${hash}.json`);
}
function _readEtagEntry(url) {
  try { return JSON.parse(fs.readFileSync(_etagCachePathFor(url), 'utf8')); }
  catch { return null; }
}
function _writeEtagEntry(url, entry) {
  try {
    fs.mkdirSync(etagCacheDir || cacheDir, { recursive: true });
    fs.writeFileSync(_etagCachePathFor(url), JSON.stringify(entry), 'utf8');
  } catch (_) { /* best-effort — worst case we just miss the 304 discount */ }
}

// ─── Global fetch() wrapper (main process) ───────────────────────────────────
// Several call sites (fittings, ESI open-window, character_ipc's OAuth bits)
// call the built-in fetch() directly instead of httpGet/httpGetFull, which
// meant they got NONE of the above — no User-Agent identification, no
// X-Compatibility-Date, no rate/error-limit gating, no ETag caching. Wrapping
// the global here covers every one of them in one place, exactly like the
// renderer already does for window.fetch (see src/utils.js) — no per-call-site
// changes needed, and any future fetch() call gets this for free too.
const _origGlobalFetch = global.fetch;
if (typeof _origGlobalFetch === 'function') {
  global.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/esi\.evetech\.net/i.test(url)) return _origGlobalFetch.call(this, input, init);

    await _esiGateWait(url);
    const cached = _readEtagEntry(url);
    const reqHeaders = { 'User-Agent': APP_USER_AGENT, ..._esiCompatHeader(url), ...(init?.headers || {}) };
    // Only GETs are safe to serve from the ETag cache — never short-circuit a
    // POST/PUT/DELETE, and never send a stale conditional header on a write.
    const isGet = !init?.method || init.method.toUpperCase() === 'GET';
    if (isGet && cached?.etag) reqHeaders['If-None-Match'] = cached.etag;

    const res = await _origGlobalFetch.call(this, input, { ...(init || {}), headers: reqHeaders });
    _esiNoteFetchResponse(url, res);
    // Mirror httpGet/httpGetFull's explicit 429 handling: a bucket-limit 429
    // carries Retry-After but not necessarily the X-Esi-Error-Limit-* headers
    // _esiNoteFetchResponse already checks, so back off here too.
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || res.headers.get('x-esi-error-limit-reset') || '60', 10);
      _esiBlockUntil = Math.max(_esiBlockUntil, Date.now() + retryAfter * 1000);
    }

    if (isGet && res.status === 304 && cached) {
      // Fetch Response bodies are one-shot streams — hand back a fresh Response
      // built from the cached body so callers can still call .json()/.text().
      return new Response(cached.body, { status: 200, statusText: 'OK (cached)', headers: res.headers });
    }
    if (isGet && res.ok) {
      const etag = res.headers.get('etag');
      if (etag) {
        const body = await res.clone().text();
        _writeEtagEntry(url, { etag, body });
      }
    }
    return res;
  };
}

async function httpGet(url, headers = {}) {
  await _esiGateWait(url);
  const cached = _readEtagEntry(url);
  return new Promise((resolve, reject) => {
    const reqHeaders = { 'User-Agent': APP_USER_AGENT, 'Accept': 'application/json', ..._esiCompatHeader(url), ...headers };
    if (cached?.etag) reqHeaders['If-None-Match'] = cached.etag;
    const req = https.request(url, { headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        _esiNoteResponse(url, res);
        if (res.statusCode === 429 || res.statusCode === 420) {
          // Surface the Retry-After header so callers can back off correctly
          const retryAfter = parseInt(res.headers['retry-after'] || res.headers['x-esi-error-limit-reset'] || '60', 10);
          if (res.statusCode === 429) _esiBlockUntil = Math.max(_esiBlockUntil, Date.now() + retryAfter * 1000);
          return reject(Object.assign(
            new Error(`HTTP ${res.statusCode}: ${url}`),
            { retryAfter, isRateLimit: true }
          ));
        }
        // Not Modified — the ETag we sent still matches, reuse the stored body
        // instead of parsing the (deliberately empty) 304 response.
        if (res.statusCode === 304 && cached) {
          try { return resolve(JSON.parse(cached.body)); } catch { /* corrupt cache entry — fall through */ }
        }
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        if (res.headers['etag']) _writeEtagEntry(url, { etag: res.headers['etag'], body: data });
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
async function httpGetFull(url, headers = {}) {
  await _esiGateWait(url);
  const cached = _readEtagEntry(url);
  return new Promise((resolve, reject) => {
    const reqHeaders = { 'User-Agent': APP_USER_AGENT, 'Accept': 'application/json', ..._esiCompatHeader(url), ...headers };
    if (cached?.etag) reqHeaders['If-None-Match'] = cached.etag;
    const req = https.request(url, { headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        _esiNoteResponse(url, res);
        if (res.statusCode === 429 || res.statusCode === 420) {
          const retryAfter = parseInt(res.headers['retry-after'] || res.headers['x-esi-error-limit-reset'] || '60', 10);
          if (res.statusCode === 429) _esiBlockUntil = Math.max(_esiBlockUntil, Date.now() + retryAfter * 1000);
          return reject(Object.assign(
            new Error(`HTTP ${res.statusCode}: ${url}`),
            { retryAfter, isRateLimit: true }
          ));
        }
        if (res.statusCode === 304 && cached) {
          try { return resolve({ data: JSON.parse(cached.body), xPages: cached.xPages ?? 1 }); } catch { /* corrupt cache entry — fall through */ }
        }
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        const xPages = parseInt(res.headers['x-pages'] || '1', 10);
        if (res.headers['etag']) _writeEtagEntry(url, { etag: res.headers['etag'], body: data, xPages });
        try {
          resolve({
            data: JSON.parse(data),
            xPages,
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

async function httpPost(url, body, headers = {}, formEncoded = false) {
  // Was never gated or identified with X-Compatibility-Date — fine for the
  // SSO token endpoint (not ESI), but this is also used for real ESI POSTs
  // (bulk name resolution, fittings), which need the same treatment as
  // httpGet/httpGetFull. _esiGateWait/_esiCompatHeader/_esiNoteResponse are
  // all already scoped to esi.evetech.net only, so this is a no-op for SSO.
  await _esiGateWait(url);
  return new Promise((resolve, reject) => {
    const postData = formEncoded ? body : JSON.stringify(body);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'User-Agent': APP_USER_AGENT,
        'Content-Type': formEncoded ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'application/json',
        'Host': urlObj.hostname,
        ..._esiCompatHeader(url),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        _esiNoteResponse(url, res);
        if (res.statusCode === 429 || res.statusCode === 420) {
          const retryAfter = parseInt(res.headers['retry-after'] || res.headers['x-esi-error-limit-reset'] || '60', 10);
          if (res.statusCode === 429) _esiBlockUntil = Math.max(_esiBlockUntil, Date.now() + retryAfter * 1000);
          return reject(Object.assign(
            new Error(`HTTP ${res.statusCode}: ${url}`),
            { retryAfter, isRateLimit: true }
          ));
        }
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

// ─── Dashboard widget pop-outs ────────────────────────────────────────────────
// Each dashboard widget can float as its own small glass window. The dashboard
// keeps rendering the widget in a hidden host and streams its HTML here; the
// popout is a dumb mirror. Closing a popout (button or OS close) notifies the
// dashboard so the widget pops back into the grid.
const widgetPopouts = new Map();   // widgetId → BrowserWindow

ipcHandle('widget-popout-open', (_e, { id, title, w, h }) => {
  if (!id) return { success: false, error: 'No widget id' };
  const existing = widgetPopouts.get(id);
  if (existing && !existing.isDestroyed()) { existing.focus(); return { success: true }; }

  const win = new BrowserWindow({
    width:      Math.round(Math.max(280, Math.min(w || 420, 1000))),
    height:     Math.round(Math.max(200, Math.min((h || 320) + 40, 1000))),  // + titlebar
    minWidth:   240,
    minHeight:  160,
    resizable:  true,
    skipTaskbar: false,
    transparent: false,
    ...(acrylicSupported()
      ? { titleBarStyle: 'hidden', backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
      : { frame: false, backgroundColor: '#070b14' }),
    icon: appIconPath() || undefined,
    webPreferences: {
      preload:          path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'html', 'widget-window.html'),
               { query: { id, title: title || 'WIDGET' } });
  widgetPopouts.set(id, win);

  win.on('closed', () => {
    widgetPopouts.delete(id);
    // Any close (pop-in button or OS ✕) returns the widget to the dashboard
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('widget-popped-in', id);
    }
  });
  return { success: true };
});

// Pop-in button inside the popout → close (the closed handler does the rest)
ipcHandle('widget-popout-close', (_e, id) => {
  const win = widgetPopouts.get(id);
  if (win && !win.isDestroyed()) win.close();
  return { success: true };
});

// Popout finished loading → ask the dashboard for a first content push
ipcHandle('widget-popout-ready', (_e, id) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('widget-popout-ready', id);
  }
  return { success: true };
});

// Fresh widget HTML from the dashboard, relayed to the matching popout
ipcHandle('widget-popout-content', (_e, { id, html, title }) => {
  const win = widgetPopouts.get(id);
  if (win && !win.isDestroyed()) win.webContents.send('widget-content', { id, html, title });
  return { success: true };
});

// Always-on-top pin toggle from the popout titlebar
ipcHandle('widget-popout-pin', (_e, { id, pinned }) => {
  const win = widgetPopouts.get(id);
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!pinned, 'screen-saver');
  return { success: true };
});

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
    transparent:     false,
    show:            false,   // created hidden — shown INACTIVE below (see note)
    // Acrylic doesn't render on frame:false windows — titleBarStyle:'hidden'
    // gives the same chromeless look and lets the material work (this is why
    // the main window's glass worked and this popup's didn't). Solid-color
    // frameless fallback for pre-22H2 Windows.
    ...(acrylicSupported()
      ? { titleBarStyle: 'hidden', backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
      : { frame: false, backgroundColor: '#070b14' }),
    icon:            appIconPath() || undefined,
    webPreferences: {
      preload:          path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
 
  // ── GAME-SAFETY: never steal foreground focus ────────────────────────────
  // Electron's default show() force-activates the window. If a D3D game holds
  // the display in exclusive fullscreen, that forced foreground change yanks
  // the game out of its display mode → device-lost → some titles (CoD,
  // Battlefield, anything anticheat-wrapped) hard-crash instead of recovering.
  // showInactive() draws the alert without touching the game's focus or swap
  // chain; flashFrame() pulses the taskbar so it still gets noticed. We also
  // stay in the NORMAL topmost band (options alwaysOnTop) instead of the old
  // 'screen-saver' level, which aggravated the forced mode switch.
  win.once('ready-to-show', () => {
    win.showInactive();
    win.flashFrame(true);
  });

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

// ─── System tray ───────────────────────────────────────────────────────────────
// When "Minimize to tray" is on, minimizing the main window hides it to the
// Windows notification area instead of the taskbar; the tray icon (and its
// context menu) is the way back. The tray is created/destroyed as the setting
// is toggled so there's no stray icon when the feature is off.
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return tray;
  // A missing .ico must never break minimize-to-tray: fall back to a blank image
  // (menu and click-to-restore still work) rather than letting new Tray() throw.
  const iconPath = appIconPath();
  tray = new Tray(iconPath || nativeImage.createEmpty());
  tray.setToolTip('EVE Carbon');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show EVE Carbon', click: showMainWindow },
    { type: 'separator' },
    { label: 'Quit EVE Carbon', click: () => app.quit() },
  ]));
  // Single click is the common Windows idiom for restoring a tray app.
  tray.on('click', showMainWindow);
  return tray;
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

// Apply the current minimize-to-tray preference: create the tray when enabled,
// remove it when disabled — restoring the window first if it's currently hidden
// so the user can never be stranded with no way to bring it back.
function applyMinimizeToTray(enabled) {
  minimizeToTrayEnabled = !!enabled;
  if (minimizeToTrayEnabled) {
    createTray();
  } else {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) showMainWindow();
    destroyTray();
  }
}

// ─── Acrylic glass (spatial UI) ───────────────────────────────────────────────
// backgroundMaterial:'acrylic' is a Windows 11 22H2+ DWM effect: the OS blurs
// whatever is behind the window (desktop, other apps) and composites it under
// our transparent web content — this is what lets the reeded-glass CSS show the
// desktop through. Win10 (build < 22000) ignores it, so we keep the solid
// background there and the renderer falls back to the classic dark theme.
function acrylicSupported() {
  if (process.platform !== 'win32') return false;
  const build = parseInt(require('os').release().split('.')[2] || '0', 10);
  return build >= 22621; // 22H2 — earlier Win11 builds have broken acrylic resize
}

function createWindow() {
  const glass = acrylicSupported();
  const win = new BrowserWindow({
    width: 1800,
    height: 1200,
    minWidth: 900,
    minHeight: 640,
    // Fully transparent bg lets the OS acrylic material show through the page.
    backgroundColor: glass ? '#00000000' : '#070b14',
    ...(glass ? { backgroundMaterial: 'acrylic' } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#070b14', symbolColor: '#ab7ab8', height: 32 },
    icon: appIconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,   // enables the embedded <webview> on the Forums page
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

  // Minimize to tray: hide the window instead of dropping it to the taskbar.
  // window-all-closed never fires (the window is hidden, not closed) so the
  // app keeps running in the tray until explicitly quit.
  win.on('minimize', (e) => {
    if (minimizeToTrayEnabled) {
      e.preventDefault();
      win.hide();
    }
  });

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
// EVE SSO access tokens are JWTs whose payload carries the granted scopes in `scp`.
// Decoding it (no signature check needed — we already trust our own stored token)
// lets us tell when the app's required scope list has grown beyond what the
// character last consented to, so the renderer can prompt a re-auth.
function decodeTokenScopes(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const scp = payload.scp;
    return Array.isArray(scp) ? scp : (typeof scp === 'string' ? scp.split(' ') : []);
  } catch (_) { return null; }
}

// Scopes the app now requires that this character's token wasn't granted. Empty
// when up to date (or when the token can't be decoded — we don't nag in that case).
async function getMissingScopes(characterId) {
  try {
    const granted = decodeTokenScopes(await getValidToken(characterId));
    if (!granted) return [];
    return SCOPES.split(' ').filter(s => s && !granted.includes(s));
  } catch (_) { return []; }
}

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

  // If the app has gained new ESI scopes since this character last authorised,
  // flag it so the renderer can redirect the user to re-authenticate.
  const missingScopes = await getMissingScopes(characterId).catch(() => []);
  if (missingScopes.length) { summary.needsReauth = true; summary.missingScopes = missingScopes; }
  return summary;
});

// ─── Status-only sync (location + ship + active implants) ─────────────────────
// The dashboard banner shows "where am I / what am I flying / which implants". This
// refreshes just those three on demand (every dashboard load) — no wallet / info /
// jump-clone / asset work, and crucially NO implant stale-gate, so the banner is
// always the latest ESI pull. Each step preserves stale DB data on its own error.
async function statusCharacterSync(characterId) {
  await charInfoDb.ensureCharacterTables(characterId);
  const token   = await getValidToken(characterId);
  const authHdr = { Authorization: `Bearer ${token}` };

  // Current location (+ station/structure + system names)
  try {
    const loc = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/location/?datasource=tranquility`, authHdr);
    let stationName = null;
    try {
      if (loc.station_id)        { const s = await getLocator().resolveLocation(loc.station_id,   characterId); stationName = s?.name || null; }
      else if (loc.structure_id) { const s = await getLocator().resolveLocation(loc.structure_id, characterId); stationName = s?.name || null; }
    } catch (_) {}
    let sysName = null;
    if (loc.solar_system_id) { try { const nm = await resolveNames([loc.solar_system_id]); sysName = nm[loc.solar_system_id] || null; } catch (_) {} }
    await charInfoDb.upsertLocation(characterId, { ...loc, solar_system_name: sysName }, stationName);
  } catch (e) { console.warn(`[statusSync] location ${characterId}: ${e.message}`); }

  // Current ship
  try {
    const ship = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/ship/?datasource=tranquility`, authHdr);
    let typeName = '';
    if (ship.ship_type_id) { try { const nm = await resolveNames([ship.ship_type_id]); typeName = nm[ship.ship_type_id] || ''; } catch (_) {} }
    await charInfoDb.upsertShip(characterId, ship, typeName);
  } catch (e) { console.warn(`[statusSync] ship ${characterId}: ${e.message}`); }

  // Active implants — no stale gate; preserve DB rows if the fetch itself fails.
  try {
    const raw   = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/implants/?datasource=tranquility`, authHdr);
    const ids   = [...new Set(Array.isArray(raw) ? raw : [])];
    const names = ids.length ? await resolveNames(ids) : {};
    const slots = ids.length ? await resolveImplantSlots(ids) : {};
    await charInfoDb.replaceImplants(characterId, ids.map(id => ({
      implant_id: id, type_name: names[id] || `Type ${id}`, slot: slots[id] ?? null,
    })));
  } catch (e) { console.warn(`[statusSync] implants ${characterId}: ${e.message}`); }

  return { ok: true };
}

ipcHandle('sync-character-status', async (_event, characterId) => {
  try { return await statusCharacterSync(characterId); }
  catch (e) { return { ok: false, error: e.message }; }
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
// CCP now ships the SDE as a JSONL export (developers.eveonline.com/static-data
// — Fuzzwork's sqlite dump is no longer the source). Version check uses the
// SDE manifest's buildNumber, stored in sde.md5 for path compatibility with
// the rest of the app. Fetch/extract/convert logic lives in src/sde_fetch.js +
// src/sde_build.js (shared with scripts/fetch-sde.js, the CI/dev build step).

function getSdeMd5Path() {
  const devPath  = path.join(__dirname, 'data', 'sde.md5');
  const prodPath = path.join(process.resourcesPath || __dirname, 'data', 'sde.md5');
  return app.isPackaged ? prodPath : devPath;
}

// sde-check-update → { upToDate, remoteMd5, localMd5 }
// (field names kept as *Md5 for renderer compatibility; the value is now the
// SDE build number, not an MD5 — see comment above.)
ipcHandle('sde-check-update', async () => {
  try {
    const manifest = await sdeFetch.fetchManifest(APP_USER_AGENT);
    const remoteMd5 = String(manifest.buildNumber);
    let localMd5 = null;
    try { localMd5 = fs.readFileSync(getSdeMd5Path(), 'utf8').trim(); } catch { /* no local version yet */ }
    return { upToDate: remoteMd5 === localMd5, remoteMd5, localMd5 };
  } catch (e) {
    return { error: e.message };
  }
});

// sde-download-update — downloads CCP's JSONL export, converts it to sde.sql,
// saves the version token. Sends 'sde-update-progress' push events: { stage, percent }
ipcHandle('sde-download-update', async (event) => {
  const sdePath = getSdePath();
  const md5Path = getSdeMd5Path();
  const win     = BrowserWindow.fromWebContents(event.sender);
  const push    = (stage, percent) => {
    if (win && !win.isDestroyed()) win.webContents.send('sde-update-progress', { stage, percent });
  };

  try {
    const manifest = await sdeFetch.fetchAndBuildSde({
      userAgent: APP_USER_AGENT,
      outSqlitePath: sdePath,
      onProgress: (stage, pct) => push(stage, pct ?? undefined),
    });

    fs.writeFileSync(md5Path, String(manifest.buildNumber), 'utf8');
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
// Remove the tray icon on quit so it doesn't linger in the notification area.
app.on('before-quit', () => destroyTray());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});