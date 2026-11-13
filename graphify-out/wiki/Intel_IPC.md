# Intel IPC

> 19 nodes · cohesion 0.11

## Key Concepts

- **electron** (18 connections) — `package.json`
- **intel_ipc.js** (8 connections) — `src/ipc/intel_ipc.js`
- **_serveDemoForum()** (4 connections) — `main.js`
- **_setDemoForumCookies()** (4 connections) — `main.js`
- **registerForumHandlers()** (4 connections) — `src/ipc/forum_ipc.js`
- **config_ipc.js** (4 connections) — `src/ipc/config_ipc.js`
- **station_ipc.js** (4 connections) — `src/ipc/station_ipc.js`
- **preload.js** (4 connections) — `src/preload.js`
- **registerConfigHandlers()** (2 connections) — `src/ipc/config_ipc.js`
- **registerStationHandlers()** (2 connections) — `src/ipc/station_ipc.js`
- **src_demo_forum_base** (2 connections)
- **{ ipcMain }** (1 connections) — `src/ipc/config_ipc.js`
- **{ BrowserWindow }** (1 connections) — `src/ipc/intel_ipc.js`
- **fs** (1 connections) — `src/ipc/intel_ipc.js`
- **path** (1 connections) — `src/ipc/intel_ipc.js`
- **{ ipcMain }** (1 connections) — `src/ipc/station_ipc.js`
- **{ contextBridge, ipcRenderer }** (1 connections) — `src/preload.js`
- **IPC_EVENT_CHANNELS** (1 connections) — `src/preload.js`
- **_listenerRegistry** (1 connections) — `src/preload.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (9 shared connections)
- [Character IPC](Character_IPC.md) (4 shared connections)
- [Demo Alliance Forum](Demo_Alliance_Forum.md) (3 shared connections)
- [PI Tally Test](PI_Tally_Test.md) (3 shared connections)
- [NPM Dev Dependencies](NPM_Dev_Dependencies.md) (2 shared connections)
- [Auto Updater](Auto_Updater.md) (2 shared connections)
- [Intel IPC (registerIntelHandlers)](Intel_IPC_registerIntelHandlers.md) (1 shared connections)
- [ESI IPC](ESI_IPC.md) (1 shared connections)
- [Fleet Kills](Fleet_Kills.md) (1 shared connections)
- [Map IPC](Map_IPC.md) (1 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (1 shared connections)

## Source Files

- `main.js`
- `package.json`
- `src/ipc/config_ipc.js`
- `src/ipc/forum_ipc.js`
- `src/ipc/intel_ipc.js`
- `src/ipc/station_ipc.js`
- `src/preload.js`

## Audit Trail

- EXTRACTED: 42 (91%)
- INFERRED: 4 (9%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*