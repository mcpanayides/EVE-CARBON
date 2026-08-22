# Forum IPC

> 20 nodes · cohesion 0.12

## Key Concepts

- **{ BrowserWindow }** (9 connections) — `src/ipc/intel_ipc.js`
- **forum_ipc.js** (8 connections) — `src/ipc/forum_ipc.js`
- **appIconPath()** (6 connections) — `main.js`
- **assets_ipc.js** (5 connections) — `src/ipc/assets_ipc.js`
- **intel_ipc.js** (5 connections) — `src/ipc/intel_ipc.js`
- **acrylicSupported()** (4 connections) — `main.js`
- **createPingAlertWindow()** (4 connections) — `main.js`
- **createWindow()** (4 connections) — `main.js`
- **registerIntelHandlers()** (4 connections) — `src/ipc/intel_ipc.js`
- **createIntelWidgetWindow()** (3 connections) — `main.js`
- **registerAssetHandlers()** (3 connections) — `src/ipc/assets_ipc.js`
- **registerForumHandlers()** (3 connections) — `src/ipc/forum_ipc.js`
- **{ ESI_BASE }** (1 connections) — `src/ipc/assets_ipc.js`
- **{ ipcMain, BrowserWindow }** (1 connections) — `src/ipc/assets_ipc.js`
- **{ APP_USER_AGENT }** (1 connections) — `src/ipc/forum_ipc.js`
- **{ BrowserWindow, session, net }** (1 connections) — `src/ipc/forum_ipc.js`
- **FORUM_SCRAPER_SRC** (1 connections) — `src/ipc/forum_ipc.js`
- **_forumScraper()** (1 connections) — `src/ipc/forum_ipc.js`
- **fs** (1 connections) — `src/ipc/intel_ipc.js`
- **path** (1 connections) — `src/ipc/intel_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (11 shared connections)
- [ESI Client.test](ESI_Client.test.md) (3 shared connections)
- [Fitting Tree & Scheduling](Fitting_Tree_%26_Scheduling.md) (1 shared connections)
- [Main](Main.md) (1 shared connections)
- [Accounts IPC](Accounts_IPC.md) (1 shared connections)
- [Updater IPC](Updater_IPC.md) (1 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (1 shared connections)
- [Gridstack All](Gridstack_All.md) (1 shared connections)

## Source Files

- `main.js`
- `src/ipc/assets_ipc.js`
- `src/ipc/forum_ipc.js`
- `src/ipc/intel_ipc.js`

## Audit Trail

- EXTRACTED: 58 (88%)
- INFERRED: 8 (12%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*