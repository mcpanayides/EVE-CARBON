// palette.js — theme application + palette editor UI
//
// Themes are plain CSS files (styles/theme-*.css for built-ins,
// userData/themes/*.css for user themes). Applying a theme = pointing the
// #themeStylesheet <link> at the right file; the chosen href is mirrored to
// localStorage so every window can restore it before first paint (no flash).
// Only the palette editor's live preview still injects CSS variables inline,
// via the shared ThemeVars module (window.ThemeVars, src/shared/theme-vars.js).

const THEME_LS_KEY = 'eve-theme-css';

// ── Theme application (stylesheet link swap) ─────────────────────────────────

function themeHref(theme) {
  if (theme?.file) return `./styles/${theme.file}`;                              // built-in
  if (theme?.path) return 'file:///' + encodeURI(theme.path.replace(/\\/g, '/')); // user theme
  return './styles/theme-default.css';
}

function applyTheme(theme) {
  const link = document.getElementById('themeStylesheet');
  if (!link) return;
  removeThemePreview();
  const href = themeHref(theme);
  if (link.getAttribute('href') !== href) {
    // Transparency reads computed colours — wait for the new sheet to load
    link.onload = () => applyUiTransparency();
    link.setAttribute('href', href);
  } else {
    applyUiTransparency();
  }
  // Persist for the pre-paint scripts (index.html, ping-alert, widget windows)
  try {
    localStorage.setItem(THEME_LS_KEY, JSON.stringify(
      theme?.file ? { file: theme.file } : { path: theme?.path || null }
    ));
  } catch {}
}

// ── Palette-editor live preview (inline var overrides, removed on cancel) ────

function previewTheme(swatches, roles) {
  const vars = window.ThemeVars.buildCssVarsFromCustom(swatches, roles);
  let el = document.getElementById('eve-theme-preview');
  if (!el) {
    el = document.createElement('style');
    el.id = 'eve-theme-preview';
    document.head.appendChild(el);
  }
  el.textContent = `:root {\n${window.ThemeVars.varsToCss(vars)}\n}`;
  applyUiTransparency();
}

function removeThemePreview() {
  document.getElementById('eve-theme-preview')?.remove();
}

// ── Global panel opacity ──────────────────────────────────────────────────────
// Themes bake an alpha into their surface colours (and some are fully opaque).
// This applies the user's one "Panel opacity" setting on top of any theme, so
// the wallpaper shows through. Implemented as an inline override on :root,
// cleared + re-derived each time so a theme switch reads the new theme's true
// colours.
//
// ONLY WHEN GLASS IS OFF, and that caveat is the whole story. glass.css declares
// the same --bg-* tokens on `body.glass-on`, and custom properties inherit
// downward — so a value set here on :root is shadowed by body's for the entire
// visible UI. There used to be a separate "UI Transparency" slider in the
// palette tab doing exactly this, and with glass on (the default) it wrote a
// variable nothing read: measured, the real panel background was byte-identical
// before and after dragging it end to end.
//
// So there is now ONE control — "Panel opacity" in Wallpaper and Colour — and it
// takes whichever path actually works: --glass-tint-alpha under glass (handled
// by applyGlass), these inline overrides without it.
const UI_SURFACE_VARS = ['--bg-panel','--bg-card','--bg-card-deep','--bg-deep','--bg-input','--bg-modal','--bg-surface'];

function _parseRgb(str) {
  if (!str) return null;
  str = str.trim();
  let m = str.match(/^#([0-9a-f]{3})$/i);
  if (m) { const h = m[1]; return { r: parseInt(h[0]+h[0],16), g: parseInt(h[1]+h[1],16), b: parseInt(h[2]+h[2],16) }; }
  m = str.match(/^#([0-9a-f]{6})$/i);
  if (m) { const h = m[1]; return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) }; }
  m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]) };
  return null;
}

/** The one panel-opacity setting, shared with the glass controls in ui.js. */
function getPanelOpacity() {
  try {
    const s = (typeof _getGlassSettings === 'function') ? _getGlassSettings() : null;
    const a = s && Number(s.tintAlpha);
    if (Number.isFinite(a)) return Math.max(0.05, Math.min(1, a));
  } catch (_) { /* fall through to the default */ }
  return 0.45;
}

