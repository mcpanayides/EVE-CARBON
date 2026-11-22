# Assets IPC

> 20 nodes · cohesion 0.10

## Key Concepts

- **electron** (18 connections) — `package.json`
- **intel_ipc.js** (8 connections) — `src/ipc/intel_ipc.js`
- **assets_ipc.js** (6 connections) — `src/ipc/assets_ipc.js`
- **registerAssetHandlers()** (4 connections) — `src/ipc/assets_ipc.js`
- **config_ipc.js** (4 connections) — `src/ipc/config_ipc.js`
- **station_ipc.js** (4 connections) — `src/ipc/station_ipc.js`
- **preload.js** (4 connections) — `src/preload.js`
- **registerConfigHandlers()** (2 connections) — `src/ipc/config_ipc.js`
- **registerStationHandlers()** (2 connections) — `src/ipc/station_ipc.js`
- **syncAssetsInternal()** (1 connections) — `src/ipc/assets_ipc.js`
- **worker()** (1 connections) — `src/ipc/assets_ipc.js`
- **{ ipcMain, BrowserWindow }** (1 connections) — `src/ipc/assets_ipc.js`
- **{ ipcMain }** (1 connections) — `src/ipc/config_ipc.js`
- **{ BrowserWindow }** (1 connections) — `src/ipc/intel_ipc.js`
- **fs** (1 connections) — `src/ipc/intel_ipc.js`
- **path** (1 connections) — `src/ipc/intel_ipc.js`
- **{ ipcMain }** (1 connections) — `src/ipc/station_ipc.js`
- **{ contextBridge, ipcRenderer }** (1 connections) — `src/preload.js`
- **IPC_EVENT_CHANNELS** (1 connections) — `src/preload.js`
- **_listenerRegistry** (1 connections) — `src/preload.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (8 shared connections)
- [Character IPC](Character_IPC.md) (4 shared connections)
- [Palette Accent Split Test](Palette_Accent_Split_Test.md) (3 shared connections)
- [NPM Dev Dependencies](NPM_Dev_Dependencies.md) (2 shared connections)
- [Intel IPC](Intel_IPC.md) (1 shared connections)
- [Demo Alliance Forum](Demo_Alliance_Forum.md) (1 shared connections)
- [Account & Auth IPC](Account_&_Auth_IPC.md) (1 shared connections)
- [ESI IPC](ESI_IPC.md) (1 shared connections)
- [Fleet Mining](Fleet_Mining.md) (1 shared connections)
- [Map IPC](Map_IPC.md) (1 shared connections)
- [Auto Updater](Auto_Updater.md) (1 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (1 shared connections)

## Source Files

- `package.json`
- `src/ipc/assets_ipc.js`
- `src/ipc/config_ipc.js`
- `src/ipc/intel_ipc.js`
- `src/ipc/station_ipc.js`
- `src/preload.js`

## Audit Trail

- EXTRACTED: 39 (89%)
- INFERRED: 5 (11%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*