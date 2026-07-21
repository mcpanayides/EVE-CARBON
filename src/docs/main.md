# `main.js` — Function & IPC Handler Reference

This is the Electron **main process** file. It owns all privileged operations: OAuth/SSO login, token management, ESI API calls, SQLite access, file system I/O, and the IPC bridge that the renderer (UI) uses via `window.eveAPI.*`.

---

## Module-Level Constants & State

| Name | Purpose |
|---|---|
| `SSO_AUTH_URL / SSO_TOKEN_URL / SSO_VERIFY_URL` | EVE Online OAuth 2.0 endpoints |
| `ESI_BASE` | Base URL for all ESI REST calls (`https://esi.evetech.net`) |
| `FUZZWORK_BASE` | Base URL for Fuzzwork blueprint API |
| `CALLBACK_PORT / CALLBACK_URL` | Local HTTP server that receives the OAuth redirect (`127.0.0.1:12500`) |
| `CLIENT_ID` | Loaded from `.env` via `dotenv` (public identifier — no client secret is used; auth is PKCE-only) |
| `SCOPES` | Full list of ESI OAuth scopes requested at login |
| `pendingAuth` | In-memory map of `state → { codeVerifier, win }` for PKCE login flow |
| `nameCache` | In-memory cache for resolved entity names and implant slot lookups |
| `bpCache` | In-memory cache for Fuzzwork blueprint data |
| `callbackServer` | Reference to the local HTTP server used for OAuth callbacks |
| `sdeDb` | SQLite handle for the local SDE (Static Data Export) database |
| `locator` | Singleton instance of the shared location resolver (`./src/locator`) |
| `jabberClient` | XMPP client instance for Jabber/EVE comms integration |
| `pingFileWatcher / pingFileWatchTimer` | `fs.watch` handle + debounce timer for the ping-file feature |

---

## Startup & Initialisation

---

### `globalThis.crypto.randomUUID` polyfill *(top-level)*

**Purpose:** Ensures `crypto.randomUUID()` is available on older Node.js versions. Falls back to manually constructing a v4 UUID from `crypto.randomBytes(16)` with the correct variant/version bits set.

**Connects to:** Node.js `crypto` module.

---

### `getXmppClient()`

**Purpose:** Lazy-loads the `@xmpp/client` ESM package on first call and caches the import. ESM modules cannot be `require()`'d, so this async import is done on demand.

**Connects to:** `@xmpp/client` npm package.

---

### `getSdePath()`

**Purpose:** Returns the correct filesystem path to `sde.sql` depending on whether the app is running in development (`__dirname/data/`) or as a packaged Electron build (`process.resourcesPath/data/`).

---

### `initSde()`

**Purpose:** Opens the local SDE SQLite database in read-only mode and assigns it to `sdeDb`. If the file doesn't exist or fails to open, `sdeDb` is left as `null` and SDE-dependent features gracefully degrade.

**Connects to:** `sqlite` / `sqlite3` (Node packages), `getSdePath()`.

---

### `initPaths()`

**Purpose:** Sets all global path variables (`userDataPath`, `dbPath`, `configPath`, `cacheDir`, `appDataDir`) using Electron's `app.getPath('userData')`. Creates the `cache/` and `data/` directories if they don't exist.

**Connects to:** Electron `app`, Node.js `fs`, `path`.

---

### `app.whenReady()` handler *(top-level)*

**Purpose:** Main startup sequence. Runs `initPaths()`, `initSde()`, initialises the character SQLite DB (`charInfoDb.initCharacterDb`), then calls `createWindow()`.

**Connects to:** `initPaths()`, `initSde()`, `charInfoDb.initCharacterDb()`, `createWindow()`.

---

## File System & Persistence

---

### `loadDB()` / `saveDB(db)`

**Purpose:** Reads and writes `blueprints.json` — a simple JSON file that stores accounts (tokens), blueprints, and assets. `loadDB` returns a default structure if the file is missing or unparseable.

