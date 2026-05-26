# `dashboard.js` — Function Reference

This file drives the main EVE Online character dashboard. It is responsible for auto-refreshing stale character data, rendering the welcome banner, calculating net worth, displaying industry jobs, and drawing the KPI/wealth panel.

---

## Module-Level State

| Variable | Type | Purpose |
|---|---|---|
| `STALE_MS` | `number` | Threshold (30 min) beyond which character data is considered stale |
| `_dashboardLoading` | `boolean` | Guard flag for dashboard load (declared but not actively used in visible code) |
| `_autoRefreshRunning` | `boolean` | Prevents more than one background auto-refresh pass from running at once |
| `_autoSyncingIds` | `Set<string>` | Shared set of character IDs currently being auto-synced; read by `characters.js` to reflect spinner state on already-rendered cards |

---

## Functions

---

### `_fireAutoSync(characterId, phase, success)`

**Purpose:** Broadcasts a DOM custom event (`auto-sync`) so that other parts of the UI (e.g. character cards in `characters.js`) can react to background sync state changes without being tightly coupled to this module.

**Parameters:**
- `characterId` — the character being synced (cast to string)
- `phase` — `'start'`, `'done'`, or `'error'`
- `success` — boolean result (relevant on `done`/`error`)

**Connects to:**
- `document` — dispatches a `CustomEvent` on it
- `characters.js` — listens for this event to update card UI

---

### `autoRefreshStaleCharacters(accounts)`

**Purpose:** Background, non-blocking sync pass that runs once per dashboard load. Checks the `synced_at` timestamp for every account from the local DB; any character whose data is older than 30 minutes is queued for a full ESI sync, one at a time.

**Behaviour:**
- Skips entirely if already running (`_autoRefreshRunning` guard)
- Aborts the queue early if a manual sync button becomes active (`.character-sync-btn[disabled]` present in the DOM)
- Fires `_fireAutoSync` events at each stage so the UI can show progress

**Connects to:**
- `window.eveAPI.getCharacterData(characterId)` — reads `synced_at` from `character_information.db`
- `window.eveAPI.syncCharacterFull(characterId)` — triggers a full ESI sync for stale characters
- `_fireAutoSync()` — broadcasts sync lifecycle events
- `logToConsole()` — logs progress/errors to the in-app console

---

### `loadDashboard()`

**Purpose:** Main entry point. Orchestrates the entire dashboard render in three parallel async sections after an initial cache hit attempt.

**DOM elements targeted:**
- `#dashboardNetworthSummary` — KPI / net worth panel
- `#dashboardJobsTable` — industry jobs table
- `#dashboardWelcomeBanner` — character welcome banner
- `#dashboardMainCharName` — label showing the main character's name

**Execution flow:**

1. **Cache render** — Attempts an immediate render from `dashboard_cache` via `window.eveAPI.cacheGet()` so the UI is not blank while fresh data loads.
2. **Account check** — Calls `window.eveAPI.getAccounts()`. Shows empty-state messages and exits early if no accounts exist.
3. **Background auto-refresh** — Calls `autoRefreshStaleCharacters()` in a fire-and-forget manner.
4. **Section 1 — Welcome Banner** (async IIFE): Reads character info, location, ship, implants, corporation/alliance names, and bloodline from the local DB, then calls `renderBanner()`.
5. **Section 2 — Net Worth** (async IIFE): Calculates liquid ISK, asset value (from DB × EVE market prices), and buy-order escrow, then calls `renderKPIPanel()`. Caches the result for 1 hour.
6. **Section 3 — Jobs Table** (async IIFE): Fetches industry jobs for all characters one at a time, resolves item/system/facility names in bulk, and renders a sortable HTML table.

**Connects to:**
- `window.eveAPI.cacheGet / cacheSet` — dashboard cache
- `window.eveAPI.getAccounts()` — account list
- `window.eveAPI.getCharacterData(id)` — DB reads for banner and wallet
- `window.eveAPI.getCharacterImplants(id)` — fallback IPC call for implants
- `window.eveAPI.getNames(ids)` — bulk name resolution (corps, alliances, items, solar systems)
- `window.eveAPI.getMarketPrices()` — single unauthenticated ESI call, cached 12 h
- `window.eveAPI.getCharacterAssetsDb(id)` — asset list from local DB
- `window.eveAPI.getCharacterOrders(id)` — active market orders (for escrow)
- `window.eveAPI.getCharacterJobs(id)` — industry job list
- `window.eveAPI.getStructureInfo(facilityId, charId)` — player structure details for system name resolution
- `autoRefreshStaleCharacters()` — background sync
- `renderBanner()` — banner HTML writer (inner function, see below)
- `renderKPIPanel()` — KPI panel renderer
- `serialESI()` — rate-limit-safe ESI wrapper (inner function, see below)
- `logToConsole()` — in-app console output
- `escHtml()` — HTML escaping utility
- `formatISK()` — ISK number formatter

---

### `renderBanner({ charId, charName, birthday, gender, secStatus, corpId, corpName, allianceId, allianceName, homeStationName, homeSystemSec, bloodlineName, implants, currentShipTypeId, currentShipTypeName, stale })` *(inner function inside `loadDashboard`)*

