# Fleet Ops IPC

> 8 nodes · cohesion 0.32

## Key Concepts

- **fleet_ops_ipc.js** (8 connections) — `src/ipc/fleet_ops_ipc.js`
- **fleet_ipc_clone.test.js** (8 connections) — `test/fleet_ipc_clone.test.js`
- **registerFleetOpHandlers()** (7 connections) — `src/ipc/fleet_ops_ipc.js`
- **cloneable()** (5 connections) — `src/ipc/fleet_ops_ipc.js`
- **trackerFor()** (1 connections) — `src/ipc/fleet_ops_ipc.js`
- **assert** (1 connections) — `test/fleet_ipc_clone.test.js`
- **OP** (1 connections) — `test/fleet_ipc_clone.test.js`
- **test** (1 connections) — `test/fleet_ipc_clone.test.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [Dashboard Killfeed Test](Dashboard_Killfeed_Test.md) (2 shared connections)
- [Fleet After-Action Report](Fleet_After-Action_Report.md) (2 shared connections)
- [Palette Slots Test](Palette_Slots_Test.md) (2 shared connections)
- [Intel IPC (registerConfigHandlers)](Intel_IPC_registerConfigHandlers.md) (1 shared connections)
- [Fleet Op Records](Fleet_Op_Records.md) (1 shared connections)
- [Fleet Kills](Fleet_Kills.md) (1 shared connections)
- [Fleet Mining](Fleet_Mining.md) (1 shared connections)

## Source Files

- `src/ipc/fleet_ops_ipc.js`
- `test/fleet_ipc_clone.test.js`

## Audit Trail

- EXTRACTED: 20 (91%)
- INFERRED: 2 (9%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*