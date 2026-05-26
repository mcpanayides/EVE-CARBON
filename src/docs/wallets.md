# `wallets.js` — Function Reference

## Overview

This file handles all wallet-related UI in the app, split across two surfaces:

1. **Wallets page** — a grid of wallet balance cards, one per character, sorted by balance descending.
2. **Wallet Journal modal** — a three-tab modal per character showing an income/expense donut chart (Overview), a market transaction table (Transactions), and a loyalty points breakdown (LP Standings).

All data comes from `character_information.db` via IPC, synced every 30 minutes by `coreCharacterSync` / `fullCharacterSync` in `main.js`. No live ESI calls are made here.

---

## Module-Level State

| Variable | Type | Purpose |
|---|---|---|
| `_journalCharId` | Number\|null | Stores the character ID of the currently open journal modal. Set on open, cleared on close. |
| `_journalRingChart` | Chart.js instance\|null | Holds the active Chart.js doughnut chart instance. Destroyed and recreated each time the Overview tab loads, to prevent canvas reuse errors. |

---

## Module-Level Constants

### `REF_TYPE_LABELS`

A lookup object mapping ESI `ref_type` strings from the wallet journal to human-readable category labels used in the Overview chart and legend.

| Example Keys | Label |
|---|---|
| `market_transaction` | `'Market'` |
| `bounty_prizes`, `bounty_prize` | `'Bounties'` |
| `transaction_tax` | `'Taxes'` |
| `brokers_fee` | `'Broker Fees'` |
| `planetary_export_tax`, `planetary_import_tax` | `'PI Tax'` |
| `structure_gate_jump` | `'Jump'` |
| `jump_clone_activation`, `jump_clone_installation` | `'Clone Jump'` |
| *(and more)* | |

Unknown `ref_type` values fall back to a title-cased, underscore-stripped version of the key via `_refLabel()`.

---

### `PALETTE`

A fixed array of 10 hex colour strings used to colour the segments of the income donut chart and their corresponding legend swatches. Cycles through in order; any categories beyond 10 would reuse colours (in practice capped at 9 + "Other").

```
'#4ada8a','#ab7ab8','#f5c842','#e24b4a','#4ab8f5',
'#f58c42','#42f5c8','#f542a1','#a1f542','#8c42f5'
```

---

## Wallets Page

### `renderWallets()`

**Entry point** for the Wallets page. Called by `navigateToPage('wallets')` in `ui.js`.

- Shows a loading message in `#walletsGrid`.
- Calls `window.eveAPI.getAccounts()` to get all authenticated characters; shows an empty state if none exist.
- Fetches the wallet balance for every character in parallel via `Promise.all`, reading `data?.wallet?.balance` from `window.eveAPI.getCharacterData()`. Falls back to `0` per character on error.
- Sums all balances to compute a combined total.
- Shows `#walletsTotalRow` and sets `#walletsTotalValue` to `formatISK(total)`.
- Sets `#walletsSummary` to the character count.
- Sorts characters by balance descending and renders one `.wallet-card` per character into `#walletsGrid`. Each card shows:
  - Character portrait (EVE image server, 64px)
  - Character name
  - Wallet balance formatted via `formatISK()`
  - A hover border highlight (accent colour)
  - A click handler that calls `openWalletJournal(characterId, characterName)`
- On error, renders an error message directly in `#walletsGrid`.

**Connects to:**

| Dependency | Role |
|---|---|
| `#walletsGrid` (DOM) | Main grid container — cards injected here |
| `#walletsSummary` (DOM) | Character count label (defined in `pageLoader.js` wallets template) |
| `#walletsTotalRow` (DOM) | Combined wealth row — shown after load |
| `#walletsTotalValue` (DOM) | Combined ISK total display |
| `window.eveAPI.getAccounts()` | IPC → `get-accounts` — all authenticated characters |
| `window.eveAPI.getCharacterData(characterId)` | IPC → `get-character-info-db` — reads `wallet.balance` |
| `openWalletJournal(characterId, characterName)` | Opens the journal modal on card click |
| `formatISK()` (`utils.js`) | Formats ISK values for balance display |
| `escHtml()` (`utils.js`) | Sanitises character names |
| EVE image server | Portrait: `https://images.evetech.net/characters/{id}/portrait?size=64` |

