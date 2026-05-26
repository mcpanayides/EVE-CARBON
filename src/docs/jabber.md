# `jabber.js` — Function & Connection Reference

---

## Module-Level State (external, referenced by this file)

| Variable | Purpose |
|---|---|
| `jabberMessages` | Array of received XMPP message objects `{ from, body, type, isDirector }` |
| `jabberFilterDirectorOnly` | Boolean toggle — when true, only director messages are shown |
| `jabberSettings` | Object holding the active Jabber config (service, jid, password, directorOnly) |
| `jabberConnected` | Boolean reflecting current connection status |

---

## Functions

### `renderJabberTable()`
**Purpose:** Re-renders the `#jabberTable tbody` with the current message list, applying the `jabberFilterDirectorOnly` filter if active. Displays a "No messages" placeholder when the list is empty. Always calls `updateJabberSummary()` after rendering.

**Calls:**
| Called function | Why |
|---|---|
| `updateJabberSummary()` | Refresh the message count label after every render |
| `escHtml(str)` | Sanitise `from`, `body`, and `type` fields before injecting into HTML |

---

### `updateJabberSummary()`
**Purpose:** Updates the `#jabberSummary` element with the current visible message count, respecting the `jabberFilterDirectorOnly` state. Handles singular/plural label correctly.

**No outbound calls** — pure DOM write using module state.

---

### `populateJabberSettings()` *(async)*
**Purpose:** Loads the saved Jabber configuration from the app config and populates the settings form fields (`#jabberService`, `#jabberJid`, `#jabberPassword`, `#jabberDirectorOnly`). Also writes the loaded values into the `jabberSettings` module variable. Supports two config shapes (`cfg.app.jabber` and `cfg.jabber`).

**Calls:**
| Called function/API | Why |
|---|---|
| `window.eveAPI.getAppConfig()` | Retrieve the persisted application configuration |

---

### `gatherJabberSettings()`
**Purpose:** Reads the current values from the settings form fields and returns them as a plain object `{ service, jid, password, directorOnly }`. Falls back to sane defaults if fields are missing. Used before saving or connecting.

**No outbound calls** — pure DOM read.

---

### `autoConnectJabber()` *(async)*
**Purpose:** Reads Jabber credentials directly from `getAppConfig()` and attempts an automatic connection on startup. Updates the `#jabberStatus` label throughout. Shows error toasts if the connection fails or credentials are missing.

**Calls:**
| Called function/API | Why |
|---|---|
| `window.eveAPI.getAppConfig()` | Read saved credentials for auto-connect |
| `window.eveAPI.connectJabber({ service, jid, password })` | Initiate the XMPP connection via main process |
| `showToast(msg, type)` | Display error feedback to the user on failure |

---

### `bindJabberEvents()`
**Purpose:** Wires up all Jabber-related event listeners. Called once from `bindEvents()` during app initialisation. Registers three listeners:

1. **`#jabberDirectorOnly` change** — updates `jabberFilterDirectorOnly` and re-renders the table.
2. **`jabber-message` IPC event** — pushes incoming messages onto `jabberMessages` and re-renders the table.
3. **`jabber-status` IPC event** — updates `jabberConnected`, refreshes nav status indicators, and updates the `#jabberStatus` label.

**Calls:**
| Called function/API | Why |
|---|---|
| `renderJabberTable()` | Re-render on filter change or new incoming message |
| `window.eveAPI.on('jabber-message', ...)` | Subscribe to incoming XMPP messages from main process |
| `window.eveAPI.on('jabber-status', ...)` | Subscribe to connection status updates from main process |
| `updateNavStatusIndicators()` | Refresh nav bar connection badge on status change |

---

## External Dependencies

| Dependency | Source | Used by |
|---|---|---|
| `window.eveAPI.getAppConfig()` | Electron IPC / preload | `populateJabberSettings`, `autoConnectJabber` |
| `window.eveAPI.connectJabber(credentials)` | Electron IPC / preload | `autoConnectJabber` |
| `window.eveAPI.on('jabber-message', ...)` | Electron IPC / preload | `bindJabberEvents` |
| `window.eveAPI.on('jabber-status', ...)` | Electron IPC / preload | `bindJabberEvents` |
| `showToast(msg, type)` | Global UI utility | `autoConnectJabber` |
| `updateNavStatusIndicators()` | Global UI utility | `bindJabberEvents` |
| `escHtml(str)` | Global utility | `renderJabberTable` |
| `bindEvents()` | App initialisation | Calls `bindJabberEvents()` |

---

## Call Graph

```
bindJabberEvents()                             ← called once from bindEvents()
├── window.eveAPI.on('jabber-message', ...)
│   └── renderJabberTable()
│       ├── escHtml()
│       └── updateJabberSummary()
├── window.eveAPI.on('jabber-status', ...)
│   └── updateNavStatusIndicators()
└── [#jabberDirectorOnly change]
    └── renderJabberTable()
        ├── escHtml()
        └── updateJabberSummary()

populateJabberSettings()
└── window.eveAPI.getAppConfig()

gatherJabberSettings()
└── (DOM reads only)

autoConnectJabber()
├── window.eveAPI.getAppConfig()
├── window.eveAPI.connectJabber()
└── showToast()
```