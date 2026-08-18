'use strict';
//
// ─── fleet_ops.js — an FC's record of a fleet, from form-up to stand-down ─────
//
// An "op" is one bounded outing: it has a name, a start, an end, and a record of
// who was in it, what they flew, and where the fleet actually went. Phase 1 of
// the Fleet Tracker (see TODO.md); kills, losses and mining land in Phases 2-3.
//
// THE WHOLE THING IS FREE, and that is the point. `/fleets/{id}/members` already
// returns `solar_system_id` for every pilot, and `src/func/fc.js` has been
// fetching it every 6 seconds and throwing it away. Recording an op costs no new
// ESI call, no new scope, and no extra load on anyone — it only keeps what was
// already arriving.
//
// ── Two design decisions worth knowing before changing anything ──────────────
//
// 1. WHERE THE FLEET IS, IS NOT WHERE THE FC IS. Boss location is the obvious
//    signal and the wrong one: the FC is frequently off-grid, scouting ahead, or
//    the last to jump. The fleet's position is the MODAL system across members,
//    and it is debounced, because a fleet mid-warp is genuinely spread across
//    three systems for several seconds and recording that produces a movement
//    log that is mostly noise.
//
// 2. THIS IS USER DATA AND IS NEVER REBUILT. `src/asset_index.js` DROPs its
//    tables when the shape is wrong, which is correct there — it is a derived
//    cache and can be rebuilt from the source in seconds. An op is a record of
//    something that happened once. It has no source to rebuild from. So the
//    migration path here ADDS columns and never drops a table, and
//    `CREATE TABLE IF NOT EXISTS` alone is NOT a migration — it silently does
//    nothing to an existing table, which has already cost this project two
//    shipped upgrades ("no such column: room_jid").

