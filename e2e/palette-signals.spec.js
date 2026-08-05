// The palette is the user's to recolour. The operational signals are not.
//
// The Beehive stand-down light used to be wired to --pal-red / --pal-gold /
// --pal-green, so recolouring "losses" recoloured STAND DOWN with it — the one
// indicator that has to be unmistakable mid-op could end up rendered in whatever
// hue somebody picked for a chart series. src/styles/signals.css splits them by
// load order (it is linked AFTER the theme), and this holds that split.
const { test, expect } = require('./support/electron-app');

const openPalette = async (window) => {
  await window.locator('#openSettingsBtn').click();
  await window.locator('[data-settings-tab="palette"]').click();
  await expect(window.locator('#settingsTabPalette')).toBeVisible({ timeout: 15_000 });
};

const cssVar = (window, name) => window.evaluate(
  (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('the signal colours exist and are distinct', async ({ window }) => {
  const go   = await cssVar(window, '--signal-go');
  const hold = await cssVar(window, '--signal-hold');
  const stop = await cssVar(window, '--signal-stop');
  for (const [name, v] of [['go', go], ['hold', hold], ['stop', stop]]) {
    expect(v, `--signal-${name} must be defined`).toMatch(/^#|rgb/);
  }
  expect(new Set([go, hold, stop]).size, 'a traffic light needs three distinct colours').toBe(3);
});

test('recolouring the palette does NOT move the signals', async ({ window }) => {
  await openPalette(window);
  const before = {
    stop:   await cssVar(window, '--signal-stop'),
    go:     await cssVar(window, '--signal-go'),
    hold:   await cssVar(window, '--signal-hold'),
    palRed: await cssVar(window, '--pal-red'),
  };

  // Drive the real editor path: enter customise mode and change every swatch.
  await window.evaluate(() => document.getElementById('paletteEditBtn')?.click());
  await window.waitForTimeout(400);
  const changed = await window.evaluate(async () => {
    const inputs = [...document.querySelectorAll('#settingsTabPalette input[type="color"]')];
    inputs.forEach((inp, i) => {
      inp.value = i % 2 ? '#00FF00' : '#0000FF';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 500));
    return inputs.length;
  });
  expect(changed, 'the editor offered swatches to change').toBeGreaterThan(0);

  // The palette moved. Not asserted against an exact hex: the generator derives
  // each token from its swatch with a tonal adjustment, so #0000ff arrives as
  // #3333ff — what matters is that it is no longer the default.
  const palRed = await cssVar(window, '--pal-red');
  expect(palRed, 'the palette did change').not.toBe(before.palRed);

  // …and the traffic light did not.
  expect(await cssVar(window, '--signal-stop'), 'STAND DOWN must not follow the palette').toBe(before.stop);
  expect(await cssVar(window, '--signal-go'),   'RUNNING must not follow the palette').toBe(before.go);
  expect(await cssVar(window, '--signal-hold'), 'HOLDING must not follow the palette').toBe(before.hold);
});

// ── Panel opacity: one control, and it has to actually do something ──────────
//
// There used to be two sliders for this — "UI Transparency" in the palette tab
// and "Panel opacity" under Glass — and each was silently inert in the other
// mode. glass.css declares the --bg-* tokens on `body.glass-on`, and custom
// properties inherit downward, so the palette slider's :root writes were
// shadowed for the entire visible UI. With glass on (the default) dragging it
// end to end left the real panel background byte-identical.

const panelBg = (window) => window.evaluate(() => {
  const el = document.querySelector('.dashboard-panel, .panel, #page-dashboard');
  return el ? getComputedStyle(el).backgroundColor : null;
});

const setAppearance = (window, { glass, alpha }) => window.evaluate(async (o) => {
  const s = _getGlassSettings();
  if (o.glass !== undefined) s.enabled = o.glass;
  if (o.alpha !== undefined) s.tintAlpha = o.alpha;
  _saveGlassSettings(s);
  await applyGlass(s);
  await new Promise(r => setTimeout(r, 200));
}, { glass, alpha });

test('panel opacity changes the panels WITH glass on', async ({ window }) => {
  await setAppearance(window, { glass: true, alpha: 0.20 });
  const low = await panelBg(window);
  await setAppearance(window, { glass: true, alpha: 0.90 });
  const high = await panelBg(window);
  expect(low, 'a panel background was measurable').toBeTruthy();
  expect(high, 'the slider must move the real background, not just a variable').not.toBe(low);
});

test('panel opacity changes the panels WITHOUT glass', async ({ window }) => {
  await setAppearance(window, { glass: false, alpha: 0.20 });
  const low = await panelBg(window);
  await setAppearance(window, { glass: false, alpha: 0.90 });
  const high = await panelBg(window);
  expect(high, 'the no-glass path must work too').not.toBe(low);
});

test('there is exactly one opacity control', async ({ window }) => {
  // Two sliders for one setting is how the dead one went unnoticed for so long.
  await window.locator('#openSettingsBtn').click();
  await window.locator('[data-settings-tab="background"]').click();
  await expect(window.locator('#glassTintAlphaSlider')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('#uiTransparencySlider')).toHaveCount(0);
});
