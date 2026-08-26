# TODO

Known work that is understood, measured, and deliberately not done yet. Each
entry says what the problem is, what it costs today, and how to reproduce it —
so picking one up does not start with re-deriving the diagnosis.

---

## Assets at real-user scale — the rework

**Status:** diagnosed and prototyped end to end. Not built. Measured 2026-08-15
against 90 characters / 100,029 assets (`npm run stress:data`, `stress:render`).

### What is wrong today

The page loads every asset for every character into a JS array, builds the whole
tree into the DOM in one synchronous pass, and computes every price in the
renderer afterwards.

| | today |
|---|---|
| first rows on screen | 27.1 s |
| tree settled | 44.6 s |
| DOM rows | 109,527 |
| sort by price | 42.2 s, **every click** |

**The database is not the bottleneck.** Reading all 99,184 rows across 90
characters takes 2.7 s with a flat per-row cost (0.0253 ms/row for the biggest
hangar vs 0.0334 for the smallest — linear). Roughly 42 of the 45 seconds is DOM
construction. `renderNextAssetChunk()` is an empty function; chunked rendering
existed once and was removed.

### Why naive pagination is the wrong answer

"Show 30 rows per page" only sorts the 30 rows you fetched. If a Titan sits at
row 4,000 of the unsorted set, it never reaches page one. Sorting has to happen
across **all** the data or the most valuable item — the whole reason to sort by
price — is exactly what gets hidden.

The fix is not to stop paginating. It is to **sort in the database and paginate a
globally-ordered result**. The page is then a window onto all 100k rows ranked by
value, so the Titan is row one because SQLite ranked every row, not because the
renderer sorted a page.

### The blocker: price is not data, it is a render-time guess

`assetUnitPrice()` derives a value in the renderer from three caches that arrive
independently:

| input | where it lives | for |
|---|---|---|
| Jita buy/sell | one JSON file per type in the main-process file cache | most items |
| CCP adjusted/average | in-memory map, fetched once | blueprint originals |
| SDE group/category | `typeMetaCache`, fetched per type | Titan/Super/faction-dread defaults |

So a Titan's 165 B valuation cannot be known until SDE metadata has loaded —
the single most valuable item in a hangar is the one whose price arrives last.
Nothing can sort by value in SQL while this is true.

**This is the enabling change.** Materialise one authoritative `unit_value` per
type into SQLite, resolved at write time from all three sources. Everything else
follows from it, and it independently fixes price loss on restart and the
dashboard's net-worth recomputation.

#### Which price source — measured, 2026-08-15

Against the real profile (16 characters, 10,819 assets, 2,484 distinct types):

| | CCP `/markets/prices/` | Fuzzwork Jita 4-4 |
|---|---|---|
| calls | 1 | 10 (250 types each) |
| time | 1.8 s | 3.2 s |
| coverage of held types | 91.4 % | 91.8 % |

**Fetching prices is not the bottleneck.** 3.2 s once, cached 6 h, against a
42 s render. Replacing Jita with the single CCP call saves ~1.4 s and costs a
great deal of accuracy.

CCP's adjusted price is systematically low — median ratio 0.82, portfolio 290 B
vs 357 B (**-18.6 %**) — and the outliers land on exactly the items worth
knowing about:

| item | CCP | Jita | |
|---|---|---|---|
| Wyvern (Supercarrier) | 27,000 M | 4.9 M | Jita wrong — supercapitals have no highsec market |
| Domination Control Tower | 1,931 M | 8,499 M | CCP wrong — faction structure |
| Apostle (Force Auxiliary) | 1,211 M | 3,422 M | CCP wrong |
| Women's 'Structure' Skirt | 28 M | 790 M | CCP wrong — collector market |
| Harbinger Blueprint | 590 M | 624 M | CCP right — BPOs are its job |

Neither source is authoritative alone, and they fail on *different* classes:
CCP misprices player-traded rares and faction gear; Jita has no price at all for
things that cannot be sold there. This is why `ASSET_DEFAULT_VALUE` exists.

**Tiered resolution** — the right answer, for accuracy rather than speed:

1. CCP's one call as the **baseline for every type** (free, complete, 91 %).
2. **Real market prices only for the types that carry the value.** The top 50
   types hold **78.9 %** of portfolio value out of 2,484 — so refining a few
   hundred costs one Fuzzwork batch instead of ten, and is kinder to a free
   third-party service.
3. Hardcoded hull defaults override both where no real market exists.

Ranking for step 2 uses the CCP value, which only has to be approximately right
to pick the right few hundred types.

### Measured prototype

Against the real 100k-asset fixture, no tuning beyond two indexes:

| operation | time |
|---|---|
| materialise assets + index | 215 ms |
| own value per item | 220 ms |
| recursive container roll-up (12,769 containers) | 317 ms |
| **top 50 by value, globally ordered** | **77 ms** |
| top 50 including container totals | 32 ms |
| page 200 deep | 87 ms |
| location totals (120 group rows) | 128 ms |
| expand one location (200 rows) | 217 ms |
| grand total / net worth | 60 ms |

Precompute is ~1.7 s once after a sync, in the background. Every interaction
after that is under a quarter of a second — against 42 seconds today.

The recursive roll-up was the risk (a container's sort key depends on its
descendants, to arbitrary depth) and it is 317 ms with a depth guard against the
self-referential `location_id` values ESI has been known to return.

### The design

1. **`type_prices` table.** One row per type: `unit_value`, `updated_at`.
   Written by the existing `fetchHubPrices` path, with the BPO map and the
   capital-hull defaults folded in so the column is the final answer. Refreshed
   on the existing TTL; `updated_at` makes staleness visible.
2. **One assets relation.** Assets are sharded into `char_<id>_assets` tables, so
   a global sort needs a `UNION ALL` (6 ms as a view, 215 ms materialised). A
   single `assets` table with a `character_id` column would be simpler and
   faster; larger migration, worth costing separately.
