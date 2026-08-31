# Electron Main Process

> 88 nodes · cohesion 0.03

## Key Concepts

- **main.js** (165 connections) — `main.js`
- **loadConfig()** (4 connections) — `main.js`
- **createTray()** (4 connections) — `main.js`
- **applyMinimizeToTray()** (4 connections) — `main.js`
- **jumpBridgesPath()** (3 connections) — `main.js`
- **_esiNoteResponseCore()** (3 connections) — `main.js`
- **showMainWindow()** (3 connections) — `main.js`
- **getMissingScopes()** (3 connections) — `main.js`
- **config_ipc.js** (3 connections) — `src/ipc/config_ipc.js`
- **station_ipc.js** (3 connections) — `src/ipc/station_ipc.js`
- **getSdePath()** (2 connections) — `main.js`
- **initSde()** (2 connections) — `main.js`
- **resolvePackFile()** (2 connections) — `main.js`
- **_readLaunchAtLogin()** (2 connections) — `main.js`
- **loadJumpBridges()** (2 connections) — `main.js`
- **saveJumpBridges()** (2 connections) — `main.js`
- **_esiNoteFetchResponse()** (2 connections) — `main.js`
- **destroyTray()** (2 connections) — `main.js`
- **decodeTokenScopes()** (2 connections) — `main.js`
- **registerConfigHandlers()** (2 connections) — `src/ipc/config_ipc.js`
- **registerStationHandlers()** (2 connections) — `src/ipc/station_ipc.js`
- **path** (1 connections) — `main.js`
- **{ app }** (1 connections) — `main.js`
- **{ BrowserWindow, ipcMain, shell, screen, Tray, Menu, safeStorage, nativeImage, session }** (1 connections) — `main.js`
- **https** (1 connections) — `main.js`
- *... and 63 more nodes in this community*

## Relationships

- [Main Process ESI & Cache Layer](Main_Process_ESI_%26_Cache_Layer.md) (35 shared connections)
- [Electron Main Process (appIconPath)](Electron_Main_Process_%28appIconPath%29.md) (10 shared connections)
- [ESI Client Test](ESI_Client_Test.md) (6 shared connections)
- [Presence](Presence.md) (4 shared connections)
- [PI IPC](PI_IPC.md) (3 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (2 shared connections)
- [ESI IPC](ESI_IPC.md) (2 shared connections)
- [Fleet After-Action Report](Fleet_After-Action_Report.md) (2 shared connections)
- [Map IPC](Map_IPC.md) (2 shared connections)
- [Theme Vars](Theme_Vars.md) (2 shared connections)
- [Auto Updater](Auto_Updater.md) (2 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (2 shared connections)

## Source Files

- `main.js`
- `src/ipc/config_ipc.js`
- `src/ipc/station_ipc.js`

## Audit Trail

- EXTRACTED: 278 (98%)
- INFERRED: 6 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*