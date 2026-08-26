# Bucket

> 13 nodes · cohesion 0.38

## Key Concepts

- **zkill-fanout/worker.js** (10 connections) — `workers/zkill-fanout/worker.js`
- **bucket.js** (7 connections) — `workers/zkill-fanout/bucket.js`
- **fetch()** (7 connections) — `workers/zkill-fanout/worker.js`
- **bucketOf()** (5 connections) — `workers/zkill-fanout/bucket.js`
- **bucketRange()** (5 connections) — `workers/zkill-fanout/bucket.js`
- **isComplete()** (5 connections) — `workers/zkill-fanout/bucket.js`
- **toSeq()** (4 connections) — `workers/zkill-fanout/bucket.js`
- **fromUpstream()** (4 connections) — `workers/zkill-fanout/worker.js`
- **fetchSequence()** (4 connections) — `workers/zkill-fanout/worker.js`
- **json()** (3 connections) — `workers/zkill-fanout/worker.js`
- **BUCKET_SIZE** (2 connections) — `workers/zkill-fanout/bucket.js`
- **bucketsToFetch()** (2 connections) — `workers/zkill-fanout/bucket.js`
- **upstreamHeaders()** (2 connections) — `workers/zkill-fanout/worker.js`

## Relationships

- No strong cross-community connections detected

## Source Files

- `workers/zkill-fanout/bucket.js`
- `workers/zkill-fanout/worker.js`

## Audit Trail

- EXTRACTED: 60 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*