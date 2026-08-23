# Forum IPC

> 20 nodes · cohesion 0.12

## Key Concepts

- **{ BrowserWindow }** (9 connections) — `src/ipc/intel_ipc.js`
- **forum_ipc.js** (8 connections) — `src/ipc/forum_ipc.js`
- **appIconPath()** (6 connections) — `main.js`
- **createWindow()** (5 connections) — `main.js`
- **assets_ipc.js** (5 connections) — `src/ipc/assets_ipc.js`
- **intel_ipc.js** (5 connections) — `src/ipc/intel_ipc.js`
- **createPingAlertWindow()** (4 connections) — `main.js`
- **acrylicSupported()** (4 connections) — `main.js`
- **registerIntelHandlers()** (4 connections) — `src/ipc/intel_ipc.js`
- **createIntelWidgetWindow()** (3 connections) — `main.js`
- **registerAssetHandlers()** (3 connections) — `src/ipc/assets_ipc.js`
- **registerForumHandlers()** (3 connections) — `src/ipc/forum_ipc.js`
- **{ ipcMain, BrowserWindow }** (1 connections) — `src/ipc/assets_ipc.js`
- **{ ESI_BASE }** (1 connections) — `src/ipc/assets_ipc.js`
- **{ APP_USER_AGENT }** (1 connections) — `src/ipc/forum_ipc.js`
- **{ BrowserWindow, session, net }** (1 connections) — `src/ipc/forum_ipc.js`
- **_forumScraper()** (1 connections) — `src/ipc/forum_ipc.js`
- **FORUM_SCRAPER_SRC** (1 connections) — `src/ipc/forum_ipc.js`
- **fs** (1 connections) — `src/ipc/intel_ipc.js`
- **path** (1 connections) — `src/ipc/intel_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (11 shared connections)
- [ESI Client Test](ESI_Client_Test.md) (3 shared connections)
- [Gridstack Touch & Drag-Drop](Gridstack_Touch_%26_Drag-Drop.md) (2 shared connections)
- [Electron Main Process (showMainWindow)](Electron_Main_Process_%28showMainWindow%29.md) (1 shared connections)
- [Demo Mode](Demo_Mode.md) (1 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (1 shared connections)
- [Auto Updater](Auto_Updater.md) (1 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (1 shared connections)

## Source Files

- `main.js`
- `src/ipc/assets_ipc.js`
- `src/ipc/forum_ipc.js`
- `src/ipc/intel_ipc.js`

## Audit Trail

- EXTRACTED: 59 (88%)
- INFERRED: 8 (12%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*