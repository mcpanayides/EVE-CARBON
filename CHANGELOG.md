# Changelog

All notable changes to EVE Carbon will be documented here.
Each release's GitHub notes are the matching `## [version]` section below —
the release workflow extracts the section for the tag being published.

## Marking a release critical

Because the release notes ARE this section, adding one line here is what turns
the in-app update prompt red, states the reason, and removes "Skip This
Version". Use it when running the old build actively costs the user something —
data loss, a security fix, a broken sync — not merely for a big release:

```markdown
> **CRITICAL UPDATE** — assets are lost when upgrading from 3.2
```

An invisible form is also accepted, for when the notes should not shout in
markdown but the app still should:

```markdown
<!-- eve-carbon:critical: assets are lost when upgrading from 3.2 -->
```

Whatever follows the marker becomes the reason shown to the user, so write it
for them rather than for the changelog. Only a line STARTING with the marker
counts — prose mentioning a "critical bug" further down does not trip it, which
is deliberate: a flag that fires on most releases stops being read.
See `test/updater_critical.test.js`.

---

## [3.7.0] - 2026-09-01

Two numbers this release were wrong in a way you could not see from inside the
app: the early-warning system measured every hostile's distance from a position
that stopped updating the moment you started watching, and a Nyx reported
551,507 less armour than the game gives it. Both were found by checking against
EVE itself rather than against another part of EVE Carbon, and both now
reconcile exactly.

### Fixed
- **The early-warning system measured from where you used to be.** Every jump
  count, ETA and alert is derived from the monitored character's position, and
  that position came from the stored ESI location — refreshed on a 30-minute
  stale gate, from the Dashboard, for the selected character only. Worse, the
  origins were resolved once when you ticked the box and never again, so once
  watching began the position was frozen for the whole session however long it
  ran. Jump a supercarrier to its ratting system and the tool went on warning
  you about the staging system you had left, with nothing on screen admitting
  it. Position now comes from EVE's own Local chat log — the client writes
  `Channel changed to Local : <system>` the instant you arrive — so it updates
  about a second after the gate flash, needs no scope, and covers alts that were
  never authenticated. Verified against 79 real logs rather than assumed.
- **Armour hitpoint rigs were stacking-penalised.** EVE does not penalise them.
  Three Capital Trimark Armor Pump IIs are 1.2 × 1.2 × 1.2 = 1.728, not the
  1.569 a penalised chain gives. Measured against a real Nyx — 3× CONCORD
  25000mm Steel Plates, full High-grade Amulet set, all skills V — the game
  reports 6,006,292 armour and EVE Carbon now reports 6,006,292.4. With both
  Armor Command Bursts running the game reports 6,997,330 and EVE Carbon
  reports 6,997,330.6. A unit test had been asserting the penalty, and passed
  for as long as the engine agreed with it.
- **The Defense panel described two different ships at once.** The resistance
  row was drawn from the command-burst-boosted numbers while the hitpoints and
  EHP beside it were the base ones, so under bursts the stated EHP did not
  follow from the stated hitpoints and resists. Resists now show the base value
  with the boost as a green delta, matching every other figure in the panel.
- **Locally saved fits came back with an empty cargo hold.** Cargo was written
  into the saved fit and then left out of the call that restored it.
- **The monitored-characters dropdown was see-through.** It painted with the
  modal background token, which is tuned for a dialog that always has a dimming
  backdrop behind it; this one floats directly over the contact list, so under
  the glass theme it rendered at 55% opacity with no blur at all. The fitting
  pickers and the bay panels had the same problem over the ship render.
- **The implants panel showed nine of its ten sockets.**

### Added
- **Clones.** A named implant set you put on and take off, the way a jump clone
  works in game. Fits have always stored their implants, which is right for
  reopening one fit and wrong for comparing two — loading the shield version
  wiped the implants the armour version was saved with. A clone is stored
  separately from any fit and outranks a fit's own implants while worn, so you
  can swap hulls around a fixed set of implants. **Your real clones come along
  free**: the app already syncs your active implants and every jump clone with
  its contents, so they can be worn or saved directly, with no extra ESI call.
- **One picker for implants, cargo and fighter squadrons**, on the same dialog
  as Import from Game. Each bay used to carry its own inline search whose
  results dropped on top of the list they were being added to — searching
  "high" for an implant covered all ten sockets. Every row now states what will
  happen before you click it: which slot an implant takes and what it replaces,
  how many more of an item the hold has room for, which tube a squadron loads
  into and how much of it fits. A row that cannot be used is disabled and names
  the limit stopping it.
- **The fighter bay has a way in.** Its chip was inert — the only route to a
  squadron was dragging one onto a tube wedge.
- **Where a character's position came from is shown**, and how fresh it is:
  `LIVE` when it is read from the game log as you jump, `ESI 24m` when it is a
  fallback, `logged off` when the client is not running.

### Changed
- **The monitored-characters list updates while you watch.** A jump is pushed to
  the page rather than polled, and says what moved where.
- **`fit-search` returns volume, category, implant slot and squadron size** with
  each result, so a picker can describe a row without a second round-trip per
  result.

## [3.6.0] - 2026-08-22

The fitting simulator was wrong, and in places badly wrong — a bastioned
Marauder read at half its real damage and a sieged Dreadnought at roughly a
ninth. Every number below was checked against the game rather than against
another tool. The map also now draws the same galaxy on every install.

### Fixed
- **Bastion, Siege, Triage and Industrial Cores did nothing.** None of them were
  modelled, so the module that defines how a Marauder or Dreadnought fights was
  simply absent from the simulation. Bastion halves the turret cycle (×2 damage);
  Siege multiplies turret damage by 9.4. Their resistance, repair, sensor and
  immobilising effects now apply too — all read from the module's own dogma
  attributes, so faction variants and any future re-tune are picked up without a
  code change.
