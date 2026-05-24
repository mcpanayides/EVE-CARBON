// ─── character_info_db.js ─────────────────────────────────────────────────────
// Manages the character_information.db SQLite database in /data.
// Each character gets its own set of tables prefixed by characterId.
// Called from main.js via require('./src/character_info_db').
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const path    = require('path');
const fs      = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

let charDb = null;   // shared db handle, opened once

// ── DB init ───────────────────────────────────────────────────────────────────
async function initCharacterDb(dataDir) {
  if (charDb) return charDb;

  // Ensure /data folder exists next to the app root (not in userData)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbFile = path.join(dataDir, 'character_information.db');
  charDb = await open({ filename: dbFile, driver: sqlite3.Database });

  // Enable WAL for concurrent reads
  await charDb.run('PRAGMA journal_mode=WAL');
  await charDb.run('PRAGMA foreign_keys=ON');

  console.log(`[CharDB] Opened: ${dbFile}`);
  return charDb;
}

// ── Per-character table creation ──────────────────────────────────────────────
// All tables are prefixed with char_{characterId}_ so multiple characters
// live safely in the same database file.
async function ensureCharacterTables(characterId) {
  const db = charDb;
  const p  = `char_${characterId}`;

  await db.exec(`
    -- Basic character info (one row, upserted)
    CREATE TABLE IF NOT EXISTS ${p}_info (
      character_id    INTEGER PRIMARY KEY,
      character_name  TEXT,
      corporation_id  INTEGER,
      alliance_id     INTEGER,
      birthday        TEXT,
      description     TEXT,
      gender          TEXT,
      race_id         INTEGER,
      bloodline_id    INTEGER,
      security_status REAL,
      synced_at       INTEGER
    );

    -- Wallet balance history (one row per sync)
    CREATE TABLE IF NOT EXISTS ${p}_wallet (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      balance      REAL,
      synced_at    INTEGER
    );

    -- Current location
    CREATE TABLE IF NOT EXISTS ${p}_location (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      solar_system_id   INTEGER,
      solar_system_name TEXT,
      station_id        INTEGER,
      station_name      TEXT,
      structure_id      INTEGER,
      synced_at         INTEGER
    );

    -- Current ship
    CREATE TABLE IF NOT EXISTS ${p}_ship (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ship_item_id  INTEGER,
      ship_type_id  INTEGER,
      ship_name     TEXT,
      ship_type_name TEXT,
      synced_at     INTEGER
    );

    -- Implants (all installed, including active set)
    CREATE TABLE IF NOT EXISTS ${p}_implants (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      implant_id   INTEGER,
      type_name    TEXT,
      slot         INTEGER,
      synced_at    INTEGER
    );

    -- Clone jump clones (alpha/beta clones with their implants)
    CREATE TABLE IF NOT EXISTS ${p}_jump_clones (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      jump_clone_id   INTEGER,
      location_id     INTEGER,
      location_name   TEXT,
      clone_name      TEXT,
      implants_json   TEXT,
      synced_at       INTEGER
    );

    -- Planetary Interaction colonies
    CREATE TABLE IF NOT EXISTS ${p}_pi_colonies (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      planet_id        INTEGER,
      planet_type      TEXT,
      solar_system_id  INTEGER,
      solar_system_name TEXT,
      upgrade_level    INTEGER,
      num_pins         INTEGER,
      last_update      INTEGER,
      synced_at        INTEGER
    );

    -- Assets (full inventory)
    CREATE TABLE IF NOT EXISTS ${p}_assets (
      item_id            INTEGER PRIMARY KEY,
      type_id            INTEGER,
      type_name          TEXT,
      location_id        INTEGER,
      location_name      TEXT,
      location_flag      TEXT,
      quantity           INTEGER,
      is_singleton       INTEGER,
      solar_system_id    INTEGER,
      solar_system_name  TEXT,
      region_id          INTEGER,
      region_name        TEXT,
      security_status    REAL,
      synced_at          INTEGER
    );

    -- Blueprints
    CREATE TABLE IF NOT EXISTS ${p}_blueprints (
      item_id           INTEGER PRIMARY KEY,
      type_id           INTEGER,
      type_name         TEXT,
      location_id       INTEGER,
      location_flag     TEXT,
      quantity          INTEGER,
      runs              INTEGER,
      me                INTEGER,
      te                INTEGER,
      is_bpc            INTEGER,
      synced_at         INTEGER
    );
  `);
}

