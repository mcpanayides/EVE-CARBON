// ─── resfile.js ───────────────────────────────────────────────────────────────
// Minimal client for CCP's EVE client "resfile" distribution system — the same
// manifest chain the EVE Launcher and eve-online-tools/eve-resfile-proxy use to
// resolve game resource files (UI textures, icons, backgrounds, sounds…) to
// CDN URLs. Ported by hand from eve-resfile-proxy's Go source (MIT-less, but
// public) rather than shelling out to it — this app only ever needs to resolve
// a handful of known logical paths, not run a general-purpose caching proxy.
//
// Resolution chain (verified against live data 2026-07-20, build 3439610):
//   1. GET https://binaries.eveonline.com/eveclient_TQ.json         -> { buildNumber }
//   2. GET https://binaries.eveonline.com/eveonline_<build>.txt     -> "app:" manifest (CSV)
//      find the "app:/resfileindex.txt" row -> its cdnPath
//   3. GET https://binaries.eveonline.com/<cdnPath from step 2>     -> "res:" manifest (CSV)
//      (this IS resfileindex.txt's actual content — served from binaries, not resources)
//   4. Look up the desired logical path (e.g. "ui/texture/icons/x.png") in that
//      manifest -> its cdnPath
//   5. GET https://resources.eveonline.com/<cdnPath from step 4>    -> raw asset bytes
//
// Manifest line format (comma-separated, only the first 2 columns required):
//   logicalPath,cdnPath,md5,size,compressedSize,mode
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const BINARIES_ORIGIN  = 'https://binaries.eveonline.com';
const RESOURCES_ORIGIN = 'https://resources.eveonline.com';

function _url(origin, p) {
  return `${origin.replace(/\/$/, '')}/${String(p).replace(/^\//, '')}`;
}

// Fetches a URL as text, following redirects (CCP's CDN doesn't currently
// redirect these endpoints, but binaries/resources are CDN-fronted so this
// mirrors the defensive handling already used for the SDE download in
// sde_fetch.js rather than assuming it never will).
function fetchText(url, userAgent, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('too many redirects fetching ' + url));
    https.get(url, { headers: { 'User-Agent': userAgent } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        fetchText(next, userAgent, _redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Same, but accumulates raw bytes (for image/binary assets).
function fetchBuffer(url, userAgent, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('too many redirects fetching ' + url));
    https.get(url, { headers: { 'User-Agent': userAgent } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        fetchBuffer(next, userAgent, _redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Parses one manifest's CSV text into logicalPath -> {cdnPath, md5, size, compressedSize}.
// `prefix` is 'app' or 'res' — only rows under "<prefix>:/" are kept, with that
// prefix stripped, matching eve-resfile-proxy's vfs/manifest.go parseManifest().
function parseManifest(text, prefix) {
  const logicalPrefix = `${prefix}:/`;
  const entries = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const logicalPath = parts[0].trim().toLowerCase();
    const cdnPath      = parts[1].trim();
    if (!logicalPath || !cdnPath || !logicalPath.startsWith(logicalPrefix)) continue;
    const fsPath = logicalPath.slice(logicalPrefix.length);
    if (!fsPath || entries.has(fsPath)) continue; // first entry wins, same as upstream
    entries.set(fsPath, {
      cdnPath,
      md5:            parts[2] ? parts[2].trim() : null,
      size:           parts[3] ? parseInt(parts[3], 10) : null,
      compressedSize: parts[4] ? parseInt(parts[4], 10) : null,
    });
  }
  return entries;
}

// Build number for the given server ('tranquility' | 'singularity').
async function getBuildNumber(userAgent, server = 'tranquility') {
  const name = server === 'singularity' ? 'SISI' : 'TQ';
  const body = await fetchText(_url(BINARIES_ORIGIN, `eveclient_${name}.json`), userAgent);
  const json = JSON.parse(body);
  const build = json.buildNumber || json.build;
  if (!build) throw new Error('eveclient JSON had no buildNumber');
  return String(build);
}

// Resolves a list of "res:" logical paths (e.g.
// "graphics/character/global/paperdolllibrary/backgrounds/a trailercitadel.png")
// to their current CDN entries, for the current client build. Two network hops
// beyond the build lookup: the ~30KB app manifest, then the ~20MB resfileindex.
// Callers should cache the result themselves — this always does a full resolve.
async function resolveResourcePaths(wantedPaths, userAgent, server = 'tranquility') {
  const buildNumber = await getBuildNumber(userAgent, server);

  const appManifestText = await fetchText(_url(BINARIES_ORIGIN, `eveonline_${buildNumber}.txt`), userAgent);
  const appEntries = parseManifest(appManifestText, 'app');

  const indexEntry = appEntries.get('resfileindex.txt');
  if (!indexEntry) throw new Error('resfileindex.txt not found in app manifest for build ' + buildNumber);

  // resfileindex.txt is itself listed IN the app (binaries) manifest, so it is
  // fetched from the binaries origin too — only entries INSIDE it (the actual
  // game resources) live on the resources origin. Mixing these up 404s.
  const resIndexText = await fetchText(_url(BINARIES_ORIGIN, indexEntry.cdnPath), userAgent);
  const resEntries = parseManifest(resIndexText, 'res');

  const resolved = {};
  for (const p of wantedPaths) {
    const entry = resEntries.get(p.toLowerCase());
    if (entry) resolved[p] = entry;
  }
  return { buildNumber, resolved };
}

// Fetches the actual asset bytes for a previously-resolved cdnPath.
async function fetchResourceBytes(cdnPath, userAgent) {
  return fetchBuffer(_url(RESOURCES_ORIGIN, cdnPath), userAgent);
}

module.exports = {
  getBuildNumber,
  resolveResourcePaths,
  fetchResourceBytes,
  parseManifest,   // exported for unit tests
  BINARIES_ORIGIN,
  RESOURCES_ORIGIN,
};
