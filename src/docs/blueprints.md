# `blueprints.js` — Function & Connection Reference

> EVE Online industry tool. Reads blueprint data from `character_information.db` (SQLite) via IPC, renders a searchable/filterable library, and hosts calculators for Ore, Ice, and Gas.
>
> **External state** (declared in `state.js`, loaded before this file): `allLibBPs`, `filterPerfectOnly`, `searchTimer`, `manualSearchTimer`, `currentIndustryTab`, `selectedBpTypeId`, `selectedME`, `selectedTE`, `ESI_IMAGE`.

---

## Table of Contents

1. [Blueprint Library — Load & Filter](#1-blueprint-library--load--filter)
2. [Blueprint Library — Render](#2-blueprint-library--render)
3. [Blueprint Detail Panel](#3-blueprint-detail-panel)
4. [Material Helpers](#4-material-helpers)
5. [Recursive Component Tree](#5-recursive-component-tree)
6. [Industry Page Tab Routing](#6-industry-page-tab-routing)
7. [Stubs & Fallback Guards](#7-stubs--fallback-guards)
8. [Ore Calculator](#8-ore-calculator)
9. [Ice Calculator](#9-ice-calculator)
10. [Gas Calculator](#10-gas-calculator)
11. [Connection Map](#11-connection-map)

---

## 1. Blueprint Library — Load & Filter

### `loadBlueprintLibrary()` *(async)*
Loads all blueprints from the SQLite DB via IPC. Falls back to the legacy JSON handler if the new handler is not registered. Normalises field names (`type_name` → `name`, etc.), sets the module-level `allLibBPs` array, and calls `renderBlueprintList`.

**Calls:** `window.eveAPI.getAllBlueprintsFromDb()` → fallback `window.eveAPI.getAllBlueprints()` → `renderBlueprintList()` → `showToast()`

---

### `handleLibraryFilter()`
Reads all filter/sort inputs from the DOM (`bpLibSearch`, `bpLibFilter`, `bpLibSort`, `bpLibMinME`, `bpLibMinTE`, `bpLibMinRuns`) and applies them to `allLibBPs`. Respects the `filterPerfectOnly` flag (ME 10 / TE 20).

**Calls:** `sortBlueprints()` → `renderBlueprintList()`

---

### `togglePerfectFilter(value?)`
Flips (or sets) `filterPerfectOnly`, shows a toast, then re-runs the filter.

**Calls:** `showToast()` → `handleLibraryFilter()`

---

### `sortBlueprints(bps, criteria)`
Pure sort utility. Returns a sorted copy of `bps` by `me`, `te`, `runs`, or `name` (default).

**Returns:** sorted `Array`

---

## 2. Blueprint Library — Render

### `renderBlueprintList(bps)`
Clears and re-renders the `#bpLibList` grid. Each card shows the blueprint icon, name, ME/TE progress bars, owner portrait, BPO/BPC badge, and a **View** button. Applies Tech II and Faction dot indicators.

**Event listeners attached per card:**
- `.bp-view-btn` → `openBlueprintDetail(bp)`
- `.card-perfect-dot` → `togglePerfectFilter()`

**Calls:** `escHtml()`

---

### `bindLibraryEvents()`
Attaches debounced `input` listeners (300 ms) to `bpLibSearch`, `bpLibMinME`, `bpLibMinTE`, `bpLibMinRuns`; `change` listeners to `bpLibFilter` and `bpLibSort`; and a `click` listener to `toggleLibraryBtn`.

**Calls:** `handleLibraryFilter()` → `toggleLibraryView()` (external)

---

## 3. Blueprint Detail Panel

### `openBlueprintDetail(bp)` *(async)*
Hides the library list and renders a detail panel for the given blueprint object. Shows a loading skeleton while fetching SDE materials, then renders the materials table with adjusted quantities, a **Full Calculator** button, and a **Component Tree** toggle.

**SDE fetch chain:**
1. `window.eveAPI.sdeBlueprintMaterials(bp.type_id, bp.me)` (primary)
2. `fetchFuzzworkMaterials(bp.type_id, bp.me)` (fallback)

**Event listeners attached:**
- `#backToBpLib` → restores library view
- `#bpCalcBtn` → sets `selectedBpTypeId/ME/TE`, calls `openMaterialsInTab()` or `navigateIndustryTab('calculator')`
- `#bpTreeBtn` → calls `buildRecursiveMaterialTree()` then `generateTreeHTML()`

**Calls:** `fetchFuzzworkMaterials()` · `renderMaterialRow()` · `buildRecursiveMaterialTree()` · `generateTreeHTML()` · `escHtml()` · `showToast()` · `navigateIndustryTab()`

---

### `renderMaterialRow(mat)`
Returns an HTML string for a single material row: icon, name (highlighted if `mat.isComponent`), adjusted qty, and struck-through base qty if different.

**Returns:** `string` (HTML)

---

## 4. Material Helpers

### `fetchFuzzworkMaterials(typeId, me)` *(async)*
Fallback when SDE is unavailable. Calls `window.eveAPI.getBlueprintMaterials(typeId)`, applies the ME bonus to each material's base quantity, and returns a normalised result object.

**Calls:** `window.eveAPI.getBlueprintMaterials()` · `applyMEBonus()`

**Returns:** `{ materials, productTypeId: null, productName: null, productQty: 1 }` or `null`

---

### `applyMEBonus(baseQty, me)`
Applies EVE's standard ME formula: `max(1, ceil(baseQty × (1 − me/100)))`. Returns `1` for any base qty ≤ 1.

**Returns:** `number`

---

## 5. Recursive Component Tree

### `getCachedBlueprintMaterials(typeId)` *(async)*
Cache-aware wrapper around `window.eveAPI.getBlueprintMaterials`. Checks the local cache first (key `bp_materials_<typeId>`); stores results for 7 days on miss.

**Calls:** `cacheGet()` · `window.eveAPI.getBlueprintMaterials()` · `cacheSet()`

---

### `buildRecursiveMaterialTree(blueprintTypeId, quantityRequired?)` *(async)*
Recursively fetches materials for a blueprint and all manufacturable sub-components, building a nested tree. Uses `window.eveAPI.findBpForProduct` to check whether each material has its own blueprint.

**Calls:** `getCachedBlueprintMaterials()` · `window.eveAPI.findBpForProduct()` · (recursion)

**Returns:** `Array<{ typeid, name, quantity, subTree }>`

---

### `generateTreeHTML(treeNodes)`
Recursively converts a material tree (from `buildRecursiveMaterialTree`) into a nested `<ul>` HTML string. Sub-components are visually distinguished and call themselves recursively.

**Returns:** `string` (HTML)

---

### `renderTreeResults(blueprintName, meLevel, materialTree)`
Renders a full-page tree view into `#results`, including a **Back to Library** button and the output of `generateTreeHTML`.

**Calls:** `generateTreeHTML()` · `escHtml()`

---

### `backToLibrary()`
Restores `#mainLibraryView` and hides `#results`. Called by an inline `onclick` in `renderTreeResults`.

---

## 6. Industry Page Tab Routing

### `initIndustryPage()`
Clones all `.industry-sub-btn` elements (to strip old listeners) and re-attaches `click` listeners that call `navigateIndustryTab(tab)`.

**Calls:** `navigateIndustryTab()`

---

### `navigateIndustryTab(tab)`
Central router for the industry section. Sets `currentIndustryTab`, updates active button state, and injects the correct content into `#industryTabContent`.

| `tab` value | Action |
|---|---|
| `blueprints` | Renders filter bar + `#bpLibList`, calls `bindLibraryEvents()` + `renderBlueprintList()` |
| `search` | Renders search input, binds debounced `handleManualSearchInput` |
| `cost-index` | Calls `renderCostIndex()` *(external)* |
| `ore` | Calls `renderOreCalculator()` |
| `ice` | Calls `renderIceCalculator()` |
| `gas` | Calls `renderGasCalculator()` |
| anything else | Renders a "Coming soon" placeholder |

**Calls:** `bindLibraryEvents()` · `renderBlueprintList()` · `renderCostIndex()` · `renderOreCalculator()` · `renderIceCalculator()` · `renderGasCalculator()` · `handleManualSearchInput()` (external)

---

## 7. Stubs & Fallback Guards

### `buildCategoryBrowse()` *(stub)*
No-op. Logs to console. Prevents crashes if called before the real implementation loads.

### `handleBlueprintSearch(query)` *(stub)*
No-op. Logs to console.

### `window.handleManualSearchInput` *(fallback guard)*
Set to a warning no-op only if `handleManualSearchInput` is not already defined. Prevents a `ReferenceError` if the search module hasn't loaded.

---

## 8. Ore Calculator

**Static data constants:**
- `ORE_DATA` — 16 ore types across Highsec / Lowsec / Nullsec, each with `typeId`, `volume`, `batchSize`, and mineral yields.
- `MINERAL_IDS` — Map of mineral name → EVE type ID (Tritanium → Morphite).
- `ORE_SELL_IDS` — Map of ore name → raw sell type ID (for fetching unrefined ore prices).

**Module state:** `_oreRefineEff` (default 72.36%), `_oreTaxRate` (default 5%), `_oreSort`, `_orePrices`, `_oreLoading`.

---

### `renderOreCalculator(container)` *(async)*
Injects the full Ore Calculator UI (toolbar, mineral price strip, sortable table) into `container`. Binds toolbar `change` events and column header `click` events, then calls `loadOrePrices()`.

**Event listeners attached:**
- `#oreRefineEff` change → updates `_oreRefineEff`, calls `buildOreTable()`
- `#oreTaxRate` change → updates `_oreTaxRate`, calls `buildOreTable()`
- `#oreRefreshBtn` click → calls `loadOrePrices()`
- `.ore-th` click → updates `_oreSort`, calls `buildOreTable()`

**Calls:** `loadOrePrices()`

---

### `loadOrePrices()` *(async)*
Fetches Jita 4-4 sell prices for all minerals and raw ores in a single IPC call. Updates the mineral price strip in the DOM, then calls `buildOreTable()`.

**Calls:** `window.eveAPI.getJitaPrices()` · `buildOreTable()` · `formatNumber()` · `logToConsole()` · `escHtml()`

---

### `calcOreRow(ore)`
Computes refine ISK/unit, ISK/m³, raw sell/unit, and raw sell/m³ for a single ore using current `_oreRefineEff`, `_oreTaxRate`, and `_orePrices`. Applies EVE's floor rounding on refined mineral quantities.

**Returns:** `{ iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 }`

---

### `buildOreTable()`
Reads all ore rows via `calcOreRow()`, sorts by `_oreSort`, and re-renders `#oreTableBody` with inline progress bars and group colour chips.

**Calls:** `calcOreRow()` · `formatNumber()` · `escHtml()`

---

## 9. Ice Calculator

**Static data constants:**
- `ICE_DATA` — 22 ice types across Highsec / Highsec+ / Lowsec / Compressed, each with `typeId`, `volume`, `batchSize`, and product yields.
- `ICE_PRODUCT_IDS` — Map of product name → EVE type ID (Heavy Water, Liquid Ozone, isotopes, Strontium Clathrates).
- `ICE_SELL_IDS` — Auto-derived from `ICE_DATA` (name → typeId).

**Module state:** `_iceRefineEff`, `_iceTaxRate`, `_iceSort`, `_icePrices`, `_iceLoading`.

---

### `renderIceCalculator(container)` *(async)*
Injects the Ice Calculator UI (toolbar, ice-product price strip, sortable table). Binds the same pattern of toolbar and column-header events as the Ore calculator, then calls `loadIcePrices()`.

**Event listeners attached:**
- `#iceRefineEff` / `#iceTaxRate` change → update state, call `buildIceTable()`
- `#iceRefreshBtn` click → calls `loadIcePrices()`
- `.ice-th` click → updates `_iceSort`, calls `buildIceTable()`

**Calls:** `loadIcePrices()`

---

### `loadIcePrices()` *(async)*
Fetches prices for all ice products and raw ice types. Updates the product price strip, then calls `buildIceTable()`.

**Calls:** `window.eveAPI.getJitaPrices()` · `buildIceTable()` · `formatNumber()` · `logToConsole()` · `escHtml()`

---

### `calcIceRow(ice)`
Computes refine ISK/unit, ISK/m³, raw sell/unit, and raw sell/m³ for a single ice type. Ice uses floor rounding on product quantities but no mineral-style batch size (batchSize = 1 for all ice).

**Returns:** `{ iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 }`

---

### `buildIceTable()`
Reads all ice rows via `calcIceRow()`, sorts by `_iceSort`, and re-renders `#iceTableBody`. Highlights the top row, shows product yield abbreviations, and colour-codes refine vs raw sell comparison.

**Calls:** `calcIceRow()` · `formatNumber()` · `escHtml()`

---

## 10. Gas Calculator

**Static data constants:**
- `GAS_DATA` — 26 gas types across Cytoserocin (lowsec) / Mykoserocin (nullsec) / Fullerite (wormhole) / Pochven.
- `VENTURE_HOLD_M3` — `5000` (Venture gas hold in m³).

**Module state:** `_gasSort`, `_gasPrices`, `_gasLoading`. *(No refine efficiency — gas is sold raw.)*

---

### `renderGasCalculator(container)` *(async)*
Injects the Gas Calculator UI (toolbar, group legend strip, sortable table). Gas has no refining step — values are raw sell prices only. Binds column-header sort and the Refresh button, then calls `loadGasPrices()`.

**Event listeners attached:**
- `#gasRefreshBtn` click → calls `loadGasPrices()`
- `.gas-th` click → updates `_gasSort`, calls `buildGasTable()`

**Calls:** `loadGasPrices()`

---

### `loadGasPrices()` *(async)*
Fetches Jita prices for all gas type IDs. Updates `_gasPrices` and the `#gasPriceAge` timestamp, then calls `buildGasTable()`.

**Calls:** `window.eveAPI.getJitaPrices()` · `buildGasTable()` · `logToConsole()` · `escHtml()`

---

### `buildGasTable()`
Computes ISK/unit, ISK/m³, and ISK/full Venture hold for each gas type, sorts by `_gasSort`, and re-renders `#gasTableBody` with inline progress bars and group colour chips.

**Calls:** `formatNumber()` · `escHtml()`

---

## 11. Connection Map

```
initIndustryPage()
  └─► navigateIndustryTab(tab)
        ├─► [blueprints] bindLibraryEvents() ──► handleLibraryFilter()
        │                                               └─► sortBlueprints()
        │                                               └─► renderBlueprintList()
        │                                                     └─► openBlueprintDetail()  [View btn]
        │                                                           ├─► sdeBlueprintMaterials()  [IPC]
        │                                                           ├─► fetchFuzzworkMaterials()
        │                                                           │     └─► getBlueprintMaterials()  [IPC]
        │                                                           │     └─► applyMEBonus()
        │                                                           ├─► renderMaterialRow()
        │                                                           ├─► buildRecursiveMaterialTree()  [Tree btn]
        │                                                           │     └─► getCachedBlueprintMaterials()
        │                                                           │           └─► getBlueprintMaterials()  [IPC]
        │                                                           │     └─► findBpForProduct()  [IPC]
        │                                                           └─► generateTreeHTML()  (recursive)
        │
        ├─► [ore]  renderOreCalculator()
        │           └─► loadOrePrices() ──► getJitaPrices()  [IPC]
        │                                └─► buildOreTable() ──► calcOreRow()
        │
        ├─► [ice]  renderIceCalculator()
        │           └─► loadIcePrices() ──► getJitaPrices()  [IPC]
        │                                └─► buildIceTable() ──► calcIceRow()
        │
        └─► [gas]  renderGasCalculator()
                    └─► loadGasPrices() ──► getJitaPrices()  [IPC]
                                         └─► buildGasTable()
```

### IPC calls (`window.eveAPI.*`)

| Method | Used by |
|---|---|
| `getAllBlueprintsFromDb()` | `loadBlueprintLibrary` |
| `getAllBlueprints()` | `loadBlueprintLibrary` (fallback) |
| `sdeBlueprintMaterials(typeId, me)` | `openBlueprintDetail` |
| `getBlueprintMaterials(typeId)` | `fetchFuzzworkMaterials`, `getCachedBlueprintMaterials` |
| `findBpForProduct(typeId)` | `buildRecursiveMaterialTree` |
| `getJitaPrices(ids[])` | `loadOrePrices`, `loadIcePrices`, `loadGasPrices` |

### External functions required (not defined in this file)

| Function | Expected source |
|---|---|
| `showToast(msg, type)` | UI utilities |
| `escHtml(str)` | UI utilities |
| `formatNumber(n)` | UI utilities |
| `logToConsole(msg, level)` | UI utilities |
| `cacheGet(key)` / `cacheSet(key, val, days)` | Cache module |
| `toggleLibraryView()` | UI module |
| `openMaterialsInTab(typeId)` | Calculator module |
| `renderCostIndex(container)` | Cost index module |
| `handleManualSearchInput()` | Search/calculator module |