# Electron Main Process

> 82 nodes · cohesion 0.03

## Key Concepts

- **main.js** (165 connections) — `main.js`
- **loadConfig()** (4 connections) — `main.js`
- **jumpBridgesPath()** (3 connections) — `main.js`
- **getMissingScopes()** (3 connections) — `main.js`
- **config_ipc.js** (3 connections) — `src/ipc/config_ipc.js`
- **station_ipc.js** (3 connections) — `src/ipc/station_ipc.js`
- **getSdePath()** (2 connections) — `main.js`
- **initSde()** (2 connections) — `main.js`
- **resolvePackFile()** (2 connections) — `main.js`
- **_readLaunchAtLogin()** (2 connections) — `main.js`
- **loadJumpBridges()** (2 connections) — `main.js`
- **saveJumpBridges()** (2 connections) — `main.js`
- **decodeTokenScopes()** (2 connections) — `main.js`
- **registerConfigHandlers()** (2 connections) — `src/ipc/config_ipc.js`
- **registerStationHandlers()** (2 connections) — `src/ipc/station_ipc.js`
- **path** (1 connections) — `main.js`
- **{ app }** (1 connections) — `main.js`
- **{ BrowserWindow, ipcMain, shell, screen, Tray, Menu, safeStorage, nativeImage, session }** (1 connections) — `main.js`
- **https** (1 connections) — `main.js`
- **http** (1 connections) — `main.js`
- **crypto** (1 connections) — `main.js`
- **fs** (1 connections) — `main.js`
- **demoMode** (1 connections) — `main.js`
- **demoPaths** (1 connections) — `main.js`
- **{ APP_USER_AGENT, ESI_BASE, ESI_COMPATIBILITY_DATE, Esi }** (1 connections) — `main.js`
- *... and 57 more nodes in this community*

## Relationships

- [Main Process ESI & Cache Layer](Main_Process_ESI_%26_Cache_Layer.md) (27 shared connections)
- [Forum IPC](Forum_IPC.md) (11 shared connections)
- [Electron Main Process (_esiCompatHeader)](Electron_Main_Process_%28_esiCompatHeader%29.md) (9 shared connections)
- [Electron Main Process (showMainWindow)](Electron_Main_Process_%28showMainWindow%29.md) (4 shared connections)
- [ESI Client Test](ESI_Client_Test.md) (4 shared connections)
- [Presence](Presence.md) (4 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (3 shared connections)
- [PI IPC](PI_IPC.md) (3 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (2 shared connections)
- [ESI IPC](ESI_IPC.md) (2 shared connections)
- [Fleet After-Action Report](Fleet_After-Action_Report.md) (2 shared connections)
- [Map IPC](Map_IPC.md) (2 shared connections)

## Source Files

- `main.js`
- `src/ipc/config_ipc.js`
- `src/ipc/station_ipc.js`

## Audit Trail

- EXTRACTED: 262 (98%)
- INFERRED: 4 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*