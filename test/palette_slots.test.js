'use strict';
//
// Every swatch the palette editor offers must actually drive something.
//
// Three of them did not. baby_blue, indigo and cyan were shown in Settings and
// written into every saved theme, but no rule anywhere read them — you could
// pick any colour and nothing changed. A control that costs the user a decision
// and then ignores it is worse than a missing one, and nothing catches it: the
// editor renders happily, the theme saves happily, and the app looks the same.
//
// So the slot list is checked against what the stylesheets actually reference.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT       = path.join(__dirname, '..');
const PALETTE_JS = path.join(ROOT, 'src', 'func', 'palette.js');
const STYLES_DIR = path.join(ROOT, 'src', 'styles');

/** The slot table, read from source — no renderer needed. */
function swatchSlots() {
  const src   = fs.readFileSync(PALETTE_JS, 'utf8');
  const block = src.slice(src.indexOf('const SWATCH_SLOTS = ['), src.indexOf('const SWATCH_GROUPS'));
  const slots = [];
  const re = /\{\s*key:\s*'([^']+)'\s*,\s*group:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block))) slots.push({ key: m[1], group: m[2] });
  return slots;
}

const allCss = () => fs.readdirSync(STYLES_DIR)
  .filter(f => f.endsWith('.css'))
  .map(f => fs.readFileSync(path.join(STYLES_DIR, f), 'utf8'))
  .join('\n');

test('the slot table parses and is not empty', () => {
  const slots = swatchSlots();
  assert.ok(slots.length >= 10, `only found ${slots.length} slots`);
  assert.ok(slots.some(s => s.group === 'status'));
  assert.ok(slots.some(s => s.group === 'data'));
  assert.ok(slots.some(s => s.group === 'structure'));
});

test('every colour swatch drives a --pal-* token some stylesheet reads', () => {
  const css  = allCss();
  const dead = swatchSlots()
    .filter(s => s.group !== 'structure')
    .filter(s => !css.includes(`--pal-${s.key}`));
  assert.deepStrictEqual(dead.map(s => s.key), [],
    `these swatches are offered but nothing reads them: ${dead.map(s => s.key).join(', ')}`);
});

test('the retired swatches are gone from the editor', () => {
  // Named explicitly so re-adding one has to be a deliberate act with a token
  // to back it, rather than an accident that quietly ships a dead control.
  const keys = swatchSlots().map(s => s.key);
  for (const gone of ['baby_blue', 'indigo', 'cyan']) {
    assert.ok(!keys.includes(gone), `${gone} is back in the editor without a token`);
  }
});

test('the operational signals are NOT offered as swatches', () => {
  // The whole point of signals.css: a traffic light whose red can be set to blue
  // has stopped being a traffic light.
  const keys = swatchSlots().map(s => s.key);
  for (const k of keys) {
    assert.ok(!k.startsWith('signal'), `${k} would make an operational signal user-editable`);
  }
  const signals = fs.readFileSync(path.join(STYLES_DIR, 'signals.css'), 'utf8');
  for (const tok of ['--signal-go', '--signal-hold', '--signal-stop']) {
    assert.ok(signals.includes(tok), `${tok} must be defined in signals.css`);
  }
});

test('no theme file overrides a signal', () => {
  // signals.css is linked after the theme so it wins anyway, but a theme that
  // tries is a sign somebody misunderstood the split.
  for (const f of fs.readdirSync(STYLES_DIR).filter(n => n.startsWith('theme-'))) {
    const css = fs.readFileSync(path.join(STYLES_DIR, f), 'utf8');
    assert.ok(!/--signal-/.test(css), `${f} sets a --signal-* token`);
  }
});