---

## Journal Modal

### `openWalletJournal(characterId, characterName)`

Opens the wallet journal modal for a specific character and loads all three tabs in parallel.

- Stores `characterId` in `_journalCharId`.
- Shows `#walletJournalBackdrop`.
- Sets `#journalCharPortrait` src and `#journalCharName` text in the modal header.
- Clones all `.journal-tab-btn` elements to strip any previously bound listeners, then re-attaches `click` → `_switchJournalTab(btn.dataset.tab)` on each fresh clone.
- Defaults to the Overview tab by calling `_switchJournalTab('overview')`.
- Calls all three tab loaders in parallel via `Promise.all`:
  - `_loadJournalOverview(characterId)`
  - `_loadJournalTransactions(characterId)`
  - `_loadJournalLP(characterId)`

**Connects to:**

| Dependency | Role |
|---|---|
| `_journalCharId` (module state) | Written with the current character ID |
| `#walletJournalBackdrop` (DOM) | Modal container — shown |
| `#journalCharPortrait` (DOM) | Modal header portrait `<img>` |
| `#journalCharName` (DOM) | Modal header character name |
| `.journal-tab-btn` (DOM) | Tab buttons — cloned and re-bound |
| `_switchJournalTab(tab)` | Activates the default Overview tab and handles tab clicks |
| `_loadJournalOverview(characterId)` | Loads the Overview tab content |
| `_loadJournalTransactions(characterId)` | Loads the Transactions tab content |
| `_loadJournalLP(characterId)` | Loads the LP Standings tab content |
| EVE image server | Portrait: `https://images.evetech.net/characters/{id}/portrait?size=64` |

---

### `closeWalletJournal()`

Closes the wallet journal modal.

- Sets `#walletJournalBackdrop` display to `'none'`.
- Clears `_journalCharId` to `null`.

**Connects to:**

| Dependency | Role |
|---|---|
| `#walletJournalBackdrop` (DOM) | Hidden |
| `_journalCharId` (module state) | Cleared |

---

### Backdrop Click-to-Close (IIFE)

An immediately-invoked function that wires a click-outside-to-close listener on `#walletJournalBackdrop` once the DOM is ready.

- Fires on `DOMContentLoaded`.
- Checks `e.target === backdrop` before closing — clicks on modal content do not propagate to close it.
- Calls `closeWalletJournal()`.

**Connects to:**

| Dependency | Role |
|---|---|
| `#walletJournalBackdrop` (DOM) | Click target |
| `closeWalletJournal()` | Called when backdrop is clicked directly |

---

### `_switchJournalTab(tab)`

Switches the visible tab inside the journal modal.

- Iterates `.journal-tab-btn` elements — highlights the active one with `var(--accent)` background and dark text; resets all others to transparent.
- Iterates `.journal-tab-content` panels — shows the one whose `id` matches `journalTab-{tab}`, hides all others.

Tab keys and their corresponding panel IDs:

| `tab` value | Panel ID |
|---|---|
| `'overview'` | `#journalTab-overview` |
| `'transactions'` | `#journalTab-transactions` |
| `'lp'` | `#journalTab-lp` |

**Connects to:**

| Dependency | Role |
|---|---|
| `.journal-tab-btn` (DOM) | Tab buttons — active styling toggled |
| `.journal-tab-content` (DOM) | Tab panels — shown/hidden by ID match |

---

## Journal Tab Loaders

### `_loadJournalOverview(characterId)`

Loads the Overview tab: totals income and expenses from the wallet journal, renders a doughnut chart of income by category, and builds an income + expense legend.

- Shows loading placeholders in `#journalIncomeTotal`, `#journalExpenseTotal`, `#journalLegend`, and `#journalRingValue`.
- Calls `window.eveAPI.getWalletJournal(characterId)` to fetch all journal entries.
- Iterates entries, using `_refLabel()` to map each `ref_type` to a category label, then buckets amounts into `incomeByLabel` (positive amounts) and `expenseByLabel` (negative amounts, stored as absolute values).
- Displays total income, total expense, and net (income − expense) in the header elements.
- Builds the donut chart from the top 8 income categories; remaining categories are merged into an `'Other Income'` segment.
- Destroys any existing `_journalRingChart` instance before creating a new Chart.js doughnut chart on `#journalRingChart`.
  - `cutout: '72%'` — gives the donut its thick ring appearance.
  - Custom tooltip: shows `{label}: {formatISK(value)}`.
  - Legend is disabled on the chart itself — a custom HTML legend is built below.
