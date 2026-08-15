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
  Not yet wired into the post-sync path — the startup refresh covers staleness
  for now, and Phase 2 should trigger a rebuild when a sync completes.
- **Phase 2 — query per view.** Replace the load-all-and-filter-in-JS path.
  Kills the 100k-row array and makes sorting global and instant. Biggest
  user-visible win.
- **Phase 3 — virtualised rendering.** Only then is the DOM the limit.

### Known complications

- **Collapse state and "expand all"** currently assume every row exists in the
  DOM. Virtualising means tracking expansion as data, not as CSS.
- **Price staleness** becomes visible in a way it is not today. Needs a refresh
  policy and an honest "prices as of …" affordance.
- **The container roll-up must be rebuilt on every sync**, and a partial sync
  must not leave a half-rolled tree.
- **Column resize / sort indicators** read the live table; both need rewiring to
  a virtual list.

### Reproduce

```bash
npm run stress:data     # 90 chars / 100k assets, data-layer timings
npm run stress:render   # renders against it, render timings
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
