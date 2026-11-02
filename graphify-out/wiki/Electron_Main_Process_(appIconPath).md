# Electron Main Process (appIconPath)

> 24 nodes · cohesion 0.10

## Key Concepts

- **{ BrowserWindow }** (11 connections) — `src/ipc/intel_ipc.js`
- **forum_ipc.js** (8 connections) — `src/ipc/forum_ipc.js`
- **appIconPath()** (5 connections) — `main.js`
- **acrylicSupported()** (5 connections) — `main.js`
- **assets_ipc.js** (5 connections) — `src/ipc/assets_ipc.js`
- **intel_ipc.js** (5 connections) — `src/ipc/intel_ipc.js`
- **createPingAlertWindow()** (4 connections) — `main.js`
- **createTray()** (4 connections) — `main.js`
- **applyMinimizeToTray()** (4 connections) — `main.js`
- **registerAssetHandlers()** (4 connections) — `src/ipc/assets_ipc.js`
- **registerIntelHandlers()** (4 connections) — `src/ipc/intel_ipc.js`
- **createIntelWidgetWindow()** (3 connections) — `main.js`
- **applyWidgetPin()** (3 connections) — `main.js`
- **showMainWindow()** (3 connections) — `main.js`
- **registerForumHandlers()** (3 connections) — `src/ipc/forum_ipc.js`
- **destroyTray()** (2 connections) — `main.js`
- **{ ipcMain, BrowserWindow }** (1 connections) — `src/ipc/assets_ipc.js`
- **{ ESI_BASE }** (1 connections) — `src/ipc/assets_ipc.js`
- **{ APP_USER_AGENT }** (1 connections) — `src/ipc/forum_ipc.js`
- **{ BrowserWindow, session, net }** (1 connections) — `src/ipc/forum_ipc.js`
- **_forumScraper()** (1 connections) — `src/ipc/forum_ipc.js`
- **FORUM_SCRAPER_SRC** (1 connections) — `src/ipc/forum_ipc.js`
- **fs** (1 connections) — `src/ipc/intel_ipc.js`
- **path** (1 connections) — `src/ipc/intel_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (15 shared connections)
- [Demo Mode](Demo_Mode.md) (3 shared connections)
- [Demo Fixtures Test](Demo_Fixtures_Test.md) (3 shared connections)
- [Zkill Fanout Worker Test](Zkill_Fanout_Worker_Test.md) (1 shared connections)
- [Electron App](Electron_App.md) (1 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (1 shared connections)
- [Auto Updater](Auto_Updater.md) (1 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (1 shared connections)
- [Demo Skill Sheets](Demo_Skill_Sheets.md) (1 shared connections)

## Source Files

- `main.js`
- `src/ipc/assets_ipc.js`
- `src/ipc/forum_ipc.js`
- `src/ipc/intel_ipc.js`

## Audit Trail

- EXTRACTED: 71 (88%)
- INFERRED: 10 (12%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*