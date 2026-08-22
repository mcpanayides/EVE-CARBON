# EVE Carbon

EVE Carbon is a comprehensive desktop companion for EVE Online — one fast, native app that brings your characters' live ESI data together with a local Static Data Export (SDE) database. Industry and markets, wealth and trading, Faction Warfare and PvP, fitting and fleet command, skill planning and in-game comms all live in one place, wrapped in a secure, themeable Electron interface. Whether you're scaling capital production, chasing ISK-per-LP on the market, tracking a warzone, or planning the next skill to fly a new hull, EVE Carbon gives you the data and organizational tools to do it without alt-tabbing to a dozen websites.

## 🚀 Features

* **Secure EVE SSO Integration**: Authenticate multiple characters via EVE Online SSO; access tokens are stored locally.
* **Dashboard & Net Worth**: At-a-glance liquid wealth, asset value and activity across your whole roster, plus a live market ticker.
* **Multi-Character Skill Planner**: Build a plan once and cost it against every character, with an in-game-style skill browser, plan-by-ship prerequisite expansion, optimal remaps, and a Jita-priced implant / cerebral-accelerator cost optimiser. Export to Multibuy, plain text, or EVEMon.
* **Blueprint Library & Industry Tools**: Synchronize and browse blueprints (with correct BPO/BPC icons), plus a recursive material calculator, reactions, salvage, ore/reprocessing, cost index, bulk Jita appraisal, shopping lists, and a **Station Checkout** that diffs a shopping list against what you already hold in a chosen station, structure or container and surfaces exactly what's missing.
* **Mining Ledger**: Per-character (and combined) mining yield valued as raw ore or refined minerals, daily trends, and corp moon-extraction timers — auto-refreshed on ESI's own cadence.
* **Finances Suite**: Wallets and liquid-wealth tracking, a contracts browser, an **LP Store optimiser** (ranks loyalty offers by ISK/LP on live Jita prices), and **Trading tools** — per-station undercut alerts with background notifications, per-item realised P&L, profit-over-time, and a vs-Jita order view.
* **Faction Warfare Tracker**: Live warzone control and tiers, per-system plex/contested status, militia stats, pilot & corp leaderboards, and LP-rate tiers.
* **Killboard**: Recent kills and losses with all-time PvP stats, plus combined all-character and all-corporation overviews (via zKillboard).
* **EVE Mail & Notifications**: Read, reply to and send in-game mail, and browse the in-game notification feed — all live from ESI.
* **Fitting Simulator, Fleet Tools & Star Map**: Simulate ship fits (browsing hulls by the in-game market tree), run live fleet tools, and plan jumps on an interactive map with Thera / wormhole routing. The map also paints live sovereignty as a glowing influence field — coloured by alliance, or by your own standings, with each territory named on its own ground.
* **Planetary Interaction**: Track PI colonies and extractor timers across your characters.
* **Built-in Jabber Client**: Connect directly to `jabber.eveonline.com` via an integrated XMPP client with director-only filtering, message pop-ups, and a configurable ping-alert sound (with custom uploads).
* **Local SDE Database**: A bundled SQLite EVE Static Data Export for lightning-fast, offline item and type lookups.
* **Dynamic Theming**: Customizable UI with user-configurable themes saved locally.

---

## 🏗 Architecture & Tech Stack

* **Framework**: [Electron](https://www.electronjs.org/) (main and renderer processes with Context Bridge isolation).
* **Frontend**: Vanilla HTML/CSS/JS, using dynamic CSS variables for theming.
* **Backend / Local DB**: Node.js, `sqlite3` for local SDE queries, and local JSON storage for user profiles and caching.
* **External services**:
  * EVE Online ESI (`https://esi.evetech.net`) + EVE SSO (OAuth 2.0 / PKCE)
  * EVE Tech Image Server (`images.evetech.net`)
  * Fuzzwork market aggregates
  * zKillboard (killmails & PvP stats)
  * EvE-Scout (Thera / wormhole routing)
  * EVERef (reference data)

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
1. **Install dependencies**
   ```
   npm install
   ```
2. **Fetch the EVE Static Data Export** (downloads the local SDE database used for item/type lookups)
   ```
   npm run fetch-sde
   ```
3. **Run it**
   ```
   npm start
   ```

### Building installers
- **Windows** (fetches the SDE automatically):
  ```
  npm run build-win
  ```
  The installer will be in `dist/EVE Carbon Setup x.x.x.exe`.
- **macOS**: `npm run fetch-sde && npm run build-mac`
- **Linux**: `npm run fetch-sde && npm run build-linux`

### For what does what and where
See [`./graphify-out/wiki`](./graphify-out/wiki/index.md) for a generated map of the codebase — one article per subsystem, with the functions in it and how it connects to its neighbours.

## 📝 Notes
- **Character data requires an EVE SSO login** — you sign in with your EVE account and grant scopes; your tokens are stored locally and never leave your machine. Public data (Faction Warfare, market prices, killboard) needs no login.
- When a new feature adds an ESI scope, characters authorised before it existed must **re-authenticate** — the app tells you which ones and prompts you.
- Blueprint material data may be incomplete for very new items not yet indexed by ESI.
- Reaction chains are auto-detected (manufacturing vs reaction blueprints).

## 🤝 Special Thanks
- **Fuzzworks** — without Steve, none of this would be possible.
- **Adam4EVE** — station name resolution.
- **EVE Rift** — an incredible app that gave me many ideas and tonnes of inspiration.
- **EVE Online [Fenris Creations]** — for making an incredible game, and giving the power to the people to build all these amazing tools.
- **Nikita Manaenkov** — several tweaks and security updates.

🩷 Built with blood, sweat, tears 😭😭, and lots of Claude Code…
