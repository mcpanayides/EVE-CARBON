# Auto Updater

> 13 nodes · cohesion 0.24

## Key Concepts

- **updater_ipc.js** (18 connections) — `src/ipc/updater_ipc.js`
- **ref_https** (10 connections)
- **registerUpdaterHandlers()** (7 connections) — `src/ipc/updater_ipc.js`
- **downloadBinary()** (6 connections) — `src/ipc/updater_ipc.js`
- **fetchJson()** (6 connections) — `src/ipc/updater_ipc.js`
- **parseReleaseFlags()** (4 connections) — `src/ipc/updater_ipc.js`
- **ref_http** (4 connections)
- **clean()** (2 connections) — `src/ipc/updater_ipc.js`
- **compareVersions()** (2 connections) — `src/ipc/updater_ipc.js`
- **fs** (1 connections) — `src/ipc/updater_ipc.js`
- **os** (1 connections) — `src/ipc/updater_ipc.js`
- **path** (1 connections) — `src/ipc/updater_ipc.js`
- **{ shell, BrowserWindow }** (1 connections) — `src/ipc/updater_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (4 shared connections)
- [Presence Worker Test](Presence_Worker_Test.md) (2 shared connections)
- [Station & Structure Locator](Station_&_Structure_Locator.md) (2 shared connections)
- [Character IPC](Character_IPC.md) (2 shared connections)
- [Demo Data Spec](Demo_Data_Spec.md) (2 shared connections)
- [Account & Auth IPC](Account_&_Auth_IPC.md) (2 shared connections)
- [Intel IPC](Intel_IPC.md) (1 shared connections)
- [Demo Mode Test](Demo_Mode_Test.md) (1 shared connections)
- [HTTP Request Broker](HTTP_Request_Broker.md) (1 shared connections)
- [ESI IPC](ESI_IPC.md) (1 shared connections)
- [Resfile](Resfile.md) (1 shared connections)
- [SDE Fetch & Build](SDE_Fetch_&_Build.md) (1 shared connections)

## Source Files

- `src/ipc/updater_ipc.js`

## Audit Trail

- EXTRACTED: 40 (95%)
- INFERRED: 2 (5%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*