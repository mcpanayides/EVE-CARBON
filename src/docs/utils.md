# `utils.js` — Function Reference

## Overview

This file is the shared utility layer for the entire renderer. It contains no page-specific logic — every function here is a pure helper or a general-purpose UI primitive used across multiple modules. It is the most widely depended-on file in the codebase; `escHtml`, `formatNumber`, `showToast`, and `logToConsole` are called from virtually every other script.

One self-initialising IIFE (`initConsoleToggle`) runs automatically at load time to wire up the console expand/collapse behaviour.

---

## String & Number Formatting

### `escHtml(str)`

Escapes a string for safe injection into HTML, preventing XSS.

Replaces the four dangerous HTML characters:

| Character | Escaped As |
|---|---|
| `&` | `&amp;` |
| `<` | `&lt;` |
| `>` | `&gt;` |
| `"` | `&quot;` |

Coerces the input to a string via `String(str)` before processing, so non-string values (numbers, `null`, etc.) are safe to pass.

Connects to nothing external — pure utility function.

**Returns:** `String`

**Called by:** `materials.js`, `planetary-interaction.js`, `pageLoader.js`, `ui.js`, `logToConsole()`, and any other module that injects user-derived or API-derived text into HTML.

---

### `formatNumber(num)`

Rounds a number to the nearest integer and formats it with locale-appropriate thousands separators (e.g. `1234567` → `'1,234,567'`).

Connects to nothing external — pure utility function.

**Returns:** `String`

**Called by:** `materials.js` (quantities, unit prices, totals in the materials table).

---

### `formatISK(value)`

Formats an ISK value into a short, human-readable string with magnitude suffix. Returns `'0 ISK'` for falsy or non-numeric input.

| Range | Format | Example |
|---|---|---|
| ≥ 1 trillion | `{N}.XX T ISK` | `'1.23 T ISK'` |
| ≥ 1 billion | `{N}.XX B ISK` | `'456.78 B ISK'` |
| ≥ 1 million | `{N}.XX M ISK` | `'12.34 M ISK'` |
| ≥ 1 thousand | `{N}.X K ISK` | `'9.5 K ISK'` |
| < 1 thousand | `{N} ISK` | `'842 ISK'` |

Connects to nothing external — pure utility function.

**Returns:** `String`

---

### `formatCurrency(value)`

Formats a number as a USD currency string using the browser's `Intl.NumberFormat` API, with no decimal places (e.g. `1234567` → `'$1,234,567'`). Returns `'N/A'` if the input is not a number.

Connects to nothing external — pure utility function.

**Returns:** `String`

---

## Animated Counter

### `countUp(el, targetValue, duration = 1200)`

Animates a DOM element's text content counting up (or down) from its current displayed value to `targetValue` over `duration` milliseconds using a cubic ease-out curve.

- Reads the starting value from `el.dataset.currentVal` (set by a previous call), falling back to `0`.
- Stores `targetValue` in `el.dataset.currentVal` so a subsequent call can animate from where it left off.
- Uses `requestAnimationFrame` for the animation loop — no `setInterval`.
- Easing formula: `1 - (1 - progress)³` — fast start, gentle finish.
- Formats the animated value with `toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`.
- Returns immediately (no-op) if `el` is falsy.

**Connects to:**

| Dependency | Role |
|---|---|
| `el` (DOM element, argument) | Target element whose `textContent` is animated |
| `el.dataset.currentVal` | Persists the last target value on the element itself for smooth chaining |
| `requestAnimationFrame` | Browser animation API — drives the tick loop |

**Returns:** `void`

---

## Toast Notifications

### `showToast(msg, type = 'info')`

Creates and displays a self-dismissing toast notification in the bottom-right corner of the screen.

- Creates a `<div>` styled as a fixed-position pill using CSS variables for theming.
- Colour is chosen by `type`:

| `type` | Colour CSS variable |
|---|---|
| `'success'` | `var(--success)` |
| `'error'` | `var(--danger)` |
| `'info'` (default) | `var(--accent)` |

