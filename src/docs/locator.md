# `locator.js` — Function & Connection Reference

> **Module purpose:** Centralised EVE location resolver. Resolves any EVE location ID (solar system, NPC station, or player-owned structure) to a full named + geo-enriched object. Exported as a factory function — callers inject dependencies on creation.

---

## Module Architecture

This file uses the **factory pattern**:

```js
const locator = require('./locator')({ httpGet, readCache, writeCache, getValidToken,
                                       getStationById, upsertNpcStations, upsertUpwellStructures });
```

**Module-level (outside factory):** `urlToOpts`, `fetchHtml`, `fetchJson`, `fetchJsonInsecure`, and the ESI 420 cooldown tracker `_esiErrorLimitUntil` are shared across all instances.

**Inside the factory:** All other functions close over the injected dependencies and a shared in-memory `_nameCache`.

---

## Constants

| Constant | Value | Purpose |
|---|---|---|
| `ESI_BASE` | `https://esi.evetech.net` | Base URL for all ESI calls |
| `ADAM4EVE_BASE` | `https://www.adam4eve.eu` | Fallback structure name source |
| `ZKILLBOARD_BASE` | `https://zkillboard.com` | Fallback structure name source |
| `HAMMERTIME_BASE` | `https://stop.hammerti.me.uk` | Community structure DB |
| `PLAYER_STRUCTURE_MIN_ID` | `1_000_000_000_000` | Threshold for player-owned structure IDs |
| `HOBOLEAKS_STATIONS_URL` | `https://sde.hoboleaks.space/tq/stastations.json` | Primary NPC station list source |
| `FUZZWORK_STATIONS_URL` | `https://www.fuzzwork.co.uk/dump/latest/staStations.json` | Fallback NPC station list source |

## Module-Level State

| Variable | Scope | Purpose |
|---|---|---|
| `_esiErrorLimitUntil` | Module-level (shared) | Timestamp until which ESI calls should be paused after an HTTP 420 |
| `_nameCache` | Factory instance | In-memory `{ id: name }` map; avoids redundant ESI `/universe/names/` calls within a session |

## Injected Dependencies (factory parameters)

| Parameter | Type | Purpose |
|---|---|---|
| `httpGet(url, headers?)` | function | Authenticated HTTP GET (returns parsed JSON) |
| `readCache(key)` | function | Read a value from the persistent cache |
| `writeCache(key, value, ttlDays)` | function | Write a value to the persistent cache |
| `getValidToken(characterId)` | function | Retrieve a valid ESI OAuth bearer token |
| `getStationById(id)` | function | Query local SQLite DB for a station/structure by ID |
| `upsertNpcStations(rows[])` | function | Bulk-upsert NPC station rows into local DB |
| `upsertUpwellStructures(rows[])` | function | Bulk-upsert Upwell structure rows into local DB |

---

## Public API (returned by factory)

| Function | Description |
|---|---|
| `resolveStructureName(structureId, characterId?)` | Resolve a player structure ID to `{ name, solar_system_id, owner_id }` |
| `resolveLocation(locationId, characterId?)` | Full resolution to name + system / constellation / region / sec / owner |
| `resolveLocations(locationIds[], characterId?)` | Batch wrapper for `resolveLocation`, up to 8 concurrent |
| `resolveJobLocation(job, characterId?)` | Industry-job convenience resolver returning `{ systemName, facilityName, securityStatus, regionName }` |
| `resolveSystemNames(systemIds[])` | Thin wrapper — bulk-resolve solar system IDs to `{ id: name }` |
| `esiNamesPost(ids[])` | General bulk ID → name resolver via ESI `/v3/universe/names/` |
| `syncStationDatabase(opts?)` | Populate local NPC station and Upwell structure tables |

---

## Functions

### `urlToOpts(rawUrl, extraHeaders?)` *(module-level)*
**Purpose:** Parses a URL string into an `https.request()` options object. Required for compatibility with older Node versions bundled with Electron that don't accept plain string URLs.

**No outbound calls** — pure URL parsing.

---

### `fetchHtml(url, timeoutMs?, _redirects?)` *(module-level)*
**Purpose:** Low-level HTML fetcher using Node `https`. Returns raw HTML string. Follows up to 3 redirects (301/302), resolving relative redirect paths against the original host. Used for scraping zkillboard and adam4eve pages.

