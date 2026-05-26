# `materials.js` — Function Reference

## Overview

This file handles two main UI flows in an EVE Online industry tool:

1. **Materials Modal** — fetches and displays a blueprint's required materials and estimated Jita market cost.
2. **Manual Blueprint Search** — lets users search for blueprints/items by name, view details, and trigger the materials modal.

---

## Materials Modal

### `openMaterialsInTab(typeId)`

**Entry point** for loading the materials modal.

- Calls `window.eveAPI.getAllBlueprints()` to look up the blueprint matching `typeId`, extracting its name and ME (Material Efficiency) level.
- Calls `buildRecursiveMaterialTree(typeId, 1)` to build the full material tree.
  - If that fails, falls back to `window.eveAPI.getProductForBlueprint(typeId)` and retries with the product's type ID.
- On success, calls `showMaterialsModal()` to render the modal.
- On failure, shows an error toast via `showToast()`.

**Connects to:**
| Dependency | Role |
|---|---|
| `window.eveAPI.getAllBlueprints()` | Fetches full blueprint list |
| `window.eveAPI.getProductForBlueprint(typeId)` | Fallback: resolves blueprint → product |
| `buildRecursiveMaterialTree(typeId, qty)` | Builds nested material tree |
| `showMaterialsModal()` | Renders the modal UI |
| `showToast()` | Displays status/error messages |

---

### `closeMaterialsModal()`

Hides the materials modal by setting `display: none` on `#materialsModalBackdrop`.

**Connects to:**
| Dependency | Role |
|---|---|
| `#materialsModalBackdrop` (DOM) | The modal overlay element |

---

### `showMaterialsModal(typeId, bpName, meLevel, materialTree)`

Populates and displays the materials modal with blueprint info, market pricing, and a materials table.

- Sets the blueprint icon (`#materialsModalIcon`) and title (`#materialsModalTitle`).
- If `materialTree` is empty, renders a "not in public database" message.
- Otherwise, flattens the material tree to get unique type IDs and total quantities.
- Calls `window.eveAPI.getJitaPrices(typeIds)` to fetch Jita sell/buy prices and calculate a total estimated cost.
- Calls `generateMaterialsTable()` to build the HTML table of materials.
- Renders the ME level badge, price display, and materials table into `#materialsModalBody`.

**Connects to:**
| Dependency | Role |
|---|---|
| `#materialsModalBackdrop` (DOM) | Modal container — shown by setting `display: flex` |
| `#materialsModalIcon` (DOM) | Blueprint image element |
| `#materialsModalTitle` (DOM) | Modal heading text |
| `#materialsModalBody` (DOM) | Main content area for materials & pricing |
| `window.eveAPI.getJitaPrices(typeIds)` | Fetches live Jita market prices |
| `generateMaterialsTable()` | Renders the materials HTML table |
| `formatNumber()` | Formats ISK values with commas |
| `escHtml()` | Sanitises strings before injecting into HTML |

---

### `generateMaterialsTable(treeNodes, priceData)`

Builds and returns an HTML string for a table of required materials.

- Iterates over `treeNodes`, each representing one material line.
- For each node, looks up unit price from `priceData` (preferring sell price over buy price).
- Highlights rows with sub-trees (intermediate manufactured components) using `var(--accent)` colour and the `◈` icon; raw materials use `⬡`.
- Returns a `<table>` HTML string, or a fallback message if the node list is empty.

**Connects to:**
| Dependency | Role |
|---|---|
| `priceData` (argument) | Price map keyed by type ID, sourced from `getJitaPrices()` |
| `formatNumber()` | Formats quantities and prices |
| `escHtml()` | Sanitises material names |
| CSS variables (`--accent`, `--text-1`, etc.) | Theming — expects the app's CSS custom properties |

---

## Manual Blueprint Search

### `handleManualSearchInput()`

Triggered on input changes in the `#bpName` search field. Implements a live-search dropdown.

- Ignores queries shorter than 2 characters.
- Calls `window.eveAPI.search(query)` and takes up to 12 `inventory_type` results.
- Resolves names for each type ID via `window.eveAPI.sdeGetName()` (SDE lookup) and `window.eveAPI.getNames()` (ESI batch lookup), merging both sources.
- Renders results as clickable items in `#searchDropdown`, each calling `selectManualSearchItem()` on click.

