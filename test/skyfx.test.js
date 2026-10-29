// The Spatial map's dust, twinkle and lens flares (src/func/skyfx.js): the dust
// has to move the way the camera does - in when you fly in, away when you pull
// out, past faster the nearer it is - and the flares have to be the size they
// were judged at, on the star the view is closing on.
const test = require('node:test');
const assert = require('node:assert/strict');
const SkyFx = require('../src/func/skyfx.js');

const W = 1600, H = 900, SPECK = 0.8;
const still = { zoom: 0, dx: 0, dy: 0, travel: 0, yaw: 0, pitch: 0 };

function field() {
  const f = SkyFx.makeDust(SkyFx.dustCount(W, H), 7);
  SkyFx.fitDust(f, W, H);
  return f;
}

/** Every speck's place on screen (or null) and depth, before and after a move made with no drift. */
function across(move) {
  const f = field();
  const before = Array.from({ length: f.n }, (_, i) => ({ p: SkyFx.projectDust(f, i, SPECK), z: f.z[i] }));
  f.seen.fill(1);
  SkyFx.stepDust(f, Object.assign({}, still, move), 0, 0);
  // A speck that left the box came back in somewhere else - stepDust clears
  // its seen flag so no streak is drawn - and has no "after" to compare.
  return before.map((b, i) => ({ ...b, q: SkyFx.projectDust(f, i, SPECK), z2: f.z[i], wrapped: !f.seen[i] }))
    .filter(s => s.p && s.q && !s.wrapped);
}

const fromMiddle = ([x, y]) => Math.hypot(x - W / 2, y - H / 2);

test('flying in, the dust comes towards the lens and streams out from the middle', () => {
  const specks = across({ zoom: Math.log(1.12) });
  assert.ok(specks.length > 100, `enough specks in view to judge: ${specks.length}`);
  for (const s of specks) {
    assert.ok(s.z2 < s.z, 'nearer');
    assert.ok(fromMiddle(s.q) >= fromMiddle(s.p) - 1e-9, 'further out on screen');
  }
});

test('pulling out, it falls away towards the middle', () => {
  const specks = across({ zoom: -Math.log(1.12) });
  assert.ok(specks.length > 100);
  for (const s of specks) {
    assert.ok(s.z2 > s.z, 'further');
    assert.ok(fromMiddle(s.q) <= fromMiddle(s.p) + 1e-9, 'closer to the middle');
  }
});

test('when the map slides, every speck crosses faster than it - the nearest fastest', () => {
  const specks = across({ dx: 10 });
  for (const s of specks) {
    const moved = s.q[0] - s.p[0];
    assert.ok(moved > 10, `in front of the map, so faster than its 10 px: ${moved}`);
    assert.ok(Math.abs(moved - 10 * SkyFx.DUST.mapDepth / s.z) < 0.01, 'parallax: inversely with depth');
  }
});

