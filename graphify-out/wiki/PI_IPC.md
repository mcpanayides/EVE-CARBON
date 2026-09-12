# PI IPC

> 20 nodes · cohesion 0.14

## Key Concepts

- **t()** (16 connections) — `scripts/watch-fleet-op.js`
- **pi_ipc.js** (11 connections) — `src/ipc/pi_ipc.js`
- **watch-fleet-op.js** (8 connections) — `scripts/watch-fleet-op.js`
- **syncPIForCharacter()** (7 connections) — `src/ipc/pi_ipc.js`
- **registerPIHandlers()** (6 connections) — `src/ipc/pi_ipc.js`
- **render()** (3 connections) — `scripts/watch-fleet-op.js`
- **summariseStorage()** (3 connections) — `src/ipc/pi_ipc.js`
- **getJumpGraph()** (3 connections) — `src/ipc/pi_ipc.js`
- **_fitBuildTree()** (2 connections) — `main.js`
- **dur()** (2 connections) — `scripts/watch-fleet-op.js`
- **buildStorageTypes()** (2 connections) — `src/ipc/pi_ipc.js`
- **getItemVolume()** (2 connections) — `src/ipc/pi_ipc.js`
- **sqlite3** (1 connections) — `scripts/watch-fleet-op.js`
- **{ open }** (1 connections) — `scripts/watch-fleet-op.js`
- **path** (1 connections) — `scripts/watch-fleet-op.js`
- **ONCE** (1 connections) — `scripts/watch-fleet-op.js`
- **snapshot()** (1 connections) — `scripts/watch-fleet-op.js`
- **{ ESI_BASE }** (1 connections) — `src/ipc/pi_ipc.js`
- **PI_STORAGE_TYPES_FALLBACK** (1 connections) — `src/ipc/pi_ipc.js`
- **PI_ITEM_VOLUMES** (1 connections) — `src/ipc/pi_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (4 shared connections)
- [Main Process ESI & Cache Layer](Main_Process_ESI_%26_Cache_Layer.md) (2 shared connections)
- [Map IPC](Map_IPC.md) (1 shared connections)
- [Demo Mode](Demo_Mode.md) (1 shared connections)
- [Fitting Simulator (renderFitting)](Fitting_Simulator_%28renderFitting%29.md) (1 shared connections)
- [Fitting Drones & Stats Display](Fitting_Drones_%26_Stats_Display.md) (1 shared connections)
- [Market Trading](Market_Trading.md) (1 shared connections)
- [Jabber XMPP IPC](Jabber_XMPP_IPC.md) (1 shared connections)
- [Theme Vars](Theme_Vars.md) (1 shared connections)
- [Chart Umd (running)](Chart_Umd_%28running%29.md) (1 shared connections)
- [Chart Umd](Chart_Umd.md) (1 shared connections)
- [Chart Umd (utils)](Chart_Umd_%28utils%29.md) (1 shared connections)

## Source Files

- `main.js`
- `scripts/watch-fleet-op.js`
- `src/ipc/pi_ipc.js`

## Audit Trail

- EXTRACTED: 49 (67%)
- INFERRED: 24 (33%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*