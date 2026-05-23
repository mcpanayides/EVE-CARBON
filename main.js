require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

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
  'esi-clones.read_clones.v1',           // ← home location (medical clone location)
  'esi-skills.read_skills.v1',            // ← total skill points
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
let userDataPath, dbPath, configPath, cacheDir;
let pingFileWatcher = null;
let pingFileWatchTimer = null;

function initPaths() {
  userDataPath = app.getPath('userData');
  dbPath = path.join(userDataPath, 'blueprints.json');
  configPath = path.join(userDataPath, 'config.json');
  cacheDir = path.join(userDataPath, 'cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) { /* ignore */ }
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

app.whenReady().then(async () => {
  initPaths();
  await initSde();
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
  try {
    const token = await getValidToken(characterId);
    const url = `${ESI_BASE}/latest/characters/${characterId}/industry/jobs/?datasource=tranquility&status=completed`;
    const jobs = await httpGet(url, { Authorization: `Bearer ${token}` });
    if (!Array.isArray(jobs)) return [];
    const systemIds = [...new Set(jobs.filter(j => j.solar_system_id).map(j => j.solar_system_id))];
    const nameMap = systemIds.length ? await resolveNames(systemIds) : {};
    return jobs.map(job => ({
      ...job,
      solar_system_name: nameMap[job.solar_system_id] || (job.solar_system_id ? `System ${job.solar_system_id}` : 'Unknown'),
    }));
  } catch (e) {
    console.warn('Failed to load character jobs:', e.message || e);
    return [];
  }
});

ipcMain.handle('remove-account', (_, characterId) => {
  const db = loadDB();
  delete db.accounts[characterId];
  delete db.blueprints[characterId];
  delete db.assets[characterId];
  saveDB(db);
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

  const typeIds = [...new Set(allAssets.map(a => a.type_id).filter(Boolean))];
  const locationIds = [...new Set(allAssets.map(a => a.location_id).filter(Boolean))];
  const nameMap = await resolveNames([...new Set([...typeIds, ...locationIds])]);

  // Resolve additional metadata for locations: system, constellation, region, sec status, owner
  const locationMeta = {};
  for (const locId of locationIds) {
    const cacheKey = `loc_meta_${locId}`;
    let meta = readCache(cacheKey);
    if (!meta) {
      meta = { system_id: null, constellation_id: null, region_id: null, security_status: null, owner_id: null };
      try {
        // Try station endpoint
        try {
          const st = await httpGet(`${ESI_BASE}/v1/universe/stations/${locId}/?datasource=tranquility`);
          if (st && (st.system_id || st.solar_system_id)) {
            meta.system_id = st.system_id || st.solar_system_id || null;
          }
        } catch (e) { /* ignore */ }

        // If no system yet, try structure endpoint
        if (!meta.system_id) {
          try {
            const struct = await httpGet(`${ESI_BASE}/v1/universe/structures/${locId}/?datasource=tranquility`);
            if (struct && struct.solar_system_id) {
              meta.system_id = struct.solar_system_id;
              if (struct.owner_id) meta.owner_id = struct.owner_id;
            }
          } catch (e) { /* ignore */ }
        }

        // If still no system, maybe the location is a system id itself
        if (!meta.system_id) {
          try {
            const sysTest = await httpGet(`${ESI_BASE}/v4/universe/systems/${locId}/?datasource=tranquility`);
            if (sysTest) {
              meta.system_id = locId;
            }
          } catch (e) { /* ignore */ }
        }

        // If we have a system_id, fetch system details
        if (meta.system_id) {
          try {
            const sys = await httpGet(`${ESI_BASE}/v4/universe/systems/${meta.system_id}/?datasource=tranquility`);
            if (sys) {
              meta.constellation_id = sys.constellation_id || null;
              meta.security_status = sys.security_status || null;
            }
          } catch (e) { /* ignore */ }
        }

        // If we have a constellation, fetch region
        if (meta.constellation_id) {
          try {
            const con = await httpGet(`${ESI_BASE}/v1/universe/constellations/${meta.constellation_id}/?datasource=tranquility`);
            if (con) meta.region_id = con.region_id || null;
          } catch (e) { /* ignore */ }
        }

        // Cache meta for a day
        try { writeCache(cacheKey, meta, 1); } catch (e) { /* ignore */ }
      } catch (e) {
        meta = meta || { system_id: null, constellation_id: null, region_id: null, security_status: null, owner_id: null };
      }
    }
    locationMeta[locId] = meta;
  }

  // Pre-resolve names for constellation, region, owners
  const extraIds = [];
  Object.values(locationMeta).forEach(m => {
    if (m.constellation_id) extraIds.push(m.constellation_id);
    if (m.region_id) extraIds.push(m.region_id);
    if (m.owner_id) extraIds.push(m.owner_id);
  });
  const extraNameMap = extraIds.length ? await resolveNames([...new Set(extraIds)]) : {};

  const assets = allAssets.map(asset => {
    const locMeta = locationMeta[asset.location_id] || {};
    const ownerName = locMeta.owner_id ? (extraNameMap[locMeta.owner_id] || null) : null;
    const constellationName = locMeta.constellation_id ? (extraNameMap[locMeta.constellation_id] || null) : null;
    const regionName = locMeta.region_id ? (extraNameMap[locMeta.region_id] || null) : null;

    return {
      item_id: asset.item_id,
      type_id: asset.type_id,
      name: nameMap[asset.type_id] || `Type ${asset.type_id}`,
      location_id: asset.location_id,
      location_name: nameMap[asset.location_id] || `Location ${asset.location_id}`,
      quantity: asset.quantity,
      volume: asset.volume || 0,
      is_singleton: asset.is_singleton,
      location_flag: asset.location_flag || asset.flag || '',
      system_id: locMeta.system_id || null,
      constellation_id: locMeta.constellation_id || null,
      constellation_name: constellationName,
      region_id: locMeta.region_id || null,
      region_name: regionName,
      security_status: typeof locMeta.security_status === 'number' ? locMeta.security_status : null,
      owner_id: locMeta.owner_id || null,
      owner_name: ownerName || null,
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
ipcMain.handle('esi-search', async (_, query) => {
  return httpGet(`${ESI_BASE}/v2/search/?categories=inventory_type&search=${encodeURIComponent(query)}&strict=false&datasource=tranquility`);
});

ipcMain.handle('esi-names', async (_, ids) => {
  if (!ids || !ids.length) return [];
  const map = await resolveNames(ids);
  return ids.map(id => ({ id, name: map[id] || `Type ${id}` }));
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