- **T2 specialization skills were dropped.** A T2 gun requires its size skill AND
  a specialization; only the first was applied, silently losing ~10% of the
  damage of every T2 turret in the game. Launcher specializations lost their
  rate-of-fire bonus the same way.
- **Weapon damage and rate-of-fire rigs contributed nothing.** Burst Aerators and
  Collision Accelerators were excluded from the damage path — about 18% of the
  DPS of any fit carrying one.
- **Armour and shield hitpoint rigs contributed nothing**, so Trimarks and Core
  Defence Field Extenders never reached EHP.
- **Drones were about a quarter light**, missing their size and specialization
  skills. **Fighters were worse** — squadrons flew on raw attributes with no
  skills and no carrier hull bonus at all, so a Revenant's two racial bonuses
  counted for nothing.
- **Fighter Support Units were unread**, along with their rate-of-fire bonus.
- **Smartbombs were left out of Offence**, and a **Nosferatu counted as nothing**
  when it is one of the largest capacitor sources on a fit.
- **Micro Jump Drives were charged 16× too much capacitor** — every 12s rather
  than once per 192s duty cycle — and their signature bloom was missing.
- **42.7% of every per-level hull trait in the game was silently discarded**
  (now 35.1%). Capital hitpoint bonuses worth up to 500%, capacitor-use bonuses
  on 93 hulls, inertia, signature and cargo traits all now apply.
- **Two command-burst magnitudes were transposed**, leaving targeting range and
  scan resolution wrong in opposite directions.
- **The curated map layout only existed on one machine.** It lived in a local
  user-data file, so every other install fell back to the algorithm and drew a
  noticeably more spread-out galaxy. It now ships with the app.
- **Regional gateway boxes could be drawn on top of each other** — two gateways
  looking like one, at every zoom level. Gateway placement now reserves the room
  the box actually occupies, without moving a single system.
- **The map's system search was clipped by the page header**, so its results
  list was cut off after the first row.

### Added
- **A cargo hold you can load.** Search or drag anything aboard — modules,
  charges, drones, deployables — to carry a field refit. Volume is tracked
  against the real hold, and the fit round-trips through EFT with its cargo.
  Cargo is weight only and never counts toward damage or tank.
- **Cargo capacity is simulated**: hauler traits, Expanded Cargoholds and
  Cargohold Optimization rigs, including the expander's velocity cost.
- **Saved fits can be deleted**, and in-game fits can be removed from EVE Carbon
  without touching the game — with a way to restore them.

### Changed
- **Boosted stats read `base + boost [combined]`.** Previously only the base and
  the boost were shown, leaving the reader to add them up.
- **"Save to Game" is now "Copy to Clipboard".** EVE imports EFT from the
  clipboard, which is how every other fitting tool hands a fit over, and it
  carries the cargo hold. The ESI write path and its
  `esi-fittings.write_fittings.v1` scope have been removed — the app no longer
  asks for write access to your in-game fittings.

## [3.5.0] - 2026-08-19

Fleet ops get a record and an after-action report, the demo profile now fills
every page, and eleven gas type IDs that were quietly pricing the wrong item are
fixed.

### Added
- **Fleet Tracker records an op.** Start an op alongside fleet tracking and it
  keeps the roster over time, the fleet's movement, the systems it passed
  through, its kills and losses, and its mining — then renders an after-action
  report you can paste straight into a forum post as Markdown, BBCode or text.
  Movement is debounced so gate crossings do not fill the narrative, kills are
  pulled once at the end rather than streamed, and friendly fire scores as a
  loss instead of being counted twice.
- **Op History.** Every past op with its pilots, systems, kills and ISK, and its
  report — reachable after the fleet is over. Previously the report existed only
  inside the live tracking flow, so closing the app put it out of reach.
- **An op closes itself when the FC hands over boss**, ending the record with a
  reason rather than simply going blind.
- **A screenshot pipeline.** `npm run shots` walks all 44 screens in demo mode
  and writes the published image set. Screenshots no longer ship inside the
  installer.

### Changed
- **The demo profile now populates every page**, not just the ones reading from
  disk. Mail, notifications, calendar, killboard, skill queue, market orders,
  industry jobs and early warning all render invented data, so the app can be
  demonstrated without exposing a real account's assets or killboard.
- **Outbound requests are rate-governed per host.** A token bucket paces ESI at
  15/s and zKillboard at 1/s, and the live kill stream backs off from a 100 ms
  step to 400 ms — it is somebody else's free server.
- **Confirmations use the app's own dialog** rather than the operating system's
  grey box, and destructive ones are red with Cancel focused.
- Type icons in list rows are no longer boxed, and the ambient background
  gradient is gone — it cost 130-210% CPU in the GPU process for something the
  glass blur had already hidden.

### Fixed
- **Eleven of the twenty-six gas types were priced as the wrong item.** Prices
  are fetched by type ID, so a wrong ID never errored — Malachite Cytoserocin
  was valued as "The Red Card", Hiemal Tricarboxyl Vapor as an ore, and four
  Mykoserocins pointed at unpublished booster formulas. Only the last group
  looked broken; the rest showed a plausible icon and a plausible, wrong price.
  All four ore/ice/gas/moon tables now verify against the bundled SDE.
- **Eight ice names were years out of date.** Thick Blue Ice, Pristine White
  Glaze, Smooth Glacial Mass and Enriched Clear Icicle were renamed by CCP to
  the "IV-Grade" convention; the ore-hold screen already used the new names, so
  the app disagreed with itself.
- **The online counter under-reported.** Sessions were held in memory by a
  Durable Object that Cloudflare evicts after about 15 seconds, so three clients
  each saw only themselves. The tooltip now also breaks the count down by
  platform.
