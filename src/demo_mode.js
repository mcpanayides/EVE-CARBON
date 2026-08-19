'use strict';
//
// Demo mode — runs the app against a self-contained, fully-populated fake
// profile so every page has something real to show. Built for recording
// walkthroughs and screenshots, and for handing someone a build they can click
// around without an EVE account or an ESI login.
//
// Enable with either:
//   npm start -- --demo            (or: electron . --demo)
//   EVE_CARBON_DEMO=1 npm start
//
// Extra switches:
//   --demo-keep            don't wipe the demo profile on launch (set up a view,
//                          then re-record without it resetting under you)
//   --demo-size=1600x900   exact CONTENT size, so recordings aren't scaled
//
// ── ISOLATION IS THE WHOLE POINT ──────────────────────────────────────────────
// Two separate redirects are needed, and missing either one would write fake
// data over something real:
//
//   userData             → <appData>/EVE Carbon Demo
//        config, accounts, caches, saved layouts
//   EVE_CARBON_DATA_DIR  → <appData>/EVE Carbon Demo/data
//        character_information.db and jabber_data.db, which normally live in the
//        app's own data/ folder BESIDE sde.sql (see initPaths in main.js) — i.e.
//        the developer's real character database. Seeding without this redirect
//        would overwrite it.
//
// sde.sql is NOT redirected: getSdePath() always resolves it relative to the
// app itself, and it's read-only static data, so the demo shares the real one
// rather than needing a 115 MB copy.
//
// Everything here is best-effort. isEnabled() is false on a normal launch and
// nothing else in this file runs; if seeding throws, the app still starts (with
// an emptier demo) rather than failing to open.

const fs   = require('fs');
const path = require('path');

const FLAG      = '--demo';
const KEEP_FLAG = '--demo-keep';
const SIZE_FLAG = '--demo-size=';

// 16:9 at a size that still fits on a 1080p display with room for the OS chrome.
// Recording at exact content size avoids the soft, resampled look you get from
// scaling a mismatched capture region.
const DEFAULT_SIZE = { width: 1600, height: 900 };

function _argv() {
  // process.argv differs between `electron .` and a packaged build; scanning the
  // whole array rather than indexing keeps both working.
  return Array.isArray(process.argv) ? process.argv : [];
}

// ── The real profile's location, captured before anything is redirected ───────
// The Settings toggle has to read and write the REAL config.json, never the
// demo one. Once redirectPaths() has run, app.getPath('userData') answers with
// the demo directory — and the demo directory is wiped on every launch. A
// toggle that wrote there would appear to work, vanish on restart, and leave
// the app permanently stuck in demo mode with no way out through the UI.
//
// So the real path is captured once, before the redirect, and every config
// read/write below goes through it.
let _realUserData = null;

function realUserDataPath(app) {
  if (!_realUserData && app) {
    try { _realUserData = app.getPath('userData'); } catch (_) { /* not ready yet */ }
  }
  return _realUserData;
}

function _realConfigPath(app) {
  const dir = realUserDataPath(app);
  return dir ? path.join(dir, 'config.json') : null;
}

/** `app.demoMode` from the real config — the Settings toggle's persisted value. */
function _configSaysDemo(app) {
  const cfgPath = _realConfigPath(app);
  if (!cfgPath) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return !!(cfg && cfg.app && cfg.app.demoMode);
  } catch (_) { return false; }   // absent or malformed config is not a demo launch
}

/**
 * Is this a demo launch?
 *
 * Three ways in, checked in order of explicitness: the CLI flag, the env var,
 * then the persisted Settings toggle. `app` is optional — without it only the
 * first two are consulted, which is what keeps this callable before Electron is
 * ready and from unit tests.
 */
function isEnabled(app) {
  if (_argv().includes(FLAG)) return true;
  if (/^(1|true|yes)$/i.test(String(process.env.EVE_CARBON_DEMO || ''))) return true;
  return _configSaysDemo(app);
}

/**
 * Persist the Settings toggle. Always writes the REAL config, so it works
 * identically whether the app is currently running a demo profile or not —
 * which is the only way "turn demo mode off" can work from inside demo mode.
 *
 * Takes effect on the next launch: the profile redirect happens at boot, long
 * before any window exists.
 *
 * @returns {boolean} the value actually persisted
 */
function setEnabled(app, enabled) {
  const cfgPath = _realConfigPath(app);
  if (!cfgPath) throw new Error('demo mode: real config path is not known yet');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch (_) { cfg = {}; }
  cfg.app = cfg.app || {};
  cfg.app.demoMode = !!enabled;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return !!enabled;
}

