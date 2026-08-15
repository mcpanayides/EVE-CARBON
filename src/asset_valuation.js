// ─── asset_valuation.js ───────────────────────────────────────────────────────
// Turns "what is this worth" from a render-time guess into a database column.
//
// Until now an item's value was computed in the renderer from three caches that
// arrive independently — Jita prices (one JSON file per type), CCP's adjusted
// map, and SDE metadata for the capital-hull defaults. Nothing could sort or
// aggregate by value in SQL, the figures vanished on restart, and the single
// most valuable item in a hangar (a Titan, priced by hull group) was the one
// whose price arrived last.
//
// This module materialises one authoritative unit_value per type, then rolls it
// out across every asset and up through every container, so the database can
// answer "the 50 most valuable things you own" in tens of milliseconds instead
// of the renderer sorting 100,000 rows it had to hold in memory first.
//
// ── Why prices come from two sources ────────────────────────────────────────
// Measured against a real 2,484-type profile (see TODO.md):
//
//   • CCP /markets/prices/  — ONE call, covers 91.4% of held types, and is
//     systematically ~18% low. Its outliers are spectacular in both directions:
//     it valued a Domination Control Tower at 23% of its Jita price and a
//     collector apparel item at 3%.
//   • Fuzzwork Jita 4-4     — one call per 250 types, covers 91.8%, and has no
//     price at all for things that cannot be sold in highsec. It quoted a
//     Wyvern at 4.9M against a real value in the tens of billions.
//
// Neither is authoritative. So: CCP is the baseline for everything, real market
// prices refine only the types that carry the value (the top 50 types hold ~79%
// of a portfolio, so a few hundred is one batch instead of ten), and hardcoded
// hull defaults override both where no real market exists.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// Capital hulls with no open market. Every price source lies about these —
// CCP prices them by build cost, Jita has no orders at all — so an explicit
// value is the honest answer. Mirrors ASSET_DEFAULT_VALUE in src/func/assets.js;
// that copy drives the current renderer and should be deleted when the UI moves
// onto this table.
const HULL_DEFAULTS = {
  Titan:        { standard: 165e9, faction: 300e9 },
  Supercarrier: { standard:  50e9, faction: 150e9 },
  Dreadnought:  { standard:     0, faction:  30e9 },   // standard dreads DO trade
};

// A blueprint COPY is worth a nominal amount however expensive its product is —
// it is a licence to build, not the thing. Originals are valued by CCP's
// adjusted price, which is the one job that map does well.
const BPC_UNIT_VALUE = 0.01;

// How many types get a real market lookup. 250 is one Fuzzwork batch, and at
// ~79% of portfolio value in the top 50 types it is well past the point of
// diminishing returns.
const REFINE_TOP_N = 250;

/**
 * Decide one unit value per type.
 *
 * Pure: no I/O, no database. Everything it needs is passed in, which is what
 * makes the precedence rules testable without a network or a fixture.
 *
 * @param {object}  o
 * @param {Map<number,number>} o.ccp        type_id → CCP adjusted/average
 * @param {Map<number,number>} o.market     type_id → real market price (the refined subset)
 * @param {Map<number,object>} o.meta       type_id → { group, metaGroup } from the SDE
 * @returns {Map<number,{ value:number, source:string }>}
 */
function resolveUnitValues({ ccp = new Map(), market = new Map(), meta = new Map() } = {}) {
  const out = new Map();
  const types = new Set([...ccp.keys(), ...market.keys(), ...meta.keys()]);

  for (const typeId of types) {
    // 1. A hull with no real market outranks both price sources. This is the
    //    Titan case: without it the most valuable item you own is priced by
    //    whichever stray lowball order happened to be up.
    const hull = hullDefault(meta.get(typeId));
    if (hull > 0) { out.set(typeId, { value: hull, source: 'hull-default' }); continue; }

    // 2. A real market price, for the types worth looking up.
    const m = market.get(typeId);
    if (m > 0) { out.set(typeId, { value: m, source: 'market' }); continue; }

    // 3. CCP's baseline for everything else.
    const c = ccp.get(typeId);
    if (c > 0) { out.set(typeId, { value: c, source: 'ccp' }); continue; }

    out.set(typeId, { value: 0, source: 'unknown' });
  }
  return out;
}

/** The explicit value for a capital hull, or 0 when the type is not one. */
function hullDefault(md) {
  if (!md || !md.group) return 0;
  const tier = HULL_DEFAULTS[md.group];
  if (!tier) return 0;
  // metaGroup 4 is the pirate-faction variant, worth substantially more.
  return Number(md.metaGroup) === 4 ? tier.faction : tier.standard;
}

