// The map's own region nebulae and skybox: which family a region's SDE skybox
// belongs to, the colours that follow, and the clouds - deterministic, wispy,
// fading to nothing at their edges, and a sky that wraps without a seam.
const test = require('node:test');
const assert = require('node:assert/strict');
const Nebula = require('../src/func/nebula.js');

// Real graphicFile paths from the SDE's graphics.jsonl (build 3654997).
const GENESIS = 'res:/dx9/scene/Universe/a01_cube.red';
const CITADEL = 'res:/dx9/scene/Universe/c01_cube.red';
const PLACID  = 'res:/dx9/scene/Universe/g05_cube.red';
const METRO   = 'res:/dx9/scene/Universe/m01_cube.red';

test('reads the family and number off every shape of SDE skybox path', () => {
  assert.deepEqual(Nebula.familyOf(GENESIS), { family: 'a', index: 1, key: 'a01' });
  assert.deepEqual(Nebula.familyOf('res:/dx9/scene/Universe/c19_cube.red'), { family: 'c', index: 19, key: 'c19' });
  assert.deepEqual(Nebula.familyOf('res:/dx9/scene/Universe/y01_cube.red'), { family: 'y', index: 1, key: 'y01' });
  assert.deepEqual(Nebula.familyOf('res:/dx9/Scene/Wormholes/wormhole_class_03.red'), { family: 'w', index: 3, key: 'w03' });
  assert.deepEqual(Nebula.familyOf('res:/dx9/scene/abyssal/ad02_B_cube.red'), { family: 'x', index: 22, key: 'x02B' });
  assert.equal(Nebula.familyOf(null), null);
  assert.equal(Nebula.familyOf('res:/dx9/model/ship/rifter.red'), null);
});

test('each family paints in its own colours', () => {
  const core = (file) => Nebula.paletteFor(Nebula.familyOf(file)).core;
  const [ar, ag, ab] = core(GENESIS), [cr, , cb] = core(CITADEL), [gr, gg] = core(PLACID), [mr, mg, mb] = core(METRO);
  assert.ok(ar > ab && ag > ab, `Amarr side is gold: ${core(GENESIS)}`);
  assert.ok(cb > cr, `Caldari side is blue: ${core(CITADEL)}`);
  assert.ok(gg > gr, `Gallente side is green: ${core(PLACID)}`);
  assert.ok(mr > mg && mr > mb, `Minmatar side is rust: ${core(METRO)}`);
});

test('neighbours in a family are related, not identical', () => {
  const hue = (file) => {
    const [r, g, b] = Nebula.paletteFor(Nebula.familyOf(file)).core.map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const kador = 'res:/dx9/scene/Universe/a02_cube.red', domain = 'res:/dx9/scene/Universe/a03_cube.red';
  assert.ok(Math.abs(hue(kador) - hue(domain)) <= 20, 'same family, near hues');
  assert.notDeepEqual(Nebula.nebulaDensity('a02', 48), Nebula.nebulaDensity('a03', 48), 'their own clouds');
});

test('a cloud is the same every time, wispy, and fades out before its edge', () => {
  const N = 64;
  const d = Nebula.nebulaDensity('c02', N);
  assert.deepEqual(d, Nebula.nebulaDensity('c02', N), 'deterministic');
  let mass = 0, edge = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = d[j * N + i];
      assert.ok(v >= 0 && v <= 1);
      mass += v;
      if (i === 0 || j === 0 || i === N - 1 || j === N - 1) edge += v;
    }
  }
  assert.equal(edge, 0, 'nothing on the border, so it blends rather than tiles');
  assert.ok(mass / (N * N) > 0.03, 'and something in the middle');
});

test('the skybox dust wraps left to right without a seam', () => {
  const w = 128, h = 32, d = Nebula.skyDust(7, w, h);
  // Across the wrap should differ no more than any neighbouring columns do.
  let seam = 0, inner = 0;
  for (let j = 0; j < h; j++) {
    seam = Math.max(seam, Math.abs(d[j * w + (w - 1)] - d[j * w]));
    for (let i = 1; i < w; i++) inner = Math.max(inner, Math.abs(d[j * w + i] - d[j * w + i - 1]));
  }
  assert.ok(seam <= inner, `seam ${seam} vs largest step ${inner}`);
});

test('film grain is bell-shaped round mid-grey - so on average it changes nothing', () => {
  const g = Nebula.grainTile(0x5eed, 128);
  assert.deepEqual(g, Nebula.grainTile(0x5eed, 128), 'the same tile every time');
  let sum = 0, sq = 0, mid = 0;
  for (const v of g) { sum += v; sq += v * v; if (Math.abs(v - 128) < 37) mid++; }
  const mean = sum / g.length, sd = Math.sqrt(sq / g.length - mean * mean);
  assert.ok(Math.abs(mean - 128) < 2, `centred on mid-grey: ${mean}`);
  // The spread is tuned by eye (~21 levels, 2026-10-29): wide enough to read as
  // grain, narrow enough to stay fine. Bounds, not the exact figure, so a nudge
  // to the look does not fail the build.
  assert.ok(sd > 10 && sd < 60, `a real spread, not static: sd ${sd}`);
  assert.ok(mid / g.length > 0.6, 'most of it near the middle, like grain, not flat noise');
});

test('a region sits at the mean of its systems, sized by the 85th percentile', () => {
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push({ x: i, y: 0, z: 0 });
  pts.push({ x: 1000, y: 0, z: 0 });                     // one far-flung system
  const e = Nebula.regionExtent(pts);
  assert.ok(Math.abs(e.x - (190 + 1000) / 21) < 1e-9);
  assert.ok(e.r < 200, `one outlier does not blow the region up: ${e.r}`);
  assert.equal(Nebula.regionExtent([]), null);
});