- Builds the custom legend in `#journalLegend`:
  - **Income rows**: coloured swatch + label + ISK value, in descending order.
  - **Expense rows**: red swatch + label + negative ISK value, top 5 only, separated by a divider.
- On error, shows the error message in `#journalLegend`.

**Connects to:**

| Dependency | Role |
|---|---|
| `#journalIncomeTotal` (DOM) | Total income display |
| `#journalExpenseTotal` (DOM) | Total expense display |
| `#journalLegend` (DOM) | Custom HTML legend container |
| `#journalRingValue` (DOM) | Net value displayed in the donut centre hole |
| `#journalRingChart` (DOM) | `<canvas>` element for the Chart.js doughnut |
| `window.eveAPI.getWalletJournal(characterId)` | IPC → `get-wallet-journal` — journal entries from local DB |
| `_journalRingChart` (module state) | Previous chart instance destroyed before re-creation |
| `_refLabel(refType)` | Maps ESI `ref_type` strings to category labels |
| `REF_TYPE_LABELS` (constant) | Source for `_refLabel()` lookups |
| `PALETTE` (constant) | Colours for donut segments and legend swatches |
| `Chart` (Chart.js global) | Used to instantiate the doughnut chart |
| `formatISK()` (`utils.js`) | Formats all ISK values |
| `escHtml()` (`utils.js`) | Sanitises category labels in the legend HTML |

---

### `_loadJournalTransactions(characterId)`

Loads the Transactions tab: a table of market buy/sell transactions.

- Shows a loading row in `#journalTransactionBody`.
- Calls `window.eveAPI.getWalletTransactions(characterId)`.
- Shows an empty message if no transactions are returned.
- Renders one `<tr>` per transaction with six columns:
  - **Date** — formatted as `DD Mon YYYY` (e.g. `'15 Jan 2025'`).
  - **Type** — `BUY` (red) or `SELL` (green), determined from `t.is_buy`.
  - **Item** — `t.type_name`, falling back to `"Type {type_id}"`.
  - **Quantity** — locale-formatted integer.
  - **Unit Price** — `formatISK(t.unit_price)`.
  - **Total** — quantity × unit price, prefixed with `−` for buys or `+` for sells, coloured accordingly.
- On error, renders the error message as a single-row table entry.

**Connects to:**

| Dependency | Role |
|---|---|
| `#journalTransactionBody` (DOM) | `<tbody>` of the transactions table |
| `window.eveAPI.getWalletTransactions(characterId)` | IPC → `get-wallet-transactions` — transaction rows from local DB |
| `formatISK()` (`utils.js`) | Formats unit price and total |
| `escHtml()` (`utils.js`) | Sanitises date and item name strings |

---

### `_loadJournalLP(characterId)`

Loads the LP Standings tab: a table of loyalty point balances per corporation.

- Shows a loading row in `#journalLPBody`.
- Calls `window.eveAPI.getLoyaltyPoints(characterId)`.
- Shows an empty message if no LP data is returned.
- Finds the maximum LP value across all rows to normalise the progress bar widths.
- Renders one `<tr>` per corporation row with three columns:
  - **Corporation** — corporation logo (32px, EVE image server) + name.
  - **LP bar** — a proportional progress bar (width = `(lp / maxLP) * 100%`) plus the LP value right-aligned.
  - **Third column** — reserved/empty (`—`), for future use (e.g. LP store value estimate).
- On error, renders the error message as a single-row table entry.

**Connects to:**

| Dependency | Role |
|---|---|
| `#journalLPBody` (DOM) | `<tbody>` of the LP standings table |
| `window.eveAPI.getLoyaltyPoints(characterId)` | IPC → `get-loyalty-points` — LP rows from local DB |
| `escHtml()` (`utils.js`) | Sanitises corporation name |
| EVE image server | Corp logo: `https://images.evetech.net/corporations/{id}/logo?size=32` |

