# Demo Snapshot Refresh

> 16 nodes · cohesion 0.18

## Key Concepts

- **demo-snapshot.js** (12 connections) — `scripts/demo-snapshot.js`
- **main()** (6 connections) — `scripts/demo-snapshot.js`
- **esi.js** (5 connections) — `src/shared/esi.js`
- **write()** (4 connections) — `scripts/demo-snapshot.js`
- **url()** (4 connections) — `src/shared/esi.js`
- **snapshotSkills()** (3 connections) — `scripts/demo-snapshot.js`
- **loadPilotPool()** (3 connections) — `scripts/demo-snapshot.js`
- **unit()** (2 connections) — `scripts/demo-snapshot.js`
- **get()** (2 connections) — `scripts/demo-snapshot.js`
- **syncStationDatabase()** (2 connections) — `src/locator.js`
- **fs** (1 connections) — `scripts/demo-snapshot.js`
- **path** (1 connections) — `scripts/demo-snapshot.js`
- **Esi** (1 connections) — `scripts/demo-snapshot.js`
- **OUT** (1 connections) — `scripts/demo-snapshot.js`
- **round()** (1 connections) — `scripts/demo-snapshot.js`
- **headers()** (1 connections) — `src/shared/esi.js`

## Relationships

- [Demo Fixtures Test](Demo_Fixtures_Test.md) (2 shared connections)
- [Station & Structure Locator](Station_%26_Structure_Locator.md) (1 shared connections)
- [Calendar & Events](Calendar_%26_Events.md) (1 shared connections)
- [Net Log](Net_Log.md) (1 shared connections)

## Source Files

- `scripts/demo-snapshot.js`
- `src/locator.js`
- `src/shared/esi.js`

## Audit Trail

- EXTRACTED: 45 (92%)
- INFERRED: 4 (8%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*