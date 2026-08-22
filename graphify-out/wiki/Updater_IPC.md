# Updater IPC

> 17 nodes · cohesion 0.16

## Key Concepts

- **updater_ipc.js** (15 connections) — `src/ipc/updater_ipc.js`
- **l()** (10 connections) — `src/vendor/gridstack/gridstack-all.js`
- **registerUpdaterHandlers()** (7 connections) — `src/ipc/updater_ipc.js`
- **parseReleaseFlags()** (5 connections) — `src/ipc/updater_ipc.js`
- **updater_critical.test.js** (5 connections) — `test/updater_critical.test.js`
- **clean()** (2 connections) — `src/ipc/updater_ipc.js`
- **compareVersions()** (2 connections) — `src/ipc/updater_ipc.js`
- **downloadBinary()** (2 connections) — `src/ipc/updater_ipc.js`
- **fetchJson()** (2 connections) — `src/ipc/updater_ipc.js`
- **{ APP_USER_AGENT }** (1 connections) — `src/ipc/updater_ipc.js`
- **fs** (1 connections) — `src/ipc/updater_ipc.js`
- **os** (1 connections) — `src/ipc/updater_ipc.js`
- **path** (1 connections) — `src/ipc/updater_ipc.js`
- **{ shell, BrowserWindow }** (1 connections) — `src/ipc/updater_ipc.js`
- **assert** (1 connections) — `test/updater_critical.test.js`
- **{ parseReleaseFlags }** (1 connections) — `test/updater_critical.test.js`
- **test** (1 connections) — `test/updater_critical.test.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [ESI Client.test](ESI_Client.test.md) (2 shared connections)
- [Fitting Tree & Scheduling](Fitting_Tree_%26_Scheduling.md) (2 shared connections)
- [Gridstack All](Gridstack_All.md) (2 shared connections)
- [Forum IPC](Forum_IPC.md) (1 shared connections)
- [Appraisal](Appraisal.md) (1 shared connections)
- [EVE Mail](EVE_Mail.md) (1 shared connections)
- [Skills & Training Queue](Skills_%26_Training_Queue.md) (1 shared connections)
- [Fleet Mining](Fleet_Mining.md) (1 shared connections)
- [Fitting Cargo & Charts](Fitting_Cargo_%26_Charts.md) (1 shared connections)

## Source Files

- `src/ipc/updater_ipc.js`
- `src/vendor/gridstack/gridstack-all.js`
- `test/updater_critical.test.js`

## Audit Trail

- EXTRACTED: 48 (83%)
- INFERRED: 10 (17%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*