3. **`asset_value`** — own value per item — and **`contained`** — rolled-up
   value per container — rebuilt after each sync.
4. **Query per view, not load-everything.** The renderer asks for the visible
   page, the group totals, one expanded location. It never holds 100k rows.
   Search and filters become `WHERE` clauses.
5. **Virtualised rows.** Only viewport rows exist in the DOM.

### Phasing — each step ships on its own

- **Phase 1 — value in the database. DONE (v3.0.1-dev).**
  `src/asset_valuation.js` + `src/ipc/valuation_ipc.js`. `type_prices`,
  `asset_value` and `asset_contained` are materialised after a tiered price
  resolution (CCP baseline → market refinement of the top types → hull
  defaults), refreshed 20 s after launch. Measured on the 90-character /
  100k-asset fixture: rebuild 2.5 s once, then **top 50 across all characters
  38 ms**, page 500 deep 37 ms, one character 3 ms, net worth 11 ms.
  Wired into the post-sync path in Phase 2.
- **Phase 2 — query per view. DONE (v3.0.1-dev).**
  `src/asset_index.js` + the query handlers in `src/ipc/valuation_ipc.js`, with
  `src/func/assets.js` rewritten around them. The page no longer loads anything
  it is not showing: it opens as a list of locations, expanding one asks which
  characters hold something there, and expanding a character asks for its items.
  Collapsing removes those rows again.

  Measured on the 90-character / 100k-asset fixture, in the running app:

  | | before | after |
  |---|---|---|
  | first paint | ~42 s | **2.9 s** |
  | DOM rows at rest | ~100,000 | **120** |
  | sort by value | full re-sort + re-render | **133 ms** |
  | expand one hangar | n/a (all built up front) | **353 ms**, +165 rows |
  | search | re-filter 100k in JS | **~300 ms** |

  Data-layer timings (`npm run stress:index`, uncontended): filter options
  82 ms, summary 64 ms, location groups 34–45 ms whether filtered, searched or
  not, one hangar 8 ms, top 50 across everything 2 ms.

  The rebuild is ~12 s end to end (2.1 s values and roll-up, 2.8 s resolving
  locations for 90 characters, 7.2 s building the index), debounced and in the
  background. It is the one number that got slower, deliberately: it buys every
  number above it. About a second of that is the staging-table swap described
  below, which is what keeps the page readable while it runs.

  **The rebuild builds into staging tables and swaps.** Everything in the main
  process shares ONE SQLite connection, so a query the page makes during a
  rebuild does not get its own snapshot — it executes inside the rebuild's
  transaction. Emptying the live table first therefore let the page report an
  empty hangar mid-rebuild; sampling a read forty times during an in-place
  rebuild returned `3000, 0, 1, 2, 3 …` as the table refilled underneath it.
  Now the live tables are untouched until the new ones are complete (the same
  write-then-swap `replaceAssets` uses). The swap itself still has a window
  where the table genuinely does not exist, between the DROP and the RENAME, so
  reads are gated across it — milliseconds, against six seconds before.

  **Group totals are an invariant, not an accident.** A header shows
  `SUM(own_value)` while each top-level row shows own + contained, so the two
  agree only if everything counted inside a container is also a row in the same
  group. Rolling containers up from `asset_contained` (built over the RAW rows,
  which know nothing about grouping) broke that: a ship could report contents
  filed under a different location, reading 57B while the character header above
  it read 50B. The index now rolls up over its OWN rows, scoped to the group the
  container is displayed in. Checked against real data: 446 groups, 0
  mismatches — and `assertHeadersMatchRows` in the tests asserts it for every
  group of every fixture rather than trusting it holds.

  Three things worth knowing about how it got there:

  - **The index materialises the OUTPUT of `getCharacterAssets`, not a SQL
    rewrite of it.** Working out where an asset *is* means climbing a parent
    chain through containers and falling back through three global caches, with
    placeholder detection and a cycle guard. That code is correct and has been
    through several rounds of bugs; reimplementing it as a recursive CTE would
    have re-fought all of them. It runs once per sync (3.5 s for 90 characters)
    instead of on every filter change.
  - **A covering index is the whole difference.** Grouping by `loc_key` while
    summing `own_value` made SQLite walk `idx_ai_loc` and then fetch 100,000
    rows from the table to read the columns: 1,013 ms per keystroke. With
    `(loc_key, own_value, is_pi, search_blob)` it answers from the index alone —
    26 ms, and search went 1,028 ms → 47 ms.
  - **Per-row `await` was the rebuild cost, not the statement.** 100,000
    `stmt.run()` calls inside one transaction took 17 s; multi-row INSERTs sized
    from a bind budget took it to ~8 s, and dropping the indexes for the load
    took the rest.

- **Phase 3 — virtualised rendering. DONE (v3.0.1-dev).**
  The page keeps a flat MODEL of the rows it would show and builds only the
  slice inside the viewport, with two spacer rows carrying the height of
  everything above and below so the scrollbar stays honest.

  Measured on one real stockpile hangar, 4,938 rows:

  | | before | after |
  |---|---|---|
  | expand | 2,381 ms | **193 ms** |
  | table rows built | 5,144 | **28** |
  | frame latency | 153 ms | **6 ms** |
  | scroll deep into the list | — | **32 ms**, still ~30 rows |

  Two things fall out of the model rather than being special-cased:

  - **Collapsed containers cost nothing.** Their contents never enter the model,
    so they are not built. That alone was 4,063 of the 4,938 rows — four fifths
    of the old cost bought rows that were built and then hidden with
    `display:none`.
  - **Every row's y position is known before anything renders**, so jumping to a
    scroll offset is a binary search over prefix sums rather than a layout of
    everything above it.

  `GROUP_ITEM_CAP` went from 5,000 to **50,000**. It existed because the
  renderer built a row per item; with the DOM cost gone, what remains is the
  query and the model walk — measured on a 22,343-row hangar at 367 ms and
  28 ms. The old limit was truncating lists to avoid a cost that no longer
  exists.

  **The fixture had to be fixed first.** `seed-stress.js` promised "the shape
  that hurts, not just the row count" and then picked a random station per item,
  so the biggest hangar in a 100k profile was 129 rows and this whole phase was
  unexercised. It now takes a `concentrate` fraction that parks most of one
  character's items in a single station.

