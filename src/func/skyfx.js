// ─── skyfx.js — the Spatial map's dust, star twinkle and lens flares ─────────
// No DOM, no globals: unit-testable under Node (`node --test`) and reused in the
// browser via window.SkyFx. Loaded as a plain <script> before map.js, which owns
// the canvas and does the drawing.
//
// WHY THE DUST HAS A CAMERA OF ITS OWN
//
// The Spatial camera never actually moves closer to anything. Zoom is
// magnification: every star scales about the same point at the same rate, so
// flying in looks exactly like enlarging a photograph. Nothing on screen says
// "you are travelling" - and that is what the dust is for.
//
// It fills a box of space just in front of a camera of its own, and that camera
// is driven by how the real one changes:
//
//   zoom in / out   travel forward / back: specks stream past the lens, or
//                   fall away towards the middle of the view
//   pan             a slide: near specks cross faster than the map, far ones
//                   barely faster
//   orbit           a swing round a point beyond the dust: every speck sweeps
//                   the way the near side of the map does, the nearest fastest
//   a focus glide   travel along the glide
//
// Every move is eased in over a fraction of a second rather than taken at once:
// a wheel tick is a 12% jump in a single frame, and taken whole the dust would
// teleport. Eased, it streams.
//
// It shows only round the edges of the view - none across the middle, rising
// to all of it at the edges, like a vignette: motes turning up in the middle of
// the screen looked wrong, and the middle is where the stars you are looking at
// are. The motes are soft and greyed, keeping only a hint of the gas's colour -
// in its full colour they read as little stars flying past - and mostly come in
// loose clumps, a few smaller motes turning slowly round a bigger one, the way
// dust hangs together.
//
// THE STARS
//
// Each star twinkles on its own rhythm - a slow swell, a quick shimmer riding
// on it, and now and then a sharp glint - so neighbours never pulse in step.
// Flown in, each also carries a small lens flare, and the star the view is
// closing on carries a bigger one. Their sizes were set against a real view,
// see FLARE below.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node / tests
  if (typeof window !== 'undefined') window.SkyFx = api;                       // renderer
})(this, function () {
  'use strict';

  const TAU = Math.PI * 2;

  // The dust rig, in units of its own. A speck at depth z that the camera
  // slides past by s units crosses s * focal / z px of screen.
  const DUST = {
    near:     0.16,  // a speck nearer than this has passed the lens
    far:      1.6,   // and further than this has faded into the gas
    mapDepth: 2.0,   // where the map itself sits, as far as the dust is concerned
    pivot:    1.9,   // what an orbit swings the dust round: past all of it, as the map's pivot is
    turn:     0.3,   // how much of an orbit the dust takes - all of it whipped the near specks across the screen
    drift:    0.006, // units a second a speck wanders on its own
    margin:   1.08,  // how far past the edge of the view the box reaches, so a wrap is never seen
    focal:    0.8,   // focal length, in view widths: about a 64 degree field
    perPx:    1800,  // one mote in the box per this many px of view; about a third are ever in view
    max:      2000,
    clump:    0.014, // how far a clump's small motes float from its biggest
    clear:    0.5,   // the vignette: no dust inside this much of the way to the view's edge...
    edge:     1.05,  // ...and all of it by here (1 is the middle of an edge, 1.41 a corner)
    tint:     0.18,  // how much of the gas's colour the dust keeps
  };

  // Measured, not guessed: in the screenshot the flares were judged against
  // (G15Z-W selected, Scalding Pass, a 2184 px wide map) a typical stargate
  // spans 333 px, and the bridge from HJ-BCH to V-F6DQ 82 px. The closest
  // star's flare is about a third of that bridge - half a centimetre to a
  // centimetre on that screen - and every other star's two thirds of that:
  // any smaller and it never cleared the star's own glow. Sizes are what you
  // see, ray tip to ray tip; they grow gently as you fly further in, never
  // past the cap.
  const FLARE = {
    refGatePx: 333,
    hero: 30, heroMin: 22, heroMax: 40,     // px, the star you are closing on
    star: 20, starMin: 11, starMax: 24,     // px, every other star (a mid-size one, near)
    starFrom: 36,  starFull: 70,            // gate px over which the small flares come in...
    heroFrom: 100, heroFull: 200,           // ...and the big one: only once you are really close
  };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

  /** mulberry32, as in nebula.js: a small seeded generator, uniform in [0, 1). */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** How many specks a view this size gets. */
  function dustCount(W, H) {
    return clamp(Math.round((W * H) / DUST.perPx), 120, DUST.max);
  }

  /**
   * A box of motes, spread evenly through it - mostly in loose clumps. Dust
   * rarely drifts alone: most motes come with one to four smaller ones turning
   * slowly round them. Seeded, so a test sees the same field every time.
   * Positions start in a unit box; fitDust scales it to the view.
   *
   * `count` is about how many motes in all. parent[i] is the clump's biggest
   * mote for a small one, and -1 for the biggest itself: only those are moved,
   * and their small motes follow.
   */
  function makeDust(count, seed) {
    const r = rng(seed);
    const kids = [];                        // small motes per clump: none for about a quarter, up to four
    let n = 0;
    while (n < count) {
      const u = r(), k = u < 0.28 ? 0 : u < 0.55 ? 1 : u < 0.78 ? 2 : u < 0.92 ? 3 : 4;
      kids.push(k);
      n += 1 + k;
    }
    const f32 = () => new Float32Array(n);
    const f = {
      n, r, t: 0,
      x: f32(), y: f32(), z: f32(),
      vx: f32(), vy: f32(), vz: f32(),      // each clump's own wander
      size: f32(),
      age: f32(),                           // seconds since it last came into the box
      px: f32(), py: f32(),                 // where it was drawn last frame...
      seen: new Uint8Array(n),              // ...if it was: a streak runs from there
      parent: new Int32Array(n),
      orbit: f32(), spin: f32(), phase: f32(),   // a small mote's distance, turn rate and place round its clump
      jump: new Uint8Array(n),              // set for one step when a clump leaves the box and comes back elsewhere
      X: 1, Y: 1, W: 0, H: 0, F: 0,
    };
    let i = 0;
    for (const k of kids) {
      const p = i++;
      f.parent[p] = -1;
      f.x[p] = r() * 2 - 1;
      f.y[p] = r() * 2 - 1;
      f.z[p] = DUST.near + r() * (DUST.far - DUST.near);
      f.vx[p] = (r() * 2 - 1) * DUST.drift;
      f.vy[p] = (r() * 2 - 1) * DUST.drift;
      f.vz[p] = (r() * 2 - 1) * DUST.drift;
      f.size[p] = 0.75 + r() * 0.65;
      f.age[p] = 10;                        // already there: nothing fades in on the first frame
      for (let c = 0; c < k; c++, i++) {
        f.parent[i] = p;
        f.size[i] = f.size[p] * (0.35 + r() * 0.45);
        f.orbit[i] = DUST.clump * (0.3 + r() * 0.7);
        f.spin[i] = (r() < 0.5 ? -1 : 1) * (0.15 + r() * 0.35);   // rad/s: a turn every 12-40 s
        f.phase[i] = r() * TAU;
      }
    }
    placeClumps(f, 0);
    return f;
  }

  /**
   * Every small mote at its place round its clump's biggest at time t (s): a
   * slow, slightly tilted turn, near enough the same depth. A clump that just
   * left the box and came back elsewhere takes its small motes with it.
   */
  function placeClumps(f, t) {
    for (let i = 0; i < f.n; i++) {
      const p = f.parent[i];
      if (p < 0) continue;
      const a = f.phase[i] + f.spin[i] * t, o = f.orbit[i];
      f.x[i] = f.x[p] + o * Math.cos(a);
      f.y[i] = f.y[p] + o * 0.8 * Math.sin(a);
      f.z[i] = Math.max(DUST.near * 0.5, f.z[p] + o * 0.6 * Math.sin(0.7 * a + f.phase[i]));
      f.age[i] = f.age[p];
      if (f.jump[p]) f.seen[i] = 0;
    }
  }

  /**
   * Size the box to the view: the far end of the view's frustum, a little over.
   * What is already there is rescaled with it, so a resize moves nothing.
   */
  function fitDust(f, W, H) {
    const F = DUST.focal * W;
    const X = DUST.far * (W / 2) / F * DUST.margin;
    const Y = DUST.far * (H / 2) / F * DUST.margin;
    const kx = X / f.X, ky = Y / f.Y;
    for (let i = 0; i < f.n; i++) { f.x[i] *= kx; f.y[i] *= ky; }
    f.X = X; f.Y = Y; f.W = W; f.H = H; f.F = F;
    placeClumps(f, f.t);                    // a clump keeps its size whatever the box's
    f.seen.fill(0);
  }

  /**
   * How much dust shows at a point on screen, 0..1: none across the middle of
   * the view, rising to all of it at the edges - a vignette. Motes turning up
   * in the middle of the screen looked wrong; dust catching the light round the
   * edge of a lens looks like dust.
   */
  function vignette(sx, sy, W, H) {
    const u = (2 * sx - W) / W, v = (2 * sy - H) / H;
    return smooth(DUST.clear, DUST.edge, Math.sqrt(u * u + v * v));
  }

  /**
   * Dust's colour from the gas behind it, written into `out`: most of the
   * colour taken out, and lifted off black. In the gas's own saturated colour
   * the motes read as little stars flying past; greyed, they read as dust.
   */
  function dustTint(rgb, out) {
    const L = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    for (let k = 0; k < 3; k++) out[k] = clamp(Math.round(50 + 0.75 * (L + (rgb[k] - L) * DUST.tint)), 0, 255);
    return out;
  }

  /** Where speck i lands on screen, and its radius in px - or null out of view. */
  function projectDust(f, i, speck) {
    const z = f.z[i];
    const sx = f.W / 2 + f.F * f.x[i] / z, sy = f.H / 2 + f.F * f.y[i] / z;
    const r = speck * f.size[i] / z;
    if (sx < -r || sx > f.W + r || sy < -r || sy > f.H + r) return null;
    return [sx, sy, r];
  }

  /** How strongly a speck shows at depth z: fading up out of the far gas, and out just before the lens. */
  function depthFade(z) {
    return smooth(DUST.near, DUST.near + 0.12, z) * (1 - smooth(DUST.far - 0.5, DUST.far, z));
  }

  /**
   * How the camera moved between two snapshots, as the dust sees it.
   * Snapshots are { zoom, panX, panY, yaw, pitch, fx, fy, fz, W, H, flat }, the
   * pitch as drawn (Flat looks straight down). toView(dx, dy, dz, yaw, pitch)
   * turns a world offset into camera space the way the map's projection does,
   * and pxPerUnit is how many px a world unit spans at the focus.
   *
   *   zoom      log of the zoom ratio: + is flying in
   *   dx, dy    the map's slide at its own depth, px
   *   travel    forward motion from a focus glide, px at the map's depth
   *   yaw, pitch  turns, radians
   *   cut       a jump no camera makes - a refit, a resize, a switch to Flat -
   *             so the dust starts afresh instead of streaking across the view
   */
  function cameraDelta(a, b, pxPerUnit, toView) {
    if (!a || !b || a.W !== b.W || a.H !== b.H || a.flat !== b.flat) return { cut: true };
    const zoom = Math.log(b.zoom / a.zoom);
    const yaw = b.yaw - a.yaw, pitch = b.pitch - a.pitch;
    let dx = b.panX - a.panX, dy = b.panY - a.panY, travel = 0;
    // A glide moves the focus with the angles held. An orbit moves the focus
    // too, but only to keep its pivot still: the swing is the motion then, and
    // counting the focus as well would count it twice.
    if (!yaw && !pitch) {
      const ox = b.fx - a.fx, oy = b.fy - a.fy, oz = b.fz - a.fz;
      if (ox || oy || oz) {
        const v = toView(ox, oy, oz, b.yaw, b.pitch);
        dx -= v[0] * pxPerUnit;
        dy -= v[1] * pxPerUnit;
        travel = v[2] * pxPerUnit;
      }
    }
    const span = Math.max(b.W, b.H) * 3;
    if (!Number.isFinite(zoom) || Math.abs(zoom) > 1.2 || Math.abs(yaw) > 0.7 || Math.abs(pitch) > 0.7
        || !(Math.hypot(dx, dy) <= span) || !(Math.abs(travel) <= span)) return { cut: true };
    return { cut: false, zoom, dx, dy, travel, yaw, pitch };
  }

  /** Motion still to be played out. */
  function motion() { return { zoom: 0, dx: 0, dy: 0, travel: 0, yaw: 0, pitch: 0 }; }

  const KEYS = ['zoom', 'dx', 'dy', 'travel', 'yaw', 'pitch'];

  function addMotion(p, d) { for (const k of KEYS) p[k] += d[k]; return p; }

  function clearMotion(p) { for (const k of KEYS) p[k] = 0; return p; }

  /** Take `share` of what is pending, leaving the rest for later frames. */
  function takeMotion(p, share) {
    const m = {};
    for (const k of KEYS) { m[k] = p[k] * share; p[k] -= m[k]; }
    return m;
  }

  /** The share of a pending move to play this frame, so a jump plays out over about tau seconds. */
  function easeShare(dt, tau) { return 1 - Math.exp(-dt / tau); }

  /** True while there is enough motion left to be worth drawing every frame for. */
  function moving(p) {
    return Math.abs(p.zoom) > 1e-4 || Math.abs(p.dx) > 0.05 || Math.abs(p.dy) > 0.05
      || Math.abs(p.travel) > 0.05 || Math.abs(p.yaw) > 1e-4 || Math.abs(p.pitch) > 1e-4;
  }

  /**
   * Move every clump: this frame's share of the camera's motion (m, from
   * takeMotion, with pitchNow - the camera's pitch, which the yaw axis leans
   * with), then its own wander; its small motes follow, turning round it at
   * time t. Anything leaving the box comes back in on the far side: flying in,
   * at the far end, out of the gas; flying out, from just behind the lens, and
   * anywhere across the box - which at that depth is mostly off screen, so it
   * drifts in from the edge the way something you have just backed past would.
   * Either way it fades in, so nothing pops.
   */
  function stepDust(f, m, dt, t) {
    const { near, far, mapDepth, pivot, turn, drift } = DUST;
    const depth = far - near, X = f.X, Y = f.Y, F = f.F;
    // The map slid dx px at its own depth: the dust camera slid dx * mapDepth / F.
    const sx = m.dx * mapDepth / F, sy = m.dy * mapDepth / F;
    // Zoom by k is travel that magnifies the map's depth by k.
    const fwd = mapDepth * (1 - Math.exp(-m.zoom)) + m.travel * mapDepth / F;
    const yaw = m.yaw * turn, pitch = m.pitch * turn;
    const cy = Math.cos(yaw), sy2 = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const lean = m.pitchNow || 0, cl = Math.cos(lean), sl = Math.sin(lean);
    // A slow current through the whole field, so it is never quite still.
    const wx = drift * 0.7 * Math.sin(t * 0.071 + 1.3);
    const wy = drift * 0.45 * Math.sin(t * 0.053 + 4.1);
    const wz = drift * 0.8 * Math.sin(t * 0.037 + 2.2);
    for (let i = 0; i < f.n; i++) {
      if (f.parent[i] >= 0) continue;        // a small mote goes where its clump goes
      f.jump[i] = 0;
      let x = f.x[i], y = f.y[i], z = f.z[i];
      if (yaw || pitch) {
        let zr = z - pivot;
        if (yaw) {
          // About the galaxy's own up, as this camera sees it: undo the lean,
          // turn, lean back - the same turn the map's projection makes.
          const y0 = y * cl + zr * sl;
          let z0 = -y * sl + zr * cl;
          const x1 = x * cy + z0 * sy2;
          z0 = -x * sy2 + z0 * cy;
          x = x1;
          y = y0 * cl - z0 * sl;
          zr = y0 * sl + z0 * cl;
        }
        if (pitch) {
          const y1 = y * cp - zr * sp;
          zr = y * sp + zr * cp;
          y = y1;
        }
        z = zr + pivot;
      }
      x += sx + (f.vx[i] + wx) * dt;
      y += sy + (f.vy[i] + wy) * dt;
      z += -fwd + (f.vz[i] + wz) * dt;
      if (z < near || z > far) {
        z = near + (((z - near) % depth) + depth) % depth;
        x = (f.r() * 2 - 1) * X;
        y = (f.r() * 2 - 1) * Y;
        f.age[i] = 0;
        f.seen[i] = 0;
        f.jump[i] = 1;
      }
      if (x > X || x < -X) { x -= Math.sign(x) * 2 * X * Math.ceil((Math.abs(x) - X) / (2 * X)); f.seen[i] = 0; f.jump[i] = 1; }
      if (y > Y || y < -Y) { y -= Math.sign(y) * 2 * Y * Math.ceil((Math.abs(y) - Y) / (2 * Y)); f.seen[i] = 0; f.jump[i] = 1; }
      f.x[i] = x; f.y[i] = y; f.z[i] = z;
      f.age[i] += dt;
    }
    f.t = t;
    placeClumps(f, t);
  }

  /** A stable 32-bit seed from a system id. */
  function seedOf(id) { return Math.imul((id | 0) ^ 0x5bd1e995, 2654435761) >>> 0; }

  /** A star's own rhythm, from its id: rates in radians (or cycles) a second, and where it starts. */
  function twinkleOf(id) {
    const r = rng(seedOf(id));
    return {
      slow:  TAU / (2.6 + r() * 3.6),  slowAt:  r() * TAU,   // a swell every 2.6-6.2 s
      quick: TAU / (0.38 + r() * 0.6), quickAt: r() * TAU,   // a shimmer every 0.4-1 s
      glint: 1 / (5 + r() * 12),       glintAt: r(),         // a glint every 5-17 s
      // Pulled out to the whole cluster only these glint: a third of 5,500
      // stars is still a sky full of them, and every one costs a draw.
      far:   r() < 0.35,
    };
  }

  /**
   * The glint alone at time t (s), 0..1: a sharp flash about a twentieth of its
   * cycle wide, and exactly nothing outside a sixth of it - so a star that is
   * not glinting costs one multiply to rule out.
   */
  function glint(q, t) {
    const c = ((t * q.glint + q.glintAt) % 1 + 1) % 1 - 0.5;
    return c * c > 0.0064 ? 0 : Math.exp(-(c * c) / 0.0012);
  }

  /** How bright a star's twinkle is at time t (s): 0..1. */
  function twinkle(q, t) {
    const slow = 0.5 + 0.5 * Math.sin(t * q.slow + q.slowAt);
    const quick = 0.5 + 0.5 * Math.sin(t * q.quick + q.quickAt);
    return Math.min(1, 0.1 + 0.55 * slow * (0.72 + 0.28 * quick) + 0.55 * glint(q, t));
  }

  /** The quick shimmer alone, 0..1 - what the fainter diagonal rays ride on. */
  function shimmer(q, t) { return 0.5 + 0.5 * Math.sin(t * q.quick + q.quickAt); }

  /**
   * The star the view is closing on: the one nearest the middle of the view,
   * nearer stars preferred - and sticky, so the big flare does not hop between
   * two stars almost as central as each other. `s` holds the stars the map just
   * drew as parallel arrays { n, x, y, t, id }, t being 1 at the near edge of
   * the view's depth and 0 at the far.
   */
  function pickHero(s, W, H, prevId) {
    const cx = W / 2, cy = H / 2, D = Math.min(W, H) / 2;
    let best = -1, bestScore = Infinity, prevScore = Infinity;
    for (let i = 0; i < s.n; i++) {
      const d = Math.hypot(s.x[i] - cx, s.y[i] - cy) / D;
      if (d > 0.9) continue;
      const score = d + 0.3 * (1 - s.t[i]);
      if (score < bestScore) { bestScore = score; best = i; }
      if (s.id[i] === prevId) prevScore = score;
    }
    if (best < 0) return null;
    return prevScore - bestScore < 0.05 ? prevId : s.id[best];
  }

  /**
   * Flare sizes for how long a typical gate looks on screen: px across for a
   * star and for the one being closed on, and how much of each to show (0..1).
   */
  function flareSizes(gatePx) {
    const g = Math.max(1e-6, gatePx) / FLARE.refGatePx;
    return {
      star:  clamp(FLARE.star * Math.pow(g, 0.2), FLARE.starMin, FLARE.starMax),
      hero:  clamp(FLARE.hero * Math.pow(g, 0.35), FLARE.heroMin, FLARE.heroMax),
      starK: smooth(FLARE.starFrom, FLARE.starFull, gatePx),
      heroK: smooth(FLARE.heroFrom, FLARE.heroFull, gatePx),
    };
  }

  return { DUST, FLARE, rng, dustCount, makeDust, placeClumps, fitDust, projectDust, depthFade, vignette, dustTint,
           cameraDelta, motion, addMotion, clearMotion, takeMotion, easeShare, moving, stepDust,
           twinkleOf, glint, twinkle, shimmer, pickHero, flareSizes, smooth };
});