**Calls:**
| Called function | Why |
|---|---|
| `urlToOpts(url, headers)` | Build request options from URL string |
| `fetchHtml(...)` *(recursive)* | Follow 301/302 redirects |

---

### `fetchJson(url, timeoutMs?, _redirects?)` *(module-level)*
**Purpose:** Low-level JSON fetcher using Node `https`. Follows redirects, handles the ESI HTTP 420 error-limit (records cooldown in `_esiErrorLimitUntil`), rejects all non-2xx responses, and also rejects ESI 200 responses that contain a single `error` key — preventing error bodies from being treated as valid data.

**Calls:**
| Called function | Why |
|---|---|
| `urlToOpts(url, headers)` | Build request options from URL string |
| `fetchJson(...)` *(recursive)* | Follow 301/302 redirects |

---

### `fetchJsonInsecure(url, timeoutMs?)` *(module-level)*
**Purpose:** Variant of `fetchJson` with TLS certificate verification disabled (`rejectUnauthorized: false`). Used exclusively for Hammertime (`stop.hammerti.me.uk`) which has a known cert issue. No redirect following.

**Calls:**
| Called function | Why |
|---|---|
| `urlToOpts(url, headers)` | Build request options from URL string |

---

### `_waitForEsiCooldown()` *(factory-private, async)*
**Purpose:** Checks the module-level `_esiErrorLimitUntil` timestamp. If a 420 cooldown is active, waits the remaining duration before returning. Prevents further ESI structure lookups from hammering the error limit.

**No outbound calls** — pure timer/sleep.

---

### `_persistToStationDb(id, result)` *(factory-private, async)*
**Purpose:** After any external source successfully resolves a structure or station name, writes it back to the local SQLite DB so future lookups can skip the network entirely. Validates the result before persisting — rejects generic fallback strings, error messages, and overly long names. Routes to `upsertNpcStations` for IDs in the NPC station range, or `upsertUpwellStructures` for player structures.

**Calls:**
| Called function | Why |
|---|---|
| `upsertNpcStations([row])` | Persist NPC station (ID 60m–64m) to local DB |
| `upsertUpwellStructures([row])` | Persist Upwell structure (ID ≥ 1T) to local DB |

---

### `esiNamesPost(ids[])` *(async)*
**Purpose:** General-purpose bulk ID-to-name resolver. Deduplicates IDs, skips any already in `_nameCache`, batches the remainder into chunks of 1000, and POSTs each chunk to ESI `/v3/universe/names/`. Resolves characters, corps, alliances, systems, and stations. Returns `{ id: name }` map for all requested IDs.

**Calls:**
| API | Why |
|---|---|
| `https.request(...)` *(inline POST)* | ESI POST `/v3/universe/names/` |

---

### `resolveSystemNames(systemIds[])` *(async)*
**Purpose:** Thin convenience wrapper around `esiNamesPost` — semantically scoped to solar system IDs. Returns `{ id: name }`.

**Calls:**
| Called function | Why |
|---|---|
| `esiNamesPost(ids)` | Delegate to the general bulk name resolver |

---

### `_esiStructureGeo(id, characterId?)` *(factory-private, async)*
**Purpose:** Fetches `{ solar_system_id, owner_id }` for a player-owned structure from ESI `/v2/universe/structures/{id}/`. Tries authenticated first (if `characterId` provided), falls back to public ESI (works for structures with open services). Returns `{}` on complete failure.

**Calls:**
| Called function/API | Why |
|---|---|
| `_waitForEsiCooldown()` | Respect ESI 420 cooldown before hitting ESI |
| `getValidToken(characterId)` | Get OAuth token for authenticated request |
| `httpGet(url, headers)` | Authenticated ESI structure lookup |
| `fetchJson(url)` | Unauthenticated public ESI fallback |

---

### `resolveStructureName(structureId, characterId?)` *(async)*
**Purpose:** Resolves a player-owned structure ID (≥ 1T) to `{ name, solar_system_id, owner_id }` using a 6-step fallback chain. Checks cache and local DB before touching the network. Each successful external resolution is written back to cache and persisted to local DB via `_persistToStationDb`.

**Resolution chain:**

