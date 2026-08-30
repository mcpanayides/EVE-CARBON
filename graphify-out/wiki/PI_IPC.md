# PI IPC

> 9 nodes · cohesion 0.33

## Key Concepts

- **pi_ipc.js** (10 connections) — `src/ipc/pi_ipc.js`
- **syncPIForCharacter()** (7 connections) — `src/ipc/pi_ipc.js`
- **summariseStorage()** (3 connections) — `src/ipc/pi_ipc.js`
- **registerPIHandlers()** (3 connections) — `src/ipc/pi_ipc.js`
- **buildStorageTypes()** (2 connections) — `src/ipc/pi_ipc.js`
- **getItemVolume()** (2 connections) — `src/ipc/pi_ipc.js`
- **{ ESI_BASE }** (1 connections) — `src/ipc/pi_ipc.js`
- **PI_STORAGE_TYPES_FALLBACK** (1 connections) — `src/ipc/pi_ipc.js`
- **PI_ITEM_VOLUMES** (1 connections) — `src/ipc/pi_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (3 shared connections)
- [Main Process ESI & Cache Layer](Main_Process_ESI_%26_Cache_Layer.md) (2 shared connections)
- [Character IPC](Character_IPC.md) (1 shared connections)

## Source Files

- `src/ipc/pi_ipc.js`

## Audit Trail

- EXTRACTED: 24 (80%)
- INFERRED: 6 (20%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*