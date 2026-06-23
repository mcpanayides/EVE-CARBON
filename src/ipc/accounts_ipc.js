const { ipcMain, BrowserWindow, shell } = require('electron');
const crypto = require('crypto');

// ─── SSO constants (duplicated from main for module self-containment) ─────────
const SSO_AUTH_URL  = 'https://login.eveonline.com/v2/oauth/authorize/';
const SSO_TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';
const CALLBACK_PORT = 12500;
const CALLBACK_URL  = 'http://127.0.0.1:12500/auth/callback/';
const CLIENT_ID     = process.env.EVE_CLIENT_ID;

const SCOPES = [
  'esi-characters.read_blueprints.v1',
  'esi-assets.read_assets.v1',
  'esi-corporations.read_blueprints.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-industry.read_corporation_jobs.v1',
  'esi-wallet.read_character_wallet.v1',
  'esi-clones.read_clones.v1',
  'esi-clones.read_implants.v1',
  'esi-skills.read_skills.v1',
  'esi-markets.read_character_orders.v1',
  'esi-contracts.read_character_contracts.v1',
  'esi-location.read_location.v1',
  'esi-location.read_ship_type.v1',
  'esi-universe.read_structures.v1',            // resolve player-owned structure (Citadel/Keepstar) names where the char has docking access
  'esi-planets.manage_planets.v1',
  'esi-characters.read_loyalty.v1',
  'esi-characters.read_standings.v1',
  'esi-alliances.read_contacts.v1',             // alliance-set standings (blue/red) for jump routing
  'esi-skills.read_skillqueue.v1',
  'esi-fleets.read_fleet.v1',
  'esi-ui.write_waypoint.v1',
  'esi-ui.open_window.v1',
].join(' ');

// ─── PKCE helpers ─────────────────────────────────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── SSO state store (per login attempt) ─────────────────────────────────────
// Keyed by PKCE state string; each entry holds { codeVerifier, win }
const pendingAuth = {};

/**
 * registerAccountHandlers
 *
 * @param {object} deps
 * @param {function} deps.loadDB              - loads the JSON database
 * @param {function} deps.saveDB              - persists the JSON database
 * @param {object}   deps.charInfoDb          - character SQLite helper module
 * @param {function} deps.httpPost            - authenticated HTTP POST helper
 * @param {function} deps.fullCharacterSync   - runs a full ESI sync for a character
 * @param {object}   deps.callbackServerState - { server, start } — shared server ref
 */
function registerAccountHandlers({
  ipcHandle,
  loadDB,
  saveDB,
  charInfoDb,
  httpPost,
  fullCharacterSync,
  callbackServerState,
}) {

  // ─── IPC: Get accounts ──────────────────────────────────────────────────────
  ipcHandle('get-accounts', () => {
    const db = loadDB();
    return Object.values(db.accounts).map(a => ({
      characterId:   a.characterId,
      characterName: a.characterName,
      addedAt:       a.addedAt,
    }));
  });

  // ─── IPC: Remove account ────────────────────────────────────────────────────
  ipcHandle('remove-account', async (_, characterId) => {
    const db = loadDB();
    delete db.accounts[characterId];
    delete db.blueprints[characterId];
    delete db.assets[characterId];
    saveDB(db);
    // Also wipe character tables from character_information.db
    try { await charInfoDb.removeCharacterData(characterId); } catch (e) { /* ignore */ }
    return true;
  });

  // ─── IPC: Start SSO login ───────────────────────────────────────────────────
  ipcHandle('start-sso-login', (event) => {
    // Ensure the local OAuth callback server is running
    callbackServerState.start();

    const codeVerifier  = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state         = crypto.randomBytes(16).toString('hex');

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

    shell.openExternal(`${SSO_AUTH_URL}?${params.toString()}`);
    return { ok: true };
  });

  // ─── Callback server (OAuth redirect handler) ───────────────────────────────
  // Exposed on callbackServerState so main.js can also close it on quit.
  const http = require('http');
  const SSO_VERIFY_URL = 'https://login.eveonline.com/oauth/verify';

  function startCallbackServer() {
    if (callbackServerState.server) return;

    callbackServerState.server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/auth/callback' && url.pathname !== '/auth/callback/') {
        res.end();
        return;
      }

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
        // Exchange code for tokens via PKCE (no client secret needed)
        const formBody = new URLSearchParams({
          grant_type:    'authorization_code',
          code,
          client_id:     CLIENT_ID,
          redirect_uri:  CALLBACK_URL,
          code_verifier: codeVerifier,
        }).toString();

        const tokenData = await httpPost(SSO_TOKEN_URL, formBody, {}, true);

        // Verify the token to retrieve character identity
        const { default: https } = await import('https');
        const charInfo = await new Promise((resolve, reject) => {
          const r = https.request(
            SSO_VERIFY_URL,
            { headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'EVE-BPC-Calculator/2.0', Accept: 'application/json' } },
            (res2) => {
              let d = '';
              res2.on('data', c => d += c);
              res2.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse')); } });
            }
          );
          r.on('error', reject);
          r.end();
        });

        const characterId   = charInfo.CharacterID;
        const characterName = charInfo.CharacterName;

        // Persist new account
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

        // Auto full-sync in background — don't block the HTTP response
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

    callbackServerState.server.listen(CALLBACK_PORT, '127.0.0.1');
  }

  // Attach start fn to the shared state object so main.js can call it
  callbackServerState.start = startCallbackServer;
}

module.exports = { registerAccountHandlers };