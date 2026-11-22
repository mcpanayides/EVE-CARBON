# Preload Bridge

> 15 nodes · cohesion 0.13

## Key Concepts

- **electron** (18 connections) — `package.json`
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
- **{ ipcMain }** (1 connections) — `src/ipc/station_ipc.js`
- **{ contextBridge, ipcRenderer }** (1 connections) — `src/preload.js`
- **IPC_EVENT_CHANNELS** (1 connections) — `src/preload.js`
- **_listenerRegistry** (1 connections) — `src/preload.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (8 shared connections)
- [Character IPC](Character_IPC.md) (4 shared connections)
- [Demo Alliance Forum](Demo_Alliance_Forum.md) (3 shared connections)
- [NPM Dev Dependencies](NPM_Dev_Dependencies.md) (2 shared connections)
- [ESI Audit](ESI_Audit.md) (2 shared connections)
- [Account & Auth IPC](Account_&_Auth_IPC.md) (1 shared connections)
- [ESI IPC](ESI_IPC.md) (1 shared connections)
- [Fleet Op Records](Fleet_Op_Records.md) (1 shared connections)
- [Force Projection](Force_Projection.md) (1 shared connections)
- [Auto Updater](Auto_Updater.md) (1 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (1 shared connections)

## Source Files

- `main.js`
- `package.json`
- `src/ipc/config_ipc.js`
- `src/ipc/forum_ipc.js`
- `src/ipc/station_ipc.js`
- `src/preload.js`

## Audit Trail

- EXTRACTED: 36 (92%)
- INFERRED: 3 (8%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*