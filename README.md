# EVE Carbon
Designed for serious capsuleers and industrial manufacturers, EVE-Carbon is a comprehensive desktop management tool for EVE Online. By integrating live ESI data with a local Static Data Export (SDE) database, it delivers lightning-fast recursive blueprint calculations, real-time wealth tracking, and integrated XMPP Jabber communications—all wrapped in a secure, customizable Electron interface. Whether you are scaling up capital ship production or optimizing regional supply chains, EVE-Carbon provides the critical data and organizational tools needed to dominate the industrial market.

## 🚀 Features

* **Secure EVE SSO Integration**: Authenticate characters securely via EVE Online SSO.
* **Multi-Character Skill Planner**: Build skill plans once and cost them against every character, with an in-game-style skill browser, plan-by-ship prerequisite expansion, remap optimisation, and a Jita-priced implant/cerebral-accelerator cost optimiser.
* **EVE Mail & Notifications**: Read, reply to and send in-game mail, and browse the in-game notification feed — all live from ESI.
* **Killboard**: Recent kills and losses with all-time PvP stats, plus combined all-character and all-corporation overviews (via zKillboard).
* **Blueprint Library & Industry Tools**: Synchronize and browse blueprints (with correct BPO/BPC icons), plus a recursive material calculator, reactions, salvage, ore/reprocessing, cost index, bulk Jita appraisal, shopping lists, and a **Station Checkout** that diffs a shopping list against what you already hold in a chosen station/structure/container and surfaces exactly what's missing.
* **Mining Ledger**: Per-character (and combined) mining yield valued as raw ore or refined minerals, daily trends, and corp moon-extraction timers — auto-refreshed on ESI's own cadence.
* **Finances Suite**: Wallets and liquid-wealth tracking, contracts browser, an **LP Store optimiser** (ranks loyalty offers by ISK/LP on live Jita prices), and **Trading tools** — per-station undercut alerts with background toast notifications, per-item realised P&L, profit-over-time, and a vs-Jita order view.
* **Faction Warfare Tracker**: Live warzone control and tiers, per-system plex/contested status, militia stats, pilot & corp leaderboards, and LP-rate tiers — sourced from public ESI.
* **Fitting Simulator, Fleet Tools & Star Map**: Simulate ship fits (browsing hulls by the in-game market tree), run fleet tools, and plan jumps on an interactive map.
* **Built-in Jabber Client**: Connect directly to `jabber.eveonline.com` via an integrated XMPP client with director-only filtering, message pop-ups, and a configurable ping-alert sound (with custom uploads).
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

**macOS (Apple Silicon):** the app is ad-hoc signed but not yet notarized, so on first
launch macOS quarantines it. Right-click the app → **Open** and confirm, or run
`xattr -dr com.apple.quarantine "/Applications/EVE-Carbon.app"` once — after that it
opens normally.

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
   🤝 Fuzzworks for without Steve none of this would be possible
   🤝 Adam4EVE  - Station Name resolutions
   🤝 EVE Rift for making an incredible app, and giving me many ideas and tonnes of inspiration 
   🤝 EVE Online [Fenris Creations] for making an incredible game, and giving the power to the people to build all the amazing tools
   🤝 Nikita Manaenkov - Serveral tweaks and security updates.
   🩷 Built with blood sweat tears 😭😭, and lots of Claude code...


