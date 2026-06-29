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
      headers: { 'User-Agent': 'EVE-Carbon-Updater/1.0', 'Accept': 'application/json' },
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

      // Check if this version was previously skipped
      const cfg = loadConfig();
      const skipped = cfg?.app?.updater?.skippedVersion;
      if (skipped === latestVersion) return { hasUpdate: false, currentVersion };

      if (compareVersions(latestVersion, currentVersion) > 0) {
        // Prefer a direct .exe asset download, fall back to the release page
        const exeAsset = (data.assets || []).find(a => /\.exe$/i.test(a.name));
        const downloadUrl = exeAsset?.browser_download_url || data.html_url || GH_RELEASES_URL;
        return { hasUpdate: true, latestVersion, currentVersion, downloadUrl };
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
  // NSIS installer and quits. Non-exe URLs fall back to opening the browser.
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
    const req = lib.get(url, { headers: { 'User-Agent': 'EVE-Carbon-Updater/1.0' } }, res => {
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

module.exports = { registerUpdaterHandlers };
