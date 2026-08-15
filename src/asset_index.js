// ─── asset_index.js ───────────────────────────────────────────────────────────
// Phase 2 of the assets rework (TODO.md): one query per view.
//
// Until now the Assets page loaded EVERY asset of EVERY character into the
// renderer as one array, then filtered, grouped, sorted and rendered it in JS.
// At ninety characters and a hundred thousand items that array is the problem:
// the structured clone alone is seconds, sorting is O(n log n) over the whole
// portfolio on every keystroke, and "sort by value" could only order what had
// already been loaded — which is why a Titan in the ninetieth hangar never made
// it to the top.
//
// This module materialises ONE flat, indexed row per displayed asset, carrying
// everything the page needs to group, filter, sort and label without a second
// lookup. The page then asks for what is on screen: the location groups, then
// one group's characters, then one character's items.
//
// ── Why the rows come from getCharacterAssets, not from SQL ─────────────────
// Working out WHERE an asset is, is not a join. ESI returns a flat list where a
// row's location_id points at its immediate parent, which may be a station, a
// structure, a solar system, or another item the character owns. Resolving that
// to a real place means climbing the parent chain to the first ancestor with a
// resolved location, then falling back through three global caches, with
// placeholder detection at every step and a cycle guard. character_info_db's
// getCharacterAssets already does exactly that, correctly, and has been through
// several rounds of bugs to get there.
//
// Reimplementing it as a recursive CTE would have re-fought all of those. So the
// index materialises its OUTPUT instead: the expensive walk runs once per sync
// in the main process (measured at 3.4 s for ninety characters) rather than on
// every filter change in the renderer.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { BPC_UNIT_VALUE } = require('./asset_valuation');

// A single character's holdings in a single location are bounded by reality, but
// nothing stops a stockpile alt parking tens of thousands of rows in one
// station. Past this many the query returns the most valuable and says so.
//
// This was 5,000 while the renderer built a table row per item and expanding a
// 4,938-row hangar took 2.4 seconds. Phase 3 made the DOM cost independent of
// the row count, so what remains is the query and the flat-model walk. Measured
// on a 22,343-row hangar: 367 ms to query, 28 ms to build the tree — so the old
// limit was cutting lists for a cost that no longer exists.
//
// 50,000 keeps a guard against a corrupt sync without truncating any hangar a
// person could actually fill.
const GROUP_ITEM_CAP = 50000;

// ── Placeholder detection ────────────────────────────────────────────────────
// A location name that is really a placeholder, not a place. Mirrors the
// locator's _isUnresolvedName and the renderer's isUnresolvedLocName; all three
// have to agree or the same structure lands in two different groups.
function isUnresolvedLocName(s) {
  return !s
    || /^(structure|location|station)\s+\d+$/i.test(s)
    || /no structure found|not found|forbidden|^error/i.test(s);
}

/**
 * The grouping identity of a row: which location header it belongs under.
 *
 * Deliberately identical to the rule the renderer used before this table
 * existed. Named locations group by name + system, so items nested inside ships
 * and containers (which carry the container id as their location_id but resolve
 * to the same station) stay in one group instead of splintering. Unnamed ones
 * key on location_id so two unreadable citadels in one system stay apart.
 *
 * Pure, and exported, because getting this wrong silently reshapes the whole
 * page and nothing else would catch it.
 */
function locationIdentity(row) {
  const named   = !isUnresolvedLocName(row.location_name);
  const sysName = row.solar_system_name || '';
  return {
    key: named
      ? `${row.location_name}||${row.solar_system_id || ''}`
      : String(row.location_id || 'unknown'),
    label: named
      ? row.location_name
      : (sysName ? `Unknown Structure — ${sysName}` : `Location ${row.location_id}`),
    unresolved: !named,
  };
}

