// ─── resfile_backgrounds.js ───────────────────────────────────────────────────
// Background-wallpaper presets sourced live from CCP's resfile CDN (via
// src/resfile.js) instead of bundling duplicate JPGs in assets/backgrounds/.
// Fetched once and cached to userData/resfile-cache/ — after that, listing is
// a pure disk read with zero network calls, same as a bundled preset.
//
// Curated 2026-07-20 from CCP's own character-creation background plates
// (graphics/character/global/paperdolllibrary/backgrounds/ — visually reviewed
// against build 3439610), picked for being large (2800x1200+), cinematic, and
// free of baked-in UI/text overlays that would clash with the app's own chrome.
// ─────────────────────────────────────────────────────────────────────────────

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const resfile = require('./resfile');

const RESFILE_BACKGROUND_PRESETS = [
  { id: 'citadel-overlook',   name: 'Citadel Overlook',   path: 'graphics/character/global/paperdolllibrary/backgrounds/a trailercitadel.png' },
  { id: 'crimson-corridor',   name: 'Crimson Corridor',   path: 'graphics/character/global/paperdolllibrary/backgrounds/a trailerdust.png' },
  { id: 'amber-horizon',      name: 'Amber Horizon',      path: 'graphics/character/global/paperdolllibrary/backgrounds/a ue 1.png' },
  { id: 'clone-bay',          name: 'Clone Bay',          path: 'graphics/character/global/paperdolllibrary/backgrounds/a trailerawakening.png' },
  { id: 'citadel-silhouette', name: 'Citadel Silhouette', path: 'graphics/character/global/paperdolllibrary/backgrounds/a trailercitadel 3.png' },
];

function _assetsDir(cacheDir)          { return path.join(cacheDir, 'assets'); }
function _resolvedCachePath(cacheDir)  { return path.join(cacheDir, 'resolved.json'); }
function _assetPath(cacheDir, preset)  { return path.join(_assetsDir(cacheDir), preset.id + (path.extname(preset.path) || '.png')); }

function _readResolvedCache(cacheDir) {
  try { return JSON.parse(fs.readFileSync(_resolvedCachePath(cacheDir), 'utf8')); }
  catch { return null; }
}
function _writeResolvedCache(cacheDir, data) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(_resolvedCachePath(cacheDir), JSON.stringify(data), 'utf8');
  } catch (_) { /* best-effort — a failed write just costs a re-resolve next call */ }
}

// Fetches+caches whatever presets aren't already on disk. Never throws — a
// network hiccup just leaves those presets uncached for this call/run; the
// next call (or the next app launch) tries again.
async function _ensureCached(userAgent, cacheDir) {
  fs.mkdirSync(_assetsDir(cacheDir), { recursive: true });

  const missing = RESFILE_BACKGROUND_PRESETS.filter(p => !fs.existsSync(_assetPath(cacheDir, p)));
  if (!missing.length) return;

  let resolvedEntries;
  const cached = _readResolvedCache(cacheDir);
  if (cached?.entries && missing.every(p => cached.entries[p.path])) {
    // A previous run already resolved these cdnPaths (e.g. it was interrupted
    // after resolving but before all bytes were fetched) — skip the ~20MB
    // resfileindex re-download and reuse them.
    resolvedEntries = cached.entries;
  } else {
    try {
      const { buildNumber, resolved } = await resfile.resolveResourcePaths(
        missing.map(p => p.path), userAgent
      );
      resolvedEntries = resolved;
      _writeResolvedCache(cacheDir, { buildNumber, entries: resolved });
    } catch (e) {
      console.warn('[resfile] failed to resolve background paths:', e.message);
      return;
    }
  }

  for (const preset of missing) {
    const entry = resolvedEntries[preset.path];
    if (!entry) { console.warn('[resfile] no manifest entry for', preset.path); continue; }
    try {
      const bytes = await resfile.fetchResourceBytes(entry.cdnPath, userAgent);
      if (entry.md5 && crypto.createHash('md5').update(bytes).digest('hex') !== entry.md5.toLowerCase()) {
        console.warn('[resfile] checksum mismatch for', preset.path, '— skipping');
        continue;
      }
      fs.writeFileSync(_assetPath(cacheDir, preset), bytes);
    } catch (e) {
      console.warn('[resfile] failed to fetch', preset.path, ':', e.message);
    }
  }
}

// Returns currently-cached presets as {id, name, source, url}[] — same shape
// list-backgrounds already returns for bundled/user images, so the renderer
// needs no changes at all. Fetches anything still missing first (a few
// seconds, once ever, the first time Settings → Background is opened after
// install or a cache clear); a preset that fails to fetch (offline, CDN
// hiccup) is simply omitted rather than shown broken.
//
// Deliberately NOT prefetched at app startup: an earlier version fired this
// fire-and-forget from app.whenReady(), but the ~30MB cold-cache download
// (the 20MB resfileindex manifest plus 5 images) competed with SDE/DB init
// and the renderer's first-paint IPC burst for network + event-loop time
// often enough to measurably slow early startup — caught via e2e
// (wallets.spec.js went from a reliable ~4.3s to occasionally timing out at
// 10s). Fetching lazily on first visit — the same pattern the PI, market,
// forums and jabber pages already use — has zero startup cost and only
// affects the one settings tab that actually needs it.
async function listResfileBackgrounds({ userAgent, cacheDir }) {
  await _ensureCached(userAgent, cacheDir).catch(() => {});
  const out = [];
  for (const preset of RESFILE_BACKGROUND_PRESETS) {
    const assetPath = _assetPath(cacheDir, preset);
    if (!fs.existsSync(assetPath)) continue;
    out.push({
      id:     `resfile:${preset.id}`,
      name:   preset.name,
      source: 'resfile',
      url:    pathToFileURL(assetPath).href,
    });
  }
  return out;
}

module.exports = { listResfileBackgrounds, RESFILE_BACKGROUND_PRESETS };
