# Fleet Ops IPC

> 13 nodes · cohesion 0.18

## Key Concepts

- **fleet_ops_ipc.js** (12 connections) — `src/ipc/fleet_ops_ipc.js`
- **fleet_ipc_clone.test.js** (8 connections) — `test/fleet_ipc_clone.test.js`
- **cloneable()** (3 connections) — `src/ipc/fleet_ops_ipc.js`
- **registerFleetOpHandlers()** (3 connections) — `src/ipc/fleet_ops_ipc.js`
- **aar** (1 connections) — `src/ipc/fleet_ops_ipc.js`
- **kills** (1 connections) — `src/ipc/fleet_ops_ipc.js`
- **mining** (1 connections) — `src/ipc/fleet_ops_ipc.js`
- **ops** (1 connections) — `src/ipc/fleet_ops_ipc.js`
- **aar** (1 connections) — `test/fleet_ipc_clone.test.js`
- **assert** (1 connections) — `test/fleet_ipc_clone.test.js`
- **{ cloneable }** (1 connections) — `test/fleet_ipc_clone.test.js`
- **OP** (1 connections) — `test/fleet_ipc_clone.test.js`
- **test** (1 connections) — `test/fleet_ipc_clone.test.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [Fleet Aar](Fleet_Aar.md) (2 shared connections)
- [Fleet Kills](Fleet_Kills.md) (1 shared connections)
- [Fleet Mining](Fleet_Mining.md) (1 shared connections)
- [Fleet Ops](Fleet_Ops.md) (1 shared connections)

## Source Files

- `src/ipc/fleet_ops_ipc.js`
- `test/fleet_ipc_clone.test.js`

## Audit Trail

- EXTRACTED: 31 (89%)
- INFERRED: 4 (11%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*