**Connects to:** Node.js `fs`, `dbPath`.

---

### `loadConfig()` / `saveConfig(cfg)`

**Purpose:** Reads and writes `config.json` — stores UI theme and app-level settings. Returns an empty object on failure.

**Connects to:** Node.js `fs`, `configPath`.

---

### `getCachePath(key)`

**Purpose:** Converts a cache key to a safe filename (strips non-alphanumeric characters) and returns the full path inside `cacheDir`.

---

### `readCache(key)`

**Purpose:** Reads a JSON cache file from disk, checks the `ts` + `ttl` fields, and returns the stored value `v` if still fresh. Deletes expired files and returns `null` on miss or expiry.

**Connects to:** `getCachePath()`, Node.js `fs`.

---

### `writeCache(key, value, days)`

**Purpose:** Serialises a value to a JSON cache file with a `ts` (timestamp) and `ttl` (days × ms). Default TTL is 7 days.

**Connects to:** `getCachePath()`, Node.js `fs`.

---

### `getLocator()`

**Purpose:** Singleton factory for the location resolver. Creates the locator on first call, wiring it up with `httpGet`, `readCache`, `writeCache`, `getValidToken`, and the `charInfoDb` station helpers so it can check local DB tables before hitting any external network source.

**Connects to:** `./src/locator`, `httpGet()`, `readCache()`, `writeCache()`, `getValidToken()`, `charInfoDb.getStationById/upsertNpcStations/upsertUpwellStructures`.

---

## HTTP Helpers

---

### `httpGet(url, headers)`

**Purpose:** Makes an authenticated or unauthenticated HTTPS GET request. Sets a standard `User-Agent`, parses JSON response, and throws a typed error on HTTP 429 (with `retryAfter` and `isRateLimit` properties so callers can back off correctly). Times out after 20 seconds.

**Connects to:** Node.js `https`.

---

### `httpPost(url, body, headers, formEncoded)`

**Purpose:** Makes an HTTPS POST request. Supports both JSON (`Content-Type: application/json`) and form-encoded (`application/x-www-form-urlencoded`) bodies. Used for token exchange and ESI bulk-name resolution. Times out after 20 seconds.

**Connects to:** Node.js `https`.

---

## Authentication (PKCE / SSO)

---

### `generateCodeVerifier()`

**Purpose:** Generates a cryptographically random 32-byte PKCE code verifier, base64url-encoded.

**Connects to:** Node.js `crypto`.

---

### `generateCodeChallenge(verifier)`

**Purpose:** Derives the PKCE code challenge from the verifier using SHA-256 + base64url encoding.

**Connects to:** Node.js `crypto`.

---

### `startCallbackServer()`

**Purpose:** Starts a local HTTP server on port 12500 to receive the OAuth redirect from EVE's SSO. On a valid callback it:

1. Exchanges the auth code for tokens via `httpPost` to `SSO_TOKEN_URL` (PKCE flow — no client secret needed)
2. Verifies the token with `SSO_VERIFY_URL` to get character name/ID
3. Saves the account (including tokens) to `blueprints.json`
4. Notifies the renderer via `win.webContents.send('account-added', …)`
5. Kicks off `fullCharacterSync()` in the background via `setImmediate`
6. Sends progress events (`char-sync-progress`) to the renderer during sync

Returns styled HTML success/error pages to the browser tab.

**Connects to:** `httpPost()`, `httpGet()`, `loadDB()`, `saveDB()`, `fullCharacterSync()`, `pendingAuth`, Node.js `http`.

---

### `getValidToken(characterId)`

