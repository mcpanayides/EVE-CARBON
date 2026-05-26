# `ui.js` — Function Reference

## Overview

This file owns all top-level UI behaviour that isn't specific to a single page — the settings drawer, sidebar navigation, nav status indicators, the blueprint library toggle, database sync controls, and the first-run station seed. It wires up event listeners, manages shared visual state, and delegates to page-specific load functions when the user navigates.

---

## Settings Drawer

### `setSettingsTab(tab)`

Switches the active tab inside the settings drawer.

- Updates `currentSettingsTab` (global, `state.js`) to the new tab key.
- Toggles the `active` class on all `.settings-menu-btn` elements — the button whose `data-settings-tab` matches `tab` becomes active.
- Shows the matching `.settings-tab` panel (`#settingsTab{Tab}`) and hides all others. The panel ID is derived by capitalising the first letter of `tab` (e.g. `'jabber'` → `#settingsTabJabber`).
- If `tab === 'database'`, calls `populateDatabaseSettings()` to refresh the last-synced timestamps immediately.

**Connects to:**

| Dependency | Role |
|---|---|
| `currentSettingsTab` (`state.js`) | Written with the new tab key |
| `.settings-menu-btn` (DOM) | Tab buttons — `active` class toggled |
| `.settings-tab` (DOM) | Tab content panels — shown/hidden by ID match |
| `populateDatabaseSettings()` | Called when the database tab is opened |

---

### `bindUISettings()`

Attaches all event listeners for the settings drawer. Called once at startup from `app.js`.

- **Open button** (`#openSettingsBtn`): shows `#uiSettingsDrawer`, calls `populateSettingsInputs()` to fill in saved values, then calls `setSettingsTab()` to restore the last active tab.
- **Close button** (`#closeSettingsBtn`): hides the drawer.
- **Backdrop click** (click on `#uiSettingsDrawer` itself, not its children): hides the drawer.
- **Tab buttons** (`.settings-menu-btn`): calls `setSettingsTab(btn.dataset.settingsTab)` on each click.
- **Save button** (`#saveSettingsBtn`): calls `saveAllSettings()`, hides the drawer, shows a success toast.

**Connects to:**

| Dependency | Role |
|---|---|
| `#openSettingsBtn` (DOM) | Triggers drawer open |
| `#uiSettingsDrawer` (DOM) | The drawer container — shown/hidden |
| `#closeSettingsBtn` (DOM) | Triggers drawer close |
| `#saveSettingsBtn` (DOM) | Triggers save |
| `.settings-menu-btn` (DOM) | Tab switcher buttons |
| `populateSettingsInputs()` | Fills saved values into inputs on open |
| `setSettingsTab()` | Restores active tab on open; called on tab click |
| `saveAllSettings()` | Persists settings on save |
| `showToast()` | Shows "Settings saved." confirmation |

---

### `populateSettingsInputs()`

Populates all settings inputs with their currently saved values when the drawer opens.

- Always calls `populateJabberSettings()` to fill in Jabber connection fields.
- If the database tab is currently active (`currentSettingsTab === 'database'`), also calls `populateDatabaseSettings()`.

**Connects to:**

| Dependency | Role |
|---|---|
| `currentSettingsTab` (`state.js`) | Checked to decide whether to populate the database tab |
| `populateJabberSettings()` | Fills Jabber JID, password, service, director filter into their inputs |
| `populateDatabaseSettings()` | Fills last-synced timestamps — only if database tab is active |

---

### `saveAllSettings()`

Gathers all settings from the drawer inputs and persists them via IPC.

- Calls `gatherJabberSettings()` to read current Jabber input values.
- Calls `window.eveAPI.saveAppConfig({ jabber })` to write the config to disk via the main process.

**Connects to:**

| Dependency | Role |
|---|---|
| `gatherJabberSettings()` | Reads Jabber fields from the DOM and returns a settings object |
| `window.eveAPI.saveAppConfig(config)` | IPC → `app-save-config` — persists to disk |

---

## Navigation

### `bindNavigation()`

Attaches all sidebar navigation event listeners. Called once at startup from `app.js`.

