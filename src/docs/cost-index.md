# `cost-index.js` — Function & Connection Reference

> **Module purpose:** Renders and manages the Cost Index Calculator tab — fetches live industry cost index data from the EVE ESI API, resolves system names/regions, and provides filtering by region, system name, jump range, and facility type.

---

## Module-Level State

| Variable | Type | Purpose |
|---|---|---|
| `_ciAllSystems` | `Array \| null` | Raw ESI response array, session-cached |
| `_ciLoading` | `boolean` | Guard flag to prevent concurrent fetches |
| `_ciSort` | `{ col, dir }` | Current sort column and direction |
| `_ciRegion` | `string` | Selected region ID filter |
| `_ciSystemQuery` | `string` | Current system name search string |
| `_ciJumpRange` | `number` | Max jumps for system proximity filter (default: 4) |
| `_ciReqFactory` | `boolean` | Toggle: only show systems with manufacturing index > 0 |
| `_ciReqLab` | `boolean` | Toggle: only show systems with any research index > 0 |
| `_ciSearchTimer` | `number \| null` | Debounce timer handle for system search input |
| `_ciSystemMap` | `object` | `solarSystemId → { name, secStatus, regionName, regionId }` lookup |

## Module-Level Constants

| Constant | Purpose |
|---|---|
| `CI_REGIONS` | Map of EVE region IDs to display names (used to populate the region dropdown) |
| `CI_ACTIVITY_MAP` | Maps ESI activity IDs (1, 3, 4, 5, 8, 11) to column key strings (e.g. `manufacturing`, `invention`) |

---

## Functions

### `renderCostIndex(container)` *(async)*
**Purpose:** Entry point for the Cost Index tab. Builds the full UI (toolbar, stats bar, table, footer, CSS) into the provided `container` element, wires up all event listeners, and triggers the initial data load.

**UI elements created:**
- `#ciWrap` — outer flex wrapper
- `#ciRegionSel` — region dropdown
- `#ciSystemSearch` + `#ciSystemDrop` — system autocomplete input
- `#ciJumpRange` — jump range selector
- `#ciReqFactory` / `#ciReqLab` — toggle checkboxes
- `#ciRefreshBtn` — manual refresh button
- `#ciPriceAge` — timestamp label
- `#ciStatsBar` with `#ciRowCount`, `#ciBestMfg`, `#ciBestLab`
- `#ciTable` / `#ciTableBody` — sortable data table

**Event listeners wired:**

| Event | Element | Action |
|---|---|---|
| `click` | `#ciRefreshBtn` | Calls `loadCIData(true)` |
| `change` | `#ciRegionSel` | Updates `_ciRegion`, clears system search, calls `applyCIFilters()` |
| `change` | `#ciJumpRange` | Updates `_ciJumpRange`, calls `applyCIFilters()` if system query active |
| `change` | `#ciReqFactory` | Updates `_ciReqFactory`, calls `applyCIFilters()` |
| `change` | `#ciReqLab` | Updates `_ciReqLab`, calls `applyCIFilters()` |
| `input` | `#ciSystemSearch` | Debounces 250 ms, calls `handleCISystemInput()` |
| `keydown` | `#ciSystemSearch` | Escape hides dropdown; Enter clicks first autocomplete item |
| `click` | `document` | Hides `#ciSystemDrop` on outside click |
| `click` | `.ci-th` (each) | Toggles sort column/direction, calls `renderCITable()` |

**Calls:**
| Called function | Why |
|---|---|
| `loadCIData(false)` | Initial data fetch on tab open |
| `applyCIFilters()` | Via multiple control event handlers |
| `handleCISystemInput()` | Via debounced system search input |
| `renderCITable()` | Via column header sort clicks |
| `escHtml(str)` | Sanitise region names in dropdown HTML |

---

### `loadCIData(forceRefresh)` *(async)*
**Purpose:** Fetches the full ESI `/industry/systems/` endpoint and loads system name/region details. Uses session cache (`_ciAllSystems`) unless `forceRefresh` is `true`. Calls `applyCIFilters()` once data is ready.

**Guard:** Returns immediately if `_ciLoading` is already `true` to prevent concurrent fetches.

**Calls:**
| Called function/API | Why |
|---|---|
| `window.eveAPI.esiFetch(url)` | Fetch all industry systems from ESI |
| `loadCISystemDetails(systemIds)` | Resolve names, sec status, region for each system |
| `applyCIFilters()` | Trigger filtered render after load |
| `logToConsole(msg, level)` | Progress and error output to app console |
| `escHtml(str)` | Sanitise error message in failure HTML |

---

### `loadCISystemDetails(systemIds)` *(async)*
**Purpose:** Resolves human-readable name, security status, and region for every system ID returned by ESI. Populates `_ciSystemMap`. Fetches names in chunks of 800 via `window.eveAPI.getNames`, then enriches with sec/region data via `window.eveAPI.resolveSystemNames` (capped at 500 IDs due to API constraints).

**Calls:**
| Called function/API | Why |
|---|---|
| `window.eveAPI.getNames(batch)` | ESI POST `/universe/names/` — resolve IDs to names in batches of 800 |
| `window.eveAPI.resolveSystemNames(ids)` | Resolve sec status + region per system (first 500) |

---

### `applyCIFilters()` *(async)*
**Purpose:** Applies all active filters (region, factory toggle, lab toggle, system name / jump range) to `_ciAllSystems`, stores the result in `window._ciFilteredSystems`, and calls `renderCITable()`. The jump-range path is async because it queries the ESI route API.