// What people call things, where the game does not.
//
// Only terms that are NOT already a substring of the group name belong here:
// "dread" finds Dreadnought and "ceptor" finds Interceptor for free, so adding
// them would be noise. "Mothership" is the case that needs this — the group has
// been called Supercarrier for years, but half of New Eden never stopped.
//
// Matched against the start of the group name so blueprint groups come along
// with their hulls: Supercarrier and "Supercarrier Blueprints" both answer to
// "mothership".
const GROUP_ALIASES = [
  { match: /^Supercarrier/i,               terms: ['mothership', 'mom'] },
  { match: /^Force Auxiliary/i,            terms: ['fax'] },
  { match: /^Capital Industrial Ship/i,    terms: ['rorq'] },
  { match: /^Heavy Assault Cruiser/i,      terms: ['hac'] },
  { match: /^Heavy Interdiction Cruiser/i, terms: ['hic', 'hictor'] },
  { match: /^Interdictor/i,                terms: ['bubbler'] },
  { match: /^Interceptor/i,                terms: ['inty'] },
  { match: /^Strategic Cruiser/i,          terms: ['t3c'] },
  { match: /^Tactical Destroyer/i,         terms: ['t3d'] },
  { match: /^Command Destroyer/i,          terms: ['dessie'] },
  { match: /^Black Ops/i,                  terms: ['blops'] },
  { match: /^Jump Freighter/i,             terms: ['jf'] },
  { match: /^Deep Space Transport/i,       terms: ['dst'] },
  { match: /^Blockade Runner/i,            terms: ['br'] },
  { match: /^Capsule/i,                    terms: ['pod'] },
  { match: /^Electronic Attack Ship/i,     terms: ['eaf'] },
];

/** Community names for a group, or an empty array. */
function groupAliases(group) {
  if (!group) return [];
  const out = [];
  for (const a of GROUP_ALIASES) if (a.match.test(group)) out.push(...a.terms);
  return out;
}

/**
 * One lower-cased haystack per row, so the search box is a single LIKE instead
 * of eight ORs across eight columns.
 *
 * Covers the fields the old JS filter searched — item name, custom name,
 * location, corp, region, system — plus the SDE group and category, which is
 * what lets a search work by CLASS rather than by name. Substring matching then
 * gives the hierarchy for free: "carrier" finds Carrier, Supercarrier and both
 * of their blueprint groups, while "supercarrier" finds only the supers.
 *
 * Plurals are stored alongside, because group names are singular
 * ("Supercarrier", "Dreadnought") and people type plurals — without them
 * "dreadnoughts" finds nothing while "dreadnought" finds everything, which
 * reads as a broken search rather than as a grammar rule.
 *
 * Each WORD is pluralised, not just the whole phrase. A Nyx Blueprint is in the
 * group "Supercarrier Blueprints", so appending an s to the phrase gives
 * "supercarrier blueprintss" — and "supercarriers" still matches nothing. The
 * plural has to be attached to the word it belongs to.
 */
function pluralise(term) {
  const words = term.split(/\s+/).filter(Boolean);
  const out = [`${term}s`];
  if (words.length > 1) out.push(...words.map(w => `${w}s`));
  return out;
}

function searchBlob(row, typeInfo = {}) {
  const plain = [
    row.type_name, row.name, row.custom_name, row.location_name,
    row.owner_name, row.region_name, row.solar_system_name,
  ].filter(Boolean);

  const classes = [typeInfo.group, typeInfo.category, ...groupAliases(typeInfo.group)]
    .filter(Boolean);

  return [...plain, ...classes, ...classes.flatMap(pluralise)]
    .join(' ').toLowerCase();
}

// ── Schema ───────────────────────────────────────────────────────────────────
// (character_id, item_id) rather than item_id alone: item ids are unique across
// New Eden, but a demo fixture or a corrupt sync must not be able to make one
// character's row silently replace another's.

const SCHEMA = (sfx = '') => `
  CREATE TABLE IF NOT EXISTS asset_index${sfx} (
    character_id      INTEGER NOT NULL,
    item_id           INTEGER NOT NULL,
    character_name    TEXT,
    type_id           INTEGER,
    type_name         TEXT,
    custom_name       TEXT,
    is_bpc            INTEGER,
    quantity          INTEGER,
    volume            REAL,
    location_id       INTEGER,
    location_flag     TEXT,
    is_singleton      INTEGER,

    loc_key           TEXT NOT NULL,
    region_name       TEXT,
    owner_name        TEXT,

    type_group        TEXT,
    type_category     TEXT,
    type_slot         TEXT,
    meta_level        INTEGER,
    tech_level        INTEGER,
    -- Precomputed rather than a LIKE 'Planetary%' at query time: the location
    -- list re-aggregates this on every keystroke, and a per-row LIKE across a
    -- hundred thousand rows is most of what made that query slow.
    is_pi             INTEGER NOT NULL DEFAULT 0,

    own_value         REAL NOT NULL DEFAULT 0,
    contained_value   REAL NOT NULL DEFAULT 0,
    total_value       REAL NOT NULL DEFAULT 0,

    search_blob       TEXT,
    PRIMARY KEY (character_id, item_id)
  );

  -- The location dimension: about a hundred and twenty rows against a hundred
  -- thousand. Keeping the labels here means the group query aggregates two
  -- numbers and joins, instead of carrying six MIN() aggregates over every
  -- asset just to recover a station name it already knew.
  CREATE TABLE IF NOT EXISTS asset_location${sfx} (
    loc_key           TEXT PRIMARY KEY,
    loc_label         TEXT,
    loc_unresolved    INTEGER DEFAULT 0,
    solar_system_id   INTEGER,
    solar_system_name TEXT,
    region_name       TEXT,
    security_status   REAL,
    -- Only the merged "unknown structures" group sets this; everything else
    -- builds its subtitle from system and region at render time.
    subtitle          TEXT
  );

`;

