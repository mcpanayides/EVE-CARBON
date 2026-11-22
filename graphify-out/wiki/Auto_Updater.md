# Auto Updater

> 16 nodes · cohesion 0.19

## Key Concepts

- **updater_ipc.js** (18 connections) — `src/ipc/updater_ipc.js`
- **ref_https** (10 connections)
- **updater_critical.test.js** (8 connections) — `test/updater_critical.test.js`
- **registerUpdaterHandlers()** (7 connections) — `src/ipc/updater_ipc.js`
- **downloadBinary()** (6 connections) — `src/ipc/updater_ipc.js`
- **fetchJson()** (6 connections) — `src/ipc/updater_ipc.js`
- **parseReleaseFlags()** (4 connections) — `src/ipc/updater_ipc.js`
- **ref_http** (4 connections)
- **clean()** (2 connections) — `src/ipc/updater_ipc.js`
- **compareVersions()** (2 connections) — `src/ipc/updater_ipc.js`
- **fs** (1 connections) — `src/ipc/updater_ipc.js`
- **os** (1 connections) — `src/ipc/updater_ipc.js`
- **path** (1 connections) — `src/ipc/updater_ipc.js`
- **{ shell, BrowserWindow }** (1 connections) — `src/ipc/updater_ipc.js`
- **assert** (1 connections) — `test/updater_critical.test.js`
- **test** (1 connections) — `test/updater_critical.test.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (4 shared connections)
- [Palette Slots Test](Palette_Slots_Test.md) (4 shared connections)
- [Character IPC](Character_IPC.md) (3 shared connections)
- [Fleet Kills Test](Fleet_Kills_Test.md) (2 shared connections)
- [Account & Auth IPC](Account_&_Auth_IPC.md) (2 shared connections)
- [Lint](Lint.md) (1 shared connections)
- [Intel IPC](Intel_IPC.md) (1 shared connections)
- [Alliance Packs Spec](Alliance_Packs_Spec.md) (1 shared connections)
- [ESI IPC](ESI_IPC.md) (1 shared connections)
- [Station & Structure Locator](Station_&_Structure_Locator.md) (1 shared connections)
- [Resfile Backgrounds](Resfile_Backgrounds.md) (1 shared connections)
- [SDE Fetch & Build](SDE_Fetch_&_Build.md) (1 shared connections)

## Source Files

- `src/ipc/updater_ipc.js`
- `test/updater_critical.test.js`

## Audit Trail

- EXTRACTED: 46 (96%)
- INFERRED: 2 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*