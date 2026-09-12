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

// ── Main is live for a theme that predates it ────────────────────────────────
//
// This is the bug the unit tests could not see. Every theme a user had already
// saved names accent:'red' and has no `main` swatch, and the app deliberately
// keeps painting those exactly as they were so nothing repaints on upgrade. That
// left Main inert for everyone who already had a theme: it rendered a grey
// placeholder, the live preview got the theme's old roles, and saving wrote
// those roles back. Set Main, nothing happens, no explanation.
//
// Driven through the real renderer, on a real pre-split theme, because the
// generator tests all pass while this is broken.
test('the Main swatch moves the app on a theme written before it existed', async ({ window }) => {
  await openPalette(window);

  const result = await window.evaluate(async () => {
    // A real pre-split user theme: accent bound to red, no `main` swatch.
    _currentTheme = {
      id: 'user:Legacy.css', name: 'Legacy',
      roles: { accent: 'red', danger: 'red', success: 'green', warning: 'orange', info: 'blue' },
      swatches: {
        red: '#eb1d0a', green: '#4ada8a', gold: '#ffd24a', yellow: '#f3841b', blue: '#4a9fd4',
        teal: '#2ebd9e', purple: '#9b7fd4', pink: '#e47baf', orange: '#c06c30',
        background: '#070a12', panel: '#10141f', text: '#ccd1da', border: '#3a4150',
      },
    };
    _editSwatches = null;

    // What the editor offers before anything is touched.
    const seeded = editorSwatches().main;
    const roles  = editorRoles();

    // A no-op save must not move the accent...
    previewTheme(editorSwatches(), editorRoles());
    const read = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const untouched = { accent: read('--accent'), danger: read('--danger') };

    // ...and setting Main must.
    _editSwatches = { main: '#e09ed2' };
    previewTheme(editorSwatches(), editorRoles());
    const changed = { accent: read('--accent'), danger: read('--danger') };

    removeThemePreview();
    return { seeded, accentRole: roles.accent, untouched, changed };
  });

  // The pill shows the colour actually in use, not the #888888 placeholder for
  // a slot this theme does not have.
  expect(result.seeded.toLowerCase(), 'Main must be seeded from the accent in use').toBe('#eb1d0a');
  expect(result.accentRole, 'the editor must make the theme main-driven').toBe('main');

  // Migrating costs nothing: untouched, it is still the theme it was.
  expect(result.untouched.accent.toLowerCase()).toBe('#eb1d0a');

  // And the actual complaint: setting Main repaints the app.
  expect(result.changed.accent.toLowerCase(), 'Main did not reach --accent').toBe('#e09ed2');
  expect(result.changed.danger, 'and it must not have dragged the loss colour with it')
    .toBe(result.untouched.danger);
});

// ── The editor must not leave the app wearing an unsaved preview ─────────────
//
// Reported as "the UI is pink but the Main swatch still says red", and both were
// telling the truth about different things. previewTheme() injects a <style> of
// whatever you are dragging, and only applyTheme() and the Cancel button ever
// removed it. Leave the editor any other way — close the drawer, or press the
// drawer's big SAVE, which commits Jabber and calendar settings and never had
// anything to do with the palette — and that <style> stayed applied for the rest
// of the session. The app wore colours that were never saved anywhere while the
// editor faithfully reported the theme file.
test('closing settings drops an unsaved palette preview instead of wearing it', async ({ window }) => {
  await openPalette(window);

  const before = await cssVar(window, '--accent');

  // Drag Main somewhere obvious, exactly as the editor does.
  await window.evaluate(() => {
    if (!_editSwatches) _editSwatches = {};
    _editSwatches.main = '#00ff88';
    previewTheme(editorSwatches(), editorRoles());
  });
  expect(await cssVar(window, '--accent'), 'the preview should be live while editing').toBe('#00ff88');

  // Now leave WITHOUT using SAVE PALETTE — the drawer's own save button.
  await window.locator('#saveSettingsBtn').click();
  await expect(window.locator('#uiSettingsDrawer')).toBeHidden();

  expect(await cssVar(window, '--accent'),
    'an unsaved preview must not survive leaving the editor').toBe(before);
  expect(await window.evaluate(() => !!document.getElementById('eve-theme-preview')),
    'the preview <style> must be gone').toBe(false);

  // And reopening must agree with what is on screen.
  await openPalette(window);
  expect(await cssVar(window, '--accent'), 'reopening must not resurrect it').toBe(before);
});

// ── Deleting a theme does not require editing one ────────────────────────────
//
// DELETE used to live inside the save row, shown only in edit mode — so removing
// a theme with a mistyped name meant clicking CUSTOMISE (entering an edit state,
// arming the live preview) purely to reach the button, then leaving again. It is
// now beside the picker, on the theme you are actually looking at.
test('a custom theme can be deleted straight from the picker', async ({ window }) => {
  await openPalette(window);
  const select = window.locator('#themeSelect');
  const del    = window.locator('#themeDeleteBtn');

  // A built-in cannot be deleted, so the button must not be offered for one.
  await expect(del).toBeHidden();

  // Make a custom theme to delete.
  await window.locator('#paletteEditBtn').click();
  await window.locator('#paletteNameInput').fill('Typoo Theme');
  await window.locator('#paletteSaveBtn').click();
  await expect(select.locator('option', { hasText: 'Typoo Theme' })).toHaveCount(1, { timeout: 15_000 });

  // It is selected and active after saving, and now deletable — with no trip
  // through CUSTOMISE.
  await expect(del).toBeVisible();
  await expect(window.locator('#paletteSaveRow')).toBeHidden();

  await del.click();
  const dialog = window.locator('.cf-backdrop');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Typoo Theme');
  await dialog.locator('.cf-go').click();

  await expect(select.locator('option', { hasText: 'Typoo Theme' })).toHaveCount(0, { timeout: 15_000 });
  // Deleting the ACTIVE theme falls back to the built-in rather than leaving the
  // app pointed at a file that no longer exists.
  await expect(del).toBeHidden();
});

test('cancelling the delete keeps the theme', async ({ window }) => {
  await openPalette(window);
  await window.locator('#paletteEditBtn').click();
  await window.locator('#paletteNameInput').fill('Keep Me');
  await window.locator('#paletteSaveBtn').click();
  const select = window.locator('#themeSelect');
  await expect(select.locator('option', { hasText: 'Keep Me' })).toHaveCount(1, { timeout: 15_000 });

  await window.locator('#themeDeleteBtn').click();
  await window.locator('.cf-backdrop .cf-cancel').click();
  await expect(select.locator('option', { hasText: 'Keep Me' })).toHaveCount(1);
});

test('editing your own theme offers to update it, not to spawn a copy', async ({ window }) => {
  // Every save of a theme you already owned used to prefill "Copy of X", so the
  // picker filled up with near-identical themes — which is what made an easy
  // delete necessary in the first place.
  await openPalette(window);
  await window.locator('#paletteEditBtn').click();
  await expect(window.locator('#paletteNameInput')).toHaveValue(/^Copy of /, { timeout: 5_000 });
  await window.locator('#paletteNameInput').fill('Mine');
  await window.locator('#paletteSaveBtn').click();
  await expect(window.locator('#themeSelect').locator('option', { hasText: 'Mine' }))
    .toHaveCount(1, { timeout: 15_000 });

  // Now editing MY theme should default to updating it.
  await window.locator('#paletteEditBtn').click();
  await expect(window.locator('#paletteNameInput')).toHaveValue('Mine');
});