**Connects to:**
| Dependency | Role |
|---|---|
| `#bpName` (DOM) | Search text input |
| `#searchDropdown` (DOM) | Dropdown container for results |
| `window.eveAPI.search(query)` | EVE type name search |
| `window.eveAPI.sdeGetName(id)` | SDE name lookup per type ID |
| `window.eveAPI.getNames(ids)` | ESI batch name resolution |
| `selectManualSearchItem()` | Called when the user picks a result |
| `escHtml()` | Sanitises names in dropdown HTML |

---

### `selectManualSearchItem(item)`

Handles user selection from the search dropdown.

- Sets `#bpName` input value to the selected item's name.
- Hides `#searchDropdown`.
- Calls `loadManualBlueprintSearch()` to fetch and display blueprint details.

**Connects to:**
| Dependency | Role |
|---|---|
| `#bpName` (DOM) | Search input field |
| `#searchDropdown` (DOM) | Dropdown to hide after selection |
| `loadManualBlueprintSearch()` | Loads full blueprint details into the results panel |

---

### `loadManualBlueprintSearch(typeId, itemName)`

Fetches blueprint details for a selected item and renders a result card with a "View Materials" button.

- Shows `#selectedBpCard` with the item icon and name.
- Calls `window.eveAPI.findBpForProduct(typeId)` to look up blueprint metadata (blueprint type ID, max production limit).
- Updates `#selectedBpMeta` with blueprint details or a "not found" message.
- Renders a result panel in `#results` with blueprint icon, name, type ID, and a **View Materials** button.
- The "View Materials" button calls `openMaterialsInTab(typeId)` when clicked.

**Connects to:**
| Dependency | Role |
|---|---|
| `#selectedBpCard` (DOM) | Card element shown after selection |
| `#selectedBpIcon` (DOM) | Blueprint image inside the card |
| `#selectedBpName` (DOM) | Item name inside the card |
| `#selectedBpMeta` (DOM) | Blueprint metadata text |
| `#results` (DOM) | Panel where the result card is rendered |
| `#manual-view-materials` (DOM, dynamic) | Button injected into `#results` |
| `window.eveAPI.findBpForProduct(typeId)` | Looks up blueprint metadata for a product type |
| `openMaterialsInTab(typeId)` | Opens the materials modal on button click |
| `showToast()` | Shows "Calculating materials..." status message |
| `escHtml()` | Sanitises names before rendering |

---

## External Dependencies Summary

### `window.eveAPI` Methods Used

| Method | Called By |
|---|---|
| `getAllBlueprints()` | `openMaterialsInTab` |
| `getProductForBlueprint(typeId)` | `openMaterialsInTab` (fallback) |
| `getJitaPrices(typeIds)` | `showMaterialsModal` |
| `search(query)` | `handleManualSearchInput` |
| `sdeGetName(id)` | `handleManualSearchInput` |
| `getNames(ids)` | `handleManualSearchInput` |
| `findBpForProduct(typeId)` | `loadManualBlueprintSearch` |

### Global Utilities Used

| Utility | Purpose |
|---|---|
| `buildRecursiveMaterialTree(typeId, qty)` | Constructs nested bill-of-materials tree |
| `showToast(message, type)` | Displays UI toast notifications |
| `formatNumber(value)` | Formats numbers (ISK amounts, quantities) |
| `escHtml(string)` | Escapes HTML special characters to prevent XSS |

### DOM Elements Referenced

| Element ID | Used In |
|---|---|
| `#materialsModalBackdrop` | `showMaterialsModal`, `closeMaterialsModal` |
| `#materialsModalIcon` | `showMaterialsModal` |
| `#materialsModalTitle` | `showMaterialsModal` |
| `#materialsModalBody` | `showMaterialsModal` |
| `#bpName` | `handleManualSearchInput`, `selectManualSearchItem` |
| `#searchDropdown` | `handleManualSearchInput`, `selectManualSearchItem` |
| `#selectedBpCard` | `loadManualBlueprintSearch` |
| `#selectedBpIcon` | `loadManualBlueprintSearch` |
| `#selectedBpName` | `loadManualBlueprintSearch` |
| `#selectedBpMeta` | `loadManualBlueprintSearch` |
| `#results` | `loadManualBlueprintSearch` |
| `#manual-view-materials` | `loadManualBlueprintSearch` (injected dynamically) |