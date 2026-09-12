// Baseline smoke test: the app launches, every real nav page opens without
// throwing, and no page leaves stray console errors behind. This is the cheap
// floor-level check that catches the most common break — a renamed element ID,
// a null-deref in a page's init function, a broken onclick handler — across
// the WHOLE app in one pass, independent of the deeper per-page specs.
const { test, expect } = require('./support/electron-app');

// Pages with a static #page-{name} container (see src/func/ui.js navigateToPage).
// 'map' is excluded: it's fetched at runtime from page-map.html, a different
// code path from the rest of the SPA — worth its own spec later.
const PAGES = ['dashboard', 'industry', 'wallets', 'assets', 'pi', 'fc', 'calendar', 'characters'];

test('app launches to the dashboard', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });
});

for (const page of PAGES) {
  test(`nav: ${page} page opens and stays error-free`, async ({ window }) => {
    // pageerror = uncaught JS exceptions (real bugs). Console 'error' also
    // fires for plain failed network requests, which the fixture EXPECTS —
    // its ESI token is deliberately invalid, so live-data widgets legitimately
    // 400/401/404 and Chromium logs that as a console error. Only flag console
    // errors that aren't that noise (e.g. the app's own console.error(...) calls).
    const errors = [];
    window.on('pageerror', (e) => errors.push(e.message));
    window.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (/Failed to load resource/.test(msg.text())) return;
      errors.push(msg.text());
    });

    await window.locator(`.nav-btn[data-page="${page}"]`).click();
    await expect(window.locator(`#page-${page}`)).toBeVisible();
    await expect(window.locator(`#page-${page}`)).toHaveClass(/active/);

    // Let first-visit async init (SDE queries, DB reads) settle before judging.
    await window.waitForTimeout(1000);

    expect(errors, `console/page errors on ${page}: ${errors.join(' | ')}`).toEqual([]);
  });
}

// ── Online counter and its version tooltip ───────────────────────────────────
// The counter is fed by the main-process heartbeat, which beats ten seconds
// after launch — too slow to wait for here — so the renderer half is driven
// directly. That is the half that was changed; the worker half has its own unit
// tests against the deployed source.
test('the online counter shows a per-version tooltip, newest first', async ({ window }) => {
  const state = await window.evaluate(() => {
    _updatePresenceCount({
      count: 61,
      versions: { '4.0.0': 19, '3.7.0': 12, '3.3.0': 23, '3.0.0': 5, unknown: 2 },
    });
    const wrap = document.getElementById('presenceStatus');
    return {
      label: document.getElementById('presenceCountLabel').textContent,
      visible: wrap.style.display,
      title: wrap.title,
    };
  });

  expect(state.label).toBe('61 ONLINE');
  expect(state.visible).toBe('inline-flex');
  // Three newest releases named, everything older plus unknown folded together.
  expect(state.title).toContain('4.0.0 — 19 users');
  expect(state.title).toContain('3.7.0 — 12 users');
  expect(state.title).toContain('3.3.0 — 23 users');
  expect(state.title).toContain('Other — 7 users');
  expect(state.title).not.toContain('3.0.0');
  expect(state.title).not.toContain('unknown');
});

test('the counter still works when the worker sends no version breakdown', async ({ window }) => {
  // An older worker, or a client talking to one, answers with a count alone.
  const state = await window.evaluate(() => {
    _updatePresenceCount({ count: 3, versions: null });
    const wrap = document.getElementById('presenceStatus');
    return { label: document.getElementById('presenceCountLabel').textContent, title: wrap.title };
  });
  expect(state.label).toBe('3 ONLINE');
  expect(state.title).toContain('3 running EVE Carbon right now');
});

test('a bare number is still accepted, so a stale renderer never blanks the counter', async ({ window }) => {
  const label = await window.evaluate(() => {
    _updatePresenceCount(7);
    return document.getElementById('presenceCountLabel').textContent;
  });
  expect(label).toBe('7 ONLINE');
});

test('the counter hides when the count is unknown', async ({ window }) => {
  const display = await window.evaluate(() => {
    _updatePresenceCount({ count: null, versions: null });
    return document.getElementById('presenceStatus').style.display;
  });
  expect(display).toBe('none');
});

