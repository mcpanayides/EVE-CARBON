# Map IPC

> 28 nodes · cohesion 0.11

## Key Concepts

- **map_ipc.js** (15 connections) — `src/ipc/map_ipc.js`
- **galaxy_layout.js** (7 connections) — `src/galaxy_layout.js`
- **registerMapHandlers()** (7 connections) — `src/ipc/map_ipc.js`
- **cpu_budget.test.js** (7 connections) — `test/cpu_budget.test.js`
- **cpu_budget.js** (6 connections) — `src/cpu_budget.js`
- **workerCount()** (4 connections) — `src/cpu_budget.js`
- **balance()** (4 connections) — `src/cpu_budget.js`
- **buildRegionLayouts()** (4 connections) — `src/galaxy_layout.js`
- **_recordHistory()** (4 connections) — `src/ipc/map_ipc.js`
- **logicalCores()** (3 connections) — `src/cpu_budget.js`
- **_fetchSovSystems()** (2 connections) — `src/ipc/map_ipc.js`
- **_bundledLayoutPath()** (2 connections) — `src/ipc/map_ipc.js`
- **_modernLayoutPath()** (2 connections) — `src/ipc/map_ipc.js`
- **_historyAppend()** (2 connections) — `src/ipc/map_ipc.js`
- **_historyTrim()** (2 connections) — `src/ipc/map_ipc.js`
- **os** (1 connections) — `src/cpu_budget.js`
- **path** (1 connections) — `src/galaxy_layout.js`
- **{ Worker }** (1 connections) — `src/galaxy_layout.js`
- **cpuBudget** (1 connections) — `src/galaxy_layout.js`
- **WORKER_FILE** (1 connections) — `src/galaxy_layout.js`
- **{ app }** (1 connections) — `src/ipc/map_ipc.js`
- **fs** (1 connections) — `src/ipc/map_ipc.js`
- **path** (1 connections) — `src/ipc/map_ipc.js`
- **galaxyLayout** (1 connections) — `src/ipc/map_ipc.js`
- **{ ESI_BASE }** (1 connections) — `src/ipc/map_ipc.js`
- *... and 3 more nodes in this community*

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [Market Trading](Market_Trading.md) (1 shared connections)
- [Account & Auth IPC](Account_%26_Auth_IPC.md) (1 shared connections)

## Source Files

- `src/cpu_budget.js`
- `src/galaxy_layout.js`
- `src/ipc/map_ipc.js`
- `test/cpu_budget.test.js`

## Audit Trail

- EXTRACTED: 73 (87%)
- INFERRED: 11 (13%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*