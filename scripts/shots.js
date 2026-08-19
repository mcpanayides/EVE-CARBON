#!/usr/bin/env node
'use strict';
//
// ─── shots.js — the published screenshot set ─────────────────────────────────
//
//   npm run shots                    → ./screenshots/*.jpg
//   npm run shots -- --out=./tmp     → somewhere else
//   npm run shots -- --size=1920x1080
//   npm run shots -- --max-kb=250    → per-file ceiling (default 250)
//   npm run shots -- --only=industry → just the shots whose id starts with that
//
// Runs the REAL app against the demo profile, walks every sidebar page AND the
// sub-tools inside them, and writes one image per screen. What lands in the
// folder is what a viewer would see.
//
// WHY DEMO MODE, NOT A REAL ACCOUNT
// A screenshot of a live killboard or asset list publishes what its owner flies
// and owns. That is a targeting problem, not a privacy nicety. The demo profile
// is invented top to bottom (src/demo_data.js, src/demo_fixtures.js), so these
// are safe to post to a forum or Discord.
//
// WHY JPEG
// These are marketing images, not pixel references. A dark UI screenshot at
// q≈80 lands around 120-200 KB against 600 KB-1 MB for the same frame as PNG.
// The script drops quality per-file until it fits --max-kb so no single image
// can blow the budget, and prints the total at the end.

const fs   = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

const REPO_ROOT = path.join(__dirname, '..');

// Ordered as a walkthrough, not alphabetically — the numeric prefix doubles as
// a running order for a demo video or a forum post.
//
//   id    file name (after the number)
//   page  sidebar button (data-page)
//   tab   optional sub-tool, as [attribute, value]
//   wait  extra settle time in ms where a page builds something heavy
const SHOTS = [
  { id: 'dashboard',              page: 'dashboard', wait: 3500 },
  { id: 'characters',             page: 'characters' },

  { id: 'skills-queues',          page: 'skills',  tab: ['data-skills-tab', 'queues'] },
  { id: 'skills-planner',         page: 'skills',  tab: ['data-skills-tab', 'planner'] },
  { id: 'skills-plans',           page: 'skills',  tab: ['data-skills-tab', 'plans'] },

  { id: 'killboard',              page: 'killboard', wait: 3000 },

  { id: 'fw-overview',            page: 'fw', tab: ['data-fw-tab', 'overview'] },
  { id: 'fw-systems',             page: 'fw', tab: ['data-fw-tab', 'systems'] },
  { id: 'fw-militia',             page: 'fw', tab: ['data-fw-tab', 'militia'] },
  { id: 'fw-leaderboards',        page: 'fw', tab: ['data-fw-tab', 'leaderboards'] },
  { id: 'fw-lp',                  page: 'fw', tab: ['data-fw-tab', 'lp'] },

  { id: 'mail',                   page: 'mail', wait: 2500 },
  { id: 'calendar',               page: 'calendar' },

  { id: 'assets',                 page: 'assets', wait: 3000 },

  { id: 'finances-wallets',       page: 'wallets', tab: ['data-finances-tab', 'wallets'] },
  { id: 'finances-contracts',     page: 'wallets', tab: ['data-finances-tab', 'contracts'] },
  { id: 'finances-trading',       page: 'wallets', tab: ['data-finances-tab', 'trading'] },
  { id: 'finances-lpstore',       page: 'wallets', tab: ['data-finances-tab', 'lpstore'] },

  { id: 'industry-blueprints',    page: 'industry', tab: ['data-industry-tab', 'blueprints'], wait: 3000 },
  { id: 'industry-bp-search',     page: 'industry', tab: ['data-industry-tab', 'search'] },
  { id: 'industry-active-jobs',   page: 'industry', tab: ['data-industry-tab', 'active-jobs'] },
  { id: 'industry-salvage',       page: 'industry', tab: ['data-industry-tab', 'salvage'] },
  { id: 'industry-orehold',       page: 'industry', tab: ['data-industry-tab', 'orehold'] },
  { id: 'industry-mining',        page: 'industry', tab: ['data-industry-tab', 'mining'] },
  { id: 'industry-cost-index',    page: 'industry', tab: ['data-industry-tab', 'cost-index'] },
  { id: 'industry-appraisal',     page: 'industry', tab: ['data-industry-tab', 'appraisal'] },
  { id: 'industry-shopping',      page: 'industry', tab: ['data-industry-tab', 'shopping-lists'] },
  { id: 'industry-checkout',      page: 'industry', tab: ['data-industry-tab', 'station-checkout'] },
  { id: 'industry-reactions',     page: 'industry', tab: ['data-industry-tab', 'reactions'] },
  { id: 'industry-ore-calc',      page: 'industry', tab: ['data-industry-tab', 'ore'] },
  { id: 'industry-ice-calc',      page: 'industry', tab: ['data-industry-tab', 'ice'] },
  { id: 'industry-gas-calc',      page: 'industry', tab: ['data-industry-tab', 'gas'] },
  { id: 'industry-moon-calc',     page: 'industry', tab: ['data-industry-tab', 'moon-calc'] },
  { id: 'industry-moon-scan',     page: 'industry', tab: ['data-industry-tab', 'moon'] },

  { id: 'pi-colonies',            page: 'pi', tab: ['data-pi-tab', 'colonies'] },
  { id: 'pi-planet-size',         page: 'pi', tab: ['data-pi-tab', 'planet-size'] },

  { id: 'fleet-tracker',          page: 'fc', tab: ['data-fc-tab', 'composition'] },
  { id: 'fleet-op-history',       page: 'fc', tab: ['data-fc-tab', 'ophistory'] },
  { id: 'fleet-fitting-sim',      page: 'fc', tab: ['data-fc-tab', 'fitting'], wait: 3000 },
  { id: 'fleet-early-warning',    page: 'fc', tab: ['data-fc-tab', 'intel'] },
  { id: 'fleet-fight-notify',     page: 'fc', tab: ['data-fc-tab', 'fleetfight'] },

  { id: 'map',                    page: 'map', wait: 7000 },
  { id: 'jabber',                 page: 'jabber' },
  { id: 'forums',                 page: 'forums', wait: 3000 },
];

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/**
 * Shoot at the highest quality that still fits the budget.
 *
 * A fixed quality either wastes bytes on simple screens or blows the ceiling on
 * the busy ones (the map and the asset table are far denser than a settings
 * pane). Stepping down per-file means no single image can break the budget and
 * the simple ones stay crisp.
 */
