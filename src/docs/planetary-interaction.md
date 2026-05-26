# `planetary-interaction.js` — Function Reference

## Overview

This module handles loading, filtering, and rendering of EVE Online Planetary Interaction (PI) data. It fetches colony data for all authenticated characters from the local database, pre-fetches jump distances from the EVE ESI route API, and renders an interactive colony browser with filter controls.

---

## Module-Level Constants & State

### `PI_PLANET_TYPE_IDS`

A lookup table mapping planet type names (lowercase strings) to their EVE type IDs. Used to construct icon URLs for colony cards via `https://images.evetech.net/types/{id}/icon?size=64`.

| Key | Type ID |
|---|---|
| `temperate` | 11 |
| `oceanic` | 2014 |
| `ice` | 12 |
| `gas` | 13 |
| `lava` | 2015 |
| `barren` | 2016 (also the fallback) |
| `storm` | 2017 |
| `plasma` | 2063 |
| `shattered` | 30889 |

### Module State Variables

| Variable | Type | Purpose |
|---|---|---|
| `_piAllCharData` | Array | Stores colony data for all characters after loading. Each entry is `{ charId, charName, portraitUrl, colonies[] }`. Reset on each `loadPlanetaryInteraction()` call. |
| `_piJumpCache` | Object | Key-value cache of jump distances. Keys are `"originId:destId"` strings; values are jump counts (integers) or `null` on failure. |
| `_piOriginSysId` | Number\|null | Solar system ID of the reference character's current location. Used as the origin for all jump distance calculations. |
| `_piOriginSysName` | String | Display name of the origin system, shown in the range filter label. |

---

## Functions

### `loadPlanetaryInteraction()`

**Entry point** for the PI page. Orchestrates data loading and kicks off rendering.

- Clears all module state and shows a loading message in `#piContainer`.
- Calls `window.eveAPI.getAccounts()` to get all authenticated characters; shows an empty state if none exist.
- Calls `loadCharacterColonies()` for every account in parallel via `Promise.allSettled()`, collecting only fulfilled results that have at least one colony.
- Shows a "No Colonies Found" empty state if no colonies exist across all characters.
- Determines the **reference character** for jump distance calculations: prefers the character matching `selectedCharacterId` (global), falls back to the first account.
- Calls `window.eveAPI.getCharacterData()` on the reference character to get their current solar system.
- If an origin system is found, calls `prefetchJumpDistances()` to warm the jump cache.
- Calls `renderPIShell()` to build the full UI.
- On any uncaught error, renders a "Network Error" state in `#piContainer`.

**Connects to:**

| Dependency | Role |
|---|---|
| `#piContainer` (DOM) | Target container — injected by `pageLoader.js` in the `pi` page template |
| `window.eveAPI.getAccounts()` | Fetches all authenticated character accounts |
| `window.eveAPI.getCharacterData(charId)` | Gets reference character's location (solar system) |
| `loadCharacterColonies(account)` | Loads colony data per character |
| `prefetchJumpDistances(originSysId, charData)` | Pre-warms jump distance cache |
| `renderPIShell(container)` | Renders the filter bar and colony body |
| `selectedCharacterId` (global) | Used to pick the reference character for jump calculations |

---

### `loadCharacterColonies(account)`

Loads colony data for a single character from the local database.

- Normalises the character ID from varying account object shapes (`characterId`, `character_id`, or `id`).
- Calls `window.eveAPI.getCharacterData(charId)` and extracts the character name, falling back through multiple fields if needed.
- Returns a character data object: `{ charId, charName, portraitUrl, colonies }`.
- The portrait URL is constructed directly from the EVE image server; no separate API call is made.
- `colonies` comes from `data?.piColonies` — an empty array if not present.

**Connects to:**

| Dependency | Role |
|---|---|
| `window.eveAPI.getCharacterData(charId)` | Reads character info and `piColonies` from local DB |
| EVE image server | Portrait URL built as `https://images.evetech.net/characters/{charId}/portrait?size=64` |

**Returns:** `{ charId, charName, portraitUrl, colonies[] }`

---

### `prefetchJumpDistances(originSysId, charData)`

Pre-fetches jump distances from the origin system to every unique colony system, populating `_piJumpCache`.

- Collects all unique `solar_system_id` values across all colonies, excluding the origin system itself (which is always 0 jumps).
- For each unique system, checks `_piJumpCache` first to avoid duplicate requests.
- Calls the EVE ESI route API directly: `GET /latest/route/{origin}/{destination}/`
- On success, stores `response.length - 1` as the jump count (the route array includes the origin system, so minus one gives the actual jump count).
- On failure (network error or non-OK response), stores `null` for that system.
- All fetches run in parallel via `Promise.allSettled()`.