// ── Schema ───────────────────────────────────────────────────────────────────
// `create` runs on every startup and is the source of truth for a fresh install.
// `added` lists columns introduced AFTER a table first shipped: they are applied
// with ALTER TABLE, the only migration SQLite offers, so every one of them must
// be nullable or carry a DEFAULT. Adding a column means adding it in BOTH places
// — `create` for new installs, `added` for existing ones.
const TABLES = [
  {
    name: 'fleet_ops',
    create: `
      CREATE TABLE IF NOT EXISTS fleet_ops (
        op_id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name              TEXT    NOT NULL,
        doctrine          TEXT,
        boss_character_id INTEGER NOT NULL,
        fleet_id          INTEGER,
        started_at        INTEGER NOT NULL,
        ended_at          INTEGER,
        end_reason        TEXT,
        notes             TEXT
      )`,
    added: [],
  },
  {
    // One row per (op, pilot, hull). A pilot who swaps ships mid-fleet gets a
    // second row rather than an overwritten one, so ship changes are recorded
    // for free and "what did we actually field" survives a refit.
    name: 'fleet_op_roster',
    create: `
      CREATE TABLE IF NOT EXISTS fleet_op_roster (
        op_id        INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        ship_type_id INTEGER NOT NULL,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        PRIMARY KEY (op_id, character_id, ship_type_id)
      )`,
    added: [],
  },
  {
    name: 'fleet_op_movement',
    create: `
      CREATE TABLE IF NOT EXISTS fleet_op_movement (
        op_id           INTEGER NOT NULL,
        at              INTEGER NOT NULL,
        solar_system_id INTEGER NOT NULL,
        members_there   INTEGER NOT NULL,
        members_total   INTEGER NOT NULL,
        PRIMARY KEY (op_id, at)
      )`,
    added: [],
  },
  {
    // EVERY system any part of the fleet was seen in — which is deliberately NOT
    // the same set as fleet_op_movement.
    //
    // Movement is the readable narrative and is debounced, so a system the fleet
    // only passed through never appears in it. Kills do not care about the
    // narrative: a tackler dies on the gate of a system the fleet crossed in
    // twenty seconds, and looking for kills only where the fleet *settled* would
    // silently lose that killmail with nothing to indicate anything was missed.
    name: 'fleet_op_systems',
    create: `
      CREATE TABLE IF NOT EXISTS fleet_op_systems (
        op_id           INTEGER NOT NULL,
        solar_system_id INTEGER NOT NULL,
        first_seen      INTEGER NOT NULL,
        last_seen       INTEGER NOT NULL,
        PRIMARY KEY (op_id, solar_system_id)
      )`,
    added: [],
  },
  {
    // Kills and losses, pulled in one pass when the op closes (Phase 2).
    // Keyed on killmail_id so re-running the pull updates rather than duplicates.
    name: 'fleet_op_kills',
    create: `
      CREATE TABLE IF NOT EXISTS fleet_op_kills (
        op_id                   INTEGER NOT NULL,
        killmail_id             INTEGER NOT NULL,
        killmail_hash           TEXT,
        at                      INTEGER NOT NULL,
        solar_system_id         INTEGER,
        side                    TEXT    NOT NULL,
        victim_character_id     INTEGER,
        victim_corporation_id   INTEGER,
        victim_alliance_id      INTEGER,
        victim_ship_type_id     INTEGER,
        isk                     REAL,
        final_blow_character_id INTEGER,
        involved                INTEGER,
        npc                     INTEGER,
        PRIMARY KEY (op_id, killmail_id)
      )`,
    added: [],
  },
  {
    // What the ledger held for our own characters WHEN THE OP STARTED.
    //
    // `/characters/{id}/mining` is a DAILY RUNNING TOTAL by (date, system, type)
    // with no timestamp — there is no way to ask "what did this pilot mine
    // between 20:00 and 23:00". The only way to get an op's yield is to
    // photograph the counter at the start and subtract. This table is that
    // photograph, and without it the op can never be scored at all.
    name: 'fleet_op_mining_baseline',
    create: `
      CREATE TABLE IF NOT EXISTS fleet_op_mining_baseline (
        op_id           INTEGER NOT NULL,
        character_id    INTEGER NOT NULL,
        date            TEXT    NOT NULL,
        solar_system_id INTEGER NOT NULL,
        type_id         INTEGER NOT NULL,
        quantity        INTEGER NOT NULL,
        PRIMARY KEY (op_id, character_id, date, solar_system_id, type_id)
      )`,
    added: [],
  },
  {
    // The computed delta — what was mined DURING the op. Re-runnable: the
    // ledger is hours behind, so pulling again later corrects the numbers
    // rather than adding to them.
    name: 'fleet_op_mining',
    create: `
      CREATE TABLE IF NOT EXISTS fleet_op_mining (
        op_id           INTEGER NOT NULL,
        character_id    INTEGER NOT NULL,
        solar_system_id INTEGER NOT NULL,
        type_id         INTEGER NOT NULL,
        quantity        INTEGER NOT NULL,
        isk             REAL,
        source          TEXT    NOT NULL,
        PRIMARY KEY (op_id, character_id, solar_system_id, type_id, source)
      )`,
    added: [],
  },
];

