'use strict';
//
// The main colour and the negative colour are two different colours.
//
// They were one slot. `@roles` named `red` for BOTH `accent` and `danger`, so
// the swatch labelled "Negative — losses, danger, alerts" was also driving every
// --accent* token: roughly 470 of the app's ~635 colour references, across 25
// stylesheets and 81 more in JS. Every icon, hover, focus ring, nav highlight,
// KPI figure and banner glow moved when you adjusted the colour that is only
// supposed to mean "you lost a ship" — so you could not have red losses and a
// non-red app, and nothing said so.
//
// Nothing catches that class of bug by looking at one file: the roles line, the
// generator and the stylesheet each looked reasonable on their own. So the
// property is asserted directly — move one swatch, prove the other role stays
// put — in both directions.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT  = path.join(__dirname, '..');
const TV    = require(path.join(ROOT, 'src', 'shared', 'theme-vars.js'));
const THEME = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'theme-default.css'), 'utf8');

const meta = TV.parseThemeCssMeta(THEME);

/** A full swatch set in the post-split shape. */
const SW = {
  main: '#e09ed2', red: '#e0483a', teal: '#4ecbb0', purple: '#9b7fd4', pink: '#e47baf',
  green: '#4ada8a', yellow: '#e6c84a', orange: '#f58c42', gold: '#ffd24a', blue: '#4a9fd4',
  background: '#070a12', panel: '#10141f', text: '#ccd1da', border: '#3a4150',
};
const ROLES = { accent: 'main', danger: 'red', success: 'green', warning: 'orange', info: 'blue' };

const ACCENT_TOKENS = ['--accent', '--accent-dim', '--accent-glow', '--accent-08',
                       '--accent-25', '--accent-50', '--glow-color', '--glow-color-2'];
const DANGER_TOKENS = ['--pal-red', '--danger', '--danger-bg', '--danger-border', '--status-offline'];

// ── The split itself ─────────────────────────────────────────────────────────

test('moving Negative does not move the app', () => {
  // The bug, stated as a property. Before the split every one of these changed.
  const base = TV.buildCssVarsFromCustom(SW, ROLES);
  const red  = TV.buildCssVarsFromCustom({ ...SW, red: '#00ff00' }, ROLES);
  for (const tok of ACCENT_TOKENS) {
    assert.ok(base[tok], `${tok} is not derived at all`);
    assert.strictEqual(red[tok], base[tok], `${tok} followed the Negative swatch`);
  }
});

test('moving Negative DOES move what is actually negative', () => {
  // The other half: having split them, the danger role must still be live, or
  // the swatch has been made decorative instead of separated.
  const base = TV.buildCssVarsFromCustom(SW, ROLES);
  const red  = TV.buildCssVarsFromCustom({ ...SW, red: '#00ff00' }, ROLES);
  for (const tok of DANGER_TOKENS) {
    assert.ok(base[tok], `${tok} is not derived at all`);
    assert.notStrictEqual(red[tok], base[tok], `${tok} ignored the Negative swatch`);
  }
});

test('moving Main moves the app and leaves the danger colours alone', () => {
  const base = TV.buildCssVarsFromCustom(SW, ROLES);
  const main = TV.buildCssVarsFromCustom({ ...SW, main: '#00ff00' }, ROLES);
  for (const tok of ACCENT_TOKENS) {
    assert.notStrictEqual(main[tok], base[tok], `${tok} ignored the Main swatch`);
  }
  for (const tok of DANGER_TOKENS) {
    assert.strictEqual(main[tok], base[tok], `${tok} followed the Main swatch`);
  }
});

// ── Themes written before the split ──────────────────────────────────────────

