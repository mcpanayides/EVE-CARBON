#!/usr/bin/env node
'use strict';
//
// Measure the asset data layer at real-user scale.
//
//   node scripts/stress-assets.js                       # 90 chars, 100k assets
//   node scripts/stress-assets.js --chars 20 --assets 20000
//   node scripts/stress-assets.js --keep                # leave the DB for the e2e run
//
// No Electron and no rendering: this isolates the DATABASE half of the problem
// so a slow query cannot be mistaken for a slow render, and vice versa. The
// renderer half is measured by e2e/assets-stress.spec.js against the same
// fixture.
//
// Reports per-stage timings and the shape of what came back, so a regression
// shows up as a number rather than as "the app feels slow".
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { buildStressProfile, seedStressCharacterDb } = require('../e2e/fixtures/seed-stress');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const ms = (n) => `${n.toLocaleString()} ms`;

(async () => {
  const characters = arg('chars', 90);
  const assets     = arg('assets', 100000);
  const stations   = arg('stations', 120);
  const keep       = process.argv.includes('--keep');

  const dir = process.env.EVE_CARBON_STRESS_DIR
    || path.join(os.tmpdir(), 'eve-carbon-stress', `${characters}c-${assets}a`);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`profile     ${characters} characters · ${assets.toLocaleString()} assets · ${stations} stations`);
  console.log(`directory   ${dir}\n`);

  let t = Date.now();
  const profile = buildStressProfile({ characters, assets, stations });
  console.log(`generate    ${ms(Date.now() - t)}   ${profile.totalAssets.toLocaleString()} rows in memory`);

  // A fresh database every run: measuring inserts into a table that already
  // holds the same rows measures the delete, not the insert.
  for (const f of ['character_information.db', 'character_information.db-wal', 'character_information.db-shm']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) {}
  }

  t = Date.now();
  let lastPct = -1;
  const { charInfoDb, timings } = await seedStressCharacterDb(dir, profile, {
    onProgress: (done, total) => {
      const pct = Math.floor((done / total) * 10) * 10;
      if (pct > lastPct) { lastPct = pct; process.stdout.write(`\rwrite       ${pct}%`); }
    },
  });
  process.stdout.write('\r');
  console.log(`write       ${ms(Date.now() - t)}   (tables ${ms(timings.tables)} · info ${ms(timings.info)} · assets ${ms(timings.assets)})`);

  // ── The read the Assets page actually performs ──
  // getCharacterAssets runs a JOIN walk to resolve each item's display location
  // through its parent chain. That is the query most likely to go quadratic.
  const perChar = [];
  t = Date.now();
  for (const c of profile.chars) {
    const t0 = Date.now();
    const rows = await charInfoDb.getCharacterAssets(c.characterId);
    perChar.push({ name: c.characterName, rows: rows.length, ms: Date.now() - t0 });
  }
  const readTotal = Date.now() - t;
  const totalRows = perChar.reduce((n, p) => n + p.rows, 0);
  console.log(`read all    ${ms(readTotal)}   ${totalRows.toLocaleString()} rows over ${characters} calls`);

  perChar.sort((a, b) => b.ms - a.ms);
  console.log('\nslowest characters:');
  for (const p of perChar.slice(0, 5)) {
    console.log(`  ${String(p.ms).padStart(6)} ms  ${String(p.rows).padStart(7)} rows  ${p.name}`);
  }

  // Per-row cost is the number that tells you whether a query is linear. If the
  // biggest hangar costs far more per row than the smallest, the query is not.
  const biggest  = perChar[0];
  const smallest = perChar.filter(p => p.rows > 0).sort((a, b) => a.rows - b.rows)[0];
  if (biggest && smallest && smallest.rows) {
    const bigPer   = biggest.ms / Math.max(1, biggest.rows);
    const smallPer = smallest.ms / Math.max(1, smallest.rows);
    console.log(`\nper-row     biggest ${bigPer.toFixed(4)} ms/row · smallest ${smallPer.toFixed(4)} ms/row`);
    if (smallPer > 0 && bigPer / smallPer > 3) {
      console.log('            ^ the big hangar costs disproportionately more per row —');
      console.log('              the read scales worse than linearly.');
    }
  }

  await charInfoDb.closeCharacterDb();

  if (keep) {
    console.log(`\nkept        ${dir}`);
    console.log('            EVE_CARBON_STRESS_DIR is set from this path by the e2e stress spec.');
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('\ncleaned up  (pass --keep to leave the database in place)');
  }
})().catch(e => { console.error('\nstress run failed:', e.stack || e.message); process.exit(1); });