/**
 * Which types are worth a real market lookup.
 *
 * Ranked by CCP value × quantity held, because that only has to be approximately
 * right to pick the right few hundred. A type CCP overvalues gets checked, which
 * is harmless; one it undervalues badly may be missed, which self-corrects as
 * the refined set grows and costs a fraction of a percent of portfolio value in
 * the meantime.
 */
function selectTypesToRefine(heldQuantities, ccp, limit = REFINE_TOP_N) {
  const ranked = [];
  for (const [typeId, qty] of heldQuantities) {
    const unit = ccp.get(typeId) || 0;
    // Types CCP cannot price at all are ranked ahead of cheap ones: an unknown
    // price is far more likely to be a rare worth real money than a mineral.
    ranked.push({ typeId, weight: unit > 0 ? unit * qty : Number.MAX_SAFE_INTEGER / 2 });
  }
  ranked.sort((a, b) => b.weight - a.weight);
  return ranked.slice(0, limit).map(r => r.typeId);
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  -- One authoritative value per type. Not per item: the BPO/BPC distinction is
  -- a property of the ITEM (same type_id, different worth), applied in SQL when
  -- asset_value is built.
  CREATE TABLE IF NOT EXISTS type_prices (
    type_id    INTEGER PRIMARY KEY,
    unit_value REAL    NOT NULL DEFAULT 0,
    source     TEXT,                        -- hull-default | market | ccp | unknown
    updated_at TEXT
  );

  -- Own value of every asset, across every character. The UNION the renderer
  -- used to do in JS, done once and indexed.
  CREATE TABLE IF NOT EXISTS asset_value (
    item_id      INTEGER PRIMARY KEY,
    character_id INTEGER NOT NULL,
    type_id      INTEGER,
    location_id  INTEGER,
    quantity     INTEGER,
    own_value    REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_av_char   ON asset_value(character_id);
  CREATE INDEX IF NOT EXISTS idx_av_parent ON asset_value(location_id);
  CREATE INDEX IF NOT EXISTS idx_av_value  ON asset_value(own_value DESC);

  -- Value held INSIDE each container, to any depth. A ship or an asset safety
  -- wrap is worth what is in it, and that has to be known before anything can
  -- be sorted by value.
  CREATE TABLE IF NOT EXISTS asset_contained (
    container_id    INTEGER PRIMARY KEY,
    contained_value REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS valuation_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

// Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS is a
// no-op on an existing table, so a new column has to be added explicitly or
// every write against it fails with "no such column" on exactly the installs
// that already had data. (The Jabber room columns shipped that way once; this
// table is not going to.)
const ADDED_COLUMNS = [
  ['type_prices', 'source',     'TEXT'],
  ['type_prices', 'updated_at', 'TEXT'],
];

async function ensureValuationTables(db) {
  await db.exec(SCHEMA);
  for (const [table, column, decl] of ADDED_COLUMNS) {
    try { await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`); }
    catch (_) { /* already present — the normal case */ }
  }
}

// ─── Writing prices ───────────────────────────────────────────────────────────

async function writeTypePrices(db, resolved) {
  await ensureValuationTables(db);
  const now = new Date().toISOString();
  await db.exec('BEGIN');
  try {
    const stmt = await db.prepare(
      'INSERT OR REPLACE INTO type_prices (type_id, unit_value, source, updated_at) VALUES (?, ?, ?, ?)');
    for (const [typeId, { value, source }] of resolved) {
      await stmt.run(typeId, value, source, now);
    }
    await stmt.finalize();
    await db.run(
      `INSERT INTO valuation_meta (key, value) VALUES ('prices_updated_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`, now);
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
  return resolved.size;
}

// ─── Materialising asset values ───────────────────────────────────────────────

/**
 * Rebuild asset_value and asset_contained from the per-character asset tables.
 *
 * Called after a sync. The whole thing is one transaction: a half-rebuilt
 * valuation is worse than a stale one, because a partial container roll-up
 * silently under-values every ship it did not reach.
 */
async function rebuildAssetValues(db) {
  await ensureValuationTables(db);

  const tables = (await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'char\\_%\\_assets' ESCAPE '\\'"
  )).map(r => r.name);
  if (!tables.length) return { items: 0, containers: 0 };

  // A blueprint COPY is nominal whatever its type is worth, so the BPO/BPC test
  // has to happen per item — hence the join to each character's blueprint table.
  const selects = tables.map(tn => {
    const cid = tn.match(/char_(\d+)_assets/)?.[1];
    if (!cid) return null;
    const bp = `char_${cid}_blueprints`;
    return `
      SELECT a.item_id, ${cid} AS character_id, a.type_id, a.location_id, a.quantity,
             CASE WHEN b.is_bpc = 1 THEN ${BPC_UNIT_VALUE} * COALESCE(a.quantity, 1)
                  ELSE COALESCE(a.quantity, 1) * COALESCE(p.unit_value, 0) END AS own_value
        FROM ${tn} a
        LEFT JOIN type_prices p ON p.type_id = a.type_id
        LEFT JOIN ${bp} b       ON b.item_id = a.item_id`;
  }).filter(Boolean);

  await db.exec('BEGIN');
  try {
    await db.exec('DELETE FROM asset_value');
    await db.exec(`INSERT INTO asset_value (item_id, character_id, type_id, location_id, quantity, own_value)
                   ${selects.join(' UNION ALL ')}`);

    // Roll every item's value up to each of its ancestors. The depth bound is
    // not caution for its own sake: ESI has returned items whose location_id
    // points back into their own subtree, and an unbounded walk never returns.
    await db.exec('DELETE FROM asset_contained');
    await db.exec(`
      INSERT INTO asset_contained (container_id, contained_value)
      WITH RECURSIVE up(root, parent, value, depth) AS (
        SELECT v.item_id, v.location_id, v.own_value, 0
          FROM asset_value v
         WHERE v.own_value > 0
        UNION ALL
        SELECT u.root, p.location_id, u.value, u.depth + 1
          FROM up u
          JOIN asset_value p ON p.item_id = u.parent
         WHERE u.depth < 12
      )
      SELECT parent, SUM(value)
        FROM up
       -- EVERY depth counts, including 0. The base row already means "this
       -- value belongs to the container named in the parent column" -- filtering
       -- it out credited grandparents while leaving every direct parent at zero.
       WHERE parent IN (SELECT item_id FROM asset_value)
         AND parent <> root                       -- never let an item contain itself
       GROUP BY parent`);

    await db.run(
      `INSERT INTO valuation_meta (key, value) VALUES ('values_rebuilt_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`, new Date().toISOString());
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }

  const items = (await db.get('SELECT COUNT(*) c FROM asset_value')).c;
  const containers = (await db.get('SELECT COUNT(*) c FROM asset_contained')).c;
  return { items, containers };
}

// ─── The queries this exists to make possible ─────────────────────────────────

/**
 * The most valuable things owned, ranked across EVERY character.
 *
 * This is the query the whole design is for. The ORDER BY runs over every asset,
 * so a Titan sitting in one hangar out of ninety is row one — the limit takes
 * the top of a global ordering, not the top of whatever page was fetched.
 */
async function getTopAssetsByValue(db, { limit = 50, offset = 0, characterId = null } = {}) {
  const where = characterId ? 'WHERE v.character_id = ?' : '';
  const params = characterId ? [characterId, limit, offset] : [limit, offset];
  return db.all(`
    SELECT v.item_id, v.character_id, v.type_id, v.quantity,
           v.own_value,
           COALESCE(c.contained_value, 0) AS contained_value,
           v.own_value + COALESCE(c.contained_value, 0) AS total_value
      FROM asset_value v
      LEFT JOIN asset_contained c ON c.container_id = v.item_id
      ${where}
     ORDER BY total_value DESC
     LIMIT ? OFFSET ?`, ...params);
}

/** Total asset value, per character or across all of them. One query. */
async function getAssetNetWorth(db, characterId = null) {
  // own_value only: adding contained_value would count everything inside a
  // container twice, once as itself and once as part of its parent.
  const row = characterId
    ? await db.get('SELECT SUM(own_value) v FROM asset_value WHERE character_id = ?', characterId)
    : await db.get('SELECT SUM(own_value) v FROM asset_value');
  return row?.v || 0;
}

/** When prices and values were last refreshed — staleness the UI can show. */
async function getValuationMeta(db) {
  const rows = await db.all('SELECT key, value FROM valuation_meta');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

module.exports = {
  HULL_DEFAULTS, BPC_UNIT_VALUE, REFINE_TOP_N,
  resolveUnitValues, hullDefault, selectTypesToRefine,
  ensureValuationTables, writeTypePrices, rebuildAssetValues,
  getTopAssetsByValue, getAssetNetWorth, getValuationMeta,
};
