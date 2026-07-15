// theme-vars.js — shared colour math + CSS-variable derivation for themes.
// Loaded by BOTH processes:
//   • main (theme_ipc.js) — require()d to generate user-theme .css files and
//     migrate legacy YAML themes
//   • renderer (palette.js) — <script> tag; attaches window.ThemeVars, used for
//     the live palette-editor preview
// Themes themselves are plain CSS files (src/styles/theme-*.css for built-ins,
// userData/themes/*.css for user themes). This module is only the generator.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThemeVars = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ── Colour helpers ──────────────────────────────────────────────────────────

  function hexToRgba(hex, alpha) {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function hexToHsl(hex) {
    if (!hex?.startsWith('#')) return [0, 0, 50];
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [h * 360, s * 100, l * 100];
  }

  function hslToHex(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return '#' + [h + 1/3, h, h - 1/3].map(t => {
      const v = Math.round(hue2rgb(p, q, t) * 255);
      return v.toString(16).padStart(2, '0');
    }).join('');
  }

  function darken(hex, frac) {
    const [h, s, l] = hexToHsl(hex);
    return hslToHex(h, s, Math.max(0, l - frac * 100));
  }

  function lighten(hex, frac) {
    const [h, s, l] = hexToHsl(hex);
    return hslToHex(h, s, Math.min(100, l + frac * 100));
  }

  // ── Full palette (Carbon/Sirius-style slots) → CSS variable map ────────────

  function buildCssVars(palette, roles) {
    const p = palette;
    const a = p[roles?.accent || 'red'];   // the accent slot for this theme

    return {
      // Teal / danger alpha helpers (character sync button states)
      '--teal-success-bg':     hexToRgba(p.teal?.base, 0.18),
      '--teal-success-border': hexToRgba(p.teal?.base, 0.30),
      '--danger-bg':           hexToRgba(p.red?.bright, 0.14),
      '--danger-border':       hexToRgba(p.red?.bright, 0.25),

      // Primary accent (driven by roles.accent)
      '--accent':          a?.base,
      '--accent-dim':      a?.dim,
      '--accent-glow':     a?.glow       || hexToRgba(a?.base, 0.18),
      '--accent-03':       hexToRgba(a?.base, 0.03),
      '--accent-04':       hexToRgba(a?.base, 0.04),
      '--accent-05':       hexToRgba(a?.base, 0.05),
      '--accent-06':       hexToRgba(a?.base, 0.06),
      '--accent-08':       a?.subtle     || hexToRgba(a?.base, 0.08),
      '--accent-10':       hexToRgba(a?.base, 0.10),
      '--accent-12':       hexToRgba(a?.base, 0.12),
      '--accent-15':       hexToRgba(a?.base, 0.15),
      '--accent-20':       hexToRgba(a?.base, 0.20),
      '--accent-25':       a?.border     || hexToRgba(a?.base, 0.25),
      '--accent-30':       hexToRgba(a?.base, 0.30),
      '--accent-40':       hexToRgba(a?.base, 0.40),
      '--accent-50':       hexToRgba(a?.base, 0.50),
      '--glow-color':      hexToRgba(a?.base, 0.22),
      '--glow-color-2':    a?.base,

      // Semantic status
      '--success':         p.green?.base,
      '--danger':          p.red?.bright,
      '--warning':         p.orange?.warning || p.orange?.base,
      '--status-online':   p.green?.bright,
      '--status-offline':  p.red?.bright,

      // Named EVE colours
      '--teal':            p.teal?.base,
      '--teal-glow':       p.teal?.glow,
      '--liquidisk':       p.teal?.base,
      '--assets':          p.purple?.bright,
      '--newbie':          p.teal?.base,
      '--hisec':           p.blue?.hisec    || p.blue?.base,
      '--lowsec':          p.yellow?.lowsec || p.yellow?.base,
      '--nullsec':         p.red?.base,
      '--lawless':         p.indigo?.dim    || p.purple?.dim,

      // Popup-window slot colours (ping-alert buttons/badges)
      '--teal-bg':         hexToRgba(p.teal?.base, 0.12),
      '--teal-border':     hexToRgba(p.teal?.base, 0.35),
      '--teal-text':       p.teal?.bright   || p.teal?.base,
      '--indigo-bg':       hexToRgba(p.indigo?.base, 0.12),
      '--indigo-border':   hexToRgba(p.indigo?.base, 0.32),
      '--indigo-text':     p.indigo?.bright || p.indigo?.base,
      '--green-bg':        hexToRgba(p.green?.base, 0.12),
      '--green-border':    hexToRgba(p.green?.base, 0.35),
      '--green-text':      p.green?.bright  || p.green?.base,

      // Tier rank labels
      '--tier-top':        p.blue?.base,
      '--tier-2':          p.indigo?.base,
      '--tier-1':          p.orange?.base,
      '--tier-0':          p.teal?.base,

      // ESI badge
      '--esi-green':       p.green?.glow,
      '--esi-green-dim':   p.green?.subtle,

      // Nav active bg
      '--nav-active-bg':   p.blue?.nav_active,

      // Backgrounds
      '--bg':              p.surface?.body,
      '--bg-body':         p.surface?.body,
      '--bg-deep':         p.surface?.deep,
      '--bg-panel':        p.surface?.panel,
      '--bg-card':         p.surface?.card,
      '--bg-card-deep':    p.surface?.card_deep,
      '--bg-input':        p.surface?.input,
      '--bg-modal':        p.surface?.modal,
      '--bg-hover':        p.surface?.hover,
      '--bg-hover-subtle': p.surface?.hover_subtle,
      '--bg-code':         p.surface?.code,
      '--toast-bg':        p.surface?.toast,
      '--bg-surface':      p.surface?.card,
      '--bg-banner-end':   p.surface?.banner_end,
      '--backdrop':        p.overlay?.backdrop,

      // Text
      '--text-1':          p.text?.primary,
      '--text-2':          p.text?.secondary,
      '--text-3':          p.text?.tertiary,
      '--text-4':          p.text?.header,
      '--text-5':          p.text?.muted,
      '--text-6':          p.text?.dim,
      '--text-7':          p.text?.faint,
      '--text-8':          p.text?.console,
      '--text-9':          p.text?.console,
      '--text-input':      p.text?.input,
      '--text-on-accent':  p.text?.on_accent,
      '--text-name':       p.text?.name,

      // Borders / lines
      '--border':          p.line?.default,
      '--border-b':        p.line?.panel,
      '--border-c':        p.line?.panel,
      '--border-d':        p.line?.outer,
      '--border-e':        p.line?.divider,

      // Shadows
      '--shadow-dark':     p.overlay?.shadow,
      '--shadow-darker':   p.overlay?.shadow_deep,
      '--shadow-black-12': 'rgba(0,0,0,0.12)',
      '--spinner-track':   hexToRgba(a?.base, 0.08),

      // Hatch
      '--hatch-color':     p.overlay?.hatch,
      '--hatch-card-color':p.overlay?.hatch_card,
      '--dot-color':       p.overlay?.dot,

      // Body / concord glows
      '--glow-body-a1':    p.overlay?.glow_a1,
      '--glow-body-a2':    p.overlay?.glow_a2,
      '--glow-body-a3':    p.overlay?.glow_a3,
      '--glow-body-b1':    p.overlay?.glow_b1,
      '--glow-body-b2':    p.overlay?.glow_b2,
      '--glow-main-1':     p.overlay?.concord_1,
      '--glow-main-2':     p.overlay?.concord_2,
      '--glow-main-3':     p.overlay?.concord_3,
      '--glow-sec-1':      p.overlay?.concord_4,
      '--glow-sec-2':      p.overlay?.concord_5,
    };
  }

  // ── Simplified user theme (16 swatches) → CSS variable map ─────────────────

  function buildCssVarsFromCustom(sw, roles) {
    const accent = sw[roles?.accent || 'red'] || sw.red;

    // Derive a minimal full-palette structure from the 16 swatches
    const derived = {
      red:       { base: sw.red,       bright: lighten(sw.red, 0.10),      dim: darken(sw.red, 0.25),      glow: hexToRgba(sw.red, 0.22),       border: hexToRgba(sw.red, 0.25), subtle: hexToRgba(sw.red, 0.08) },
      teal:      { base: sw.teal,      bright: lighten(sw.teal, 0.10),     dim: darken(sw.teal, 0.20),     glow: hexToRgba(sw.teal, 0.30) },
      purple:    { base: sw.purple,    bright: lighten(sw.purple, 0.08),   dim: darken(sw.purple, 0.20) },
      pink:      { base: sw.pink,      bright: lighten(sw.pink, 0.10),     dim: darken(sw.pink, 0.20) },
      baby_blue: { base: sw.baby_blue, bright: lighten(sw.baby_blue, 0.10),dim: darken(sw.baby_blue, 0.15)},
      green:     { base: sw.green,     bright: lighten(sw.green, 0.08),    dim: darken(sw.green, 0.20),    glow: hexToRgba(sw.green, 0.25),   subtle: hexToRgba(sw.green, 0.10) },
      yellow:    { base: sw.yellow,    bright: lighten(sw.yellow, 0.08),   dim: darken(sw.yellow, 0.20),   lowsec: sw.yellow },
      orange:    { base: sw.orange,    bright: lighten(sw.orange, 0.08),   dim: darken(sw.orange, 0.20),   warning: sw.orange },
      gold:      { base: sw.gold,      bright: lighten(sw.gold, 0.08),     dim: darken(sw.gold, 0.20) },
      indigo:    { base: sw.indigo,    bright: lighten(sw.indigo, 0.08),   dim: darken(sw.indigo, 0.25) },
      cyan:      { base: sw.cyan,      bright: lighten(sw.cyan, 0.08),     dim: darken(sw.cyan, 0.20) },
      blue:      { base: sw.blue,      bright: lighten(sw.blue, 0.08),     dim: darken(sw.blue, 0.20),     nav_active: hexToRgba(sw.blue, 0.12), hisec: sw.blue, glow: hexToRgba(sw.blue, 0.22), subtle: hexToRgba(sw.blue, 0.08), border: hexToRgba(sw.blue, 0.25) },
      surface:   {
        body: sw.background, deep: hexToRgba(sw.background, 0.95),
        panel: sw.panel,     card: lighten(sw.panel, 0.03),
        card_deep: darken(sw.panel, 0.03),
        input: sw.panel,     modal: sw.panel,
        toast: sw.panel,     code: darken(sw.background, 0.02),
        hover: hexToRgba(accent, 0.07),
        hover_subtle: hexToRgba(accent, 0.03),
        banner_end: sw.panel,
      },
      text: {
        primary: sw.text,   secondary: lighten(sw.text, 0.05),
        tertiary: lighten(sw.text, 0.20), header: lighten(sw.text, 0.30),
        muted: lighten(sw.text, 0.35),    dim: lighten(sw.text, 0.45),
        faint: lighten(sw.text, 0.55),    console: lighten(sw.text, 0.40),
        input: sw.text,     on_accent: '#ffffff',  name: sw.text,
      },
      line: {
        default: sw.border,
        panel: hexToRgba(accent, 0.30),
        outer: hexToRgba(accent, 0.15),
        divider: lighten(sw.background, 0.10),
        subtle: 'rgba(128,128,128,0.04)',
      },
      overlay: {
        backdrop: 'rgba(0,0,0,0.70)',
        shadow: 'rgba(0,0,0,0.25)',
        shadow_deep: 'rgba(0,0,0,0.60)',
        hatch: 'rgba(255,255,255,0.018)',
        hatch_card: 'rgba(255,255,255,0.010)',
        glow_a1: hexToRgba(accent, 0.30),
        glow_a2: hexToRgba(sw.red, 0.20),
        glow_a3: hexToRgba(sw.red, 0.05),
        glow_b1: hexToRgba(sw.teal, 0.08),
        glow_b2: hexToRgba(accent, 0.10),
        concord_1: hexToRgba(accent, 0.35),
        concord_2: hexToRgba(darken(accent, 0.10), 0.25),
        concord_3: hexToRgba(accent, 0.05),
        concord_4: hexToRgba(accent, 0.06),
        concord_5: hexToRgba(accent, 0.15),
      },
    };

    return buildCssVars(derived, roles);
  }

  // ── Serialisation ───────────────────────────────────────────────────────────

  function varsToCss(vars) {
    return Object.entries(vars)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n');
  }

  // Full .css theme-file text. meta: { id, name, description, author, roles,
  // swatches, vars }. If vars is omitted it is derived from the 16 swatches.
  function buildThemeCssFileText(meta) {
    const vars = meta.vars || buildCssVarsFromCustom(meta.swatches, meta.roles);
    const head = [
      '/* ═══════════════════════════════════════════════════════════════════════',
      `   EVE Carbon theme — ${meta.name}`,
      '   Generated theme file: one CSS custom property per colour token.',
      '   The @-metadata comments below are parsed by theme_ipc.js — keep them.',
      '   ═══════════════════════════════════════════════════════════════════════ */',
      `/* @id: ${meta.id || meta.name} */`,
      `/* @name: ${meta.name} */`,
      `/* @description: ${(meta.description || '').replace(/\*\//g, '')} */`,
      `/* @author: ${meta.author || ''} */`,
      `/* @roles: ${JSON.stringify(meta.roles || {})} */`,
      `/* @swatches: ${JSON.stringify(meta.swatches || {})} */`,
    ].join('\n');
    return `${head}\n\n:root {\n${varsToCss(vars)}\n}\n`;
  }

  // Parse the @-metadata header out of a theme .css file's text.
  function parseThemeCssMeta(text) {
    const meta = {};
    const re = /\/\*\s*@(\w+):\s*([\s\S]*?)\s*\*\//g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const key = m[1], raw = m[2];
      if (key === 'roles' || key === 'swatches') {
        try { meta[key] = JSON.parse(raw); } catch { /* malformed — skip */ }
      } else {
        meta[key] = raw;
      }
    }
    return meta;
  }

  return {
    hexToRgba, hexToHsl, hslToHex, darken, lighten,
    buildCssVars, buildCssVarsFromCustom,
    varsToCss, buildThemeCssFileText, parseThemeCssMeta,
  };
});
