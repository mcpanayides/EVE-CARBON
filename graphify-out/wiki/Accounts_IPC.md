# Accounts IPC

> 9 nodes · cohesion 0.28

## Key Concepts

- **accounts_ipc.js** (11 connections) — `src/ipc/accounts_ipc.js`
- **registerAccountHandlers()** (5 connections) — `src/ipc/accounts_ipc.js`
- **generateCodeChallenge()** (2 connections) — `src/ipc/accounts_ipc.js`
- **generateCodeVerifier()** (2 connections) — `src/ipc/accounts_ipc.js`
- **{ APP_USER_AGENT }** (1 connections) — `src/ipc/accounts_ipc.js`
- **crypto** (1 connections) — `src/ipc/accounts_ipc.js`
- **{ ipcMain, BrowserWindow, shell }** (1 connections) — `src/ipc/accounts_ipc.js`
- **pendingAuth** (1 connections) — `src/ipc/accounts_ipc.js`
- **SCOPES** (1 connections) — `src/ipc/accounts_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [ESI Client.test](ESI_Client.test.md) (2 shared connections)
- [Forum IPC](Forum_IPC.md) (1 shared connections)

## Source Files

- `src/ipc/accounts_ipc.js`

## Audit Trail

- EXTRACTED: 23 (92%)
- INFERRED: 2 (8%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*