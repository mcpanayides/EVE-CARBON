// Measurement harness for widget content fit. Mounts each widget's real markup
// with synthetic data on an otherwise-empty grid, resizes it through Gridstack,
// and reports the three ways content fails to fit its frame:
//
//   scrollY  — body taller than the frame: you must scroll a tile to read it
//   clipped  — content past an overflow:hidden edge: simply invisible
//   scrollX  — a horizontally scrolling region: columns hidden off the right
//
// It prints the table for diagnosis AND asserts the fix stays fixed: no widget
// may hide content sideways, and the card widgets must not clip at any size a
// user can drag them to. Vertical scrolling of a LIST (the jobs table) is fine —
// that is what a list does; hiding a column off the right edge is not.
const { test, expect } = require('./support/electron-app');

const SIZES = [
  { w: 12, h: 15 }, { w: 5, h: 15 }, { w: 5, h: 14 }, { w: 12, h: 10 }, { w: 6, h: 8 }, { w: 4, h: 8 },
  { w: 4, h: 6 },   { w: 3, h: 6 }, { w: 2, h: 5 }, { w: 2, h: 4 },
];

async function measure(window, base, mountFn) {
  return window.evaluate(async ({ base, sizes, mountSrc }) => {
    const mount = eval(`(${mountSrc})`);
    const grid = (typeof _dashGrid !== 'undefined' && _dashGrid) || null;
    if (!grid) return { base, rows: [], error: 'grid not initialised' };

    // Empty grid: a lone probe sizes deterministically, with nothing to pack against.
    [...grid.engine.nodes].forEach(n => grid.removeWidget(n.el, true));

    const id = `${base}~probe`;
    const el = _makeDashItemEl({ id, x: 0, y: 0 });
    document.getElementById('dashboardGrid').appendChild(el);
    grid.makeWidget(el);
    // Measurements taken mid-animation describe the transition, not the design.
    if (typeof grid.setAnimation === 'function') grid.setAnimation(false);
    // The widget's own minW/minH are left in place: the point is what a user can
    // actually drag it to, so Gridstack clamps the requested sizes for us.

    const panel = el.querySelector('.dashboard-panel');
    const body  = panel.querySelector('.dashboard-widget-body');
    const rows  = [];

    // Warm-up: the first update after makeWidget lands mid-animation, and on the
    // very first probe the grid itself may not have its final width yet, so the
    // first row would describe the layout settling rather than the design.
    grid.update(el, { x: 0, y: 0, w: 12, h: 10 });
    mount(body);
    const gridEl = document.getElementById('dashboardGrid');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 50));
      const gw = gridEl.getBoundingClientRect().width;
      const bw = body.getBoundingClientRect().width;
      if (gw > 200 && bw > gw * 0.5) break;      // the probe is 12 of 12 columns
    }

    for (const size of sizes) {
      grid.update(el, { x: 0, y: 0, w: size.w, h: size.h });
      mount(body);
      // Settle: wait until the frame stops moving rather than guessing a delay.
      let last = null;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 50));
        const now = body.getBoundingClientRect();
        const sig = `${Math.round(now.width)}x${Math.round(now.height)}`;
        if (sig === last && now.height > 0) break;
        last = sig;
      }

      const node0   = grid.engine.nodes.find(x => x.el === el);
      const bodyBox = body.getBoundingClientRect();

      // Real clipping: content past the bottom of an overflow-hidden ancestor.
      let clipped = 0, clippedSel = '';
      body.querySelectorAll('*').forEach(node => {
        const r = node.getBoundingClientRect();
        if (!r.height) return;
        let p = node.parentElement, box = null;
        while (p && p !== document.body) {
          if (getComputedStyle(p).overflowY === 'hidden') { box = p.getBoundingClientRect(); break; }
          p = p.parentElement;
        }
        if (!box) return;
        const over = Math.round(r.bottom - box.bottom);
        if (over > clipped) {
          clipped = over;
          clippedSel = typeof node.className === 'string'
            ? `.${node.className.split(' ').filter(Boolean)[0]}` : node.tagName.toLowerCase();
        }
      });

      // Horizontal scrollers (the jobs table) hide their rightmost columns.
      let scrollX = 0, scrollXSel = '';
      [body, ...body.querySelectorAll('*')].forEach(node => {
        // The kill ticker's viewport is a marquee: its track is meant to be far
        // wider than the frame. Overflow there is the feature, not the defect.
        if (node.classList?.contains('kt-viewport')) return;
        // Only genuinely SCROLLABLE regions count. A label with overflow:hidden
        // and an ellipsis also reports scrollWidth > clientWidth, but it is
        // truncated on purpose and says so on screen — that is not lost content.
        const ox = getComputedStyle(node).overflowX;
        const over = node.scrollWidth - node.clientWidth;
        if (over > scrollX && (ox === 'auto' || ox === 'scroll')) {
          scrollX = over;
          scrollXSel = typeof node.className === 'string'
            ? `.${node.className.split(' ').filter(Boolean)[0]}` : node.tagName.toLowerCase();
        }
      });

      rows.push({
        laidOut: bodyBox.height > 0,
        size: `${node0?.w ?? size.w}x${node0?.h ?? size.h}`,
        px: `${Math.round(bodyBox.width)}x${Math.round(bodyBox.height)}`,
        scrollY: body.scrollHeight - body.clientHeight,
        clipped, clippedSel, scrollX, scrollXSel,
      });
    }
    const node = grid.engine.nodes.find(x => x.el === el);
    if (node) grid.removeWidget(node.el);
    return { base, rows };
  }, { base, sizes: SIZES, mountSrc: mountFn.toString() });
}