test('a theme saved before the split looks exactly as its author left it', () => {
  // Every user theme on disk names accent:'red' and has no `main` swatch. If the
  // fallback chain were wrong they would all silently repaint on upgrade, which
  // is the one outcome worse than the bug being fixed.
  const legacyRoles = { accent: 'red', danger: 'red', success: 'green', warning: 'orange', info: 'blue' };
  const { main, ...legacySw } = SW;
  const legacy = TV.buildCssVarsFromCustom(legacySw, legacyRoles);

  assert.strictEqual(legacy['--accent'], legacySw.red, 'accent must still resolve to the red swatch');
  assert.ok(legacy['--accent-08'].includes('224,72,58'), legacy['--accent-08']);
  // And it must not come out grey from an undefined slot.
  for (const tok of ACCENT_TOKENS) {
    assert.ok(legacy[tok], `${tok} missing`);
    assert.ok(!/#(\w)\1{5}/.test(String(legacy[tok])), `${tok} came out neutral: ${legacy[tok]}`);
  }
});

test('a theme naming main without having one falls back rather than blanking', () => {
  const { main, ...noMain } = SW;
  const v = TV.buildCssVarsFromCustom(noMain, ROLES);   // roles say main, swatch absent
  assert.strictEqual(v['--accent'], noMain.red);
});

// ── --accent-dim has a contrast floor ────────────────────────────────────────

test('the accent-dim backdrop stays dark whatever accent is chosen', () => {
  // .panel-count is `background: var(--accent-dim); color: var(--accent)`, so
  // this pair has to hold apart. darken(x, 0.25) only produced a dark backdrop
  // because the old accent was a mid-lightness crimson; the same call on a
  // pastel lands mid-tone and the text on it stops being readable.
  for (const hex of ['#e09ed2', '#ffe08a', '#e0483a', '#4a9fd4', '#ffffff']) {
    const v = TV.buildCssVarsFromCustom({ ...SW, main: hex }, ROLES);
    const dimL    = TV.hexToHsl(v['--accent-dim'])[2];
    const accentL = TV.hexToHsl(hex)[2];
    assert.ok(dimL <= 32, `--accent-dim for ${hex} is L${Math.round(dimL)}, too light to sit text on`);
    assert.ok(accentL - dimL > 15,
      `${hex} (L${Math.round(accentL)}) on its dim (L${Math.round(dimL)}) has too little separation`);
  }
});

test('dimOf keeps the hue and only pins the lightness', () => {
  const [h, s] = TV.hexToHsl('#e09ed2');
  const [dh, ds, dl] = TV.hexToHsl(TV.dimOf('#e09ed2'));
  assert.ok(Math.abs(dh - h) < 2, `hue drifted ${h} -> ${dh}`);
  assert.ok(Math.abs(ds - s) < 2, `saturation drifted ${s} -> ${ds}`);
  assert.ok(Math.abs(dl - 30) < 1, `lightness should land at 30, got ${dl}`);
  assert.strictEqual(TV.dimOf(undefined), undefined, 'a missing colour passes through');
});

// ── The built-in theme agrees with all of the above ──────────────────────────

test('the built-in theme names main as its accent and red as its danger', () => {
  assert.strictEqual(meta.roles.accent, 'main');
  assert.strictEqual(meta.roles.danger, 'red');
  assert.ok(meta.swatches.main, 'the built-in theme must carry a main swatch');
  assert.notStrictEqual(meta.swatches.main, meta.swatches.red,
    'if these are equal the split is cosmetic');
});

test('the built-in --accent is the main swatch, not the red one', () => {
  const decl = /--accent:\s*(#[0-9a-fA-F]{6})/.exec(THEME);
  assert.ok(decl, '--accent must be declared');
  assert.strictEqual(decl[1].toLowerCase(), meta.swatches.main.toLowerCase());
});

test('no --accent* token in the built-in theme is still the old crimson', () => {
  // The alpha ladder was thirteen hand-written rgba()s of the crimson. A single
  // missed line would leave one hover or one focus ring red while the rest of
  // the app moved — the sort of thing nobody spots for months.
  const block = THEME.slice(THEME.indexOf('--accent:'), THEME.indexOf('--text-1:'));
  assert.ok(!/224,\s*72,\s*58/.test(block), 'an --accent* token is still crimson rgba');
  assert.ok(!/#e0483a/i.test(block), 'an --accent* token is still #e0483a');
  // ...and they are all the main hue.
  const alphas = block.match(/--accent-\d+:\s*rgba\([^)]+\)/g) || [];
  assert.ok(alphas.length >= 13, `expected the full alpha ladder, found ${alphas.length}`);
  // Derived from the declared --accent rather than hardcoded, so moving the
  // default colour does not mean editing this test — and so a ladder left on the
  // PREVIOUS accent is caught, which is the failure that actually happens.
  const [ar, ag, ab] = [1, 3, 5].map(i => parseInt(meta.swatches.main.substr(i, 2), 16));
  for (const a of alphas) {
    assert.match(a, new RegExp(`${ar},\\s*${ag},\\s*${ab}`),
      `${a} is not an alpha of --accent (${ar},${ag},${ab})`);
  }
});

test('the danger alpha helpers are red, not accent', () => {
  // These two read as accent alphas for as long as the roles were fused. A
  // failed character sync is a failure and must stay red however Main is set.
  for (const tok of ['--danger-bg', '--danger-border']) {
    const decl = new RegExp(`${tok}:\\s*(rgba\\([^)]+\\))`).exec(THEME);
    assert.ok(decl, `${tok} must be declared`);
    assert.match(decl[1], /224,\s*86,\s*75/, `${tok} is not derived from --pal-red: ${decl[1]}`);
  }
});

test('the theme still declares every accent token the generator produces', () => {
  // The hand-written built-in and the generated user themes have to expose the
  // same surface, or a token works on a custom theme and is blank on the default.
  const generated = TV.buildCssVarsFromCustom(SW, ROLES);
  for (const tok of Object.keys(generated).filter(k => k.startsWith('--accent'))) {
    assert.ok(new RegExp(`\\s${tok}:`).test(THEME), `${tok} is generated but missing from theme-default.css`);
  }
});

// ── The editor offers it, and offers it first ────────────────────────────────

test('Main is the first swatch in the editor and sits in its own group', () => {
  const src   = fs.readFileSync(path.join(ROOT, 'src', 'func', 'palette.js'), 'utf8');
  const block = src.slice(src.indexOf('const SWATCH_SLOTS = ['), src.indexOf('const SWATCH_GROUPS'));
  const first = /\{\s*key:\s*'([^']+)'\s*,\s*group:\s*'([^']+)'/.exec(block);
  assert.strictEqual(first[1], 'main', 'Main must come first — it is the colour the rest are read against');
  assert.strictEqual(first[2], 'primary', 'Main must not sit in the STATUS row it was confused with');

  const groups = src.slice(src.indexOf('const SWATCH_GROUPS = ['));
  const firstGroup = /id:\s*'([^']+)'/.exec(groups);
  assert.strictEqual(firstGroup[1], 'primary', 'the MAIN heading must render above STATUS');
});

test('a theme saved from the editor carries the split roles', () => {
  const ipc = fs.readFileSync(path.join(ROOT, 'src', 'ipc', 'theme_ipc.js'), 'utf8');
  const save = ipc.slice(ipc.indexOf("ipcHandle('theme-save-custom'"));
  assert.match(save.slice(0, 1200), /accent:\s*'main'/,
    'a newly saved theme must default to accent:main, or the split only applies to the built-in');
});

// ── Editing a theme that predates the split ──────────────────────────────────
//
// The bug this pins: every existing user theme names accent:'red' and has no
// `main` swatch, and the app deliberately keeps painting them that way so none
// of them repaints on upgrade. That compatibility path was airtight — and it had
// no door out. The Main swatch showed a grey placeholder for a slot the theme
// did not have, the live preview was handed the theme's old roles, and saving
// wrote those roles straight back. Main was inert for everybody who already had
// a theme, with nothing on screen saying why.
//
// The tests above all pass while that is true, because they exercise the
// GENERATOR with post-split inputs. This exercises the EDITOR with a real
// pre-split theme.
function loadPalette(currentTheme) {
  const vm = require('vm');
  const noop = () => {};
  const sb = {
    console, Math, Date, JSON, Map, Set, Promise, Object, Array, String, Number,
    Boolean, RegExp, Error, isNaN, parseFloat, parseInt, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { getElementById: () => null, querySelector: () => null,
                querySelectorAll: () => [], createElement: () => ({ style: {} }),
                head: { appendChild: noop }, body: { classList: { contains: () => false } },
                documentElement: { style: { removeProperty: noop, setProperty: noop } } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    window: { ThemeVars: TV, eveAPI: {} },
  };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'func', 'palette.js'), 'utf8'), ctx,
    { filename: 'palette.js' });
  // `_currentTheme` is a module-level `let`; assigning to it from an eval in the
  // same context reaches the binding.
  vm.runInContext(`_currentTheme = ${JSON.stringify(currentTheme)};`, ctx);
  return { sb, ctx };
}

