// ─── fetch-sde.js ─────────────────────────────────────────────────────────────
// Build-time SDE fetch (npm run fetch-sde / the build-win CI step). Pulls
// CCP's official JSONL static-data export (developers.eveonline.com/static-data
// — replaced the old Fuzzwork sqlite dump) and converts it into data/sde.sql
// via src/sde_build.js, schema-compatible with every existing query in the app.
//
// Version check uses the SDE manifest's buildNumber (developers.eveonline.com/
// static-data/tranquility/latest.jsonl) instead of Fuzzwork's old Last-Modified
// header, stored in data/sde.md5 for path compatibility with the rest of the app.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const { fetchAndBuildSde, fetchManifest } = require('../src/sde_fetch');
const { APP_USER_AGENT } = require('../src/app_ident');

const DATA_DIR = path.join(__dirname, '../data');
const OUT_FILE = path.join(DATA_DIR, 'sde.sql');
const VER_FILE = path.join(DATA_DIR, 'sde.md5');

function readLocalVersion() {
  try { return fs.readFileSync(VER_FILE, 'utf8').trim(); } catch { return null; }
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('Checking remote SDE version…');
  let manifest;
  try {
    manifest = await fetchManifest(APP_USER_AGENT);
    console.log(`Remote build   : ${manifest.buildNumber} (${manifest.releaseDate})`);
  } catch (e) {
    console.warn(`Could not fetch remote version (${e.message}), proceeding with download.`);
  }

  const localVer = readLocalVersion();
  console.log(`Local build    : ${localVer || '(none)'}`);

  if (manifest && String(manifest.buildNumber) === localVer && fs.existsSync(OUT_FILE)) {
    console.log('SDE is already up to date. Skipping download.');
    return;
  }

  console.log('Downloading and building the official CCP SDE (this includes converting ~1.5M rows — a few minutes)…');
  let lastLine = '';
  const finalManifest = await fetchAndBuildSde({
    userAgent: APP_USER_AGENT,
    outSqlitePath: OUT_FILE,
    onProgress: (stage, pct) => {
      const line = pct != null ? `${stage} ${pct}%` : stage;
      if (line !== lastLine) { console.log(line); lastLine = line; }
    },
  });

  fs.writeFileSync(VER_FILE, String(finalManifest.buildNumber), 'utf8');
  console.log(`\nSDE successfully built at ${OUT_FILE} (build ${finalManifest.buildNumber}).`);
  console.log(`Version saved to ${VER_FILE}`);
}

main().catch(e => { console.error('Failed to build SDE:', e.message); process.exit(1); });
