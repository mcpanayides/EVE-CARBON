# `preload.js` — Function Reference

## Overview

This is the Electron **preload script**. It runs in a privileged context between the main process and the renderer process, and uses `contextBridge.exposeInMainWorld` to safely expose a single `window.eveAPI` object to all renderer scripts.

Every method on `window.eveAPI` is a thin wrapper around `ipcRenderer.invoke()` or `ipcRenderer.on/removeListener()`. The renderer never has direct access to Node.js or Electron internals — all communication goes through this bridge.

> **IPC pattern:** `ipcRenderer.invoke(channel, ...args)` sends a message to the main process and returns a Promise that resolves with the main process handler's return value. The main process registers handlers with `ipcMain.handle(channel, fn)`.

---

## `window.eveAPI` — Method Reference

### Character Sync & Data

| Method | IPC Channel | Description |
|---|---|---|
| `syncCharacterFull(characterId)` | `sync-character-full` | Triggers a full character sync to `character_information.db`. Fetches and stores all ESI data for the given character. |
| `getCharacterInfoDb(characterId)` | `get-character-info-db` | Reads stored character info from the local CharDB. Returns cached ESI data without making a live API call. |
| `getCharacterAssetsDb(characterId)` | `get-character-assets-db` | Reads stored asset list for a character from the local DB. |
| `getCharacterBlueprintsDb(characterId)` | `get-character-blueprints-db` | Reads stored blueprint list for a character from the local DB. |
| `getCharacterData(characterId)` | `get-character-info-db` | **Alias** of `getCharacterInfoDb`. Used by `dashboard.js`, `characters.js`, `wallets`, and `planetary-interaction.js`. |
| `getCharacterAssets(characterId)` | `get-character-assets-db` | **Alias** of `getCharacterAssetsDb`. |
| `getPIColonies(characterId)` | `get-pi-colonies` | Reads stored Planetary Interaction colony data for a character. |

---

### Wallet & Loyalty Points

| Method | IPC Channel | Description |
|---|---|---|
| `getWalletJournal(charId)` | `get-wallet-journal` | Returns the wallet journal for a character, synced from ESI every 30 minutes. |
| `getWalletTransactions(charId)` | `get-wallet-transactions` | Returns market transaction history for a character. |
| `getLoyaltyPoints(charId)` | `get-loyalty-points` | Returns loyalty point balances across all corporations for a character. |
| `getWalletBalance(charId)` | `get-wallet` | Returns the current ISK wallet balance for a character. |

---

### Accounts & Authentication

| Method | IPC Channel | Description |
|---|---|---|
| `getAccounts()` | `get-accounts` | Returns all authenticated character accounts stored in the app. |
| `removeAccount(id)` | `remove-account` | Removes a character account by ID. |
| `startSSOLogin()` | `start-sso-login` | Opens the EVE Online SSO login flow (launches OAuth URL in browser or Electron window). |

---

### Dashboard & ESI Data

| Method | IPC Channel | Description |
|---|---|---|
| `esiFetch(url)` | `esi-fetch` | Generic ESI proxy — passes a URL to the main process which handles auth headers and returns the response. |
| `getCharacterInfo(characterId)` | `get-character-info` | Fetches live character info from ESI (not the local DB). |
| `getClones(characterId)` | `get-clones` | Fetches jump clone data for a character from ESI. |
| `getMarketPrices()` | `get-market-prices` | Fetches the full EVE market price list from ESI. |
| `getStructureInfo(structureId, characterId)` | `get-structure-info` | Resolves structure details (name, location) using the character's auth token. |
| `resolveLocation(locationId, characterId)` | `resolve-location` | Resolves a location ID (station or structure) to a human-readable name. |
| `resolveSystemNames(systemIds)` | `resolve-system-names` | Batch-resolves an array of solar system IDs to their names. |
| `getCharacterOrders(characterId)` | `get-character-orders` | Fetches active market orders for a character from ESI. |
| `getCharacterContracts(characterId)` | `get-character-contracts` | Fetches contracts for a character from ESI. |

---

### Blueprints

| Method | IPC Channel | Description |
|---|---|---|
| `syncBlueprints(charId)` | `sync-blueprints` | Syncs a character's blueprints from ESI into the local DB. |
| `getBlueprints(charId)` | `get-blueprints` | Returns stored blueprints for a specific character. |
| `getAllBlueprintsFromDb()` | `get-all-blueprints-from-db` | Returns all blueprints across all characters from the local DB. Used by `materials.js` as `getAllBlueprints()`. |
| `getBlueprintMaterials(id)` | `get-blueprint-materials` | Fetches raw material requirements for a blueprint from Fuzzwork or the local SDE. |
| `findBpForProduct(id)` | `find-bp-for-product` | Looks up the blueprint that produces a given product type ID (Fuzzwork). |
| `getProductForBlueprint(id)` | `get-product-for-blueprint` | Reverse lookup — finds what a blueprint produces. Used as a fallback in `materials.js`. |
| `sdeBlueprintMaterials(blueprintTypeId, me)` | `sde-blueprint-materials` | Queries the local SDE for manufacturing materials and applies the ME (Material Efficiency) bonus. Returns `{ materials, productTypeId, productName, productQty }` or `null`. |

---

### Public ESI & Fuzzwork

| Method | IPC Channel | Description |
|---|---|---|
| `search(q)` | `esi-search` | Searches EVE's ESI for inventory types matching a query string. Used by the manual blueprint search in `materials.js`. |
| `getNames(ids)` | `esi-names` | Batch-resolves an array of type IDs to their names via ESI. |
| `getJitaPrices(typeIds)` | `get-jita-prices` | Fetches current Jita 4-4 sell/buy prices for a list of type IDs (via Fuzzwork market API). |

