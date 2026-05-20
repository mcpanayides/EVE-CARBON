require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────
const SSO_AUTH_URL   = 'https://login.eveonline.com/v2/oauth/authorize/';
const SSO_TOKEN_URL  = 'https://login.eveonline.com/v2/oauth/token';
const SSO_VERIFY_URL = 'https://login.eveonline.com/oauth/verify';
const ESI_BASE       = 'https://esi.evetech.net';
const FUZZWORK_BASE  = 'https://www.fuzzwork.co.uk';
const CALLBACK_PORT  = 12500;
// Must match EXACTLY what is registered in the EVE developer portal
const CALLBACK_URL   = 'http://127.0.0.1:12500/auth/callback/';
const CLIENT_ID      = process.env.EVE_CLIENT_ID;
const CLIENT_SECRET  = process.env.EVE_CLIENT_SECRET;
const SCOPES         = [
 'esi-characters.read_blueprints.v1',
  'esi-assets.read_assets.v1',
  'esi-corporations.read_blueprints.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-industry.read_corporation_jobs.v1'
].join(' ');

// ─── Paths ────────────────────────────────────────────────────────────────────
const userDataPath = app.getPath('userData');
const dbPath       = path.join(userDataPath, 'blueprints.json');
const configPath   = path.join(userDataPath, 'config.json');

// ─── Simple JSON "database" s
function loadDB() {
  try { return JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch { return { accounts: {}, blueprints: {} }; }
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

ipcMain.handle('remove-account', (_, characterId) => {
  const db = loadDB();
  delete db.accounts[characterId];
  delete db.blueprints[characterId];
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

// ─── IPC: Public ESI (no auth) ────────────────────────────────────────────────
ipcMain.handle('esi-search', async (_, query) => {
  return httpGet(`${ESI_BASE}/v2/search/?categories=inventory_type&search=${encodeURIComponent(query)}&strict=false&datasource=tranquility`);
});

ipcMain.handle('esi-names', async (_, ids) => {
  if (!ids || !ids.length) return [];
  const map = await resolveNames(ids);
  return ids.map(id => ({ id, name: map[id] || `Type ${id}` }));
});

ipcMain.handle('get-blueprint-materials', async (_, typeId) => {
  if (bpCache[typeId]) return bpCache[typeId];
  const data = await httpGet(`${FUZZWORK_BASE}/api/blueprint.php?typeid=${typeId}&runs=1&me=0&pe=0`);
  bpCache[typeId] = data;
  return data;
});

ipcMain.handle('find-bp-for-product', async (_, productTypeId) => {
  const key = `prod_${productTypeId}`;
  if (bpCache[key]) return bpCache[key];
  try {
    const data = await httpGet(`${FUZZWORK_BASE}/api/blueprint.php?producttypeid=${productTypeId}&runs=1&me=0&pe=0`);
    bpCache[key] = data;
    return data;
  } catch { return null; }
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

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
});
app.on('window-all-closed', () => {
  if (callbackServer) callbackServer.close();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
