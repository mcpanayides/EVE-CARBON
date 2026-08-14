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

  // Card widgets must fit whole; the tables may scroll vertically but never
  // horizontally (that is how the ACTIVITY and PROGRESS columns went missing).
  const mustNotClip = new Set(['killTicker', 'jobWatch', 'charWallet', 'latestPing']);

  for (const [base, fn] of [['killTicker', kills], ['jobWatch', jobwatch], ['charWallet', wallet], ['latestPing', latestPing], ['activeJobs', activeJobs]]) {
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
