'use strict';
// ─── upkeep.js ───────────────────────────────────────────────────────────────
// Clears what EVE Carbon leaves behind between versions and over months of use.
// Runs once, a minute after launch, and says nothing.
//
// The rule for anything listed here: the app would never read it again. Not "is
// probably old", but cannot be used, or costs one request to have back:
//
//   installers   The in-app update downloads EVE-Carbon-Setup-<time>.exe to the
//                temp folder, runs it and quits. Nothing ever deleted it: 160 MB
//                a version.
//   store copy   electron-builder's installer keeps a copy of itself for
//                electron-updater, which this app doesn't use: 160 MB.
//   cache        cache/<key>.json carries its own expiry, and readCache() deletes
//                an expired one when it is next asked for. A key nobody asks for
//                again (a type's old price, a structure's name) stayed for good.
//   etags        cache/esi-etag/<hash>.json, untouched for 30 days. Losing one
//                costs one full ESI answer instead of a 304.
//
// Settings, characters, fits, packs, themes, sounds, backgrounds and logs are
// not here and must not be: those are the user's. SDE leftovers are
// sde_cleanup.js (they explain themselves) and sde_store.js.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const INSTALLER_RE = /^EVE-Carbon-Setup-\d{13}\.exe$/;   // updater_ipc.js's name for it
const ETAG_RE = /^[0-9a-f]{40}\.json$/;                  // sha1 of the URL
const ETAG_MAX_AGE_MS = 30 * DAY;

/** Delete `file` unless it changed since `st` was taken. Bytes freed, or 0. */
async function removeIfUnchanged(file, st) {
  try {
    const now = await fs.promises.lstat(file);
    if (!now.isFile() || now.mtimeMs !== st.mtimeMs || now.size !== st.size) return 0;
    await fs.promises.unlink(file);
    return st.size || 1;
  } catch (_) { return 0; }   // in use or gone: next launch
}

/** Files directly in `dir` whose name passes `wanted`, with their stat. */
async function listFiles(dir, wanted) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!wanted(n)) continue;
    const file = path.join(dir, n);
    try {
      const st = await fs.promises.lstat(file);
      if (st.isFile()) out.push({ file, st });
    } catch (_) { /* gone */ }
  }
  return out;
}

async function sweep(list, keep) {
  let files = 0, bytes = 0;
  for (const { file, st } of list) {
    if (await keep(file, st)) continue;
    const freed = await removeIfUnchanged(file, st);
    if (freed) { files++; bytes += freed; }
  }
  return { files, bytes };
}

/** Is this one of our cache entries, and past its own expiry? */
async function cacheExpired(file, now) {
  try {
    const e = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return !!e && Number.isFinite(e.ts) && Number.isFinite(e.ttl) && 'v' in e && now - e.ts > e.ttl;
  } catch (_) { return false; }   // not ours to judge
}

/**
 * @param {{ tmpDir?: string, updaterDir?: string, cacheDir?: string, etagDir?: string, now?: number }} opts
 *   Any place left out is skipped.
 * @returns {Promise<{ files: number, bytes: number, parts: object }>}
 */
async function runUpkeep({ tmpDir, updaterDir, cacheDir, etagDir, now = Date.now() }) {
  const parts = {};
  const old = (ms) => (_f, st) => now - st.mtimeMs < ms;
  if (tmpDir)     parts.installers = await sweep(await listFiles(tmpDir, n => INSTALLER_RE.test(n)), old(HOUR));
  if (updaterDir) parts.storeCopy  = await sweep(await listFiles(updaterDir, n => n === 'installer.exe'), old(HOUR));
  if (cacheDir)   parts.cache      = await sweep(await listFiles(cacheDir, n => n.endsWith('.json')), async (f) => !(await cacheExpired(f, now)));
  if (etagDir)    parts.etags      = await sweep(await listFiles(etagDir, n => ETAG_RE.test(n)), old(ETAG_MAX_AGE_MS));
  const total = Object.values(parts).reduce((s, p) => ({ files: s.files + p.files, bytes: s.bytes + p.bytes }), { files: 0, bytes: 0 });
  return { ...total, parts };
}

module.exports = { runUpkeep };