async function shootWithin(win, maxBytes) {
  let last = null;
  for (const quality of [88, 80, 72, 64, 55, 45]) {
    const buf = await win.screenshot({ type: 'jpeg', quality });
    last = { buf, quality };
    if (buf.length <= maxBytes) return last;
  }
  return last;   // still over budget: keep the smallest and say so
}

(async () => {
  const outDir = path.resolve(arg('out', path.join(REPO_ROOT, 'screenshots')));
  const size   = arg('size', '1600x900');
  const maxKb  = Number(arg('max-kb', '250'));
  const only   = arg('only', '');
  const list   = only ? SHOTS.filter((s) => s.id.startsWith(only)) : SHOTS;

  if (!list.length) { console.error(`No shots match --only=${only}`); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });

  // Claude Code's shells set ELECTRON_RUN_AS_NODE=1, which makes Electron boot
  // as plain Node and the app never opens a window. It must be DELETED, not
  // blanked — the bootstrap checks for presence.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`Launching in demo mode at ${size} — ${list.length} shots, ≤${maxKb} KB each`);

  // The app holds a single-instance lock (main.js), so a second copy exits
  // immediately and Playwright reports only "Target page, context or browser has
  // been closed". Say what actually happened instead: the run is doomed before
  // it starts, and the EPERM lines above it are the same one instance holding
  // the demo database open.
  let app;
  try {
    app = await electron.launch({ args: [REPO_ROOT, '--demo', `--demo-size=${size}`], env });
  } catch (e) {
    if (/has been closed/i.test(e.message || '')) {
      console.error('\nCould not start: another EVE Carbon instance is already running.');
      console.error('The app takes a single-instance lock, so this one exited on launch.');
      console.error('Close EVE Carbon (check the system tray) and run this again.');
      process.exit(1);
    }
    throw e;
  }
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(4000);        // SDE open, demo seed, first dashboard paint

  const problems = [];
  win.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.split('\n')[0]}`));

  let n = 0, total = 0, oversize = 0;
  for (const shot of list) {
    n++;
    const name = `${String(n).padStart(2, '0')}-${shot.id}.jpg`;
    const file = path.join(outDir, name);
    try {
      await win.locator(`.nav-btn[data-page="${shot.page}"]`).click({ timeout: 8000 });
      await win.waitForTimeout(shot.wait || 1800);

      if (shot.tab) {
        const [attr, val] = shot.tab;
        await win.locator(`[${attr}="${val}"]`).first().click({ timeout: 8000 });
        await win.waitForTimeout(shot.wait || 1800);
      }

      const { buf, quality } = await shootWithin(win, maxKb * 1024);
      fs.writeFileSync(file, buf);
      total += buf.length;
      const kb = Math.round(buf.length / 1024);
      if (buf.length > maxKb * 1024) { oversize++; console.log(`  ${name}  ${kb} KB  q${quality}  OVER BUDGET`); }
      else console.log(`  ${name}  ${kb} KB  q${quality}`);
    } catch (e) {
      problems.push(`[${shot.id}] ${e.message.split('\n')[0]}`);
      console.log(`  ${name}  FAILED — ${e.message.split('\n')[0]}`);
    }
  }

  await app.close().catch(() => {});

  console.log(`\n${n} shots → ${outDir}`);
  console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB` + (oversize ? `  (${oversize} over budget)` : ''));
  if (problems.length) {
    console.log('\nProblems:');
    for (const p of problems) console.log('  ' + p);
  }
  // A failed shot is a missing marketing image, not a broken build — report and
  // exit clean so a release is never blocked by one flaky page.
})().catch((e) => { console.error(e); process.exit(1); });