test('an orbit sweeps the dust the way the near side of the map goes, the nearest fastest', () => {
  // The map's projection carries its near side LEFT as yaw grows, and the dust
  // is all nearer than the map. Far specks at the very edge of the view can
  // drift out a touch instead - turning brings that side of the box closer,
  // which is perspective, not a bug - so the rule is held to the near ones
  // and to the field as a whole.
  const specks = across({ yaw: 0.05, pitchNow: 0 });
  const near = [], far = [], all = [];
  for (const s of specks) {
    const moved = s.q[0] - s.p[0];
    all.push(moved);
    if (s.z < 0.5) { assert.ok(moved < 0, 'a near speck goes left'); near.push(-moved); }
    if (s.z > 1.3) far.push(Math.abs(moved));
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(near.length && far.length);
  assert.ok(mean(all) < 0, 'the field as a whole goes left');
  assert.ok(mean(near) > 3 * mean(far), `near ${mean(near).toFixed(1)} px vs far ${mean(far).toFixed(1)} px`);
});

/** How far each small mote sits from its clump's biggest, in the dust's own units. */
const offsets = (f) => Array.from(f.parent).map((p, i) =>
  p < 0 ? null : Math.hypot(f.x[i] - f.x[p], f.y[i] - f.y[p], f.z[i] - f.z[p]));

test('whatever the camera does, the dust stays in its box, and what comes back in fades in', () => {
  const f = field();
  for (const m of [{ zoom: 3 }, { zoom: -3 }, { dx: 9000, dy: -4000 }, { yaw: 0.6, pitch: -0.4, pitchNow: 1 }, { travel: 20000 }]) {
    SkyFx.stepDust(f, Object.assign({}, still, m), 0.016, 1);
    for (let i = 0; i < f.n; i++) {
      if (f.parent[i] >= 0) continue;              // a small mote rides with its clump, checked below
      assert.ok(f.z[i] >= SkyFx.DUST.near && f.z[i] <= SkyFx.DUST.far, `depth ${f.z[i]}`);
      assert.ok(Math.abs(f.x[i]) <= f.X && Math.abs(f.y[i]) <= f.Y, 'across');
    }
    // A turn round the clump plus its small tilt in depth: never past 1.17x the clump's reach.
    for (const o of offsets(f)) if (o !== null) assert.ok(o <= SkyFx.DUST.clump * 1.2, 'and its small motes with it');
  }
  const back = Array.from(f.age).filter(a => a < 0.1).length;
  assert.ok(back > f.n / 2, 'the motes that re-entered start their fade from nothing');
  assert.equal(SkyFx.depthFade(SkyFx.DUST.near), 0, 'and nothing shows right at the lens...');
  assert.equal(SkyFx.depthFade(SkyFx.DUST.far), 0, '...or at the far end');
  assert.equal(SkyFx.depthFade(0.9), 1);
});

test('the field is seeded, and a resize rescales it rather than reshuffling it', () => {
  const a = field(), b = field();
  assert.deepEqual(Array.from(a.x), Array.from(b.x));
  const lead = Array.from(a.parent).indexOf(-1, 5);
  const x0 = a.x[lead] / a.X, y0 = a.y[lead] / a.Y, clumps = offsets(a);
  SkyFx.fitDust(a, 1000, 1000);
  assert.ok(Math.abs(a.x[lead] / a.X - x0) < 1e-6 && Math.abs(a.y[lead] / a.Y - y0) < 1e-6);
  offsets(a).forEach((o, i) => { if (o !== null) assert.ok(Math.abs(o - clumps[i]) < 1e-5, 'a clump keeps its size'); });
  assert.ok(SkyFx.dustCount(2184, 1110) > SkyFx.dustCount(1291, 726));
  assert.equal(SkyFx.dustCount(100000, 100000), SkyFx.DUST.max);
});

test('dust comes in clumps: a few smaller motes floating slowly round a bigger one', () => {
  const f = field();
  const leaders = Array.from(f.parent).filter(p => p < 0).length;
  const small = f.n - leaders;
  assert.ok(small > leaders * 1.1, `most motes have company: ${small} small round ${leaders}`);
  assert.ok(Math.abs(f.n - SkyFx.dustCount(W, H)) <= 5, 'and the count is still what the view asked for');
  for (let i = 0; i < f.n; i++) {
    const p = f.parent[i];
    if (p >= 0) assert.ok(f.size[i] < f.size[p], 'the small ones are smaller');
  }
  // Time passing with the camera still: each small mote turns round its clump,
  // keeping its distance; the clump itself only drifts.
  const kid = Array.from(f.parent).findIndex(p => p >= 0), p = f.parent[kid];
  const rel = () => [f.x[kid] - f.x[p], f.y[kid] - f.y[p]];
  const before = rel(), d0 = offsets(f)[kid];
  SkyFx.stepDust(f, still, 0, 6);                  // six seconds on, nothing drifting (dt 0)
  const after = rel();
  assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) > d0 * 0.3, 'it floated round');
  assert.ok(Math.abs(offsets(f)[kid] - d0) < SkyFx.DUST.clump * 0.7, 'and stayed close');
  // And a camera move carries the whole clump: the small motes go with it.
  const lx = f.x[p], kx = f.x[kid];
  SkyFx.stepDust(f, Object.assign({}, still, { dx: 40 }), 0, 6);
  assert.ok(Math.abs((f.x[kid] - kx) - (f.x[p] - lx)) < 1e-6);
});

test('the dust keeps to the edges of the view, like a vignette', () => {
  assert.equal(SkyFx.vignette(W / 2, H / 2, W, H), 0, 'none in the middle');
  assert.equal(SkyFx.vignette(W * 0.6, H * 0.55, W, H), 0, 'none near it either');
  assert.ok(SkyFx.vignette(0, H / 2, W, H) > 0.95, 'all of it at the edge');
  assert.equal(SkyFx.vignette(0, 0, W, H), 1, 'and in the corners');
  let last = -1;
  for (let x = W / 2; x <= W; x += 20) {
    const v = SkyFx.vignette(x, H / 2, W, H);
    assert.ok(v >= last, 'rising steadily outwards');
    last = v;
  }
});

