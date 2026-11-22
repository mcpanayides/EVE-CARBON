# HTTP Request Broker

> 64 nodes · cohesion 0.05

## Key Concepts

- **request_broker.js** (32 connections) — `src/request_broker.js`
- **zkill_stream.js** (11 connections) — `src/intel/zkill_stream.js`
- **zkill-fanout/worker.js** (10 connections) — `workers/zkill-fanout/worker.js`
- **zkill_bucket.test.js** (9 connections) — `test/zkill_bucket.test.js`
- **get()** (8 connections) — `src/request_broker.js`
- **bucket.js** (8 connections) — `workers/zkill-fanout/bucket.js`
- **fetch()** (7 connections) — `workers/zkill-fanout/worker.js`
- **zkill_fanout.test.js** (7 connections) — `test/zkill_fanout.test.js`
- **zkill-fanout** (7 connections) — `workers/zkill-fanout/README.md`
- **_token()** (6 connections) — `src/request_broker.js`
- **bucketOf()** (6 connections) — `workers/zkill-fanout/bucket.js`
- **bucketRange()** (6 connections) — `workers/zkill-fanout/bucket.js`
- **isComplete()** (6 connections) — `workers/zkill-fanout/bucket.js`
- **_pump()** (5 connections) — `src/request_broker.js`
- **bucketsToFetch()** (4 connections) — `workers/zkill-fanout/bucket.js`
- **toSeq()** (4 connections) — `workers/zkill-fanout/bucket.js`
- **fromUpstream()** (4 connections) — `workers/zkill-fanout/worker.js`
- **resolveZkillBase()** (3 connections) — `src/intel/zkill_stream.js`
- **_acquire()** (3 connections) — `src/request_broker.js`
- **cacheKey()** (3 connections) — `src/request_broker.js`
- **_hostOf()** (3 connections) — `src/request_broker.js`
- **_lane()** (3 connections) — `src/request_broker.js`
- **_refill()** (3 connections) — `src/request_broker.js`
- **_release()** (3 connections) — `src/request_broker.js`
- **reserve()** (3 connections) — `src/request_broker.js`
- *... and 39 more nodes in this community*

## Relationships

- [Presence Worker Test](Presence_Worker_Test.md) (4 shared connections)
- [Character IPC](Character_IPC.md) (2 shared connections)
- [Intel Zkill Stream Test](Intel_Zkill_Stream_Test.md) (2 shared connections)
- [Intel Service](Intel_Service.md) (1 shared connections)
- [Auto Updater](Auto_Updater.md) (1 shared connections)
- [Electron Main Process](Electron_Main_Process.md) (1 shared connections)
- [Account & Auth IPC](Account_&_Auth_IPC.md) (1 shared connections)
- [Request Broker Test](Request_Broker_Test.md) (1 shared connections)

## Source Files

- `src/intel/zkill_stream.js`
- `src/request_broker.js`
- `test/zkill_bucket.test.js`
- `test/zkill_fanout.test.js`
- `workers/zkill-fanout/README.md`
- `workers/zkill-fanout/bucket.js`
- `workers/zkill-fanout/worker.js`

## Audit Trail

- EXTRACTED: 104 (90%)
- INFERRED: 12 (10%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*