/** Keep the existing demo profile instead of rebuilding it. */
function shouldKeep() {
  return _argv().includes(KEEP_FLAG) ||
         /^(1|true|yes)$/i.test(String(process.env.EVE_CARBON_DEMO_KEEP || ''));
}

/** Content size for the main window, from --demo-size=WxH or the default. */
function windowSize() {
  const arg = _argv().find(a => a.startsWith(SIZE_FLAG));
  const raw = arg ? arg.slice(SIZE_FLAG.length) : String(process.env.EVE_CARBON_DEMO_SIZE || '');
  const m   = /^(\d{3,5})x(\d{3,5})$/.exec(raw.trim());
  if (!m) return { ...DEFAULT_SIZE };
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * Point the app at the demo profile. MUST be called before
 * app.requestSingleInstanceLock() and before initPaths():
 *   • the single-instance lock is keyed on userData, so redirecting first lets a
 *     demo instance run alongside a normal one instead of quitting on the lock;
 *   • initPaths() reads app.getPath('userData') and process.env.EVE_CARBON_DATA_DIR
 *     once, and everything downstream uses its results.
 *
 * @returns {{userDataDir: string, dataDir: string}|null} null when not a demo launch
 */
function redirectPaths(app) {
  realUserDataPath(app);          // capture the real profile BEFORE any setPath
  if (!isEnabled(app)) return null;
  // Sibling of the real profile, not inside it — so "delete the demo" is a
  // single obvious folder and can never take real data with it.
  const userDataDir = path.join(app.getPath('appData'), 'EVE Carbon Demo');
  const dataDir     = path.join(userDataDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  app.setPath('userData', userDataDir);
  process.env.EVE_CARBON_DATA_DIR = dataDir;

  console.log(`[demo] profile: ${userDataDir}`);
  return { userDataDir, dataDir };
}

/**
 * Wipe the demo profile so every launch starts from the same state — the thing
 * that makes takes reproducible when you re-record one segment.
 *
 * Deliberately narrow: it removes only known-generated files rather than
 * rm -rf'ing the directory, because getting a path wrong in a recursive delete
 * is the one mistake here with real consequences.
 */
function reset({ userDataDir, dataDir }) {
  if (shouldKeep()) { console.log('[demo] --demo-keep: existing profile left alone'); return; }
  const targets = [
    path.join(userDataDir, 'blueprints.json'),
    path.join(userDataDir, 'config.json'),
    path.join(userDataDir, 'modern-map-layout.auto.json'),
    path.join(dataDir, 'character_information.db'),
    path.join(dataDir, 'character_information.db-shm'),
    path.join(dataDir, 'character_information.db-wal'),
  ];
  for (const t of targets) {
    try { if (fs.existsSync(t)) fs.rmSync(t, { force: true }); }
    catch (e) { console.warn(`[demo] could not clear ${path.basename(t)}: ${e.message}`); }
  }
  // The cache directory holds two unrelated things: our own dashboard snapshots
  // (dash_snap_*.json — RENDERED HTML, 7-day TTL) and Electron's HTTP cache
  // (Cache_Data), which is LOCKED while a previous instance is still exiting.
  //
  // This used to be one recursive rmSync in an empty catch. A single locked
  // entry made the whole call throw, the failure was swallowed, and the stale
  // snapshots survived — so a widget kept rendering last week's "No active corp
  // industry jobs" no matter what the fixtures returned. Clearing entry by entry
  // means a locked Electron cache can no longer protect our own snapshots, and
  // anything that does fail is reported rather than hidden.
  const cacheDir = path.join(userDataDir, 'cache');
  let stuck = 0;
  try {
    for (const entry of fs.readdirSync(cacheDir)) {
      try { fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true }); }
      catch (_) { stuck++; }
    }
  } catch (_) { /* no cache dir yet — nothing to clear */ }
  if (stuck) console.warn(`[demo] ${stuck} cache entr${stuck === 1 ? 'y' : 'ies'} were locked and left in place`);
}

/** Apply demo overrides to the main window's BrowserWindow options. */
function windowOptions(base) {
  // No `app` needed: by the time a window is created, redirectPaths() has
  // already cached the real path, so the config check works from the cache.
  if (!isEnabled()) return base;
  const { width, height } = windowSize();
  return { ...base, width, height, center: true };
}

module.exports = {
  isEnabled, setEnabled, shouldKeep, windowSize, redirectPaths, reset,
  windowOptions, realUserDataPath, DEFAULT_SIZE,
};
