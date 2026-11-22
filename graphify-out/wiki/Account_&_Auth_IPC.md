# Account & Auth IPC

> 10 nodes · cohesion 0.27

## Key Concepts

- **accounts_ipc.js** (14 connections) — `src/ipc/accounts_ipc.js`
- **registerAccountHandlers()** (6 connections) — `src/ipc/accounts_ipc.js`
- **_demoAccessToken()** (4 connections) — `main.js`
- **generateCodeChallenge()** (2 connections) — `src/ipc/accounts_ipc.js`
- **generateCodeVerifier()** (2 connections) — `src/ipc/accounts_ipc.js`
- **SCOPES** (2 connections) — `src/ipc/accounts_ipc.js`
- **https** (1 connections) — `https`
- **crypto** (1 connections) — `src/ipc/accounts_ipc.js`
- **{ ipcMain, BrowserWindow, shell }** (1 connections) — `src/ipc/accounts_ipc.js`
- **pendingAuth** (1 connections) — `src/ipc/accounts_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (3 shared connections)
- [Auto Updater](Auto_Updater.md) (2 shared connections)
- [Character IPC](Character_IPC.md) (2 shared connections)
- [Main Process ESI & Cache Layer](Main_Process_ESI_&_Cache_Layer.md) (1 shared connections)
- [Preload Bridge](Preload_Bridge.md) (1 shared connections)
- [Presence](Presence.md) (1 shared connections)

## Source Files

- `https`
- `main.js`
- `src/ipc/accounts_ipc.js`

## Audit Trail

- EXTRACTED: 21 (95%)
- INFERRED: 1 (5%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*