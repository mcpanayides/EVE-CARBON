# README

> 28 nodes · cohesion 0.13

## Key Concepts

- **zkill-fanout/worker.js** (10 connections) — `workers/zkill-fanout/worker.js`
- **zkill_bucket.test.js** (9 connections) — `test/zkill_bucket.test.js`
- **bucket.js** (8 connections) — `workers/zkill-fanout/bucket.js`
- **fetch()** (7 connections) — `workers/zkill-fanout/worker.js`
- **zkill-fanout** (7 connections) — `workers/zkill-fanout/README.md`
- **bucketOf()** (6 connections) — `workers/zkill-fanout/bucket.js`
- **bucketRange()** (6 connections) — `workers/zkill-fanout/bucket.js`
- **isComplete()** (6 connections) — `workers/zkill-fanout/bucket.js`
- **bucketsToFetch()** (4 connections) — `workers/zkill-fanout/bucket.js`
- **toSeq()** (4 connections) — `workers/zkill-fanout/bucket.js`
- **fromUpstream()** (4 connections) — `workers/zkill-fanout/worker.js`
- **resolveZkillBase()** (3 connections) — `src/intel/zkill_stream.js`
- **fetchSequence()** (3 connections) — `workers/zkill-fanout/worker.js`
- **Two protocols** (3 connections) — `workers/zkill-fanout/README.md`
- **json()** (2 connections) — `workers/zkill-fanout/worker.js`
- **upstreamHeaders()** (2 connections) — `workers/zkill-fanout/worker.js`
- **BUCKET_SIZE** (2 connections) — `workers/zkill-fanout/bucket.js`
- **Client migration to the batched feed** (2 connections) — `workers/zkill-fanout/README.md`
- **Deploy** (2 connections) — `workers/zkill-fanout/README.md`
- **What it will actually cost** (2 connections) — `workers/zkill-fanout/README.md`
- **assert** (1 connections) — `test/zkill_bucket.test.js`
- **test** (1 connections) — `test/zkill_bucket.test.js`
- **zkill-fanout/README.md** (1 connections) — `workers/zkill-fanout/README.md`
- **Checking it works** (1 connections) — `workers/zkill-fanout/README.md`
- **The custom-domain trick** (1 connections) — `workers/zkill-fanout/README.md`
- *... and 3 more nodes in this community*

## Relationships

- [Sso Scopes Test](Sso_Scopes_Test.md) (3 shared connections)
- [Zkill Stream](Zkill_Stream.md) (1 shared connections)

## Source Files

- `src/intel/zkill_stream.js`
- `test/zkill_bucket.test.js`
- `workers/zkill-fanout/README.md`
- `workers/zkill-fanout/bucket.js`
- `workers/zkill-fanout/worker.js`

## Audit Trail

- EXTRACTED: 49 (94%)
- INFERRED: 3 (6%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*