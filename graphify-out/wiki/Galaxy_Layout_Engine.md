# Galaxy Layout Engine

> 15 nodes · cohesion 0.19

## Key Concepts

- **galaxy_layout.js** (7 connections) — `src/galaxy_layout.js`
- **cpu_budget.test.js** (7 connections) — `test/cpu_budget.test.js`
- **cpu_budget.js** (6 connections) — `src/cpu_budget.js`
- **workerCount()** (4 connections) — `src/cpu_budget.js`
- **balance()** (4 connections) — `src/cpu_budget.js`
- **buildRegionLayouts()** (4 connections) — `src/galaxy_layout.js`
- **logicalCores()** (3 connections) — `src/cpu_budget.js`
- **os** (1 connections) — `src/cpu_budget.js`
- **path** (1 connections) — `src/galaxy_layout.js`
- **{ Worker }** (1 connections) — `src/galaxy_layout.js`
- **cpuBudget** (1 connections) — `src/galaxy_layout.js`
- **WORKER_FILE** (1 connections) — `src/galaxy_layout.js`
- **test** (1 connections) — `test/cpu_budget.test.js`
- **assert** (1 connections) — `test/cpu_budget.test.js`
- **{ workerCount, balance, logicalCores, MAX_WORKERS }** (1 connections) — `test/cpu_budget.test.js`

## Relationships

- [Map IPC](Map_IPC.md) (2 shared connections)
- [Watch Fleet Op](Watch_Fleet_Op.md) (1 shared connections)

## Source Files

- `src/cpu_budget.js`
- `src/galaxy_layout.js`
- `test/cpu_budget.test.js`

## Audit Trail

- EXTRACTED: 34 (79%)
- INFERRED: 9 (21%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*