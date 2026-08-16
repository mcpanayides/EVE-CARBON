// ─── sde_fetch.js ───────────────────────────────────────────────────────────
// Downloads CCP's official SDE (developers.eveonline.com/static-data — the
// JSONL export that replaced the old Fuzzwork sqlite dump), extracts it, and
// builds the app's sde.sql via src/sde_build.js. Shared by scripts/fetch-sde.js
// (CI/dev build) and main.js's in-app "Update SDE" flow.
// ─────────────────────────────────────────────────────────────────────────────

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const yauzl  = require('yauzl');
const { buildSdeFromJsonl } = require('./sde_build');

// ── Safe zip extraction ──────────────────────────────────────────────────────
// This replaced extract-zip, which has an unfixed path-traversal advisory
// (CVE-2026-56876, high): it writes symlink entries without validating their
// targets, so an archive containing a link to ../../../ can place files
// anywhere the process can write. There is no patched release — 2.0.1 is both
// the latest version and the vulnerable one — so the dependency had to go
// rather than be bumped.
//
// The archive here is CCP's SDE, fetched over TLS, and this runs from the
// in-app "Update SDE" button on the user's own machine. The download follows
// redirects and is not signed or checksummed, so "the source is trusted" rests
// on the CDN and the TLS chain alone. That is a thin thing to hang arbitrary
// file writes on when the alternative is a few lines of validation.
//
// yauzl is what extract-zip wrapped anyway; what is added here is the checking
// it did not do.

const S_IFMT  = 0o170000;   // file-type mask within the unix mode
const S_IFLNK = 0o120000;   // symbolic link

/** Unix mode from a zip entry, or 0 when the archive carries no unix bits. */
function entryMode(entry) {
  return (entry.externalFileAttributes >>> 16) & 0xFFFF;
}

/**
 * Where this entry may be written, or an Error explaining why it may not.
 *
 * Rejects absolute paths, drive letters, and any ".." segment before resolving,
 * then confirms the resolved path is still inside the destination — belt and
 * braces, because the string checks and the resolve check fail on different
 * tricks (the first on "../x", the second on things like a symlinked dest).
 */
function safeEntryPath(destDir, entryName) {
  const name = String(entryName).replace(/\\/g, '/');
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
    return { error: `absolute path in archive: ${name}` };
  }
  if (name.split('/').some(seg => seg === '..')) {
    return { error: `path traversal in archive: ${name}` };
  }
  const root = path.resolve(destDir);
  const full = path.resolve(root, name);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { error: `path escapes the extraction directory: ${name}` };
  }
  return { full };
}

/**
 * Extract a zip, refusing anything that could write outside destDir.
 *
 * Symlinks are rejected outright rather than resolved. The SDE archive is a
 * flat set of JSONL files and has no legitimate use for them, so "no symlinks"
 * costs nothing here and removes the entire class of attack.
 */
function extractZipSafely(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);

      const fail = (e) => { try { zip.close(); } catch (_) {} reject(e); };

      zip.on('entry', (entry) => {
        const isDir = /\/$/.test(entry.fileName);

        if (!isDir && (entryMode(entry) & S_IFMT) === S_IFLNK) {
          return fail(new Error(`refusing symlink in SDE archive: ${entry.fileName}`));
        }
        const { full, error } = safeEntryPath(destDir, entry.fileName);
        if (error) return fail(new Error(`refusing ${error}`));

        if (isDir) {
          fs.mkdirSync(full, { recursive: true });
          return zip.readEntry();
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return fail(streamErr);
          const out = fs.createWriteStream(full);
          stream.on('error', fail);
          out.on('error', fail);
          out.on('close', () => zip.readEntry());
          stream.pipe(out);
        });
      });

      zip.on('end', resolve);
      zip.on('error', fail);
      zip.readEntry();
    });
  });
}

const MANIFEST_URL = 'https://developers.eveonline.com/static-data/tranquility/latest.jsonl';
const ZIP_URL       = 'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip';

// Manifest is one JSONL line: {"_key":"sde","buildNumber":N,"releaseDate":"..."}
function fetchManifest(userAgent) {
  return new Promise((resolve, reject) => {
    https.get(MANIFEST_URL, { headers: { 'User-Agent': userAgent } }, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} fetching SDE manifest`)); }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const line = body.split('\n').find(l => l.trim());
          resolve(JSON.parse(line));
        } catch (e) { reject(new Error('Could not parse SDE manifest: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// developers.eveonline.com serves the "latest" zip as a 302 to a build-numbered
// CloudFront URL — https.get never follows redirects on its own (confirmed live:
// GET .../eve-online-static-data-latest-jsonl.zip -> 302 Location: .../eve-online-
// static-data-<build>-jsonl.zip), so this needs the same manual redirect-follow
// used elsewhere in the app (see src/locator.js fetchHtml/fetchJson).
function downloadFile(url, destPath, userAgent, onProgress, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('too many redirects downloading ' + url));
    https.get(url, { headers: { 'User-Agent': userAgent } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        downloadFile(next, destPath, userAgent, onProgress, _redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`)); }
      const writer = fs.createWriteStream(destPath);
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0, lastPct = -1;
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (total > 0 && onProgress) {
          const pct = Math.round((downloaded / total) * 100);
          if (pct !== lastPct) { lastPct = pct; onProgress(pct, downloaded, total); }
        }
      });
      res.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Full pipeline: fetch manifest -> download zip -> extract -> build sqlite ->
 * atomically replace outSqlitePath. Uses a fresh temp directory so a failure
 * at any stage never touches the live database.
 *
 * @param {object} opts
 * @param {string} opts.userAgent
 * @param {string} opts.outSqlitePath - final destination (e.g. data/sde.sql)
 * @param {(stage:string, pct?:number) => void} [opts.onProgress]
 * @returns {Promise<{buildNumber:number, releaseDate:string}>}
 */
async function fetchAndBuildSde({ userAgent, outSqlitePath, onProgress }) {
  const report = (stage, pct) => { if (onProgress) onProgress(stage, pct); };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-sde-'));
  const zipPath = path.join(tmpRoot, 'sde.zip');
  const jsonlDir = path.join(tmpRoot, 'jsonl');

  try {
    report('Checking SDE version…');
    const manifest = await fetchManifest(userAgent);

    report('Downloading SDE…', 0);
    await downloadFile(ZIP_URL, zipPath, userAgent, (pct) => report('Downloading SDE…', pct));

    report('Extracting…');
    fs.mkdirSync(jsonlDir, { recursive: true });
    await extractZipSafely(zipPath, jsonlDir);

    report('Building database (this can take a minute)…');
    await buildSdeFromJsonl(jsonlDir, outSqlitePath + '.tmp', (msg) => report(`Building database… ${msg}`));

    report('Finishing up…');
    const outDir = path.dirname(outSqlitePath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    try { fs.renameSync(outSqlitePath + '.tmp', outSqlitePath); }
    catch (_) {
      // Cross-device rename (e.g. temp dir on a different drive) — copy + delete.
      fs.copyFileSync(outSqlitePath + '.tmp', outSqlitePath);
      fs.unlinkSync(outSqlitePath + '.tmp');
    }

    report('Done', 100);
    return manifest;
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  fetchManifest, downloadFile, fetchAndBuildSde, MANIFEST_URL, ZIP_URL,
  // Exported for test/sde_extract.test.js — this is the security boundary that
  // replaced a vulnerable dependency, so it is tested against real hostile
  // archives rather than trusted to review.
  extractZipSafely, safeEntryPath,
};
