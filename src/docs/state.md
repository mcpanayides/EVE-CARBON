# `state.js` — Shared Application State Reference

## Overview

This file is the single source of truth for all mutable global state in the application. In a plain-script (non-module) Electron renderer setup, every variable declared here becomes a `window`-level global, accessible by any other script loaded in the same renderer context.

No functions are exported or called here at startup beyond building the `BP_LOOKUP` index. The intent is that all other modules **read and write these variables directly** rather than managing their own isolated state.

---

## Blueprint & Industry State

These variables track the currently selected blueprint and calculator settings, used primarily by the industry calculator and blueprint library UI.

| Variable | Default | Type | Purpose |
|---|---|---|---|
| `selectedBpTypeId` | `null` | Number\|null | EVE type ID of the currently selected blueprint. |
| `selectedBpName` | `null` | String\|null | Display name of the currently selected blueprint. |
| `selectedME` | `3` | Number | Material Efficiency level applied to blueprint calculations. |
| `selectedTE` | `2` | Number | Time Efficiency level applied to blueprint calculations. |
| `currentResults` | `null` | Object\|null | Holds the result set from the most recent industry calculation. |
| `allLibBPs` | `[]` | Array | Full list of blueprints loaded into the blueprint library panel. |
| `searchTimer` | `null` | Timer\|null | Debounce timer handle for the main blueprint search input. |
| `manualSearchTimer` | `null` | Timer\|null | Debounce timer handle for the manual blueprint search input (materials page). |
| `currentSort` | `'name'` | String | Active sort key for the blueprint library list (e.g. `'name'`, `'me'`). |
| `isLibraryVisible` | `false` | Boolean | Whether the blueprint library side panel is currently shown. |
| `filterPerfectOnly` | `false` | Boolean | When `true`, the library filters to show only perfect ME blueprints. |
| `currentIndustryTab` | `null` | String\|null | The currently active sub-tab within the Industry page (e.g. `'blueprints'`, `'calculator'`). |

---

## Navigation & UI State

| Variable | Default | Type | Purpose |
|---|---|---|---|
| `navCollapsed` | `false` | Boolean | Whether the sidebar navigation is in collapsed (icon-only) mode. |
| `currentPage` | `null` | String\|null | The key of the currently active top-level nav page (e.g. `'industry'`, `'assets'`). Compared against `PAGE_HTML` keys from `pageLoader.js`. |
| `currentSettingsTab` | `'jabber'` | String | The active tab within the settings modal. Defaults to `'jabber'`. |
| `selectedCharacterId` | `null` | Number\|null | The character ID of the globally selected character. Read by `planetary-interaction.js` to pick the reference character for jump distance calculations. |

---

## Jabber (XMPP) State

| Variable | Default | Type | Purpose |
|---|---|---|---|
| `jabberSettings` | *(see below)* | Object | Persisted Jabber connection config. Written from the settings modal, read by the Jabber connect logic. |
| `jabberMessages` | `[]` | Array | In-memory list of received Jabber messages, rendered in the `#jabberTable`. |
| `jabberFilterDirectorOnly` | `true` | Boolean | When `true`, only messages from director bots are shown in the Jabber table. |
| `jabberConnected` | `false` | Boolean | Tracks whether the Jabber client is currently connected. Used to update `#jabberStatus`. |

### `jabberSettings` Shape

```js
{
  service:      'xmpp://jabber.eveonline.com:5222',  // XMPP server URL
  jid:          '',                                   // Jabber ID (user@domain)
  password:     '',                                   // Jabber password
  directorOnly: true,                                 // Filter non-director messages
}
```

---

## Assets State

| Variable | Default | Type | Purpose |
|---|---|---|---|
| `allAssetsCache` | `null` | Array\|null | Full unfiltered asset list loaded from the DB. `null` until first load. |
| `filteredAssetsCache` | `null` | Array\|null | The subset of assets currently visible after search/filter is applied. |
| `assetsRenderPos` | `0` | Number | Cursor position for virtual/chunked rendering — tracks how many asset rows have been rendered so far. |

---

## Constants

