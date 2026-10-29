# Zkill Stream

> 11 nodes · cohesion 0.20

## Key Concepts

- **zkill_stream.js** (12 connections) — `src/intel/zkill_stream.js`
- **zkill_fanout.test.js** (5 connections) — `test/zkill_fanout.test.js`
- **createZkillStream()** (3 connections) — `src/intel/zkill_stream.js`
- **resolveZkillBase()** (2 connections) — `src/intel/zkill_stream.js`
- **https** (1 connections) — `src/intel/zkill_stream.js`
- **{ APP_USER_AGENT }** (1 connections) — `src/intel/zkill_stream.js`
- **broker** (1 connections) — `src/intel/zkill_stream.js`
- **directGet()** (1 connections) — `src/intel/zkill_stream.js`
- **test** (1 connections) — `test/zkill_fanout.test.js`
- **assert** (1 connections) — `test/zkill_fanout.test.js`
- **{ resolveZkillBase, DEFAULT_BASE }** (1 connections) — `test/zkill_fanout.test.js`

## Relationships

- [ESI Client Test](ESI_Client_Test.md) (2 shared connections)
- [Intel Service](Intel_Service.md) (2 shared connections)
- [Intel Zkill Stream Test](Intel_Zkill_Stream_Test.md) (2 shared connections)
- [HTTP Request Broker](HTTP_Request_Broker.md) (1 shared connections)

## Source Files

- `src/intel/zkill_stream.js`
- `test/zkill_fanout.test.js`

## Audit Trail

- EXTRACTED: 25 (86%)
- INFERRED: 4 (14%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*