// ── Update banner severity ───────────────────────────────────────────────────
// A critical release has to survive being ignored: somebody who habitually
// dismisses the update banner should stop at this one. Driven directly rather
// than by faking a GitHub release — the parser that decides criticality has its
// own unit tests; this is about what the banner then looks like.
test('a critical update is red, explains itself, and offers no permanent skip', async ({ window }) => {
  const state = await window.evaluate(() => {
    showUpdateBanner('4.0.0', '3.3.0', 'https://example.invalid/x.exe',
      { critical: true, criticalReason: 'corrupts the asset index on upgrade' });
    const banner = document.getElementById('updateBanner');
    const label  = document.getElementById('updateBannerLabel');
    return {
      shown:   banner.style.display,
      classes: banner.className,
      label:   label.textContent.trim(),
      text:    document.getElementById('updateBannerText').textContent,
      skip:    document.getElementById('updateBannerSkipBtn').style.display,
      border:  getComputedStyle(banner).borderBottomColor,
      labelCol: getComputedStyle(label).color,
    };
  });

  expect(state.shown).toBe('flex');
  expect(state.classes).toContain('is-critical');
  expect(state.label).toBe('⚠ CRITICAL UPDATE');
  // The reason is the point — "install this" without "because" trains people to
  // dismiss banners.
  expect(state.text).toContain('corrupts the asset index on upgrade');
  expect(state.skip, 'a critical update must not offer a permanent skip').toBe('none');
  // Red, not the usual green. Compare channels rather than an exact string.
  const rgb = state.labelCol.match(/\d+/g).map(Number);
  expect(rgb[0], `label should be red, got ${state.labelCol}`).toBeGreaterThan(rgb[1] + 40);
});

test('an ordinary update stays green and can still be skipped', async ({ window }) => {
  const state = await window.evaluate(() => {
    showUpdateBanner('3.4.0', '3.3.0', 'https://example.invalid/x.exe', {});
    const banner = document.getElementById('updateBanner');
    const label  = document.getElementById('updateBannerLabel');
    return {
      classes: banner.className,
      label:   label.textContent.trim(),
      skip:    document.getElementById('updateBannerSkipBtn').style.display,
      labelCol: getComputedStyle(label).color,
    };
  });

  expect(state.classes).not.toContain('is-critical');
  expect(state.label).toBe('⬡ UPDATE AVAILABLE');
  expect(state.skip).not.toBe('none');
  const rgb = state.labelCol.match(/\d+/g).map(Number);
  expect(rgb[1], `label should be green, got ${state.labelCol}`).toBeGreaterThan(rgb[0] + 40);
});

test('the banner switches back cleanly from critical to ordinary', async ({ window }) => {
  // The class is toggled, not added — a stale is-critical would paint an
  // ordinary release red and burn the signal.
  const classes = await window.evaluate(() => {
    showUpdateBanner('4.0.0', '3.3.0', 'u', { critical: true });
    showUpdateBanner('3.4.0', '3.3.0', 'u', {});
    return document.getElementById('updateBanner').className;
  });
  expect(classes).not.toContain('is-critical');
});

// Page changes cross-fade rather than cut (navigateToPage wraps its .active class
// swap in document.startViewTransition; base.css styles ::view-transition-*).
// A view transition that silently stops firing looks exactly like one that works
// — the page still changes — so the call is asserted rather than the appearance.
test('changing page runs a view transition, and still changes the page', async ({ window }) => {
  // Wait for the app to finish arriving at the dashboard first. Without this the
  // spy is installed mid-boot and catches the app's OWN opening navigation as
  // well as this one — two transitions, and an assertion that reads like the
  // page swap fired twice when nothing is wrong.
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });

  const result = await window.evaluate(async () => {
    const original = document.startViewTransition?.bind(document);
    if (!original) return { supported: false };
    let calls = 0;
    document.startViewTransition = (cb) => { calls++; return original(cb); };
    try {
      navigateToPage('skills');
      await new Promise(r => setTimeout(r, 500));
      return {
        supported: true, calls,
        active: document.querySelector('.nav-page.active')?.id,
      };
    } finally { document.startViewTransition = original; }
  });

  expect(result.supported, 'Electron ships a Chromium new enough for this').toBe(true);
  expect(result.calls, 'the page swap must go through a view transition').toBe(1);
  // The transition must not swallow the navigation it exists to decorate.
  expect(result.active).toBe('page-skills');
  await expect(window.locator('#page-skills')).toBeVisible();
});