**Filter pipeline:**
1. Map raw ESI data → normalised system objects using `_ciSystemMap`
2. Region filter — match `regionId` against `_ciRegion`
3. Factory toggle — exclude systems with `manufacturing === 0`
4. Lab toggle — exclude systems with all research/copy/invention indexes at 0
5. System search — if query ≥ 2 chars and no region selected:
   - Tries exact/prefix match via `findCISystemByName()` → filters by jump range via `filterByJumpRange()`
   - Falls back to partial name filter if no anchor found

**Calls:**
| Called function | Why |
|---|---|
| `findCISystemByName(query)` | Resolve search string to a system anchor object |
| `filterByJumpRange(systems, anchorId, maxJumps)` | ESI-based jump distance filter |
| `renderCITable()` | Re-render the table after filtering |

---

### `findCISystemByName(query)`
**Purpose:** Searches `_ciSystemMap` for an exact name match first, then a prefix match. Returns `{ id, name, secStatus, regionName, regionId }` or `null`.

**No outbound calls** — pure in-memory lookup over `_ciSystemMap`.

---

### `filterByJumpRange(systems, anchorId, maxJumps)` *(async)*
**Purpose:** Given an anchor system and a max-jumps value, queries the ESI route API for each candidate system in batches of 20 (concurrent via `Promise.all`). Returns only systems whose shortest-path jump count is ≤ `maxJumps`.

Updates `#ciRowCount` progressively with a "checking… (N/total)" label while batches run.

**Calls:**
| Called function/API | Why |
|---|---|
| `window.eveAPI.esiFetch(url)` | ESI GET `/route/{from}/{to}/` per destination system |

---

### `renderCITable()`
**Purpose:** Reads `window._ciFilteredSystems`, sorts by the current `_ciSort` state, updates the stats bar (`#ciRowCount`, `#ciBestMfg`, `#ciBestLab`), and writes all table rows to `#ciTableBody`. Calculates per-column max values for proportional bar scaling.

**Calls:**
| Called function | Why |
|---|---|
| `ciBarCell(value, pct, color)` | Render each cost-index cell with its bar + formatted value |
| `formatCI(value)` | Format a raw cost index float as a `%` string |
| `escHtml(str)` | Sanitise system and region names in row HTML |

---

### `ciBarCell(value, pct, color)`
**Purpose:** Returns an HTML string for a single cost-index table cell. Renders a proportional coloured bar and a formatted percentage label, or a `—` dash if the value is zero/absent.

**Calls:**
| Called function | Why |
|---|---|
| `formatCI(value)` | Format the numeric value as a percentage string |

---

### `formatCI(value)`
**Purpose:** Pure formatter — multiplies a raw cost index (e.g. `0.02341`) by 100 and returns a 3-decimal percentage string (e.g. `"2.341%"`), or `"—"` for zero/falsy values.

**No outbound calls.**

---

### `handleCISystemInput()` *(async)*
**Purpose:** Handles debounced input on `#ciSystemSearch`. Searches `_ciSystemMap` for names starting with the typed query (minimum 2 chars), renders up to 20 matching results in the `#ciSystemDrop` autocomplete dropdown. Clicking a result sets `_ciSystemQuery`, clears the region filter, and calls `applyCIFilters()`.

**Calls:**
| Called function | Why |
|---|---|
| `applyCIFilters()` | Apply the chosen system as a filter anchor |
| `escHtml(str)` | Sanitise system/region names in dropdown HTML |

---

## External Dependencies

| Dependency | Source | Used by |
|---|---|---|
| `window.eveAPI.esiFetch(url)` | Electron IPC / preload | `loadCIData`, `filterByJumpRange` |
| `window.eveAPI.getNames(ids)` | Electron IPC / preload | `loadCISystemDetails` |
| `window.eveAPI.resolveSystemNames(ids)` | Electron IPC / preload | `loadCISystemDetails` |
| `logToConsole(msg, level)` | Global UI utility | `loadCIData` |
| `escHtml(str)` | Global utility | `renderCostIndex`, `renderCITable`, `handleCISystemInput`, `loadCIData` |
| `window._ciFilteredSystems` | Module-level write, read by `renderCITable` | `applyCIFilters` → `renderCITable` |

---

## Connection / Call Graph

```
renderCostIndex(container)
├── escHtml()                          ← region dropdown HTML
├── loadCIData(false)                  ← initial load
│   ├── window.eveAPI.esiFetch()       ← ESI /industry/systems/
│   ├── loadCISystemDetails(ids)
│   │   ├── window.eveAPI.getNames()   ← ESI /universe/names/ batched
│   │   └── window.eveAPI.resolveSystemNames()
│   ├── applyCIFilters()
│   │   ├── findCISystemByName()       ← in-memory name search
│   │   ├── filterByJumpRange()
│   │   │   └── window.eveAPI.esiFetch()  ← ESI /route/{from}/{to}/
│   │   └── renderCITable()
│   │       ├── ciBarCell()
│   │       │   └── formatCI()
│   │       └── escHtml()
│   └── logToConsole()
│
├── [ciRefreshBtn click]
│   └── loadCIData(true)               ← force re-fetch
│
├── [ciRegionSel change]
│   └── applyCIFilters() → renderCITable()
│
├── [ciJumpRange change]
│   └── applyCIFilters() → renderCITable()
│
├── [ciReqFactory change]
│   └── applyCIFilters() → renderCITable()
│
├── [ciReqLab change]
│   └── applyCIFilters() → renderCITable()
│
├── [ciSystemSearch input — debounced 250ms]
│   └── handleCISystemInput()
│       ├── escHtml()
│       └── [dropdown item click]
│           └── applyCIFilters() → renderCITable()
│
└── [.ci-th header click]
    └── renderCITable()
```