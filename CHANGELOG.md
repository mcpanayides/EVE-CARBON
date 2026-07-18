# Changelog

All notable changes to EVE Carbon will be documented here.
Each release's GitHub notes are the matching `## [version]` section below —
the release workflow extracts the section for the tag being published.

---

## [1.1.5] - 2026-07-16
### Features
- **Corporation industry jobs** — the Active Jobs list (Industry page), the Active Industry Jobs widget and the Job Watch widget now include your corporation's research/manufacturing jobs alongside personal ones. Corp jobs carry a **CORP** badge and are attributed to their installer; jobs you installed for the corp are deduplicated so they stay listed under your character.
- Corp access is probed gracefully per character (scope on the token **and** the in-game **Factory Manager** role are required) — characters without access simply contribute nothing. Results are cached per corporation, so several alts in the same corp cost one ESI call.

### Notes
- Uses the `esi-industry.read_corporation_jobs.v1` scope (already in the login scope list). If corp jobs don't appear for an older character, remove and re-add them via SSO.
- The in-app version of this build reports **1.1.4**.

## [1.1.3] - 2026-07-15
_Rollup of 1.1.1 – 1.1.3._
### Fixes
- **Beehive status** — classification and MOTD parsing refactored twice for accuracy (explicit status-line detection, fail-safe handling).
- **Dead code removal** — deleted orphaned per-page HTML and theme files (Jabber, Market, Planetary Interaction, Wallets, Carbon/Sirius theme copies); pages are built by the page loader.
### Polish
- New styles for the Industry Cost Index page, the ping alert window, and themes.

## [1.1.0] - 2026-07-14
### Features
- **Spatial glass design** across the whole UI — panels, widgets, modals and forms render as floating glass slabs (new `glass.css`, Windows 11 acrylic behind the window where supported).
- **Widget pop-outs** — dashboard widgets can pop out into standalone glass windows (new pop-out button + `widget-window.html`).
- **Planetary Interaction** — card footer and detail modal redesigned; bug modal modernized to match the glass look.

## [1.0.0] - 2026-07-07
**First official release.** 🎉
### Features
- **Fitting tool** — local-fit indicators, damage bars, and capacitor stability lines.
- **Navigation** — the last visited page persists across restarts.
### Security
- Subresource integrity + `crossorigin` on external scripts; DOM-XSS code-scanning fix; locator certificate-validation fix.

## [0.9.1] - 2026-07-03
### Features
- **Beehive status widget** (GoonFleet beacon status from the room MOTD) and a **Modern view** dashboard toggle.
- **Forum scraping** with an enhanced forum UI.
- **Fitting** — fit browse tree API and fitting UI enhancements.
### Fixes
- Certificate pinning for the Hammertime API (structure locator security).
- Better error handling in asset loading.

## [0.9.0] - 2026-06-29
### Features
- **Widgetized dashboard** — the dashboard is now a configurable grid: **drag, resize, add and remove** widgets, with the layout persisted per session. Widgets snap tight and reflow their contents responsively as you resize them.
- **New dashboard widgets:**
  - **Net Worth** split into three independent widgets — Net Worth (KPIs), **Wealth Growth** (12-month chart), and **Wealth by Character**.
  - **Wallet Balances** with a 24-hour up/down ticker — green ↗ / red ↘ change per character and combined.
  - **Skill Queue** — the selected character's training queue with a live time-remaining countdown (adds the `esi-skills.read_skillqueue.v1` scope).
  - **Market Quicklook** — pin items via local-SDE name autocomplete; live Jita buy/sell plus a 24-hour price-trend badge.
  - **Active Market Orders** — buy/sell orders across all characters with fill bars and expiry.
  - **Job Watch** — pin and monitor a single in-progress industry job with a live countdown; addable any number of times (one per job).
- **Persistent market ticker** — a scrolling bottom bar of top market movers with item icons, Jita prices, and green/red day-over-day change.
- **Always-on incursion banner** — pinned alert at the top of the dashboard when an incursion is active in your alliance's space.
- **Fleet Commander page** — fleet composition tracker and fitting simulator.
- **Calendar** — in-app iCalendar (`.ics`) parsing, plus forum integration.
- **Reactions Profit calculator** — card grid with detailed breakdown modals.
- **Resync All** — one-click background re-sync of every character.
- **Map** — wormhole-connections toggle.
- **Material Symbols icons** across the UI for a consistent look with the navbar.

