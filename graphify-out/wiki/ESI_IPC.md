# ESI IPC

> 42 nodes · cohesion 0.06

## Key Concepts

- **app_ident.js** (23 connections) — `src/app_ident.js`
- **esi_ipc.js** (13 connections) — `src/ipc/esi_ipc.js`
- **APP_USER_AGENT** (11 connections) — `src/app_ident.js`
- **esi_client.test.js** (9 connections) — `test/esi_client.test.js`
- **character_ipc.js** (8 connections) — `src/ipc/character_ipc.js`
- **forum_ipc.js** (8 connections) — `src/ipc/forum_ipc.js`
- **esi_headers.test.js** (6 connections) — `test/esi_headers.test.js`
- **registerEsiHandlers()** (5 connections) — `src/ipc/esi_ipc.js`
- **esi.js** (5 connections) — `src/shared/esi.js`
- **fuzzwork_api.test.js** (5 connections) — `test/fuzzwork_api.test.js`
- **Esi** (4 connections) — `src/app_ident.js`
- **fetchFuzzworkBlueprint()** (4 connections) — `src/ipc/esi_ipc.js`
- **registerForumHandlers()** (3 connections) — `src/ipc/forum_ipc.js`
- **FUZZWORK_BLUEPRINT_URL()** (2 connections) — `src/ipc/esi_ipc.js`
- **_fuzzworkMaterials()** (2 connections) — `src/ipc/esi_ipc.js`
- **{ version }** (1 connections) — `src/app_ident.js`
- **{ ipcMain }** (1 connections) — `src/ipc/character_ipc.js`
- **{ ESI_BASE, Esi }** (1 connections) — `src/ipc/character_ipc.js`
- **registered** (1 connections) — `src/ipc/character_ipc.js`
- **NOTE: the corp mining routes use singular "/corporation/" (an ESI quirk),** (1 connections) — `src/ipc/character_ipc.js`
- **{ APP_USER_AGENT, ESI_BASE }** (1 connections) — `src/ipc/esi_ipc.js`
- **demoMode** (1 connections) — `src/ipc/esi_ipc.js`
- **{ ipcMain }** (1 connections) — `src/ipc/esi_ipc.js`
- **TICKER_TYPE_IDS** (1 connections) — `src/ipc/esi_ipc.js`
- **{ APP_USER_AGENT }** (1 connections) — `src/ipc/forum_ipc.js`
- *... and 17 more nodes in this community*

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (8 shared connections)
- [Package Manifest (package json)](Package_Manifest_%28package_json%29.md) (2 shared connections)
- [SDE Fetch & Build](SDE_Fetch_%26_Build.md) (2 shared connections)
- [Zkill Stream](Zkill_Stream.md) (2 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (2 shared connections)
- [Electron Main Process (appIconPath)](Electron_Main_Process_%28appIconPath%29.md) (2 shared connections)
- [Auto Updater](Auto_Updater.md) (2 shared connections)
- [Station & Structure Locator](Station_%26_Structure_Locator.md) (2 shared connections)
- [Demo Mode](Demo_Mode.md) (2 shared connections)
- [Intel Zkill Stream Test](Intel_Zkill_Stream_Test.md) (1 shared connections)
- [Alert Rules](Alert_Rules.md) (1 shared connections)
- [Map IPC](Map_IPC.md) (1 shared connections)

## Source Files

- `src/app_ident.js`
- `src/ipc/character_ipc.js`
- `src/ipc/esi_ipc.js`
- `src/ipc/forum_ipc.js`
- `src/shared/esi.js`
- `test/esi_client.test.js`
- `test/esi_headers.test.js`
- `test/fuzzwork_api.test.js`

## Audit Trail

- EXTRACTED: 125 (93%)
- INFERRED: 10 (7%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*