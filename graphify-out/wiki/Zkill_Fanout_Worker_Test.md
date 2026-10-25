# Zkill Fanout Worker Test

> 15 nodes · cohesion 0.14

## Key Concepts

- **zkill_fanout_worker.test.js** (9 connections) — `test/zkill_fanout_worker.test.js`
- **assets_ipc.js** (5 connections) — `src/ipc/assets_ipc.js`
- **registerAssetHandlers()** (4 connections) — `src/ipc/assets_ipc.js`
- **worker()** (4 connections) — `test/zkill_fanout_worker.test.js`
- **resolveLocations()** (2 connections) — `src/locator.js`
- **call()** (2 connections) — `test/zkill_fanout_worker.test.js`
- **{ ipcMain, BrowserWindow }** (1 connections) — `src/ipc/assets_ipc.js`
- **{ ESI_BASE }** (1 connections) — `src/ipc/assets_ipc.js`
- **test** (1 connections) — `test/zkill_fanout_worker.test.js`
- **assert** (1 connections) — `test/zkill_fanout_worker.test.js`
- **path** (1 connections) — `test/zkill_fanout_worker.test.js`
- **{ pathToFileURL }** (1 connections) — `test/zkill_fanout_worker.test.js`
- **ENV** (1 connections) — `test/zkill_fanout_worker.test.js`
- **fakeUpstream()** (1 connections) — `test/zkill_fanout_worker.test.js`
- **maxAge()** (1 connections) — `test/zkill_fanout_worker.test.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (1 shared connections)
- [Electron Main Process (appIconPath)](Electron_Main_Process_%28appIconPath%29.md) (1 shared connections)
- [Station & Structure Locator](Station_%26_Structure_Locator.md) (1 shared connections)

## Source Files

- `src/ipc/assets_ipc.js`
- `src/locator.js`
- `test/zkill_fanout_worker.test.js`

## Audit Trail

- EXTRACTED: 29 (83%)
- INFERRED: 6 (17%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*