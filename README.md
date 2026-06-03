# EVE Carbon
Designed for serious capsuleers and industrial manufacturers, EVE-Carbon is a comprehensive desktop management tool for EVE Online. By integrating live ESI data with a local Static Data Export (SDE) database, it delivers lightning-fast recursive blueprint calculations, real-time wealth tracking, and integrated XMPP Jabber communications—all wrapped in a secure, customizable Electron interface. Whether you are scaling up capital ship production or optimizing regional supply chains, EVE-Carbon provides the critical data and organizational tools needed to dominate the industrial market.

## 🚀 Features

* **Secure EVE SSO Integration**: Authenticate characters securely via EVE Online SSO.
* **Blueprint Library Management**: Synchronize, browse, and organize your blueprints directly from ESI.
* **Recursive Material Calculator**: Dynamically build multi-level manufacturing trees for any blueprint, integrating public blueprint copies via Fuzzwork.
* **Asset & Wealth Tracking**: Track liquid wealth, active market orders, and item locations across your character roster.
* **Built-in Jabber Client**: Connect directly to `jabber.eveonline.com` via an integrated XMPP client with director-only filtering.
* **Local SDE Database**: Uses a local SQLite EVE Static Data Export (SDE) for lightning-fast, offline item and type lookups.
* **Dynamic Theming**: Customizable UI with user-configurable themes saved locally.

---

## 🏗 Architecture & Tech Stack

* **Framework**: [Electron](https://www.electronjs.org/) (Main and Renderer processes with Context Bridge isolation).
* **Frontend**: Vanilla HTML/CSS/JS, utilizing dynamic CSS variables for theming.
* **Backend / Local DB**: Node.js, `sqlite3` for local SDE queries, and local JSON storage for user profiles and caching.
* **External APIs**: 
  * EVE Online ESI (`https://esi.evetech.net`)
  * EVE SSO OAuth 2.0
  * Fuzzwork API
  * EVE Tech Image Server

## 📥 Download
The easiest way to get EVE Carbon is from the 
[Releases page](https://github.com/mcpanayides/EVE-CARBON/releases) — 
just download and run the installer, no setup needed.

---

## 🔧 Building from Source
For developers who want to build or contribute:

### Requirements
- Node.js v22 or higher

### Steps
1. Install dependencies
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

### For what does what and where
-- Please check the ./src/docs for more details


## Notes
- All data comes from the public EVE ESI API — no API key or login needed
- Blueprint material data may be incomplete for very new items not yet indexed by ESI
- Reaction chains are auto-detected (manufacturing vs reaction blueprints)


🤝 Special Thanks
   - 🤝Fuzzworks for without Steve none of this would be possible
   - 🤝Adam4EVE  - Station Name resolutions
   - 🤝EVE Rift for making an incredible app, and giving me many ideas and tonnes of inspiration 
   - 🤝EVE Online [Fenris Creations] for making an incredible game, and giving the power to the people to build all the amazing tools
   - 🩷Built with blood sweat tears 😭😭, and lots of Claude code...


