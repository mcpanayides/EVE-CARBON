# Character IPC

> 36 nodes · cohesion 0.07

## Key Concepts

- **app_ident.js** (21 connections) — `src/app_ident.js`
- **esi_client.test.js** (13 connections) — `test/esi_client.test.js`
- **src_app_ident_esi_base** (12 connections)
- **APP_USER_AGENT** (11 connections) — `src/app_ident.js`
- **zkill_stream.js** (11 connections) — `src/intel/zkill_stream.js`
- **character_ipc.js** (9 connections) — `src/ipc/character_ipc.js`
- **esi_headers.test.js** (9 connections) — `test/esi_headers.test.js`
- **forum_ipc.js** (8 connections) — `src/ipc/forum_ipc.js`
- **assets_ipc.js** (6 connections) — `src/ipc/assets_ipc.js`
- **esi.js** (5 connections) — `src/shared/esi.js`
- **registerAssetHandlers()** (4 connections) — `src/ipc/assets_ipc.js`
- **registerCharacterHandlers()** (3 connections) — `src/ipc/character_ipc.js`
- **_forumScraper()** (3 connections) — `src/ipc/forum_ipc.js`
- **src_app_ident_esi** (3 connections)
- **src_app_ident_esi_compatibility_date** (3 connections)
- **classify()** (2 connections) — `src/ipc/forum_ipc.js`
- **tableData()** (2 connections) — `src/ipc/forum_ipc.js`
- **directGet()** (1 connections) — `src/intel/zkill_stream.js`
- **syncAssetsInternal()** (1 connections) — `src/ipc/assets_ipc.js`
- **worker()** (1 connections) — `src/ipc/assets_ipc.js`
- **fetchZkillFeed()** (1 connections) — `src/ipc/character_ipc.js`
- **headers()** (1 connections) — `src/shared/esi.js`
- **url()** (1 connections) — `src/shared/esi.js`
- **https** (1 connections) — `src/intel/zkill_stream.js`
- **{ ipcMain, BrowserWindow }** (1 connections) — `src/ipc/assets_ipc.js`
- *... and 11 more nodes in this community*

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (10 shared connections)
- [PI Roles Test](PI_Roles_Test.md) (7 shared connections)
- [Preload Bridge](Preload_Bridge.md) (4 shared connections)
- [Intel Zkill Stream Test](Intel_Zkill_Stream_Test.md) (3 shared connections)
- [ESI IPC](ESI_IPC.md) (3 shared connections)
- [Auto Updater](Auto_Updater.md) (3 shared connections)
- [Station & Structure Locator](Station_&_Structure_Locator.md) (3 shared connections)
- [NPM Dev Dependencies](NPM_Dev_Dependencies.md) (2 shared connections)
- [Fetch SDE](Fetch_SDE.md) (2 shared connections)
- [Intel IPC](Intel_IPC.md) (2 shared connections)
- [Account & Auth IPC](Account_&_Auth_IPC.md) (2 shared connections)
- [Force Projection](Force_Projection.md) (2 shared connections)

## Source Files

- `src/app_ident.js`
- `src/intel/zkill_stream.js`
- `src/ipc/assets_ipc.js`
- `src/ipc/character_ipc.js`
- `src/ipc/forum_ipc.js`
- `src/shared/esi.js`
- `test/esi_client.test.js`
- `test/esi_headers.test.js`

## Audit Trail

- EXTRACTED: 90 (92%)
- INFERRED: 8 (8%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*