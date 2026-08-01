# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- Electron desktop app (Windows / macOS / Linux). The renderer is vanilla HTML/CSS/JS, so it is a `web` surface, not a native iOS/Android platform. -->

## Users

Primary user: the **serious, multi-character EVE Online player** — a "generalist power-user" who lives across several of the game's deep systems at once (industry, markets, Faction Warfare, PvP, fitting, fleet command, skill planning, in-game comms) rather than specializing in one. They run multiple characters, care about ISK efficiency, and currently stitch their play together across a dozen external websites and spreadsheets.

No single persona (industrialist, trader, FC) dominates the design: the product must serve the whole loop equally well, and the interface has to make a very wide feature surface feel navigable to one person switching contexts frequently.

## Product Purpose

EVE Carbon is a **comprehensive desktop companion for EVE Online** — one fast, native app that unifies a character roster's live ESI data with a bundled local Static Data Export (SDE) database. It exists to collapse the sprawl of third-party EVE tooling (industry calculators, market/appraisal sites, killboards, FW trackers, skill planners, comms) into a single trusted app the pilot keeps open alongside the game.

Success means **community adoption**: EVE Carbon becomes a recognized, trusted third-party tool that EVE players recommend to each other — the default companion a generalist power-user reaches for instead of alt-tabbing to a dozen sites.

## Positioning

The defensible position is **breadth unified with local speed and privacy**, not any single best-in-class calculator. Neighboring tools each own one slice (a market site, a killboard, a skill planner); EVE Carbon is the one place all of those slices share a roster, a theme, and a window. Two structural advantages a single-purpose web tool cannot truthfully copy:

- A **bundled local SDE (SQLite)** enabling instant, offline item/type lookups and recursive material math — no round-trips to a remote API for reference data.
- **Local-only credential handling**: EVE SSO tokens are stored on the user's machine and never leave it, so the breadth does not come at the cost of trusting a third-party server with account access.

## Operating Context

- Runs on the **desktop, alongside the running EVE client**, typically on a second monitor or alt-tabbed to; the pilot moves between planning (industry, skills, markets) and live activity (FW, killboard, fleet, comms).
- Data comes from **EVE Online ESI + EVE SSO (OAuth 2.0 / PKCE)** for authenticated character data, and public sources for the rest.
- The pilot manages **multiple authenticated characters** at once, and expects roster-wide, combined, and per-character views.
- New features that add an ESI scope require previously-authorized characters to **re-authenticate**; the app surfaces which ones and prompts them.
- Background, ambient signals matter in-context: undercut alerts, extractor/moon timers, mail/notifications, and a configurable Jabber ping sound run while the pilot is doing something else.

## Capabilities and Constraints

Confirmed capability surface (each is a distinct area the design must house):

- **Auth & roster**: multi-character EVE SSO; local token storage.
- **Dashboard & Net Worth**: liquid wealth, asset value, roster activity, live market ticker.
- **Skill Planner**: multi-character plan costing, in-game-style skill browser, plan-by-ship prerequisite expansion, optimal remaps, Jita-priced implant/accelerator optimiser; exports to Multibuy / text / EVEMon.
- **Blueprint Library & Industry**: BPO/BPC-aware blueprint sync, recursive material calculator, reactions, salvage, ore/reprocessing, cost index, bulk Jita appraisal, shopping lists, and **Station Checkout** (diffs a shopping list against holdings in a station/structure/container).
- **Mining Ledger**: per-character and combined yield valued as ore or refined minerals, daily trends, corp moon-extraction timers.
- **Finances Suite**: wallets & liquid wealth, contracts browser, LP Store optimiser (ISK/LP on live Jita prices), trading tools (undercut alerts w/ background notifications, per-item realised P&L, profit-over-time, vs-Jita order view).
- **Faction Warfare Tracker**: warzone control & tiers, per-system plex/contested status, militia stats, pilot & corp leaderboards, LP-rate tiers.
- **Killboard**: recent kills/losses, all-time PvP stats, combined all-character/all-corp overviews (via zKillboard).
- **EVE Mail & Notifications**: read/reply/send mail; in-game notification feed — live from ESI.
- **Fitting Simulator, Fleet Tools & Star Map**: fit simulation (hulls via in-game market tree), live fleet tools, interactive jump map with Thera / wormhole routing.
- **Planetary Interaction**: PI colonies and extractor timers across characters.
- **Built-in Jabber (XMPP) client**: connects to `jabber.eveonline.com`, director-only filtering, message pop-ups, configurable ping-alert sound with custom uploads.
- **Local SDE database**: bundled SQLite EVE Static Data Export for offline lookups.
- **Dynamic theming**: user-configurable themes saved locally.