### Known complications

- ~~**Collapse state and "expand all"** assume every row exists in the DOM.~~
  **Done in Phase 2.** Expansion state now decides what is FETCHED, not just
  what is visible: `_assetGroupState` / `_assetCharState` drive the queries, and
  collapsing removes the rows. Ship and container fits are still a show/hide,
  because a character's whole hangar arrives in one query — that level is
  already in the DOM by the time it can be toggled.
- ~~**Price staleness** becomes visible in a way it is not today.~~
  **Done in Phase 2.** Every ISK figure is materialised, so `#assetPriceAge`
  says how old it is and turns amber past a day. Deliberately a label and not a
  button: prices refresh on their own (at launch, after each sync), and a
  refresh control in that toolbar would be pressed as though it reloaded the
  page — exactly how RESOLVE NAMES ended up being moved into Settings.
- ~~**The container roll-up must be rebuilt on every sync**, and a partial sync
  must not leave a half-rolled tree.~~
  **Done in Phase 2.** Both asset-write paths (`assets_ipc.syncAssetsInternal`
  and the full sync in `main.js`) call `notifyAssetsChanged`, which debounces
  20 s with a 3-minute ceiling so ninety characters coalesce into one rebuild
  rather than ninety. The rebuild is one transaction, so a partial one rolls
  back rather than leaving a half-rolled tree.
- ~~**Column resize / sort indicators** read the live table.~~
  **Not an issue after all.** Both read `<thead>`, which is always present and
  is not virtualised — only `<tbody>` rows are windowed. Checked rather than
  rewired.
- ~~**Virtualising means tracking expansion as data.**~~ **Done in Phase 3.**
  Expansion state is now the ONLY truth: `_assetEnsureOpenBranches()` fetches
  whatever the state says should be open and repaints, and both the click
  handlers and the post-sort re-render call it. The version before it had the
  click handler fetch for itself and bail if the render token had moved on, so
  clicking a location while a sort was still in flight set the state to open,
  aborted, and never repainted — state said open, model said closed, and the
  next click closed it again. The group simply would not open, intermittently.
- **The window is rebuilt, not recycled.** Each scroll frame replaces the ~30
  rows in `<tbody>` rather than repositioning existing nodes, so every row's
  `<img>` element is recreated. In practice the type icons come straight from
  the memory cache and scrolling measures at 32 ms, but on a cold cache a fast
  scroll will issue requests it need not. Recycling rows (keeping the nodes and
  rewriting their cells) is the refinement if that ever shows.
- **Row heights are constants** (`ASSET_ROW_H`, mirrored in `assets.css`). The
  list computes every offset from them, so a row that can render taller than its
  constant makes the whole list drift — rows land at the wrong y and the
  scrollbar lies — with nothing thrown. Item cells are clipped and an e2e test
  asserts every rendered row matches its constant. Adding a row type, or letting
  one wrap, means updating both.

- **Search is a substring LIKE**, which can never seek — it scans the covering
  index (61 ms at 100k with class data, acceptable). If that stops being enough,
  FTS5 with prefix tokens is the next step, but it changes the matching
  semantics from "contains" to "starts with", so it is a behaviour decision
  rather than a drop-in.

### Column alignment (fixed)

Reported as "the indenting is knocking the columns out of alignment". It was
not the indentation — measured, every column edge was already identical between
header and cell. Two unrelated faults:

- **`pages-characters.css` carries `.asset-table th, .asset-table td {
  text-align: left }`** for the Characters page's own table, which happens to
  share the class name. At 0,1,1 it outranked every per-cell rule in
  `assets.css` (0,1,0), so all ten cells rendered left while the headers stayed
  right via `.th-right` (0,2,0). Alignment is now declared once per column on
  `data-col-key`, scoped to `#assetTable` so an id selector puts it out of
  reach — text left, numbers right, header and cell from the same rule.
- **`ASSET_COL_DEFAULTS` had five entries for a ten-column table**, left behind
  when the extra columns were added. `_assetApplyColWidths` walks every `th`, so
  columns six to ten were set to `undefinedpx` — invalid, ignored. It also broke
  persistence outright: saved widths were length-checked against the same list,
  so any column a user resized was discarded on the next load.

An e2e test now asserts, for every column, that the header and the cell beneath
it resolve to the same `text-align` and that each column has a real width.

### Searching by ship class

The search column carries the SDE group and category as well as the item name,
so the box searches by CLASS, not just by name. Substring matching then gives
the hierarchy for nothing:

| typed | finds |
|---|---|
| `dreadnought` | every dread **and** every dread blueprint (group `Dreadnought Blueprint`) |
| `carrier` | Carriers, Supercarriers, and both blueprint groups |
| `supercarrier` | only the supers |
| `dreadnought blueprint` | only the prints |
| `blueprint` | everything in the Blueprint category |

Two things that are not obvious and are pinned by tests:

- **Plurals are stored per WORD, not per phrase.** Group names are singular and
  people type plurals. Appending an s to the phrase is not enough: a Nyx
  Blueprint is in `Supercarrier Blueprints`, so the phrase plural is
  "supercarrier blueprintss" and `supercarriers` still matches nothing. The s
  has to go on the word it belongs to.
- **`GROUP_ALIASES` holds only names that are NOT already substrings** of the
  group — `mothership`, `fax`, `hic`, `blops`, `pod`. `dread` already finds
  Dreadnought and `ceptor` already finds Interceptor, so aliases for those would
  be dead weight inside the covering index, paid for on every keystroke. A test
  asserts this and reports every violation at once; the version that stopped at
  the first failure hid that `recon` was redundant with `Force Recon Ship`.