- **ME and TE bars ignored custom palettes.** EVE's efficiency colours were
  typed into four rules rather than bound to tokens, so a user palette
  recoloured everything around the bars and left the bars behind.
- Settings panels no longer get clipped when the window is not maximised — the
  drawer body guessed at its own height and tall tabs had no way to scroll.
- 197 dead CSS selectors and 6 unused tokens removed.

## [3.4.0] - 2026-08-16

> **CRITICAL UPDATE** — fixes a security flaw in the SDE updater that let a
> tampered download write files outside its folder

A security release, plus the online-user counter finally working in installed
builds and a fix for renaming shopping lists.

### Security
- **The SDE updater could be made to write anywhere on your disk.** The zip
  library it used (`extract-zip`) creates symlink entries from an archive
  without checking where they point, so an archive that had been tampered with
  in transit could place files outside the extraction folder — with whatever
  access the app has. There is no fixed version of that library, so it has been
  removed entirely and replaced with extraction that refuses symlinks, absolute
  paths and anything climbing out of the target directory. (CVE-2026-56876)
- **Cache keys no longer use SHA-1.** ESI responses are cached per character
  using a hash of the access token. Two characters colliding on that hash would
  have meant one pilot briefly seeing another's data; the hash is now SHA-256 at
  twice the width.
- Text from the mining and fitting pages is escaped before it reaches the page,
  closing two cross-site-scripting paths reported by code scanning.
- Release builds now run with least-privilege permissions.

### Fixed
- **Renaming a shopping list did nothing.** The rename button called a browser
  dialog Electron does not implement — it throws rather than returning empty, so
  the click handler died silently. Both creating and renaming a list now use the
  same in-app dialog.
- **Blank dashboard widgets repair themselves again.** The repair pass only ran
  after a character sync, so on the common case — a restart where everything is
  already up to date — it was skipped entirely and widgets that failed during
  startup stayed blank until removed and re-added. It now runs 45 seconds after
  the dashboard loads and whenever a sync finishes, and only re-fetches widgets
  that actually failed.
- **The "N online" counter works in installed builds.** It has never appeared in
  a released version — the address it reports to was empty in every build, so
  the feature disabled itself silently. Hovering the counter now also shows
  which versions people are running.

### Changed
- **Critical releases now look like it.** An update that costs you something to
  postpone shows a red banner stating why, and does not offer "Skip This
  Version". Ordinary updates are unchanged.
- Every ESI request now uses CCP's current unversioned routes with a pinned
  compatibility date. The old versioned routes still work but are undocumented
  and outside that contract, so they were removed before CCP retires them.

## [3.3.0] - 2026-08-15
The Assets page is rebuilt from the database up. It used to load every asset of
every character into the browser, build a table row for each one, and work out
prices afterwards — which on a large account meant about forty-five seconds
before anything appeared, and another forty every time you clicked a column.
Value now lives in the database, the page asks only for what is on screen, and
it builds only the rows inside the window.

Measured on a 90-character, 100,000-item profile:

| | before | after |
|---|---|---|
| page opens | ~42 s | **2.9 s** |
| table rows held | ~100,000 | **120** |
| sort by value | 42 s, every click | **under ½ s** |
| open a 5,000-item hangar | 2.4 s | **0.2 s** |
| search | re-filter everything in the browser | **~0.3 s** |

### Assets
- **Sorting by value now ranks everything you own.** Previously it could only
  order what had already loaded, so a Titan sitting in the ninetieth hangar
  never reached the top. The database ranks every row, and the page shows the
  top of that ordering.
- **Containers are worth what is inside them.** An Asset Safety Wrap's own type
  is worth nothing while it holds a billion ISK of modules — which is exactly
  the number you need to decide whether to pay to get it back. Ships, wraps and
  freight containers now show their contents' value, with a breakdown on hover.
- **Station and character totals match the rows beneath them.** A ship could
  report 57B while the character heading it read 50B, because the two counted
  different things. Verified against real data across 446 groups.
- **Search works by ship class, not just by name.** "Dreadnought" finds every
  dread and every dread blueprint; "carrier" finds carriers, supercarriers and
  their blueprints; "supercarrier" finds only the supers. Plurals work, and so
  do the names the game does not use — mothership, fax, hic, blops, rorq, pod.
- **Columns line up.** Text left, numbers right, headers reading the same way as
  the cells under them. Column widths are applied to every column and a width
  you drag is remembered again — the saved list was being discarded on reload.
- **Prices say how old they are.** Every figure is stored rather than fetched
  while you look at it, so the toolbar states when they were last refreshed and
  warns once they are over a day old. They refresh on their own, after launch
  and after each sync.
- **Assets no longer go missing.** Asset syncing stopped early whenever a page
  came back with fewer items than expected, silently dropping everything after
  it — which is how a supercarrier disappeared from a hangar while the rest of
  the character synced normally.
- **Prices survive a restart** and no longer vanish and reload every time the
  page is opened.

### Under it
- Asset value is materialised into the database with a tiered resolution: CCP's
  reference prices as a baseline for everything, real Jita prices for the types
  that actually carry the value, and explicit values for capital hulls that have
  no open market and that every price source misreports.
- The valuation rebuilds itself after a sync, coalescing a ninety-character sync
  into one rebuild rather than ninety, and builds into staging tables so the
  page never catches it mid-rebuild.

## [3.0.0] - 2026-08-12
Jabber becomes a real chat client, the dashboard gets a kill ticker and honest
resizing, and two installer/database faults that only ever showed up in shipped
builds are fixed.