function report(r) {
  console.log(`\n=== ${r.base} ===${r.error ? ' ' + r.error : ''}`);
  for (const row of r.rows) {
    const flags = [];
    if (row.scrollY > 1) flags.push(`scrollY+${row.scrollY}`);
    if (row.clipped > 1) flags.push(`CLIPPED ${row.clippedSel}+${row.clipped}`);
    if (row.scrollX > 1) flags.push(`scrollX ${row.scrollXSel}+${row.scrollX}`);
    console.log(`  ${row.size.padEnd(6)} body ${row.px.padEnd(10)} ${flags.length ? flags.join(' · ') : 'fits'}`);
  }
}

test.beforeEach(async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });
});

test('measure widget content fit across sizes', async ({ window }) => {
  const kills = (b) => {
    const k = Array.from({ length: 8 }, (_, i) => ({
      killmailId: 1000 + i, totalValue: (i + 1) * 1.234e9, time: new Date(Date.now() - i * 8.64e7).toISOString(),
      victimCharId: 90000001, victimShipTypeId: 671, systemId: 30000142, _byCharId: 1,
    }));
    window._ktNames = { 90000001: 'Some Very Long Victim Name', 671: 'Erebus', 30000142: 'Jita' };
    _ktRenderInstance(b, k, 'All characters', true, new Map([['1', 'My Pilot Name']]));
  };

  const jobwatch = (b) => {
    const now = Date.now();
    const jobs = [{
      job_id: 1, character_id: 1, activity_id: 1, status: 'active', runs: 20,
      start_date: new Date(now - 3.6e6).toISOString(), end_date: new Date(now + 7.2e6).toISOString(),
      product_type_id: 671, is_corp_job: true,
    }];
    _renderJobWatchInstance(b, 'jobWatch~probe', jobs,
      { 1: { characterName: 'My Pilot Name' } }, { 671: 'Erebus Blueprint Copy' });
  };

  const wallet = (b) => {
    _renderCharWalletInstance(b, 'charWallet~probe',
      [{ characterId: 1, characterName: 'My Pilot Name' }], { 1: 123456789012 });
  };

  const latestPing = (b) => {
    b.innerHTML = '<div id="dashboardPingsContent"></div>';
    renderDashboardPing({
      id: 1, is_director: true, sig: 'REAVERS', target_sig: 'HOME DEFENSE',
      who_pinged: 'Some Director Name', eve_timecode: '2026-08-10 19:45',
      fc_name: 'A Fleet Commander', formup_location: '1DQ1-A - Keepstar',
      comms: 'Op 1', pap_type: 'Strategic', doctrine: 'Muninn https://example.com/fit',
      hurf: 'Form up now, we are going to be moving out shortly. Bring your own ship and be ready.',
    });
  };

  const activeJobs = (b) => {
    const now = Date.now();
    const jobs = Array.from({ length: 4 }, (_, i) => ({
      job_id: i, character_id: 1, _charName: 'My Pilot Name', activity_id: [1, 3, 4, 8][i], status: 'active',
      runs: 10, start_date: new Date(now - 3.6e6).toISOString(), end_date: new Date(now + 7.2e6).toISOString(),
      product_type_id: 671, blueprint_type_id: 671,
    }));
    b.innerHTML = '<div id="probeJobs"></div>';
    renderActiveJobsWidget(b.querySelector('#probeJobs'), jobs, [{ characterId: 1, characterName: 'My Pilot Name' }]);
  };

  // A killfeed's rows are a list, so it may scroll vertically — but never lose a
  // column sideways, and never clip: a row cut in half mid-name is unreadable.
  const killFeed = (b) => {
    const now = Date.now();
    const rows = Array.from({ length: 14 }, (_, i) => ({
      killmailId: 1000 + i, time: new Date(now - i * 900_000).toISOString(),
      totalValue: (i + 1) * 1.234e9, isLoss: i % 3 === 0, attackerCount: i + 1,
      victimShipTypeId: 671, systemId: 30000142,
      victimCharId: 90000001, finalBlowCharId: 90000002,
    }));
    _kfNames = { 671: 'Erebus', 30000142: 'Jita',
                 90000001: 'Some Very Long Victim Name', 90000002: 'Another Long Pilot Name' };
    _kfRenderInstance(b, rows);
  };

  // ── Faction Warfare tiles ───────────────────────────────────────────────────
  // These read module state in faction-warfare.js, declared with `let` at the top
  // of a classic script — which puts it in the script scope, NOT on window. The
  // seeds below are therefore BARE assignments: `window._fwStats = …` would
  // silently create an unrelated property and the probe would render its empty
  // state. Seeding _fwNames too keeps _fwResolveNames off the network.
  const fwBoard = (b) => {
    const ids = [90000001, 90000002, 90000003, 90000004, 90000005];
    _fwNames = Object.fromEntries(ids.map((id, i) => [id, `Some Very Long Pilot Name ${i + 1}`]));
    _fwLbChars = { kills: { active_total: ids.map((id, i) => ({ character_id: id, amount: 14400 - i * 2600 })) } };
    localStorage.setItem('dashboardFwBoard', JSON.stringify({ 'fwBoard~probe': 'kills:active_total' }));
    _fwWRenderBoard(b, 'fwBoard~probe');
  };

  const fwSystems = (b) => {
    const owners = [500001, 500004, 500003, 500002, 500001, 500004];
    _fwNames = Object.fromEntries(owners.map((_, i) => [30000100 + i, `Long System Name ${i + 1}`]));
    _fwSystems = owners.map((o, i) => ({
      solar_system_id: 30000100 + i, owner_faction_id: o,
      occupier_faction_id: i === 2 ? FW_FACTIONS[o].enemy : o,
      contested: i === 0 ? 'vulnerable' : 'contested',
      victory_points: 75000 - i * 9000, victory_points_threshold: 75000,
    }));
    localStorage.setItem('dashboardFwSystems', JSON.stringify({ 'fwSystems~probe': 'all' }));
    _fwWRenderSystems(b, 'fwSystems~probe');
  };

  const fwTug = (b) => {
    const stat = (id, sys, vp, kills, pilots) => ({
      faction_id: id, systems_controlled: sys, pilots,
      kills: { yesterday: kills, total: kills * 900 },
      victory_points: { yesterday: vp, total: vp * 900 },
    });
    // Real proportions from a live warzone: Caldari hold more ground while
    // Gallente out-plexed them yesterday, which is the case the tile exists for.
    _fwStats = [stat(500001, 53, 138603, 399, 57139), stat(500004, 37, 155073, 552, 45010),
                stat(500003, 44, 148829, 343, 32848), stat(500002, 26, 145308, 657, 34501)];
    localStorage.setItem('dashboardFwTug', JSON.stringify({ 'fwTug~probe': 'cal-gal' }));
    _fwWRenderTug(b, 'fwTug~probe');
  };

  // Card widgets must fit whole; the tables may scroll vertically but never
  // horizontally (that is how the ACTIVITY and PROGRESS columns went missing).
  // The FW tiles are lists (Top Pilots, Capture Pressure) or a card (the tug of
  // war), and the tug of war is the one that must never lose a piece: a rope
  // with its push line cut off is a picture of a fight with the result missing.
  const mustNotClip = new Set(['killTicker', 'jobWatch', 'charWallet', 'latestPing', 'fwTug']);

  for (const [base, fn] of [['killTicker', kills], ['jobWatch', jobwatch], ['charWallet', wallet], ['latestPing', latestPing], ['activeJobs', activeJobs],
                            ['fwBoard', fwBoard], ['fwSystems', fwSystems], ['fwTug', fwTug],
                            ['killFeed', killFeed]]) {
    const result = await measure(window, base, fn);
    report(result);

    // A row measured before Gridstack finished laying the probe out reports a
    // zero-height body; it describes the animation, not the design.
    for (const row of result.rows.filter(r => r.laidOut)) {
      expect(`${base} ${row.size} scrollX ${row.scrollXSel}`,
        `${base} at ${row.size} (${row.px}) hides content off its right edge`)
        .toBe(`${base} ${row.size} scrollX `);
      if (mustNotClip.has(base)) {
        expect(`${base} ${row.size} clipped ${row.clippedSel}`,
          `${base} at ${row.size} (${row.px}) cuts content off`)
          .toBe(`${base} ${row.size} clipped `);
      }
    }
  }
});
