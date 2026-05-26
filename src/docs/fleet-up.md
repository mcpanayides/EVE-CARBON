# `fleetup.js` — Function & Connection Reference

---

## Functions

### `openFleetBossWindow(characterId, bossCharacterId)` *(async)*
**Purpose:** Triggers the active EVE client to open the in-game information window for a target character (the fleet boss). Authenticates as `characterId` to obtain a valid token, then sends a POST to the ESI UI endpoint targeting `bossCharacterId`.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `characterId` | `number \| string` | The character whose EVE client session is used to send the UI command |
| `bossCharacterId` | `number \| string` | The character whose info window should be opened in the EVE client |

**Calls:**

| Called function/API | Why |
|---|---|
| `window.eveAPI.getValidToken(characterId)` | Retrieve a valid ESI OAuth bearer token for the acting character |
| `fetch(url, options)` | POST to ESI `/v1/ui/openwindow/information/` to trigger the in-game UI action |

**ESI endpoint used:**
```
POST https://esi.evetech.net/v1/ui/openwindow/information/?target_id={bossCharacterId}&datasource=tranquility
Authorization: Bearer {token}
```

**Error handling:** Catches all errors and logs them via `console.error` — failures are silent to the user.

---

## External Dependencies

| Dependency | Source | Used by |
|---|---|---|
| `window.eveAPI.getValidToken(characterId)` | Electron IPC / preload | `openFleetBossWindow` |
| `fetch(url, options)` | Browser / Node native | `openFleetBossWindow` |

---

## Call Graph

```
openFleetBossWindow(characterId, bossCharacterId)
├── window.eveAPI.getValidToken(characterId)   ← get OAuth bearer token
└── fetch()                                    ← ESI POST /v1/ui/openwindow/information/
```