# `pageLoader.js` — Function Reference

## Overview

This file is responsible for injecting all page HTML into the app's main navigation container at startup. Rather than fetching page templates from the filesystem or a server, all HTML is defined inline as template literals in a single `PAGE_HTML` object. This approach works natively in Electron's renderer process with no `fetch()` or file I/O required.

> **To add a new page:** add its HTML as a new key in `PAGE_HTML`. No other files need changing.

---

## Data: `PAGE_HTML`

A plain object where each key is a page name and each value is an HTML string (template literal) for that page's full content. Each page wraps its content in a `<div id="page-{name}" class="nav-page">`.

### Pages Defined

| Key | Page ID | Description |
|---|---|---|
| `characters` | `#page-characters` | Character list, SSO login, drag-to-reorder, selected character card |
| `dashboard` | `#page-dashboard` | Net worth, industry jobs, and character status overview |
| `industry` | `#page-industry` | Sub-navigation hub for all industry tools (blueprints, calculator, reactions, etc.) |
| `assets` | `#page-assets` | Local database asset browser with search and filters |
| `wallets` | `#page-wallets` | Wallet balances per character, combined liquid wealth display |
| `fc` | `#page-fc` | Fleet Commander tools (placeholder — coming soon) |
| `map` | `#page-map` | Map and navigation (placeholder — coming soon) |
| `pi` | `#page-pi` | Planetary Interaction colony monitor |
| `forums` | `#page-forums` | Forums and community links (placeholder — coming soon) |
| `jabber` | `#page-jabber` | Jabber XMPP client — message table, connection status, director bot filter |
| `market` | `#page-market` | Market data and trading tools (placeholder — coming soon) |

### Notable DOM Elements Declared Inside `PAGE_HTML`

These IDs are injected into the document by `loadAllPages()` and are subsequently referenced by other scripts:

| Element ID | Page | Purpose |
|---|---|---|
| `#selectedCharacterSection` | characters | Shown/hidden when a character is selected |
| `#selectedCharPortrait` | characters | Character portrait `<img>` |
| `#selectedCharName` | characters | Character name display |
| `#selectedCharMeta` | characters | Character metadata (corp, alliance, etc.) |
| `#charSearch` | characters | Search input for filtering characters |
| `#addCharacterNavBtn` | characters | "Add Character" button for EVE SSO login |
| `#accountsListNav` | characters | Grid container for character cards |
| `#dashboardWelcomeBanner` | dashboard | Welcome/status banner |
| `#dashboardContent` | dashboard | Dashboard grid layout |
| `#dashboardNetworthSummary` | dashboard | Net worth panel content |
| `#dashboardJobsTable` | dashboard | Finished industry jobs table |
| `#industryTabContent` | industry | Populated by `navigateIndustryTab()` |
| `#assetSummary` | assets | Summary text (e.g. "1,234 items") |
| `#assetSearch` | assets | Item search input (calls `filterAssets()`) |
| `#assetCharFilter` | assets | Character filter dropdown (calls `filterAssets()`) |
| `#assetRegionFilter` | assets | Region filter dropdown (calls `filterAssets()`) |
| `#walletsSummary` | wallets | Wallet summary text |
| `#walletsTotalRow` | wallets | Combined wealth row (hidden until loaded) |
| `#walletsTotalValue` | wallets | Combined ISK value display |
| `#walletsGrid` | wallets | Grid of per-character wallet cards |
| `#piContainer` | pi | Populated by the PI module |
| `#jabberStatus` | jabber | Connection status label |
| `#jabberSummary` | jabber | Message count summary |
| `#jabberTable` | jabber | Incoming message table |

### Inline `onclick` Handlers in Templates

These function calls are wired directly in the injected HTML and must exist in the global scope:

| Handler | Declared In | Triggered By |
|---|---|---|
| `closePage('characters')` | external | ✕ button on Characters page |
| `clearSelectedCharacter()` | external | ✕ button on selected character card |
| `closePage('dashboard')` | external | ✕ button on Dashboard page |
| `closePage('industry')` | external | ✕ button on Industry page |
| `closePage('assets')` | external | ✕ button on Assets page |
| `filterAssets()` | external | `oninput` on `#assetSearch`, `onchange` on filter dropdowns |
| `closePage('wallets')` | external | ✕ button on Wallets page |
| `closePage('fc')` | external | ✕ button on Fleet Commander page |
| `closePage('map')` | external | ✕ button on Map page |
| `closePage('pi')` | external | ✕ button on PI page |
| `closePage('forums')` | external | ✕ button on Forums page |
| `closePage('jabber')` | external | ✕ button on Jabber page |
| `closePage('market')` | external | ✕ button on Market page |

---

## Functions

### `loadAllPages()`

Iterates over every entry in `PAGE_HTML` and injects each page's HTML into `#navPagesContainer`.

- Creates a temporary `<div>`, sets its `innerHTML` to the template string, then moves all child nodes directly into the container (avoiding a wrapper element per page).
- Logs an error and returns early if `#navPagesContainer` is not found in the DOM.
- Called synchronously — no async work involved.

**Connects to:**

| Dependency | Role |
|---|---|
| `PAGE_HTML` | Source of all page HTML strings |
| `#navPagesContainer` (DOM) | Target container where all pages are injected |

---

## Module-Level Bootstrap: `window.__pagesReady`

```js
window.__pagesReady = new Promise(resolve => { ... });
```

Exposes a Promise on the global `window` object so that `app.js` (and any other script) can `await window.__pagesReady` before interacting with page elements.

- If the DOM is still loading (`document.readyState === 'loading'`), it waits for `DOMContentLoaded` before calling `loadAllPages()`, then resolves.
- If the DOM is already ready, it calls `loadAllPages()` immediately and resolves at once.
- Since `loadAllPages()` is synchronous, the promise resolves in the same tick after injection.

**Connects to:**

| Dependency | Role |
|---|---|
| `loadAllPages()` | Called as part of the resolution sequence |
| `window.__pagesReady` | Consumed by `app.js` (and potentially other scripts) via `await` |
| `DOMContentLoaded` (event) | Guards injection until the DOM is ready |

---

## Execution Flow

```
Script loads
    │
    ├─ DOM still loading? ──yes──► wait for DOMContentLoaded
    │                                      │
    └─ DOM already ready? ──yes──►         ▼
                                    loadAllPages()
                                           │
                               Inject each PAGE_HTML entry
                               into #navPagesContainer
                                           │
                                  window.__pagesReady resolves
                                           │
                                    app.js continues
```

---

## External Dependencies Summary

### Functions Expected in Global Scope

| Function | Called From |
|---|---|
| `closePage(pageName)` | `onclick` in every page's ✕ button |
| `clearSelectedCharacter()` | `onclick` in characters page selected-char card |
| `filterAssets()` | `oninput` / `onchange` in assets page toolbar |
| `navigateIndustryTab(tabName)` | Expected to populate `#industryTabContent` (called externally, referenced in a comment) |

### DOM Elements Expected to Pre-Exist

| Element ID | Required By |
|---|---|
| `#navPagesContainer` | `loadAllPages()` — all pages are injected here |

### Consumed By

| Consumer | How |
|---|---|
| `app.js` | `await window.__pagesReady` before accessing any injected page elements |