### Jabber
- **Chat rooms.** A rooms rail beside the broadcast feed: join rooms, read them,
  and talk back. Unread badges count how many *people* have spoken since you last
  looked, not how many messages — one person posting forty lines is not forty
  things to catch up on. Read state lives in the database, so it survives a
  restart.
- **Find rooms.** Service discovery (XEP-0030) against your conference server,
  which is offered as `conference.<your domain>` and stays editable. Name and
  description columns, a filter once a server returns more than a dozen, and
  double-click to join — instead of having to know a room's exact address.
- **Room history.** Archived messages are fetched with MAM (XEP-0313), paged
  backwards from the oldest message held, deduplicated by archive id so a re-pull
  never doubles a room, and dated by when they were *sent*. The MAM namespace is
  negotiated per room, so a server that answers "bad-request" is now reported as
  "this room keeps no archive" rather than as a dead button.
- **Room subject and occupants.** The MOTD banner under the room title with its
  links live, and the occupant roster on the right, ranked by affiliation then
  role. Composer gains emoji, a link builder and formatting.
- **The broadcast feed is broadcasts again.** Room chat was reaching it two ways:
  messages were classified as room chat only if this app had joined the room, and
  the feed's history query had no filter at all. Now routed by stanza type and
  read with `room_jid IS NULL`. A Broadcasts / Alerts / All filter separates
  structure-alert bots from fleet pings.

### Dashboard
- **Top Kills ticker** — a full-width marquee of your most valuable kills over 90
  days, roster-wide or per character, from the same cached zKillboard feed the
  Killboard page uses.
- **Widgets ask what to show when you add them.** Character Wallet, Job Watch and
  Top Kills pick their subject in the add menu rather than carrying a dropdown
  forever in a tile that has no room for one.
- **Widgets resize honestly.** Content compacts through seven measured steps
  instead of being cut off: media shrinks first, then secondary lines, and the
  one fact a widget exists for is the last thing to go. The Active Jobs table
  drops columns by priority rather than scrolling ACTIVITY and PROGRESS off the
  right edge.
- **Latest Ping** now matches the pop-out layout section for section, with the
  formup, comms and doctrine links actually clickable.
- A refresh control beside the ✕, and an unread mail badge that is correct before
  you ever open the Mail page.

### Fixed
- **All-users installs.** `character_information.db` was created inside the
  install directory, which works for a per-user install and fails completely for
  an all-users one — Program Files is not writable and SQLite cannot create its
  WAL sidecar. It also meant every Windows account shared one set of characters,
  and that an update deleted the database. Now in `userData`, with a one-time
  migration that brings an existing database across.
- **Upgrading an existing Jabber database.** The room columns were indexed in the
  same batch that created the table, so on any database that predated chat rooms
  the batch aborted with "no such column: room_jid" and the migration below it
  never ran. Order is now tables → columns → indexes.
- Asset containers are priced by their contents — an Asset Safety Wrap showed
  N/A while holding a fortune. Numeric sorts now order the station and character
  groups too, not just the items inside them.
- Mail and Killboard default to All characters and remember the choice.
- The presence heartbeat says why it is off instead of silently disabling itself,
  and a release build with an empty `PRESENCE_URL` secret is now flagged in CI.

### Testing
- A stress fixture at real-user scale — 90 characters, 100,000 assets, nested
  containers — plus `npm run stress:data` and `npm run stress:render`. It found a
  45-second Assets render on its first run; see TODO.md.
- `e2e/widget-fit.spec.js` measures widget content fit at every size and asserts
  no widget hides content.
- 315 unit tests, 89 e2e.

---

## [2.0.0] - 2026-08-05
Early Warning: a full intel system that reads your in-game channels and tells you
what is coming, how far out, and how long you have. Plus a rebuilt ESI client
after a review from CCP developer relations, and a Fuzzwork fix after their
operator got in touch.

Major, because how the app talks to every external service changed.

### Added
- **Early Warning (Fleet Commander → Early Warning).** Reads your intel channels
  and tracks each contact's distance OVER TIME, so it can tell a gang closing on
  you from one ratting five jumps away. Built for the case where reacting late is
  fatal — barges sieged in a belt need 60–120 seconds to break, align and go.
  Validated against 12 023 real intel messages.
  - **Jumps lead, ETA follows.** Distance comes from the stargate graph and is
    exact; time is inferred from the contact's observed speed, so it is shown as
    "~2m" and dimmed further when that speed has not been measured yet.
  - **Track and trace.** A gang reported by four people across three channels is
    ONE contact, keyed on its membership so the row follows it from gate to gate
    rather than becoming a new contact in every system.
  - **Gang sizing** — solo / gang / large / fleet, with an optional sound above a
    size you choose.
  - **Custom alerts** — watchlist pilots, hulls, threat roles, gang size, bubbles,
    "only when closing", and contact-sheet standings ("a −10 within 8 jumps").
  - **Patterns** — which gates hostiles habitually come through and what hour they
    turn up, and it says nothing until there is enough history to mean something.
  - **Resumes after a restart** by replaying the last five minutes of the log, so
    a relaunch mid-op does not start blind. The replay itself never alerts.
  - **Live killmails (optional)** from zKillboard, which work with EVE closed.
  - Floating pop-out and a dashboard widget, sharing one row layout.
- **Diagnostic log (Settings → General).** Off by default. Records what the app
  does to a file so a bug report can carry evidence. Access tokens, sign-in codes
  and your user folder are stripped BEFORE anything is written, so the file is
  safe to attach — and the bug reporter shows you exactly what will be sent.
- **Demo Mode (Settings → General)** — a separate, fully-populated example profile
  for screenshots and walkthroughs. Your real data is untouched.

### Changed
- **One ESI client.** `ESI_BASE` was declared in eight files with full URLs
  hard-coded in a dozen more; there is now a single definition in
  `src/shared/esi.js` used by every window.