// ── Universal refresh ────────────────────────────────────────────────────────
//
// Eleven pages carried their own refresh button and four had none, each in its
// own spot — so there was nowhere reliable to reach for when something looked
// stuck. One is now injected into every page's header action group, beside the
// ✕. Ctrl+R is wired (the default menu owns Reload) but a window reload
// re-renders from the same caches, so the numbers come back identical and it
// reads as though nothing happened; it now runs this instead.
test('every page has a refresh beside its ✕, and it rebuilds that page', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });

  // Injected, not authored — so a page added later cannot be missed.
  const pages = await window.evaluate(() => [...document.querySelectorAll('.nav-page')]
    .filter(p => p.id)
    .map(p => ({ id: p.id, ok: !!p.querySelector('.page-header-actions .page-refresh-btn') })));
  expect(pages.length, 'pages found').toBeGreaterThan(10);
  expect(pages.filter(p => !p.ok).map(p => p.id), 'every page needs one').toEqual([]);

  await window.locator('.nav-btn[data-page="skills"]').click();
  await expect(window.locator('#page-skills')).toBeVisible();
  const btn = window.locator('#page-skills .page-refresh-btn');
  await expect(btn).toBeVisible();

  // It re-runs the page's own first-visit initialiser rather than a per-page map.
  const rebuilt = await window.evaluate(async () => {
    const before = _pageInitialized.has('skills');
    let reinitialised = false;
    const orig = _initPageForFirstVisit;
    globalThis._initPageForFirstVisit = (p) => { if (p === 'skills') reinitialised = true; return orig(p); };
    try {
      await refreshApp();
      return { before, reinitialised, stillOnSkills: currentPage === 'skills' };
    } finally { globalThis._initPageForFirstVisit = orig; }
  });

  expect(rebuilt.before, 'the page was initialised before refreshing').toBe(true);
  expect(rebuilt.reinitialised, 'refresh must re-run the page initialiser').toBe(true);
  // A refresh rebuilds where you are; it does not send you home.
  expect(rebuilt.stillOnSkills).toBe(true);
  await expect(window.locator('#page-skills')).toBeVisible();

  // And it re-enables itself, so it is not a one-shot.
  await expect(btn).toBeEnabled();
});

test('refresh is re-entrancy guarded', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });
  // Hammering the button must not start several passes at once.
  //
  // Counted by completed passes, not by calls to autoRefreshStaleCharacters:
  // that one has two legitimate callers (refreshApp, and loadDashboard itself),
  // so on the dashboard a single refresh reaches it twice — the second returning
  // straight back out of its own _autoRefreshRunning guard. Counting it measured
  // the call graph rather than the property under test.
  const passes = await window.evaluate(async () => {
    let done = 0;
    const orig = showToast;
    globalThis.showToast = (msg, kind) => { if (msg === 'Refreshed.') done++; return orig(msg, kind); };
    try {
      await Promise.all([refreshApp(), refreshApp(), refreshApp()]);
      return done;
    } finally { globalThis.showToast = orig; }
  });
  expect(passes, 'three clicks must be one refresh').toBe(1);
});

// Ctrl+R runs the app's refresh, not a window reload. The default menu owns
// Reload, so main intercepts the key with before-input-event (which fires ahead
// of menu accelerators) and pushes 'app-refresh' to the renderer. Shift+Ctrl+R
// is left alone — Force Reload is still the real reload, for a wedged renderer.
test('Ctrl+R is intercepted and drives the app refresh, not a reload', async ({ electronApp, window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });

  // Mark the document so a genuine reload is detectable: a reload loses this.
  await window.evaluate(() => {
    window.__notReloaded = true;
    window.__refreshes = 0;
    const orig = refreshApp;
    globalThis.refreshApp = async () => { window.__refreshes++; return orig(); };
    window.eveAPI.on('app-refresh', () => refreshApp());
  });

  // Sent through main exactly as the real key does, so the wiring under test is
  // the wiring that ships — including the preload channel allowlist.
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('app-refresh');
  });
  await window.waitForTimeout(1500);

  const state = await window.evaluate(() => ({
    refreshes: window.__refreshes, alive: window.__notReloaded === true,
  }));
  expect(state.alive, 'the window must NOT have reloaded').toBe(true);
  expect(state.refreshes, 'the app refresh must have run').toBeGreaterThanOrEqual(1);
});

// ── The loading indicator ────────────────────────────────────────────────────
//
// One place, every page: refresh · spinner · ✕. The slot matters as much as the
// spinner does — the eye is already at that corner because that is where the
// click just happened, so "this page is working" should always appear there and
// never anywhere else.
test('every page carries the loading spinner between refresh and ✕', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });

  const layout = await window.evaluate(() => [...document.querySelectorAll('.nav-page')]
    .filter(p => p.id)
    .map(p => {
      const g = p.querySelector('.page-header-actions');
      // Order within the group, ignoring any page-declared action buttons.
      const kinds = g ? [...g.children].map(c =>
        c.classList.contains('page-refresh-btn') ? 'refresh'
          : c.classList.contains('page-spinner') ? 'spinner'
          : c.classList.contains('close-page-btn') ? 'close' : 'other') : [];
      return { id: p.id, order: kinds.filter(k => k !== 'other').join('|') };
    }));

  expect(layout.length).toBeGreaterThan(10);
  const wrong = layout.filter(p => p.order !== 'refresh|spinner|close');
  expect(wrong, 'refresh · spinner · ✕, on every page').toEqual([]);
});