// Finding the open op is the hottest query — every poll asks "am I recording?".
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_fleet_ops_open ON fleet_ops(ended_at, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_move_op  ON fleet_op_movement(op_id, at)`,
];

const _ensured = new WeakSet();

/**
 * Create the tables and apply any pending column migrations.
 *
 * Reads PRAGMA table_info rather than keeping a hand-maintained list of ALTERs
 * that someone has to remember to append to. Enumerating what the table
 * actually has is the only version of this that cannot drift.
 */
async function ensureFleetOpTables(db) {
  if (_ensured.has(db)) return;

  for (const t of TABLES) {
    await db.exec(t.create);
    if (!t.added.length) continue;

    const have = new Set((await db.all(`PRAGMA table_info(${t.name})`)).map((c) => c.name));
    for (const [column, decl] of t.added) {
      if (have.has(column)) continue;
      await db.run(`ALTER TABLE ${t.name} ADD COLUMN ${column} ${decl}`);
      console.log(`[fleet_ops] migration applied: ${t.name}.${column}`);
    }
  }
  for (const sql of INDEXES) await db.exec(sql);

  _ensured.add(db);
}

// ── Where is the fleet? ──────────────────────────────────────────────────────

/**
 * The system holding the largest share of the fleet.
 *
 * Ties break on the lowest system id. That is arbitrary but it must be
 * DETERMINISTIC: an even split between two systems would otherwise flap the
 * modal system on alternate polls, and the debounce below would never settle.
 *
 * @returns {{systemId:number, there:number, total:number}|null} null when
 *   nobody has a readable position — an empty fleet, or a roster read that came
 *   back without locations. Null means "no information", NOT "moved to
 *   nowhere", and callers must not record it as a position.
 */
function modalSystem(members) {
  const counts = new Map();
  let total = 0;

  for (const m of members || []) {
    const sys = m && (m.solarSystemId ?? m.solar_system_id);
    if (!sys) continue;              // no position for this pilot — skip, don't guess
    counts.set(sys, (counts.get(sys) || 0) + 1);
    total++;
  }
  if (!total) return null;

  let best = null;
  for (const [systemId, there] of counts) {
    if (!best || there > best.there || (there === best.there && systemId < best.systemId)) {
      best = { systemId, there };
    }
  }
  return { systemId: best.systemId, there: best.there, total };
}

/**
 * Turns a stream of roster polls into a movement log.
 *
 * WHY DEBOUNCE. A 40-pilot fleet taking a gate is spread over two systems for
 * as long as it takes everyone to land — several polls at 6s each. Recording
 * every modal system as it flickers produces a log that says the fleet bounced
 * back and forth four times, which is both wrong and unreadable. A new system
 * has to hold the majority for `holdPolls` consecutive polls before it counts
 * as the fleet having moved.
 *
 * The FIRST position is committed immediately: there is nothing to debounce
 * against, and an op whose log starts three polls late looks like it began
 * somewhere it did not.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.holdPolls=3] consecutive polls a new system must lead.
 */
function createMovementTracker({ holdPolls = 3 } = {}) {
  let current   = null;   // the system we have committed to
  let candidate = null;   // a different system currently leading
  let streak    = 0;      // consecutive polls `candidate` has led

  return {
    /**
     * @returns {{solarSystemId:number, membersThere:number, membersTotal:number}|null}
     *   a movement to record, or null when nothing has changed yet.
     */
    observe(members) {
      const modal = modalSystem(members);
      if (!modal) return null;        // no readable position — hold what we know

      if (modal.systemId === current) {
        candidate = null; streak = 0;  // still here; any half-formed move is off
        return null;
      }

      if (modal.systemId === candidate) streak++;
      else { candidate = modal.systemId; streak = 1; }

      const first = current === null;
      if (!first && streak < holdPolls) return null;

      current = modal.systemId;
      candidate = null; streak = 0;
      return {
        solarSystemId: modal.systemId,
        membersThere:  modal.there,
        membersTotal:  modal.total,
      };
    },

    /** Exposed for tests and for resuming a tracker against a stored log. */
    get currentSystem() { return current; },
    resumeAt(systemId) { current = systemId ?? null; candidate = null; streak = 0; },
  };
}

/**
 * Adds dwell time to a movement log.
 *
 * Dwell is what makes the report readable — "held OWN-5GQ for 14 minutes" is the
 * sentence an FC actually writes. It is derived rather than stored, because the
 * final entry's dwell is only known once the op ends.
 *
 * @param {Array}  entries    ordered movement rows (ascending `at`)
 * @param {number} [endedAt]  op end; defaults to now for a still-running op.
 */
function withDwell(entries, endedAt) {
  const rows = [...(entries || [])].sort((a, b) => a.at - b.at);
  const last = endedAt ?? Date.now();
  return rows.map((r, i) => ({
    ...r,
    dwellMs: Math.max(0, (i + 1 < rows.length ? rows[i + 1].at : last) - r.at),
  }));
}

// ── Persistence ──────────────────────────────────────────────────────────────

async function startOp(db, { name, doctrine, bossCharacterId, fleetId, at = Date.now() }) {
  await ensureFleetOpTables(db);
  const r = await db.run(
    `INSERT INTO fleet_ops (name, doctrine, boss_character_id, fleet_id, started_at)
     VALUES (?, ?, ?, ?, ?)`,
    [String(name || 'Untitled op'), doctrine || null, bossCharacterId, fleetId || null, at],
  );
  return r.lastID;
}

async function endOp(db, opId, { at = Date.now(), reason = 'stopped' } = {}) {
  await ensureFleetOpTables(db);
  // `ended_at IS NULL` guards against a double stop reopening the end time.
  await db.run(
    `UPDATE fleet_ops SET ended_at = ?, end_reason = ? WHERE op_id = ? AND ended_at IS NULL`,
    [at, reason, opId],
  );
}

/** The op still running, if any. At most one is open at a time. */
async function openOp(db) {
  await ensureFleetOpTables(db);
  return (await db.get(
    `SELECT * FROM fleet_ops WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
  )) || null;
}

