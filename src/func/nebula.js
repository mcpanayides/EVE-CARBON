// ─── nebula.js — the map's own region nebulae and skybox ─────────────────────
// No DOM, no globals: unit-testable under Node (`node --test`) and reused in the
// browser via window.Nebula. Loaded as a plain <script> before map.js.
//
// WHAT THIS DOES
//
// The SDE gives every region a skybox: a nebulaID whose graphics row is a path
// into the game client's own files ("res:/dx9/scene/Universe/a03_cube.red").
// The art itself ships with the client and is CCP's, so the map never touches
// it. What it does use is the MAPPING - which family each region's skybox comes
// from - and it paints its own nebula for every region from that family:
//
//   a  the Amarr side     golds and ambers       Genesis, Kador, Domain, Delve…
//   c  the Caldari side   steel blues and cyans  The Citadel, The Forge, Deklein…
//   g  the Gallente side  teals and greens       Sinq Laison, Placid, Fountain…
//   m  the Minmatar side  rusts and crimsons     Metropolis, Heimatar, Curse…
//   j  Jove               violets                J7HZ-F, A821-A
//   y  Yasna Zakh         Triglavian red
//   w  wormhole classes   cold greys
//   x  the Abyss          deep reds
//
// Regions sharing a skybox in the SDE (Aridia and Pochven, Sinq Laison and
// Exordium) share a nebula; neighbours in a family look related but not the
// same, because each file number shifts the hue and seeds its own cloud.
//
// Everything here is deterministic: the same key always paints the same cloud,
// so a region looks the same on every launch and in every test.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node / tests
  if (typeof window !== 'undefined') window.Nebula = api;                      // renderer
})(this, function () {
  'use strict';

  // Hues in degrees: the family's body and its accent, saturation 0..1.
  const FAMILIES = {
    a: { hue: 38,  accent: 16,  sat: 0.62 },
    c: { hue: 207, accent: 188, sat: 0.55 },
    g: { hue: 166, accent: 140, sat: 0.50 },
    m: { hue: 14,  accent: 352, sat: 0.62 },
    j: { hue: 272, accent: 248, sat: 0.45 },
    y: { hue: 350, accent: 328, sat: 0.60 },
    w: { hue: 206, accent: 226, sat: 0.16 },
    x: { hue: 356, accent: 330, sat: 0.50 },
  };

  /**
   * Which family and number a skybox file belongs to, or null.
   *   ".../Universe/a03_cube.red"           -> { family: 'a', index: 3,  key: 'a03' }
   *   ".../Wormholes/wormhole_class_02.red" -> { family: 'w', index: 2,  key: 'w02' }
   *   ".../abyssal/ad02_B_cube.red"         -> { family: 'x', index: 22, key: 'x02B' }
   */
  function familyOf(file) {
    const f = String(file || '');
    let m = /\/([acgmjy])(\d+)_cube\.red$/i.exec(f);
    if (m) {
      const family = m[1].toLowerCase(), index = Number(m[2]);
      return { family, index, key: family + m[2] };
    }
    m = /wormhole_class_(\d+)\.red$/i.exec(f);
    if (m) return { family: 'w', index: Number(m[1]), key: 'w' + m[1] };
    m = /\/ad(\d+)_([a-z])_cube\.red$/i.exec(f);
    if (m) {
      const index = Number(m[1]) * 10 + (m[2].toUpperCase().charCodeAt(0) - 64);
      return { family: 'x', index, key: 'x' + m[1] + m[2].toUpperCase() };
    }
    return null;
  }

  /** FNV-1a: a stable 32-bit seed from a key like "a03". */
  function seedOf(key) {
    let h = 2166136261;
    for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /** mulberry32: a small seeded generator, uniform in [0, 1). */
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

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const ch = (t) => {
      t = (t + 1) % 1;
      const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
      return Math.round(v * 255);
    };
    return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
  }

  /**
   * A nebula's two colours: a bright core and a deep edge, from its family's
   * hues shifted by up to 10 degrees by the file number - so Genesis and
   * Kador are both gold, but not the same gold.
   */
  function paletteFor(neb) {
    const fam = FAMILIES[neb && neb.family] || FAMILIES.w;
    const shift = ((neb.index * 37) % 21) - 10;
    return {
      core: hslToRgb(fam.hue + shift, fam.sat, 0.62),
      edge: hslToRgb(fam.accent + shift, Math.min(1, fam.sat + 0.1), 0.30),
    };
  }

  /** Seeded 3-D value noise in [0, 1]. Three dimensions so the skybox can wrap. */
  function makeNoise(seed) {
    const r = rng(seed);
    const perm = new Uint8Array(512), val = new Float32Array(256);
    for (let i = 0; i < 256; i++) { perm[i] = i; val[i] = r(); }
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    const fade = (t) => t * t * (3 - 2 * t);
    return function (x, y, z) {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
      const X = xi & 255, Y = yi & 255, Z = zi & 255;
      const v = (a, b, c) => val[perm[perm[perm[a] + b] + c]];
      const l = (a, b, t) => a + (b - a) * t;
      return l(
        l(l(v(X, Y, Z),     v(X + 1, Y, Z),     xf), l(v(X, Y + 1, Z),     v(X + 1, Y + 1, Z),     xf), yf),
        l(l(v(X, Y, Z + 1), v(X + 1, Y, Z + 1), xf), l(v(X, Y + 1, Z + 1), v(X + 1, Y + 1, Z + 1), xf), yf),
        zf);
    };
  }

  /** Fractal sum of octaves, normalised back to [0, 1]. */
  function fbm(noise, x, y, z, octaves) {
    let sum = 0, amp = 0.5, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * f, y * f, z * f);
      norm += amp; amp *= 0.5; f *= 2.03;
    }
    return sum / norm;
  }

  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

  /**
   * One region's cloud: density 0..1 on a size x size grid, wispy (the noise
   * warped by more noise) and fading to nothing well inside the square's edge,
   * so drawn large and overlapping its neighbours it blends rather than tiles.
   */
  function nebulaDensity(key, size) {
    const seed = seedOf(key), noise = makeNoise(seed), r = rng(seed ^ 0x9e3779b9);
    // An off-centre heart and a lean, so each cloud has its own shape.
    const ox = (r() - 0.5) * 0.35, oy = (r() - 0.5) * 0.35, stretch = 0.75 + r() * 0.5;
    const out = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
      const v = (j / (size - 1)) * 2 - 1;
      for (let i = 0; i < size; i++) {
        const u = (i / (size - 1)) * 2 - 1;
        const du = (u - ox) * stretch, dv = (v - oy) / stretch;
        // The leaning, off-centre shape - inside an envelope that always reaches
        // zero before the square's edge. Leaned far enough, the shape alone
        // reached it, and drawn large that showed as a hard straight line.
        const falloff = (1 - smooth(0.15, 0.98, Math.hypot(du, dv))) * (1 - smooth(0.62, 0.97, Math.hypot(u, v)));
        if (falloff <= 0) continue;
        const wx = fbm(noise, u * 1.4, v * 1.4, 0.37, 3);
        const wy = fbm(noise, u * 1.4 + 5.2, v * 1.4 + 1.3, 0.37, 3);
        const n = fbm(noise, u * 2.1 + wx * 1.6, v * 2.1 + wy * 1.6, 1.7, 5);
        out[j * size + i] = Math.min(1, Math.max(0, (n - 0.36) * 2.4)) * falloff;
      }
    }
    return out;
  }

  /**
   * The skybox's dust: density 0..1 on a w x h grid that wraps left to right -
   * sampled round a cylinder, so turning the camera a full circle never shows
   * a seam.
   */
  function skyDust(seed, w, h) {
    const noise = makeNoise(seed), out = new Float32Array(w * h), R = 2.2;
    // Down the sky at the same rate as round it, or every wisp comes out a tall
    // streak: the circumference is 2*pi*R across w pixels, so h pixels span
    // 2*pi*R * h / w.
    const span = Math.PI * 2 * R * (h / w);
    for (let j = 0; j < h; j++) {
      const y = (j / h) * span;
      for (let i = 0; i < w; i++) {
        const t = (i / w) * Math.PI * 2;
        const n = fbm(noise, Math.cos(t) * R, y, Math.sin(t) * R, 5);
        out[j * w + i] = Math.min(1, Math.max(0, (n - 0.42) * 2.0));
      }
    }
    return out;
  }

  /** Background stars: positions in [0, 1) texture space, brightness and size. */
  function skyStars(seed, count) {
    const r = rng(seed), out = [];
    for (let i = 0; i < count; i++) {
      const b = r();
      out.push({ u: r(), v: r(), b: 0.15 + b * b * 0.6, big: r() < 0.04 });
    }
    return out;
  }

  /**
   * Film grain: a size x size tile of grey levels around mid-grey, bell-shaped
   * like real grain (the mean of three draws) rather than flat static. Laid
   * over the gas with soft light, mid-grey changes nothing, so the grain is
   * all in the spread.
   */
  function grainTile(seed, size) {
    const r = rng(seed), out = new Uint8Array(size * size);
    for (let i = 0; i < out.length; i++) {
      const v = 128 + ((r() + r() + r()) / 3 - 0.5) * 128;
      out[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
    return out;
  }

  /**
   * Where a region is and how big: the mean of its systems' positions and the
   * 85th-percentile distance from it - a few far-flung systems should not
   * blow a region's nebula up across its neighbours.
   */
  function regionExtent(points) {
    if (!points.length) return null;
    let x = 0, y = 0, z = 0;
    for (const p of points) { x += p.x; y += p.y; z += p.z; }
    x /= points.length; y /= points.length; z /= points.length;
    const d = points.map(p => Math.hypot(p.x - x, p.y - y, p.z - z)).sort((a, b) => a - b);
    return { x, y, z, r: d[Math.min(d.length - 1, Math.floor(d.length * 0.85))] };
  }

  return { FAMILIES, familyOf, seedOf, rng, hslToRgb, paletteFor, makeNoise, fbm,
           nebulaDensity, skyDust, skyStars, grainTile, regionExtent };
});