### Reproduce

```bash
npm run stress:data     # 90 chars / 100k assets, builds the fixture
npm run stress:index    # data-layer timings: rebuild + every per-view query
npm run stress:render   # legacy render timings

STRESS=1 npx playwright test e2e/assets-stress.spec.js   # the real renderer
```

Fixture: `e2e/fixtures/seed-stress.js` — deterministic seed, real region and
system names, three-deep container nesting, weighted so a few characters hold
most of the items (the shape that hurts, not just the row count).

---

## Network rate — a governor, not good manners

**Status:** audited 2026-08-17 by enumerating every timer in the app. Not built.

### What is running today

18 `setInterval` timers. **Six of the fastest make no network request at all**,
which is worth knowing before anyone "fixes" them:

| timer | cadence | what it actually does |
|---|---|---|
| `src/intel/chatlog_reader.js:291` | 1 s | reads local EVE chat-log files off disk |
| `src/func/dashboard.js:3345` | 1 s | DOM countdown on industry-job cards |
| `src/func/fc_intel.js:203` | 2 s | `intelContacts()` — IPC to main, in-memory |
| `src/func/dashboard.js:1124` | 3 s | same, IPC only |
| `src/jabber_ipc.js:81` | 60 s | XMPP stanza on the already-open connection |
| `src/func/blueprints.js:2472` | 30 s | DOM re-render |

The ones that do reach the network, for a user with 20 characters:

| source | cadence | reqs/tick | sustained |
|---|---|---|---|
| mail unread (`src/func/mail.js:681`) | 30 s | **one per character**, `Promise.all` | **0.67/s** |
| fc poll (FC only, while tracking) | 6 s | 2 | 0.33/s |
| **`zkill_stream` catch-up** | **100 ms** | 1 | **10/s** |
| `zkill_stream` idle | 6 s | 1 | 0.17/s |
| eve status | 60 s | 1 | 0.02/s |
| trading / map / mining | 5 min | few | <0.05/s |
| kill_watch / ticker / FW | 10–30 min | few | negligible |

**Steady state is ~0.9 requests/second.** Nothing is near any plausible ceiling
**except `zkill_stream`**, which walks its sequence cursor at `STEP_MS = 100`
(10/s) whenever it falls behind, and which **bypasses the request broker
entirely** via its own `directGet`.

### Two structural gaps

1. `src/request_broker.js:46-47` caps **concurrency** (8 per host for ESI, 6
   default) but has **no requests-per-second limit at all**. Concurrency is not
   rate: 8 in flight against fast responses is far more than 8/s.
2. `zkill_stream` does not go through the broker, so even adding one there would
   not have covered the one feature that needed it.

### The number that actually matters

Rate limits are **per IP**, so 100k users never share a budget and nobody is
banned by someone else's traffic. That framing makes this look smaller than it
is. zKillboard's own information page describes their scale as *"serving
thousands of requests per minute."* 100k clients each polling at the stream's
**idle** cadence of one request per 6 seconds is **~16,700 requests/second —
a million per minute**, on the order of a thousand times their entire stated
traffic, from this app alone.

**Any design where every client independently polls a third-party free service
does not scale to 100k users, at any cadence.** ESI is different: CCP built it
for third-party apps, it is CDN-backed, and cache timers are published precisely
so clients can poll. There the constraint is the error budget (100 errors/60 s
per IP), not volume.

### Also worth recording

The comment in `src/intel/zkill_stream.js` asserts zKillboard "publishes a hard
limit of 15 requests per second per IP" with a one-hour ban. **That number is
not in their API wiki or their information page** — both state only "do not
hammer the server, be polite." It may be right from their Discord, but it is
currently a number we design against and cannot source. Treat it as unverified
and stay well under it regardless.

### The work

- [x] **Token bucket per host in `request_broker.js`. DONE.** A fourth mechanism
      beside the fresh-cache, single-flight and lane limits, because
      **concurrency is not rate**: a lane of 8 against fast responses was never
      a bound on requests/second. Shipped ceilings — `esi.evetech.net` 15/s
      burst 30 (burst sized to the measured 34-request page-open peak, so
      ordinary use is not taxed), `zkillboard.com` 1/s burst 3 (REST API, used
      once per op by the AAR), `r2z2.zkillboard.com` 2.5/s burst 5 (the live
      cursor, which must keep pace with the kill feed), default 5/s burst 10.
      `setRate()` / `resetRates()` allow tuning without a release. FIFO is
      preserved deliberately — a bucket that let new arrivals overtake the queue
      would never drain it under load.
- [x] **Bring `zkill_stream` under the governor. DONE — but not the way this
      item originally said.** "Route it through the broker" was wrong: the
      bypass is deliberate and documented at `src/intel/zkill_stream.js`, since
      every caching layer breaks that feed silently (a cached `sequence.json`
      means the cursor never advances and no killmail ever arrives again, while
      the loop keeps reporting itself healthy). It needed the rate gate WITHOUT
      the caching, so the broker now exports `reserve(url)` — take a token, skip
      everything else — and `directGet` awaits it.
- [x] **Slow the stream. DONE.** `STEP_MS` 100 → 400 ms (10/s → 2.5/s),
      `IDLE_MS` 6 s → 15 s, `MAX_CATCHUP` 200 → 50 (200 steps at 400 ms would be
      80 s spent catching up to kills already outside the relevance window).
      The old 100 ms was justified by a comment citing a 15/s zKillboard ceiling
      that **is not in their documentation** — the test asserting it has been
      corrected to state what we actually know.

  One property worth knowing before touching the bucket: its timers are
  `unref`'d so a backlog of throttled polls cannot delay app quit. Verified
  consequence — if nothing else holds the event loop, the process exits and a
  queued promise **never settles**, rather than rejecting. Fine in Electron
  main, visible in bare `node` probes. Do not await a broker call from a
  shutdown path.
