const { APP_USER_AGENT } = require('../app_ident');
// ── updater_ipc.js — GitHub Releases update checker ───────────────────────────
// Checks https://api.github.com/repos/mcpanayides/EVE-CARBON/releases/latest
// for a newer version than the currently running app (tags must be "v"-prefixed,
// e.g. v0.5.4). If found, the renderer shows a notification and the user can
// open the GitHub Releases download page.
//
// User data lives in %AppData%\EVE-Carbon\ and is never touched by the NSIS
// installer, so upgrades are seamless (accounts, databases, settings all survive).

const { shell, BrowserWindow } = require('electron');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Use the releases LIST endpoint, not /releases/latest. /releases/latest EXCLUDES
// pre-releases and drafts — and every EVE-Carbon release is published as a
// pre-release, so /releases/latest returns 404 and the app never sees an update.
const GH_RELEASES_API = 'https://api.github.com/repos/mcpanayides/EVE-CARBON/releases?per_page=30';
const GH_RELEASES_URL = 'https://github.com/mcpanayides/EVE-CARBON/releases/latest';

// ── Marking a release critical ───────────────────────────────────────────────
// The release body IS the CHANGELOG section for that tag (see the "Release
// notes" step in .github/workflows/main.yml), so the marker lives in
// CHANGELOG.md and needs no workflow change and no extra asset.
//
// Two accepted forms, because the machine-readable one is easy to forget:
//
//   <!-- eve-carbon:critical: data loss on upgrade from 3.2 -->
//   > **CRITICAL UPDATE** — data loss on upgrade from 3.2
//
// The HTML comment is invisible in rendered markdown; the blockquote is what a
// person actually types. Either sets the flag, and whatever follows becomes the
// reason shown in the banner.
//
// Pure and exported so it can be tested without a network or a release.
const CRITICAL_COMMENT = /<!--\s*eve-carbon:critical\s*(?::\s*([^]*?))?\s*-->/i;
const CRITICAL_PROSE   = /^[>\s]*\*{0,2}critical(?:\s+update)?\*{0,2}\s*[—\-:]?\s*(.*)$/im;

