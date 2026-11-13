# Main Process ESI & Cache Layer

> 34 nodes · cohesion 0.13

## Key Concepts

- **fullCharacterSync()** (13 connections) — `main.js`
- **getLocator()** (13 connections) — `main.js`
- **httpGet()** (13 connections) — `main.js`
- **coreCharacterSync()** (12 connections) — `main.js`
- **getValidToken()** (10 connections) — `main.js`
- **httpPost()** (8 connections) — `main.js`
- **httpGetFull()** (7 connections) — `main.js`
- **_httpJsonRaw()** (7 connections) — `main.js`
- **statusCharacterSync()** (7 connections) — `main.js`
- **_esiAuthHeaders()** (6 connections) — `main.js`
- **fetchAllianceContacts()** (6 connections) — `main.js`
- **_getValidTokenUncoalesced()** (6 connections) — `main.js`
- **resolveNames()** (6 connections) — `main.js`
- **syncSkillsStep()** (6 connections) — `main.js`
- **_esiGateWait()** (5 connections) — `main.js`
- **_esiNoteResponse()** (5 connections) — `main.js`
- **loadDB()** (5 connections) — `main.js`
- **resolveImplantSlots()** (5 connections) — `main.js`
- **readCache()** (4 connections) — `main.js`
- **saveDB()** (4 connections) — `main.js`
- **writeCache()** (4 connections) — `main.js`
- **decodeTokenScopes()** (3 connections) — `main.js`
- **_esiCompatHeader()** (3 connections) — `main.js`
- **_etagCachePathFor()** (3 connections) — `main.js`
- **fetchAndStoreSkills()** (3 connections) — `main.js`
- *... and 9 more nodes in this community*

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (36 shared connections)
- [Demo Mode Fixtures](Demo_Mode_Fixtures.md) (3 shared connections)
- [PI IPC](PI_IPC.md) (2 shared connections)
- [Intel IPC (registerIntelHandlers)](Intel_IPC_registerIntelHandlers.md) (2 shared connections)
- [Auto Updater](Auto_Updater.md) (1 shared connections)
- [Intel Service](Intel_Service.md) (1 shared connections)

## Source Files

- `main.js`

## Audit Trail

- EXTRACTED: 96 (82%)
- INFERRED: 21 (18%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*