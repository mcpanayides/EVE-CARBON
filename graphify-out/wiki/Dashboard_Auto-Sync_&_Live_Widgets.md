# Dashboard Auto-Sync & Live Widgets

> 14 nodes · cohesion 0.21

## Key Concepts

- **loadDashboard()** (25 connections) — `src/func/dashboard.js`
- **refreshDashboardLiveWidgets()** (11 connections) — `src/func/dashboard.js`
- **autoRefreshStaleCharacters()** (6 connections) — `src/func/dashboard.js`
- **_healFailedDashboardWidgets()** (4 connections) — `src/func/dashboard.js`
- **renderWalletBalanceWidget()** (4 connections) — `src/func/dashboard.js`
- **renderSkillQueueWidget()** (4 connections) — `src/func/dashboard.js`
- **_invalidateSharedJobs()** (3 connections) — `src/func/dashboard.js`
- **_renderNetWorthSection()** (3 connections) — `src/func/dashboard.js`
- **refreshDashboardPage()** (3 connections) — `src/func/dashboard.js`
- **_fireAutoSync()** (2 connections) — `src/func/dashboard.js`
- **autoSyncOnNavigate()** (2 connections) — `src/func/dashboard.js`
- **_isDirectorPing()** (2 connections) — `src/func/dashboard.js`
- **_pingSortKey()** (2 connections) — `src/func/dashboard.js`
- **_walletTicker()** (2 connections) — `src/func/dashboard.js`

## Relationships

- [Dashboard Widgets](Dashboard_Widgets.md) (20 shared connections)
- [Dashboard Widgets (_activeJobsShared)](Dashboard_Widgets_%28_activeJobsShared%29.md) (9 shared connections)
- [Dashboard Grid Layout & Popouts](Dashboard_Grid_Layout_%26_Popouts.md) (4 shared connections)
- [Dashboard Widgets (_wealthCharData)](Dashboard_Widgets_%28_wealthCharData%29.md) (1 shared connections)
- [Dashboard Widgets (_getMarketWatch)](Dashboard_Widgets_%28_getMarketWatch%29.md) (1 shared connections)

## Source Files

- `src/func/dashboard.js`

## Audit Trail

- EXTRACTED: 71 (97%)
- INFERRED: 2 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*