function parseReleaseFlags(body) {
  const text = String(body || '');
  const m = CRITICAL_COMMENT.exec(text) || CRITICAL_PROSE.exec(text);
  if (!m) return { critical: false, criticalReason: null };
  // Strip markdown emphasis from the reason so the banner shows plain text.
  const reason = String(m[1] || '').replace(/[*_`]/g, '').trim();
  return { critical: true, criticalReason: reason || null };
}

// Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
function compareVersions(v1, v2) {
  const a = v1.split('.').map(Number);
  const b = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// Fetch JSON from a URL, following up to 5 redirects.
function fetchJson(url, redirectsLeft = 5) {
  const https = require('https');
  const http  = require('http');
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': APP_USER_AGENT, 'Accept': 'application/json' },
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectsLeft > 0) {
        return resolve(fetchJson(res.headers.location, redirectsLeft - 1));
      }
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function registerUpdaterHandlers({ ipcHandle, app, loadConfig, saveConfig }) {

  // ── Check for update ────────────────────────────────────────────────────────
  // Returns:
  //   { hasUpdate: false }
  //   { hasUpdate: true, latestVersion, currentVersion, downloadUrl }
  ipcHandle('updater-check', async () => {
    const currentVersion = app.getVersion();
    try {
      const releases = await fetchJson(GH_RELEASES_API);
      const list = Array.isArray(releases) ? releases : [];

      // Pick the highest semver among non-draft releases (pre-releases included).
      // tag_name is like "v0.9.0" / "v0.8.4b"; we read the leading x.y.z.
      let best = null; // { ver, release }
      for (const r of list) {
        if (!r || r.draft) continue;
        const m = String(r.tag_name || '').replace(/^v/, '').match(/^\d+\.\d+\.\d+/);
        if (!m) continue;
        if (!best || compareVersions(m[0], best.ver) > 0) best = { ver: m[0], release: r };
      }
      if (!best) return { hasUpdate: false, currentVersion };

      const latestVersion = best.ver;
      const data          = best.release;

      const { critical, criticalReason } = parseReleaseFlags(data.body);

      // A skipped version stays skipped — unless it is critical. "Skip" means
      // "this one is not worth my time", which is a judgement the user cannot
      // make about a release that fixes data loss, because the reason only
      // arrives with the release itself.
      const cfg = loadConfig();
      const skipped = cfg?.app?.updater?.skippedVersion;
      if (skipped === latestVersion && !critical) return { hasUpdate: false, currentVersion };

      if (compareVersions(latestVersion, currentVersion) > 0) {
        // Pick the asset matching this platform's installer — was hardcoded to
        // .exe regardless of OS, so macOS was handed the Windows installer URL.
        // Falls back to the release page if this OS has no matching asset yet
        // (e.g. the mac build for this release hasn't finished/uploaded).
        const pattern = process.platform === 'darwin' ? /\.dmg$/i
                      : process.platform === 'linux'  ? /\.AppImage$/i
                      : /\.exe$/i;
        const asset      = (data.assets || []).find(a => pattern.test(a.name));
        const downloadUrl = asset?.browser_download_url || data.html_url || GH_RELEASES_URL;
        return { hasUpdate: true, latestVersion, currentVersion, downloadUrl, critical, criticalReason };
      }

      return { hasUpdate: false, currentVersion };
    } catch (e) {
      console.warn('[updater] check failed:', e.message);
      return { hasUpdate: false, currentVersion };
    }
  });

  // ── Open download page in browser ──────────────────────────────────────────
  ipcHandle('updater-open-download', async (_, downloadUrl) => {
    const url = (downloadUrl && /^https?:\/\//.test(downloadUrl))
      ? downloadUrl
      : GH_RELEASES_URL;
    shell.openExternal(url);
    return { success: true };
  });

  // ── Auto-download installer and launch ──────────────────────────────────────
  // Windows only: streams the .exe asset directly to a temp file, reports
  // progress via 'updater-download-progress' IPC events, then spawns the
  // NSIS installer and quits. Any non-exe URL (the .dmg on macOS, .AppImage
  // on Linux, or a release-page fallback) opens in the browser instead —
  // there's no equivalent silent-install flow for those installer formats.
  ipcHandle('updater-download-and-install', async (event, downloadUrl) => {
    if (!downloadUrl || !/\.exe(\?.*)?$/i.test(downloadUrl)) {
      // macOS / Linux — open browser as fallback
      shell.openExternal(downloadUrl || GH_RELEASES_URL);
      return { success: true, method: 'browser' };
    }

    const send = (stage, percent) => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          win.webContents.send('updater-download-progress', { stage, percent });
        }
      } catch (_) {}
    };

    const fileName = `EVE-Carbon-Setup-${Date.now()}.exe`;
    const destPath = path.join(os.tmpdir(), fileName);

    try {
      send('Connecting…', 0);
      await downloadBinary(downloadUrl, destPath, pct => send(`Downloading… ${pct}%`, pct));
      send('Launching installer…', 100);

      // Spawn detached so the installer survives the app quitting
      const { spawn } = require('child_process');
      spawn(destPath, [], { detached: true, stdio: 'ignore' }).unref();

      setTimeout(() => app.quit(), 800);
      return { success: true, method: 'install' };
    } catch (e) {
      // Clean up partial download
      try { fs.unlinkSync(destPath); } catch (_) {}
      console.error('[updater] download failed:', e.message);
      return { success: false, error: e.message };
    }
  });

  // ── Skip a specific version ─────────────────────────────────────────────────
  // Persisted in config so the prompt doesn't reappear for the same version.
  ipcHandle('updater-skip-version', async (_, version) => {
    try {
      const cfg = loadConfig();
      cfg.app = cfg.app || {};
      cfg.app.updater = cfg.app.updater || {};
      cfg.app.updater.skippedVersion = version;
      saveConfig(cfg);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

// Streams a binary URL to destPath, following redirects, calling onProgress(0-100).
function downloadBinary(url, destPath, onProgress, redirectsLeft = 10) {
  const https = require('https');
  const http  = require('http');
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': APP_USER_AGENT } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        return resolve(downloadBinary(res.headers.location, destPath, onProgress, redirectsLeft - 1));
      }
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));

      const total    = parseInt(res.headers['content-length'] || '0', 10);
      let received   = 0;
      const fileStream = fs.createWriteStream(destPath);

      res.on('data', chunk => {
        received += chunk.length;
        if (total > 0) onProgress(Math.round(received / total * 100));
      });
      res.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(destPath); });
      fileStream.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Download timed out')); });
    req.end();
  });
}

module.exports = { parseReleaseFlags, registerUpdaterHandlers };
