# Electron Main Process (appIconPath)

> 14 nodes · cohesion 0.19

## Key Concepts

- **{ BrowserWindow }** (10 connections) — `src/ipc/intel_ipc.js`
- **appIconPath()** (5 connections) — `main.js`
- **createWindow()** (5 connections) — `main.js`
- **assets_ipc.js** (5 connections) — `src/ipc/assets_ipc.js`
- **intel_ipc.js** (5 connections) — `src/ipc/intel_ipc.js`
- **createPingAlertWindow()** (4 connections) — `main.js`
- **acrylicSupported()** (4 connections) — `main.js`
- **createIntelWidgetWindow()** (3 connections) — `main.js`
- **registerAssetHandlers()** (3 connections) — `src/ipc/assets_ipc.js`
- **registerIntelHandlers()** (3 connections) — `src/ipc/intel_ipc.js`
- **{ ipcMain, BrowserWindow }** (1 connections) — `src/ipc/assets_ipc.js`
- **{ ESI_BASE }** (1 connections) — `src/ipc/assets_ipc.js`
- **fs** (1 connections) — `src/ipc/intel_ipc.js`
- **path** (1 connections) — `src/ipc/intel_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (10 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (3 shared connections)
- [Demo Mode](Demo_Mode.md) (1 shared connections)
- [Widget Popout Spec](Widget_Popout_Spec.md) (1 shared connections)
- [Auto Updater](Auto_Updater.md) (1 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (1 shared connections)

## Source Files

- `main.js`
- `src/ipc/assets_ipc.js`
- `src/ipc/intel_ipc.js`

## Audit Trail

- EXTRACTED: 47 (92%)
- INFERRED: 4 (8%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*