// Created after the bulk load, not during it — maintaining five indexes across a
// hundred thousand inserts costs more than building them once at the end.
//
// idx_ai_cover earns its size. The location list groups by loc_key and sums
// own_value, and without every one of those columns in the index SQLite walks
// idx_ai_loc and then fetches a hundred thousand rows from the table to read
// them: measured at 1013 ms, against 26 ms when the index can answer alone.
// search_blob is in there for the same reason — a substring LIKE can never
// seek, but scanning it inside the covering index instead of the table took the
// search-while-filtering case from 1028 ms to 47 ms.
const INDEXES = [
  ['idx_ai_cover',    'asset_index%s(loc_key, own_value, is_pi, search_blob)'],
  // Opening one hangar: an index seek rather than a scan of the whole portfolio.
  ['idx_ai_loc_char', 'asset_index%s(loc_key, character_id)'],
  ['idx_ai_char',     'asset_index%s(character_id)'],
  ['idx_ai_value',    'asset_index%s(total_value DESC)'],
  ['idx_ai_region',   'asset_index%s(region_name)'],
  ['idx_ai_owner',    'asset_index%s(owner_name)'],
];

const CREATE_INDEXES = (sfx = '') => INDEXES
  .map(([name, def]) => `CREATE INDEX IF NOT EXISTS ${name}${sfx} ON ${def.replace('%s', sfx)};`)
  .join('\n');
const DROP_INDEXES = (sfx = '') => INDEXES
  .map(([name]) => `DROP INDEX IF EXISTS ${name}${sfx};`)
  .join('\n');

// What each table must have. CREATE TABLE IF NOT EXISTS does NOTHING to an
// existing table, so a column added later is absent on exactly the installs that
// already had data, and every write fails with "no such column". This project
// has shipped that bug twice (Jabber room columns, then type_prices) and hit it
// a third time developing this file.
//
// Elsewhere the fix is an ALTER list, which only works if somebody remembers to
// add to it. These two tables are a derived cache — every row is rebuilt from
// the character tables on the next refresh — so the shape can simply be
// asserted and the table dropped when it does not match. Nothing is lost, and
// it cannot be forgotten.
const EXPECTED_COLUMNS = {
  asset_index: [
    'character_id', 'item_id', 'character_name', 'type_id', 'type_name', 'custom_name',
    'is_bpc', 'quantity', 'volume', 'location_id', 'location_flag', 'is_singleton',
    'loc_key', 'region_name', 'owner_name', 'type_group', 'type_category', 'type_slot',
    'meta_level', 'tech_level', 'is_pi', 'own_value', 'contained_value', 'total_value',
    'search_blob',
  ],
  asset_location: [
    'loc_key', 'loc_label', 'loc_unresolved', 'solar_system_id',
    'solar_system_name', 'region_name', 'security_status', 'subtitle',
  ],
};

// Which open handles have already been checked. Every read goes through
// ensureAssetIndex, and re-running two PRAGMAs plus eight CREATE IF NOT EXISTS
// statements on each one means paying for them on every keystroke in the search
// box. Keyed on the handle itself, so reopening the database re-checks.
const _ensured = new WeakSet();

// Held only while the rebuild swaps its staging tables into place. Between
// DROP TABLE asset_index and the RENAME that replaces it, the table genuinely
// does not exist, and every read in this process shares the same connection —
// so a query landing in that gap fails with "no such table" rather than merely
// seeing old data. The swap is milliseconds; waiting it out is invisible.
//
// The long INSERT phase deliberately does NOT hold this: reads during it run
// against the untouched live tables, which is the whole point of staging.
let _swapInFlight = null;