- **Versioned ESI routes are gone.** All 90 `/vN/` calls now use unversioned paths
  with `X-Compatibility-Date`, per CCP's guidance — new ESI routes are
  unversioned-only, so this stops a slow-motion breakage. Verified offline against
  ESI's OpenAPI spec rather than by probing.
- **Colour palette named for the job, not the hue** — Negative, Positive, Caution,
  Contested, Info, Liquid, Assets, Series 1–2 — each with a note on what it drives.
  Three swatches that were wired to nothing are gone.
- **Operational signals are no longer themeable.** The Beehive stand-down light was
  wired to the palette, so recolouring "losses" recoloured STAND DOWN with it.
- **Settings → Background is now "Wallpaper and Colour"**, and Panel opacity is a
  single control that works with glass on or off.

### Fixed
- **Fuzzwork 404 flood.** Every blueprint lookup called a path that does not exist,
  and because Fuzzwork sits behind the local SDE the failure was invisible to us
  while generating a 404 per blueprint at a free service run by one person. The
  parameters were meaningless and the response shape was misread as well. Thanks to
  Steve for getting in touch. The NPC station sync had the same fault twice more
  and now reads from the local SDE — no network at all.
- **Blank Industry page when viewing a second blueprint.** A selector matched an
  inline style by substring; the browser rewrites that attribute the first time
  JavaScript touches it, after which the selector hid the entire page — sub-nav,
  back button and all. It read as a frozen window.
- **UI transparency slider did nothing** in the default configuration, because glass
  redefines the same tokens further down the cascade.
- **ESI error-budget drain.** Structure lookups ran two half-blind rate limiters
  that kept refilling each other's holes, and every queued request resumed in the
  same millisecond after a pause. Speculative lookups now stand down first.
- **Fleet position changes re-measure existing contacts** instead of comparing two
  different rulers.

### Removed
- The public ESI `/search/` endpoint, which CCP has retired and nothing called.

---

## [1.7.3] - 2026-08-02
Map legibility in empire space, three security patches, and a guard so a broken
build on `main` can't go unnoticed again.

### Fixes
- **Region maps no longer overlap their own system names in empire space.** The
  Modern per-region view sizes each name pill from the text it actually contains, and
  once the canvas font fix in 1.7.1 took effect those widths became real for the first
  time. The zoom floor was still the constant tuned for the old (silently ignored)
  font, so long empire names collided — The Forge opened with 16 pairs of pills sitting
  on top of each other. The floor is now measured from the widest label and the closest
  pair in the layout. Null-sec regions are unchanged; empire regions open slightly
  closer in and pan.

### Security
- **js-yaml 5.2.1 → 5.2.3** (high) — denial of service via exponential parsing of flow
  collections. Reached only by the one-time legacy YAML theme migration.
- **tar 7.5.20 → 7.5.22** (medium) — denial of service via uncontrolled recursion on
  crafted long-path archives.
- **brace-expansion 5.0.7 → 5.0.9** (high) — denial of service via unbounded expansion
  causing an out-of-memory crash.

  `npm audit` now reports zero vulnerabilities.

### Maintenance
- **A red CI run on `main` now opens an issue** with a link to the failing run, and
  closes it again once CI is green. A corrupted `postinstall` sat on `main` unnoticed
  through a whole release cycle and cost 1.7.1 its Windows installer; this makes that
  state impossible to miss.

## [1.7.2] - 2026-08-01
Ships the Windows build that 1.7.1 couldn't produce, and fixes the "Start with Windows"
switch. Everything in 1.7.1 (below) is included — if you're on Windows, this is the
1.7.1 release.

### Fixes
- **The Windows installer is back.** 1.7.1 published only the macOS `.dmg`: the
  `postinstall` script in `package.json` had a URL accidentally pasted into the middle
  of it (`electron-builder<url> install-app-deps`), so `npm install` failed on the
  runner. That took out the release pipeline's test gate, and the Windows build job —
  which waits on that gate — never started. The macOS job survived because a POSIX
  shell splits the mangled command on the URL's `&` characters and still exits 0, while
  `cmd.exe` fails outright.
- **"Start with Windows" no longer switches itself back off.** The toggle was writing
  the Windows Run-key entry correctly all along — the *read-back* was wrong. Electron's
  `getLoginItemSettings()` splits the registry value on spaces without honouring the
  quotes around the path, so on any profile whose path contains a space (`C:\Users\Mia
  Panayides\…`, i.e. most people) it failed to match its own entry and reported
  `openAtLogin: false`. Settings then set the switch to "what actually took effect" and
  it flipped straight back off. (`executableWillLaunchAtLogin` is no better — measured
  `true` even with the entry deleted outright.) The preference is now stored in
  `config.json` like Minimize to Tray, with the OS call as the effect rather than the
  source of truth.

## [1.7.1] - 2026-08-01
A galaxy-map release. Sovereignty data is flowing again after CCP retired the endpoint
it came from, there's a new **Influence** overlay that paints alliance territory as a
glowing field, and the per-region view has been rebuilt so a region actually fills the
screen instead of stacking into a narrow column.

### Fixes
- **Sovereignty and Friends & Foes were silently blank.** CCP removed
  `/v1/sovereignty/map/` and `/v1/sovereignty/structures/` in ESI's **2026-05-19**
  compatibility snapshot. Because the app pins a compatibility date, both routes began
  returning 404 and the map quietly fell back to empty sovereignty — so every system
  read as unclaimed, the Sovereignty overlay showed nothing, and Friends & Foes had
  nothing to colour even though your alliance standings were loading fine. Both now
  read from the replacement `/sovereignty/systems`. This also restores the dashboard's
  alliance-space incursion alert, which shares the same data, and the sovereignty
  labels on the Classic map.
