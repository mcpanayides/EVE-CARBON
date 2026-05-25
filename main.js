require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const createLocator      = require('./src/locator');
const charInfoDb         = require('./src/character_info_db');

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

let xmppLibrary = null;
async function getXmppClient() {
  if (!xmppLibrary) {
    xmppLibrary = await import('@xmpp/client');
  }
  return xmppLibrary;
}

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
  'esi-characters.read_blueprints.v1',
  'esi-assets.read_assets.v1',
  'esi-corporations.read_blueprints.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-industry.read_corporation_jobs.v1',
  'esi-wallet.read_character_wallet.v1',
  'esi-clones.read_clones.v1',                  // home location + jump clones + implants
  'esi-skills.read_skills.v1',                  // total skill points
  'esi-markets.read_character_orders.v1',       // active market orders (escrow)
  'esi-contracts.read_character_contracts.v1',  // contracts (escrow)
  'esi-location.read_location.v1',              // current solar system / station
  'esi-location.read_ship_type.v1',             // current ship type
  'esi-planets.manage_planets.v1',              // planetary interaction colonies
  'esi-characters.read_loyalty.v1',             // loyalty points per corporation
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
let pingFileWatcher = null;
let pingFileWatchTimer = null;

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

// Locator: shared location resolver (player structures + NPC stations)
let locator = null;
function getLocator() {
  if (!locator) locator = createLocator({ httpGet, readCache, writeCache, getValidToken });
  return locator;
}

app.whenReady().then(async () => {
  initPaths();
  await initSde();
  await charInfoDb.initCharacterDb(appDataDir);
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

// ─── PKCE helpers ─────────────────────────────────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── SSO state store (per login attempt) ──────────────────────────────────────
const pendingAuth = {}; // state -> { codeVerifier, mainWindow }

// ─── Caches ───────────────────────────────────────────────────────────────────
const nameCache = {};
const bpCache   = {};

// ─── Local callback HTTP server ───────────────────────────────────────────────
let callbackServer = null;

function startCallbackServer() {
  if (callbackServer) return;
  callbackServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
    if (url.pathname !== '/auth/callback' && url.pathname !== '/auth/callback/') { res.end(); return; }

    const code  = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state || !pendingAuth[state]) {
      res.writeHead(400);
      res.end('<html><body style="background:#070b14;color:#e24b4a;font-family:monospace;padding:2rem;"><h2>❌ Auth Error</h2><p>Invalid callback. Close this window.</p></body></html>');
      return;
    }

    const { codeVerifier, win } = pendingAuth[state];
    delete pendingAuth[state];

    try {
      // Exchange code for tokens (PKCE — no secret key needed)
      const formBody = new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        client_id:     CLIENT_ID,
        redirect_uri:  CALLBACK_URL,
        code_verifier: codeVerifier,
      }).toString();

      const tokenData = await httpPost(SSO_TOKEN_URL, formBody, {}, true);

      // Verify the token to get character info
      const charInfo = await httpGet(SSO_VERIFY_URL, {
        'Authorization': `Bearer ${tokenData.access_token}`
      });

      const characterId   = charInfo.CharacterID;
      const characterName = charInfo.CharacterName;

      // Save to DB
      const db = loadDB();
      db.accounts[characterId] = {
        characterId,
        characterName,
        accessToken:  tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt:    Date.now() + (tokenData.expires_in * 1000),
        addedAt:      Date.now(),
      };
      saveDB(db);

      // Notify renderer
      if (win && !win.isDestroyed()) {
        win.webContents.send('account-added', { characterId, characterName });
      }

      // ── Auto full-sync on first login ────────────────────────────────────
      // Run in background — don't block the HTTP response
      setImmediate(async () => {
        try {
          console.log(`[CharSync] Auto-syncing all data for ${characterName} (${characterId})…`);
          if (win && !win.isDestroyed()) {
            win.webContents.send('char-sync-progress', { characterId, characterName, step: 'start' });
          }
          const summary = await fullCharacterSync(characterId, characterName, (step, detail) => {
            console.log(`[CharSync] ${characterName} — ${step}: ${detail}`);
            if (win && !win.isDestroyed()) {
              win.webContents.send('char-sync-progress', { characterId, characterName, step, detail });
            }
          });
          console.log(`[CharSync] ✓ ${characterName} sync complete:`, summary);
          if (win && !win.isDestroyed()) {
            win.webContents.send('char-sync-progress', { characterId, characterName, step: 'done', summary });
          }
        } catch (e) {
          console.error(`[CharSync] Auto-sync failed for ${characterName}:`, e.message);
          if (win && !win.isDestroyed()) {
            win.webContents.send('char-sync-progress', { characterId, characterName, step: 'error', detail: e.message });
          }
        }
      });

      // Add the Content-Type header so the browser knows how to render the hexagon
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="background:#070b14;color:#4ada8a;font-family:monospace;padding:2rem;text-align:center;">
        <div style="margin-top:3rem;">
          <div style="font-size:3rem;margin-bottom:1rem;">⬡</div>
          <h2 style="letter-spacing:0.1em;">CHARACTER AUTHENTICATED</h2>
          <p style="color:#6888a8;margin-top:1rem;">${characterName} has been added to the calculator.</p>
          <p style="color:#3a5070;margin-top:2rem;font-size:11px;">You can close this window.</p>
        </div>
      </body></html>`);

    } catch (e) {
      res.writeHead(500);
      res.end(`<html><body style="background:#070b14;color:#e24b4a;font-family:monospace;padding:2rem;"><h2>Auth Failed</h2><p>${e.message}</p></body></html>`);
      if (win && !win.isDestroyed()) {
        win.webContents.send('auth-error', e.message);
      }
    }
  });

  callbackServer.listen(CALLBACK_PORT, '127.0.0.1');
}

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
      // 1. Update preload path to look inside 'src'
      preload: path.join(__dirname, 'src', 'preload.js'), 
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  const url = require('url');
  // 2. Update html path to look inside 'src'
  win.loadURL(url.format({
    pathname: path.join(__dirname, 'src', 'index.html'),
    protocol: 'file:',
    slashes: true
  }));
  return win;
}

// ─── IPC: Config ──────────────────────────────────────────────────────────────
// Config is now hardcoded — no client-side config needed

// ─── IPC: Accounts ────────────────────────────────────────────────────────────
ipcMain.handle('get-accounts', () => {
  const db = loadDB();
  return Object.values(db.accounts).map(a => ({
    characterId:   a.characterId,
    characterName: a.characterName,
    addedAt:       a.addedAt,
  }));
});

ipcMain.handle('get-character-jobs', async (_, characterId) => {
  // Completed jobs never change — cache aggressively to avoid hammering ESI.
  // This is the single biggest source of 429s in the dashboard refresh loop.
  const cacheKey = `jobs_completed_${characterId}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  try {
    const token = await getValidToken(characterId);
    const url = `${ESI_BASE}/latest/characters/${characterId}/industry/jobs/?datasource=tranquility&status=completed`;
    const jobs = await httpGet(url, { Authorization: `Bearer ${token}` });
    if (!Array.isArray(jobs)) return [];
    const systemIds = [...new Set(jobs.filter(j => j.solar_system_id).map(j => j.solar_system_id))];
    const nameMap = systemIds.length ? await resolveNames(systemIds) : {};
    const result = jobs.map(job => ({
      ...job,
      solar_system_name: nameMap[job.solar_system_id] || `System ${job.solar_system_id || 'Unknown'}`,
    }));
    writeCache(cacheKey, result, 1); // 24 hours — completed jobs never change
    writeCache(`${cacheKey}_stale`, result, 30); // 30-day stale fallback for 429 situations
    return result;
  } catch (e) {
    if (e.isRateLimit) {
      // On a 429, return whatever stale cache we have rather than an empty array,
      // so the dashboard doesn't blank out the jobs table.
      const stale = readCache(`${cacheKey}_stale`);
      if (stale) return stale;
    }
    console.warn('Failed to load character jobs:', e.message || e);
    return [];
  }
});