// Every read enters through ensureAssetIndex, which makes it the one place the
// gate has to be applied.
async function ensureAssetIndex(db) {
  if (_swapInFlight) await _swapInFlight.catch(() => {});
  if (_ensured.has(db)) return;
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    let have;
    try { have = (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name); }
    catch (_) { continue; }                       // does not exist yet — SCHEMA makes it
    if (!have.length) continue;
    const missing = expected.filter(c => !have.includes(c));
    if (missing.length) {
      console.log(`[assetIndex] ${table} is missing ${missing.join(', ')} — rebuilding the table`);
      await db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  }
  await db.exec(SCHEMA());
  await db.exec(CREATE_INDEXES());
  _ensured.add(db);
}

// ── Building ─────────────────────────────────────────────────────────────────

/**
 * Rebuild the whole index from resolved asset rows.
 *
 * @param {object} db
 * @param {Array}  rows     getCharacterAssets() output with characterId /
 *                          characterName attached to every row.
 * @param {Map}    typeInfo type_id -> { group, category, slot, metaLevel, techLevel }
 *
 * One transaction, like the valuation rebuild and for the same reason: a
 * half-built index is worse than a stale one, because the missing half looks
 * exactly like "you do not own that any more".
 */
async function rebuildAssetIndex(db, rows = [], typeInfo = new Map()) {
  await ensureAssetIndex(db);

  const COLUMNS = [
    'character_id', 'item_id', 'character_name', 'type_id', 'type_name', 'custom_name',
    'is_bpc', 'quantity', 'volume', 'location_id', 'location_flag', 'is_singleton',
    'loc_key', 'region_name', 'owner_name',
    'type_group', 'type_category', 'type_slot', 'meta_level', 'tech_level', 'is_pi',
    'own_value', 'contained_value', 'total_value',
    'search_blob',
  ];

  // Prices read into memory once. Doing this as UPDATE … (SELECT …) after the
  // load instead ran a correlated subquery per row: over a hundred thousand
  // rows that was most of a ten-second rebuild. There are only a few thousand
  // priced types, so the map is small and the lookup is free.
  const unitValue = new Map(
    (await db.all('SELECT type_id, unit_value FROM type_prices').catch(() => []))
      .map(r => [r.type_id, r.unit_value]));
  // Multi-row INSERTs, not one prepared run() per row. Every run() through the
  // promise wrapper is a round trip, and a hundred thousand of them took 17 s
  // inside a single transaction — the statement was never the cost, the
  // per-row await was.
  //
  // Derived from a parameter budget rather than written as a row count, so
  // adding a column can never quietly push a statement past SQLite's bind limit
  // (measured: 30,000 binds succeed). Chunking also keeps the main process
  // responsive: the event loop gets a turn between statements, which one giant
  // INSERT would not give it.
  const CHUNK = Math.max(1, Math.floor(20000 / COLUMNS.length));
  const placeholders = `(${COLUMNS.map(() => '?').join(',')})`;

  // ── Pass one: identity and per-location tallies ────────────────────────────
  // Two passes because two of the labelling rules need to see a whole location
  // before any of its rows can be written. Both used to live in the renderer,
  // which could only apply them because it held every asset in memory — the
  // exact thing this table exists to stop. They belong here: what a group is
  // called, and which rows are in it, is what the index is FOR.
  const identity = new Array(rows.length);
  const tally = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const loc = locationIdentity(r);
    identity[i] = loc;
    let t = tally.get(loc.key);
    if (!t) {
      t = { count: 0, pi: 0, unresolved: loc.unresolved, hasSystem: false, label: loc.label, row: r };
      tally.set(loc.key, t);
    }
    t.count++;
    if (/^Planetary/i.test(typeInfo.get(Number(r.type_id))?.category || '')) t.pi++;
    if (r.solar_system_name) t.hasSystem = true;
  }

  // A location we could not name whose contents are mostly Planetary
  // Commodities is a Customs Office or an Orbital Skyhook — the only things
  // that hold PI out in space. We cannot pin the exact celestial without the
  // corp customs-offices scope, but saying WHAT it is beats "Location 1037…".
  const isPi = (t) => t.unresolved && t.count > 0 && (t.pi / t.count) >= 0.6;

  // Everything else with no name and no system: private structures we cannot
  // read at all. One each would be a screen of noise, so when there is more
  // than one they collapse into a single group at the bottom.
  const isFullyUnknown = (t) => t.unresolved && !t.hasSystem && !isPi(t);
  const unknownKeys = [...tally.entries()].filter(([, t]) => isFullyUnknown(t)).map(([k]) => k);
  const MERGED_KEY = '__unknown_structures__';
  const merge = unknownKeys.length > 1 ? new Set(unknownKeys) : new Set();

  // Final key and label per original key, applied in pass two.
  const finalKey = new Map();
  const finalLabel = new Map();
  for (const [key, t] of tally) {
    if (merge.has(key)) { finalKey.set(key, MERGED_KEY); continue; }
    finalKey.set(key, key);
    finalLabel.set(key, isPi(t)
      ? (t.hasSystem ? 'Customs Office / Skyhook' : 'Customs Office / Skyhook — system unknown')
      : t.label);
  }

  // ── What each container is carrying ────────────────────────────────────────
  // Rolled up HERE, over the index's own rows and scoped to the group the
  // container is displayed in, rather than read from asset_contained (which is
  // built over the raw rows and knows nothing about grouping).
  //
  // That scoping is the whole point. A group header shows SUM(own_value) and
  // each top-level row shows own + contained, so the header only equals the
  // rows beneath it if every descendant counted in "contained" is also a row in
  // the same group. Rolling up globally broke that: a ship could report the
  // value of contents filed under a different location, so the ship read 57B
  // while the character above it read 50B — the reported symptom exactly.
  const own = new Array(rows.length);
  const contained = new Array(rows.length).fill(0);
  const byItem = new Map();          // characterId|item_id -> row index
  const groupOf = new Array(rows.length);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const qty = r.quantity == null ? 1 : r.quantity;
    // The same rule the raw valuation applies, so the two tables cannot
    // disagree about what a thing is worth: a blueprint copy is nominal however
    // expensive its product is, everything else is quantity times unit value.
    own[i] = Number(r.is_bpc) === 1
      ? BPC_UNIT_VALUE * qty
      : qty * (unitValue.get(Number(r.type_id)) || 0);
    groupOf[i] = `${finalKey.get(identity[i].key)}|${r.characterId}`;
    byItem.set(`${r.characterId}|${r.item_id}`, i);
  }

  for (let i = 0; i < rows.length; i++) {
    if (!own[i]) continue;
    const charId = rows[i].characterId;
    let parentIdx = byItem.get(`${charId}|${rows[i].location_id}`);
    // ESI has returned items whose location_id points back into their own
    // subtree; an unguarded walk there never returns.
    const seen = new Set([i]);
    let depth = 0;
    while (parentIdx !== undefined && !seen.has(parentIdx) && depth < 12) {
      if (groupOf[parentIdx] !== groupOf[i]) break;   // a different header owns it
      seen.add(parentIdx);
      contained[parentIdx] += own[i];
      parentIdx = byItem.get(`${charId}|${rows[parentIdx].location_id}`);
      depth++;
    }
  }

  // One row per location. Built alongside the items so the two tables can never
  // disagree about which key a station has.
  const locations = new Map();
  if (merge.size) {
    const mergedCount = unknownKeys.reduce((n, k) => n + tally.get(k).count, 0);
    locations.set(MERGED_KEY, [
      MERGED_KEY, 'Unknown / inaccessible structures', 1, null, null, null, null,
      `${merge.size} structures · no name or system resolvable · ${mergedCount.toLocaleString()} items`,
    ]);
  }

  // ── Build into staging tables, then swap ───────────────────────────────────
  // Everything in the main process shares ONE SQLite connection, so a query the
  // Assets page makes while this is running does not get its own snapshot — it
  // executes inside this transaction and sees whatever state the rebuild has
  // reached. Emptying the live table first therefore made the page briefly
  // report that the user owns nothing, which is exactly what it did when the
  // startup refresh landed while someone was reading it.
  //
  // So the live tables are left alone until the new ones are complete. Same
  // write-then-swap strategy replaceAssets uses, for the same reason. The swap
  // itself rebuilds the indexes, so a read caught inside that window still gets
  // correct rows — just unindexed ones for a moment.
  const SFX = '_new';
  await db.exec(`DROP TABLE IF EXISTS asset_index${SFX}; DROP TABLE IF EXISTS asset_location${SFX};`);
  await db.exec(SCHEMA(SFX));

  await db.exec('BEGIN');
  try {

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const params = [];
      for (let j = 0; j < chunk.length; j++) {
        const n = i + j;
        const r = chunk[j];
        const orig = identity[n];
        const loc = { key: finalKey.get(orig.key), unresolved: orig.unresolved };
        const ti  = typeInfo.get(Number(r.type_id)) || {};
        const qty = r.quantity == null ? 1 : r.quantity;
        const ownValue = own[n];
        const containedInGroup = contained[n];

        if (!locations.has(loc.key)) {
          locations.set(loc.key, [
            loc.key, finalLabel.get(orig.key), loc.unresolved ? 1 : 0,
            r.solar_system_id || null, r.solar_system_name || null,
            r.region_name || null,
            typeof r.security_status === 'number' ? r.security_status : null,
            null,
          ]);
        }
        params.push(
          r.characterId, r.item_id, r.characterName || null,
          r.type_id, r.type_name || r.name || null, r.custom_name || null,
          r.is_bpc == null ? null : Number(r.is_bpc),
          qty,
          r.volume || 0, r.location_id, r.location_flag || null,
          r.is_singleton ? 1 : 0,
          loc.key, r.region_name || null, r.owner_name || null,
          ti.group || null, ti.category || null, ti.slot || null,
          ti.metaLevel == null ? null : Number(ti.metaLevel),
          ti.techLevel == null ? null : Number(ti.techLevel),
          /^Planetary/i.test(ti.category || '') ? 1 : 0,
          ownValue, containedInGroup, ownValue + containedInGroup,
          searchBlob(r, ti),
        );
      }
      await db.run(
        `INSERT OR REPLACE INTO asset_index${SFX} (${COLUMNS.join(',')}) VALUES ` +
        chunk.map(() => placeholders).join(','), ...params);
    }

    const locRows = [...locations.values()];
    for (let i = 0; i < locRows.length; i += CHUNK) {
      const chunk = locRows.slice(i, i + CHUNK);
      await db.run(
        `INSERT OR REPLACE INTO asset_location${SFX}
           (loc_key, loc_label, loc_unresolved, solar_system_id, solar_system_name,
            region_name, security_status, subtitle) VALUES ` +
        chunk.map(() => '(?,?,?,?,?,?,?,?)').join(','), ...chunk.flat());
    }

    // The swap. Dropping the live tables takes their indexes with them, so the
    // canonical index names are free to be recreated on the tables that just
    // took their place. Gated, because for the length of this the live table
    // does not exist and a concurrent read would fail outright.
    let released;
    _swapInFlight = new Promise(resolve => { released = resolve; });
    try {
      await db.exec(`DROP TABLE IF EXISTS asset_index; DROP TABLE IF EXISTS asset_location;`);
      await db.exec(`ALTER TABLE asset_index${SFX} RENAME TO asset_index;`);
      await db.exec(`ALTER TABLE asset_location${SFX} RENAME TO asset_location;`);
      await db.exec(CREATE_INDEXES());
    } finally {
      _swapInFlight = null;
      released();
    }

    await db.run(
      `INSERT INTO valuation_meta (key, value) VALUES ('index_rebuilt_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`, new Date().toISOString());

    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    // The live tables were never touched; only the staging pair needs clearing.
    await db.exec(`DROP TABLE IF EXISTS asset_index${SFX}; DROP TABLE IF EXISTS asset_location${SFX};`)
      .catch(() => {});
    throw e;
  }

  const c = await db.get('SELECT COUNT(*) c, COUNT(DISTINCT loc_key) g FROM asset_index');
  return { rows: c.c, groups: c.g };
}

