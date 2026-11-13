# Fleet Kills

> 20 nodes · cohesion 0.14

## Key Concepts

- **fleet_ops_ipc.js** (8 connections) — `src/ipc/fleet_ops_ipc.js`
- **fleet_ipc_clone.test.js** (8 connections) — `test/fleet_ipc_clone.test.js`
- **registerFleetOpHandlers()** (7 connections) — `src/ipc/fleet_ops_ipc.js`
- **fleet_kills.js** (7 connections) — `src/fleet_kills.js`
- **fleet_mining.js** (7 connections) — `src/fleet_mining.js`
- **pullOpKills()** (5 connections) — `src/fleet_kills.js`
- **cloneable()** (5 connections) — `src/ipc/fleet_ops_ipc.js`
- **classifyKillmail()** (2 connections) — `src/fleet_kills.js`
- **pastSecondsFor()** (2 connections) — `src/fleet_kills.js`
- **summarise()** (2 connections) — `src/fleet_kills.js`
- **systemUrl()** (2 connections) — `src/fleet_kills.js`
- **computeDelta()** (2 connections) — `src/fleet_mining.js`
- **key()** (2 connections) — `src/fleet_mining.js`
- **priceRows()** (1 connections) — `src/fleet_mining.js`
- **restrictToSystems()** (1 connections) — `src/fleet_mining.js`
- **summarise()** (1 connections) — `src/fleet_mining.js`
- **trackerFor()** (1 connections) — `src/ipc/fleet_ops_ipc.js`
- **assert** (1 connections) — `test/fleet_ipc_clone.test.js`
- **OP** (1 connections) — `test/fleet_ipc_clone.test.js`
- **test** (1 connections) — `test/fleet_ipc_clone.test.js`

## Relationships

- [Sso Scopes Test](Sso_Scopes_Test.md) (3 shared connections)
- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [PI Tally Test](PI_Tally_Test.md) (2 shared connections)
- [Fleet After-Action Report](Fleet_After-Action_Report.md) (2 shared connections)
- [Intel IPC](Intel_IPC.md) (1 shared connections)
- [Fleet Kills Test](Fleet_Kills_Test.md) (1 shared connections)
- [Fleet Op Records](Fleet_Op_Records.md) (1 shared connections)

## Source Files

- `src/fleet_kills.js`
- `src/fleet_mining.js`
- `src/ipc/fleet_ops_ipc.js`
- `test/fleet_ipc_clone.test.js`

## Audit Trail

- EXTRACTED: 28 (72%)
- INFERRED: 11 (28%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*