### Fixes
- **Net-worth asset value** — fixed assets valuing to ~0 ISK when the global market-price fetch was rate-limited during cold start: an empty price map is no longer cached, prices keep a stale fallback, and poisoned values auto-recompute.
- **Wallet balances** — fall back to the latest local snapshot when the live ESI call is rate-limited, so balances never show a false 0 ISK (and a bogus −100% drop).
- **Cold-start self-heal** — Active Jobs, Skill Queue and Wallet widgets refresh automatically once the background sync warms ESI tokens; rate-limited calls fall back to cached data instead of blanking.
- **Asset locations** — fitted ships and their contents now group under their station instead of floating to the top level as "Myrm", "…'s Velator", etc.; fully unknown / inaccessible structures collapse into a single group rather than cluttering the list with raw "Location {id}" rows.
- **Market item search** — replaced the removed public ESI `/search/` endpoint with a local SDE search (with name autocomplete).

### Notes
- New scope `esi-skills.read_skillqueue.v1` (Skill Queue widget) — re-login may be required.

## [0.8.7] - 2026-06-26
### Features
- **Calendar groundwork** — iCalendar (`.ics`) parser, forum IPC handlers, and calendar styles.

## [0.8.6] - 2026-06-25
### Features
- **My Blueprints page** — major overhaul, plus multiple fixes.
- **Reactions Profit calculator** — card grid with detailed breakdown modals.
- **Resync All** — one-click background re-sync of every character.
- Industry buttons switched to **Material Symbols** icons.

## [0.8.5] - 2026-06-24
### Features
- **Automatic data syncing** and improved navigation (smarter nav button handling).
- **Assets** — database wipe function, enhanced sorting, sortable headers restyled (new `assets.css`).

## [0.8.4b] - 2026-06-23
### Features
- **Wormhole connections on the map** — live Thera/Turnur connections from the EvE-Scout API, with a map toggle.

## [0.8.3] - 2026-06-22
### Features
- **Friends & Foes map overlay** — systems colored by alliance standings (adds the `esi-alliances.read_contacts.v1` scope; re-login required for standings).
- **Stargate Planner** — plan sub-cap stargate routes from the map.

## [0.8.2] - 2026-06-22
### Features
- **Settings → General** — Start with Windows and minimize-to-tray options.
- **Jump gate import** — paste a jump gate list with validation for friendly gates; results and counts shown on import.
- **Orehold minerals calculator** — parse orehold contents and value the reprocessed mineral yield.
### Fixes
- Map jump-bridge toggle tooltip corrected.

## [0.8.1] - 2026-06-18
_First packaged release of the 0.8 line — includes the unreleased 0.8.0 and 0.7.6 changes below, plus multiple stability fixes._

## [0.8.0] - 2026-06-18
### Features
- **Trade hubs in Ore/Ice/Gas/Moon calculators** — choose between Jita, Amarr, Dodixie, Rens and Hek; prices come from the selected hub.
- **Skill- & standing-based market tax** — sales tax (Accounting) and broker fee (Broker Relations + faction/corp standing at the hub owner) are pulled from the character's ESI data instead of a flat number. Adds the `esi-characters.read_standings.v1` scope (re-login required for standings).
- **Sell / Buy / Split price method** — realistic fees: Sell = broker + sales tax, Buy = sales tax only, Split = midpoint.
- **Moon Calculator** — new tab. Values moon ore by its full reprocessing output (all moon materials + minerals) read from the local SDE; falls back to a primary-material estimate with a hint when the SDE isn't downloaded.
- **Character favorites** — star characters to pin them to the top of the list.
- **Current location everywhere** — shown on the Dashboard banner, the selected-character card, and each character card.
- **Jump planner → "Show route on map"** — highlights the plotted route on the galaxy map with start/end markers and auto-fit.
- **Map "You are here"** — marks the selected character's current system.