| Constant | Value | Purpose |
|---|---|---|
| `ASSET_CHUNK` | `200` | Number of asset rows rendered per batch. Used by the chunked asset renderer to avoid blocking the UI on large asset lists. |
| `priceCache` | `{}` | In-memory price cache keyed by `typeId`. Each entry is `{ buy, sell }`. Populated lazily as prices are fetched; never persisted to disk. |
| `ESI_IMAGE` | `'https://images.evetech.net/types'` | Base URL for EVE type icon images. Append `/{typeId}/icon?size=64` (or `/bp?size=64` for blueprints) to build a full URL. |

---

## Blueprint Lookup Index

### `BP_LOOKUP`

A plain object built at startup from `EVE_CATEGORIES` (defined in `categories.js`). Maps lowercase blueprint names to their blueprint type IDs.

```js
// Built as:
EVE_CATEGORIES.forEach(cat => {
  cat.items.forEach(item => {
    BP_LOOKUP[item.name.toLowerCase()] = item.bpId;
  });
});
```

- Keys are lowercased blueprint names (e.g. `"tritanium mining crystal i blueprint"`).
- Values are blueprint type IDs (`bpId`).
- Built once at script load time; treated as read-only after that.

**Depends on:** `EVE_CATEGORIES` (global, defined in `categories.js`) — must be loaded before `state.js`.

---

### `getBpIdFromName(name)`

Looks up a blueprint's type ID by its name using the pre-built `BP_LOOKUP` index.

- Lowercases the input before lookup, so the search is case-insensitive.
- Returns the `bpId` integer if found, or `undefined` if the name isn't in the index.

**Connects to:**

| Dependency | Role |
|---|---|
| `BP_LOOKUP` | Source index — built from `EVE_CATEGORIES` at load time |

**Returns:** `Number | undefined`

---

## Load Order Requirement

`state.js` must be loaded **after** `categories.js` and **before** any module that reads from `BP_LOOKUP` or any of the state variables above. The `BP_LOOKUP` index is built synchronously at script parse time using `EVE_CATEGORIES`, so `categories.js` must already be evaluated.

```
categories.js  →  state.js  →  all other modules
```

---

## Cross-Module Usage Reference

| Variable / Constant | Read By | Written By |
|---|---|---|
| `selectedCharacterId` | `planetary-interaction.js` → `loadPlanetaryInteraction` | Character selection UI |
| `selectedBpTypeId` / `selectedBpName` | Industry calculator, materials modal | Blueprint library / search |
| `selectedME` / `selectedTE` | Industry calculator | Calculator input handlers |
| `currentResults` | Industry results renderer | Calculator logic |
| `allLibBPs` | Blueprint library renderer | Blueprint sync / load |
| `searchTimer` / `manualSearchTimer` | Search input handlers (debounce) | Search input handlers |
| `currentSort` | Blueprint library sort UI | Sort button handlers |
| `isLibraryVisible` | Library panel toggle | Library toggle button |
| `filterPerfectOnly` | Blueprint library filter | Filter toggle button |
| `navCollapsed` | Nav render logic | Nav toggle button |
| `currentPage` | Nav active-state rendering | `navigateToPage()` |
| `currentSettingsTab` | Settings modal tab renderer | Settings tab buttons |
| `currentIndustryTab` | Industry tab renderer | `navigateIndustryTab()` |
| `jabberSettings` | Jabber connect logic | Settings modal save |
| `jabberMessages` | `#jabberTable` renderer | `window.eveAPI.on('jabber-message')` handler |
| `jabberFilterDirectorOnly` | Jabber message filter | Settings modal / filter toggle |
| `jabberConnected` | `#jabberStatus` renderer | `window.eveAPI.on('jabber-status')` handler |
| `allAssetsCache` / `filteredAssetsCache` | `filterAssets()`, asset renderer | Asset load / `filterAssets()` |
| `assetsRenderPos` | Chunked asset renderer | Asset renderer scroll handler |
| `ASSET_CHUNK` | Chunked asset renderer | — (constant) |
| `priceCache` | Price fetch logic | Price fetch logic |
| `ESI_IMAGE` | Any module building type icon URLs | — (constant) |
| `BP_LOOKUP` | `getBpIdFromName()` | Built once at load from `EVE_CATEGORIES` |
| `getBpIdFromName()` | Industry / blueprint search modules | — |