// ── Upsert helpers ────────────────────────────────────────────────────────────

async function upsertCharacterInfo(characterId, info) {
  const db  = charDb;
  const p   = `char_${characterId}`;
  const now = Date.now();
  await db.run(`
    INSERT INTO ${p}_info
      (character_id, character_name, corporation_id, alliance_id, birthday,
       description, gender, race_id, bloodline_id, security_status, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(character_id) DO UPDATE SET
      character_name  = excluded.character_name,
      corporation_id  = excluded.corporation_id,
      alliance_id     = excluded.alliance_id,
      birthday        = excluded.birthday,
      description     = excluded.description,
      gender          = excluded.gender,
      race_id         = excluded.race_id,
      bloodline_id    = excluded.bloodline_id,
      security_status = excluded.security_status,
      synced_at       = excluded.synced_at
  `, [
    characterId,
    info.name || '',
    info.corporation_id || null,
    info.alliance_id    || null,
    info.birthday       || null,
    info.description    || null,
    info.gender         || null,
    info.race_id        || null,
    info.bloodline_id   || null,
    info.security_status || null,
    now,
  ]);
}

async function insertWalletSnapshot(characterId, balance) {
  const db = charDb;
  await db.run(
    `INSERT INTO char_${characterId}_wallet (balance, synced_at) VALUES (?,?)`,
    [balance, Date.now()]
  );
}

async function upsertLocation(characterId, loc, stationName) {
  const db  = charDb;
  const now = Date.now();
  await db.run(
    `INSERT INTO char_${characterId}_location
       (solar_system_id, solar_system_name, station_id, station_name, structure_id, synced_at)
     VALUES (?,?,?,?,?,?)`,
    [
      loc.solar_system_id  || null,
      loc.solar_system_name|| null,
      loc.station_id       || null,
      stationName          || null,
      loc.structure_id     || null,
      now,
    ]
  );
}

async function upsertShip(characterId, ship, typeName) {
  const db  = charDb;
  const now = Date.now();
  await db.run(
    `INSERT INTO char_${characterId}_ship
       (ship_item_id, ship_type_id, ship_name, ship_type_name, synced_at)
     VALUES (?,?,?,?,?)`,
    [ship.ship_item_id || null, ship.ship_type_id || null,
     ship.ship_name   || null, typeName || null, now]
  );
}

async function replaceImplants(characterId, implants) {
  const db  = charDb;
  const now = Date.now();
  const p   = `char_${characterId}`;
  await db.run(`DELETE FROM ${p}_implants`);
  for (const imp of implants) {
    await db.run(
      `INSERT INTO ${p}_implants (implant_id, type_name, slot, synced_at)
       VALUES (?,?,?,?)`,
      [imp.implant_id, imp.type_name || '', imp.slot || null, now]
    );
  }
}

async function replaceJumpClones(characterId, clones) {
  const db  = charDb;
  const now = Date.now();
  const p   = `char_${characterId}`;
  await db.run(`DELETE FROM ${p}_jump_clones`);
  for (const c of clones) {
    await db.run(
      `INSERT INTO ${p}_jump_clones
         (jump_clone_id, location_id, location_name, clone_name, implants_json, synced_at)
       VALUES (?,?,?,?,?,?)`,
      [
        c.jump_clone_id  || null,
        c.location_id    || null,
        c.location_name  || null,
        c.name           || null,
        JSON.stringify(c.implants || []),
        now,
      ]
    );
  }
}

