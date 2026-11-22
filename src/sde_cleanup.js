'use strict';
// ─── sde_cleanup.js ──────────────────────────────────────────────────────────
// Removes what SDE updates left in the temp folder.
//
// An update downloads and unpacks in <temp>/eve-carbon-sde-XXXXXX, and deletes
// the folder when it ends. Up to 4.1.3 an update could hang for ever (see
// sde_store.js), and then it never ended: about 650 MB stranded per launch. One
// machine had 220 of them, 16 GB. Closing the app mid-update strands one too,
// so this runs on every launch, not only the first one after the fix.
//
// Deleting is the one thing here that cannot be taken back, so it only ever
// touches a DIRECT child of the temp folder, whose name is exactly the prefix
// plus mkdtemp's six characters, that is a real directory (not a link), and
// that nothing has written to for an hour. Another copy of the app may be in
// the middle of an update; those take minutes.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const PREFIX = 'eve-carbon-sde-';
const NAME_RE = /^eve-carbon-sde-[A-Za-z0-9]{6}$/;
const MIN_AGE_MS = 60 * 60 * 1000;

/** Total size of a folder, and the newest write in it. Links are not followed. */
async function measure(dir) {
  let bytes = 0, newest = 0;
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const st = await fs.promises.lstat(full).catch(() => null);
    if (!st) continue;
    newest = Math.max(newest, st.mtimeMs);
    if (st.isDirectory()) {
      const sub = await measure(full).catch(() => ({ bytes: 0, newest: 0 }));
      bytes += sub.bytes;
      newest = Math.max(newest, sub.newest);
    } else bytes += st.size;
  }
  return { bytes, newest };
}

/** The leftovers: [{ path, bytes }]. */
async function findLeftovers({ tmpDir, now = Date.now(), minAgeMs = MIN_AGE_MS }) {
  let entries = [];
  try { entries = await fs.promises.readdir(tmpDir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    if (!NAME_RE.test(e.name)) continue;
    const full = path.join(tmpDir, e.name);
    try {
      const st = await fs.promises.lstat(full);
      if (!st.isDirectory()) continue;              // a link or a file wearing the name
      const m = await measure(full);
      if (now - Math.max(st.mtimeMs, m.newest) < minAgeMs) continue;
      out.push({ path: full, bytes: m.bytes });
    } catch (_) { /* gone, or not ours to read */ }
  }
  return out;
}

/** Remove them one at a time. onProgress({ done, total, freed, bytes }) after each. */
async function removeLeftovers(list, onProgress = () => {}) {
  const bytes = list.reduce((s, x) => s + x.bytes, 0);
  let done = 0, removed = 0, freed = 0;
  for (const item of list) {
    try {
      // The name and type are checked again here: the list may be seconds old.
      const st = await fs.promises.lstat(item.path);
      if (!NAME_RE.test(path.basename(item.path)) || !st.isDirectory()) throw new Error('not an SDE folder');
      await fs.promises.rm(item.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      removed++;
      freed += item.bytes;
    } catch (_) { /* in use; the next launch tries again */ }
    done++;
    onProgress({ done, total: list.length, freed, bytes });
  }
  return { removed, failed: list.length - removed, freed, bytes };
}

module.exports = { findLeftovers, removeLeftovers, PREFIX, MIN_AGE_MS };