// ── Filtering ────────────────────────────────────────────────────────────────

/**
 * Turn the toolbar's four controls into one WHERE clause.
 * Every query goes through this, so a filter can never apply to the item list
 * but not the totals above it.
 */
function buildWhere(f = {}) {
  const where = [];
  const params = [];

  if (f.characterId) { where.push('character_id = ?'); params.push(Number(f.characterId)); }

  if (f.region === '__unresolved__') {
    where.push("(region_name IS NULL OR region_name = '')");
  } else if (f.region) {
    where.push('region_name = ?'); params.push(f.region);
  }

  if (f.corp) { where.push('owner_name = ?'); params.push(f.corp); }

  if (f.search) {
    where.push('search_blob LIKE ?');
    params.push(`%${String(f.search).toLowerCase().trim()}%`);
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// ── Sorting ──────────────────────────────────────────────────────────────────
// Column key -> the indexed column it sorts on, and whether it is numeric.
// Sorting by value uses total_value, so a container is ranked by what it is
// carrying. That is the whole point: an Asset Safety Wrap whose own type is
// worth nothing, holding a billion ISK of modules, belongs at the top.
const SORT_COLUMNS = {
  name:     { col: 'type_name',     num: false },
  qty:      { col: 'quantity',      num: true  },
  group:    { col: 'type_group',    num: false },
  category: { col: 'type_category', num: false },
  slot:     { col: 'type_slot',     num: false },
  vol:      { col: 'volume',        num: true  },
  meta:     { col: 'meta_level',    num: true  },
  tech:     { col: 'tech_level',    num: true  },
  price:    { col: 'total_value',   num: true  },
};

function isNumericSort(col) { return !!(SORT_COLUMNS[col] && SORT_COLUMNS[col].num); }

/** ORDER BY for the item list. Ties break on name so the order never wobbles. */
function itemOrderBy(sort = {}) {
  const spec = SORT_COLUMNS[sort.col];
  const dir  = sort.dir === -1 ? 'DESC' : 'ASC';
  if (!spec) return 'ORDER BY type_name COLLATE NOCASE ASC';
  const collate = spec.num ? '' : ' COLLATE NOCASE';
  return `ORDER BY ${spec.col}${collate} ${dir}, type_name COLLATE NOCASE ASC`;
}

// ── The queries the page is built from ───────────────────────────────────────

/** Dropdown contents. Three cheap DISTINCTs instead of scanning every asset in JS. */
async function getFilterOptions(db) {
  await ensureAssetIndex(db);
  const [chars, regions, corps, unresolved] = await Promise.all([
    db.all(`SELECT DISTINCT character_id id, character_name name FROM asset_index
             WHERE character_name IS NOT NULL ORDER BY character_name COLLATE NOCASE`),
    db.all(`SELECT DISTINCT region_name name FROM asset_index
             WHERE region_name IS NOT NULL AND region_name <> '' ORDER BY region_name COLLATE NOCASE`),
    db.all(`SELECT DISTINCT owner_name name FROM asset_index
             WHERE owner_name IS NOT NULL AND owner_name <> '' ORDER BY owner_name COLLATE NOCASE`),
    db.get(`SELECT COUNT(*) c FROM asset_index WHERE region_name IS NULL OR region_name = ''`),
  ]);
  return {
    characters: chars.map(r => ({ id: r.id, name: r.name })),
    regions:    regions.map(r => r.name),
    corps:      corps.map(r => r.name),
    unresolvedCount: unresolved.c || 0,
  };
}

/** The line above the table: how much is shown, of how much, across how many characters. */
async function getSummary(db, filters = {}) {
  await ensureAssetIndex(db);
  const { sql, params } = buildWhere(filters);
  const [shown, all] = await Promise.all([
    db.get(`SELECT COUNT(*) rows, COUNT(DISTINCT character_id) chars,
                   COALESCE(SUM(own_value), 0) value
              FROM asset_index ${sql}`, ...params),
    db.get('SELECT COUNT(*) rows FROM asset_index'),
  ]);
  return {
    rows: shown.rows || 0,
    characters: shown.chars || 0,
    // own_value only: adding contained_value would count everything inside a
    // container twice, once as itself and once as part of its parent.
    value: shown.value || 0,
    totalRows: all.rows || 0,
    filtered: (shown.rows || 0) < (all.rows || 0),
  };
}

/**
 * One row per location header — the only thing the page renders until something
 * is expanded. A hundred and twenty rows instead of a hundred thousand.
 *
 * A numeric sort orders the HEADERS by what they hold, not just the items
 * inside them. Sorting by price while the stations stayed in region order was
 * the reported "sorting doesn't work": at the level you were reading it, it did
 * not.
 */
async function getLocationGroups(db, filters = {}, sort = {}) {
  await ensureAssetIndex(db);
  const { sql, params } = buildWhere(filters);

  // The merged "unknown structures" bucket always sorts last, whatever the
  // column: it is a place to put things that could not be identified, not a
  // location competing for the top of the list.
  const last = `CASE WHEN l.loc_key = '__unknown_structures__' THEN 1 ELSE 0 END`;

  let orderBy;
  if (sort.col === 'name') {
    orderBy = `ORDER BY ${last}, l.loc_label COLLATE NOCASE ${sort.dir === -1 ? 'DESC' : 'ASC'}`;
  } else if (isNumericSort(sort.col)) {
    orderBy = `ORDER BY ${last}, t.value ${sort.dir === -1 ? 'DESC' : 'ASC'}, l.loc_label COLLATE NOCASE ASC`;
  } else {
    orderBy = `ORDER BY ${last},
                        l.region_name COLLATE NOCASE ASC,
                        l.solar_system_name COLLATE NOCASE ASC,
                        l.loc_label COLLATE NOCASE ASC`;
  }

  // Aggregate first over the big table (two sums and a count, nothing else),
  // then join the ~120-row dimension for the labels. Carrying the labels
  // through the GROUP BY as MIN() aggregates cost about 700 ms per keystroke.
  return db.all(`
    SELECT l.loc_key, l.loc_label, l.loc_unresolved, l.subtitle,
           l.solar_system_name, l.region_name, l.security_status,
           t.item_count, t.value
      FROM (SELECT loc_key,
                   COUNT(*)                    item_count,
                   COALESCE(SUM(own_value), 0) value
              FROM asset_index ${sql}
             GROUP BY loc_key) t
      JOIN asset_location l ON l.loc_key = t.loc_key
     ${orderBy}`, ...params);
}

/** The characters holding something in one location, for an expanded group. */
async function getGroupCharacters(db, locKey, filters = {}, sort = {}) {
  await ensureAssetIndex(db);
  const { sql, params } = buildWhere(filters);
  const clause = sql ? `${sql} AND loc_key = ?` : 'WHERE loc_key = ?';
  const orderBy = isNumericSort(sort.col)
    ? `ORDER BY value ${sort.dir === -1 ? 'DESC' : 'ASC'}, character_name COLLATE NOCASE ASC`
    : `ORDER BY character_name COLLATE NOCASE ${sort.col === 'name' && sort.dir === -1 ? 'DESC' : 'ASC'}`;

  return db.all(`
    SELECT character_id, character_name,
           COUNT(*) item_count, COALESCE(SUM(own_value), 0) value
      FROM asset_index ${clause}
     GROUP BY character_id
     ${orderBy}`, ...params, locKey);
}

/**
 * The items one character holds in one location. The leaf query — everything
 * above it exists so this one is the only place that returns item rows, and
 * only for a group somebody actually opened.
 */
async function getGroupItems(db, locKey, characterId, filters = {}, sort = {}, cap = GROUP_ITEM_CAP) {
  await ensureAssetIndex(db);
  const { sql, params } = buildWhere(filters);
  const clause = sql ? `${sql} AND loc_key = ? AND character_id = ?`
                     : 'WHERE loc_key = ? AND character_id = ?';
  const args = [...params, locKey, Number(characterId)];

  const total = (await db.get(
    `SELECT COUNT(*) c FROM asset_index ${clause}`, ...args)).c || 0;

  // Past the cap, take the most valuable rather than an arbitrary alphabetical
  // slice — if the list has to be cut, the cut should keep what matters.
  const orderBy = total > cap ? 'ORDER BY total_value DESC' : itemOrderBy(sort);

  const rows = await db.all(`
    SELECT character_id, character_name, item_id, type_id, type_name, custom_name,
           is_bpc, quantity, volume, location_id, location_flag, is_singleton,
           type_group, type_category, type_slot, meta_level, tech_level,
           own_value, contained_value, total_value
      FROM asset_index ${clause}
     ${orderBy}
     LIMIT ?`, ...args, cap);

  return { rows, total, truncated: total > cap };
}

/** The most valuable things owned, ranked across every character. */
async function getTopItems(db, { limit = 50, offset = 0, filters = {} } = {}) {
  await ensureAssetIndex(db);
  const { sql, params } = buildWhere(filters);
  // The where clause is written against asset_index columns, so it is applied
  // before the label join rather than after it.
  const scoped = sql.replace(/\b(character_id|region_name|owner_name|search_blob)\b/g, 'a.$1');
  return db.all(`
    SELECT a.character_id, a.character_name, a.item_id, a.type_id, a.type_name,
           a.custom_name, a.quantity, a.loc_key, l.loc_label, a.region_name,
           a.own_value, a.contained_value, a.total_value
      FROM asset_index a
      LEFT JOIN asset_location l ON l.loc_key = a.loc_key
      ${scoped}
     ORDER BY a.total_value DESC
     LIMIT ? OFFSET ?`, ...params, limit, offset);
}

module.exports = {
  GROUP_ITEM_CAP, GROUP_ALIASES,
  isUnresolvedLocName, locationIdentity, searchBlob, groupAliases,
  buildWhere, itemOrderBy, isNumericSort, SORT_COLUMNS,
  ensureAssetIndex, rebuildAssetIndex,
  getFilterOptions, getSummary, getLocationGroups,
  getGroupCharacters, getGroupItems, getTopItems,
};
