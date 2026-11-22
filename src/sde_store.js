'use strict';
// ─── sde_store.js ────────────────────────────────────────────────────────────
// Which SDE (CCP's static data) the app reads, and where an update is saved.
//
// Two places can hold one:
//   bundled  <app>/resources/data/sde.sql + sde.md5, shipped by the installer.
//   user     <userData>/sde/sde-<build>.sql, written by the in-app update.
//
// WHY THE UPDATE HAS ITS OWN PLACE. It used to be written beside the bundled
// one. An all-users install lives in Program Files, where the app cannot write,
// so every update failed at the first step, and failed silently (4.1.3 and
// earlier): the card sat on "Step 1 of 16" for ever, and each launch left 650 MB
// in the temp folder.
//
// WHY THE BUILD NUMBER IS IN THE FILE NAME. The app holds its SDE open, and
// Windows will not rename over an open file. The old code fell back to copying
// over it, under the feet of a live SQLite connection. A new name needs neither:
// the update lands beside the one in use, and the next launch picks it up.
//
// A dev checkout passes no userDir and keeps reading and writing data/.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

// Tables the app reads that older sde_build.js versions did not create.
const SDE_REQUIRED_TABLES = ['dgmEffectModifiers'];

const COPY_RE = /^sde-(\d+)\.sql$/;
const TMP_RE  = /^sde-\d+\.sql\..*tmp(-journal|-wal|-shm)?$/;
// Beside the bundled one: 4.1.3 and earlier wrote sde.sql.tmp there, a dev checkout
// writes sde.sql.<pid>-<hex>.tmp. (An all-users folder can't be written, or tidied.)
const BUNDLED_TMP_RE = /^sde\.sql\.(\d+-[0-9a-f]+\.)?tmp(-journal|-wal|-shm)?$/;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;   // an update in another process is minutes, never an hour

/**
 * Can this file be used as an SDE? { ok, schemaOk }: ok = it opens and holds
 * types; schemaOk = it also has every table this version of the app reads.
 */
function inspectSde(file) {
  return new Promise((resolve) => {
    if (!file || !fs.existsSync(file)) return resolve({ ok: false, schemaOk: false });
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return resolve({ ok: false, schemaOk: false });
      const done = (r) => db.close(() => resolve(r));
      db.get('SELECT typeID FROM invTypes LIMIT 1', (err, row) => {
        if (err || !row) return done({ ok: false, schemaOk: false });
        const ph = SDE_REQUIRED_TABLES.map(() => '?').join(',');
        db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${ph})`, SDE_REQUIRED_TABLES,
          (e, rows) => done({ ok: true, schemaOk: !e && (rows || []).length === SDE_REQUIRED_TABLES.length }));
      });
    });
  });
}

function createSdeStore({ bundledDir, userDir = null }) {
  const bundledPath = path.join(bundledDir, 'sde.sql');
  const bundledVersionPath = path.join(bundledDir, 'sde.md5');

  function bundled() {
    if (!fs.existsSync(bundledPath)) return null;
    let build = 0;
    try { build = parseInt(fs.readFileSync(bundledVersionPath, 'utf8').trim(), 10) || 0; } catch (_) { /* no version file */ }
    return { path: bundledPath, build, source: 'bundled' };
  }

  function userCopies() {
    if (!userDir) return [];
    let names = [];
    try { names = fs.readdirSync(userDir); } catch (_) { return []; }
    return names.map(n => ({ n, m: COPY_RE.exec(n) })).filter(x => x.m)
      .map(x => ({ path: path.join(userDir, x.n), build: Number(x.m[1]), source: 'user' }))
      .sort((a, b) => b.build - a.build);
  }

  /**
   * The SDE to use: the newest that opens and has the current schema. On a tie
   * the bundled one wins (nothing is gained by keeping a second copy). A file
   * with an older schema is used only when there is nothing better.
   * { path, build, source, schemaOk } or null.
   */
  async function pick() {
    const all = [bundled(), ...userCopies()].filter(Boolean);
    const usable = [];
    for (const c of all) {
      const r = await inspectSde(c.path);
      if (r.ok) usable.push({ ...c, schemaOk: r.schemaOk });
    }
    usable.sort((a, b) => (b.schemaOk - a.schemaOk) || (b.build - a.build)
      || (a.source === 'bundled' ? -1 : 1));
    return usable[0] || null;
  }

  /** Where an update to this build is written. */
  function targetFor(build) {
    return userDir ? path.join(userDir, `sde-${Number(build)}.sql`) : bundledPath;
  }

  /** Record an update written to targetFor(). The user copy carries its build in its name. */
  function recordBuild(build) {
    if (!userDir) fs.writeFileSync(bundledVersionPath, String(build), 'utf8');
  }

  /**
   * Drop the user copies that are not `keepPath`, and what an interrupted update
   * left half-written. Run at launch, when nothing but `keepPath` is open.
   */
  function tidy(keepPath, now = Date.now()) {
    const removed = [];
    const list = (dir) => { try { return fs.readdirSync(dir); } catch (_) { return []; } };
    const drop = (full) => {
      try { fs.unlinkSync(full); removed.push(path.basename(full)); } catch (_) { /* in use, or not ours to write; next launch */ }
    };
    const isOld = (full) => {
      try { return now - fs.statSync(full).mtimeMs > TMP_MAX_AGE_MS; } catch (_) { return false; }
    };
    for (const n of userDir ? list(userDir) : []) {
      const full = path.join(userDir, n);
      if (full === keepPath) continue;
      if (COPY_RE.test(n) || (TMP_RE.test(n) && isOld(full))) drop(full);
    }
    for (const n of list(bundledDir)) {
      const full = path.join(bundledDir, n);
      if (BUNDLED_TMP_RE.test(n) && isOld(full)) drop(full);
    }
    return removed;
  }

  return { pick, bundled, userCopies, targetFor, recordBuild, tidy, dir: userDir || bundledDir };
}

module.exports = { createSdeStore, inspectSde, SDE_REQUIRED_TABLES };