async function replacePiColonies(characterId, colonies) {
  const db  = charDb;
  const now = Date.now();
  const p   = `char_${characterId}`;
  await db.run(`DELETE FROM ${p}_pi_colonies`);
  for (const col of colonies) {
    await db.run(
      `INSERT INTO ${p}_pi_colonies
         (planet_id, planet_type, solar_system_id, solar_system_name,
          upgrade_level, num_pins, last_update, synced_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        col.planet_id          || null,
        col.planet_type        || null,
        col.solar_system_id    || null,
        col.solar_system_name  || null,
        col.upgrade_level      || 0,
        col.num_pins           || 0,
        col.last_update        || null,
        now,
      ]
    );
  }
}

async function replaceAssets(characterId, assets) {
  const db  = charDb;
  const now = Date.now();
  const p   = `char_${characterId}`;
  await db.run(`DELETE FROM ${p}_assets`);
  // Insert in batches of 500
  for (let i = 0; i < assets.length; i += 500) {
    const batch = assets.slice(i, i + 500);
    await db.run('BEGIN');
    for (const a of batch) {
      await db.run(
        `INSERT OR REPLACE INTO ${p}_assets
           (item_id, type_id, type_name, location_id, location_name,
            location_flag, quantity, is_singleton, solar_system_id,
            solar_system_name, region_id, region_name, security_status, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          a.item_id, a.type_id, a.name || a.type_name || '',
          a.location_id, a.location_name || '', a.location_flag || '',
          a.quantity || 1, a.is_singleton ? 1 : 0,
          a.solar_system_id || null, a.solar_system_name || null,
          a.region_id || null, a.region_name || null,
          a.security_status != null ? a.security_status : null,
          now,
        ]
      );
    }
    await db.run('COMMIT');
  }
}

async function replaceBlueprints(characterId, blueprints) {
  const db  = charDb;
  const now = Date.now();
  const p   = `char_${characterId}`;
  await db.run(`DELETE FROM ${p}_blueprints`);
  await db.run('BEGIN');
  for (const bp of blueprints) {
    await db.run(
      `INSERT OR REPLACE INTO ${p}_blueprints
         (item_id, type_id, type_name, location_id, location_flag,
          quantity, runs, me, te, is_bpc, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        bp.item_id, bp.type_id, bp.name || '',
        bp.location_id, bp.location_flag || '',
        bp.quantity, bp.runs, bp.me, bp.te,
        bp.isBPC ? 1 : 0, now,
      ]
    );
  }
  await db.run('COMMIT');
}

// ── Read helpers (for IPC get handlers) ──────────────────────────────────────

async function getCharacterData(characterId) {
  if (!charDb) return null;
  const p = `char_${characterId}`;
  try {
    const info       = await charDb.get(`SELECT * FROM ${p}_info WHERE character_id=?`, characterId);
    const wallet     = await charDb.get(`SELECT * FROM ${p}_wallet ORDER BY id DESC LIMIT 1`);
    const location   = await charDb.get(`SELECT * FROM ${p}_location ORDER BY id DESC LIMIT 1`);
    const ship       = await charDb.get(`SELECT * FROM ${p}_ship ORDER BY id DESC LIMIT 1`);
    const implants   = await charDb.all(`SELECT * FROM ${p}_implants ORDER BY slot ASC`);
    const jumpClones = await charDb.all(`SELECT * FROM ${p}_jump_clones ORDER BY id ASC`);
    const piColonies = await charDb.all(`SELECT * FROM ${p}_pi_colonies ORDER BY id ASC`);
    return { info, wallet, location, ship, implants, jumpClones, piColonies };
  } catch (e) {
    return null;
  }
}

async function getCharacterAssets(characterId) {
  if (!charDb) return [];
  try {
    return await charDb.all(`SELECT * FROM char_${characterId}_assets ORDER BY type_name ASC`);
  } catch (e) { return []; }
}

async function getCharacterBlueprints(characterId) {
  if (!charDb) return [];
  try {
    return await charDb.all(`SELECT * FROM char_${characterId}_blueprints ORDER BY type_name ASC`);
  } catch (e) { return []; }
}

async function removeCharacterData(characterId) {
  if (!charDb) return;
  const p = `char_${characterId}`;
  const tables = ['info','wallet','location','ship','implants','jump_clones','pi_colonies','assets','blueprints'];
  for (const t of tables) {
    try { await charDb.run(`DROP TABLE IF EXISTS ${p}_${t}`); } catch (_) {}
  }
  console.log(`[CharDB] Removed all tables for character ${characterId}`);
}

module.exports = {
  initCharacterDb,
  ensureCharacterTables,
  upsertCharacterInfo,
  insertWalletSnapshot,
  upsertLocation,
  upsertShip,
  replaceImplants,
  replaceJumpClones,
  replacePiColonies,
  replaceAssets,
  replaceBlueprints,
  getCharacterData,
  getCharacterAssets,
  getCharacterBlueprints,
  removeCharacterData,
};