- [x] **Confirmed what the governor actually covers**, by enumerating every file
      making direct `https.request`/`https.get` calls rather than assuming.
      Eight do; six are legitimately outside it and should stay there:
      `accounts_ipc.js` is the OAuth **POST** (POSTs are never brokered),
      `net_log.js` only instruments other callers, and `sde_fetch.js` /
      `resfile.js` pull large static files from CCP's own CDNs. The two that
      matter are in: `main.js:2760`'s `httpGet` wraps `requestBroker.get()` with
      the raw transport as its `perform`, so **every ESI GET passes the
      governor** — including `locator.js`, which takes that same `httpGet`
      injected rather than rolling its own — and `zkill_stream` now takes a
      token via `reserve()`.
- [ ] **Fan the stream out through our own Worker** (we already run Cloudflare
      for presence). One consumer instead of 100,000. This is the only version
      of live intel that survives the growth target. **Still the real fix** —
      everything above bounds one client; nothing above changes the arithmetic
      that 100k clients polling a volunteer-run service is ~1000x their traffic.

      **WRITTEN, NOT DEPLOYED** — `workers/zkill-fanout/`. It mirrors the two
      upstream routes exactly (`/ephemeral/sequence.json`,
      `/ephemeral/<id>.json`), so the client needs no protocol change and can be
      pointed back at zKillboard by unsetting one variable; a bespoke protocol
      would have made the Worker a hard dependency instead of an optimisation.
      The fan-out works because every client walks the SAME cursor and therefore
      requests identical URLs, so edge caching collapses them onto one upstream
      fetch. The sequence — the only moving part — is refreshed at most once
      every 5s no matter how many clients ask, and that number does not grow
      with users. It is not an open proxy: any other path 404s.

      Remaining, and it needs a Cloudflare account rather than code:
      `npx wrangler deploy`, then set `EVE_CARBON_ZKILL_BASE` and watch the
      Worker's request count stay flat as clients are added. **Only once it is
      proven under real traffic**, change the fallback in `resolveZkillBase()`
      so it helps every user — a default pointing at a Worker that does not
      exist takes the intel feed down for everyone at once. Until then it is
      opt-in and nothing changes for anybody.
- [x] **Stagger the mail poll. DONE.** It was `Promise.all` over every account
      each 30s — the largest single burst the app makes, and the largest
      steady-state contributor at ~0.67 req/s for 20 characters. Concurrency
      limits did not help: the broker's lane bounds how many are IN FLIGHT, not
      how many start per second. The walk is now sequential with a gap sized so
      it always finishes inside its own window (the gap shrinks as characters
      are added; 90 characters still fit), and a busy guard stops a slow walk
      being overlapped by the next tick.

      It also backs off to 5 minutes when the window is hidden OR unfocused,
      and polls immediately on coming back — nobody can read the badge when the
      window is behind something, so full-cadence polling there bought nothing
      and cost the most. `test/mail_poll.test.js` pins both, and the stagger was
      verified by mutation: restoring `Promise.all` fails the spread test.
- [x] **Back the FC poll off to ~30 s when not in a fleet. DONE** — shipped with
      Fleet Tracker Phase 1 (9440af7), which is why that section ticked it while
      this one went stale. `FC_IDLE_POLL_MS` in `src/func/fc.js`: the not-in-fleet
      branch calls `_fcSetCadence(FC_IDLE_POLL_MS)` and the in-fleet branch
      restores 6 s, so it recovers on rejoining rather than staying slow.

      It shipped with no test, so nothing stopped a refactor from quietly putting
      it back to 6 s. `test/fc_poll_cadence.test.js` now pins it, and asserts the
      RE-ARMED INTERVAL rather than the variable — `_fcSetCadence` returns early
      when the value is unchanged, so a version that assigns without restarting
      the timer reports 30 s while still polling every 6 s. Verified by mutation:
      removing the backoff fails 2 tests, and dropping only the timer restart
      fails the one assertion written for it.

---

## Fleet Tracker — ops, movement, kills and the AAR

**Status:** ESI surface verified 2026-08-17 against `esi.evetech.net/meta/openapi.json`
(204 paths, offline diff — no route-by-route probing). Not built.

Rename **Fleet Composition → Fleet Tracker**: it already tracks more than
composition. Change the display label only — the internal tab key is
`'composition'`, persisted to `localStorage.fcLastTab` (`src/func/fc.js:110`), so
renaming the key would break everyone's saved last-tab on upgrade.

### What ESI's fleet endpoints actually contain — verified, so nobody re-checks

The complete fleet API is **14 routes and contains no combat data of any kind**.
It is a roster and org-chart API: no damage, no HP, no kills, no losses, in any
field of any route.

- `GET /characters/{id}/fleet` → `fleet_id, fleet_boss_id, role, wing_id, squad_id`
- `GET /fleets/{id}` → `motd, is_free_move, is_registered, is_voice_enabled`
- `GET /fleets/{id}/members` → `character_id, ship_type_id, solar_system_id,
  station_id, wing_id, squad_id, role, role_name, join_time, takes_fleet_warp`
- `GET /fleets/{id}/wings` → `id, name, squads`
- 10 write routes: invite, kick, move member, create/delete/rename wing and squad.

**Two consequences that shape everything below:**

1. **`solar_system_id` is already in the roster payload** the poller fetches
   every 6 s (`src/func/fc.js:341`) and currently throws away. Movement history,
   ship swaps and join/leave times cost **zero new ESI calls and zero new
   scopes**.
2. **`fleet_boss_id`** lets us detect boss handover deliberately instead of
   eating a 403 and going blind.

### Kills and losses — where they actually come from

