# Auto Updater

> 25 nodes · cohesion 0.12

## Key Concepts

- **updater_ipc.js** (18 connections) — `src/ipc/updater_ipc.js`
- **accounts_ipc.js** (14 connections) — `src/ipc/accounts_ipc.js`
- **ref_https** (9 connections)
- **registerUpdaterHandlers()** (7 connections) — `src/ipc/updater_ipc.js`
- **registerAccountHandlers()** (6 connections) — `src/ipc/accounts_ipc.js`
- **downloadBinary()** (6 connections) — `src/ipc/updater_ipc.js`
- **fetchJson()** (6 connections) — `src/ipc/updater_ipc.js`
- **ref_crypto** (6 connections)
- **_demoAccessToken()** (4 connections) — `main.js`
- **parseReleaseFlags()** (4 connections) — `src/ipc/updater_ipc.js`
- **ref_http** (4 connections)
- **generateCodeChallenge()** (2 connections) — `src/ipc/accounts_ipc.js`
- **generateCodeVerifier()** (2 connections) — `src/ipc/accounts_ipc.js`
- **startCallbackServer()** (2 connections) — `src/ipc/accounts_ipc.js`
- **clean()** (2 connections) — `src/ipc/updater_ipc.js`
- **compareVersions()** (2 connections) — `src/ipc/updater_ipc.js`
- **SCOPES** (2 connections) — `src/ipc/accounts_ipc.js`
- **https** (1 connections) — `https`
- **crypto** (1 connections) — `src/ipc/accounts_ipc.js`
- **{ ipcMain, BrowserWindow, shell }** (1 connections) — `src/ipc/accounts_ipc.js`
- **pendingAuth** (1 connections) — `src/ipc/accounts_ipc.js`
- **fs** (1 connections) — `src/ipc/updater_ipc.js`
- **os** (1 connections) — `src/ipc/updater_ipc.js`
- **path** (1 connections) — `src/ipc/updater_ipc.js`
- **{ shell, BrowserWindow }** (1 connections) — `src/ipc/updater_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (8 shared connections)
- [PI Tally Test](PI_Tally_Test.md) (4 shared connections)
- [Character IPC](Character_IPC.md) (4 shared connections)
- [Station & Structure Locator](Station_&_Structure_Locator.md) (2 shared connections)
- [Intel IPC](Intel_IPC.md) (2 shared connections)
- [SDE Build](SDE_Build.md) (2 shared connections)
- [Main Process ESI & Cache Layer](Main_Process_ESI_&_Cache_Layer.md) (1 shared connections)
- [Demo Mode Test](Demo_Mode_Test.md) (1 shared connections)
- [Presence](Presence.md) (1 shared connections)
- [HTTP Request Broker](HTTP_Request_Broker.md) (1 shared connections)
- [Resfile Backgrounds](Resfile_Backgrounds.md) (1 shared connections)
- [Zkill Stream](Zkill_Stream.md) (1 shared connections)

## Source Files

- `https`
- `main.js`
- `src/ipc/accounts_ipc.js`
- `src/ipc/updater_ipc.js`

## Audit Trail

- EXTRACTED: 64 (96%)
- INFERRED: 3 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*