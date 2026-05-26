# `characters.js` — Function & Connection Reference

---

## Functions

### `loadAccounts()` *(async)*
**Purpose:** Fetches all saved EVE accounts and renders them as draggable character cards in the `#accountsListNav` element.

**Key behaviour:**
- Calls `window.eveAPI.getAccounts()` to retrieve accounts.
- Reads `char_card_order` from `localStorage` to restore the user's saved drag order.
- Builds each card with a portrait, name, character ID, SYNC button, and REMOVE button.
- Applies an `● ACTIVE` badge to the currently selected character.
- Falls back to an empty-state message if no accounts exist.
- Auto-selects the first character if none is currently selected.
- Calls `window._applyAutoSyncStateIfActive()` on each new card to handle mid-sync state.

**Calls:**
| Called function/API | Why |
|---|---|
| `window.eveAPI.getAccounts()` | Load stored accounts |
| `selectCharacter(acc)` | Auto-select first character if none active |
| `window.eveAPI.removeAccount(id)` | Remove button handler |
| `showToast(...)` | User feedback on remove/sync |
| `loadAccounts()` *(self)* | Refresh list after removal |
| `loadBlueprintLibrary()` | Refresh blueprints after removal or successful sync |
| `window.eveAPI.syncCharacterFull(id)` | Sync button handler — full character sync |
| `logToConsole(msg, level)` | Output sync progress to the app console bar |
| `window.eveAPI.on('char-sync-progress', ...)` | Subscribe to sync step events during sync |
| `window.eveAPI.off('char-sync-progress', ...)` | Unsubscribe after sync completes/fails |
| `saveCharacterOrder()` | Called on `dragend` to persist reordered cards |
| `window._applyAutoSyncStateIfActive(id, card)` | Apply syncing UI state to newly built cards |

---

### `selectCharacter(account)`
**Purpose:** Sets the active character, updates the detail panel (`#selectedCharacterSection`), highlights the active card, and shows a success toast.

**Calls:**
| Called function/API | Why |
|---|---|
| `updateNavCharacterBtn(account)` | Update the nav bar character button |
| `showToast(...)` | Notify user of active character |

---

### `clearSelectedCharacter()`
**Purpose:** Clears the active character selection, hides the detail panel, removes all active badges and highlights, and resets the nav button.

**Calls:**
| Called function/API | Why |
|---|---|
| `updateNavCharacterBtn(null)` | Reset nav bar character button |
| `showToast(...)` | Notify user selection was cleared |

---

### `saveCharacterOrder()`
**Purpose:** Reads the current DOM order of `.character-card` elements inside `#accountsListNav` and persists it to `localStorage` as `char_card_order`.

**No outbound calls** — pure DOM read + `localStorage` write.

---

## IIFEs (Self-Executing Functions)

### `initCharSyncProgressListener()` *(IIFE)*
**Purpose:** Registers a global listener on `window.eveAPI.on('char-sync-progress', ...)` to route sync step events to the app console bar. Also triggers a `loadAccounts()` refresh when a sync completes.

**Calls:**
| Called function/API | Why |
|---|---|
| `window.eveAPI.on('char-sync-progress', ...)` | Subscribe to IPC sync progress events |
| `logToConsole(msg, level)` | Show step labels in the console bar |
| `loadAccounts()` | Refresh cards when sync is `done` |

---

### `initAutoSyncCardListener()` *(IIFE)*
**Purpose:** Listens for `auto-sync` CustomEvents (dispatched by `autoRefreshStaleCharacters()` in `dashboard.js`) and mirrors the SYNC button spinner/state on the matching character card — covering both cards already in the DOM and cards rendered after the event fires.

**Exposes on `window`:**
- `window._applyAutoSyncStateIfActive(characterId, card)` — called inside `loadAccounts()` to apply syncing state to a freshly built card if that character is already mid-sync.

**Inner helpers:**
- `getCardElements(characterId)` — Finds the card, sync button, and spinner for a given character ID.
- `ensureSpinner(card, btn)` — Creates or shows the spinner element next to the sync button.

**Calls:**
| Called function/API | Why |
|---|---|
| `document.addEventListener('auto-sync', ...)` | Listen for phase start/done/error from dashboard |
| `getCardElements(characterId)` | Resolve card DOM elements |
| `ensureSpinner(card, btn)` | Show spinner on card |
| `_autoSyncingIds` *(from `dashboard.js`)* | Check if a character is currently auto-syncing |

---

## External Dependencies

| Dependency | Source | Used by |
|---|---|---|
| `window.eveAPI.getAccounts()` | Electron IPC / preload | `loadAccounts` |
| `window.eveAPI.removeAccount(id)` | Electron IPC / preload | `loadAccounts` (remove btn) |
| `window.eveAPI.syncCharacterFull(id)` | Electron IPC / preload | `loadAccounts` (sync btn) |
| `window.eveAPI.on(event, handler)` | Electron IPC / preload | `loadAccounts`, `initCharSyncProgressListener` |
| `window.eveAPI.off(event, handler)` | Electron IPC / preload | `loadAccounts` |
| `showToast(msg, type)` | Global UI utility | `loadAccounts`, `selectCharacter`, `clearSelectedCharacter` |
| `logToConsole(msg, level)` | Global UI utility | `loadAccounts`, `initCharSyncProgressListener` |
| `loadBlueprintLibrary()` | External JS (blueprints page) | `loadAccounts` |
| `updateNavCharacterBtn(account)` | External JS (nav) | `selectCharacter`, `clearSelectedCharacter` |
| `escHtml(str)` | Global utility | `loadAccounts` (card HTML) |
| `_autoSyncingIds` *(Set)* | `dashboard.js` | `initAutoSyncCardListener` / `_applyAutoSyncStateIfActive` |
| `localStorage` (`char_card_order`) | Browser storage | `loadAccounts`, `saveCharacterOrder` |
| EVE Online portrait CDN | `images.evetech.net` | Character portrait `<img>` tags |

---

## Connection / Call Graph

```
loadAccounts()
├── window.eveAPI.getAccounts()
├── selectCharacter()
│   ├── updateNavCharacterBtn()
│   └── showToast()
├── saveCharacterOrder()          ← on dragend
├── window._applyAutoSyncStateIfActive()
├── [remove btn click]
│   ├── window.eveAPI.removeAccount()
│   ├── showToast()
│   ├── loadAccounts()            ← self-refresh
│   └── loadBlueprintLibrary()
└── [sync btn click]
    ├── window.eveAPI.on('char-sync-progress', progressHandler)
    ├── window.eveAPI.syncCharacterFull()
    ├── logToConsole()
    ├── showToast()
    ├── loadBlueprintLibrary()    ← on success
    └── window.eveAPI.off('char-sync-progress', progressHandler)

selectCharacter()
├── updateNavCharacterBtn()
└── showToast()

clearSelectedCharacter()
├── updateNavCharacterBtn()
└── showToast()

saveCharacterOrder()
└── localStorage.setItem()

initCharSyncProgressListener()   (IIFE)
├── window.eveAPI.on('char-sync-progress', ...)
├── logToConsole()
└── loadAccounts()               ← on step 'done'

initAutoSyncCardListener()       (IIFE)
├── document.addEventListener('auto-sync', ...)
├── getCardElements()
├── ensureSpinner()
└── exposes window._applyAutoSyncStateIfActive()
```