**Connects to:**

| Dependency | Role |
|---|---|
| `_piJumpCache` (module state) | Written to — keyed as `"originId:destId"` |
| `https://esi.evetech.net/latest/route/{o}/{d}/` | EVE ESI route API — called directly via `fetch()` |

---

### `getJumps(colonySysId)`

Looks up the cached jump distance from the origin system to a given colony's solar system.

- Returns `0` if the colony is in the same system as the origin.
- Returns `null` if no origin is set or if the system isn't in the cache.
- Otherwise returns the integer jump count from `_piJumpCache`.

**Connects to:**

| Dependency | Role |
|---|---|
| `_piOriginSysId` (module state) | Origin system for comparison |
| `_piJumpCache` (module state) | Source of cached jump distances |

**Returns:** `Number | null`

---

### `renderPIShell(container)`

Builds and injects the full PI page UI into the container — the header, filter bar, and an empty colony body div — then wires up event listeners and runs the initial filter pass.

- Counts total colonies and derives the full lists of planet types, system names, and character names from `_piAllCharData` to populate filter dropdowns.
- Disables the range filter dropdown if no origin system is known (`_piOriginSysId` is null).
- Sets the range filter label to show the origin system name if available.
- Injects the complete HTML shell including `#piColonyCount`, `#piFilterChar`, `#piFilterType`, `#piFilterSystem`, `#piFilterRange`, `#piFilterReset`, and `#piColonyBody`.
- Attaches `change` listeners on all four filter dropdowns → `applyPIFilters()`.
- Attaches `click` listener on the reset button → `resetPIFilters()`.
- Calls `applyPIFilters()` immediately to render the initial (unfiltered) colony list.

**Connects to:**

| Dependency | Role |
|---|---|
| `_piAllCharData` (module state) | Source data for colony counts and filter options |
| `_piOriginSysId` / `_piOriginSysName` (module state) | Controls range filter availability and label |
| `#piColonyCount` (DOM, injected) | Colony/character count badge |
| `#piFilterChar` (DOM, injected) | Character filter dropdown |
| `#piFilterType` (DOM, injected) | Planet type filter dropdown |
| `#piFilterSystem` (DOM, injected) | Solar system filter dropdown |
| `#piFilterRange` (DOM, injected) | Jump range filter dropdown |
| `#piFilterReset` (DOM, injected) | Reset filters button |
| `#piColonyBody` (DOM, injected) | Colony card grid — populated by `applyPIFilters()` |
| `applyPIFilters()` | Called on every filter change and on initial render |
| `resetPIFilters()` | Called on reset button click |
| `escHtml()` | Sanitises system name in filter label |

---

### `applyPIFilters()`

Reads the current filter values, filters `_piAllCharData` accordingly, and re-renders `#piColonyBody`.

- Reads values from all four filter dropdowns (`#piFilterChar`, `#piFilterType`, `#piFilterSystem`, `#piFilterRange`).
- Converts the range value to a `maxJumps` integer (or `null` for "any").
- Filters characters by ID, then filters each character's colonies by planet type, system name, and jump distance (using `getJumps()`).
- Removes characters with zero remaining colonies after filtering.
- Updates `#piColonyCount` with the filtered count, adding a "filtered" badge if any filter is active.
- If nothing matches, renders a "No Colonies Match" empty state.
- Otherwise builds a per-character section for each character, calling `buildColonyCard()` for each colony and injecting the result into `#piColonyBody`.

**Connects to:**

| Dependency | Role |
|---|---|
| `_piAllCharData` (module state) | Source data to filter |
| `#piFilterChar` / `#piFilterType` / `#piFilterSystem` / `#piFilterRange` (DOM) | Filter controls |
| `#piColonyCount` (DOM) | Updated with filtered counts |
| `#piColonyBody` (DOM) | Re-rendered with filtered colony cards |
| `getJumps(solarSystemId)` | Resolves jump distance for range filtering |
| `buildColonyCard(colony, portraitUrl, charName)` | Generates HTML for each colony card |
| `escHtml()` | Sanitises character names in portrait `alt` attributes |

---

### `resetPIFilters()`

Resets all four filter dropdowns to `"all"` and re-runs `applyPIFilters()`.

**Connects to:**

| Dependency | Role |
|---|---|
| `#piFilterChar`, `#piFilterType`, `#piFilterSystem`, `#piFilterRange` (DOM) | Reset to `"all"` |
| `applyPIFilters()` | Called after resetting to re-render the full unfiltered list |

---

### `buildColonyCard(colony, portraitUrl, charName)`