- **Nav toggle button** (`#navToggleBtn`): calls `toggleNavigation()` on click.
- **Nav buttons** (`.nav-btn`): each calls `navigateToPage(btn.dataset.page)` on click.
- **Industry menu button** (`#industryMenuBtn`): toggles `#industryMenu` open/closed. Stops click propagation to prevent the document-level dismiss listener from immediately closing it.
- **Industry menu items** (`.industry-menu-btn` inside `#industryMenu`):
  - If the clicked button is `#menuMyBlueprints`, calls `toggleLibraryView()`.
  - Otherwise calls `navigateToPage(btn.dataset.page)`.
  - Always closes the menu after a selection.
- **Document click**: closes `#industryMenu` when clicking anywhere outside it.

**Connects to:**

| Dependency | Role |
|---|---|
| `#navToggleBtn` (DOM) | Sidebar collapse/expand toggle |
| `.nav-btn` (DOM) | All top-level page navigation buttons |
| `#industryMenuBtn` (DOM) | Opens/closes the industry dropdown menu |
| `#industryMenu` (DOM) | The dropdown container |
| `#menuMyBlueprints` (DOM) | Special industry menu item for the blueprint library |
| `.industry-menu-btn` (DOM) | Clickable items inside the industry dropdown |
| `toggleNavigation()` | Collapses/expands the sidebar |
| `navigateToPage(page)` | Navigates to the selected page |
| `toggleLibraryView()` | Shows/hides the blueprint library panel |

---

### `toggleNavigation()`

Toggles the sidebar between expanded and collapsed (icon-only) mode.

- Flips `navCollapsed` (global, `state.js`).
- Adds/removes `nav-collapsed` class on `#sidebarNav` and `collapsed` class on `#navToggleBtn`.
- Updates the toggle button's text content to `'◀'` (collapsed) or `'▶'` (expanded).

**Connects to:**

| Dependency | Role |
|---|---|
| `navCollapsed` (`state.js`) | Flipped on each call |
| `#sidebarNav` (DOM) | `nav-collapsed` class toggled |
| `#navToggleBtn` (DOM) | `collapsed` class and text content updated |

---

### `navigateToPage(page)`

Navigates the app to a top-level page.

- Hides `#mainLibraryView` and shows `#navPagesContainer`.
- Removes `active` from all `.nav-page` elements, then adds it to `#page-{page}`.
- Updates `active` class on all `.nav-btn` elements to match the new page.
- Sets `currentPage` (global, `state.js`) to the new page key.
- Calls the appropriate page-load function for the target page:

| Page key | Load function called |
|---|---|
| `'characters'` | `loadAccounts()` |
| `'dashboard'` | `loadDashboard()` |
| `'assets'` | `loadAssets()` |
| `'wallets'` | `renderWallets()` |
| `'industry'` | `initIndustryPage()` |
| `'pi'` | `loadPlanetaryInteraction()` |

**Connects to:**

| Dependency | Role |
|---|---|
| `currentPage` (`state.js`) | Written with the new page key |
| `#mainLibraryView` (DOM) | Hidden on navigation |
| `#navPagesContainer` (DOM) | Shown on navigation |
| `.nav-page` (DOM) | `active` class managed |
| `.nav-btn` (DOM) | `active` class managed |
| `#page-{page}` (DOM) | Injected by `pageLoader.js`; activated by adding `active` |
| `loadAccounts()` | Characters page loader |
| `loadDashboard()` | Dashboard page loader |
| `loadAssets()` | Assets page loader |
| `renderWallets()` | Wallets page renderer |
| `initIndustryPage()` | Industry page initialiser |
| `loadPlanetaryInteraction()` | PI page loader (`planetary-interaction.js`) |

---

## Nav Status Lights

### `setNavStatusLight(id, online)`

Sets a nav status indicator element to online (green) or offline (grey) state.

- Finds the element by `id`, then finds the `.status-light` child within it.
- Toggles `status-online` and `status-offline` CSS classes based on the `online` boolean.
- Sets the light's `title` attribute to `'Connected'` or `'Disconnected'`.

**Connects to:**

| Dependency | Role |
|---|---|
| DOM element by `id` | Parent container for the status light |
| `.status-light` (DOM child) | The coloured dot element |

---

### `updateNavStatusIndicators()`