test('dust is greyed, with only a hint of the gas behind it - not little coloured stars', () => {
  const sat = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, Math.max(r, g, b));
  for (const gas of [[200, 110, 80], [70, 140, 230], [230, 190, 80], [180, 60, 140]]) {
    const dust = SkyFx.dustTint(gas, [0, 0, 0]);
    assert.ok(sat(dust) < sat(gas) * 0.4, `${gas} -> ${dust}`);
    // Still leaning the gas's way: rust dust warmer than blue dust, and so on.
    const warm = dust[0] - dust[2], gasWarm = gas[0] - gas[2];
    assert.ok(Math.sign(warm) === Math.sign(gasWarm) || Math.abs(warm) < 3);
  }
  const black = SkyFx.dustTint([0, 0, 0], [0, 0, 0]);
  assert.ok(black[0] > 20, 'lifted off black: a mote catching the light');
  const grey = SkyFx.dustTint([128, 128, 128], [0, 0, 0]);
  assert.ok(grey[0] === grey[1] && grey[1] === grey[2], 'grey stays grey');
});

const snap = (o = {}) => Object.assign(
  { zoom: 1, panX: 0, panY: 0, yaw: 0, pitch: 1, fx: 0, fy: 0, fz: 0, W, H, flat: false }, o);
const identity = (dx, dy, dz) => [dx, dy, dz];

test('reads a wheel tick, a glide and an orbit off two camera snapshots', () => {
  // Zoom about the cursor: the zoom, plus the pan that held the cursor still.
  const tick = SkyFx.cameraDelta(snap(), snap({ zoom: 1.12, panX: -30, panY: 12 }), 1000, identity);
  assert.equal(tick.cut, false);
  assert.ok(Math.abs(tick.zoom - Math.log(1.12)) < 1e-12);
  assert.equal(tick.dx, -30);
  assert.equal(tick.dy, 12);

  // A glide: the focus moving with the angles held is travel - its slide
  // shows as the map sliding the other way, its depth as forward motion.
  const glide = SkyFx.cameraDelta(snap(), snap({ fx: 0.01, fz: 0.02 }), 1000, identity);
  assert.equal(glide.dx, -10);
  assert.equal(glide.travel, 20);

  // An orbit moves the focus only to hold its pivot: the swing is the motion.
  const orbit = SkyFx.cameraDelta(snap(), snap({ yaw: 0.1, fx: 0.5 }), 1000, identity);
  assert.equal(orbit.yaw, 0.1);
  assert.equal(orbit.dx, 0);
  assert.equal(orbit.travel, 0);
});

test('a jump no camera makes is a cut, so the dust does not streak across the screen', () => {
  assert.equal(SkyFx.cameraDelta(null, snap(), 1000, identity).cut, true, 'nothing to compare with');
  assert.equal(SkyFx.cameraDelta(snap(), snap({ W: 1200 }), 1000, identity).cut, true, 'a resize');
  assert.equal(SkyFx.cameraDelta(snap(), snap({ flat: true }), 1000, identity).cut, true, 'into Flat');
  assert.equal(SkyFx.cameraDelta(snap(), snap({ zoom: 5 }), 1000, identity).cut, true, 'a refit');
  assert.equal(SkyFx.cameraDelta(snap(), snap({ yaw: 1 }), 1000, identity).cut, true, 'a view snapped round');
  assert.equal(SkyFx.cameraDelta(snap(), snap({ panX: 1e6 }), 1000, identity).cut, true, 'a pan far off');
});

test('a move is played out over a moment: all of it, none of it twice', () => {
  const p = SkyFx.addMotion(SkyFx.motion(), { zoom: 0.2, dx: 50, dy: -20, travel: 5, yaw: 0.1, pitch: -0.05 });
  assert.equal(SkyFx.moving(p), true);
  const sum = SkyFx.motion();
  const first = SkyFx.takeMotion(p, SkyFx.easeShare(1 / 60, 0.09));
  assert.ok(first.dx > 0 && first.dx < 50 * 0.25, `one frame takes a slice, not the lot: ${first.dx}`);
  SkyFx.addMotion(sum, first);
  for (let f = 1; f < 60; f++) SkyFx.addMotion(sum, SkyFx.takeMotion(p, SkyFx.easeShare(1 / 60, 0.09)));
  assert.equal(SkyFx.moving(p), false, 'done within a second');
  assert.ok(Math.abs(sum.dx + p.dx - 50) < 1e-9 && Math.abs(sum.zoom + p.zoom - 0.2) < 1e-12, 'nothing lost or doubled');
  SkyFx.clearMotion(p);
  assert.deepEqual(p, SkyFx.motion());
});