/**
 * Fold one roster poll into the op.
 *
 * Roster upserts go out as ONE multi-row statement rather than a loop of 40:
 * everything in the main process shares a single SQLite connection, so 40
 * sequential awaits per poll is 40 round trips on the connection every 6
 * seconds, competing with whatever else is mid-query.
 */
async function recordRoster(db, opId, members, at = Date.now()) {
  const rows = (members || [])
    .filter((m) => m && m.characterId && m.shipTypeId)
    .map((m) => [opId, m.characterId, m.shipTypeId, at, at]);
  if (!rows.length) return 0;

  const placeholders = rows.map(() => '(?,?,?,?,?)').join(',');
  await db.run(
    `INSERT INTO fleet_op_roster (op_id, character_id, ship_type_id, first_seen, last_seen)
     VALUES ${placeholders}
     ON CONFLICT(op_id, character_id, ship_type_id)
     DO UPDATE SET last_seen = excluded.last_seen`,
    rows.flat(),
  );
  return rows.length;
}

/**
 * Note every system the fleet was seen in this poll.
 *
 * Undebounced and deliberately so — see the table comment. This is the set the
 * kill pull queries, and missing a system here means silently missing every
 * killmail in it.
 */
async function recordSystemsSeen(db, opId, members, at = Date.now()) {
  const systems = [...new Set(
    (members || [])
      .map((m) => m && (m.solarSystemId ?? m.solar_system_id))
      .filter(Boolean),
  )];
  if (!systems.length) return 0;

  const placeholders = systems.map(() => '(?,?,?,?)').join(',');
  await db.run(
    `INSERT INTO fleet_op_systems (op_id, solar_system_id, first_seen, last_seen)
     VALUES ${placeholders}
     ON CONFLICT(op_id, solar_system_id) DO UPDATE SET last_seen = excluded.last_seen`,
    systems.flatMap((s) => [opId, s, at, at]),
  );
  return systems.length;
}

/** Every system the op touched, for the kill pull. */
async function getOpSystems(db, opId) {
  await ensureFleetOpTables(db);
  return db.all(
    `SELECT solar_system_id, first_seen, last_seen FROM fleet_op_systems
      WHERE op_id = ? ORDER BY first_seen`, [opId]);
}

async function recordMovement(db, opId, move, at = Date.now()) {
  await db.run(
    `INSERT OR IGNORE INTO fleet_op_movement
       (op_id, at, solar_system_id, members_there, members_total)
     VALUES (?,?,?,?,?)`,
    [opId, at, move.solarSystemId, move.membersThere, move.membersTotal],
  );
}

/**
 * Store the result of a kill pull.
 *
 * Upserts on killmail_id so re-running a pull for the same op corrects rows
 * rather than doubling every number in the report.
 */
async function recordKills(db, opId, rows) {
  if (!rows || !rows.length) return 0;
  const cols = `(op_id, killmail_id, killmail_hash, at, solar_system_id, side,
                 victim_character_id, victim_corporation_id, victim_alliance_id,
                 victim_ship_type_id, isk, final_blow_character_id, involved, npc)`;
  const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
  await db.run(
    `INSERT INTO fleet_op_kills ${cols} VALUES ${placeholders}
     ON CONFLICT(op_id, killmail_id) DO UPDATE SET
       side = excluded.side, isk = excluded.isk, involved = excluded.involved`,
    rows.flatMap((k) => [
      opId, k.killmailId, k.killmailHash || null, k.at, k.solarSystemId || null, k.side,
      k.victimCharacterId || null, k.victimCorporationId || null, k.victimAllianceId || null,
      k.victimShipTypeId || null, k.isk ?? null, k.finalBlowCharacterId || null,
      k.involved ?? null, k.npc ? 1 : 0,
    ]),
  );
  return rows.length;
}