| Step | Source | Notes |
|---|---|---|
| 0 | Local DB (`getStationById`) | Fastest — no network |
| 1 | Authenticated ESI `/v2/universe/structures/{id}/` | Requires character with docking rights |
| 2 | Public ESI (unauthenticated) | Works for structures with open market/services |
| 3 | Hammertime API | Community DB; TLS disabled via `fetchJsonInsecure` |
| 4 | Zkillboard HTML scrape | Parses `<title>` and `<h1>` tags |
| 5 | adam4eve structure_history page | Parses `<title>` and `<h2>` tags |
| 6 | Graceful fallback | Returns `"Structure {id}"` with whatever geo data was found |

**Calls:**
| Called function/API | Why |
|---|---|
| `readCache(cacheKey)` | Check session cache before any network call |
| `getStationById(id)` | Step 0 — local DB lookup |
| `writeCache(cacheKey, result, ttl)` | Cache successful result |
| `_waitForEsiCooldown()` | ESI 420 guard before authenticated attempt |
| `getValidToken(characterId)` | Step 1 — get auth token |
| `httpGet(url, headers)` | Step 1 — authenticated ESI fetch |
| `fetchJson(url)` | Step 2 — public ESI fetch |
| `fetchJsonInsecure(url)` | Step 3 — Hammertime (TLS disabled) |
| `fetchHtml(url)` | Steps 4 & 5 — zkillboard and adam4eve HTML scrape |
| `_esiStructureGeo(id, characterId)` | Steps 4, 5, 6 — geo enrichment after name-only sources |
| `_persistToStationDb(id, result)` | Steps 3, 4, 5 — write resolved name to local DB |

---

### `resolveLocation(locationId, characterId?)` *(async)*
**Purpose:** Full resolution of any EVE location ID, returning the complete hierarchy: `{ name, solar_system_id, solar_system_name, constellation_id, constellation_name, region_id, region_name, security_status, owner_id, owner_name }`. Branches on ID range to select the appropriate resolution strategy, then walks the system → constellation → region hierarchy via ESI, and bulk-resolves remaining IDs (region, owner) via `esiNamesPost`.

**ID range routing:**

| ID Range | Strategy |
|---|---|
| `>= 1_000_000_000_000` | Player structure → `resolveStructureName()` |
| `60,000,000 – 63,999,999` | NPC station → local DB first, then ESI `/v2/universe/stations/{id}/` |
| `< 100,000,000` | Solar system → ESI `/v4/universe/systems/{id}/` |

**Calls:**
| Called function/API | Why |
|---|---|
| `readCache(cacheKey)` | Check persistent cache first |
| `resolveStructureName(id, characterId)` | Player structure resolution |
| `getStationById(id)` | NPC station local DB lookup |
| `httpGet(url)` | ESI station, system, and constellation fetches |
| `_persistToStationDb(id, result)` | Cache newly resolved NPC station to local DB |
| `esiNamesPost(ids[])` | Bulk-resolve region name and owner name |
| `writeCache(cacheKey, result, ttl)` | Persist result; short TTL on fallback names |

---

### `resolveLocations(locationIds[], characterId?)` *(async)*
**Purpose:** Batch wrapper for `resolveLocation`. Deduplicates IDs and processes them up to 8 at a time using a concurrency worker pool. Returns `{ id: fullLocationResult }` map.

**Calls:**
| Called function | Why |
|---|---|
| `resolveLocation(id, characterId)` | Per-ID resolution (up to 8 concurrent) |

---

### `resolveJobLocation(job, characterId?)` *(async)*
**Purpose:** Convenience resolver for ESI industry job objects. Extracts `solar_system_id` and `facility_id` from the job, resolves the system name via `esiNamesPost`, reads sec status and region from cache (or fires a background `resolveLocation` to warm the cache), and resolves the facility name via `resolveLocation`. Returns `{ systemName, facilityName, securityStatus, regionName }`.

**Calls:**
| Called function | Why |
|---|---|
| `esiNamesPost([solarSystemId])` | Resolve system name from integer ID |
| `readCache(cacheKey)` | Check if sec status / region already cached |
| `resolveLocation(solarSystemId, characterId)` | Fire-and-forget to warm cache if not present |
| `resolveLocation(facilityId, characterId)` | Resolve facility (station or structure) name |

---

### `syncStationDatabase(opts?)` *(async)*
**Purpose:** One-time (or periodic) job to populate the local `npc_stations` and `upwell_structures` SQLite tables. Runs two passes:

