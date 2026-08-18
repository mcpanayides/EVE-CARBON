---
name: EVE Carbon
description: A tactical glass terminal for EVE Online — instrument-grade data on cool cinematic space.
colors:
  crimson-signal: "#e0483a"
  crimson-deep: "#7d201a"
  space-black: "#070a12"
  surface-glass: "rgba(12, 16, 24, 0.85)"
  panel-glass: "rgba(14, 18, 28, 0.85)"
  hairline-cool: "rgba(255, 255, 255, 0.09)"
  hairline-faint: "rgba(255, 255, 255, 0.06)"
  text-primary: "#ccd1da"
  text-muted: "#909090"
  text-faint: "#565b63"
  portrait-teal: "#00c4b4"
  data-red: "#e0564b"
  data-green: "#4ada8a"
  data-teal: "#4ecbb0"
  data-gold: "#e3b341"
  data-purple: "#ab7ab8"
  data-blue: "#4a9fd4"
  data-pink: "#e47baf"
  data-orange: "#f58c42"
  me-green: "#4ada8a"
  te-cyan: "#00e5ff"
typography:
  stat:
    fontFamily: "'Fira Code', monospace"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "normal"
  title:
    fontFamily: "'Fira Code', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.15em"
  body:
    fontFamily: "'Fira Sans', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "'Fira Code', monospace"
    fontSize: "9px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.15em"
  console:
    fontFamily: "'Fira Code', monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "0.05em"
  caption:
    fontFamily: "'Fira Code', monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
  small:
    fontFamily: "'Fira Sans', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  icon:
    fontFamily: "'Material Symbols Outlined'"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "normal"
rounded:
  hair: "3px"
  chip: "4px"
  inset: "6px"
  sharp: "2px"
  soft: "8px"
  glass: "10px"
  panel: "14px"
  modal: "18px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.crimson-signal}"
    typography: "{typography.body}"
    rounded: "{rounded.sharp}"
    padding: "10px"
  button-primary-hover:
    backgroundColor: "{colors.crimson-signal}"
    textColor: "{colors.space-black}"
  nav-item:
    backgroundColor: "{colors.surface-glass}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sharp}"
    padding: "8px 10px"
  nav-item-active:
    backgroundColor: "rgba(74, 140, 220, 0.13)"
    textColor: "{colors.crimson-signal}"
  card:
    backgroundColor: "{colors.surface-glass}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sharp}"
    padding: "10px 12px"
  input:
    backgroundColor: "rgba(10, 13, 20, 0.85)"
    textColor: "#c6cbd3"
    typography: "{typography.body}"
    rounded: "{rounded.sharp}"
    padding: "6px 10px"
  badge-count:
    backgroundColor: "{colors.crimson-deep}"
    textColor: "{colors.crimson-signal}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 6px"
---

# Design System: EVE Carbon

## Overview

**Creative North Star: "The Tactical Glass Terminal"**

EVE Carbon is a dense, utility-forward data overlay whose primary material is translucent frosted glass floating over the operating system. It merges the physical, refractive identity of acrylic glass with an all-business tactical layout: a user-chosen wallpaper and the blurred desktop read faintly through the panes from behind, contrasting with sharp 2px edges, hatch textures, and scanline-thin scrollbars on the surface. The chrome is deliberately near-invisible so that the information-heavy data and the textured glass remain the sole focus.