| route | coverage | scope |
|---|---|---|
| `/characters/{id}/killmails/recent` | that character's kills **and** losses, **90 days** | `esi-killmails.read_killmails.v1` — **not currently requested** |
| `/corporations/{id}/killmails/recent` | that corp's kills and losses, 90 days | `esi-killmails.read_corporation_killmails.v1` (director) |
| `/killmails/{id}/{hash}` | attackers, victim, items, system, time | **public, no scope** |
| `/universe/system_kills` | per-system counts, last hour, no attribution | public |

**The coverage is asymmetric, and this is the design constraint.** A killmail is
attributed to a corp if *any attacker* is a member — and a fleet kill carries a
dozen attackers, so the corp route picks up **most of the fleet's kills**. A loss
appears only if the *victim* is a member, so the same route shows **your corp's
losses and nobody else's**. In a multi-corp alliance fleet, that is blind to most
of what died.

Mechanics: the list routes return **only `killmail_id` and `killmail_hash`** — no
timestamp — so each needs a `/killmails/{id}/{hash}` fetch for detail. They
paginate by page number with **no time filter**. Killmail IDs *appear* to
increase monotonically, which would allow stopping early; **that is convention,
not guaranteed by the spec — verify it against real data before relying on it**,
or a report silently truncates.

ESI killmails carry **no ISK value** — that is zKillboard's own calculation. We
have pricing in `asset_valuation.js` / `appraisal.js` and can compute destroyed
value locally. It will differ from zKill's because the price basis differs, so
the AAR must state which basis it used.

### Mining — what is and is not possible

`/characters/{id}/mining` returns `date, solar_system_id, type_id, quantity`: a
**daily aggregate with no timestamp**, for characters we hold a token for only.
There is no ESI route that reports another pilot's mining. So a live fleet-wide
ore counter **cannot be built**. What can:

- **Own characters** — snapshot the ledger at op start, diff during and at close.
  Refreshes at the ledger's cache cadence, so a handful of updates in a long op,
  not live.
- **Corp-wide** — `/corporation/{corp_id}/mining/observers/{observer_id}` gives
  `character_id, type_id, quantity, last_updated` for *everyone* at that
  observer. The only fleet-wide mining data that exists. Needs director access
  and covers **moon drills and corp structures only** — not belt mining.

Label the scope on the table itself, so an alt-only total is never read as a
fleet total.

### Phase 1 — op lifecycle and movement

Zero new ESI calls, zero new scopes.

"Start Tracking" becomes "Start Op" (named: *Home Defence 17/08*, *Rorqual
Hunt*). New tables:

| table | holds |
|---|---|
| `fleet_ops` | id, name, doctrine, boss char, started/ended, notes |
| `fleet_op_roster` | op, character, ship_type, first_seen, last_seen |
| `fleet_op_movement` | op, ts, system, members_there, total_members |
| `fleet_op_kills` | op, killmail id+hash, ts, system, victim, ship, ISK, kill\|loss |
| `fleet_op_mining` | op, character, type, quantity delta, system, source |

**"Where the fleet is" is the modal system, not the boss's.** The FC is often not
where the fleet is. Each poll, take the mode across members; record a movement
entry only when it changes **and holds for 2–3 consecutive polls**, or a fleet
mid-warp across three systems writes noise. Store dwell time per system — that is
what makes the report readable ("held OWN-5GQ for 14 minutes").

- [x] Rename the tab label; leave the `'composition'` key alone. **DONE.**
- [x] Schema + migrations. **DONE** — `src/fleet_ops.js`. Reads
      `PRAGMA table_info` and ALTERs what is missing, rather than a
      hand-maintained list of ALTERs someone has to remember to append to.
      **Never DROPs**: `asset_index` answers a shape mismatch by dropping, which
      is right for a rebuildable cache and would be data loss here.
- [x] Op start/stop, persisted roster and movement from the existing poll.
      **DONE** — `src/ipc/fleet_ops_ipc.js`, wired through `preload.js` and
      `src/func/fc.js`. Zero new ESI calls: it records what the 6 s poll was
      already fetching and discarding.
- [x] Modal-system debounce + dwell time. **DONE.** Verified by mutation, not
      just by a green test: with the debounce removed, one gate crossing writes
      **3** movement entries showing the fleet bouncing back and forth. With it,
      zero. Ties break on lowest system id — arbitrary, but it must be
      deterministic or an even split would flap forever and never settle.
- [x] Boss-handover handling via `fleet_boss_id`. **DONE — the op ends and
      says why.** Keeping it open would have gone on recording a fleet whose
      roster we can no longer read, which is worse than stopping: the gap would
      later read as the fleet having sat still.
- [x] Not-in-fleet backoff. **DONE** — 6 s → 30 s while out of fleet.

  Two behaviours that came out of building it and are worth knowing before
  changing anything. **A recording op keeps polling off-page and across
  sub-tabs** — an FC checks a fit or the intel tab constantly mid-fleet, and an
  op that stopped collecting each time would have holes exactly where the
  interesting parts are. And **an op survives a restart but tracking does not**,
  so the page says so explicitly rather than showing an "End Op" button next to
  nothing actually recording.

  Also fixed in passing, since the new messages made it obvious: `_fcStopTracking()`
  set `'Stopped.'` *after* the caller's message, so every specific reason
  ("Only the fleet boss can read the roster") was overwritten with a bare
  "Stopped." — the one case where the user most needs telling why.

### Phase 2 — kills and losses, pulled once at op close

**No live stream.** At close, one bulk pull. A 3-hour fleet through 15 systems
costs ~15 requests once; the live-stream equivalent was ~1,800. Roughly 120×
less, and it captures every pilot in fleet rather than only your alts.

**ESI first, zKill as gap-filler:**

- **ESI** — corp + character killmails cover most kills and your own losses, on
  CCP infrastructure built for this, cacheable, and it scales to 100k users with
  no third-party courtesy problem.