Technical constraints future work must respect:

- **Electron** (main + renderer with Context Bridge isolation); frontend is **vanilla HTML/CSS/JS** with dynamic CSS variables — no framework.
- **Data cadence is ESI-driven**: features auto-refresh on ESI's own cache TTL; the product deliberately has **no manual Sync/Refresh buttons**.
- ESI carries a **shared error-limit budget** (429/420) that must not be drained by aggressive polling.
- Blueprint material data may be incomplete for very new items not yet indexed by ESI.
- Requires Node.js v22+ to build; SDE fetched at build time and shipped as an extra resource.

## Brand Commitments

- **Name**: EVE Carbon. Author: Mia Christina Panayides.
- **Distinct visual identity, not a client mimic.** EVE Carbon should read as its **own brand** that respects EVE's world without trying to look like a native extension of the in-game client. Named themes **Carbon** and **Sirius** ship today; theming is user-configurable and a core part of the identity.
- Icon language today mixes an EVE neocom-style SVG sprite (for game pages) with Material Symbols (for app-utility) — a deliberate hybrid, no emoji in the chrome.
- Voice in existing product copy (README, changelog) is **knowledgeable and pilot-to-pilot** — uses EVE domain vocabulary (ISK, LP, Jita, plex, BPO/BPC, warzone) without over-explaining, confident but not marketing-slick.
- Credits real community pillars (Fuzzworks, Adam4EVE, EVE Rift, CCP/EVE Online); trades on being a respectful, credible member of the third-party dev community.

## Evidence on Hand

- **Working, shipping product** at v1.7.0 with a full changelog and GitHub Releases (Windows / macOS / Linux installers): `README.md`, `package.json`, `CHANGELOG`.
- **Per-module developer docs**: `src/docs/*.md`.
- **Live external data integrations** (real, not mocked): EVE ESI + SSO, images.evetech.net, Fuzzwork, zKillboard, EvE-Scout, EVERef.
- Existing themes and stylesheets: `src/styles/` (incl. `theme-carbon.css`, `theme-sirius.css`, `palette.css`).
- Icons/audio/backgrounds assets under `assets/`.
- **Absences future work must not fabricate**: there are no published user counts, testimonials, benchmarks, pricing, or partnership/endorsement claims. The app is free and community-oriented; do not invent adoption metrics or CCP endorsement.

## Product Principles

1. **Unify without diluting.** Breadth is the point, but every area must feel first-class; the design's job is to make a huge surface navigable for one person switching contexts, not to flatten depth.
2. **Local, fast, private by default.** Offline SDE speed and local-only tokens are core promises — never trade them for convenience or a remote dependency.
3. **Let ESI set the tempo.** Data refreshes on ESI's cadence automatically; respect the shared error budget and never add manual sync controls.
4. **Pilot-to-pilot, not marketing.** Speak the game's language to people who already know it; earn trust as a credible community tool rather than selling.
5. **Its own identity, faithful to EVE.** A distinct, themeable brand that honors EVE's world without impersonating the in-game client.

## Accessibility & Inclusion

No product-specific accessibility standard has been established. Practical baseline from the current build: it is a themeable, keyboard-and-mouse desktop app; theming must preserve legible contrast across user-configurable palettes, and color must never be the sole carrier of meaning in data-dense views (charts, KPIs, status badges).
