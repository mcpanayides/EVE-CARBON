# ESI Client Test

> 25 nodes · cohesion 0.10

## Key Concepts

- **app_ident.js** (23 connections) — `src/app_ident.js`
- **APP_USER_AGENT** (11 connections) — `src/app_ident.js`
- **esi_client.test.js** (9 connections) — `test/esi_client.test.js`
- **character_ipc.js** (8 connections) — `src/ipc/character_ipc.js`
- **esi_headers.test.js** (6 connections) — `test/esi_headers.test.js`
- **Esi** (4 connections) — `src/app_ident.js`
- **esi.js** (4 connections) — `src/shared/esi.js`
- **url()** (4 connections) — `src/shared/esi.js`
- **syncStationDatabase()** (2 connections) — `src/locator.js`
- **{ version }** (1 connections) — `src/app_ident.js`
- **{ ipcMain }** (1 connections) — `src/ipc/character_ipc.js`
- **{ ESI_BASE, Esi }** (1 connections) — `src/ipc/character_ipc.js`
- **registered** (1 connections) — `src/ipc/character_ipc.js`
- **registerCharacterHandlers()** (1 connections) — `src/ipc/character_ipc.js`
- **NOTE: the corp mining routes use singular "/corporation/" (an ESI quirk),** (1 connections) — `src/ipc/character_ipc.js`
- **headers()** (1 connections) — `src/shared/esi.js`
- **test** (1 connections) — `test/esi_client.test.js`
- **assert** (1 connections) — `test/esi_client.test.js`
- **fs** (1 connections) — `test/esi_client.test.js`
- **path** (1 connections) — `test/esi_client.test.js`
- **Esi** (1 connections) — `test/esi_client.test.js`
- **{ APP_USER_AGENT, ESI_COMPATIBILITY_DATE, ESI_BASE }** (1 connections) — `test/esi_client.test.js`
- **test** (1 connections) — `test/esi_headers.test.js`
- **assert** (1 connections) — `test/esi_headers.test.js`
- **{ Esi, ESI_BASE, ESI_COMPATIBILITY_DATE, APP_USER_AGENT }** (1 connections) — `test/esi_headers.test.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (4 shared connections)
- [Forum IPC](Forum_IPC.md) (3 shared connections)
- [Station & Structure Locator](Station_%26_Structure_Locator.md) (3 shared connections)
- [Package Manifest (package json)](Package_Manifest_%28package_json%29.md) (2 shared connections)
- [SDE Fetch & Build](SDE_Fetch_%26_Build.md) (2 shared connections)
- [Intel Service](Intel_Service.md) (2 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (2 shared connections)
- [ESI IPC](ESI_IPC.md) (2 shared connections)
- [Auto Updater](Auto_Updater.md) (2 shared connections)
- [Intel Zkill Stream Test](Intel_Zkill_Stream_Test.md) (1 shared connections)
- [Alert Rules](Alert_Rules.md) (1 shared connections)
- [Map IPC](Map_IPC.md) (1 shared connections)

## Source Files

- `src/app_ident.js`
- `src/ipc/character_ipc.js`
- `src/locator.js`
- `src/shared/esi.js`
- `test/esi_client.test.js`
- `test/esi_headers.test.js`

## Audit Trail

- EXTRACTED: 81 (93%)
- INFERRED: 6 (7%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*