- **zKill** — fills the gap: kills by fleet members in other corps, and losses by
  anyone outside yours. `GET /api/systemID/{id}/pastSeconds/{n}/` for each system
  in the movement timeline, then filter locally by roster and op window.
  Verified against their API docs: both filters valid, at least two modifiers
  required (these are two), `pastSeconds` must be a **multiple of 3600** and maxes
  at **7 days** — so an op must be closed within the week.

- [x] **Bulk pull at close. DONE** — `src/fleet_kills.js`, one request per system
      through the broker's 1/s zKillboard bucket.
- [x] **Include every system *seen*, not only debounce-stable ones. DONE** —
      `fleet_op_systems`, written undebounced on every poll. Proven rather than
      assumed: a fleet crossing a system in a single poll leaves it **absent
      from the movement log** but present in systems-seen, and the kill there is
      still found. Searching the movement log would have lost it silently.
- [x] **The `zkb` block gives ISK for free. DONE** — `totalValue`,
      `destroyedValue`, `droppedValue` and an `npc` flag come back inline,
      verified against the live API on 2026-08-17. No local valuation needed and
      no price-basis footnote: the number is zKillboard's own, which is the one
      an FC will compare the report against anyway.

  **Three items below turned out to be unnecessary, and the reason is worth
  recording so nobody re-adds them.** The plan assumed ESI would be the primary
  source and zKillboard the gap-filler. Probing the live API inverted that:
  `/api/systemID/{id}/pastSeconds/{n}/` returns the **full killmail inline** —
  `attackers[]`, `victim{}`, `killmail_time`, `solar_system_id` — plus `zkb`.
  ESI's routes return `{killmail_id, killmail_hash}` with **no timestamp**, so
  the ESI path needs a scope we do not request, covers only characters we hold
  tokens for, and then needs one extra fetch per killmail just to learn *when*
  it happened. One unauthenticated request per system beats it outright.

- [x] ~~Add `esi-killmails.read_killmails.v1`~~ **Not needed.** No new scope, no
      re-authentication for existing users, and it works for every pilot in
      fleet regardless of corp — not just the ones we have tokens for.
- [x] ~~Verify killmail-ID monotonicity~~ **Not needed** — that was only ever a
      trick for stopping ESI pagination early. `pastSeconds` bounds the window
      directly.
- [x] ~~Local ISK valuation from the item list~~ **Not needed** — `zkb` carries it.
- [ ] Recover an op if the app dies mid-fleet (within the 7-day window). The
      op itself survives (Phase 1 resumes it), but nothing yet re-pulls kills
      for an op that was closed while the network was down.

### Phase 3 — mining table and the After Action Report

Because movement and kills share timestamps and systems, the report can be
structured the way an FC actually narrates it:

```text
OWN-5GQ · 19:42–20:03 (21m)
  Kills   7   2.1B ISK    (Rorqual, 2× Hulk, 4× pod)
  Losses  5   340M ISK    (3× Sabre, 2× Malediction)
```

- [x] **Mining delta. DONE** — `src/fleet_mining.js`. A baseline is photographed
      at op start (`fleet_op_mining_baseline`) because the ledger is a **daily
      running total with no timestamp**: without the photograph there is no way,
      ever, to separate an op's yield from the rest of the pilot's day.
      Restricted to systems the fleet was actually in — verified end to end that
      an alt mining at home during the op is **excluded**, which is what stops a
      ratting alt inflating the haul.
- [x] **AAR generator. DONE** — `src/fleet_aar.js`. One model, three renderers,
      so a number cannot exist in one format and be missing from another.
- [x] **Markdown, BBCode and plain text; copy and save to file. DONE.** All
      three are built, so **the Goonfleet-forum question never needed
      answering** — the modal defaults to BBCode (most EVE alliance forums) and
      remembers the choice.
