# Electron Main Process

> 102 nodes · cohesion 0.02

## Key Concepts

- **main.js** (189 connections) — `main.js`
- **loadConfig()** (4 connections) — `main.js`
- **_readSealed()** (4 connections) — `main.js`
- **_writeSealed()** (4 connections) — `main.js`
- **createTray()** (4 connections) — `main.js`
- **applyMinimizeToTray()** (4 connections) — `main.js`
- **_esiNoteResponseCore()** (3 connections) — `main.js`
- **showMainWindow()** (3 connections) — `main.js`
- **config_ipc.js** (3 connections) — `src/ipc/config_ipc.js`
- **station_ipc.js** (3 connections) — `src/ipc/station_ipc.js`
- **getSdePath()** (2 connections) — `main.js`
- **initSde()** (2 connections) — `main.js`
- **resolvePackFile()** (2 connections) — `main.js`
- **_readLaunchAtLogin()** (2 connections) — `main.js`
- **_serveDemoForum()** (2 connections) — `main.js`
- **_setDemoForumCookies()** (2 connections) — `main.js`
- **loadJumpBridges()** (2 connections) — `main.js`
- **saveJumpBridges()** (2 connections) — `main.js`
- **loadOtherJumpBridges()** (2 connections) — `main.js`
- **saveOtherJumpBridges()** (2 connections) — `main.js`
- **loadJumpGateSyncState()** (2 connections) — `main.js`
- **saveJumpGateSyncState()** (2 connections) — `main.js`
- **_esiNoteFetchResponse()** (2 connections) — `main.js`
- **destroyTray()** (2 connections) — `main.js`
- **registerConfigHandlers()** (2 connections) — `src/ipc/config_ipc.js`
- *... and 77 more nodes in this community*

## Relationships

- [Main Process ESI & Cache Layer](Main_Process_ESI_%26_Cache_Layer.md) (38 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (10 shared connections)
- [Demo Fixtures Test](Demo_Fixtures_Test.md) (6 shared connections)
- [PI IPC](PI_IPC.md) (4 shared connections)
- [Presence](Presence.md) (4 shared connections)
- [Demo Mode](Demo_Mode.md) (2 shared connections)
- [Zkill Fanout Worker Test](Zkill_Fanout_Worker_Test.md) (2 shared connections)
- [ESI IPC](ESI_IPC.md) (2 shared connections)
- [Fleet Ops IPC](Fleet_Ops_IPC.md) (2 shared connections)
- [Jump Gate List](Jump_Gate_List.md) (2 shared connections)
- [Map IPC](Map_IPC.md) (2 shared connections)
- [Theme Vars](Theme_Vars.md) (2 shared connections)

## Source Files

- `main.js`
- `src/ipc/config_ipc.js`
- `src/ipc/station_ipc.js`

## Audit Trail

- EXTRACTED: 323 (98%)
- INFERRED: 6 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*