Refreshes all nav status lights to reflect current connection state.

- Currently calls `setNavStatusLight('jabberNavStatus', jabberConnected)`.
- Designed to be called whenever a connection status changes (e.g. from the `jabber-status` IPC event handler).

**Connects to:**

| Dependency | Role |
|---|---|
| `jabberConnected` (`state.js`) | Read to determine current Jabber connection state |
| `setNavStatusLight()` | Updates the `#jabberNavStatus` indicator |

---

### `updateNavCharacterBtn(account)`

Updates the Characters nav button to display the selected character's portrait and name, or resets it to the default icon if no character is selected.

- If `account` is provided: replaces the button's content with a portrait `<img>` (128px, falling back to 64px on error) and a `<span>` with the character name. Sets `btn.title` to `"Active: {name}"`.
- If `account` is `null`/falsy: restores the default `⚔` icon and `'Characters'` label.

**Connects to:**

| Dependency | Role |
|---|---|
| `.nav-btn-characters` (DOM) | The nav button whose content is replaced |
| EVE image server | Portrait URL: `https://images.evetech.net/characters/{id}/portrait?size=128` (64px fallback) |

---

## Blueprint Library

### `toggleLibraryView()`

Shows or hides the blueprint library panel and updates the toggle button label.

- Flips `isLibraryVisible` (global, `state.js`).
- Sets `#mainLibraryView` display to `'flex'` or `'none'`.
- Updates `#toggleLibraryBtn` text and title to `'Hide my blueprint library'` or `'Show my blueprint library'`.

**Connects to:**

| Dependency | Role |
|---|---|
| `isLibraryVisible` (`state.js`) | Flipped on each call |
| `#mainLibraryView` (DOM) | The library panel — shown/hidden |
| `#toggleLibraryBtn` (DOM) | Label updated to reflect visibility state |

---

### `clearSelection()`

Clears the selected blueprint card UI back to an empty state.

- Hides `#selectedBpCard`.
- Clears `src` on `#selectedBpIcon`, and `textContent` on `#selectedBpName` and `#selectedBpMeta`.

**Connects to:**

| Dependency | Role |
|---|---|
| `#selectedBpCard` (DOM) | Hidden |
| `#selectedBpIcon` (DOM) | `src` cleared |
| `#selectedBpName` (DOM) | Text cleared |
| `#selectedBpMeta` (DOM) | Text cleared |

---

## Database Settings Tab

### `populateDatabaseSettings()`

Populates the Database settings tab with last-synced timestamps for both NPC stations and Upwell structures.

- Calls `window.eveAPI.getStationSyncTimestamp()` twice — once for `'npc_stations'` and once for `'upwell_structures'`.
- Passes each timestamp to `_formatSyncAge()` to produce a human-readable age string (e.g. `"3 hours ago"`).
- Updates `#dbSyncLastSynced` and `#dbUpwellLastSynced` with the results, or `'Never synced'` if the timestamp is `0`/falsy.
- On error, sets both elements to `'Unknown'`.
- Called by `setSettingsTab()` when the database tab is opened, and conditionally by `populateSettingsInputs()`.

**Connects to:**

| Dependency | Role |
|---|---|
| `window.eveAPI.getStationSyncTimestamp({ key })` | IPC → `get-station-sync-timestamp` — returns ms epoch or `0` |
| `_formatSyncAge(ts)` | Converts a ms epoch timestamp to a human-readable age string |
| `#dbSyncLastSynced` (DOM) | NPC station last-synced label |
| `#dbUpwellLastSynced` (DOM) | Upwell structure last-synced label |

---

### `_formatSyncAge(ts)`

Pure helper — converts a millisecond epoch timestamp to a human-readable relative age string.

| Result | Condition |
|---|---|
| `'Just now'` | Less than 2 minutes ago |
| `'{N} minutes ago'` | Less than 1 hour ago |
| `'{N} hour(s) ago'` | Less than 1 day ago |
| `'{N} day(s) ago'` | 1 day or more ago |

Connects to nothing external — pure utility function.

**Returns:** `String`

---

### `triggerStationSync()`

Handles the "Sync NPC Stations" button in the Database settings tab. Runs a full NPC station + Upwell structure sync with animated progress feedback.

