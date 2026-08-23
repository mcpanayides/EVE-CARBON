# Valuation Rebuild Debounce Test

> 9 nodes · cohesion 0.22

## Key Concepts

- **valuation_ipc.js** (7 connections) — `src/ipc/valuation_ipc.js`
- **valuation_rebuild_debounce.test.js** (7 connections) — `test/valuation_rebuild_debounce.test.js`
- **harness()** (2 connections) — `test/valuation_rebuild_debounce.test.js`
- **valuation** (1 connections) — `src/ipc/valuation_ipc.js`
- **assetIndex** (1 connections) — `src/ipc/valuation_ipc.js`
- **test** (1 connections) — `test/valuation_rebuild_debounce.test.js`
- **assert** (1 connections) — `test/valuation_rebuild_debounce.test.js`
- **{ registerValuationHandlers,
        REBUILD_DEBOUNCE_MS, REBUILD_MAX_WAIT_MS }** (1 connections) — `test/valuation_rebuild_debounce.test.js`
- **settle()** (1 connections) — `test/valuation_rebuild_debounce.test.js`

## Relationships

- [Asset Index Schema](Asset_Index_Schema.md) (4 shared connections)
- [Electron Main Process](Electron_Main_Process.md) (1 shared connections)
- [Asset Valuation](Asset_Valuation.md) (1 shared connections)

## Source Files

- `src/ipc/valuation_ipc.js`
- `test/valuation_rebuild_debounce.test.js`

## Audit Trail

- EXTRACTED: 21 (95%)
- INFERRED: 1 (5%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*