test('every star twinkles on its own beat, now and then with a sharp glint', () => {
  const a = SkyFx.twinkleOf(30000690), b = SkyFx.twinkleOf(30000732);
  assert.deepEqual(a, SkyFx.twinkleOf(30000690), 'the same star, the same rhythm');
  let lo = 1, hi = 0, apart = 0;
  for (let t = 0; t < 60; t += 0.05) {
    const v = SkyFx.twinkle(a, t);
    assert.ok(v >= 0 && v <= 1);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
    if (Math.abs(v - SkyFx.twinkle(b, t)) > 0.1) apart++;
  }
  assert.ok(hi - lo > 0.5, `it visibly pulses: ${lo.toFixed(2)}..${hi.toFixed(2)}`);
  assert.ok(apart > 400, 'neighbours out of step');
  // The glint: full at the middle of its cycle, and nothing a quarter-cycle off.
  const peak = (0.5 - a.glintAt + 1) / a.glint;
  assert.ok(SkyFx.glint(a, peak) > 0.999);
  assert.equal(SkyFx.glint(a, peak + 0.25 / a.glint), 0);
  assert.ok(SkyFx.twinkle(a, peak) > 0.6, 'and it shows in the twinkle');
});

test('the big flare goes on the star in the middle of the view, the nearer of two, and stays put', () => {
  const stars = (rows) => ({
    n: rows.length,
    x: rows.map(r => r[0]), y: rows.map(r => r[1]), t: rows.map(r => r[2]), id: rows.map(r => r[3]),
  });
  assert.equal(SkyFx.pickHero(stars([[800, 450, 0.5, 1], [400, 300, 1, 2], [1300, 700, 1, 3]]), W, H, null), 1);
  assert.equal(SkyFx.pickHero(stars([[760, 450, 0.2, 1], [840, 450, 0.9, 2]]), W, H, null), 2, 'the nearer');
  // Two almost as central as each other: whichever already has it keeps it.
  const close = stars([[800, 450, 1, 1], [812, 450, 1, 2]]);
  assert.equal(SkyFx.pickHero(close, W, H, 2), 2);
  assert.equal(SkyFx.pickHero(close, W, H, null), 1);
  assert.equal(SkyFx.pickHero(stars([[800, 450, 1, 1], [1100, 700, 1, 2]]), W, H, 2), 1, 'unless one is clearly better');
  assert.equal(SkyFx.pickHero(stars([[10, 10, 1, 1], [1590, 890, 1, 2]]), W, H, null), null, 'nothing near the middle');
});

test('flares are the size they were judged at: a third of the HJ-BCH bridge, half a centimetre to a centimetre', () => {
  // The view they were judged in: a typical gate 333 px long, the bridge from
  // HJ-BCH to V-F6DQ 82 px. On that 27" 1440p screen a centimetre is ~43 px.
  const at = SkyFx.flareSizes(333);
  assert.ok(Math.abs(at.hero - 82 / 3) / (82 / 3) < 0.15, `about a third of the bridge: ${at.hero.toFixed(1)} px`);
  assert.ok(at.hero >= 21 && at.hero <= 43);
  assert.equal(at.heroK, 1);
  assert.equal(at.starK, 1);
  for (const g of [40, 80, 160, 333, 700, 2000, 1e5]) {
    const s = SkyFx.flareSizes(g);
    assert.ok(s.star < s.hero, `the star being closed on carries the bigger one at ${g}`);
    assert.ok(s.hero <= SkyFx.FLARE.heroMax && s.star <= SkyFx.FLARE.starMax, 'capped flying further in');
  }
  assert.ok(SkyFx.flareSizes(700).hero > at.hero, 'a little bigger closer still');
  assert.equal(SkyFx.flareSizes(30).starK, 0, 'pulled out the stars are specks: no flares');
  assert.equal(SkyFx.flareSizes(90).heroK, 0, 'the big one only once you are really close');
});