/**
 * Photograph the mining counters at op start.
 *
 * `INSERT OR IGNORE` so re-running never moves a baseline that has already been
 * taken — a baseline captured later would silently shrink the op's yield, and
 * the number would still look perfectly reasonable.
 */
async function saveMiningBaseline(db, opId, characterId, ledgerRows) {
  const rows = (ledgerRows || []).filter((r) => r && r.date && r.type_id);
  if (!rows.length) return 0;
  const placeholders = rows.map(() => '(?,?,?,?,?,?)').join(',');
  await db.run(
    `INSERT OR IGNORE INTO fleet_op_mining_baseline
       (op_id, character_id, date, solar_system_id, type_id, quantity)
     VALUES ${placeholders}`,
    rows.flatMap((r) => [opId, characterId, r.date, r.solar_system_id || 0, r.type_id, r.quantity || 0]),
  );
  return rows.length;
}

async function getMiningBaseline(db, opId, characterId) {
  return db.all(
    `SELECT date, solar_system_id, type_id, quantity FROM fleet_op_mining_baseline
      WHERE op_id = ? AND character_id = ?`, [opId, characterId]);
}

/** Whether a baseline was ever taken — an op started before Phase 3 has none. */
async function hasMiningBaseline(db, opId) {
  const r = await db.get(`SELECT 1 AS x FROM fleet_op_mining_baseline WHERE op_id = ? LIMIT 1`, [opId]);
  return !!r;
}

/** Replace the computed mining rows. Re-running corrects rather than accumulates. */
async function recordMining(db, opId, rows, source = 'ledger') {
  await db.run(`DELETE FROM fleet_op_mining WHERE op_id = ? AND source = ?`, [opId, source]);
  if (!rows || !rows.length) return 0;
  const placeholders = rows.map(() => '(?,?,?,?,?,?,?)').join(',');
  await db.run(
    `INSERT INTO fleet_op_mining
       (op_id, character_id, solar_system_id, type_id, quantity, isk, source)
     VALUES ${placeholders}`,
    rows.flatMap((r) => [opId, r.character_id || 0, r.solar_system_id, r.type_id,
                         r.quantity, r.isk ?? null, source]),
  );
  return rows.length;
}

/** Everything recorded for one op, ready to render or report. */
async function getOp(db, opId) {
  await ensureFleetOpTables(db);
  const op = await db.get(`SELECT * FROM fleet_ops WHERE op_id = ?`, [opId]);
  if (!op) return null;

  const roster = await db.all(
    `SELECT character_id, ship_type_id, first_seen, last_seen
       FROM fleet_op_roster WHERE op_id = ? ORDER BY first_seen`, [opId]);
  const movement = await db.all(
    `SELECT at, solar_system_id, members_there, members_total
       FROM fleet_op_movement WHERE op_id = ? ORDER BY at`, [opId]);
  const kills = await db.all(
    `SELECT * FROM fleet_op_kills WHERE op_id = ? ORDER BY at`, [opId]);
  const mining = await db.all(
    `SELECT character_id, solar_system_id, type_id, quantity, isk, source
       FROM fleet_op_mining WHERE op_id = ? ORDER BY quantity DESC`, [opId]);

  return { op, roster, movement: withDwell(movement, op.ended_at), kills, mining };
}

async function listOps(db, limit = 50) {
  await ensureFleetOpTables(db);
  return db.all(
    `SELECT o.*,
            (SELECT COUNT(DISTINCT character_id) FROM fleet_op_roster r WHERE r.op_id = o.op_id) AS pilots,
            (SELECT COUNT(*) FROM fleet_op_movement m WHERE m.op_id = o.op_id)                   AS systems
       FROM fleet_ops o ORDER BY o.started_at DESC LIMIT ?`, [limit]);
}

module.exports = {
  ensureFleetOpTables,
  modalSystem,
  createMovementTracker,
  withDwell,
  startOp,
  endOp,
  openOp,
  recordRoster,
  recordSystemsSeen,
  getOpSystems,
  recordMovement,
  recordKills,
  saveMiningBaseline,
  getMiningBaseline,
  hasMiningBaseline,
  recordMining,
  getOp,
  listOps,
};
