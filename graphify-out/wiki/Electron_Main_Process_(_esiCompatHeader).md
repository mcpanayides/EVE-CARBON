# Electron Main Process (_esiCompatHeader)

> 8 nodes · cohesion 0.29

## Key Concepts

- **_httpJsonRaw()** (7 connections) — `main.js`
- **_esiNoteResponse()** (5 connections) — `main.js`
- **_esiCompatHeader()** (3 connections) — `main.js`
- **_esiNoteResponseCore()** (3 connections) — `main.js`
- **_etagCachePathFor()** (3 connections) — `main.js`
- **_readEtagEntry()** (3 connections) — `main.js`
- **_writeEtagEntry()** (3 connections) — `main.js`
- **_esiNoteFetchResponse()** (2 connections) — `main.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (8 shared connections)
- [Main Process ESI & Cache Layer](Main_Process_ESI_%26_Cache_Layer.md) (5 shared connections)

## Source Files

- `main.js`

## Audit Trail

- EXTRACTED: 28 (97%)
- INFERRED: 1 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*