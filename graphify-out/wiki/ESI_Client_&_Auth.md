# ESI Client & Auth

> 27 nodes · cohesion 0.16

## Key Concepts

- **getLocator()** (14 connections) — `main.js`
- **fullCharacterSync()** (12 connections) — `main.js`
- **coreCharacterSync()** (11 connections) — `main.js`
- **getValidToken()** (10 connections) — `main.js`
- **httpGet()** (8 connections) — `main.js`
- **statusCharacterSync()** (7 connections) — `main.js`
- **_esiAuthHeaders()** (6 connections) — `main.js`
- **fetchAllianceContacts()** (6 connections) — `main.js`
- **_getValidTokenUncoalesced()** (6 connections) — `main.js`
- **httpGetFull()** (6 connections) — `main.js`
- **httpPost()** (6 connections) — `main.js`
- **resolveImplantSlots()** (6 connections) — `main.js`
- **resolveNames()** (6 connections) — `main.js`
- **_esiGateWait()** (5 connections) — `main.js`
- **_esiNoteResponse()** (5 connections) — `main.js`
- **loadDB()** (5 connections) — `main.js`
- **readCache()** (4 connections) — `main.js`
- **saveDB()** (4 connections) — `main.js`
- **writeCache()** (4 connections) — `main.js`
- **getCachePath()** (3 connections) — `main.js`
- **httpGetFullWithRetry()** (3 connections) — `main.js`
- **_mailAuth()** (3 connections) — `main.js`
- **resolveNamesFromSde()** (3 connections) — `main.js`
- **createLocator** (2 connections) — `main.js`
- **_demoAccessToken()** (2 connections) — `main.js`
- *... and 2 more nodes in this community*

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (30 shared connections)
- [Main](Main.md) (4 shared connections)
- [PI IPC](PI_IPC.md) (2 shared connections)
- [Dahboards](Dahboards.md) (1 shared connections)

## Source Files

- `main.js`

## Audit Trail

- EXTRACTED: 137 (91%)
- INFERRED: 14 (9%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*