# TODO

Known work that is understood, measured, and deliberately not done yet. Each
entry says what the problem is, what it costs today, and how to reproduce it —
so picking one up does not start with re-deriving the diagnosis.

---

## Assets page hangs at real-user scale

**Status:** measured, not fixed. Reproducible on demand.

The Assets tree builds every row for every character in one synchronous pass.
At a real profile size — 90 characters, 100,000 items — that is ~110,000 `<tr>`
elements built in one go, which locks the window for the better part of a minute
and pays the same cost again on every sort.

Measured on 2026-08-12 (see `npm run stress:data` / `npm run stress:render`):

| | |
|---|---|
| assets in cache | 99,184 |
| first rows on screen | 27.1 s |
| tree settled | 44.6 s |
| DOM rows | 109,527 (99,184 items, 120 locations) |
| sort by price | 42.2 s, every click |

**The database is not the problem.** Reading all 99,184 rows across 90
characters takes 2.7 s, and the per-row cost is flat (0.0253 ms/row for the
largest hangar vs 0.0334 ms/row for the smallest), so the query is linear.
Roughly 42 of the 45 seconds is DOM construction.

`renderNextAssetChunk()` in `src/func/assets.js` is an empty function, with the
comment *"Keep this as a no-op — tree renders all at once, scroll is no longer
needed"*. Chunked rendering existed and was removed. That is fine at four assets
and fatal at a hundred thousand.

**Two approaches, smaller one first:**

1. **Collapse locations by default.** A 90-character profile would open as ~120
   group rows instead of 109,527. Cheap to do, and nobody reads 100k rows
   anyway. Probably gets most of the win.
2. **Windowed rendering.** Build only the visible slice and fill in on scroll.
   The complete fix, and a real redesign of the tree renderer — collapse state,
   sort, the container roll-up and the column resizer all assume every row
   exists in the DOM.

**Reproduce:**

```bash
npm run stress:data     # 90 chars / 100k assets, prints the data-layer timings
npm run stress:render   # renders against it, prints the render timings
```

The fixture generator is `e2e/fixtures/seed-stress.js` (deterministic seed, real
region/system names, three-deep container nesting, weighted so a few characters
hold most of the items — the shape that actually hurts, not just the row count).

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