---

### Industry Jobs

| Method | IPC Channel | Description |
|---|---|---|
| `getCharacterJobs(characterId)` | `get-character-jobs` | Returns active and completed industry jobs for a character from ESI or the local DB. |

---

### Assets

| Method | IPC Channel | Description |
|---|---|---|
| `syncAssets(charId)` | `sync-assets` | Syncs a single character's assets from ESI into the local DB. |
| `syncAllAssets()` | `sync-all-assets` | Syncs assets for all authenticated characters in one operation. |
| `getAssets(charId)` | `get-assets` | Returns stored assets for a specific character. |
| `getAllAssets()` | `get-all-assets` | Returns stored assets across all characters. |

---

### Station & Structure Databases

| Method | IPC Channel | Description |
|---|---|---|
| `syncStationDatabase(opts)` | `sync-station-database` | Syncs the NPC station database from ESI/SDE into the local DB. |
| `syncUpwellDatabase(opts)` | `sync-upwell-database` | Syncs the Upwell structure (citadel/engineering complex) database. |
| `getStationSyncTimestamp(opts)` | `get-station-sync-timestamp` | Returns when the station database was last synced. |

---

### SDE (Static Data Export)

| Method | IPC Channel | Description |
|---|---|---|
| `sdeGetName(id)` | `sde-get-name` | Looks up a type name by ID in the local SDE database. Used alongside `getNames()` in `materials.js` for name resolution. |

---

### Persistent Cache

| Method | IPC Channel | Description |
|---|---|---|
| `cacheGet(key)` | `cache-get` | Reads a value from the persistent user data cache by key. |
| `cacheSet(key, value, days)` | `cache-set` | Writes a value to the persistent cache with an optional TTL in days. |

---

### UI & App Configuration

| Method | IPC Channel | Description |
|---|---|---|
| `getUIConfig()` | `ui-get-config` | Reads the saved UI theme/layout config (colours, panel visibility, etc.). |
| `saveUIConfig(config)` | `ui-save-config` | Persists UI config changes to disk via the main process. |
| `getAppConfig()` | `app-get-config` | Reads general app settings (refresh intervals, API keys, etc.). |
| `saveAppConfig(config)` | `app-save-config` | Persists app settings changes to disk. |

---

### Ping File Watcher

| Method | IPC Channel | Description |
|---|---|---|
| `watchPingFile(path)` | `watch-ping-file` | Tells the main process to watch a file path for changes (used for external ping integrations). Triggers `ping-file-updated` events when the file changes. |
| `unwatchPingFile()` | `unwatch-ping-file` | Stops watching the currently watched ping file. |

---

### Jabber (XMPP)

| Method | IPC Channel | Description |
|---|---|---|
| `connectJabber(config)` | `jabber-connect` | Starts the Jabber XMPP client in the main process using the provided config (service, JID, password). |
| `disconnectJabber()` | `jabber-disconnect` | Disconnects the active Jabber session. |

---

### IPC Event Listeners

#### `on(channel, fn)`

Subscribes the renderer to a main-process event on an allowlisted channel. The `ipcRenderer` event object is stripped — the callback receives only the payload `(...args)`.

**Allowed channels:**

| Channel | Triggered When |
|---|---|
| `account-added` | A new character account is successfully authenticated via SSO |
| `auth-error` | An authentication or token refresh error occurs |
| `char-sync-progress` | A character sync operation emits a progress update |
| `jabber-status` | The Jabber connection status changes (connecting, connected, disconnected, error) |
| `jabber-message` | A new Jabber message is received |
| `ping-file-updated` | The watched ping file changes on disk |

Any channel not in this list is silently ignored — the listener is not registered.

#### `off(channel, fn)`

Removes a previously registered listener. Passes directly through to `ipcRenderer.removeListener(channel, fn)`. No channel allowlist is applied here.

---

## Architecture Summary

```
Renderer scripts                preload.js               Main process
(materials.js, PI.js, etc.)                              (ipcMain handlers)
        │                            │                          │
        │  window.eveAPI.method()    │                          │
        │ ──────────────────────────►│                          │
        │                            │  ipcRenderer.invoke()    │
        │                            │ ────────────────────────►│
        │                            │                          │  DB / ESI / SDE
        │                            │       resolved value     │
        │                            │ ◄────────────────────────│
        │       Promise resolves     │                          │
        │ ◄──────────────────────────│                          │
```

The renderer has **no direct Node.js or Electron access** — `contextBridge` enforces this boundary. All privileged operations (file I/O, network with auth headers, SQLite access) live exclusively in the main process.

---

## Cross-File Usage Reference

| `window.eveAPI` Method | Called By |
|---|---|
| `getAllBlueprintsFromDb()` (as `getAllBlueprints`) | `materials.js` → `openMaterialsInTab` |
| `getProductForBlueprint()` | `materials.js` → `openMaterialsInTab` (fallback) |
| `getJitaPrices()` | `materials.js` → `showMaterialsModal` |
| `search()` | `materials.js` → `handleManualSearchInput` |
| `sdeGetName()` | `materials.js` → `handleManualSearchInput` |
| `getNames()` | `materials.js` → `handleManualSearchInput` |
| `findBpForProduct()` | `materials.js` → `loadManualBlueprintSearch` |
| `getAccounts()` | `planetary-interaction.js` → `loadPlanetaryInteraction` |
| `getCharacterData()` | `planetary-interaction.js` → `loadPlanetaryInteraction`, `loadCharacterColonies` |
| `on('account-added')` | `characters.js` (implied) |
| `on('jabber-status')` / `on('jabber-message')` | `jabber` page logic |
| `on('ping-file-updated')` | Ping file integration handler |
| `on('char-sync-progress')` | Character sync UI progress updates |