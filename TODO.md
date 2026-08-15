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

## Smaller things noticed in passing

- **`prompt()` in `src/func/shopping-lists.js:504`** — Electron has no
  `window.prompt()`; it returns `undefined`, so renaming a shopping list
  silently does nothing. Same bug as the Jabber add-room button, same fix (the
  in-app modal pattern already in that file at `showNewShoppingListModal`).
- **Dashboard blank-widget self-heal** — `refreshDashboardLiveWidgets()` exists
  to repair widgets that came back empty during the cold-start ESI burst. If
  blank widgets still need a manual refresh, that self-heal is not firing when
  it should.
- **Ping pop-up for structure alerts** — the pop-up fires on `isDirector`, which
  is `/director/i` against the sender JID and body. Structure-alert bots posting
  from a director JID would pop up as fleet pings. Worth checking during an
  attack wave.
- **XHTML-IM for Jabber rooms** — bold/italic currently send `*asterisk*`
  markers, which every client shows as typed. True rich text means XEP-0071 on
  both the send and receive paths, with a sanitised render.
