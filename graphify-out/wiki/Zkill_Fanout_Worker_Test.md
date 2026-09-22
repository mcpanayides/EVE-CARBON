# Zkill Fanout Worker Test

> 11 nodes · cohesion 0.20

## Key Concepts

- **zkill_fanout_worker.test.js** (9 connections) — `test/zkill_fanout_worker.test.js`
- **worker()** (4 connections) — `test/zkill_fanout_worker.test.js`
- **resolveLocations()** (2 connections) — `src/locator.js`
- **call()** (2 connections) — `test/zkill_fanout_worker.test.js`
- **test** (1 connections) — `test/zkill_fanout_worker.test.js`
- **assert** (1 connections) — `test/zkill_fanout_worker.test.js`
- **path** (1 connections) — `test/zkill_fanout_worker.test.js`
- **{ pathToFileURL }** (1 connections) — `test/zkill_fanout_worker.test.js`
- **ENV** (1 connections) — `test/zkill_fanout_worker.test.js`
- **fakeUpstream()** (1 connections) — `test/zkill_fanout_worker.test.js`
- **maxAge()** (1 connections) — `test/zkill_fanout_worker.test.js`

## Relationships

- [Station & Structure Locator](Station_%26_Structure_Locator.md) (1 shared connections)
- [Electron Main Process (appIconPath)](Electron_Main_Process_%28appIconPath%29.md) (1 shared connections)

## Source Files

- `src/locator.js`
- `test/zkill_fanout_worker.test.js`

## Audit Trail

- EXTRACTED: 21 (88%)
- INFERRED: 3 (12%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*