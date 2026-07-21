// ─── build-sde-from-jsonl.js ──────────────────────────────────────────────────
// CLI wrapper: `node scripts/build-sde-from-jsonl.js <jsonl-dir> <out-sqlite-path>`
// The actual conversion logic lives in src/sde_build.js (shared with main.js's
// in-app "Update SDE" flow — one implementation, two call sites).
// ─────────────────────────────────────────────────────────────────────────────

const { buildSdeFromJsonl } = require('../src/sde_build');

const [, , jsonlDirArg, outPathArg] = process.argv;
if (!jsonlDirArg || !outPathArg) {
  console.error('Usage: node build-sde-from-jsonl.js <jsonl-dir> <out-sqlite-path>');
  process.exit(1);
}

buildSdeFromJsonl(jsonlDirArg, outPathArg, msg => console.log(msg))
  .catch(e => { console.error('FAILED:', e); process.exit(1); });
