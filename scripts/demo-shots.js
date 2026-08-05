#!/usr/bin/env node
'use strict';
//
// Screenshot every page of the app in demo mode.
//
//   node scripts/demo-shots.js                 → ./demo-shots/*.png
//   node scripts/demo-shots.js --out=./shots   → somewhere else
//   node scripts/demo-shots.js --size=1920x1080
//
// Two jobs:
//   • proof — after changing the demo fixture, look at all 15 pages at once
//     instead of clicking through them and hoping;
//   • output — README images, store listings, storyboard frames for a video.
//
// Runs the REAL app against the demo profile (see src/demo_mode.js), so what
// lands in the folder is exactly what a viewer would see. It never touches the
// developer's own profile.

const fs   = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

const REPO_ROOT = path.join(__dirname, '..');

// Ordered as a walkthrough would go, not alphabetically — the file numbering
// then doubles as a running order for a demo video.
const PAGES = [
  'dashboard', 'characters', 'skills', 'assets', 'wallets', 'industry',
  'pi', 'map', 'fc', 'fw', 'killboard', 'mail', 'calendar', 'forums', 'jabber',
];

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

(async () => {
  const outDir = path.resolve(arg('out', path.join(REPO_ROOT, 'demo-shots')));
  const size   = arg('size', '1600x900');
  fs.mkdirSync(outDir, { recursive: true });

  // Claude Code's shells set ELECTRON_RUN_AS_NODE=1, which makes Electron boot
  // as plain Node and the app fail to start. It must be deleted, not blanked —
  // the bootstrap checks for PRESENCE. (Same note as e2e/support/electron-app.js.)
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    args: [REPO_ROOT, '--demo', `--demo-size=${size}`],
    env,
  });

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3000);          // first-run init: SDE, seeding, dashboard widgets

  const problems = [];
  win.on('pageerror', e => problems.push(`[pageerror] ${e.message}`));

  let n = 0;
  for (const page of PAGES) {
    n++;
    const file = path.join(outDir, `${String(n).padStart(2, '0')}-${page}.png`);
    try {
      await win.locator(`.nav-btn[data-page="${page}"]`).click({ timeout: 5000 });
      // Pages load their data on first visit; the map also builds its layout.
      await win.waitForTimeout(page === 'map' ? 6000 : 2500);
      await win.screenshot({ path: file });
      console.log(`  ${path.basename(file)}`);
    } catch (e) {
      problems.push(`[${page}] ${e.message.split('\n')[0]}`);
      console.log(`  ${page}: FAILED — ${e.message.split('\n')[0]}`);
    }
  }

  await app.close().catch(() => {});
  console.log(`\n${n} pages → ${outDir}`);
  if (problems.length) {
    console.log('\nProblems:');
    for (const p of problems) console.log('  ' + p);
  }
})().catch(e => { console.error(e); process.exit(1); });