- **Sovereignty now refreshes on the endpoint's own 5-minute cadence** instead of being
  held for an hour.

### Features
- **Influence overlay** (Map toolbar → **Influence**) — a Verite-style territory field.
  Every sov system emits influence for its holder, that influence travels outward along
  the gate graph decaying per jump, and the result is painted as interlocking hex tiles
  where the strongest holder takes each cell. Neighbouring tiles won by the same holder
  fuse into one contiguous shape, with a glow pass over the top.
  - **Territory titles** name the holder on their own ground — biggest at the galaxy
    overview, smaller as you zoom in, and only shown once a territory is large enough
    on screen to carry the name, so the overview stays readable.
  - Follows the active overlay: per-alliance colours normally, or your own standings
    (your teal, +5/+10 blues, −5/−10 hostiles) under Friends & Foes.
  - System dots take a lighter tint of the territory they sit in, so dots and ground
    agree; systems outside anyone's reach keep the overlay's own colour. Region names
    step aside while the field is up, since the titles answer the same question.
  - Available on the Classic and Modern galaxy views (not inside a single region,
    where a one-holder wash would say nothing).
- **Region view rebuilt.** Regions were laid out on a layered grid — graph depth on one
  axis, position-within-layer on the other — which turned a chain-shaped region into a
  ribbon tens of layers long and two or three wide, i.e. a narrow vertical stack down
  the middle of a wide canvas. Regions now use the same force layout the galaxy overview
  uses for its clusters, seeded from the systems' true positions, rotated so the
  region's long axis lies across the screen, and fitted on both axes. Insmother went
  from a 550×4400 ribbon to 1630×1110 — all 110 systems on screen and legible at once.
- **Jump Bridges system markers** now mark the endpoints of *your* imported Ansiblex
  network. They previously came from a public IHUB list that ESI has since removed —
  and post-Equinox that list would have meant "every sov system" anyway, because an
  alliance claim now *is* a sovereignty hub.

### Maintenance
- **Map page chrome** — toolbar icons are now Material Symbols in the shared 18px slot
  instead of emoji; the two route planners read as actions rather than layer toggles;
  every control has a visible focus ring, an accessible name and a state a screen
  reader can't disagree with; show/hide is a class rather than an inline style; and the
  spinner respects `prefers-reduced-motion`.
- **The galaxy can now fail visibly.** If the bundled Static Data Export can't be read
  the map explains what happened and offers *Try again* / *Open database settings*,
  instead of a spinner that turns forever.
- Removed the map's manual refresh button (live layers poll on their own ESI cadence).
- Alliance ticker and name now come back from one batched lookup instead of two.
- Retired the unused layered-grid region layout (81 lines) now that nothing consumes
  its positions.

## [1.7.0] - 2026-07-27
A major update: two brand-new top-level tools (Faction Warfare and Mining Ledger), a
rebuilt Finances suite with an LP-store optimiser and trading tools, a Station Checkout
for shopping lists, correct blueprint icons everywhere, and a fitting ship browser that
now mirrors the in-game market tree.

> **Re-authenticate your characters** (Characters page) after updating. This release
> adds three ESI scopes — `esi-industry.read_character_mining.v1`,
> `esi-industry.read_corporation_mining.v1` and `esi-characters.read_fw_stats.v1` —
> and the Mining Ledger and "My Militia" views stay empty until each character grants them.

### Features
- **Faction Warfare tracker** (new nav → Faction War). Five views built on public ESI:
  - **Warzone Control** — both warzones with a live control split and per-militia cards (systems held & %, control tier + LP multiplier, pilots, kills, victory points).
  - **Systems & Plexes** — every FW system with owner/occupier, contested/vulnerable status and a capture-progress bar; filter by warzone or contested-only.
  - **Leaderboards** — top pilots and corporations by kills or victory points, all-time or yesterday.
  - **My Militia** — your faction, rank, enlisted date, kills and VP (needs the FW scope).
  - **LP & Tiers** — the warzone-control tier ladder with live faction highlights and a plex-LP reference that scales to a chosen faction's current tier.
- **Mining Ledger** (Industry → Mining Ledger). Per-character and combined mining yield from ESI, valued as raw ore *or* refined minerals (reusing the ore-reprocessing math), with a daily-yield view and corp moon-extraction timers. Accumulates a longer local history than ESI's 30-day window, and refreshes automatically on the endpoint's cache cadence — no manual sync button.
- **Finances suite** (nav → Finances) rebuilt onto a left tools rail (like Industry):
  - **LP Store optimiser** — ranks a corporation's loyalty-store offers by ISK-per-LP on live Jita prices, with sortable/resizable columns and blueprint build-valuation.
  - **Trading tools** — **Undercut Alerts** (your active orders vs the best competing order at their own station, on buys *and* sells) with an opt-in background watcher that toasts you the moment a new order is undercut; **Per-Item P&L** (realised profit per item, average-cost); **Profit Over Time** (daily/weekly realised profit); and **vs Jita** (every sell order compared to Jita 4-4 — the former standalone Market page, folded in here).
- **Station Checkout** (Industry → Station Checkout). Cross-references a shopping list against what you already hold in a chosen NPC station, Upwell structure, or even a specific container, and lists exactly what's missing with a Jita buy-cost — then copy the shortfall to Multibuy or spin it into its own shopping list.
- **Jabber ping-alert sound** — an audible alert on incoming pings, configurable under Settings → Jabber with bundled presets and custom-file upload.
- **In-app notifications** — non-blocking corner toasts (e.g. undercut alerts) and a centered confirmation toast for actions like "copied to Multibuy", so clipboard/actions no longer confirm only in the status-bar log.