// A real pre-split user theme, taken from one on disk.
const LEGACY_THEME = {
  id: 'user:Ms Moirai.css', name: 'Ms Moirai',
  roles: { accent: 'red', danger: 'red', success: 'green', warning: 'orange', info: 'blue' },
  swatches: {
    red: '#eb1d0a', green: '#4ada8a', gold: '#ffd24a', yellow: '#f3841b', blue: '#4a9fd4',
    teal: '#2ebd9e', purple: '#9b7fd4', pink: '#e47baf', orange: '#c06c30',
    background: '#070a12', panel: '#10141f', text: '#ccd1da', border: '#3a4150',
  },
};

test('the Main swatch of a pre-split theme shows the colour actually in use', () => {
  // Not #888888. A grey placeholder for a slot the theme lacks is what made this
  // look broken: you edit grey, nothing happens, and the app stays red.
  const { sb } = loadPalette(LEGACY_THEME);
  assert.strictEqual(sb.editorSwatches().main, '#eb1d0a');
});

test('the editor makes a pre-split theme main-driven', () => {
  const { sb } = loadPalette(LEGACY_THEME);
  assert.strictEqual(sb.editorRoles().accent, 'main', 'or Main can never take effect');
  assert.strictEqual(sb.editorRoles().danger, 'red', 'and losses stay red');
});

