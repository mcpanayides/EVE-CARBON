# Main Process ESI & Cache Layer

> 32 nodes · cohesion 0.13

## Key Concepts

- **getLocator()** (14 connections) — `main.js`
- **fullCharacterSync()** (12 connections) — `main.js`
- **coreCharacterSync()** (11 connections) — `main.js`
- **getValidToken()** (10 connections) — `main.js`
- **httpGet()** (9 connections) — `main.js`
- **_httpJsonRaw()** (7 connections) — `main.js`
- **httpGetFull()** (7 connections) — `main.js`
- **statusCharacterSync()** (7 connections) — `main.js`
- **fetchAllianceContacts()** (6 connections) — `main.js`
- **_esiAuthHeaders()** (6 connections) — `main.js`
- **httpPost()** (6 connections) — `main.js`
- **_getValidTokenUncoalesced()** (6 connections) — `main.js`
- **resolveNames()** (6 connections) — `main.js`
- **loadDB()** (5 connections) — `main.js`
- **_esiGateWait()** (5 connections) — `main.js`
- **_esiNoteResponse()** (5 connections) — `main.js`
- **resolveImplantSlots()** (5 connections) — `main.js`
- **readCache()** (4 connections) — `main.js`
- **writeCache()** (4 connections) — `main.js`
- **saveDB()** (4 connections) — `main.js`
- **getCachePath()** (3 connections) — `main.js`
- **_mailAuth()** (3 connections) — `main.js`
- **_esiCompatHeader()** (3 connections) — `main.js`
- **_etagCachePathFor()** (3 connections) — `main.js`
- **_readEtagEntry()** (3 connections) — `main.js`
- *... and 7 more nodes in this community*

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (35 shared connections)
- [HTTP Request Broker](HTTP_Request_Broker.md) (2 shared connections)
- [PI IPC](PI_IPC.md) (2 shared connections)

## Source Files

- `main.js`

## Audit Trail

- EXTRACTED: 157 (92%)
- INFERRED: 14 (8%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*