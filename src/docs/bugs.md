# `bugs.js` — Function & Connection Reference

> Bug Report Modal for EVE Carbon. Wrapped in an IIFE to avoid polluting the global scope.
> Renders a modal overlay, collects bug report fields, validates them, and opens a pre-filled `mailto:` link addressed to `bugs@vertexstudios.co.za`.
>
> **Globally exposed:** `window.openBugReport`, `window.closeBugReport`

---

## Table of Contents

1. [Constants](#1-constants)
2. [Functions](#2-functions)
3. [Event Bindings](#3-event-bindings)
4. [Connection Map](#4-connection-map)

---

## 1. Constants

### `BUG_MODAL_HTML`
A static HTML string containing the entire modal structure. Injected into `document.body` once on first open. Key element IDs referenced throughout the module:

| Element ID | Purpose |
|---|---|
| `bugReportBackdrop` | Outer backdrop / visibility toggle |
| `closeBugReportBtn` | Closes the modal |
| `bugSummary` | One-line title input *(required)* |
| `bugCategory` | Category `<select>` (16 options) *(required)* |
| `bugAccount` | Character `<select>`, populated dynamically |
| `bugDescription` | Long description textarea *(required)* |
| `bugRepro` | Reproduction steps textarea *(required)* |
| `bugSeverityGrid` | Container for severity toggle buttons |
| `.bug-sev-btn` | Severity buttons (Low / Medium / High / Critical) |
| `bugNotes` | Optional additional notes textarea |
| `resetBugReportBtn` | Resets all fields |
| `submitBugReportBtn` | Triggers validation and submission |

---

## 2. Functions

### `injectBugModal()`
Inserts `BUG_MODAL_HTML` into `document.body` via `insertAdjacentHTML('beforeend', ...)`. Guards against double-injection by checking for `#bugReportBackdrop` first.

**Calls:** *(DOM only)*

---

### `populateBugAccounts()` *(async)*
Fetches the list of linked EVE accounts via IPC and populates the `#bugAccount` `<select>` with one `<option>` per character. Silently swallows errors (e.g. running outside Electron).

**Calls:** `window.eveAPI.getAccounts()`

---

### `openBugReport()`
The main public entry point (`window.openBugReport`). Injects the modal if not already present, populates the account dropdown, binds all events (idempotent), makes the backdrop visible, and focuses the summary input.

**Calls:** `injectBugModal()` → `populateBugAccounts()` → `bindBugEvents()` → *(DOM focus)*

---

### `closeBugReport()`
The secondary public entry point (`window.closeBugReport`). Hides the backdrop by setting `display: none`. Does nothing if the element doesn't exist.

**Calls:** *(DOM only)*

---

### `resetBugReport()`
Clears all text inputs and textareas (`bugSummary`, `bugDescription`, `bugRepro`, `bugNotes`), resets the category select to `"Launcher"`, clears the account select, and resets severity to **Medium**.

**Calls:** *(DOM only)*

---

### `validateBugReport()`
Checks that `bugSummary`, `bugDescription`, and `bugRepro` are all non-empty. On the first failing field it shows an error toast, focuses that field, and returns `false`. Returns `true` only if all three pass.

**Calls:** `showToast()` *(external)*

**Returns:** `boolean`

---

### `submitBugReport()`
Reads all form field values, builds a formatted plain-text email body, constructs a `mailto:` URI with an encoded subject and body, and triggers it by clicking a temporary `<a>` element. Shows a success toast, logs to the console, and closes the modal.

The email subject format: `[EVE Carbon Bug] [<Severity>] [<Category>] <Summary>`

**Calls:** `validateBugReport()` → `showToast()` → `logToConsole()` → `closeBugReport()`

---

### `bindBugEvents()`
Attaches all event listeners to `document` (event delegation). Guarded by the `_bugEventsBound` flag so it only runs once regardless of how many times `openBugReport()` is called.

**Listeners registered:**

| Trigger | Handler |
|---|---|
| Click `#closeBugReportBtn` | `closeBugReport()` |
| Click `#resetBugReportBtn` | `resetBugReport()` |
| Click `#submitBugReportBtn` | `submitBugReport()` |
| Click on backdrop itself | `closeBugReport()` |
| `Escape` keydown (modal visible) | `closeBugReport()` |
| Click `.bug-sev-btn` | Toggles `bug-sev-active` class |

---

## 3. Event Bindings

All listeners use **event delegation** on `document`, so they survive DOM re-injection. The `_bugEventsBound` boolean prevents duplicate listener registration across multiple `openBugReport()` calls.

```
document click
  ├─ #closeBugReportBtn  ──► closeBugReport()
  ├─ #resetBugReportBtn  ──► resetBugReport()
  ├─ #submitBugReportBtn ──► submitBugReport()
  ├─ #bugReportBackdrop  ──► closeBugReport()   (backdrop click-outside)
  └─ .bug-sev-btn        ──► toggle bug-sev-active

document keydown
  └─ Escape (modal open) ──► closeBugReport()
```

---

## 4. Connection Map

```
window.openBugReport()          [public]
  └─► injectBugModal()
        └─ guards: #bugReportBackdrop exists?
  └─► populateBugAccounts()
        └─► window.eveAPI.getAccounts()  [IPC]
  └─► bindBugEvents()           [idempotent, _bugEventsBound guard]
        └─ delegates to:
             closeBugReport()
             resetBugReport()
             submitBugReport()
               ├─► validateBugReport()
               │     └─► showToast()     [external]
               ├─► showToast()           [external]
               ├─► logToConsole()        [external]
               └─► closeBugReport()

window.closeBugReport()         [public]
  └─ sets #bugReportBackdrop display:none
```

### External dependencies

| Function | Purpose |
|---|---|
| `window.eveAPI.getAccounts()` | Fetches linked EVE character accounts |
| `showToast(msg, type)` | Displays UI toast notifications |
| `logToConsole(msg, level)` | Logs messages to the app's console panel |