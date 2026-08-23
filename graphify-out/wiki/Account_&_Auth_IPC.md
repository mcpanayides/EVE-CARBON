# Account & Auth IPC

> 18 nodes · cohesion 0.13

## Key Concepts

- **accounts_ipc.js** (11 connections) — `src/ipc/accounts_ipc.js`
- **{ BrowserWindow }** (9 connections) — `src/ipc/intel_ipc.js`
- **registerAccountHandlers()** (5 connections) — `src/ipc/accounts_ipc.js`
- **assets_ipc.js** (5 connections) — `src/ipc/assets_ipc.js`
- **intel_ipc.js** (5 connections) — `src/ipc/intel_ipc.js`
- **registerIntelHandlers()** (4 connections) — `src/ipc/intel_ipc.js`
- **registerAssetHandlers()** (3 connections) — `src/ipc/assets_ipc.js`
- **generateCodeVerifier()** (2 connections) — `src/ipc/accounts_ipc.js`
- **generateCodeChallenge()** (2 connections) — `src/ipc/accounts_ipc.js`
- **{ APP_USER_AGENT }** (1 connections) — `src/ipc/accounts_ipc.js`
- **{ ipcMain, BrowserWindow, shell }** (1 connections) — `src/ipc/accounts_ipc.js`
- **crypto** (1 connections) — `src/ipc/accounts_ipc.js`
- **SCOPES** (1 connections) — `src/ipc/accounts_ipc.js`
- **pendingAuth** (1 connections) — `src/ipc/accounts_ipc.js`
- **{ ipcMain, BrowserWindow }** (1 connections) — `src/ipc/assets_ipc.js`
- **{ ESI_BASE }** (1 connections) — `src/ipc/assets_ipc.js`
- **fs** (1 connections) — `src/ipc/intel_ipc.js`
- **path** (1 connections) — `src/ipc/intel_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (6 shared connections)
- [Package Manifest](Package_Manifest.md) (4 shared connections)
- [Electron Main Process (appIconPath)](Electron_Main_Process_%28appIconPath%29.md) (1 shared connections)
- [Demo Mode](Demo_Mode.md) (1 shared connections)
- [Auto Updater](Auto_Updater.md) (1 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (1 shared connections)
- [Gridstack Vendor Library (l)](Gridstack_Vendor_Library_%28l%29.md) (1 shared connections)

## Source Files

- `src/ipc/accounts_ipc.js`
- `src/ipc/assets_ipc.js`
- `src/ipc/intel_ipc.js`

## Audit Trail

- EXTRACTED: 48 (87%)
- INFERRED: 7 (13%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*