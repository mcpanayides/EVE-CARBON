# HTTP Request Broker

> 38 nodes · cohesion 0.08

## Key Concepts

- **request_broker.js** (32 connections) — `src/request_broker.js`
- **request_broker.test.js** (11 connections) — `test/request_broker.test.js`
- **get()** (8 connections) — `src/request_broker.js`
- **_token()** (6 connections) — `src/request_broker.js`
- **_pump()** (5 connections) — `src/request_broker.js`
- **_acquire()** (3 connections) — `src/request_broker.js`
- **cacheKey()** (3 connections) — `src/request_broker.js`
- **_hostOf()** (3 connections) — `src/request_broker.js`
- **_lane()** (3 connections) — `src/request_broker.js`
- **_refill()** (3 connections) — `src/request_broker.js`
- **_release()** (3 connections) — `src/request_broker.js`
- **reserve()** (3 connections) — `src/request_broker.js`
- **_bucket()** (2 connections) — `src/request_broker.js`
- **_hash()** (2 connections) — `src/request_broker.js`
- **_prune()** (2 connections) — `src/request_broker.js`
- **setRate()** (2 connections) — `src/request_broker.js`
- **ttlFromHeaders()** (2 connections) — `src/request_broker.js`
- **_waitFor()** (2 connections) — `src/request_broker.js`
- **invalidate()** (1 connections) — `src/request_broker.js`
- **resetRates()** (1 connections) — `src/request_broker.js`
- **snapshot()** (1 connections) — `src/request_broker.js`
- **burstUrl()** (1 connections) — `test/request_broker.test.js`
- **sleep()** (1 connections) — `test/request_broker.test.js`
- **uncached()** (1 connections) — `test/request_broker.test.js`
- **url()** (1 connections) — `test/request_broker.test.js`
- *... and 13 more nodes in this community*

## Relationships

- [Sso Scopes Test](Sso_Scopes_Test.md) (2 shared connections)
- [Electron Main Process](Electron_Main_Process.md) (1 shared connections)
- [Zkill Stream](Zkill_Stream.md) (1 shared connections)
- [Auto Updater](Auto_Updater.md) (1 shared connections)

## Source Files

- `src/request_broker.js`
- `test/request_broker.test.js`

## Audit Trail

- EXTRACTED: 51 (85%)
- INFERRED: 9 (15%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*