**Purpose:** Returns a valid access token for a character. If the stored token expires within 60 seconds, it automatically refreshes it using the refresh token and updates `blueprints.json`. Throws if the account is not found. If the refresh fails with `invalid_grant` (dead refresh token — e.g. the app's `client_id` changed, or the user revoked access), sets `account.needsReauth = true` in `blueprints.json` and throws an error tagged `{ needsReauth: true }` instead of retrying forever. `get-accounts` surfaces this flag so the Characters page can prompt a re-login; it clears itself once the account re-authenticates (the SSO callback overwrites the account entry with fresh tokens).

**Connects to:** `loadDB()`, `saveDB()`, `httpPost()` → `SSO_TOKEN_URL`.

---

## Window

---

### `createWindow()`

**Purpose:** Creates the main `BrowserWindow` (1800×1200, hidden title bar, dark background). Loads `src/index.html` via `file://` protocol. Uses `src/preload.js` with `contextIsolation: true` for a secure renderer context. DevTools are opened automatically (development-time flag).

**Connects to:** Electron `BrowserWindow`, `src/preload.js`, `src/index.html`.

---

## Sync Functions

---

### `resolveNames(ids)`

**Purpose:** Batch-resolves a list of EVE entity IDs (characters, types, systems, corporations, etc.) to names. Checks `nameCache` first, then POSTs uncached IDs to `ESI /v3/universe/names/` in chunks of 1000. Caches results in `nameCache`.

**Connects to:** `httpPost()`, `nameCache`, ESI `/v3/universe/names/`.

---

### `resolveImplantSlots(typeIds)`

**Purpose:** For each implant type ID, fetches dogma attributes from `ESI /v3/universe/types/{id}/` and extracts attribute 331 ("implantness"), which holds the real slot number (1–10). Results are cached in `nameCache` under `implant_slot_{id}` keys so each type is only looked up once per session.

**Connects to:** `httpGet()`, `nameCache`, ESI `/v3/universe/types/`.

---

### `fullCharacterSync(characterId, characterName, progressCb)`

**Purpose:** Complete ESI data pull for a character — called on first SSO login and on manual re-sync. Runs 11 steps sequentially, each writing to `character_information.db` via `charInfoDb`. Progress is reported via the optional `progressCb` callback, which the IPC wrapper forwards as `char-sync-progress` events to the renderer.

**Steps (in order):**

| # | Step | ESI Endpoint | DB Write |
|---|---|---|---|
| 1 | Character sheet | `v5/characters/{id}/` | `charInfoDb.upsertCharacterInfo` |
| 2 | Wallet balance | `v1/characters/{id}/wallet/` | `charInfoDb.insertWalletSnapshot` |
| 3 | Current location | `v1/characters/{id}/location/` + locator | `charInfoDb.upsertLocation` |
| 4 | Current ship | `v1/characters/{id}/ship/` | `charInfoDb.upsertShip` |
| 5 | Implants & jump clones | `v3/characters/{id}/clones/` + `v1/.../implants/` | `charInfoDb.replaceImplants`, `replaceJumpClones` |
| 6 | PI colonies | `v1/characters/{id}/planets/` | `charInfoDb.replacePiColonies` |
| 7 | Assets (paginated) | `v3/characters/{id}/assets/` | `charInfoDb.replaceAssets` + unresolved-location retry pass |
| 8 | Blueprints (paginated) | `v3/characters/{id}/blueprints/` | `charInfoDb.replaceBlueprints` + `blueprints.json` |
| 9 | Wallet journal | `v6/characters/{id}/wallet/journal/` | `charInfoDb.replaceWalletJournal` |
| 10 | Wallet transactions | `v1/characters/{id}/wallet/transactions/` | `charInfoDb.replaceWalletTransactions` |
| 11 | Loyalty points | `v1/characters/{id}/loyalty/points/` | `charInfoDb.replaceLoyaltyPoints` |

**Connects to:** `charInfoDb.*`, `httpGet()`, `resolveNames()`, `resolveImplantSlots()`, `getLocator()`, `getValidToken()`, `loadDB()`, `saveDB()`.

---

### `coreCharacterSync(characterId, characterName, progressCb)`

**Purpose:** A lighter version of `fullCharacterSync` that skips assets (steps 7). Called by the 20-minute auto-refresh cadence so frequent syncs don't hammer ESI with large paginated asset requests. Assets are governed separately by a 12-hour staleness rule via `sync-character-assets-if-stale`.

**Steps:** Same as `fullCharacterSync` steps 1–6 and 8 (wallet journal, transactions, loyalty points are gated by a 30-minute `WALLET_JOURNAL_STALE_MS` check).

**Connects to:** Same as `fullCharacterSync`, minus the asset sync steps.

---

### `syncAssetsInternal(characterId)`

**Purpose:** Standalone asset sync shared by both `sync-assets` and `sync-all-assets`. Fetches all asset pages from ESI, resolves type names via `resolveNames`, resolves location metadata via `getLocator().resolveLocations`, then does a second targeted pass to re-resolve any locations that returned null on the first attempt (Upwell structures that 401'd or missed Hammertime). Writes to both `character_information.db` and the legacy `blueprints.json`.

**Returns:** `{ count, items }`.

**Connects to:** `httpGet()`, `resolveNames()`, `getLocator()`, `getValidToken()`, `charInfoDb.replaceAssets/updateAssetLocation/getUnresolvedAssetLocations`, `loadDB()`, `saveDB()`.

---

### `broadcastToRenderers(channel, payload)`

**Purpose:** Sends an IPC message to all open, non-destroyed `BrowserWindow` instances. Used by the Jabber client to push status/message events to the renderer without needing a reference to a specific window.

**Connects to:** Electron `BrowserWindow.getAllWindows()`.

---

## IPC Handlers

All IPC handlers are registered with `ipcMain.handle(channel, handler)` and are called from the renderer via `window.eveAPI.*` (exposed through `src/preload.js`).

---

### Account & Auth

| IPC Channel | What it does | Connects to |
|---|---|---|
| `get-accounts` | Returns all accounts (id, name, addedAt, needsReauth) from `blueprints.json` — no tokens exposed | `loadDB()` |
| `remove-account` | Deletes account, blueprints, and assets from `blueprints.json`; removes all SQLite tables for the character | `loadDB()`, `saveDB()`, `charInfoDb.removeCharacterData()` |
| `start-sso-login` | Generates PKCE verifier/challenge, stores state in `pendingAuth`, opens the EVE SSO URL in the system browser | `startCallbackServer()`, `generateCodeVerifier/Challenge()`, `shell.openExternal()` |

---

### Sync

| IPC Channel | What it does | Connects to |
|---|---|---|
| `sync-character-full` | Manual full sync — runs all 11 steps of `fullCharacterSync`, forwarding progress events to the renderer | `fullCharacterSync()` |
| `sync-character-core` | 20-min cadence sync — runs `coreCharacterSync` (no assets), forwarding progress events | `coreCharacterSync()` |
| `sync-character-assets-if-stale` | Skips asset sync if data is less than 12 hours old (`ASSET_STALE_MS`); otherwise runs `syncAssetsInternal` | `syncAssetsInternal()`, `charInfoDb.getAssetSyncedAt()` |
| `sync-assets` | Immediately syncs assets for one character | `syncAssetsInternal()` |
| `sync-all-assets` | Syncs assets for all accounts in parallel (max 4 workers) with a 6-hour cache on the overall result | `syncAssetsInternal()`, `readCache()`, `writeCache()` |
| `sync-blueprints` | Fetches all blueprint pages from ESI, resolves names, saves to `blueprints.json` (legacy path; `sync-character-full` now also writes to SQLite) | `httpGet()`, `resolveNames()`, `getValidToken()`, `loadDB()`, `saveDB()` |

---

### Data Read — SQLite (character_information.db)

| IPC Channel | What it does | Connects to |
|---|---|---|
| `get-character-info-db` | Returns all character data rows from SQLite | `charInfoDb.getCharacterData()` |
| `get-character-assets-db` | Returns character assets from SQLite | `charInfoDb.getCharacterAssets()` |
| `get-character-blueprints-db` | Returns character blueprints from SQLite | `charInfoDb.getCharacterBlueprints()` |
| `get-all-blueprints-from-db` | Returns blueprints for all accounts from SQLite, each augmented with `characterId` and `characterName` | `charInfoDb.getCharacterBlueprints()`, `loadDB()` |
| `get-pi-colonies` | Returns PI colony data from SQLite | `charInfoDb.getCharacterPIColonies()` |
| `get-wallet-journal` | Returns wallet journal entries from SQLite | `charInfoDb.getWalletJournal()` |
| `get-wallet-transactions` | Returns wallet transactions from SQLite | `charInfoDb.getWalletTransactions()` |
| `get-loyalty-points` | Returns loyalty points per corporation from SQLite | `charInfoDb.getLoyaltyPoints()` |

---

### Data Read — JSON / ESI

| IPC Channel | What it does | Connects to |
|---|---|---|
| `get-blueprints` | Returns saved blueprints for one character from `blueprints.json` | `loadDB()` |
| `get-all-blueprints` | Returns all blueprints across all characters from `blueprints.json`, each tagged with `characterId`/`characterName` | `loadDB()` |
| `get-assets` | Returns saved assets for one character from `blueprints.json` | `loadDB()` |
| `get-all-assets` | Returns all assets across all characters from `blueprints.json` | `loadDB()` |
| `get-character-jobs` | Fetches completed industry jobs from ESI; resolves solar system names; cached 24 hours with a 30-day stale fallback on 429 | `httpGet()`, `resolveNames()`, `getValidToken()`, `readCache()`, `writeCache()` |
| `get-character-info` | Fetches authenticated character sheet from ESI v5 | `httpGet()`, `getValidToken()` |
| `get-clones` | Fetches jump clone and home station data from ESI v3 | `httpGet()`, `getValidToken()` |
| `get-character-orders` | Fetches active market orders from ESI v2 (buy-order escrow) | `httpGet()`, `getValidToken()` |
| `get-character-contracts` | Fetches character contracts from ESI v1 | `httpGet()`, `getValidToken()` |
| `get-wallet` | Fetches live wallet balance from ESI v1 | `httpGet()`, `getValidToken()` |
| `get-market-prices` | Fetches global adjusted/average market prices from ESI v1 (unauthenticated); cached 12 hours | `httpGet()`, `readCache()`, `writeCache()` |
| `get-jita-prices` | Fetches best Jita 4-4 buy/sell prices per type from The Forge region orders; cached per-type 6 hours | `httpGet()`, `readCache()`, `writeCache()` |

---

### Location & Name Resolution

| IPC Channel | What it does | Connects to |
|---|---|---|
| `get-structure-info` | Resolves a single structure or station ID to full location metadata | `getLocator().resolveLocation()` |
| `resolve-location` | Same as above (alias used elsewhere in the renderer) | `getLocator().resolveLocation()` |
| `resolve-system-names` | Bulk-resolves solar system IDs to names | `getLocator().resolveSystemNames()` |
| `esi-names` | Batch name resolution via `resolveNames()` — returns `[{ id, name }]` | `resolveNames()` |
| `esi-search` | Searches ESI for inventory types by name string | `httpGet()` → ESI `/v2/search/` |
| `esi-fetch` | Raw proxy: fetches any ESI URL unauthenticated | `httpGet()` |

---

### Station Database

| IPC Channel | What it does | Connects to |
|---|---|---|
| `sync-station-database` | Syncs NPC station list from ESI via the locator; skips if synced within 24 hours unless `{ force: true }` | `getLocator().syncStationDatabase()`, `charInfoDb.getStationsLastSync/initStationTables()` |
| `get-station-sync-timestamp` | Returns the ms-epoch of the last successful station sync | `charInfoDb.getStationsLastSync()` |
| `sync-upwell-database` | No-op placeholder — Upwell structures are populated automatically during character syncs | — |

---

### Blueprint & SDE Lookups

| IPC Channel | What it does | Connects to |
|---|---|---|
| `get-blueprint-materials` | Fetches blueprint material requirements from Fuzzwork API; in-memory cached | `httpGet()` → `fuzzwork.co.uk/api/blueprint.php`, `bpCache` |
| `find-bp-for-product` | Finds the blueprint that produces a given product type ID via Fuzzwork | `httpGet()` → Fuzzwork, `bpCache` |
| `get-product-for-blueprint` | Queries SDE `invBlueprintTypes` to find what a blueprint produces | `sdeDb.get()` |
| `sde-get-name` | Looks up a type name from the local SDE SQLite; tries multiple table name variants | `sdeDb.get()` |
| `sde-blueprint-materials` | Full SDE-based material lookup with ME bonus applied. Queries `industryActivityMaterials`, resolves names from `invTypes`, detects sub-components via `industryActivityProducts`, and applies the formula `max(1, ceil(baseQty × (1 − me/100)))` | `sdeDb.all/get()` |

---

### Config & Cache

| IPC Channel | What it does | Connects to |
|---|---|---|
| `cache-get` | Reads a value from the disk cache | `readCache()` |
| `cache-set` | Writes a value to the disk cache with a TTL in days | `writeCache()` |
| `ui-get-config` | Returns stored `uiTheme` from `config.json` | `loadConfig()` |
| `ui-save-config` | Saves `uiTheme` to `config.json` | `loadConfig()`, `saveConfig()` |
| `app-get-config` | Returns the full `config.json` object | `loadConfig()` |
| `app-save-config` | Merges new config values into `cfg.app` and saves | `loadConfig()`, `saveConfig()` |

---

### Ping File Watcher

| IPC Channel | What it does | Connects to |
|---|---|---|
| `watch-ping-file` | Starts an `fs.watch` on a file path; debounces 250 ms then broadcasts `ping-file-updated` with file contents to all renderer windows | `fs.watch()`, `BrowserWindow.getAllWindows()` |
| `unwatch-ping-file` | Closes the active file watcher and clears the debounce timer | `fs.watch` handle |

---

### Jabber (XMPP)

| IPC Channel | What it does | Connects to |
|---|---|---|
| `jabber-connect` | Creates an XMPP client using `@xmpp/client`, connects to the given `service`/`jid`/`password`, and broadcasts `jabber-status` events on connect/disconnect/error. Incoming messages are forwarded via `jabber-message` events; messages from senders/bodies matching "director" are flagged `isDirector: true` | `getXmppClient()`, `broadcastToRenderers()` |
| `jabber-disconnect` | Stops the active XMPP client and clears the `jabberClient` reference | `jabberClient.stop()` |

---

## App Lifecycle

| Event | Behaviour |
|---|---|
| `app.whenReady()` | Runs startup sequence: paths → SDE → charInfoDb → window |
| `window-all-closed` | Closes the callback server; quits the app on non-macOS |
| `activate` | Re-creates the window if no windows are open (macOS dock click) |

---

## External Dependencies

| Dependency | Used by | Notes |
|---|---|---|
| `electron` (`app`, `BrowserWindow`, `ipcMain`, `shell`) | Entire file | Electron main process APIs |
| `sqlite3` + `sqlite` | `initSde()`, `sde-*` handlers | SDE and character SQLite databases |
| `dotenv` | Top-level | Loads `EVE_CLIENT_ID` from `.env` |
| `@xmpp/client` | `jabber-connect` | ESM; lazy-loaded via `getXmppClient()` |
| `./src/locator` | `getLocator()` | Shared location resolver for NPC stations and Upwell structures |
| `./src/character_info_db` | All sync functions | SQLite helper for `character_information.db` |
| `ESI (esi.evetech.net)` | Most sync/read handlers | EVE Online REST API |
| `login.eveonline.com` | `startCallbackServer()`, `getValidToken()` | OAuth 2.0 / SSO |
| `fuzzwork.co.uk` | `get-blueprint-materials`, `find-bp-for-product` | Third-party blueprint material API |
| Node.js built-ins: `https`, `http`, `crypto`, `fs`, `path` | Throughout | Standard library |