- Appends the toast to a `.toast-layer` container div. If `.toast-layer` doesn't exist yet, it is created and appended to `document.body` first. Multiple toasts stack inside this layer.
- Automatically removes the toast element after 15 seconds via `setTimeout`.

**Connects to:**

| Dependency | Role |
|---|---|
| `.toast-layer` (DOM) | Container for stacked toasts — created on first use |
| `document.body` (DOM) | Parent for `.toast-layer` if it doesn't exist |
| CSS variables (`--success`, `--danger`, `--accent`, `--bg-card`, `--mono`) | Theming |

**Called by:** `materials.js`, `ui.js` (`bindUISettings`, `triggerStationSync`, `triggerUpwellSync`, `autoSeedNpcStations`), and any module that needs user-facing status feedback.

---

## Console Log

### `logToConsole(message, type = 'info')`

Writes a timestamped message to both the always-visible console status bar and the scrollable console history log.

- Generates a `HH:MM:SS` timestamp using `toLocaleTimeString`.
- **Status bar** (`#consoleTime`, `#consoleMsg`): updates the timestamp and message text. Sets a CSS class (`info`, `success`, or `error`) on `#consoleMsg` for colour styling.
- **History log** (`#consoleLog`): prepends a new `<div class="console-log-entry {type}">` entry containing a `<span class="log-time">` and a `<span class="log-msg">`. The message text is sanitised with `escHtml()` before insertion. The log uses `column-reverse` flex direction, so prepending produces the correct visual order (newest at bottom).
- Caps history at 200 entries — removes from the end (oldest) when the limit is exceeded.

**Connects to:**

| Dependency | Role |
|---|---|
| `#console-msg` (DOM) | Status bar message element |
| `#console-time` (DOM) | Status bar timestamp element |
| `#consoleLog` (DOM) | Scrollable log history container |
| `escHtml()` | Sanitises message text before injecting into log entry HTML |

**Called by:** `withLoadingLogs()` and any module that wants to surface status messages to the in-app console.

---

## Console Toggle (IIFE)

### `initConsoleToggle()` *(self-invoking)*

Immediately-invoked function that sets up expand/collapse behaviour for the in-app console panel. Runs once at script parse time.

- If the DOM is still loading, defers setup to `DOMContentLoaded`. Otherwise runs `setup()` immediately.
- `setup()` locates `#appConsole`, `#consoleToggleBtn`, and `#consoleStatusbar`.
- Maintains a local `expanded` boolean (not stored in `state.js` — purely local to this closure).
- `toggle()`: flips `expanded`, toggles the `expanded` CSS class on `#appConsole`, and updates the button text/title (`'▼'` / `'▲'`, `'Collapse console log'` / `'Expand console log'`).
- Clicking `#consoleToggleBtn` calls `toggle()` with `stopPropagation()` to prevent the statusbar listener from also firing.
- Clicking anywhere on `#consoleStatusbar` also calls `toggle()`.

**Connects to:**

| Dependency | Role |
|---|---|
| `#appConsole` (DOM) | The console panel — `expanded` class toggled |
| `#consoleToggleBtn` (DOM) | The ▲/▼ toggle button |
| `#consoleStatusbar` (DOM) | Clickable status bar that also triggers toggle |
| `DOMContentLoaded` (event) | Guards setup if DOM isn't ready yet |

---

## Loading Wrapper

### `withLoadingLogs(taskName, errorContainerId, asyncWork)`

Wraps an async operation with standardised console logging and error rendering.

- Logs `"Loading {taskName}..."` at `'info'` level before executing `asyncWork()`.
- On success, logs `"{taskName} loaded successfully."` at `'success'` level.
- On failure:
  - Logs the error to the native `console.error`.
  - Logs `"Connection failed: {error.message}"` at `'error'` level via `logToConsole()`.
  - Finds the element with ID `errorContainerId` and injects a styled error message into it.

**Connects to:**

| Dependency | Role |
|---|---|
| `logToConsole()` | Logs start, success, and error messages to the in-app console |
| `errorContainerId` (DOM, by ID) | Container where the error HTML is injected on failure |

**Returns:** `Promise<void>`