Builds and returns the HTML string for a single colony card.

- Determines status (`active` / `warning` / `idle`) from `colony.is_extracting` and `colony.storage_full`.
- Looks up the planet type ID from `PI_PLANET_TYPE_IDS` (falls back to `2016` — barren — if unknown).
- Calls `getPlanetLabel()` to build the display name (e.g. "Jita IV").
- Calls `getJumps()` to get the jump distance and assigns a CSS class (`same`, `near-green`, `near-yellow`, `far-red`, `far`) based on proximity.
- Renders the jump badge only if `_piOriginSysId` is set.
- Returns a `<div class="pi-card">` HTML string containing: planet icon, owner portrait, planet name/type, CC level badge, jump badge, installation count, system name, and status bar.

**Connects to:**

| Dependency | Role |
|---|---|
| `PI_PLANET_TYPE_IDS` (constant) | Maps planet type → EVE type ID for icon URL |
| `getPlanetLabel(colony)` | Generates the planet display name |
| `getJumps(solarSystemId)` | Gets jump distance for the jump badge |
| `_piOriginSysId` (module state) | Controls whether the jump badge is shown |
| EVE image server | Planet icon: `https://images.evetech.net/types/{typeId}/icon?size=64` |
| `escHtml()` | Sanitises planet type, character name, system name |

**Returns:** HTML string (`<div class="pi-card">...</div>`)

---

### `getPlanetLabel(colony)`

Generates a human-readable planet label from a colony object.

- Uses `colony.solar_system_name` as the system name (falls back to `"Unknown System"`).
- Takes `colony.planet_id % 100` as the planet number within its system.
- Converts that number to a Roman numeral (I–XVI) using a hardcoded array.
- Returns a string in the format `"SystemName IV"`.
- If the number is out of the 1–16 range, uses the raw number or `"?"` as the suffix.

**Connects to:** nothing external — pure helper function.

**Returns:** `String` (e.g. `"Dodixie IX"`)

---

## Data Flow

```
loadPlanetaryInteraction()
        │
        ├─ getAccounts() ──────────────────────────────► all characters
        │
        ├─ loadCharacterColonies() × N ───────────────► _piAllCharData
        │         └─ getCharacterData(charId)
        │
        ├─ getCharacterData(refCharId) ───────────────► _piOriginSysId / _piOriginSysName
        │
        ├─ prefetchJumpDistances() ───────────────────► _piJumpCache
        │         └─ fetch ESI /route/{o}/{d}/ × N
        │
        └─ renderPIShell(container)
                  │
                  └─ applyPIFilters()  ◄──── filter dropdowns (on change)
                            │
                            └─ buildColonyCard() × N
                                      ├─ getJumps()
                                      └─ getPlanetLabel()
```

---

## External Dependencies Summary

### `window.eveAPI` Methods Used

| Method | Called By |
|---|---|
| `getAccounts()` | `loadPlanetaryInteraction` |
| `getCharacterData(charId)` | `loadPlanetaryInteraction` (reference char), `loadCharacterColonies` |

### External APIs Called Directly

| Endpoint | Called By | Purpose |
|---|---|---|
| `https://esi.evetech.net/latest/route/{o}/{d}/` | `prefetchJumpDistances` | Jump distance between two solar systems |
| `https://images.evetech.net/types/{id}/icon?size=64` | `buildColonyCard` | Planet type icon |
| `https://images.evetech.net/characters/{id}/portrait?size=64` | `loadCharacterColonies` | Character portrait URL |

### Global Utilities Used

| Utility | Purpose |
|---|---|
| `escHtml(string)` | Sanitises strings before injecting into HTML |
| `selectedCharacterId` | Global variable — determines the reference character for jump distance origin |

### DOM Elements Referenced

| Element ID | Set By | Used By |
|---|---|---|
| `#piContainer` | `pageLoader.js` (pi page template) | `loadPlanetaryInteraction` — root render target |
| `#piColonyCount` | `renderPIShell` | `applyPIFilters` — updated with filtered counts |
| `#piFilterChar` | `renderPIShell` | `applyPIFilters`, `resetPIFilters` |
| `#piFilterType` | `renderPIShell` | `applyPIFilters`, `resetPIFilters` |
| `#piFilterSystem` | `renderPIShell` | `applyPIFilters`, `resetPIFilters` |
| `#piFilterRange` | `renderPIShell` | `applyPIFilters`, `resetPIFilters` |
| `#piFilterReset` | `renderPIShell` | `resetPIFilters` (via click listener) |
| `#piColonyBody` | `renderPIShell` | `applyPIFilters` — re-rendered on every filter change |