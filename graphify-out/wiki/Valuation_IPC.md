# Valuation IPC

> 25 nodes · cohesion 0.12

## Key Concepts

- **registerValuationHandlers()** (14 connections) — `src/ipc/valuation_ipc.js`
- **valuation_rebuild_race.test.js** (11 connections) — `test/valuation_rebuild_race.test.js`
- **valuation_rebuild_debounce.test.js** (10 connections) — `test/valuation_rebuild_debounce.test.js`
- **rebuildFromLocalData()** (7 connections) — `src/ipc/valuation_ipc.js`
- **valuation_ipc.js** (6 connections) — `src/ipc/valuation_ipc.js`
- **refreshValuation()** (5 connections) — `src/ipc/valuation_ipc.js`
- **runRebuild()** (3 connections) — `src/ipc/valuation_ipc.js`
- **typeMetadata()** (3 connections) — `src/ipc/valuation_ipc.js`
- **harness()** (3 connections) — `test/valuation_rebuild_race.test.js`
- **heldQuantities()** (2 connections) — `src/ipc/valuation_ipc.js`
- **resolvedRows()** (2 connections) — `src/ipc/valuation_ipc.js`
- **scheduleRebuild()** (2 connections) — `src/ipc/valuation_ipc.js`
- **serialised()** (2 connections) — `src/ipc/valuation_ipc.js`
- **harness()** (2 connections) — `test/valuation_rebuild_debounce.test.js`
- **fakeDb()** (2 connections) — `test/valuation_rebuild_race.test.js`
- **settle()** (1 connections) — `test/valuation_rebuild_debounce.test.js`
- **assertPaired()** (1 connections) — `test/valuation_rebuild_race.test.js`
- **tag()** (1 connections) — `test/valuation_rebuild_race.test.js`
- **tick()** (1 connections) — `test/valuation_rebuild_race.test.js`
- **assert** (1 connections) — `test/valuation_rebuild_debounce.test.js`
- **test** (1 connections) — `test/valuation_rebuild_debounce.test.js`
- **assert** (1 connections) — `test/valuation_rebuild_race.test.js`
- **test** (1 connections) — `test/valuation_rebuild_race.test.js`
- **src_ipc_valuation_ipc_rebuild_debounce_ms** (1 connections)
- **src_ipc_valuation_ipc_rebuild_max_wait_ms** (1 connections)

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (4 shared connections)
- [PI Roles Test](PI_Roles_Test.md) (4 shared connections)
- [Asset Valuation](Asset_Valuation.md) (1 shared connections)
- [Asset Index Schema](Asset_Index_Schema.md) (1 shared connections)

## Source Files

- `src/ipc/valuation_ipc.js`
- `test/valuation_rebuild_debounce.test.js`
- `test/valuation_rebuild_race.test.js`

## Audit Trail

- EXTRACTED: 45 (96%)
- INFERRED: 2 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*