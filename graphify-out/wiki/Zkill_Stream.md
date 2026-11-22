# Zkill Stream

> 9 nodes · cohesion 0.36

## Key Concepts

- **createZkillStream()** (10 connections) — `src/intel/zkill_stream.js`
- **cycle()** (5 connections) — `src/intel/zkill_stream.js`
- **fail()** (3 connections) — `src/intel/zkill_stream.js`
- **step()** (3 connections) — `src/intel/zkill_stream.js`
- **SdeProgress** (3 connections) — `src/func/sde_progress.js`
- **newestSequence()** (2 connections) — `src/intel/zkill_stream.js`
- **ok()** (2 connections) — `src/intel/zkill_stream.js`
- **schedule()** (2 connections) — `src/intel/zkill_stream.js`
- **sde_progress.js** (1 connections) — `src/func/sde_progress.js`

## Relationships

- [Intel Service](Intel_Service.md) (2 shared connections)
- [Intel Zkill Stream Test](Intel_Zkill_Stream_Test.md) (1 shared connections)
- [Character IPC](Character_IPC.md) (1 shared connections)
- [Chart Umd (de)](Chart_Umd_de.md) (1 shared connections)

## Source Files

- `src/func/sde_progress.js`
- `src/intel/zkill_stream.js`

## Audit Trail

- EXTRACTED: 14 (78%)
- INFERRED: 4 (22%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*