### Fixes
- **Blueprint icons** now render everywhere instead of showing broken images: originals use the BPO icon and copies use the BPC icon (different colours, matching the game) across the Assets list, My Blueprints library/detail/jobs, and the LP store. The Assets list also spells out "Blueprint Original" / "Blueprint Copy" instead of a bare "Blueprint".
- **Fitting ship browser** now groups hulls by the in-game **market tree** (SDE market groups) instead of inventory groups, so special-edition and Alliance-Tournament hulls file correctly — e.g. the Chremoas now sits under *Special Edition Ships → Special Edition Covert Ops*, not under Covert Ops. Group rows also carry icons.
- **New Shopping List** button now works — it opened a `window.prompt()`, which Electron doesn't support; replaced with an in-app modal.
- **Component tree → shopping list** — the tree now has its own "Add this breakdown" button that adds exactly the tier you're viewing (T1 / T2 / raw), separate from the detail view's "Add direct materials", so you no longer get base materials when you meant the T1 breakdown.
- **Send to Game** on a shopping list now shows a clear centered "copied to Multibuy" confirmation instead of confirming silently.
- The blueprint detail view now shows its controls and buttons instantly (they no longer wait on the Jita price fetch).
- **macOS (Apple Silicon) build now launches.** Previous `.dmg` builds installed but the app silently failed to open with no Gatekeeper prompt — an unsigned arm64 binary is killed outright by macOS. The build is now ad-hoc code-signed so it launches. On first run, right-click the app → **Open** (or run `xattr -dr com.apple.quarantine "/Applications/EVE-Carbon.app"`) to clear the download quarantine. (Full one-click launch needs a paid Apple Developer ID + notarization, which isn't set up yet.)

### Maintenance
- Retired the standalone **Market** nav page; its Jita-benchmark view lives on as the "vs Jita" tab inside Finances → Trading.
- Removed a stray probe image from the working tree; extended the automated end-to-end suite to cover the new tools (Faction Warfare, Mining Ledger, Trading, Station Checkout, shopping-list fixes and the fitting market-tree grouping).

## [1.6.1] - 2026-07-25
### Features
- **Skills page — multi-character skill planner** (nav → Skills). Build a plan once and cost it against every character you own, side by side, with the fastest highlighted. Includes:
  - An in-game-style skill browser: 24 skill groups you can expand, each skill showing your current level as pips and I–V buttons to add it at a target level — no need to know skill names.
  - **Plan by goal** — search for a ship (e.g. *Rifter*) and it adds every skill needed to fly it; prerequisites are expanded automatically in training order.
  - Accurate time-to-train using each character's real attributes and **active implants**.
  - **Optimal remap** — brute-forces every legal attribute allocation to find the fastest for a plan, showing the per-attribute change and time saved.
  - **Booster cost optimiser** — prices learning implants and cerebral accelerators at Jita and recommends the most cost-effective route *and* the outright fastest ("money no object"), with total ISK cost.
  - Import a character's live training queue as a plan; export as a Multibuy list (to buy the skillbooks in-game), plain text, or an EVEMon `.emp` file. (ESI's queue is read-only, so no tool can inject a plan into the game.)
- **Contracts browser** (Finances → Contracts) — browse a character's item-exchange, courier and auction contracts with type/status/expiry, reward/collateral/price, and an expandable per-contract item list (included vs requested, with BPC/ME/TE detail). Uses a scope that was already granted, so no re-authentication is needed.

### Maintenance
- Removed accidentally-committed Electron user-data from the repository (a stray profile copy with caches, storage and cookies), and added `.gitignore` rules so it can't recur. Note: it remains in older tagged history pending a separate history rewrite.
- Removed a batch of dead code with no home: two orphaned source files (`wallets.js`, `fleetup.js` — both unloaded and unreachable at runtime), 22 unused preload bridge methods, and 18 superseded IPC handlers. Verified against the full test suite plus a per-page smoke test — no functionality changed.

### Fixes
- The navigation menu now keeps **Dashboard** as the second item (directly under the character selection) after the Skills page was added.

---

## [1.6.0] - 2026-07-24
### Features
- **EVE Mail client** (nav → EVE Mail) — read, reply to and send in-game mail, with folders/labels, unread counts, mailing-list support and a composer that resolves characters, corporations, alliances and mailing lists by name. Mail is fetched live from ESI and never written to disk.
- **Notification feed** (EVE Mail → Notifications tab) — the in-game notification list (structure attacks, war decs, bills, moon extractions, insurance payouts) with category filters and readable, parsed detail for each notification. Read-only, as ESI provides no write route.
- **Bulk appraisal** (Industry → Appraisal) — paste a cargo hold, loot pile or contract and get an instant Jita valuation with per-item breakdown, Jita sell/buy/split totals, m³ volume, and a rate modifier for buyback offers. Handles EVE's paste formats and correctly keeps items whose names end in numbers (e.g. "Cap Booster 400") intact.
- **Killboard** (nav → Killboard) — recent kills and losses with all-time PvP stats (ships/ISK destroyed and lost, ISK efficiency, solo kills, danger ratio, rank), filters for kills/losses/solo, and click-through to zKillboard.
- **Combined killboard overviews** — the killboard source picker now offers *All Characters* and *All Corporations* alongside each individual character and corporation, merging every source's feed into one timeline and aggregating the stats.
- **EVE in-game nav icons** — the navigation menu now uses authentic EVE neocom icons for the game-domain pages, at a larger 28px size, with Material Symbols retained for app-utility items.

### Fixes
- **Fixed the dashboard banner's killboard/rank column being permanently blank.** zKillboard now 302-redirects its stats endpoint and our HTTP helper doesn't follow redirects, so the request silently returned nothing and the column just hid itself. Now requests the redirect target directly.
- Fixed the welcome banner's net-worth figure being able to stick on "Calculating…" — the value is now retained and applied whichever of the calculation or the banner paint finishes last, and a cold cache shows liquid ISK immediately instead of waiting on market prices.

