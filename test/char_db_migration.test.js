'use strict';
//
// Moving character_information.db out of the install directory.
//
// Older builds created it beside sde.sql inside the app's own resources folder.
// That works for a per-user install (%LOCALAPPDATA%\Programs\… is writable) and
// fails outright for an all-users install: the app lives in Program Files, the
// process is not elevated, and SQLite cannot even create the -wal/-shm files WAL
// mode requires. It also meant every Windows account on a shared machine read
// the same characters and tokens, and that an update — which replaces
// resources/ wholesale — deleted the database.
//
// The database now lives in userData. These tests cover the one-way trip.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { migrateLegacyDatabase } = require('../src/character_info_db');

const DB = 'character_information.db';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evecarbon-chardb-'));
}

test('a database left in the install directory is brought across', () => {
  const legacy = tmp(), target = tmp();
  fs.writeFileSync(path.join(legacy, DB), 'the user characters');

  assert.strictEqual(migrateLegacyDatabase(legacy, target), true);
  assert.strictEqual(fs.readFileSync(path.join(target, DB), 'utf8'), 'the user characters');
  // Copied, not moved: the install directory may be read-only, and a failed
  // delete must not cost the user their data.
  assert.ok(fs.existsSync(path.join(legacy, DB)), 'the original was removed');
});

test('the WAL sidecar comes too', () => {
  const legacy = tmp(), target = tmp();
  fs.writeFileSync(path.join(legacy, DB), 'base');
  fs.writeFileSync(path.join(legacy, `${DB}-wal`), 'committed since last checkpoint');
  fs.writeFileSync(path.join(legacy, `${DB}-shm`), 'shared memory');

  migrateLegacyDatabase(legacy, target);
  // Without the -wal file every transaction since the last checkpoint is lost,
  // which for this app is the most recent sync of every character.
  assert.strictEqual(fs.readFileSync(path.join(target, `${DB}-wal`), 'utf8'),
    'committed since last checkpoint');
  assert.ok(fs.existsSync(path.join(target, `${DB}-shm`)));
});

test('an existing database is never overwritten', () => {
  const legacy = tmp(), target = tmp();
  fs.writeFileSync(path.join(legacy, DB), 'stale copy from the install dir');
  fs.writeFileSync(path.join(target, DB), 'the live database');

  assert.strictEqual(migrateLegacyDatabase(legacy, target), false);
  assert.strictEqual(fs.readFileSync(path.join(target, DB), 'utf8'), 'the live database');
});

test('nothing to migrate is not a failure', () => {
  const legacy = tmp(), target = tmp();
  assert.strictEqual(migrateLegacyDatabase(legacy, target), false);
  assert.strictEqual(fs.existsSync(path.join(target, DB)), false);
});

test('a missing target directory is created', () => {
  const legacy = tmp();
  const target = path.join(tmp(), 'nested', 'userData');
  fs.writeFileSync(path.join(legacy, DB), 'data');

  assert.strictEqual(migrateLegacyDatabase(legacy, target), true);
  assert.ok(fs.existsSync(path.join(target, DB)));
});

test('same source and target is a no-op, not a self-copy', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, DB), 'data');
  assert.strictEqual(migrateLegacyDatabase(dir, dir), false);
  assert.strictEqual(migrateLegacyDatabase(null, dir), false);
  assert.strictEqual(migrateLegacyDatabase(dir, null), false);
});

test('an unreadable source is reported, not thrown', () => {
  // A source that cannot be copied (here: a directory where a file is expected)
  // must leave the app able to start with an empty database rather than crash
  // during boot.
  const legacy = tmp(), target = tmp();
  fs.mkdirSync(path.join(legacy, DB));
  assert.strictEqual(migrateLegacyDatabase(legacy, target), false);
});
