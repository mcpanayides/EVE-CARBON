# Map IPC

> 25 nodes · cohesion 0.11

## Key Concepts

- **map_ipc.js** (12 connections) — `src/ipc/map_ipc.js`
- **galaxy_layout.js** (7 connections) — `src/galaxy_layout.js`
- **cpu_budget.test.js** (7 connections) — `test/cpu_budget.test.js`
- **cpu_budget.js** (6 connections) — `src/cpu_budget.js`
- **registerMapHandlers()** (6 connections) — `src/ipc/map_ipc.js`
- **workerCount()** (4 connections) — `src/cpu_budget.js`
- **balance()** (4 connections) — `src/cpu_budget.js`
- **buildRegionLayouts()** (4 connections) — `src/galaxy_layout.js`
- **logicalCores()** (3 connections) — `src/cpu_budget.js`
- **_fetchSovSystems()** (2 connections) — `src/ipc/map_ipc.js`
- **_bundledLayoutPath()** (2 connections) — `src/ipc/map_ipc.js`
- **_modernLayoutPath()** (2 connections) — `src/ipc/map_ipc.js`
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
- **test** (1 connections) — `test/cpu_budget.test.js`
- **assert** (1 connections) — `test/cpu_budget.test.js`
- **{ workerCount, balance, logicalCores, MAX_WORKERS }** (1 connections) — `test/cpu_budget.test.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [Watch Fleet Op](Watch_Fleet_Op.md) (1 shared connections)
- [Package Manifest](Package_Manifest.md) (1 shared connections)

## Source Files

- `src/cpu_budget.js`
- `src/galaxy_layout.js`
- `src/ipc/map_ipc.js`
- `test/cpu_budget.test.js`

## Audit Trail

- EXTRACTED: 61 (85%)
- INFERRED: 11 (15%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*