- Locks the button (`#dbSyncStationsBtn`) — disables it, reduces opacity, spins the icon (`#dbSyncBtnIcon`), shows the progress bar (`#dbSyncProgressWrap`).
- Fires two staged `setTimeout` calls to animate the progress bar at realistic intervals while the long-running IPC call is in flight:
  - Immediately: 20% — "Downloading NPC station list from Hoboleaks SDE…"
  - After 20 s: 85% — "Resolving system and region names via ESI…"
- Calls `window.eveAPI.syncStationDatabase({ force: true })` and awaits the result.
- On success: fills the bar to 100%, updates `#dbSyncLastSynced` to `'Just now'`, shows a success toast.
- On skipped/error: shows the appropriate label and error toast.
- On exception: turns the progress bar red and shows an error toast.
- In all cases (`finally`): unlocks the button after 3 s, then resets progress bar and labels after a further 4 s.

**Connects to:**

| Dependency | Role |
|---|---|
| `#dbSyncStationsBtn` (DOM) | Sync button — locked during operation |
| `#dbSyncBtnIcon` (DOM) | Animated spin icon |
| `#dbSyncStatus` (DOM) | Status text label |
| `#dbSyncProgressWrap` (DOM) | Progress bar container |
| `#dbSyncProgressBar` (DOM) | The progress bar fill element |
| `#dbSyncProgressLabel` (DOM) | Text label inside the progress bar |
| `#dbSyncLastSynced` (DOM) | "Last synced" timestamp label |
| `window.eveAPI.syncStationDatabase({ force })` | IPC → `sync-station-database` — the long-running sync operation |
| `showToast()` | Success, info, or error notification |

---

### `triggerUpwellSync()`

Handles the "Sync Upwell Structures" button in the Database settings tab. Mirrors `triggerStationSync()` exactly but targets the Upwell structure database and its own set of DOM elements.

- Same lock/unlock pattern and two-stage progress animation as `triggerStationSync()`.
- Calls `window.eveAPI.syncUpwellDatabase({ force: true })` instead.
- On success, reports the number of Upwell structures synced.

**Connects to:**

| Dependency | Role |
|---|---|
| `#dbSyncUpwellBtn` (DOM) | Sync button — locked during operation |
| `#dbUpwellBtnIcon` (DOM) | Animated spin icon |
| `#dbUpwellStatus` (DOM) | Status text label |
| `#dbUpwellProgressWrap` (DOM) | Progress bar container |
| `#dbUpwellProgressBar` (DOM) | The progress bar fill element |
| `#dbUpwellProgressLabel` (DOM) | Text label inside the progress bar |
| `#dbUpwellLastSynced` (DOM) | "Last synced" timestamp label |
| `window.eveAPI.syncUpwellDatabase({ force })` | IPC → `sync-upwell-database` — the long-running sync operation |
| `showToast()` | Success, info, or error notification |

---

## First-Run Seed

### `autoSeedNpcStations()`

Silently seeds the NPC station database on first launch if it has never been synced. Called once by `app.js` after the DB is initialised.

- Calls `window.eveAPI.getStationSyncTimestamp({ key: 'npc_stations' })` to check if a sync has ever run.
- If a valid timestamp exists, returns immediately — nothing to do.
- If not, logs to console, shows an info toast, and calls `window.eveAPI.syncStationDatabase({ force: false })`. `force: false` means the main process will respect its 24-hour guard on subsequent calls, so this won't re-seed unnecessarily.
- On completion, shows a success toast with the number of NPC stations loaded.
- All errors are caught and logged as warnings — this is a background operation and should never block startup.

**Connects to:**

| Dependency | Role |
|---|---|
| `window.eveAPI.getStationSyncTimestamp({ key })` | IPC → `get-station-sync-timestamp` — checks whether a seed has already run |
| `window.eveAPI.syncStationDatabase({ force })` | IPC → `sync-station-database` — runs the background seed |
| `showToast()` | Info toast on start, success toast on completion |

---

## External Dependencies Summary

### `window.eveAPI` Methods Used

