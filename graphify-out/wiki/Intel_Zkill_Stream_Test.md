# Intel Zkill Stream Test

> 24 nodes · cohesion 0.12

## Key Concepts

- **intel_zkill_stream.test.js** (24 connections) — `test/intel_zkill_stream.test.js`
- **createKillWatch()** (10 connections) — `src/intel/kill_watch.js`
- **kill_watch.js** (7 connections) — `src/intel/kill_watch.js`
- **bound()** (3 connections) — `src/intel/kill_watch.js`
- **ingestPackage()** (3 connections) — `src/intel/kill_watch.js`
- **normalisePackage()** (3 connections) — `src/intel/kill_watch.js`
- **refreshLosses()** (2 connections) — `src/intel/kill_watch.js`
- **advance()** (2 connections) — `test/intel_zkill_stream.test.js`
- **fakeServer()** (2 connections) — `test/intel_zkill_stream.test.js`
- **idOf()** (2 connections) — `test/intel_zkill_stream.test.js`
- **livePkg()** (2 connections) — `test/intel_zkill_stream.test.js`
- **pkg()** (2 connections) — `test/intel_zkill_stream.test.js`
- **tick()** (2 connections) — `test/intel_zkill_stream.test.js`
- **watch()** (2 connections) — `test/intel_zkill_stream.test.js`
- **refreshSystemKills()** (1 connections) — `src/intel/kill_watch.js`
- **assert** (1 connections) — `test/intel_zkill_stream.test.js`
- **SDE** (1 connections) — `test/intel_zkill_stream.test.js`
- **SHIPS** (1 connections) — `test/intel_zkill_stream.test.js`
- **test** (1 connections) — `test/intel_zkill_stream.test.js`
- **src_intel_zkill_stream_front_check_every** (1 connections)
- **src_intel_zkill_stream_idle_ms** (1 connections)
- **src_intel_zkill_stream_max_catchup** (1 connections)
- **src_intel_zkill_stream_stall_rounds** (1 connections)
- **src_intel_zkill_stream_step_ms** (1 connections)

## Relationships

- [Intel Service](Intel_Service.md) (4 shared connections)
- [Intel Test](Intel_Test.md) (2 shared connections)
- [Character IPC](Character_IPC.md) (2 shared connections)
- [Zkill Stream](Zkill_Stream.md) (2 shared connections)
- [Sso Scopes Test](Sso_Scopes_Test.md) (2 shared connections)

## Source Files

- `src/intel/kill_watch.js`
- `test/intel_zkill_stream.test.js`

## Audit Trail

- EXTRACTED: 41 (93%)
- INFERRED: 3 (7%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*