- [ ] **Corp mining observers** — the only fleet-WIDE mining source
      (`/corporation/{id}/mining/observers/{observer_id}`). Needs director
      access and covers moon drills and corp structures only, not belt mining,
      so it belongs with the corp tooling rather than here. The `source` column
      on `fleet_op_mining` already exists to hold it alongside `'ledger'`.

  **Three limits of the ESI route, not of this code, that the report states
  rather than hides.** There is no live ore counter for anyone — not even your
  own pilots. We can only see our own characters, so a 40-pilot mining fleet
  reports whatever fraction is signed into this app, and **the coverage caveat
  travels with every mining figure in all three formats** ("covers 3 of 41
  pilots"). And it is up to an hour behind, because ESI caches the route for
  3600s and `sync-mining-ledger` self-throttles to match — asking sooner returns
  identical bytes. Hence the pull being **re-runnable**: running it again later
  recomputes from the same baseline and corrects the numbers instead of adding
  to them.

### FC Testing — live validation with two accounts

**Everything in Phases 1-3 is verified against real SQLite, real payload shapes
and probed endpoints — but no real fleet has run through any of it.** These are
the things that cannot be tested from one desktop, parked deliberately rather
than left as an unstated assumption. To be done together, with two accounts
signed in.

#### Running the session

Everything needed is committed and ready; none of it has to be re-derived.

```bash
$env:EVE_CARBON_NET_LOG=1 ; npm run start   # app, with every request recorded
npm run watch:op                            # second terminal: live view of the op
```

`npm run watch:op` (`scripts/watch-fleet-op.js`) opens the app's database
**read-only** — the app holds one write connection in WAL mode — and prints the
op as it builds, marking pass-through systems that are correctly absent from the
movement narrative. `EVE_CARBON_NET_LOG=1` writes `net-log.csv` in the userData
folder, one row per request with millisecond timestamps, which is what confirms
the 6 s → 30 s not-in-fleet backoff and the rate governor actually behaving.

**Tranquility with Mia's own accounts is the right place for this.** Reading
your own fleet roster over ESI is exactly what the API is for, and forming a
fleet and passing boss is ordinary gameplay. The standing "don't test against
the real Goonfleet server" rule is about their **Jabber**, which none of this
touches.

#### The sequence

**Op 1 — movement, roster churn, kills, mining.** Form a fleet, Start Tracking,
Start Op. Fly **4-6 systems: sit still in two for a couple of minutes, pass
straight through two without stopping.** Mia writes down the actual route — that
is the ground truth; the app's record is what gets checked against it. Then the
second account joins mid-op, swaps hull, and leaves.

**Op 2 — boss handover.** Short, both accounts, pass boss A → B. Expect the op
to close by itself with `end_reason='boss-handover'` and say so on screen.

**The kill test needs a decision, because it costs a ship.** Recommended: in
low or null, A shoots B in a throwaway frigate. That is not arbitrary — it
produces a killmail with one of our pilots as victim AND another as attacker,
which is exactly the friendly-fire case that must score as a **loss, never a
kill**. It is the trickiest logic in Phase 2 and there is no other way to test
it for real. Cheaper fallbacks: die to an NPC (tests the loss path and the `npc`
flag, not friendly fire), or skip it and wait for a real fleet.

**Wait 2-5 minutes after any kill before closing the op** — zKillboard publishes
a killmail some minutes after the fact. If the report comes back short, the
**Refresh data** button in the report modal re-pulls kills and mining; both
pulls are idempotent, so re-running only ever corrects the numbers.

- [ ] **The boss-handover path has never executed against ESI.** The logic is a
      `fleet_boss_id` comparison between polls and it is unit-tested, but the
      branch has only ever run against synthetic data. Two accounts, form a
      fleet, pass boss, confirm the op closes with `end_reason='boss-handover'`
      and says so on screen.
- [ ] **`HOLD_POLLS = 3` is an estimate, not a measurement.** ~18 s at the 6 s
      cadence, chosen as "longer than a gate crossing, shorter than a real
      stop". Take a fleet through several gates and check the movement log
      against what actually happened — too low and one crossing writes phantom
      moves, too high and a genuine short stop is missed entirely.
- [ ] **Roster churn against a live fleet** — join late, leave early, refit
      mid-fleet, and confirm each shows up as expected (a refit should be a
      second roster row, not an overwrite).
- [ ] **The kill pull against a fleet that actually killed something.** Phase 2
      is verified against a probed live zKillboard response, but the roster
      matching has only seen fixtures. One real fight settles it.

### Complications

- **The roster is boss-only.** `/fleets/{id}/members` 403s for anyone who is not
  the fleet boss (`src/func/fc.js:343`). Op tracking works only for the FC. This
  also means fleet-tracking load scales with **concurrent fleets (hundreds)**,
  not users (100k).
- Long ops write a lot of movement rows — bound the retention.
- A member who joins late or leaves early needs roster-membership-over-time, not
  a final roster. The 6 s poll gives this naturally; the schema must keep it.

---

## Smaller things noticed in passing

- ~~**`prompt()` in `src/func/shopping-lists.js`**~~ **Fixed.** One in-app modal
  now serves both naming a new list and renaming one
  (`showShoppingListNameModal`). Worth recording what was actually measured,
  because the note here was wrong: Electron's `prompt()` does not return
  `undefined`, it **throws** `"prompt() is not supported"`, so the click handler
  died on that line and everything after it was skipped. `confirm()` IS
  implemented and shows a real dialog, which is why Clear and Delete were never
  affected and were left alone. No `prompt()` calls remain in the renderer.
- ~~**Dashboard blank-widget self-heal**~~ **Fixed.** It was not firing, and the
  reason was structural: `refreshDashboardLiveWidgets()` was called only *after*
  the stale-character sync loop in `autoRefreshStaleCharacters()`, so the
  `if (!stale.length) return` branch above it never reached the repair — and
  that is the branch a restart takes, when every character is still fresh from
  minutes ago. The widgets fail during the launch ESI burst; the repair then sat
  behind a condition that the failing case does not meet.

  Now `_healFailedDashboardWidgets()` runs on both paths, plus once 45 s after
  the dashboard loads, since the widgets fail *during* that load and a check
  that only runs on navigation is one the user has to trigger by wandering off
  and coming back. It is gated on a widget genuinely showing a failure
  (`.dash-widget-failed`, set on the six failure states) rather than firing
  unconditionally: `refreshDashboardLiveWidgets()` makes live per-character ESI
  calls, and running it on every navigation of a healthy dashboard would spend
  the shared error budget on nothing. A legitimately empty widget ("No active
  market orders") carries no marker and is left alone.
- ~~**Ping pop-up for structure alerts**~~ **Fixed** — `src/intel/ping_classify.js`,
  pinned by `test/ping_classify.test.js`. The note here understated it: the
  window is EXCLUSIVE (`createPingAlertWindow` closes the current alert to open
  the next), so a wave of structure alerts does not stack up windows, it
  DESTROYS whatever is on screen — during an attack that is the fleet ping the
  FC is waiting for. Suppressing structure alerts is what keeps a real ping up,
  not tidiness.

  Three faults, not one. `/director/i` tested the WHOLE JID, so a `director.*`
  domain or a `/director-console` resource was a fleet ping. It tested the body
  with no boundary, so a private message reading "ask the director when he's on"
  took the screen. And structure bots legitimately post FROM a director address,
  so the sender can never separate them — only the body can.

  Now: the JID's NODE is tokenised and matched, excluding the look-alikes
  (`directory`, `redirector`, `directions`) by name while still matching
  `director_bot` and `alliance-directors` — no boundary rule gets both, which is
  why it is a token list. A body-only match no longer pops for a 1:1 `chat`,
  only for a broadcast. Structure alerts are still stored, still shown in the
  panel and still flagged `is_director`; they just do not take the screen. An
  explicit fleet signal ("form up", "undock") BEATS structure suppression, so
  "Fortizar under attack — home defence fleet up" still pops.
- **XHTML-IM for Jabber rooms** — bold/italic currently send `*asterisk*`
  markers, which every client shows as typed. True rich text means XEP-0071 on
  both the send and receive paths, with a sanitised render.
