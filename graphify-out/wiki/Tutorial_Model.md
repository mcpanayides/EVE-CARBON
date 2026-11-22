# Tutorial Model

> 23 nodes · cohesion 0.12

## Key Concepts

- **tutorial_model.js** (10 connections) — `src/shared/tutorial_model.js`
- **eve_status_watch.js** (9 connections) — `src/eve_status_watch.js`
- **eve_status.js** (7 connections) — `src/shared/eve_status.js`
- **pollOnce()** (3 connections) — `src/eve_status_watch.js`
- **startEveStatusWatch()** (3 connections) — `src/eve_status_watch.js`
- **stopEveStatusWatch()** (3 connections) — `src/eve_status_watch.js`
- **classify()** (3 connections) — `src/shared/eve_status.js`
- **applies()** (3 connections) — `src/shared/tutorial_model.js`
- **_fetchSummary()** (2 connections) — `src/eve_status_watch.js`
- **_resetForTests()** (2 connections) — `src/eve_status_watch.js`
- **isFlightCritical()** (2 connections) — `src/shared/eve_status.js`
- **severityOf()** (2 connections) — `src/shared/eve_status.js`
- **clamp()** (2 connections) — `src/shared/tutorial_model.js`
- **nextIndex()** (2 connections) — `src/shared/tutorial_model.js`
- **placeCard()** (2 connections) — `src/shared/tutorial_model.js`
- **progress()** (2 connections) — `src/shared/tutorial_model.js`
- **currentStatus()** (1 connections) — `src/eve_status_watch.js`
- **shouldAlert()** (1 connections) — `src/shared/eve_status.js`
- **unknown()** (1 connections) — `src/shared/eve_status.js`
- **blockers()** (1 connections) — `src/shared/tutorial_model.js`
- **holeRect()** (1 connections) — `src/shared/tutorial_model.js`
- **sameRect()** (1 connections) — `src/shared/tutorial_model.js`
- **shouldAutoStart()** (1 connections) — `src/shared/tutorial_model.js`

## Relationships

- [Fleet Kills Test](Fleet_Kills_Test.md) (2 shared connections)
- [Electron Main Process](Electron_Main_Process.md) (1 shared connections)
- [Eve Status Watch Test](Eve_Status_Watch_Test.md) (1 shared connections)

## Source Files

- `src/eve_status_watch.js`
- `src/shared/eve_status.js`
- `src/shared/tutorial_model.js`

## Audit Trail

- EXTRACTED: 16 (47%)
- INFERRED: 18 (53%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*