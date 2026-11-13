// Fleet Commander page: sub-nav tabs (Composition / Fitting Simulator / Fleet
// Fight Notify) all switch cleanly and stay error-free. Composition needs a
// live fleet to show real data, so this only checks it initializes without
// crashing — not fleet content.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="fc"]').click();
  await expect(window.locator('#page-fc')).toBeVisible({ timeout: 15_000 });
});

test('defaults to the Fleet Composition tab', async ({ window }) => {
  await expect(window.locator('.fc-sub-btn[data-fc-tab="composition"]')).toHaveClass(/active/);
  await expect(window.locator('#fcTabContent')).toBeVisible();
});

test('Fitting Simulator tab loads without crashing', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));
  await window.locator('.fc-sub-btn[data-fc-tab="fitting"]').click();
  await expect(window.locator('.fc-sub-btn[data-fc-tab="fitting"]')).toHaveClass(/active/);
  await window.waitForTimeout(1000);
  expect(errors).toEqual([]);
});

test('Fleet Fight Notify tab embeds the CCP page', async ({ window }) => {
  await window.locator('.fc-sub-btn[data-fc-tab="fleetfight"]').click();
  await expect(window.locator('#fcFleetFightWebview')).toBeVisible({ timeout: 10_000 });
});

test('fitting ship browser mirrors the in-game market tree (with group icons)', async ({ window }) => {
  await window.locator('.fc-sub-btn[data-fc-tab="fitting"]').click();
  await expect(window.locator('#fitResults .ft-grp').first()).toBeVisible({ timeout: 15_000 });

  const info = await window.evaluate(() => ({
    top: [...document.querySelectorAll('#fitResults > details.ft-grp > summary .ft-grp-name')].map(s => s.textContent.trim()),
    groupIcons: document.querySelectorAll('#fitResults .ft-grp-icon').length,
  }));
  // Market-group sections, not the old inventory-group "classes".
  expect(info.top).toContain('Battleships');
  expect(info.top).toContain('Special Edition Ships');
  // "Covert Ops" was a top-level class in the old (mis-)grouping; in the market
  // tree it's nested (under Frigates / Special Edition), never a top section.
  expect(info.top).not.toContain('Covert Ops');
  expect(info.groupIcons).toBeGreaterThan(0);   // group rows now carry icons
});

// Fractured Skies against the REAL SDE. The unit tests pin the maths on frozen
// fixtures; this proves the dogma rows main reads from dgmEffectModifiers exist
// in a freshly built database and land in the sim.
test('Fractured Skies hulls and Synchronizer rigs simulate from the real SDE', async ({ window }) => {
  await window.locator('.fc-sub-btn[data-fc-tab="fitting"]').click();
  await expect(window.locator('#fitResults .ft-grp').first()).toBeVisible({ timeout: 15_000 });
  const r = await window.evaluate(async () => {
    _fitState.skills.mode = 'all5';
    // Mega Pulse Laser II, Medium + Large Imperial Navy Synchronizer, Imperial
    // Navy Heat Sink, 1600mm Steel Plates II.
    const items = await window.eveAPI.fitGetItems([3057, 96131, 96132, 15810, 20353]);
    // Oracle Navy Issue: a full rack of battleship lasers.
    await _fitLoadHull(95629);
    const turrets = _fitState.hull.hardpoints.turret;
    for (let i = 0; i < turrets; i++) _fitAddModule(items[3057]);
    const oracle = {
      rows: (_fitState.hull.fittingMods || []).length, turrets, fitted: _fitFilled('high').length,
      pg: _fitComputeUsage().pg, pgOut: _fitEffOutputs().pg, cpuOut: _fitEffOutputs().cpu,
      laserPg: items[3057].pg,
    };
    // Synchronizers are rig-sized: the Navy Issue takes medium rigs.
    const largeRefusal = _fitCanFit(items[96132]);
    _fitAddModule(items[96131]);
    _fitAddModule(items[15810]);
    _fitAddModule(items[15810]);
    const sync = _fitSync();
    oracle.syncN = sync ? sync.n : null;
    oracle.cpuOutSync = _fitEffOutputs().cpu;
    // Talos Navy Issue: plate mass −75% from the hull at V, −25% Armor Layering.
    await _fitLoadHull(95631);
    const m0 = _fitShipDerived().mass;
    _fitAddModule(items[20353]);
    const plate = { added: _fitShipDerived().mass - m0, raw: items[20353].attrs[796], group: items[20353].groupId };
    return { oracle, largeRefusal, plate };
  });
  expect(r.oracle.rows).toBeGreaterThan(0);
  expect(r.oracle.fitted).toBe(r.oracle.turrets);
  // 95% powergrid role bonus, then Advanced Weapon Upgrades V.
  expect(r.oracle.pg).toBeCloseTo(r.oracle.turrets * r.oracle.laserPg * 0.05 * 0.9, 3);
  expect(r.oracle.pg).toBeLessThan(r.oracle.pgOut);
  expect(r.largeRefusal).toMatch(/large rig/);
  expect(r.oracle.syncN).toBe(2);
  // −10% CPU output, halved by Synchronization Rigging V.
  expect(r.oracle.cpuOutSync / r.oracle.cpuOut).toBeCloseTo(0.95, 6);
  expect(r.plate.group).toBe(329);
  expect(r.plate.added).toBeCloseTo(r.plate.raw * 0.25 * 0.75, 0);
});

test('Chremoas is filed under Special Edition Ships, not Covert Ops', async ({ window }) => {
  await window.locator('.fc-sub-btn[data-fc-tab="fitting"]').click();
  await expect(window.locator('#fitResults .ft-grp').first()).toBeVisible({ timeout: 15_000 });

  await window.locator('details.ft-grp > summary', { hasText: 'Special Edition Ships' }).first().click();
  await window.locator('details.ft-grp > summary', { hasText: 'Special Edition Covert Ops' }).first().click();
  await expect(window.locator('#fitResults .fit-result[data-name="Chremoas"]')).toBeVisible({ timeout: 10_000 });
});