---

## [1.5.0] - 2026-07-21
### Security
- Removed `EVE_CLIENT_SECRET` from the codebase and build entirely — the app's ESI login already uses PKCE and never sent it, but it was still being bundled in plaintext into every shipped installer. Rotated to a new EVE application/client ID as part of this.
- Fixed a critical archive-extraction path-traversal vulnerability (swapped the unmaintained `decompress` package for `extract-zip` in the SDE download pipeline).
- Fixed a ReDoS vulnerability in `brace-expansion` (pinned across the electron-builder toolchain) and a quadratic-CPU vulnerability in `js-yaml`.

### Fixes
- **Re-login is no longer silent or spammy** — a character whose EVE login has actually expired now shows a clear "⚠ RE-LOGIN NEEDED" badge on its card (click to re-authenticate) instead of every feature failing quietly in the background.
- **Fixed SSO tab-spam** — a bulk resync (RESYNC ALL, or the periodic auto-refresh) that hit several characters needing new ESI permissions at once used to pop a browser SSO tab for *each one*, faster than MFA could keep up. Now flagged with the same re-login badge instead of auto-launching anything.
- **Fixed removed characters silently reappearing** — a race between concurrent background token refreshes and a user's "remove account" click could resurrect a character moments after removal.
- **Fixed remove/sync/favourite buttons on character cards being unclickable** — a z-index tie with the card's own hatch-texture layer was silently swallowing clicks in the top corner of every character card.
- **Fixed the Jabber "Wipe Database" button reporting success while doing nothing** — two compounding bugs meant a wipe could silently no-op.
- **Fixed the updater always offering the Windows `.exe`, even on macOS** — it now picks the platform-appropriate installer asset (`.dmg` on Mac, `.AppImage` on Linux).
- Fixed SSO login failing with "redirect URL does not match" after the client rotation above.
- Added a "Delete All Characters" bulk option as a fallback alongside per-character removal.
- Notification toasts no longer stack up unreadably — they now write to the existing console log bar/history instead.

### Features
- **In-app Alliance Pack editor** (Settings → Jabber) — build or edit a pack's SIG/Squad groups and comms channels through a form, no YAML editing required.
- The character-card favourite star is now an exclusive "default character" toggle — only one character can be default at a time, and it's the one auto-selected on every launch.
- The "N ONLINE" anonymous presence counter is always on (removed the opt-out toggle) so it reflects real usage.

### Under the hood
- "Wallets" nav page renamed to "Finances".
- Status bar reordered to Version | SDE | N ONLINE, with a separator between SDE and the presence counter.

## [1.2.1] - 2026-07-20
### Fixes
- **ESI compliance** — every outbound request (main process and renderer) now identifies the app per CCP's ESI best practices: `EVE-Carbon/<version> (contact email; +source repo)`, sent as `User-Agent` from the app and `X-User-Agent` from the browser-side renderer (Chromium drops User-Agent overrides). Previously several endpoints still sent a stale, unidentifiable `EVE-BPC-Calculator/2.0` / `EVE-Carbon/1.0` string with no contact info.
- **ESI rate-limit hardening** — a 420 (error-limited) response now pauses *all* outbound ESI calls until the server's reset window, instead of only backing off the one request that tripped it; the app also backs off proactively when the error budget or a rate-limit bucket runs low, rather than reacting only after being throttled.
- **Nav polish** — corrected icons on the PLEX for Good and Discord buttons.

## [1.2.0] - 2026-07-18
### Features
- **Killboard on the dashboard banner** — all-time zKillboard stats beside your character: ships destroyed/lost with ranks, efficiency, and overall rank for All-time / 90 days / 7 days, each with up/down trend arrows (same ticker style as the wallet widget). Click the section to open your zKill page.
- **"N ONLINE" counter** — anonymous count of running EVE-Carbon apps in the status bar (random per-launch session ID only; opt out in Settings → General). Backed by a tiny Cloudflare worker (`infra/presence-worker`).
- **EVE Server Status** nav button — live Tranquility player count with a green/red status light; opens CCP's status page embedded in-app, with a pop-out to your browser.
- **Fleet Commander → Fleet Fight Notify** — CCP's fleet-fight notification form embedded in the app, so FCs can warn CCP about big brawls without leaving.
- **Blur strength slider** (Settings → Background) — scales the frosted-glass blur of every surface from 0–200%.
- **Discord button** in the nav — joins the EVE-Carbon Discord.

### Fixes
- **Windows tray icon / minimize-to-tray** — the `assets/` folder now ships with the installed app (it was silently excluded from packaging), fixing the "Failed to load image" error and restoring bundled background presets. Icon resolution is now self-healing with fallbacks.
- **Desktop shortcut icon on Windows** — the shortcut's icon path was corrupted by an installer buffer overflow caused by the overlong app description; description shortened and existing shortcuts repair correctly on reinstall.
- **Dashboard legibility** — banner labels/values and Net Worth KPI text now use shared text-role tokens (light-gray labels, bright values) instead of near-invisible dark grays.
- **SSO verify** moved to `login.eveonline.com/v2/oauth/verify` (ESI spring-cleaning migration); no Swagger-era endpoints remain in use.
- **Release notes** — the build pipeline now extracts the changelog section matching the released tag, so every release shows its own notes.

### Under the hood
- **Consolidated data palette** — eight `--pal-*` tokens (+ `--chart-1…8`) in `styles/palette.css` now drive every chart series, KPI value, badge and status colour; built-in themes and the Settings palette editor override them, so re-colouring the app touches one file.

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