test('the spinner lights while a refresh runs, and does not flicker', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });

  const seen = await window.evaluate(async () => {
    const sp = document.querySelector('#page-dashboard .page-spinner');
    let lit = 0;
    const iv = setInterval(() => { if (sp.classList.contains('loading')) lit++; }, 20);
    const t0 = Date.now();
    await refreshApp();
    // Sample past the refresh: the spinner is held briefly on purpose, so a load
    // that finishes instantly still reads as a beat rather than as a flicker.
    await new Promise(r => setTimeout(r, 600));
    clearInterval(iv);
    return { lit, litFor: lit * 20, elapsed: Date.now() - t0, stillOn: sp.classList.contains('loading') };
  });

  expect(seen.lit, 'the spinner must actually appear').toBeGreaterThan(0);
  expect(seen.litFor, 'and stay up long enough to be read, not flash').toBeGreaterThanOrEqual(200);
  expect(seen.stillOn, 'but it must clear once the refresh is done').toBe(false);
});

// Collapsing the rail used to hide .nav-status outright, which took the four
// things worth glancing at with it — unread mail, and whether Forums, Jabber
// and Tranquility are up. They now ride the icon as iOS-style badges.
//
// Worth an e2e rather than a unit test specifically BECAUSE it is CSS-only:
// nothing in JS would fail if the rule were dropped, and the indicators would
// just quietly vanish again the next time someone tidied the collapse block.
test('collapsing the nav keeps the status indicators as badges on the icons', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });

  // Give the mailbox something to report. _mailSetNavUnread is a top-level
  // function in a classic script, so it is on the renderer's global scope.
  await window.evaluate(() => _mailSetNavUnread(7));
  const badge = window.locator('#mailNavUnread');
  await expect(badge).toHaveText('7');

  const nav = window.locator('.sidebar-nav');
  await window.locator('#navToggleBtn').click();
  await expect(nav).toHaveClass(/nav-collapsed/);

  // The point of the change: still visible once the labels are gone.
  await expect(badge).toBeVisible();
  await expect(window.locator('#jabberNavStatus .status-light')).toBeVisible();
  await expect(window.locator('#forumNavStatus .status-light')).toBeVisible();

  // The rail animates shut (transition: width 0.2s), so wait for the width to
  // settle before measuring — otherwise this reads the geometry of a button
  // that is still two hundred pixels wide and mid-slide.
  await expect
    .poll(async () => (await window.locator('.nav-btn-mail').boundingBox()).width, { timeout: 5_000 })
    .toBeLessThan(80);

  // ...floating on the icon's top-right CORNER: the badge's left edge lands in
  // the right half of the glyph and it grows outward from there, so a longer
  // count never creeps back across the icon.
  const box  = await badge.boundingBox();
  const icon = await window.locator('.nav-btn-mail .nav-icon').boundingBox();
  expect(box.x).toBeGreaterThan(icon.x + icon.width / 2);
  expect(box.x).toBeLessThan(icon.x + icon.width);
  expect(box.y).toBeLessThan(icon.y + icon.height / 2);

  // A four-digit inbox measured exactly to the edge of the 64px rail, which is
  // a clipping box (.sidebar is overflow-y:auto, so the other axis clips too).
  // The narrow rail therefore shows a capped badge while the element keeps the
  // real number for the expanded rail and the tooltip.
  const rail = await window.locator('.sidebar').boundingBox();
  await window.evaluate(() => _mailSetNavUnread(2956));
  await expect(badge).toHaveAttribute('data-badge', '99+');
  await expect(badge).toHaveText('2956', { useInnerText: false });
  await expect(badge).toHaveAttribute('title', '2956 unread');
  const wide = await badge.boundingBox();
  expect(wide.x + wide.width).toBeLessThan(rail.x + rail.width);

  // Tranquility's player count is five digits — it cannot be a bubble, so only
  // its dot survives the collapse.
  await expect(window.locator('#eveStatusCount')).toBeHidden();
  await expect(window.locator('#eveStatusLight')).toBeVisible();

  // Zero unread must leave no empty bubble behind.
  await window.evaluate(() => _mailSetNavUnread(0));
  await expect(badge).toHaveText('');

  await window.locator('#navToggleBtn').click();
  await expect(nav).not.toHaveClass(/nav-collapsed/);
});
