#!/usr/bin/env node
'use strict';
//
// Play the map's video takes in demo mode, the same way every time, while OBS
// records the window.
//
//   node scripts/video-map.js                  → waits for Enter, then plays every take
//   node scripts/video-map.js --only=route     → one take (orbit, route, overlays, flyin, schematic)
//   node scripts/video-map.js --proof          → no waiting; a PNG at each beat in video-takes/map
//   node scripts/video-map.js --size=1080x1920 → window content size
//
// The default, 784x1392, is as close to 9:16 as a 1440p landscape monitor allows:
// Windows will not make a window taller than its screen, and H.264 needs an even
// width (783 would be the exact ratio, and OBS would resample it). Premiere has to
// scale that up to 1080x1920. For a pixel-sharp take, rotate a monitor to portrait
// and pass --size=1080x1920.
//
// Each take is separated by a second of black, so Premiere's Scene Edit
// Detection can cut one long OBS recording back into takes.
//
// Runs the REAL app against the demo profile (see src/demo_mode.js). The cursor
// on screen is drawn here, not the system's: Playwright's mouse never moves the
// real one. Everything injected lives only in this launch; nothing in the app
// knows about it.

const fs   = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

const REPO_ROOT = path.join(__dirname, '..');

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PROOF  = process.argv.includes('--proof');
const ONLY   = arg('only', null);
const SIZE   = arg('size', '784x1392');
const OUT    = path.resolve(arg('out', path.join(REPO_ROOT, 'video-takes', 'map')));
const FROM   = 'Dodixie';         // 15 jumps, all high-sec: "Safest route" has to look it on screen
const TO     = 'Jita';
const FLY_TO = 'Jita';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Installed once. The focus guard matters: the app stops decorative animation
// and skips route reveals as soon as its window loses focus (ui.js), and during
// a recording the focused window is the terminal or OBS.
function install() {
  // The contains() check is not optional: classList.remove rewrites the attribute
  // even when the class is absent, which would fire this observer forever.
  const unfocus = () => {
    if (document.body.classList.contains('app-unfocused')) document.body.classList.remove('app-unfocused');
  };
  new MutationObserver(unfocus).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  unfocus();

  const style = document.createElement('style');
  style.textContent = `
    html, body, * { cursor: none !important; }
    #takeCursor { position: fixed; left: 0; top: 0; z-index: 2147483646; pointer-events: none;
                  width: 44px; height: 44px; filter: drop-shadow(0 2px 5px rgba(0,0,0,.8)); }
    #takeCursor.down { scale: .85; }
    #takeBlack { position: fixed; inset: 0; z-index: 2147483647; background: #000; pointer-events: none; }

    /* The map alone, edge to edge. It is still the real map; the rest is just not on stage.
       The panel's backdrop-filter has to go: it makes the panel the containing block of
       anything position:fixed inside it, and clips it there. */
    body.take-stage #navPagesContainer { backdrop-filter: none !important; }
    body.take-stage .titlebar, body.take-stage .sidebar, body.take-stage .market-ticker,
    body.take-stage #appConsole, body.take-stage .map-zoom-controls { display: none !important; }
    body.take-stage #mapViewport { position: fixed !important; inset: 0 !important; width: 100vw !important;
                                   height: 100vh !important; margin: 0 !important; border-radius: 0 !important;
                                   border: 0 !important; z-index: 2147483000; }
    body.take-stage #mapLegend { display: none !important; }
    body.take-stage #mapCtxMenu { z-index: 2147483100 !important; }

    /* ...plus the two button rows a take clicks, across the top. */
    body.take-bar .page-header { position: fixed !important; inset: 0 0 auto 0 !important; z-index: 2147483001 !important;
                                 margin: 0 !important; border-radius: 0 !important; }
    body.take-bar .page-header > *:not(.map-toolbar) { display: none !important; }
    body.take-bar .map-toolbar > * { display: none !important; }
    body.take-bar .map-toolbar > [aria-label="Map overlay"],
    body.take-bar .map-toolbar > [aria-label="Map view style"] { display: flex !important; flex-wrap: wrap !important; max-width: 100%; }
  `;
  document.head.appendChild(style);

  const cursor = document.createElement('div');
  cursor.id = 'takeCursor';
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="44" height="44"><path d="M4 2l15 12h-8.2L6.4 21z" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>';
  document.body.appendChild(cursor);
  const place = (e) => { cursor.style.transform = `translate(${e.clientX - 8}px, ${e.clientY - 4}px)`; };
  document.addEventListener('mousemove', place, true);
  document.addEventListener('mousedown', () => cursor.classList.add('down'), true);
  document.addEventListener('mouseup', () => cursor.classList.remove('down'), true);

  window.__takeStage = (bar) => {
    document.body.classList.add('take-stage');
    document.body.classList.toggle('take-bar', bar);
  };

  // A slow turn of the camera, for as long as it is left on.
  window.__takeOrbit = (radPerSec) => {
    window.__takeOrbitOn = radPerSec !== 0;
    let last = performance.now();
    const step = (now) => {
      if (!window.__takeOrbitOn) return;
      _camYaw += radPerSec * (now - last) / 1000;
      last = now;
      _scheduleRender();
      requestAnimationFrame(step);
    };
    if (window.__takeOrbitOn) requestAnimationFrame(step);
  };

  // Ease the camera's zoom to a value over `ms`.
  window.__takeZoom = (to, ms) => new Promise((done) => {
    const from = _camZoom, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      _camZoom = from * Math.pow(to / from, e);    // geometric: a zoom reads evenly this way
      _scheduleRender();
      if (k < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Same note as demo-shots.js: Electron boots as plain Node if this is present.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({ args: [REPO_ROOT, '--demo', `--demo-size=${SIZE}`], env });
  const missing = [];
  const watch = (buf) => { for (const l of String(buf).split('\n')) if (l.includes('[demo] no fixture')) missing.push(l.trim()); };
  app.process().stdout.on('data', watch);
  app.process().stderr.on('data', watch);

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3000);          // first-run init: SDE, seeding, dashboard widgets
  const problems = [];
  win.on('pageerror', e => problems.push(`[pageerror] ${e.message}`));

  // The app's own minimum width is wider than a 9:16 window.
  const [wide, high] = SIZE.split('x').map(Number);
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const main = BrowserWindow.getAllWindows()[0];
    main.setMinimumSize(1, 1);
    main.setContentSize(w, h);
  }, [wide, high]);

  await win.evaluate(install);
  await win.evaluate(() => { const b = document.createElement('div'); b.id = 'takeBlack'; document.body.appendChild(b); });
  await win.locator('.nav-btn[data-page="map"]').click();
  await win.waitForSelector('#mapCanvas', { state: 'visible', timeout: 20_000 });
  await win.evaluate(() => _navSettled);
  await win.waitForTimeout(3000);          // the layout, and the sky behind it

  const got = await win.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio]);
  console.log(`window content: ${got[0]}x${got[1]} at ${got[2]}x`);
  if (got[0] !== wide || got[1] !== high) console.log(`  NOTE: asked for ${SIZE}; the OS gave something else.`);

  // ── Helpers the takes share ────────────────────────────────────────────────
  let mouse = [got[0] * 0.8, got[1] * 0.7];
  async function glide(x, y, ms = 700) {
    const [x0, y0] = mouse, t0 = Date.now();
    for (;;) {
      const k = Math.min(1, (Date.now() - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      await win.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
      if (k >= 1) break;
      await sleep(12);
    }
    mouse = [x, y];
  }

  let beatNo = 0, takeNo = 0, takeName = '';
  async function beat(label) {
    if (!PROOF) return;
    beatNo++;
    const file = path.join(OUT, `${String(takeNo).padStart(2, '0')}-${takeName}-${String(beatNo).padStart(2, '0')}-${label}.png`);
    await win.screenshot({ path: file });
    console.log(`    ${path.basename(file)}`);
  }

  /** Where a system is on screen, having checked a click there lands on it and not a neighbour. */
  async function starAt(name) {
    const p = await win.evaluate((name) => {
      const s = _systems.find(x => x.name === name);
      const c = _spatialCanvasOf(s.id);
      const hit = _hitTest(c[0], c[1]);
      const r = _canvas.getBoundingClientRect();
      return { x: r.left + c[0], y: r.top + c[1], hit: hit && hit.name };
    }, name);
    if (p.hit !== name) throw new Error(`a click on ${name} would land on ${p.hit}: pick another framing`);
    return p;
  }

  /** Glide to a button and click it, having checked it is what a click there would hit. */
  async function press(selector) {
    const p = await win.evaluate((selector) => {
      const el = document.querySelector(selector);
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { x, y, ok: !!top && (top === el || el.contains(top)), top: top && `${top.tagName}#${top.id}.${top.className}` };
    }, selector);
    if (!p.ok) throw new Error(`${selector} is covered by ${p.top}`);
    await glide(p.x, p.y, 450);
    await win.mouse.click(p.x, p.y);
  }

  /** Back to the plain Spatial map with nothing on it. */
  async function reset(bar) {
    await win.evaluate((bar) => {
      window.__takeStage(bar);
      window.__takeOrbit(0);
      mapCloseInfo();
      for (const id of ['mapJbToggle', 'mapWhToggle']) {     // arcs that cross the route and say nothing here
        const t = document.getElementById(id);
        if (t.getAttribute('aria-pressed') === 'true') t.click();
      }
      _travelStart = _travelEnd = null;
      _routeIds = null; _routeWaypointIds = new Set();
      _routeRevealFinish();
      document.querySelector('.map-view-btn[data-view="spatial"]').click();
      document.querySelector('.map-overlay-btn[data-overlay="natural"]').click();
      _viewMode = 'spatial'; _camFlat = false;
      _selected = null;
    }, bar);
    await sleep(250);                                        // the viewport's ResizeObserver has the new size
    await win.evaluate(() => { _fitSpatial(); _render(); });
  }

  // ── The takes ──────────────────────────────────────────────────────────────
  const TAKES = {
    // The cluster alone, turning. The opening, and the thing to cut back to.
    async orbit() {
      await win.evaluate(() => window.__takeOrbit(0.06));
      await beat('start');
      await sleep(5000);
      await beat('mid');
      await sleep(5000);
      await beat('end');
      await win.evaluate(() => window.__takeOrbit(0));
    },

    // The payoff: pick two stars by hand, and the route draws itself between them.
    async route() {
      await win.evaluate(async ([from, to]) => {
        // Frame the route before the clicks, so plotting it doesn't cut the camera.
        await _loadFnfStandings();
        const a = _systems.find(s => s.name === from), b = _systems.find(s => s.name === to);
        _fitSpatialTo(_travelRoutePath(a.id, b.id, { mode: 'safest', useBridges: true, avoidZarzakh: true }));
        _render();
      }, [FROM, TO]);
      await sleep(600);
      await beat('framed');

      for (const [name, act] of [[FROM, 'start'], [TO, 'end']]) {
        const star = await starAt(name);
        await glide(star.x, star.y, 900);
        await sleep(200);
        await win.mouse.click(star.x, star.y, { button: 'right' });
        await win.waitForSelector('#mapCtxMenu');
        await sleep(350);
        await beat(`menu-${act}`);
        const box = await win.locator(`#mapCtxMenu .map-ctx[data-act="${act}"]`).boundingBox();
        const mx = box.x + box.width / 2, my = box.y + box.height / 2;
        await glide(mx, my, 350);
        await sleep(150);
        await win.mouse.click(mx, my);
        await sleep(500);
      }

      await win.waitForFunction(() => typeof _revealing === 'function' && _routeIds && _revealing('gate'), null, { timeout: 5000 });
      const r = await win.evaluate(() => ({
        hops: _routeIds.length - 1,
        total: _routeReveal.gate.total,
        lowest: Math.min(..._routeIds.map(id => _sysById[id].sec)),
      }));
      if (r.lowest < 0.45) throw new Error(`the "safest" route dips to ${r.lowest.toFixed(2)}: pick another route`);
      console.log(`    route: ${r.hops} jumps, draws in over ${(r.total / 1000).toFixed(1)} s`);
      await glide(got[0] * 0.85, got[1] * 0.85, 500);       // out of the way of the line
      await sleep(r.total * 0.35);
      await beat('drawing-a');
      await sleep(r.total * 0.3);
      await beat('drawing-b');
      await win.waitForFunction(() => !_revealing('gate'), null, { timeout: 20_000 });
      await sleep(1500);
      await beat('landed');
      await sleep(1500);
    },

    // The same stars, recoloured again and again: fast cuts live here.
    async overlays() {
      // Only the overlays that read on a phone; Danger and Incursions are mostly dark at this zoom.
      for (const overlay of ['security', 'sovereignty', 'traffic', 'natural']) {
        await press(`.map-overlay-btn[data-overlay="${overlay}"]`);
        await sleep(1600);
        if (await win.evaluate(() => _overlay) !== overlay) throw new Error(`the ${overlay} overlay did not switch on`);
        await beat(overlay);
      }
    },

    // From the whole cluster down to one star, its ring and its details.
    async flyin() {
      await win.evaluate((name) => {
        const s = _systems.find(x => x.name === name);
        _spatialFocusOn(s, 1200);
      }, FLY_TO);
      await sleep(1300);
      await beat('centred');
      await win.evaluate(() => window.__takeZoom(26266 / _spatialScale(), 3500));
      await beat('close');
      const star = await starAt(FLY_TO);
      await glide(star.x, star.y, 800);
      await sleep(200);
      await win.mouse.click(star.x, star.y);
      await sleep(1500);
      await beat('selected');
      await sleep(1500);
    },

    // One click: where things really are, then the tidy Schematic of the same map.
    async schematic() {
      await sleep(1000);
      await beat('spatial');
      await press('.map-view-btn[data-view="modern"]');
      await sleep(2500);
      if (await win.evaluate(() => _viewMode) !== 'modern') throw new Error('the Schematic did not switch on');
      await beat('schematic');
      await sleep(1500);
    },
  };

  const TAKES_WITH_BAR = new Set(['overlays', 'schematic']);
  const names = Object.keys(TAKES).filter(n => !ONLY || n === ONLY);
  if (!names.length) throw new Error(`no take called "${ONLY}": ${Object.keys(TAKES).join(', ')}`);

  if (!PROOF) {
    console.log(`\nIn OBS: Window Capture on this window, capture cursor OFF, start recording.`);
    console.log(`Then press Enter here and leave the mouse alone. ${names.length} take(s).`);
    await new Promise(r => process.stdin.once('data', r));
  }

  for (const name of names) {
    takeNo++; takeName = name; beatNo = 0;
    console.log(`  take ${takeNo}: ${name}`);
    try {
      await reset(TAKES_WITH_BAR.has(name));
      await sleep(1000);                                     // black, hiding the reset
      await win.evaluate(() => { document.getElementById('takeBlack').style.display = 'none'; });
      await sleep(400);
      await TAKES[name]();
    } catch (e) {
      problems.push(`[${name}] ${e.message.split('\n')[0]}`);
      console.log(`    FAILED: ${e.message.split('\n')[0]}`);
    }
    await win.evaluate(() => { document.getElementById('takeBlack').style.display = ''; });
  }
  await sleep(1000);

  await app.close().catch(() => {});
  if (PROOF) console.log(`\nframes → ${OUT}`);
  for (const m of new Set(missing)) problems.push(m);
  if (problems.length) {
    console.log('\nProblems:');
    for (const p of problems) console.log('  ' + p);
    process.exitCode = 1;
  } else {
    console.log('\nNo problems.');
  }
  process.stdin.pause();
})().catch(e => { console.error(e); process.exit(1); });