The system lives in a permanent tension between two registers, and future work must hold both. The **backdrop is cinematic**: cool deep-space black (#070a12), a user wallpaper behind the frame (default "Citadel Overlook", shipped un-dimmed), a whisper-fine diagonal hatch across every surface, and translucent acrylic glass that refracts the desktop behind the window. The **foreground is instrument-grade**: monospace figures, uppercase micro-labels on tight tracking, right-aligned numeric columns, and crisp white-alpha hairlines. Atmosphere sets the mood; precision carries the meaning. Neither is allowed to win — a stat value never blurs into ambience, and the ambience is never flattened into a spreadsheet.

The atmosphere comes from the wallpaper and the blur, not from painted light. A pair of huge animated nebula gradients used to sit behind the whole frame; they were removed in August 2026 once the glass blur and wallpaper had made them invisible, and they were costing 130–210% CPU in the GPU process for something nobody could see. They survive only in the small, transient ping-alert popup, where the cost does not apply.

This is EVE Carbon's own identity, not a reskin of the in-game client. It respects EVE's world — a crimson signal, capsuleer-console density, faction-inspired data hues — but commits to a distinct, fully themeable brand. A single built-in theme ships: **Default** — cool deep-space surfaces, crisp edges, a refined crimson signal. There are no other named presets; users recolor by editing the 13-swatch palette (Settings → Colour Palette), and every color, chart series, and status hue routes through tokens so a custom palette repaints the whole terminal at once.

**Key Characteristics:**
- Translucent acrylic glass as the defining material and the resting default, over a cool deep-space backdrop.
- Instrument-grade data foreground: monospace values, uppercase tracked labels, crisp white-alpha hairline structure.
- Sharp 2px geometry that rounds into glass as the default surface treatment; a clear focus/blur depth hierarchy for overlays.
- A single restrained crimson signal riding on top of an eight-hue data palette that carries all quantitative meaning.
- Total themeability by derivation — a ~120-token map computed from just 13 user swatches, with the accent bound by role, not hardcoded (one Default theme + user palettes).

## Colors

The palette is a cool deep-space stage lit by a single crimson signal, with meaning carried by a disciplined eight-hue data set. Nothing decorative competes with the data.

### Primary
- **Crimson Signal** (#e0483a): The sole brand signal — a refined, slightly luminous crimson. Icons, active nav state, focus rings, panel accents, links, the single count badge. It marks *the* important state or action on a surface — never a field of buttons.
- **Crimson Deep** (#7d201a): The dim companion — filled backgrounds behind the accent, count-badge and add-button fills where crimson needs a body rather than a stroke.

### Neutral
- **Space Black** (#070a12): The `<body>` base — a cool, faintly blue deep-space stage everything floats over. Deliberately cooler than a pure neutral black so the glass reads as space, not soot.
- **Surface / Panel Glass** (rgba(12,16,24,0.85) / rgba(14,18,28,0.85)): The translucent working surfaces — cards, panels, sidebar. The 0.85 alpha is intentional: even off-glass they let the backdrop and wallpaper read faintly through; with glass on (the default) they remap to the live tint.
- **Cool Hairline** (rgba(255,255,255,0.09) → rgba(255,255,255,0.06)): Borders are crisp cool white-alpha, not tinted — dividers, panel headers, card edges. Clean and neutral so the crimson signal stays the only chromatic edge.
- **Text ramp** (#ccd1da primary → #909090 muted → #565b63 faint): A cool gray ramp from primary body text down to console timestamps. Labels sit muted; values sit bright.
- **Portrait Teal** (#00c4b4): Reserved identity color for the active character — portrait ring and active-pilot name. The one place teal means "you."

### Data Palette (the working hues)
Eight consolidated hues drive every chart series, KPI value, badge, ticker and status color. **Nothing outside `palette.css` and `theme-default.css` may hardcode these hues — always reference the token.**
- **Data Red** (#e0564b): losses, danger, total-net-worth figure, `status-offline`.
- **Data Green** (#4ada8a): gains, success, running/online states.
- **Data Teal** (#4ecbb0): liquid ISK, near-complete progress.
- **Data Gold** (#e3b341): warnings, holding states, storage-full.
- **Data Purple** (#ab7ab8): asset values.
- **Data Blue** (#4a9fd4): info, high-sec accents.
- **Data Pink** (#e47baf): chart series, secondary badges.
- **Data Orange** (#f58c42): chart series, secondary warnings.

Chart series resolve in a fixed order (red, teal, purple, gold, green, blue, pink, orange) read from CSS via `getComputedStyle`, so re-theming the tokens re-colors every canvas chart.

### Game-Derived Colors
A small set of hues are not ours to invent: they mirror what EVE itself uses, so a value reads the same here as it does in the client. These are declared as semantic tokens in `theme-default.css` and re-pointed at palette swatches by `theme-vars.js`, which is what keeps them game-accurate out of the box *and* customizable.
- **Security status** (`--hisec` #3d85c8, `--lowsec` #d4a017, `--nullsec` #e0483a, `--lawless` #6a3a7a, `--newbie` #4ec9b0): bound to the blue / yellow / red / indigo / teal swatches.
- **Industry efficiency** (`--me` #4ada8a, `--te` #00e5ff): EVE's own material- and time-efficiency colors, used by the ME/TE bars and pills on blueprint cards. Bound to the green and teal swatches.

Derived shades of these — a gradient's dark end, a pill's 13% wash — are mixed from the token with `color-mix()` rather than typed, so re-pointing a token re-shades everything that depends on it instead of leaving a stale hue behind.

### Theming & The Custom Accent
The accent is **not a fixed hex — it is a role binding over a 13-swatch palette.** Settings → Colour Palette lets the user edit thirteen swatches: nine EVE hues (red, green, gold, yellow, blue, teal, purple, pink, orange) plus four structural colors (background, panel, text, border). A `roles` map (`{accent, danger, success, warning, info}`) then points each semantic role at one of those swatch slots. The Default theme binds `accent → red` (crimson). Change the swatch or re-point the role and the highlight color changes everywhere at once.

`baby_blue`, `indigo` and `cyan` were deliberately removed from the editor (see `SWATCH_SLOTS` in `src/func/palette.js`): they were offered and written into every saved theme, but nothing ever read them, so picking a colour changed nothing. **Do not reinstate them to give a hardcoded hue somewhere a token to point at** — a control that does nothing costs the user a decision and then ignores it. `theme-vars.js` still derives those three internally for backwards-compatible theme files; that is not a reason to expose them.

There is **one built-in theme** — `theme-default.css` (`@name: Default`) — the single canonical token source. Its file-header comment still subtitles it "Nebula Glass", a leftover from the removed background gradients; the theme's actual name is Default. From the thirteen swatches, `theme-vars.js` **derives the entire ~120-token variable map**: the full accent alpha ladder (`--accent-03` … `--accent-50`) via `hexToRgba`, and each hue's bright/dim/glow variants via HSL `lighten`/`darken`. Hand-authoring stops at thirteen colors — everything downstream is computed, which is why a user palette repaints charts, KPIs, badges, borders, glows, and focus rings coherently. User palettes are saved as generated plain-CSS files in `userData/themes/*.css` (with `@roles` / `@swatches` metadata in header comments); applying one swaps the `#themeStylesheet` link, and the live editor previews edits by injecting an inline `<style>` of the derived vars. Separately, a **Glass tint** control (Settings → Background) sets the translucent surface tint and follows the OS accent color by default — it colors the glass, not the data.

### Named Rules
**The Accent-Is-A-Role Rule.** Never hardcode the highlight color. The accent is `roles.accent` resolved against the active palette and expressed only through the `--accent*` tokens. A literal crimson hex in a component breaks every user palette instantly.

**The Derive-Don't-Author Rule.** Any new accent tint, hue variant, or state color is generated from a swatch via the `theme-vars.js` helpers (`hexToRgba` / `lighten` / `darken`), not typed as a fresh literal. Thirteen swatches are the only hand-set colors; the rest is math so themes stay coherent.

**The One Signal Rule.** The accent — whatever hue the active theme binds it to — is a guideline of restraint, not a hard cap: it should mark the single most important state or action in view. When two things both want the accent, one of them is wrong — promote it with the data palette or hierarchy instead, and let the accent stay rare enough to still mean something.

**The Token-Or-Nothing Rule.** No chart, KPI, badge, or status may hardcode one of the eight data hues. Reference `--pal-*` / `--chart-*` so themes (and the user's own swatches) repaint the whole app. A raw hex in a component is a bug.

**The Color-Is-Not-The-Only-Signal Rule.** In dense data views, color reinforces meaning but never carries it alone — pair every hue with a label, icon, sign, or position so the terminal survives any user theme and any contrast need.

## Typography

**UI / Body Font:** Fira Sans (with system sans fallback)
**Data / Mono Font:** Fira Code (with monospace fallback)
**Icon Fonts:** Material Symbols Outlined (18px app-utility glyphs) + an inline EVE neocom SVG sprite (28px game-page glyphs)

**Character:** A two-voice pairing that mirrors the whole system's tension. Fira Sans handles prose, labels, and navigation — humane and quiet. Fira Code handles every *number, identifier, and status* — figures align in columns, ISK values tabulate cleanly, and the monospace grid reads as instrumentation. If it's a quantity, it's mono; if it's language, it's sans.

### Hierarchy
- **Stat** (Fira Code, 700, 20px): The headline figures — net worth, wallet balance, KPI values. Monospace so digits align and scan.
- **Title** (Fira Code, 400, 13px, letter-spacing 0.15em): Titlebar and section titles — tracked monospace that reads as a console header, not a heading.
- **Body** (Fira Sans, 400, 14px, line-height 1.5): Default UI text, descriptions, nav labels.
- **Label** (Fira Code, 700, 9–10px, letter-spacing 0.1–0.2em, uppercase): The micro-labels above every stat and panel — muted gray (`--label-muted` #909090), widely tracked, all-caps. The system's most recognizable typographic tic.
- **Console** (Fira Code, 10px): The footer log and status bar — timestamps faint, messages color-coded by severity (success/error/warning). Also the app's general micro-step: table cell text, dense badge copy, and secondary meta lines.
- **Caption** (Fira Code, 11px): The workhorse mono step between Console and Title — table values, filter-bar text, card meta rows, toolbar labels. The most-used size in the terminal.
- **Small** (Fira Sans, 12px): Secondary prose one step under Body — helper text, empty-state subtitles, descriptions inside dense panels.
- **Icon** (Material Symbols Outlined, 18px): App-utility glyphs. Game-page glyphs use the 28px inline EVE neocom SVG sprite instead, which is markup rather than a type role.

The ramp is deliberately tight: **9 · 10 · 11 · 12 · 13 · 14 · 20px**. Density is the point — three adjacent mono steps (10/11/12) do most of the work in tables and cards, and they are load-bearing, not drift. Sizes above Stat (22px+) exist only in a handful of hero figures and modal titles; treat anything new outside this ramp as a mistake unless it is added here first.

### Named Rules
**The Numbers-Are-Mono Rule.** Every quantity — ISK, LP, quantities, percentages, IDs, timers — is set in Fira Code. Language is Fira Sans. This split is not decorative; it is how the eye finds the data.

**The Muted-Label / Bright-Value Rule.** Labels are muted and tracked (`--label-muted`); the value they describe is bright (`--value-bright`, = primary text). Never invert this, and never inline-style either — always class + token.

## Layout

A fixed-height desktop shell, never a scrolling web page. The frame is a 32px draggable titlebar, a collapsible left sidebar (280px expanded → 64px icon-rail collapsed, width-animated), a flex main content area, and two persistent bottom strips: a 24px console/status bar (expands to 160px) and a 28px market ticker marquee.

Density is high and deliberate. Panels use tight internal padding (10–12px), cards stack on 8px gaps, tables run 4–6px cell padding with 10–12px labels. The spacing rhythm is a 4-step scale (4 / 8 / 12 / 16 / 20px); larger gaps are rare and reserved for empty states. Dashboard surfaces use a Gridstack widget grid; most pages are panel-and-card compositions inside a scrollable main region. Scrollbars are 4px and near-invisible until hovered.

Content reflows by the sidebar, not by breakpoint — collapsing the rail widens `main-content` (flex:1) automatically. This is a desktop instrument, tuned for a second monitor beside the running game; it is not responsive-web and does not target mobile.

## Elevation & Depth

**Glass is the resting default; depth reads as a focus hierarchy.** Translucent acrylic glass is the standard surface treatment app-wide (`glass.css`, applied by default at startup): a token remap turns every `--bg-*` surface into the live tint, and structural containers (titlebar, sidebar, panels, modals, toasts) get `backdrop-filter` blur, a 1px specular rim (`--glass-specular`), and a soft drop shadow. Inner cards inherit the blur of the panel they sit on, keeping GPU cost sane. Corners round to 10–18px. Depth is not scattered decoration — it encodes *what has focus right now*:

1. **The main content is the focus** at rest. Page panels sit as clean glass slabs on the deep-space backdrop; the sidebar and titlebar frame reads as one continuous glass surface.
2. **When an overlay opens, it takes focus and the world behind recedes into blurred glass.** Every modal, drawer, and settings surface (`.modal-backdrop`) blurs and gently dims what's behind it (`backdrop-filter: blur(...)` + a light scrim) while the overlay itself lifts on a heavy drop shadow, a crimson-tinted top border (`border-top: var(--accent-25)`), and an inset specular highlight — so the popup is unmistakably the subject and the terminal beneath is context, not clutter.

Behind everything sits the user's wallpaper and the blurred desktop — that is the entire ambient layer. There is no painted glow in the main frame: two large animated nebula gradients (`concord-glow-main` / `concord-glow-secondary`) used to pulse there and were removed once the glass blur and wallpaper had rendered them invisible. They remain in `ping-alert.css` for the small transient popup, which has no wallpaper of its own and is on screen for seconds.

A global **Glass tint** control (Settings → Background) sets the translucent surface tint. The shipped default is a fixed deep teal (`#2B7273`, darkened ×0.16 to the surface tint) with panel opacity 0.45, blur 1.45×, and desktop wash 0.15 — a cool teal-glass out of the box; users can switch it to any custom color or the OS accent. The default wallpaper is the "Citadel Overlook" plate (fetched lazily from CCP's resfile CDN, un-dimmed).

### Shadow Vocabulary
- **Panel lift** (`box-shadow: 0 8px 28px rgba(0,0,0,0.35), inset 0 1px 0 var(--glass-specular)`): structural page panels.
- **Modal lift** (`box-shadow: 0 24px 80px rgba(0,0,0,0.6), inset 0 1px 0 var(--glass-specular)`): dialogs and drawers — always the top of the focus stack.
- **Toast lift** (`box-shadow: 0 12px 36px rgba(0,0,0,0.45), inset 0 1px 0 var(--glass-specular)`): transient notifications.

### Named Rules
**The Focus-Stack Rule.** Depth encodes focus. The active surface is sharp and lifted; whatever it sits on top of is blurred and dimmed. When an overlay opens, blur and scrim the layer behind it — never leave two planes competing for attention at the same clarity.

**The Atmosphere-Is-Free Rule.** Ambience comes from the wallpaper and the glass blur — layers the compositor is already paying for — never from a full-frame painted gradient. A scaling or pulsing gradient re-rasterizes instead of taking the cheap texture path; the pair this app used to run cost 130–210% CPU in the GPU process, permanently, for something the blur had already hidden. If a future treatment needs its own light, it must be small, transient, and measured (the ping-alert popup is the one place that passes).

**The Nothing-Animates-Unwatched Rule.** This app's normal state is sitting behind the game, unfocused and occluded — and Chromium only throttles animation in a *hidden* window, not an unfocused one. Every decorative loop pauses on `body.app-unfocused` and releases its `will-change` promotion. Spinners and progress indicators are deliberately exempt: they carry meaning.

## Shapes

Softened glass geometry by default: with glass on (the resting state), the global `--radius` token resolves to 10px and structural containers round further (panels 14px, modals 18px), so the whole terminal reads as tinted glass panes. The underlying flat mode keeps a machined 2px radius — the sharp skeleton the glass rounds. Radius is driven by the *one* `--radius` token so the terminal softens in concert, never piecemeal. Two shapes break the rectilinear grid on purpose: **pills** (`999px`) for count badges, view toggles, and status chips; and **circles** for character portraits (teal-ringed), status lights, and presence dots.

Beneath the structural radii sits a **small-radius tier for interior parts** — `hair` (3px), `chip` (4px), `inset` (6px). Structural containers round with `--radius`; the pieces *inside* them (inline badges, swatches, progress fills, table-cell chips, mini-buttons) take one of these three so a 10px glass corner never repeats at 10px on a 16px badge. Interior radii are the one place a literal value is expected rather than the shared token — but only these three.

Texture is part of the form language: a whisper-fine −45°/45° diagonal hatch (`--hatch-color`, white at ~1.8% alpha) overlays select cards (KPI tiles, character/blueprint/PI cards) — the "brushed" surface of the terminal. With glass on (the default) the heavy body hatch drops and the acrylic blur over the wallpaper carries the texture instead.

A reeded-glass flute overlay — a full-window sheet of vertical ribs — was part of this language and is not any more. It was retired because the rib lines fought the dense UI instead of reading as glass, and its DOM node, rule and `--flute-*` tokens were deleted in August 2026. Do not reinstate it without a new design; the blur alone carries the material now.

## Components

For each component, the character line comes first, then shape, color, and states.

### Buttons
- **Character:** Sharp and restrained — ghost/outline by default; the accent is a stroke, not a fill, until you commit.
- **Shape:** 2px corners (`--radius`); some action toggles go pill (`999px`).
- **Primary (`.calc-btn`):** transparent background, 1px crimson border, crimson text, 0.08em tracking, full-width, 10px padding. Hover fills toward the accent.
- **Nav button:** deep-glass background, cool white-alpha hairline border, secondary-gray text, 8×10px padding. Hover → crimson border + crimson text + subtle hover wash. Active → blue-tinted `nav-active-bg` + crimson text. Icon sits in a fixed 28px slot so Material (18px) and EVE-neocom (28px) glyphs align on one baseline.
- **Add / icon buttons:** small square (20px), crimson-dim fill, crimson glyph; hover inverts to solid crimson with black glyph.

### Chips & Badges
- **Count badge:** crimson-dim fill, crimson mono text, pill radius, tiny (1×6px padding, 10px). Sits right-aligned in panel headers.
- **ESI badge:** green-tinted stroke + fill, uppercase mono — the "live data" marker.
- **Status chips / tier labels:** color from the data palette or tier ramp; always paired with a label.

### Type Icons

EVE type icons (ore, ice, gas, moon ore, blueprints, modules) sit **bare** in list rows — 20–28px, `border-radius: 3px`, no border and no background plate. The artwork is already a rendered object on its own ground; framing every one of them added a box per row that competed with the hairline table structure for the same visual weight. Large detail images (64px hero thumbs on blueprint and material pages) are the exception and keep their frame, because there the border reads as intentional matting rather than chrome.

### Cards & Panels
- **Corner:** 14px glass panels by default (2px sharp in flat fallback).
- **Background:** surface-glass / card-deep translucent tokens (remap to the live tint when glass is on).
- **Border:** cool white-alpha hairline (`--border-d/e`); selected cards get a crimson-25 border + faint crimson glow.
- **Depth:** structural panels carry backdrop blur, a specular rim, and the panel-lift shadow; inner cards inherit the panel's blur. Lift follows the focus stack, not decoration.
- **Padding:** 10–12px. Certain cards (KPI, character, blueprint, PI) carry the diagonal hatch overlay.

### Inputs / Fields
- **Style:** deep translucent fill, cool hairline border, 8px glass radius (2px flat), Fira Code text.
- **Focus:** border shifts to `--accent-40` and a 2px `--accent-08` focus ring appears — a quiet crimson glow, no outline.
- **Toggle switch:** 42×24px pill track; off = deep fill + gray knob, on = solid crimson track + white knob; focus-visible adds a crimson ring.

### Navigation
- **Style:** vertical rail of nav buttons; Dashboard is always the 2nd item. Icons are a deliberate hybrid — EVE neocom SVG sprite (28px) for game pages, Material Symbols (18px) for app-utility. No emoji anywhere in the chrome.
- **States:** default gray → hover crimson → active crimson on blue-tint. Collapsed mode drops labels and centers icons in a 64px rail.

### Signature: The Market Ticker
A persistent 28px bottom marquee — an EVE-authentic touch. A fixed mono "MARKET" label with a crimson glyph, then an infinitely scrolling track of item icon + name + price + signed percentage (green up / red down / gray flat). Pauses on hover, and pauses again whenever the window loses focus (per the Nothing-Animates-Unwatched Rule) — this app spends most of its life behind the game. It is the terminal's heartbeat: live data always in motion at the bottom of the frame.

## Do's and Don'ts

### Do:
- **Do** route every chart, KPI, badge, and status color through the `--pal-*` / `--chart-*` tokens so a user palette repaints the whole app.
- **Do** treat the accent as a role over a 13-swatch palette — bind it via `roles.accent` and consume it only through `--accent*`, so the Default theme and every user palette resolve correctly.
- **Do** set every quantity in Fira Code and every piece of language in Fira Sans.
- **Do** keep labels muted and tracked (`--label-muted`) with the value they describe bright (`--value-bright`) — via class + token, never inline style.
- **Do** encode focus with depth: the active surface is sharp and lifted; blur and dim whatever it sits on top of. When an overlay opens, blur and scrim the layer behind it.
- **Do** hold the tension: cinematic atmosphere in the backdrop, instrument-grade precision in the foreground — and buy that atmosphere from the wallpaper and the blur, which the compositor is already paying for.
- **Do** keep the accent rare enough to still signal — mark the single most important state or action per surface.
- **Do** use the fixed 28px nav icon slot so Material (18px) and EVE-neocom (28px) glyphs share a baseline.

### Don't:
- **Don't** hardcode one of the eight data hues, or inline-style any color in JS markup — always class + token.
- **Don't** hardcode the accent color — it is `roles.accent` over the active palette, expressed only through `--accent*`. A literal crimson hex breaks every user palette.
- **Don't** type a fresh accent tint or hue variant by hand — derive it from a swatch via `theme-vars.js` (`hexToRgba` / `lighten` / `darken`). Only the 13 swatches are hand-set.
- **Don't** leave two planes competing at the same clarity — an open overlay must take focus while the layer behind it blurs and dims.
- **Don't** paint a full-frame ambient gradient behind the app, or reinstate the reeded flute overlay. Atmosphere is the wallpaper plus the blur; both of those were removed for being invisible and expensive.
- **Don't** leave a decorative animation running while the window is unfocused, or leave `will-change` set on something that has stopped moving.
- **Don't** frame a type icon in a list row with a border or background plate — the artwork carries itself; only 64px hero images are matted.
- **Don't** set numbers in the sans font or spread the accent across a field of equally-weighted buttons.
- **Don't** add manual Sync/Refresh buttons — data auto-refreshes on ESI's own cache cadence.
- **Don't** use emoji in the app chrome; use the Material or EVE-neocom icon families.
- **Don't** re-introduce a YAML/JS theme engine or add a second named preset — there is one built-in theme (`src/styles/theme-default.css`); user palettes are generated plain-CSS files, one custom property per token.
