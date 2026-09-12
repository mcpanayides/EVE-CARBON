# Eve Status Watch Test

> 32 nodes · cohesion 0.08

## Key Concepts

- **eve_status_watch.js** (10 connections) — `src/eve_status_watch.js`
- **eve_status_watch.test.js** (10 connections) — `test/eve_status_watch.test.js`
- **eve_status.js** (7 connections) — `src/shared/eve_status.js`
- **eve_status.test.js** (6 connections) — `test/eve_status.test.js`
- **pollOnce()** (4 connections) — `src/eve_status_watch.js`
- **EveStatus** (3 connections) — `src/eve_status_watch.js`
- **startEveStatusWatch()** (3 connections) — `src/eve_status_watch.js`
- **stopEveStatusWatch()** (3 connections) — `src/eve_status_watch.js`
- **classify()** (3 connections) — `src/shared/eve_status.js`
- **Unsupported** (3 connections) — `test/eve_status_watch.test.js`
- **currentStatus()** (2 connections) — `src/eve_status_watch.js`
- **_fetchSummary()** (2 connections) — `src/eve_status_watch.js`
- **_resetForTests()** (2 connections) — `src/eve_status_watch.js`
- **isFlightCritical()** (2 connections) — `src/shared/eve_status.js`
- **severityOf()** (2 connections) — `src/shared/eve_status.js`
- **unknown()** (1 connections) — `src/shared/eve_status.js`
- **shouldAlert()** (1 connections) — `src/shared/eve_status.js`
- **test** (1 connections) — `test/eve_status.test.js`
- **assert** (1 connections) — `test/eve_status.test.js`
- **ES** (1 connections) — `test/eve_status.test.js`
- **summary()** (1 connections) — `test/eve_status.test.js`
- **OK** (1 connections) — `test/eve_status.test.js`
- **test** (1 connections) — `test/eve_status_watch.test.js`
- **assert** (1 connections) — `test/eve_status_watch.test.js`
- **W** (1 connections) — `test/eve_status_watch.test.js`
- *... and 7 more nodes in this community*

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (1 shared connections)

## Source Files

- `src/eve_status_watch.js`
- `src/shared/eve_status.js`
- `test/eve_status.test.js`
- `test/eve_status_watch.test.js`

## Audit Trail

- EXTRACTED: 69 (87%)
- INFERRED: 10 (13%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*