**Part 1 — NPC stations:** Fetches `stastations.json` from Hoboleaks (fallback: Fuzzwork), batch-resolves system and region names via ESI `/v3/universe/names/`, and upserts all valid NPC station rows in chunks of 500.

**Part 2 — Upwell structures:** No bulk ESI endpoint exists; this pass notes that structures are populated organically as characters are synced (via `_persistToStationDb`). A bulk re-resolve pass is skipped unless a `getAll` DB helper is injected.

Returns `{ npc: count, upwell: count }`.

**Calls:**
| Called function/API | Why |
|---|---|
| `fetchJson(HOBOLEAKS_STATIONS_URL)` | Primary NPC station list |
| `fetchJson(FUZZWORK_STATIONS_URL)` | Fallback if Hoboleaks fails |
| `doPost(url, body)` *(injected or inline)* | ESI POST `/v3/universe/names/` for geo name resolution |
| `upsertNpcStations(rows[])` | Write NPC station rows to local DB in chunks of 500 |

---

## External Dependencies

| Dependency | Source | Used by |
|---|---|---|
| `httpGet(url, headers?)` | Injected from `main.js` | `_esiStructureGeo`, `resolveLocation`, `resolveStructureName` |
| `readCache(key)` | Injected from `main.js` | `resolveStructureName`, `resolveLocation`, `resolveJobLocation` |
| `writeCache(key, value, ttl)` | Injected from `main.js` | `resolveStructureName`, `resolveLocation` |
| `getValidToken(characterId)` | Injected from `main.js` | `_esiStructureGeo`, `resolveStructureName` |
| `getStationById(id)` | Injected from `main.js` | `resolveStructureName`, `resolveLocation` |
| `upsertNpcStations(rows[])` | Injected from `main.js` | `_persistToStationDb`, `syncStationDatabase` |
| `upsertUpwellStructures(rows[])` | Injected from `main.js` | `_persistToStationDb` |
| `https` (Node built-in) | `require('https')` | `fetchHtml`, `fetchJson`, `fetchJsonInsecure`, `esiNamesPost`, `syncStationDatabase` inline POST |

---

## Call Graph

```
resolveLocation(locationId, characterId?)
├── readCache()
├── [player structure branch]
│   └── resolveStructureName(id, characterId)
│       ├── readCache()
│       ├── getStationById()                       ← Step 0: local DB
│       ├── _waitForEsiCooldown()
│       ├── getValidToken() + httpGet()            ← Step 1: auth ESI
│       ├── fetchJson()                            ← Step 2: public ESI
│       ├── fetchJsonInsecure()                    ← Step 3: Hammertime
│       ├── fetchHtml() [zkillboard]               ← Step 4
│       │   └── _esiStructureGeo()
│       │       ├── _waitForEsiCooldown()
│       │       ├── getValidToken() + httpGet()
│       │       └── fetchJson()
│       ├── fetchHtml() [adam4eve]                 ← Step 5
│       │   └── _esiStructureGeo()
│       ├── _esiStructureGeo()                     ← Step 6: geo fallback
│       ├── writeCache()
│       └── _persistToStationDb()
│           ├── upsertNpcStations()
│           └── upsertUpwellStructures()
├── [NPC station branch]
│   ├── getStationById()
│   ├── httpGet()                                  ← ESI /universe/stations/
│   └── _persistToStationDb()
├── [solar system branch]
│   └── httpGet()                                  ← ESI /universe/systems/
├── httpGet()                                      ← system hierarchy walk
├── httpGet()                                      ← constellation hierarchy walk
├── esiNamesPost([region_id, owner_id])            ← bulk name resolution
│   └── https.request() POST /universe/names/
└── writeCache()

resolveLocations(locationIds[], characterId?)
└── resolveLocation() × N                         ← up to 8 concurrent workers

resolveJobLocation(job, characterId?)
├── esiNamesPost([solarSystemId])
├── readCache()
├── resolveLocation(solarSystemId)                ← fire-and-forget cache warm
└── resolveLocation(facilityId)

resolveSystemNames(systemIds[])
└── esiNamesPost(ids)

syncStationDatabase()
├── fetchJson(HOBOLEAKS_STATIONS_URL)
├── fetchJson(FUZZWORK_STATIONS_URL)              ← fallback only
├── doPost() ESI /universe/names/                 ← geo name resolution
└── upsertNpcStations() × N chunks
```