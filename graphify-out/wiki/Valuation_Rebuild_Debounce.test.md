# Valuation Rebuild Debounce.test

> 10 nodes · cohesion 0.24

## Key Concepts

- **valuation_ipc.js** (7 connections) — `src/ipc/valuation_ipc.js`
- **valuation_rebuild_debounce.test.js** (7 connections) — `test/valuation_rebuild_debounce.test.js`
- **registerValuationHandlers()** (4 connections) — `src/ipc/valuation_ipc.js`
- **harness()** (2 connections) — `test/valuation_rebuild_debounce.test.js`
- **assetIndex** (1 connections) — `src/ipc/valuation_ipc.js`
- **valuation** (1 connections) — `src/ipc/valuation_ipc.js`
- **assert** (1 connections) — `test/valuation_rebuild_debounce.test.js`
- **{ registerValuationHandlers,
        REBUILD_DEBOUNCE_MS, REBUILD_MAX_WAIT_MS }** (1 connections) — `test/valuation_rebuild_debounce.test.js`
- **settle()** (1 connections) — `test/valuation_rebuild_debounce.test.js`
- **test** (1 connections) — `test/valuation_rebuild_debounce.test.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [Asset Index Schema](Asset_Index_Schema.md) (1 shared connections)
- [Asset Valuation](Asset_Valuation.md) (1 shared connections)

## Source Files

- `src/ipc/valuation_ipc.js`
- `test/valuation_rebuild_debounce.test.js`

## Audit Trail

- EXTRACTED: 24 (92%)
- INFERRED: 2 (8%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*