| Method | Called By |
|---|---|
| `saveAppConfig(config)` | `saveAllSettings` |
| `getStationSyncTimestamp({ key })` | `populateDatabaseSettings`, `autoSeedNpcStations` |
| `syncStationDatabase({ force })` | `triggerStationSync`, `autoSeedNpcStations` |
| `syncUpwellDatabase({ force })` | `triggerUpwellSync` |

### Page Load Functions Called by `navigateToPage()`

| Function | Defined In | Page |
|---|---|---|
| `loadAccounts()` | `characters.js` (implied) | `characters` |
| `loadDashboard()` | `dashboard.js` (implied) | `dashboard` |
| `loadAssets()` | assets module | `assets` |
| `renderWallets()` | wallets module | `wallets` |
| `initIndustryPage()` | industry module | `industry` |
| `loadPlanetaryInteraction()` | `planetary-interaction.js` | `pi` |

### Functions Expected in Global Scope (called but not defined here)

| Function | Purpose |
|---|---|
| `populateJabberSettings()` | Fills Jabber inputs from saved config |
| `gatherJabberSettings()` | Reads Jabber inputs and returns a settings object |
| `showToast(message, type)` | UI toast notifications |

### Global State Variables Used

| Variable | (`state.js`) | Read / Written |
|---|---|---|
| `currentSettingsTab` | Read (to restore tab on open), Written (by `setSettingsTab`) |
| `navCollapsed` | Read + Written by `toggleNavigation` |
| `currentPage` | Written by `navigateToPage` |
| `isLibraryVisible` | Read + Written by `toggleLibraryView` |
| `jabberConnected` | Read by `updateNavStatusIndicators` |

### DOM Elements Referenced

| Element | Used By |
|---|---|
| `#openSettingsBtn` | `bindUISettings` |
| `#uiSettingsDrawer` | `bindUISettings` |
| `#closeSettingsBtn` | `bindUISettings` |
| `#saveSettingsBtn` | `bindUISettings` |
| `.settings-menu-btn` | `bindUISettings`, `setSettingsTab` |
| `.settings-tab` | `setSettingsTab` |
| `#navToggleBtn` | `bindNavigation`, `toggleNavigation` |
| `.nav-btn` | `bindNavigation`, `navigateToPage` |
| `#industryMenuBtn` | `bindNavigation` |
| `#industryMenu` | `bindNavigation` |
| `#menuMyBlueprints` | `bindNavigation` |
| `.industry-menu-btn` | `bindNavigation` |
| `#sidebarNav` | `toggleNavigation` |
| `#mainLibraryView` | `navigateToPage`, `toggleLibraryView` |
| `#navPagesContainer` | `navigateToPage` |
| `.nav-page` | `navigateToPage` |
| `#page-{page}` | `navigateToPage` (injected by `pageLoader.js`) |
| `.nav-btn-characters` | `updateNavCharacterBtn` |
| `#jabberNavStatus` | `updateNavStatusIndicators` → `setNavStatusLight` |
| `#mainLibraryView` | `toggleLibraryView` |
| `#toggleLibraryBtn` | `toggleLibraryView` |
| `#selectedBpCard` | `clearSelection` |
| `#selectedBpIcon` | `clearSelection` |
| `#selectedBpName` | `clearSelection` |
| `#selectedBpMeta` | `clearSelection` |
| `#dbSyncLastSynced` | `populateDatabaseSettings`, `triggerStationSync` |
| `#dbUpwellLastSynced` | `populateDatabaseSettings`, `triggerUpwellSync` |
| `#dbSyncStationsBtn` | `triggerStationSync` |
| `#dbSyncBtnIcon` | `triggerStationSync` |
| `#dbSyncStatus` | `triggerStationSync` |
| `#dbSyncProgressWrap` | `triggerStationSync` |
| `#dbSyncProgressBar` | `triggerStationSync` |
| `#dbSyncProgressLabel` | `triggerStationSync` |
| `#dbSyncUpwellBtn` | `triggerUpwellSync` |
| `#dbUpwellBtnIcon` | `triggerUpwellSync` |
| `#dbUpwellStatus` | `triggerUpwellSync` |
| `#dbUpwellProgressWrap` | `triggerUpwellSync` |
| `#dbUpwellProgressBar` | `triggerUpwellSync` |
| `#dbUpwellProgressLabel` | `triggerUpwellSync` |