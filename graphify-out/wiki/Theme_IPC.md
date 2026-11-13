# Theme IPC

> 8 nodes · cohesion 0.32

## Key Concepts

- **registerThemeHandlers()** (7 connections) — `src/ipc/theme_ipc.js`
- **js-yaml** (5 connections) — `package.json`
- **resolveTheme()** (3 connections) — `src/ipc/theme_ipc.js`
- **builtinFiles()** (2 connections) — `src/ipc/theme_ipc.js`
- **migrateLegacyYamlThemes()** (2 connections) — `src/ipc/theme_ipc.js`
- **readThemeFile()** (2 connections) — `src/ipc/theme_ipc.js`
- **js-yaml@^5.5.0** (2 connections) — `package.json`
- **themePayload()** (1 connections) — `src/ipc/theme_ipc.js`

## Relationships

- [Electron Main Process](Electron_Main_Process.md) (2 shared connections)
- [PI Tally Test](PI_Tally_Test.md) (1 shared connections)
- [NPM Runtime Dependencies](NPM_Runtime_Dependencies.md) (1 shared connections)
- [NPM Dev Dependencies](NPM_Dev_Dependencies.md) (1 shared connections)
- [Alliance Pack Test](Alliance_Pack_Test.md) (1 shared connections)

## Source Files

- `package.json`
- `src/ipc/theme_ipc.js`

## Audit Trail

- EXTRACTED: 14 (93%)
- INFERRED: 1 (7%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*