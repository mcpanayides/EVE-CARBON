# EVE Carbon
A desktop application for EVE Online players to deal with anything that might arise on a day-to-day activity in EVE online.
Its starting out as an industrial calculate full multi-tier material requirements for any blueprint, with ME/TE research level support.

## Features

- 🔍 Live search against EVE ESI (no login required)
- 📊 Full 4-tier material breakdown:
  - **Tier 3** – Direct manufacturing components (Capital parts, etc.)
  - **Tier 2** – Reaction products (Fernite Carbide, Ferrogel, etc.)
  - **Tier 1** – Processed materials (Fernite Alloy, Ceramic Powder, etc.)
  - **Tier 0** – Raw materials (Scandium, Vanadium, etc.)
- ⚗️ ME/TE research level inputs with live adjustment
- 🏭 Facility bonus support (Raitaru, Azbel, Sotiyo)
- 💉 Implant bonus support
- 📋 Shows adjusted qty vs base qty and ME material savings
- Works with any blueprint: ships, capitals, structures, modules

## Building the .exe

### Requirements
- [Node.js](https://nodejs.org/) v18 or higher (includes npm)

### Steps

1. **Install dependencies**
   ```
   npm install
   ```

2. **Build the Windows installer (.exe)**
   ```
   npm run build-win
   ```
   The installer will be in `dist/EVE Carbon Setup x.x.x.exe`

3. **Or just run it without building:**
   ```
   npm start
   ```

### Other platforms
- **macOS:** `npm run build-mac`
- **Linux:** `npm run build-linux`

## No icon?
The build requires `assets/icon.ico` for Windows. If you don't have one, either:
- Remove the `"icon"` lines from `package.json`, or
- Drop any `.ico` file into the `assets/` folder and name it `icon.ico`

You can convert a PNG to ICO at https://convertio.co/png-ico/

## Notes
- All data comes from the public EVE ESI API — no API key or login needed
- Blueprint material data may be incomplete for very new items not yet indexed by ESI
- Reaction chains are auto-detected (manufacturing vs reaction blueprints)
