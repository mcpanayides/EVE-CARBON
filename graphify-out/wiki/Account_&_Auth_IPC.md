# Account & Auth IPC

> 37 nodes · cohesion 0.07

## Key Concepts

- **app_ident.js** (23 connections) — `src/app_ident.js`
- **APP_USER_AGENT** (11 connections) — `src/app_ident.js`
- **accounts_ipc.js** (11 connections) — `src/ipc/accounts_ipc.js`
- **esi_client.test.js** (9 connections) — `test/esi_client.test.js`
- **character_ipc.js** (8 connections) — `src/ipc/character_ipc.js`
- **forum_ipc.js** (8 connections) — `src/ipc/forum_ipc.js`
- **esi_headers.test.js** (6 connections) — `test/esi_headers.test.js`
- **registerAccountHandlers()** (5 connections) — `src/ipc/accounts_ipc.js`
- **Esi** (4 connections) — `src/app_ident.js`
- **esi.js** (4 connections) — `src/shared/esi.js`
- **registerForumHandlers()** (3 connections) — `src/ipc/forum_ipc.js`
- **generateCodeVerifier()** (2 connections) — `src/ipc/accounts_ipc.js`
- **generateCodeChallenge()** (2 connections) — `src/ipc/accounts_ipc.js`
- **{ version }** (1 connections) — `src/app_ident.js`
- **{ APP_USER_AGENT }** (1 connections) — `src/ipc/accounts_ipc.js`
- **{ ipcMain, BrowserWindow, shell }** (1 connections) — `src/ipc/accounts_ipc.js`
- **crypto** (1 connections) — `src/ipc/accounts_ipc.js`
- **SCOPES** (1 connections) — `src/ipc/accounts_ipc.js`
- **pendingAuth** (1 connections) — `src/ipc/accounts_ipc.js`
- **{ ipcMain }** (1 connections) — `src/ipc/character_ipc.js`
- **{ ESI_BASE, Esi }** (1 connections) — `src/ipc/character_ipc.js`
- **registered** (1 connections) — `src/ipc/character_ipc.js`
- **NOTE: the corp mining routes use singular "/corporation/" (an ESI quirk),** (1 connections) — `src/ipc/character_ipc.js`
- **{ APP_USER_AGENT }** (1 connections) — `src/ipc/forum_ipc.js`
- **{ BrowserWindow, session, net }** (1 connections) — `src/ipc/forum_ipc.js`
- *... and 12 more nodes in this community*

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (8 shared connections)
- [Electron Main Process (appIconPath)](Electron_Main_Process_%28appIconPath%29.md) (3 shared connections)
- [Station & Structure Locator](Station_%26_Structure_Locator.md) (3 shared connections)
- [Package Manifest (package json)](Package_Manifest_%28package_json%29.md) (2 shared connections)
- [SDE Fetch & Build](SDE_Fetch_%26_Build.md) (2 shared connections)
- [Zkill Stream](Zkill_Stream.md) (2 shared connections)
- [ESI IPC](ESI_IPC.md) (2 shared connections)
- [Auto Updater](Auto_Updater.md) (2 shared connections)
- [Intel Zkill Stream Test](Intel_Zkill_Stream_Test.md) (1 shared connections)
- [Alert Rules](Alert_Rules.md) (1 shared connections)
- [Map IPC](Map_IPC.md) (1 shared connections)
- [PI IPC](PI_IPC.md) (1 shared connections)

## Source Files

- `src/app_ident.js`
- `src/ipc/accounts_ipc.js`
- `src/ipc/character_ipc.js`
- `src/ipc/forum_ipc.js`
- `src/shared/esi.js`
- `test/esi_client.test.js`
- `test/esi_headers.test.js`

## Audit Trail

- EXTRACTED: 115 (96%)
- INFERRED: 5 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*