### Fixes
- **Reaction industry jobs** now show "Reaction" instead of "Activity 9" (Dashboard + Industry).
- **Jump freighter fuel & range** corrected to match Dotlan: added the Jump Freighters skill (−10%/level), fixed JF base fuel (8800 → 10000 isotopes/LY) and JDC range bonus (+25% → +20% per level).
- **Map labels** — region names now show (incl. Security overlay) when zoomed out; system names appear later so mid-zoom is no longer a cluttered mess.
- **CharDB transaction race** — serialized writes (`withTx`) to fix "cannot start a transaction within a transaction".
- **Terminal log mojibake** — main-process logs are ASCII-safe regardless of console code page; dotenv startup tip silenced.

### Security / deps
- Resolved **all 18 npm audit vulnerabilities** (2 critical, 10 high) → 0: electron 28 → 42, sqlite3 5 → 6, removed the deprecated `electron-rebuild`.

### Tooling / CI
- New staged CI pipeline: **lint → tests → coverage → build (win/mac/linux)**.
- Zero-dependency unit tests (`node:test`) for the trade and jump math, with coverage tracking.
- Added GitHub issue forms + PR template; `.env.example`; expanded `.gitignore`.
- New IPC: get-hub-prices, get-hub-meta, get-trade-profile, get-moon-reprocessing, get-skill-levels.

## [0.7.6] - 2026-06-18
### Fixes
- Improved asset location resolution and handling of unresolved names.

## [0.7.5] - 2026-06-18
### Features
- **Planet Size Mapper** — region selection with planet details.
- **Jump calc widget.**
- Code structure refactor for readability and maintainability.

## [0.7.4] - 2026-06-17
### Features
- **Market tab** — live sell orders with Jita price comparison.

## [0.7.3] - 2026-06-17
### Features
- **Single-instance lock** — prevents multiple app instances.
- Assets grouped by their resolved station.

## [0.7.2] - 2026-06-15
### Features
- **Wallets** — draggable grid with asset valuation.
- **SDE fetch** — download progress tracking and error handling; fixed the Fuzzwork SDE pull.
- **Assets** — type metadata and structure repair.
### Fixes
- Navigation fixes.

## [0.7.1] - 2026-06-09
### Features
- **Blueprint-aware asset valuation** and a sync queue for character data.

## [0.7.0] - 2026-06-09
### Features
- **SDE-first name resolution** with a persistent name cache for dynamic names.
- **Update modal** with auto-download of new versions.

## [0.6.3] - 2026-06-03
### Features
- **Salvage Calculator** with UI updates.
- YAML file handling (js-yaml).

## [0.6.2] - 2026-06-03
### Fixes
- Build pipeline fixes.

## [0.6.1] - 2026-06-03
### Fixes
- Build workflow now fetches the SDE for Windows and macOS builds.

## [0.6.0] - 2026-06-03
### Features
- **Automatic updates** — updater migrated to GitHub Releases for version checks and downloads.
- **Theme management** — IPC handlers and default themes.

## [0.5.5] - 2026-06-03
### Tooling
- Automated tag builds and releases via GitHub Actions; docs auto-update workflow; release-notes wiring.

## [0.5.4] - 2026-06-03
### Changed
- Automated build and release pipeline via GitHub Actions
- Added CI test build workflow on every push to main
- Added CHANGELOG.md for release notes
- Added Automated updater
- Alliance pack management features with UI integration

## [0.5.3] - 2026-06-03
### Added
- Major Jabber fixes
- Caching layer for SDE lookups
- Tabbed blueprint details views
- Faster blueprint loading

## [0.5.2] - 2026-06-02
### Added
- Fixed major issues with the Blueprint logic, design and calculations
- Added Shopping Lists
- Added draggable widgets to the dashboard

## [0.5.1] - 2026-06-02
### Fixed
- Fixed major issues with the BP Search functions
- Fixed major issues with the BP Calculations

## [0.5.0] - 2026-05-30
### Added
- Secure EVE SSO Integration — authenticate characters via EVE Online SSO
- Blueprint Library Management — sync, browse and organize blueprints from ESI
- Recursive Material Calculator — multi-level manufacturing trees via Fuzzwork
- Asset & Wealth Tracking — liquid wealth, market orders, item locations across character roster
- Built-in Jabber Client — XMPP connection to jabber.eveonline.com with director-only filtering
- Local SDE Database — SQLite EVE Static Data Export for offline item and type lookups
- Dynamic Theming — user-configurable themes saved locally