**Purpose:** Builds and injects the full welcome banner HTML into `#dashboardWelcomeBanner`. Handles portrait, corporation/alliance logos, character stats, implant slot grid, and current ship render.

**Inner helpers it defines:**
- `charSecColor(s)` — maps a security status number to a colour string
- `systemSecMeta(sec)` — maps a system security value to a label, colour, and CSS class (`High Sec`, `Low Sec`, etc.)
- `genderMeta(g)` — maps gender string to a colour-coded breadcrumb
- `buildImplantGrid(implants)` — builds a 2×5 implant slot grid from DB rows, gracefully handling missing slot numbers

**External images loaded:**
- `images.evetech.net` — character portraits, corporation/alliance logos, ship renders, ship icons
- `fuzzwork.co.uk` — implant item icons (with fallback to EVE CDN)

---

### `serialESI(accounts, fn, retryAfterMs)` *(inner function inside `loadDashboard`)*

**Purpose:** Runs an async ESI function `fn` for each account sequentially (not in parallel) to avoid hitting ESI's rate limit. On a `429` response it waits `retryAfterMs` (default 12 s) and retries once before giving up.

**Connects to:** Any `window.eveAPI` call passed in as `fn`, particularly `getCharacterOrders`.

---

### `renderDashboardUI(data, isCached)`

**Purpose:** Lightweight render triggered by the cache path in `loadDashboard`. Accepts pre-computed dashboard data and delegates to `renderKPIPanel()`. Marks the main character label with a `[SYNCING FROM ESI...]` badge when rendering from cache.

**Parameters:**
- `data` — `{ accounts, mainAccount, overallValue, totalWallet, grandTotal, totalByChar, walletByChar }`
- `isCached` — boolean; when `true`, a "syncing" notice is shown next to the character name

**DOM elements targeted:**
- `#dashboardNetworthSummary`
- `#dashboardMainCharName`

**Connects to:** `renderKPIPanel()`, `escHtml()`

---

### `renderKPIPanel(container, accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, assetsLoading)`

**Purpose:** Renders the full wealth KPI panel including three headline figures (Total Net Worth, Liquid ISK, Asset Value), a per-character stacked bar chart (top 6), and a 12-month compounded wealth growth line chart using Chart.js.

**Parameters:**
- `container` — the DOM element to render into (typically `#dashboardNetworthSummary`)
- `accounts` — full account list
- `totalWallet` — sum of all wallet balances
- `overallValue` — sum of asset + escrow values
- `grandTotal` — `totalWallet + overallValue`
- `totalByChar` / `walletByChar` — per-character breakdowns (keyed by `characterId` string)
- `assetsLoading` — when `true`, replaces the chart with a "Calculating…" placeholder

**Chart details:**
- Uses **Chart.js** (`new Chart(canvas, …)`)
- One line per character (up to 6), coloured via CSS variables (`--accent`, `--assets`, `--liquidisk`, etc.)
- A red "Total" line (`#ff2010`) with a custom `totalGlowPlugin` that adds a canvas shadow glow effect
- Growth is approximated by applying a fixed array of 12 multipliers to the current total (no historical DB data is used)
- Chart instance stored on `canvas._chartInstance` to allow destroy/re-render on subsequent calls

**External images loaded:**
- `images.evetech.net` — character portrait thumbnails for bar chart rows

**Connects to:** `formatISK()`, `escHtml()`, `getComputedStyle()` (for CSS variable colours), **Chart.js** (global `Chart`)

---

### `setupDashboardWidgetDrag()`

**Purpose:** Makes the `#dashboardNetworthSummary` panel draggable by its `.dashboard-panel-title` header using mouse events. Sets `position: absolute` on the parent `.dashboard-panel` element and tracks drag delta from the initial mouse-down position.

**DOM elements targeted:**
- `#dashboardNetworthSummary` — the widget
- `.dashboard-panel` (closest ancestor) — repositioned during drag
- `.dashboard-panel-title` (child of panel) — drag handle

**Events attached:** `mousedown` on header → `mousemove` / `mouseup` on `document`

---

## External Dependencies

| Dependency | Used by | Notes |
|---|---|---|
| `window.eveAPI.*` | All major functions | IPC bridge to Electron main process / local SQLite DB |
| `Chart.js` (global `Chart`) | `renderKPIPanel` | Must be loaded before `dashboard.js` |
| `logToConsole()` | `autoRefreshStaleCharacters`, `loadDashboard` | In-app console logger, defined elsewhere |
| `escHtml()` | `renderBanner`, `renderDashboardUI`, `renderKPIPanel` | HTML escaping utility, defined elsewhere |
| `formatISK()` | `renderBanner`, `renderKPIPanel` | ISK number formatter, defined elsewhere |
| `selectedCharacterId` | `loadDashboard` | Global variable set by the character selector UI |
| `images.evetech.net` | `renderBanner`, `renderKPIPanel` | EVE Online CDN for portraits, logos, ship renders |
| `fuzzwork.co.uk` | `buildImplantGrid` | Third-party EVE item icon CDN (implant fallback to EVE CDN) |s