**Usage pattern:**
```js
await withLoadingLogs('Dashboard', 'dashboardContent', async () => {
  // async work here
});
```

---

## Persistent Cache Wrappers

### `cacheSet(key, value, days = 7)`

Stores a value in the persistent app cache via `window.eveAPI.cacheSet`. Silently ignores errors — cache writes are best-effort.

**Connects to:**

| Dependency | Role |
|---|---|
| `window.eveAPI.cacheSet(key, value, days)` | IPC → `cache-set` — writes to the main process persistent cache |

**Returns:** `Promise<void>`

---

### `cacheGet(key)`

Retrieves a value from the persistent app cache via `window.eveAPI.cacheGet`. Returns `null` on any error rather than throwing.

**Connects to:**

| Dependency | Role |
|---|---|
| `window.eveAPI.cacheGet(key)` | IPC → `cache-get` — reads from the main process persistent cache |

**Returns:** `Promise<any | null>`

---

## UI Helpers

### `showError(msg)`

Renders a styled error state into `#results`.

- Sanitises `msg` with `escHtml()` before injection.
- Overwrites the entire `innerHTML` of `#results` with an `.empty-state` layout showing a warning icon, an "Error" title, and the message as a subtitle.

**Connects to:**

| Dependency | Role |
|---|---|
| `#results` (DOM) | Target container — content replaced entirely |
| `escHtml()` | Sanitises the error message before HTML injection |

---

### `scrollToResults()`

Smoothly scrolls `.main-content` to the top.

- Uses optional chaining (`?.`) — no-op if `.main-content` doesn't exist.
- Behaviour: `smooth` — animated scroll, not instant.

**Connects to:**

| Dependency | Role |
|---|---|
| `.main-content` (DOM) | The scrollable content area |

---

### `openExternal(url)`

Opens a URL in a new browser tab or external browser window.

- Creates a temporary `<a>` element, sets `href` and `target='_blank'`, then programmatically clicks it.
- The element is never appended to the DOM — it exists only in memory for the duration of the click.
- In Electron, `target='_blank'` links open in the system default browser (if `shell.openExternal` is configured) or a new Electron window depending on the `new-window` handler in the main process.

Connects to nothing external — pure DOM utility.

---

## Full Dependency Summary

### `window.eveAPI` Methods Used

| Method | Called By |
|---|---|
| `cacheSet(key, value, days)` | `cacheSet()` wrapper |
| `cacheGet(key)` | `cacheGet()` wrapper |

### Global Utilities Called Internally

| Function | Called By |
|---|---|
| `escHtml()` | `logToConsole()`, `showError()` |
| `logToConsole()` | `withLoadingLogs()` |

### DOM Elements Referenced

| Element | Used By |
|---|---|
| `document.body` | `showToast` — parent for `.toast-layer` |
| `.toast-layer` | `showToast` — toast container (created on first use) |
| `#console-msg` | `logToConsole` |
| `#console-time` | `logToConsole` |
| `#consoleLog` | `logToConsole` |
| `#appConsole` | `initConsoleToggle` |
| `#consoleToggleBtn` | `initConsoleToggle` |
| `#consoleStatusbar` | `initConsoleToggle` |
| `#results` | `showError` |
| `.main-content` | `scrollToResults` |

### Called By (cross-file reference)

| Function | Called From |
|---|---|
| `escHtml()` | `materials.js`, `planetary-interaction.js`, `ui.js`, `pageLoader.js` (inline onclick attrs), `logToConsole()`, `showError()` |
| `formatNumber()` | `materials.js` |
| `formatISK()` | Dashboard/wallet modules |
| `showToast()` | `materials.js`, `ui.js` (settings, sync functions) |
| `logToConsole()` | `withLoadingLogs()`, any module surfacing status to the console |
| `withLoadingLogs()` | Page load functions (dashboard, assets, wallets, etc.) |
| `cacheGet()` / `cacheSet()` | Any module using short-term persistent caching |
| `showError()` | Industry / blueprint search modules |
| `scrollToResults()` | Blueprint search / industry results handlers |
| `openExternal()` | Any module opening external links |
| `countUp()` | Dashboard net worth / wealth panels |