ipcMain.handle('remove-account', async (_, characterId) => {
  const db = loadDB();
  delete db.accounts[characterId];
  delete db.blueprints[characterId];
  delete db.assets[characterId];
  saveDB(db);
  // Also remove all tables for this character from character_information.db
  try { await charInfoDb.removeCharacterData(characterId); } catch (e) { /* ignore */ }
  return true;
});

// ─── IPC: SSO Login ───────────────────────────────────────────────────────────
ipcMain.handle('start-sso-login', (event) => {
  const cfg = loadConfig();
  // Client ID is hardcoded — always available

  startCallbackServer();

  const codeVerifier   = generateCodeVerifier();
  const codeChallenge  = generateCodeChallenge(codeVerifier);
  const state          = crypto.randomBytes(16).toString('hex');

  const win = BrowserWindow.fromWebContents(event.sender);
  pendingAuth[state] = { codeVerifier, win };

  const params = new URLSearchParams({
    response_type:         'code',
    redirect_uri:          CALLBACK_URL,
    client_id:             CLIENT_ID,
    scope:                 SCOPES,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  const authUrl = `${SSO_AUTH_URL}?${params.toString()}`;
  shell.openExternal(authUrl);
  return { ok: true };
});

// ─── IPC: Fetch & sync blueprints for a character ─────────────────────────────
ipcMain.handle('sync-blueprints', async (_, characterId) => {
  const token = await getValidToken(characterId);
  const db    = loadDB();

  // Fetch character blueprints
  let allBPs = [];
  let page = 1;
  while (true) {
    const data = await httpGet(
      `${ESI_BASE}/v3/characters/${characterId}/blueprints/?page=${page}&datasource=tranquility`,
      { Authorization: `Bearer ${token}` }
    );
    allBPs = allBPs.concat(data);
    if (data.length < 1000) break;
    page++;
  }

  // Resolve type names for all BPs
  const typeIds = [...new Set(allBPs.map(b => b.type_id))];
  const nameMap = await resolveNames(typeIds);

  const blueprints = allBPs.map(bp => ({
    item_id:       bp.item_id,
    type_id:       bp.type_id,
    name:          nameMap[bp.type_id] || `Type ${bp.type_id}`,
    location_id:   bp.location_id,
    location_flag: bp.location_flag,
    quantity:      bp.quantity,      // -1 = BPO, -2 = BPC
    runs:          bp.runs,          // -1 = BPO, >0 = BPC runs remaining
    me:            bp.material_efficiency,
    te:            bp.time_efficiency,
    isBPC:         bp.quantity === -2,
  }));

  db.blueprints[characterId] = {
    updatedAt: Date.now(),
    items: blueprints,
  };
  saveDB(db);

  return { count: blueprints.length, blueprints };
});

// ─── IPC: Get saved blueprints ────────────────────────────────────────────────
ipcMain.handle('get-blueprints', (_, characterId) => {
  const db = loadDB();
  return db.blueprints[characterId] || null;
});

ipcMain.handle('get-all-blueprints', () => {
  const db = loadDB();
  const all = [];
  for (const [charId, data] of Object.entries(db.blueprints)) {
    const account = db.accounts[charId];
    if (data && data.items) {
      data.items.forEach(bp => all.push({
        ...bp,
        characterId: charId,
        characterName: account?.characterName || 'Unknown',
      }));
    }
  }
  return all;
});

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

    // Active implants (separate endpoint)
    let activeImplants = [];
    try {
      activeImplants = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/implants/?datasource=tranquility`, authHdr);
    } catch (_) {}

    // Resolve implant type names
    const allImplantIds = [...new Set(activeImplants || [])];
    const implantNames = allImplantIds.length ? await resolveNames(allImplantIds) : {};
    const implants = allImplantIds.map((id, i) => ({
      implant_id: id,
      type_name:  implantNames[id] || `Type ${id}`,
      slot:       i + 1,
    }));
    await charInfoDb.replaceImplants(characterId, implants);
    summary.steps.implants = `${implants.length} active`;
    report('implants', `✓ ${implants.length} active implants`);

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
    report('pi', 'Fetching PI colonies…');
    const colonies = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/planets/?datasource=tranquility`, authHdr);
    if (Array.isArray(colonies)) {
      const sysIds = [...new Set(colonies.map(c => c.solar_system_id).filter(Boolean))];
      const sysNames = sysIds.length ? await resolveNames(sysIds) : {};
      const piData = colonies.map(c => ({
        planet_id:         c.planet_id,
        planet_type:       c.planet_type || null,
        solar_system_id:   c.solar_system_id,
        solar_system_name: sysNames[c.solar_system_id] || null,
        upgrade_level:     c.upgrade_level || 0,
        num_pins:          c.num_pins || 0,
        last_update:       c.last_update ? new Date(c.last_update).getTime() : null,
      }));
      await charInfoDb.replacePiColonies(characterId, piData);
      summary.steps.pi = `${piData.length} colonies`;
      report('pi', `✓ ${piData.length} PI colonies`);
    }
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
    const typeIds     = [...new Set(allAssets.map(a => a.type_id).filter(Boolean))];
    const locationIds = [...new Set(allAssets.map(a => a.location_id).filter(Boolean))];
    const nameMap     = await resolveNames(typeIds);
    const locationMeta = await getLocator().resolveLocations(locationIds, characterId);

    const assets = allAssets.map(asset => {
      const loc = locationMeta[asset.location_id] || {};
      return {
        item_id:           asset.item_id,
        type_id:           asset.type_id,
        name:              nameMap[asset.type_id] || `Type ${asset.type_id}`,
        location_id:       asset.location_id,
        location_name:     loc.name || `Location ${asset.location_id}`,
        location_flag:     asset.location_flag || '',
        quantity:          asset.is_singleton ? 1 : (asset.quantity || 1),
        is_singleton:      asset.is_singleton,
        solar_system_id:   loc.solar_system_id   || null,
        solar_system_name: loc.solar_system_name || null,
        region_id:         loc.region_id         || null,
        region_name:       loc.region_name       || null,
        security_status:   typeof loc.security_status === 'number' ? loc.security_status : null,
      };
    });

    await charInfoDb.replaceAssets(characterId, assets);
    summary.steps.assets = `${assets.length} items`;
    report('assets', `✓ ${assets.length} assets stored`);
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
ipcMain.handle('sync-character-full', async (event, characterId) => {
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

  // 5. Implants & jump clones
  try {
    report('implants', 'Fetching implants & clones…');
    const cloneData = await httpGet(`${ESI_BASE}/v3/characters/${characterId}/clones/?datasource=tranquility`, authHdr);
    let activeImplants = [];
    try { activeImplants = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/implants/?datasource=tranquility`, authHdr); } catch (_) {}
    const allImplantIds  = [...new Set(activeImplants || [])];
    const implantNames   = allImplantIds.length ? await resolveNames(allImplantIds) : {};
    const implants = allImplantIds.map((id, i) => ({ implant_id: id, type_name: implantNames[id] || `Type ${id}`, slot: i + 1 }));
    await charInfoDb.replaceImplants(characterId, implants);
    summary.steps.implants = `${implants.length} active`;
    report('implants', `✓ ${implants.length} active implants`);
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
  } catch (e) { summary.steps.implants = `error: ${e.message}`; report('implants', `✗ ${e.message}`); }

  // 6. Planetary Interaction
  try {
    report('pi', 'Fetching PI colonies…');
    const colonies = await httpGet(`${ESI_BASE}/v1/characters/${characterId}/planets/?datasource=tranquility`, authHdr);
    if (Array.isArray(colonies)) {
      const sysIds   = [...new Set(colonies.map(c => c.solar_system_id).filter(Boolean))];
      const sysNames = sysIds.length ? await resolveNames(sysIds) : {};
      const piData   = colonies.map(c => ({
        planet_id: c.planet_id, planet_type: c.planet_type || null,
        solar_system_id: c.solar_system_id, solar_system_name: sysNames[c.solar_system_id] || null,
        upgrade_level: c.upgrade_level || 0, num_pins: c.num_pins || 0,
        last_update: c.last_update ? new Date(c.last_update).getTime() : null,
      }));
      await charInfoDb.replacePiColonies(characterId, piData);
      summary.steps.pi = `${piData.length} colonies`;
      report('pi', `✓ ${piData.length} PI colonies`);
    }
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

// ─── IPC: Core-only auto-sync (20-min cadence, no assets) ─────────────────────
ipcMain.handle('sync-character-core', async (event, characterId) => {
  const db = loadDB();
  const account = db.accounts[characterId];
  if (!account) throw new Error('Account not found');
  const characterName = account.characterName;
  const win = BrowserWindow.fromWebContents(event.sender);

  return coreCharacterSync(characterId, characterName, (step, detail) => {
    console.log(`[CoreSync] ${characterName} — ${step}: ${detail}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('char-sync-progress', { characterId, characterName, step, detail });
    }
  });
});

// ─── IPC: Asset-only sync — skips if synced within the last 12 hours ──────────
const ASSET_STALE_MS = 12 * 60 * 60 * 1000; // 12 hours

ipcMain.handle('sync-character-assets-if-stale', async (event, characterId) => {
  const db = loadDB();
  const account = db.accounts[characterId];
  if (!account) throw new Error('Account not found');
  const characterName = account.characterName;
  const win = BrowserWindow.fromWebContents(event.sender);

  // Check how old the asset data is
  const lastAssetSync = await charInfoDb.getAssetSyncedAt(characterId).catch(() => 0);
  const ageMs = Date.now() - (lastAssetSync || 0);

  if (lastAssetSync && ageMs < ASSET_STALE_MS) {
    const hoursOld = (ageMs / 3_600_000).toFixed(1);
    console.log(`[AssetSync] ${characterName}: assets fresh (${hoursOld}h old) — skipping.`);
    return { skipped: true, characterId, characterName, ageMs };
  }

  console.log(`[AssetSync] ${characterName}: assets stale — syncing…`);
  if (win && !win.isDestroyed()) {
    win.webContents.send('char-sync-progress', { characterId, characterName, step: 'assets', detail: 'Fetching assets (paginated)…' });
  }

  try {
    const r = await syncAssetsInternal(characterId);
    console.log(`[AssetSync] ${characterName}: ✓ ${r.count} assets stored.`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('char-sync-progress', { characterId, characterName, step: 'assets', detail: `✓ ${r.count} assets stored` });
    }
    return { skipped: false, characterId, characterName, count: r.count };
  } catch (e) {
    console.warn(`[AssetSync] ${characterName}: ✗ ${e.message}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('char-sync-progress', { characterId, characterName, step: 'assets', detail: `✗ ${e.message}` });
    }
    throw e;
  }
});

// ─── IPC: Get stored character info from CharDB ───────────────────────────────
ipcMain.handle('get-character-info-db', async (_, characterId) => {
  return charInfoDb.getCharacterData(characterId);
});

ipcMain.handle('get-character-assets-db', async (_, characterId) => {
  return charInfoDb.getCharacterAssets(characterId);
});

ipcMain.handle('get-character-blueprints-db', async (_, characterId) => {
  return charInfoDb.getCharacterBlueprints(characterId);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADDITIONS FOR main.js
// Insert both blocks below immediately AFTER the existing:
//   ipcMain.handle('get-character-blueprints-db', ...)   (around line 1162)
//
// These two handlers power the new blueprints.js "My Blueprints" tab.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── IPC: Get ALL blueprints from SQLite (all synced characters) ──────────────
// Reads char_{id}_blueprints tables directly from character_information.db.
// Returns a flat array of blueprint rows, each augmented with characterId and
// characterName from the accounts store (blueprints.json).
//
// Called by: loadBlueprintLibrary() in blueprints.js
//            via window.eveAPI.getAllBlueprintsFromDb()

ipcMain.handle('get-all-blueprints-from-db', async () => {
  const db       = loadDB();
  const accounts = db.accounts || {};
  const all      = [];

  for (const [charIdStr, account] of Object.entries(accounts)) {
    const characterId   = Number(charIdStr);
    const characterName = account.characterName || 'Unknown';

    try {
      const rows = await charInfoDb.getCharacterBlueprints(characterId);
      if (Array.isArray(rows)) {
        rows.forEach(row => {
          all.push({
            ...row,
            characterId,
            characterName,
          });
        });
      }
    } catch (e) {
      console.warn(`[get-all-blueprints-from-db] Skipped character ${characterId}: ${e.message}`);
    }
  }

  return all;
});

// ─── IPC: SDE blueprint materials with ME bonus applied ──────────────────────
// Queries the local SDE sqlite (sde.sql) for the manufacturing activity of
// blueprintTypeId, then applies the ME reduction formula:
//
//   adjustedQty = max(1, ceil(baseQty × (1 − me/100)))
//
// Also resolves the product type name and quantity from industryActivityProducts.
//
// Returns:
//   {
//     materials:    [{ typeId, name, baseQty, adjustedQty, isComponent }],
//     productTypeId: number | null,
//     productName:   string | null,
//     productQty:    number,
//   }
//
// Called by: openBlueprintDetail() in blueprints.js
//            via window.eveAPI.sdeBlueprintMaterials(typeId, me)

ipcMain.handle('sde-blueprint-materials', async (_, blueprintTypeId, me = 0) => {
  if (!sdeDb) return null;

  const MANUFACTURING = 1;  // activityID for manufacturing in SDE

  // ── 1. Fetch raw materials from industryActivityMaterials ──────────────────
  // The SDE table is: industryActivityMaterials(typeID, activityID, materialTypeID, quantity)
  let matRows = [];
  try {
    matRows = await sdeDb.all(
      `SELECT materialTypeID, quantity
         FROM industryActivityMaterials
        WHERE typeID     = ?
          AND activityID = ?`,
      blueprintTypeId, MANUFACTURING
    );
  } catch (e) {
    console.warn('[sde-blueprint-materials] industryActivityMaterials query failed:', e.message);
    return null;
  }

  if (!matRows.length) return null;

  // ── 2. Resolve material type names ────────────────────────────────────────
  const matTypeIds  = matRows.map(r => r.materialTypeID);
  const nameMap     = {};

  // Try invTypes first (most SDE builds), fall back to invtypes (lowercase)
  const nameTables  = [
    { t: 'invTypes',    col: 'typeName', idcol: 'typeID' },
    { t: 'invtypes',    col: 'typeName', idcol: 'typeID' },
    { t: 'invTypes_en', col: 'typeName', idcol: 'typeID' },
    { t: 'types',       col: 'name',     idcol: 'id'     },
  ];

  // Detect which invTypes table exists once and reuse
  let invTypesTable = null;
  for (const q of nameTables) {
    try {
      await sdeDb.get(`SELECT 1 FROM ${q.t} LIMIT 1`);
      invTypesTable = q;
      break;
    } catch (_) {}
  }

  if (invTypesTable) {
    // Batch fetch: SQLite supports up to ~999 params in IN clause
    const chunks = [];
    for (let i = 0; i < matTypeIds.length; i += 900) {
      chunks.push(matTypeIds.slice(i, i + 900));
    }
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => '?').join(',');
      try {
        const rows = await sdeDb.all(
          `SELECT ${invTypesTable.idcol} AS typeID, ${invTypesTable.col} AS typeName
             FROM ${invTypesTable.t}
            WHERE ${invTypesTable.idcol} IN (${placeholders})`,
          chunk
        );
        rows.forEach(r => { nameMap[r.typeID] = r.typeName; });
      } catch (_) {}
    }
  }

  // ── 3. Detect sub-components (types that are themselves manufactured) ───────
  // A material "is a component" if there exists a blueprint that produces it.
  const componentSet = new Set();
  for (const typeId of matTypeIds) {
    try {
      const row = await sdeDb.get(
        `SELECT 1 FROM industryActivityProducts
          WHERE activityID = ? AND productTypeID = ? LIMIT 1`,
        MANUFACTURING, typeId
      );
      if (row) componentSet.add(typeId);
    } catch (_) {}
  }

  // ── 4. Apply ME bonus ─────────────────────────────────────────────────────
  const clampedME = Math.max(0, Math.min(10, me));

  const materials = matRows.map(row => {
    const baseQty     = row.quantity;
    const adjustedQty = baseQty <= 1
      ? 1
      : Math.max(1, Math.ceil(baseQty * (1 - clampedME / 100)));
    return {
      typeId:      row.materialTypeID,
      name:        nameMap[row.materialTypeID] || `Type ${row.materialTypeID}`,
      baseQty,
      adjustedQty,
      isComponent: componentSet.has(row.materialTypeID),
    };
  });

  // ── 5. Resolve product info from industryActivityProducts ─────────────────
  let productTypeId = null;
  let productName   = null;
  let productQty    = 1;

  try {
    const prodRow = await sdeDb.get(
      `SELECT productTypeID, quantity
         FROM industryActivityProducts
        WHERE typeID     = ?
          AND activityID = ?
        LIMIT 1`,
      blueprintTypeId, MANUFACTURING
    );
    if (prodRow) {
      productTypeId = prodRow.productTypeID;
      productQty    = prodRow.quantity || 1;
      if (invTypesTable) {
        try {
          const nameRow = await sdeDb.get(
            `SELECT ${invTypesTable.col} AS typeName
               FROM ${invTypesTable.t}
              WHERE ${invTypesTable.idcol} = ?`,
            productTypeId
          );
          productName = nameRow?.typeName || null;
        } catch (_) {}
      }
    }
  } catch (e) {
    console.warn('[sde-blueprint-materials] product lookup failed:', e.message);
  }

  return { materials, productTypeId, productName, productQty };
});

ipcMain.handle('get-pi-colonies', async (_, characterId) => {
  return charInfoDb.getCharacterPIColonies(characterId);
});

// ─── IPC: Wallet journal / transactions / loyalty points (from CharDB) ────────
ipcMain.handle('get-wallet-journal', async (_, characterId) => {
  return charInfoDb.getWalletJournal(characterId);
});

ipcMain.handle('get-wallet-transactions', async (_, characterId) => {
  return charInfoDb.getWalletTransactions(characterId);
});

ipcMain.handle('get-loyalty-points', async (_, characterId) => {
  return charInfoDb.getLoyaltyPoints(characterId);
});

async function syncAssetsInternal(characterId) {
  const token = await getValidToken(characterId);
  let allAssets = [];
  let page = 1;
  while (true) {
    const data = await httpGet(
      `${ESI_BASE}/v3/characters/${characterId}/assets/?page=${page}&datasource=tranquility`,
      { Authorization: `Bearer ${token}` }
    );
    allAssets = allAssets.concat(data);
    if (!data || data.length < 1000) break;
    page++;
  }

  const typeIds     = [...new Set(allAssets.map(a => a.type_id).filter(Boolean))];
  const locationIds = [...new Set(allAssets.map(a => a.location_id).filter(Boolean))];
  const nameMap     = await resolveNames(typeIds);  // type names only

  // Resolve all location metadata via the shared locator module.
  // Handles NPC stations, player structures (ESI auth -> public -> adam4eve), and system IDs.
  const locationMeta = await getLocator().resolveLocations(locationIds, characterId);


  // locationMeta[id] now has the full locator shape:
  //   { name, solar_system_id, solar_system_name, constellation_id, constellation_name,
  //     region_id, region_name, security_status, owner_id, owner_name }
  const assets = allAssets.map(asset => {
    const loc = locationMeta[asset.location_id] || {};
    return {
      item_id:            asset.item_id,
      type_id:            asset.type_id,
      name:               nameMap[asset.type_id] || `Type ${asset.type_id}`,
      location_id:        asset.location_id,
      location_name:      loc.name || `Location ${asset.location_id}`,
      quantity:           asset.is_singleton ? 1 : (asset.quantity || 1),
      volume:             asset.volume || 0,
      is_singleton:       asset.is_singleton,
      location_flag:      asset.location_flag || asset.flag || '',
      solar_system_id:    loc.solar_system_id    || null,
      solar_system_name:  loc.solar_system_name  || null,
      constellation_id:   loc.constellation_id   || null,
      constellation_name: loc.constellation_name || null,
      region_id:          loc.region_id          || null,
      region_name:        loc.region_name        || null,
      security_status:    typeof loc.security_status === 'number' ? loc.security_status : null,
      owner_id:           loc.owner_id           || null,
      owner_name:         loc.owner_name         || null,
    };
  });

  const db = loadDB();
  db.assets = db.assets || {};
  db.assets[characterId] = { updatedAt: Date.now(), items: assets };
  saveDB(db);
  return { count: assets.length, items: assets };
}

ipcMain.handle('sync-assets', async (_, characterId) => {
  return syncAssetsInternal(characterId);
});

ipcMain.handle('sync-all-assets', async () => {
  // Check cache first to avoid re-syncing too often
  try {
    const cached = readCache('sync_all_assets');
    if (cached && cached.updatedAt && (Date.now() - cached.updatedAt) < (1000 * 60 * 60 * 6)) { // 6 hours
      return cached.result;
    }
  } catch (e) {
    // ignore cache errors
  }

  const db = loadDB();
  const accounts = Object.values(db.accounts || {});
  const result = { total: 0, characters: [] };

  // Limit concurrency to avoid hammering ESI
  const CONCURRENCY = 4;
  async function workerPool(list, fn) {
    const results = [];
    let i = 0;
    async function worker() {
      while (i < list.length) {
        const idx = i++;
        try {
          results[idx] = await fn(list[idx]);
        } catch (err) {
          results[idx] = { error: err.message };
        }
      }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  const syncResults = await workerPool(accounts, async (account) => {
    try {
      const r = await syncAssetsInternal(account.characterId);
      return { characterId: account.characterId, characterName: account.characterName, count: r.count };
    } catch (err) {
      return { characterId: account.characterId, characterName: account.characterName, error: err.message };
    }
  });

  for (const s of syncResults) {
    if (s.count) result.total += s.count;
    result.characters.push(s);
  }

  // Cache the overall result for faster subsequent calls
  try { writeCache('sync_all_assets', { updatedAt: Date.now(), result }, 0.25); } catch (e) {}

  return result;
});

ipcMain.handle('watch-ping-file', async (_, filePath) => {
  try {
    if (pingFileWatcher) {
      pingFileWatcher.close();
      pingFileWatcher = null;
    }
    if (pingFileWatchTimer) {
      clearTimeout(pingFileWatchTimer);
      pingFileWatchTimer = null;
    }
    pingFileWatcher = fs.watch(filePath, { encoding: 'utf8' }, () => {
      if (pingFileWatchTimer) clearTimeout(pingFileWatchTimer);
      pingFileWatchTimer = setTimeout(async () => {
        try {
          const contents = fs.readFileSync(filePath, 'utf8');
          BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('ping-file-updated', contents, filePath);
          });
        } catch (e) {
          console.warn('Failed to read watched ping file:', e.message);
        }
      }, 250);
    });
    return true;
  } catch (e) {
    console.warn('Failed to watch ping file:', e.message);
    return false;
  }
});

ipcMain.handle('unwatch-ping-file', () => {
  if (pingFileWatcher) {
    pingFileWatcher.close();
    pingFileWatcher = null;
  }
  if (pingFileWatchTimer) {
    clearTimeout(pingFileWatchTimer);
    pingFileWatchTimer = null;
  }
  return true;
});

let jabberClient = null;
let jabberConnectionActive = false;

function broadcastToRenderers(channel, payload) {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  });
}

ipcMain.handle('jabber-connect', async (_, { service, jid, password }) => {
  try {
    if (!service || !jid || !password) {
      return { success: false, message: 'Service, JID, and password are required.' };
    }
    const [username, domain] = jid.split('@');
    if (!username || !domain) {
      return { success: false, message: 'Invalid JID format. Use user@domain.' };
    }

    if (jabberClient) {
      try { await jabberClient.stop(); } catch (_) {}
      jabberClient = null;
      jabberConnectionActive = false;
    }

    const { client: xmppClient } = await getXmppClient();
    jabberClient = xmppClient({ service, domain, username, password });

    jabberClient.on('error', (err) => {
      broadcastToRenderers('jabber-status', { status: 'error', message: err?.message || String(err) });
    });

    jabberClient.on('offline', () => {
      jabberConnectionActive = false;
      broadcastToRenderers('jabber-status', { status: 'offline', message: 'Disconnected' });
    });

    jabberClient.on('online', (address) => {
      jabberConnectionActive = true;
      broadcastToRenderers('jabber-status', { status: 'online', message: `Connected as ${address.toString()}` });
    });

    jabberClient.on('stanza', (stanza) => {
      if (!stanza.is('message')) return;
      const body = stanza.getChildText('body');
      if (!body) return;
      const from = stanza.attrs.from || '';
      const type = stanza.attrs.type || 'chat';
      const isDirector = /director/i.test(from) || /director/i.test(body);
      broadcastToRenderers('jabber-message', { from, type, body, isDirector, raw: stanza.toString() });
    });

    await jabberClient.start();
    return { success: true, message: 'Connecting...' };
  } catch (err) {
    console.warn('Jabber connect failed:', err.message || err);
    return { success: false, message: err.message || String(err) };
  }
});

ipcMain.handle('jabber-disconnect', async () => {
  if (jabberClient) {
    try { await jabberClient.stop(); } catch (_) {}
    jabberClient = null;
    jabberConnectionActive = false;
  }
  return true;
});

ipcMain.handle('get-assets', (_, characterId) => {
  const db = loadDB();
  return db.assets?.[characterId] || null;
});

ipcMain.handle('get-all-assets', () => {
  const db = loadDB();
  const all = [];
  for (const [charId, data] of Object.entries(db.assets || {})) {
    const account = db.accounts[charId];
    if (data && data.items) {
      data.items.forEach(asset => all.push({
        ...asset,
        characterId: charId,
        characterName: account?.characterName || 'Unknown',
      }));
    }
  }
  return all;
});

// ─── IPC: Wallet Balance ──────────────────────────────────────────────────────
ipcMain.handle('get-wallet', async (_, characterId) => {
  try {
    const token = await getValidToken(characterId);
    const url = `${ESI_BASE}/v1/characters/${characterId}/wallet/?datasource=tranquility`;
    
    // The wallet endpoint returns a flat number representing the ISK balance
    const walletBalance = await httpGet(url, { Authorization: `Bearer ${token}` });
    return typeof walletBalance === 'number' ? walletBalance : 0;
  } catch (e) {
    console.warn(`Failed to fetch wallet for ${characterId}:`, e.message || e);
    return 0;
  }
});

// ─── IPC: Public ESI (no auth) ────────────────────────────────────────────────
// IPC: resolve a single location (structure or station) -> full metadata
// Used by dashboard for home station and blueprints for location names.
// All three should use getLocator(), not bare locator
ipcMain.handle('get-structure-info', async (_, structureId, characterId) => {
  return getLocator().resolveLocation(structureId, characterId);
});

ipcMain.handle('resolve-location', async (_, locationId, characterId) => {
  return getLocator().resolveLocation(locationId, characterId);
});

ipcMain.handle('resolve-system-names', async (_, systemIds) => {
  return getLocator().resolveSystemNames(systemIds);
});

ipcMain.handle('esi-search', async (_, query) => {
  return httpGet(`${ESI_BASE}/v2/search/?categories=inventory_type&search=${encodeURIComponent(query)}&strict=false&datasource=tranquility`);
});

ipcMain.handle('esi-names', async (_, ids) => {
  if (!ids || !ids.length) return [];
  const map = await resolveNames(ids);
  return ids.map(id => ({ id, name: map[id] || `Type ${id}` }));
});


// ─── IPC: Public ESI proxy ────────────────────────────────────────────────────
ipcMain.handle('esi-fetch', async (_, url) => {
  return httpGet(url);
});

// ─── IPC: Global market prices (adjusted_price / average_price) ──────────────
// Single public endpoint — no auth. Returns all tradeable items at once.
// This is the same price source EVE uses for net worth calculations.
// Cache aggressively: prices update ~daily.
ipcMain.handle('get-market-prices', async () => {
  const cacheKey = 'market_prices_global';
  const cached = readCache(cacheKey);
  if (cached) return cached;
  try {
    const data = await httpGet(`${ESI_BASE}/v1/markets/prices/?datasource=tranquility`);
    // Convert array to map keyed by type_id for O(1) lookup
    const map = {};
    if (Array.isArray(data)) {
      data.forEach(item => {
        map[item.type_id] = {
          adjusted: item.adjusted_price || 0,
          average:  item.average_price  || 0,
        };
      });
    }
    writeCache(cacheKey, map, 0.5); // cache 12 hours
    return map;
  } catch (e) {
    console.warn('get-market-prices failed:', e.message);
    return {};
  }
});

// ─── IPC: Authenticated character sheet ──────────────────────────────────────
ipcMain.handle('get-character-info', async (_, characterId) => {
  try {
    const token = await getValidToken(characterId);
    return await httpGet(
      `${ESI_BASE}/v5/characters/${characterId}/?datasource=tranquility`,
      { Authorization: `Bearer ${token}` }
    );
  } catch (e) {
    console.warn(`get-character-info failed for ${characterId}:`, e.message);
    return null;
  }
});

// ─── IPC: Clones / home location ─────────────────────────────────────────────
ipcMain.handle('get-clones', async (_, characterId) => {
  try {
    const token = await getValidToken(characterId);
    return await httpGet(
      `${ESI_BASE}/v3/characters/${characterId}/clones/?datasource=tranquility`,
      { Authorization: `Bearer ${token}` }
    );
  } catch (e) {
    console.warn(`get-clones failed for ${characterId}:`, e.message);
    return null;
  }
});

// ─── IPC: Character market orders (for escrow) ───────────────────────────────
// Returns active buy orders — their 'escrow' field is ISK locked up.
ipcMain.handle('get-character-orders', async (_, characterId) => {
  try {
    const token = await getValidToken(characterId);
    const orders = await httpGet(
      `${ESI_BASE}/v2/characters/${characterId}/orders/?datasource=tranquility`,
      { Authorization: `Bearer ${token}` }
    );
    return Array.isArray(orders) ? orders : [];
  } catch (e) {
    console.warn(`get-character-orders failed for ${characterId}:`, e.message);
    return [];
  }
});

// ─── IPC: Character contracts (for escrow) ───────────────────────────────────
// Returns all contracts; we sum 'price' on outstanding buyer contracts.
ipcMain.handle('get-character-contracts', async (_, characterId) => {
  try {
    const token = await getValidToken(characterId);
    const contracts = await httpGet(
      `${ESI_BASE}/v1/characters/${characterId}/contracts/?datasource=tranquility`,
      { Authorization: `Bearer ${token}` }
    );
    return Array.isArray(contracts) ? contracts : [];
  } catch (e) {
    console.warn(`get-character-contracts failed for ${characterId}:`, e.message);
    return [];
  }
});

ipcMain.handle('cache-get', (_, key) => {
  return readCache(key);
});

ipcMain.handle('cache-set', (_, key, value, days = 7) => {
  writeCache(key, value, days);
  return true;
});

ipcMain.handle('ui-get-config', () => {
  const cfg = loadConfig();
  return cfg.uiTheme || null;
});

ipcMain.handle('ui-save-config', (_, uiTheme) => {
  const cfg = loadConfig();
  cfg.uiTheme = uiTheme || {};
  saveConfig(cfg);
  return true;
});

ipcMain.handle('app-get-config', () => {
  const cfg = loadConfig();
  return cfg || {};
});

ipcMain.handle('app-save-config', (_, appConfig) => {
  const cfg = loadConfig();
  cfg.app = cfg.app || {};
  cfg.app = { ...cfg.app, ...appConfig };
  saveConfig(cfg);
  return true;
});

ipcMain.handle('get-blueprint-materials', async (_, typeId) => {
  if (bpCache[typeId]) return bpCache[typeId];
  try {
    const data = await httpGet(`${FUZZWORK_BASE}/api/blueprint.php?typeid=${typeId}&runs=1&me=0&pe=0`);
    bpCache[typeId] = data;
    return data;
  } catch (err) {
    console.warn(`Blueprint ${typeId} not found in Fuzzwork, returning empty materials:`, err.message);
    // Return empty materials object so app can handle gracefully
    const emptyData = { materials: [], blueprintTypeID: typeId };
    bpCache[typeId] = emptyData;
    return emptyData;
  }
});

ipcMain.handle('find-bp-for-product', async (_, productTypeId) => {
  const key = `prod_${productTypeId}`;
  if (bpCache[key]) return bpCache[key];
  try {
    const data = await httpGet(`${FUZZWORK_BASE}/api/blueprint.php?producttypeid=${productTypeId}&runs=1&me=0&pe=0`);
    bpCache[key] = data;
    return data;
  } catch (err) {
    console.warn(`No blueprint found for product ${productTypeId}:`, err.message);
    // Return null so app knows no blueprint exists
    return null;
  }
});

ipcMain.handle('get-product-for-blueprint', async (_, blueprintTypeId) => {
  // Query SDE to find what this blueprint produces
  if (!sdeDb) return null;
  try {
    const result = await sdeDb.get('SELECT productTypeID FROM invBlueprintTypes WHERE blueprintTypeID = ?', blueprintTypeId);
    if (result && result.productTypeID) {
      console.log(`Blueprint ${blueprintTypeId} produces type ${result.productTypeID}`);
      return result.productTypeID;
    }
    return null;
  } catch (err) {
    console.warn(`Failed to look up product for blueprint ${blueprintTypeId}:`, err.message);
    return null;
  }
});

// ─── Jita Market Prices (Jita 4-4 is station 60003760) ──────────────────────
ipcMain.handle('get-jita-prices', async (_, typeIds) => {
  const JITA_STATION_ID = 60003760; // Jita IV - Moon 4 (Caldari Navy Assembly Plant)
  const prices = {};
  
  try {
    // Get market orders for each type - batch requests efficiently
    for (const typeId of typeIds) {
      const cacheKey = `jita_price_${typeId}`;
      const cached = readCache(cacheKey);
      
      if (cached) {
        prices[typeId] = cached;
        continue;
      }
      
      try {
        // Fetch orders for this type in The Forge region and filter for Jita station
        // The Forge region id is 10000002; Jita station id is used to pick station-specific orders
        const REGION_FORGE = 10000002;
        let orderData = [];
        try {
          orderData = await httpGet(
            `${ESI_BASE}/v1/markets/${REGION_FORGE}/orders/?datasource=tranquility&type_id=${typeId}&order_type=all`
          );
        } catch (e) {
          // If region endpoint fails, fall back to empty
          orderData = [];
        }

        // Filter for orders at Jita station if present
        orderData = Array.isArray(orderData) ? orderData.filter(o => Number(o.location_id) === JITA_STATION_ID) : [];

        if (!orderData || orderData.length === 0) {
          prices[typeId] = { buy: 0, sell: 0 };
          writeCache(cacheKey, { buy: 0, sell: 0 }, 1); // Cache misses for 1 day
          continue;
        }

        // Separate buy and sell orders
        const buyOrders = orderData.filter(o => o.is_buy_order);
        const sellOrders = orderData.filter(o => !o.is_buy_order);
        
        // Get best (highest) buy price and best (lowest) sell price
        const bestBuyPrice = buyOrders.length > 0
          ? Math.max(...buyOrders.map(o => o.price))
          : 0;
        
        const bestSellPrice = sellOrders.length > 0
          ? Math.min(...sellOrders.map(o => o.price))
          : 0;
        
        const priceData = { buy: bestBuyPrice, sell: bestSellPrice };
        prices[typeId] = priceData;
        
        // Cache prices for 6 hours
        writeCache(cacheKey, priceData, 0.25);
      } catch (e) {
        console.log(`Failed to fetch Jita price for ${typeId}:`, e.message);
        prices[typeId] = { buy: 0, sell: 0 };
      }
    }
  } catch (e) {
    console.error('Market price lookup error:', e);
  }
  
  return prices;
});

// ─── Name resolver (batched) ─────────────────────────────────────────────────
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

// IPC: SDE name lookup (best-effort fallback to a local SDE sqlite file)
ipcMain.handle('sde-get-name', async (_, typeId) => {
  if (!sdeDb) return null;
  const tries = [
    { t: 'invTypes', col: 'typeName', idcol: 'typeID' },
    { t: 'invtypes', col: 'typeName', idcol: 'typeID' },
    { t: 'invTypes_en', col: 'typeName', idcol: 'typeID' },
    { t: 'types', col: 'name', idcol: 'id' }
  ];
  for (const q of tries) {
    try {
      const row = await sdeDb.get(`SELECT ${q.col} as name FROM ${q.t} WHERE ${q.idcol} = ?`, typeId);
      if (row && row.name) return row.name;
    } catch (e) { /* ignore */ }
  }
  return null;
});

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.on('window-all-closed', () => {
  if (callbackServer) callbackServer.close();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});