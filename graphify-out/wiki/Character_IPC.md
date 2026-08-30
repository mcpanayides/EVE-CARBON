# Character IPC

> 14 nodes · cohesion 0.18

## Key Concepts

- **app_ident.js** (23 connections) — `src/app_ident.js`
- **APP_USER_AGENT** (11 connections) — `src/app_ident.js`
- **character_ipc.js** (8 connections) — `src/ipc/character_ipc.js`
- **esi_headers.test.js** (6 connections) — `test/esi_headers.test.js`
- **Esi** (4 connections) — `src/app_ident.js`
- **{ version }** (1 connections) — `src/app_ident.js`
- **{ ipcMain }** (1 connections) — `src/ipc/character_ipc.js`
- **{ ESI_BASE, Esi }** (1 connections) — `src/ipc/character_ipc.js`
- **registered** (1 connections) — `src/ipc/character_ipc.js`
- **registerCharacterHandlers()** (1 connections) — `src/ipc/character_ipc.js`
- **NOTE: the corp mining routes use singular "/corporation/" (an ESI quirk),** (1 connections) — `src/ipc/character_ipc.js`
- **test** (1 connections) — `test/esi_headers.test.js`
- **assert** (1 connections) — `test/esi_headers.test.js`
- **{ Esi, ESI_BASE, ESI_COMPATIBILITY_DATE, APP_USER_AGENT }** (1 connections) — `test/esi_headers.test.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (4 shared connections)
- [ESI Client Test](ESI_Client_Test.md) (3 shared connections)
- [Forum IPC](Forum_IPC.md) (3 shared connections)
- [Package Manifest (package json)](Package_Manifest_%28package_json%29.md) (2 shared connections)
- [SDE Fetch & Build](SDE_Fetch_%26_Build.md) (2 shared connections)
- [Zkill Stream](Zkill_Stream.md) (2 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (2 shared connections)
- [ESI IPC](ESI_IPC.md) (2 shared connections)
- [Auto Updater](Auto_Updater.md) (2 shared connections)
- [Station & Structure Locator](Station_%26_Structure_Locator.md) (2 shared connections)
- [Intel Zkill Stream Test](Intel_Zkill_Stream_Test.md) (1 shared connections)
- [Alert Rules](Alert_Rules.md) (1 shared connections)

## Source Files

- `src/app_ident.js`
- `src/ipc/character_ipc.js`
- `test/esi_headers.test.js`

## Audit Trail

- EXTRACTED: 59 (97%)
- INFERRED: 2 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*