test('opening the editor and saving without touching Main changes nothing', () => {
  // The migration must be free. Main is seeded from the old accent, so a save
  // that does not touch it has to produce the identical accent.
  const { sb } = loadPalette(LEGACY_THEME);
  const before = TV.buildCssVarsFromCustom(LEGACY_THEME.swatches, LEGACY_THEME.roles);
  const after  = TV.buildCssVarsFromCustom(sb.editorSwatches(), sb.editorRoles());
  for (const tok of ACCENT_TOKENS) {
    assert.strictEqual(after[tok], before[tok], `${tok} moved on a no-op save`);
  }
  assert.strictEqual(after['--accent'], '#eb1d0a');
});

test('changing Main on a pre-split theme repaints the app', () => {
  // The whole point. This is what did not work.
  const { sb, ctx } = loadPalette(LEGACY_THEME);
  const vm = require('vm');
  vm.runInContext("_editSwatches = { main: '#e09ed2' };", ctx);

  const vars = TV.buildCssVarsFromCustom(sb.editorSwatches(), sb.editorRoles());
  assert.strictEqual(vars['--accent'], '#e09ed2', 'Main must drive the accent');
  assert.ok(vars['--accent-08'].includes('224,158,210'), vars['--accent-08']);
  // ...and the negative colour is untouched by it.
  assert.strictEqual(vars['--pal-red'], TV.lighten('#eb1d0a', 0.10));
  assert.notStrictEqual(vars['--danger'], vars['--accent']);
});

test('a theme nobody edits is still left exactly alone', () => {
  // The compatibility path stays: the migration happens in the EDITOR, on a save
  // the user asked for — not silently at load.
  const v = TV.buildCssVarsFromCustom(LEGACY_THEME.swatches, LEGACY_THEME.roles);
  assert.strictEqual(v['--accent'], '#eb1d0a');
});
