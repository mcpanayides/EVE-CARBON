# HTTP Request Broker

> 60 nodes · cohesion 0.05

## Key Concepts

- **request_broker.js** (32 connections) — `src/request_broker.js`
- **resfile_backgrounds.js** (18 connections) — `src/resfile_backgrounds.js`
- **request_broker.test.js** (11 connections) — `test/request_broker.test.js`
- **resfile.js** (10 connections) — `src/resfile.js`
- **get()** (8 connections) — `src/request_broker.js`
- **_token()** (6 connections) — `src/request_broker.js`
- **_ensureCached()** (6 connections) — `src/resfile_backgrounds.js`
- **_pump()** (5 connections) — `src/request_broker.js`
- **fetchText()** (5 connections) — `src/resfile.js`
- **resolveResourcePaths()** (5 connections) — `src/resfile.js`
- **_assetPath()** (4 connections) — `src/resfile_backgrounds.js`
- **fetchBuffer()** (4 connections) — `src/resfile.js`
- **getBuildNumber()** (4 connections) — `src/resfile.js`
- **_url()** (4 connections) — `src/resfile.js`
- **_acquire()** (3 connections) — `src/request_broker.js`
- **cacheKey()** (3 connections) — `src/request_broker.js`
- **_hostOf()** (3 connections) — `src/request_broker.js`
- **_lane()** (3 connections) — `src/request_broker.js`
- **_refill()** (3 connections) — `src/request_broker.js`
- **_release()** (3 connections) — `src/request_broker.js`
- **reserve()** (3 connections) — `src/request_broker.js`
- **_assetsDir()** (3 connections) — `src/resfile_backgrounds.js`
- **listResfileBackgrounds()** (3 connections) — `src/resfile_backgrounds.js`
- **_readResolvedCache()** (3 connections) — `src/resfile_backgrounds.js`
- **_resolvedCachePath()** (3 connections) — `src/resfile_backgrounds.js`
- *... and 35 more nodes in this community*

## Relationships

- [Account & Auth IPC](Account_&_Auth_IPC.md) (3 shared connections)
- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [Palette Accent Split Test](Palette_Accent_Split_Test.md) (2 shared connections)
- [PI Roles Test](PI_Roles_Test.md) (2 shared connections)
- [Intel Zkill Stream Test](Intel_Zkill_Stream_Test.md) (1 shared connections)
- [Presence Worker Test](Presence_Worker_Test.md) (1 shared connections)

## Source Files

- `src/request_broker.js`
- `src/resfile.js`
- `src/resfile_backgrounds.js`
- `test/request_broker.test.js`

## Audit Trail

- EXTRACTED: 92 (87%)
- INFERRED: 14 (13%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*