---

## Private Helpers

### `_refLabel(refType)`

Maps an ESI wallet journal `ref_type` string to a human-readable category label.

- Looks up `refType` in `REF_TYPE_LABELS`.
- If not found, falls back to `_titleCase(refType.replace(/_/g, ' '))` — converts snake_case to Title Case (e.g. `'corporation_account_withdrawal'` → `'Corporation Account Withdrawal'`).

**Connects to:**

| Dependency | Role |
|---|---|
| `REF_TYPE_LABELS` (constant) | Primary label source |
| `_titleCase()` | Fallback formatter for unknown ref types |

**Returns:** `String`

---

### `_titleCase(str)`

Converts a string to Title Case by uppercasing the first letter of every word.

Connects to nothing external — pure utility function.

**Returns:** `String`  
**Example:** `'bounty prize'` → `'Bounty Prize'`

---

## Data Flow

```
renderWallets()
      │
      ├─ getAccounts() ──────────────────────────────► all characters
      │
      └─ getCharacterData() × N ────────────────────► wallet.balance per character
                │
                └─ card click → openWalletJournal(charId, charName)
                                        │
                                        ├─ _switchJournalTab('overview')
                                        │
                                        ├─ _loadJournalOverview(charId)
                                        │       └─ getWalletJournal()
                                        │               └─ Chart.js doughnut
                                        │
                                        ├─ _loadJournalTransactions(charId)
                                        │       └─ getWalletTransactions()
                                        │
                                        └─ _loadJournalLP(charId)
                                                └─ getLoyaltyPoints()
```

---

## External Dependencies Summary

### `window.eveAPI` Methods Used

| Method | Called By |
|---|---|
| `getAccounts()` | `renderWallets` |
| `getCharacterData(characterId)` | `renderWallets` — reads `wallet.balance` |
| `getWalletJournal(characterId)` | `_loadJournalOverview` |
| `getWalletTransactions(characterId)` | `_loadJournalTransactions` |
| `getLoyaltyPoints(characterId)` | `_loadJournalLP` |

### Third-Party Libraries

| Library | Used By | Purpose |
|---|---|---|
| `Chart` (Chart.js) | `_loadJournalOverview` | Renders the income doughnut chart on `#journalRingChart` |

### Global Utilities Used

| Utility | Called By |
|---|---|
| `formatISK()` (`utils.js`) | `renderWallets`, `_loadJournalOverview`, `_loadJournalTransactions` |
| `escHtml()` (`utils.js`) | `renderWallets`, `_loadJournalOverview`, `_loadJournalTransactions`, `_loadJournalLP` |

### Called By

| Function | Called From |
|---|---|
| `renderWallets()` | `ui.js` → `navigateToPage('wallets')` |
| `openWalletJournal()` | `renderWallets()` — wallet card click handler |
| `closeWalletJournal()` | Backdrop IIFE click handler; expected to also be called from a close button in the modal HTML |

### DOM Elements Referenced

| Element ID | Used By |
|---|---|
| `#walletsGrid` | `renderWallets` |
| `#walletsSummary` | `renderWallets` |
| `#walletsTotalRow` | `renderWallets` |
| `#walletsTotalValue` | `renderWallets` |
| `#walletJournalBackdrop` | `openWalletJournal`, `closeWalletJournal`, backdrop IIFE |
| `#journalCharPortrait` | `openWalletJournal` |
| `#journalCharName` | `openWalletJournal` |
| `.journal-tab-btn` | `openWalletJournal`, `_switchJournalTab` |
| `.journal-tab-content` | `_switchJournalTab` |
| `#journalTab-overview` | `_switchJournalTab` |
| `#journalTab-transactions` | `_switchJournalTab` |
| `#journalTab-lp` | `_switchJournalTab` |
| `#journalIncomeTotal` | `_loadJournalOverview` |
| `#journalExpenseTotal` | `_loadJournalOverview` |
| `#journalRingValue` | `_loadJournalOverview` |
| `#journalRingChart` | `_loadJournalOverview` |
| `#journalLegend` | `_loadJournalOverview` |
| `#journalTransactionBody` | `_loadJournalTransactions` |
| `#journalLPBody` | `_loadJournalLP` |