function applyUiTransparency() {
  const root = document.documentElement;
  // Clear prior inline overrides so getComputedStyle reads the active theme's
  // real surface colours (not a previously-applied alpha).
  UI_SURFACE_VARS.forEach(v => root.style.removeProperty(v));
  // Under glass, body.glass-on owns these tokens and shadows anything set here.
  // Writing them anyway is what made the old slider look functional while doing
  // nothing at all — so this path stands down and leaves it to applyGlass.
  if (document.body && document.body.classList.contains('glass-on')) return;
  const alpha = +getPanelOpacity().toFixed(3);
  const cs = getComputedStyle(root);
  UI_SURFACE_VARS.forEach(v => {
    const rgb = _parseRgb(cs.getPropertyValue(v));
    if (rgb) root.style.setProperty(v, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`);
  });
}

// ── Apply saved theme at startup ──────────────────────────────────────────────

async function initTheme() {
  // Drop the legacy injected-vars cache from the YAML-theme era
  try { localStorage.removeItem('eve-carbon-theme-vars'); } catch {}
  try {
    const cfg     = await window.eveAPI.getAppConfig();
    const themeId = cfg?.app?.theme || 'Default';
    const theme   = await window.eveAPI.themeGet(themeId)
                 || await window.eveAPI.themeGet('Default');
    if (theme) applyTheme(theme);   // no-op href-wise if the pre-paint script already set it
  } catch (e) {
    console.warn('[palette] initTheme failed:', e.message);
  }
  applyUiTransparency();
}

// ── Palette settings tab ──────────────────────────────────────────────────────

// The palette, named for what each colour DOES rather than what hue it happens
// to be today. "Red" tells you nothing about what changes when you edit it — and
// it becomes an outright lie the moment somebody sets it to blue. The job is the
// stable thing; the hue is the setting.
//
// Three groups, because they carry different risk:
//
//   STATUS     meaning-bearing. These are how the app says "this went well" or
//              "this is dangerous", so they are read as language, not decoration.
//              Swapping Positive and Negative would invert every gain and loss
//              in the app.
//   DATA       value categories and chart series. Free to restyle to taste —
//              they separate things visually and mean nothing on their own.
//   STRUCTURE  the surfaces everything else sits on.
//
// The `key` is the on-disk name and is NOT renamed: it is what themes already
// written to userData/themes/*.css store, and changing it would silently reset
// every custom theme somebody has made.
//
// baby_blue, indigo and cyan were dropped. They were offered here and written
// into every saved theme, but nothing in the app ever read them — you could pick
// any colour and nothing changed. A control that does nothing is worse than a
// missing one, because it costs the user a decision and then ignores it.
const SWATCH_SLOTS = [
  { key: 'red',    group: 'status', label: 'Negative',  desc: 'Losses, danger, alerts' },
  { key: 'green',  group: 'status', label: 'Positive',  desc: 'Gains, success, online' },
  { key: 'gold',   group: 'status', label: 'Caution',   desc: 'Warnings, holding states' },
  { key: 'yellow', group: 'status', label: 'Contested', desc: 'Contested, unknown basis' },
  { key: 'blue',   group: 'status', label: 'Info',      desc: 'Info accents, badges' },

  { key: 'teal',   group: 'data',   label: 'Liquid',    desc: 'Wallet balances, progress' },
  { key: 'purple', group: 'data',   label: 'Assets',    desc: 'Asset and stock values' },
  { key: 'pink',   group: 'data',   label: 'Series 1',  desc: 'Extra chart series' },
  { key: 'orange', group: 'data',   label: 'Series 2',  desc: 'Extra series, secondary warnings' },

  { key: 'background', group: 'structure', label: 'Background', desc: 'App backdrop' },
  { key: 'panel',      group: 'structure', label: 'Panel',      desc: 'Cards and panels' },
  { key: 'text',       group: 'structure', label: 'Text',       desc: 'Primary text' },
  { key: 'border',     group: 'structure', label: 'Border',     desc: 'Dividers and outlines' },
];

const SWATCH_GROUPS = [
  { id: 'status',    title: 'STATUS',    hint: 'these carry meaning' },
  { id: 'data',      title: 'DATA',      hint: 'charts and value categories' },
  { id: 'structure', title: 'STRUCTURE', hint: 'surfaces and text' },
];

let _allThemes     = [];
let _currentTheme  = null;   // theme payload from theme-get
let _editSwatches  = null;   // { key: hexColor } — live edits
let _editMode      = false;

function getSwatchColor(themeData, slotKey) {
  return themeData?.swatches?.[slotKey] || '#888888';
}

function editorSwatches() {
  const base = {};
  SWATCH_SLOTS.forEach(({ key }) => { base[key] = getSwatchColor(_currentTheme, key); });
  return { ...base, ...(_editSwatches || {}) };
}

// Returns true if a hex color is perceived as light (use dark overlay text)
function isLightColor(hex) {
  if (!hex?.startsWith('#')) return false;
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 145;
}

function renderSwatches(editable) {
  const grid = document.getElementById('paletteSwatchGrid');
  if (!grid) return;
  grid.innerHTML = '';
  grid.style.cssText = 'display:flex; flex-direction:column; gap:16px;';

  function makePill(slot, isStructural) {
    const { key, label, desc } = slot;
    const color   = _editSwatches?.[key] || getSwatchColor(_currentTheme, key);
    const isHex   = typeof color === 'string' && color.startsWith('#');
    const textCol = isHex && isLightColor(color) ? 'rgba(0,0,0,0.50)' : 'rgba(255,255,255,0.65)';
    const height  = isStructural ? '52px' : '72px';
    const radius  = '14px';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; align-items:stretch; gap:5px;';

    const pill = document.createElement('label');
    pill.title = editable ? `Edit ${label}` : label;
    pill.style.cssText = `
      position:relative; display:flex; align-items:flex-end;
      height:${height}; border-radius:${radius};
      background:${color};
      border:1.5px solid rgba(128,128,128,${editable ? '0.30' : '0.12'});
      box-shadow: 0 2px 8px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.14);
      cursor:${editable ? 'pointer' : 'default'};
      overflow:hidden; padding:0 9px 7px;
      transition: transform .12s, box-shadow .12s, border-color .12s;
    `;

    // Hex value inside pill
    if (isHex) {
      const hexEl = document.createElement('span');
      hexEl.dataset.hexEl = key;
      hexEl.textContent = color.toUpperCase();
      hexEl.style.cssText = `font-size:9px; font-family:var(--mono); letter-spacing:.05em; color:${textCol}; pointer-events:none; line-height:1;`;
      pill.appendChild(hexEl);
    }

    if (editable) {
      const inp = document.createElement('input');
      inp.type  = 'color';
      inp.value = isHex ? color : '#888888';
      inp.style.cssText = 'opacity:0; position:absolute; width:0; height:0; pointer-events:none;';

      inp.addEventListener('input', e => {
        const hex = e.target.value;
        pill.style.background = hex;
        const tc = isLightColor(hex) ? 'rgba(0,0,0,0.50)' : 'rgba(255,255,255,0.65)';
        const hexEl = pill.querySelector(`[data-hex-el="${key}"]`);
        if (hexEl) { hexEl.textContent = hex.toUpperCase(); hexEl.style.color = tc; }
        if (!_editSwatches) _editSwatches = {};
        _editSwatches[key] = hex;
        previewTheme(editorSwatches(), _currentTheme?.roles);
      });

      pill.appendChild(inp);
      pill.addEventListener('click', () => inp.click());
      pill.addEventListener('mouseenter', () => {
        pill.style.transform    = 'translateY(-2px)';
        pill.style.boxShadow    = '0 6px 16px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.14)';
        pill.style.borderColor  = 'var(--accent)';
      });
      pill.addEventListener('mouseleave', () => {
        pill.style.transform    = '';
        pill.style.boxShadow    = '0 2px 8px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.14)';
        pill.style.borderColor  = 'rgba(128,128,128,0.30)';
      });
    }

    const lbl = document.createElement('div');
    lbl.textContent = label;
    lbl.style.cssText = 'font-size:10px; color:var(--text-2); font-family:var(--mono); letter-spacing:.06em; text-align:center; padding-top:1px;';

    wrap.appendChild(pill);
    wrap.appendChild(lbl);

    // What this colour actually drives. The name says which job it does; this
    // says where you will see it change, which is the part that lets somebody
    // edit with intent instead of guessing and checking.
    if (desc) {
      const sub = document.createElement('div');
      sub.textContent = desc;
      sub.style.cssText = 'font-size:9px; color:var(--text-4); text-align:center; line-height:1.25;';
      pill.title = editable ? `Edit ${label} — ${desc}` : `${label} — ${desc}`;
      wrap.appendChild(sub);
    }
    return wrap;
  }

  // One heading per group, so the risk of editing each is visible before you do.
  function makeHeading(g) {
    const sep = document.createElement('div');
    sep.style.cssText = 'display:flex; align-items:center; gap:10px;';
    sep.innerHTML = `
      <div style="font-size:9px; letter-spacing:.12em; color:var(--text-4); font-family:var(--mono); flex-shrink:0;">${g.title}</div>
      <div style="font-size:9px; color:var(--text-4); opacity:.75; flex-shrink:0;">${g.hint}</div>
      <div style="flex:1; border-top:1px solid var(--border-e);"></div>
    `;
    return sep;
  }

  for (const g of SWATCH_GROUPS) {
    const slots = SWATCH_SLOTS.filter(s => s.group === g.id);
    if (!slots.length) continue;
    grid.appendChild(makeHeading(g));
    const row = document.createElement('div');
    // A shared minimum so pills line up across groups of different sizes.
    row.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fit,minmax(92px,1fr)); gap:8px;';
    slots.forEach(s => row.appendChild(makePill(s, g.id === 'structure')));
    grid.appendChild(row);
  }
}

function setEditMode(active) {
  _editMode = active;
  _editSwatches = active ? {} : null;
  renderSwatches(active);

  const saveRow   = document.getElementById('paletteSaveRow');
  const delBtn    = document.getElementById('paletteDeleteBtn');
  const editBtn   = document.getElementById('paletteEditBtn');
  const cancelBtn = document.getElementById('paletteCancelBtn');

  if (saveRow)   saveRow.style.display   = active ? 'flex' : 'none';
  if (editBtn)   editBtn.style.display   = active ? 'none' : 'inline-block';
  if (cancelBtn) cancelBtn.style.display = active ? 'inline-block' : 'none';

  if (delBtn) {
    const isUser = _currentTheme?.id?.startsWith('user:');
    delBtn.style.display = isUser && active ? 'inline-block' : 'none';
  }

  if (active) {
    const nameInp = document.getElementById('paletteNameInput');
    if (nameInp) nameInp.value = `Copy of ${_currentTheme?.name || 'Theme'}`;
  }
}

async function populatePaletteSettings() {
  const select = document.getElementById('themeSelect');
  if (!select) return;

  try {
    _allThemes = await window.eveAPI.themeGetAll();
    const activeId = await window.eveAPI.themeGetActive();

    select.innerHTML = '';
    for (const t of _allThemes) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.source === 'user' ? `${t.name} (custom)` : t.name;
      if (t.id === activeId) opt.selected = true;
      select.appendChild(opt);
    }

    await loadTheme(select.value);
  } catch (e) {
    console.warn('[palette] populatePaletteSettings failed:', e.message);
  }
}

async function loadTheme(id) {
  try {
    _currentTheme = await window.eveAPI.themeGet(id);
    setEditMode(false);
    renderSwatches(false);

    const desc = document.getElementById('themeDescription');
    if (desc) desc.textContent = _currentTheme?.description || '';
  } catch (e) {
    console.warn('[palette] loadTheme failed:', e.message);
  }
}

function bindPaletteEvents() {
  // Theme dropdown change
  const select = document.getElementById('themeSelect');
  if (select) {
    select.addEventListener('change', () => loadTheme(select.value));
  }

  // Panel opacity lives in Wallpaper and Colour (ui.js) — one control, one setting.

  // Apply theme
  document.getElementById('themeApplyBtn')?.addEventListener('click', async () => {
    const id = document.getElementById('themeSelect')?.value;
    if (!id) return;
    await window.eveAPI.themeSetActive(id);
    const theme = await window.eveAPI.themeGet(id);
    if (theme) {
      applyTheme(theme);
      showToast(`Theme "${theme.name || id}" applied.`, 'success');
    }
  });

  // Enter edit mode (create custom copy)
  document.getElementById('paletteEditBtn')?.addEventListener('click', () => setEditMode(true));

  // Cancel edits — drop the preview overrides, back to the applied theme
  document.getElementById('paletteCancelBtn')?.addEventListener('click', () => {
    removeThemePreview();
    applyUiTransparency();
    setEditMode(false);
  });

  // Save custom palette
  document.getElementById('paletteSaveBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('paletteNameInput')?.value?.trim();
    if (!name) { showToast('Enter a palette name.', 'error'); return; }

    const result = await window.eveAPI.themeSaveCustom({
      name,
      roles:    _currentTheme?.roles || { accent: 'red', danger: 'red', success: 'green', warning: 'orange' },
      swatches: editorSwatches(),
    });

    if (result.success) {
      await populatePaletteSettings();
      // Select and apply the new theme
      const sel = document.getElementById('themeSelect');
      if (sel) sel.value = result.id;
      await window.eveAPI.themeSetActive(result.id);
      const theme = await window.eveAPI.themeGet(result.id);
      if (theme) applyTheme(theme);
      showToast(`Palette "${name}" saved.`, 'success');
      setEditMode(false);
    } else {
      showToast(`Save failed: ${result.error}`, 'error');
    }
  });

  // Delete custom palette
  document.getElementById('paletteDeleteBtn')?.addEventListener('click', async () => {
    const id = _currentTheme?.id;
    if (!id?.startsWith('user:')) return;
    if (!confirm(`Delete the palette "${_currentTheme?.name}"?`)) return;
    const result = await window.eveAPI.themeDeleteCustom(id);
    if (result.success) {
      await populatePaletteSettings();
      // Reload the built-in default
      const theme = await window.eveAPI.themeGet('Default');
      if (theme) applyTheme(theme);
      showToast('Palette deleted.', 'success');
    } else {
      showToast(`Delete failed: ${result.error}`, 'error');
    }
  });
}

// Expose for startup init
window.initTheme  = initTheme;
window.applyTheme = applyTheme;
