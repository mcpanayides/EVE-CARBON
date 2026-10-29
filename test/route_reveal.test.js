// A plotted route drawing itself in (src/func/route-reveal.js): about 1.2 s a
// hop on a short route, never more than 15 s however long, each hop eased out
// of one system and into the next, and jump arcs growing along their own path.
const test = require('node:test');
const assert = require('node:assert/strict');
const RouteReveal = require('../src/func/route-reveal.js');

const s = (ms) => ms / 1000;

test('a short route keeps the pace of a hop; a long one quickens, and never passes 15 s', () => {
  assert.ok(Math.abs(s(RouteReveal.durationMs(1)) - 1.2) < 0.1, `one hop: ${s(RouteReveal.durationMs(1))} s`);
  assert.ok(Math.abs(s(RouteReveal.durationMs(2)) - 2.4) < 0.25, 'two hops: two or so seconds');
  const ten = s(RouteReveal.durationMs(10));
  assert.ok(ten > 7 && ten < 10, `ten hops in eight or so: ${ten} s`);
  // 1DQ1-A to Jita by gates is 42 jumps.
  const long = s(RouteReveal.durationMs(42));
  assert.ok(long > 13 && long < 15, `a 42-jump gate route: ${long} s`);
  assert.ok(s(RouteReveal.durationMs(5000)) <= 15, 'and nothing, however long, past 15 s');
  let last = 0;
  for (let n = 1; n <= 200; n++) {
    const d = RouteReveal.durationMs(n);
    assert.ok(d > last, 'a longer route never draws in faster');
    assert.ok(d / n <= 1200 + 1e-6, 'and no hop ever takes longer than 1.2 s');
    last = d;
  }
  assert.equal(RouteReveal.durationMs(0), 0, 'no hops, nothing to draw');
});

test('every hop gets the same share of the time, and eases in and out of its systems', () => {
  const total = RouteReveal.durationMs(4), hop = total / 4;
  assert.deepEqual(RouteReveal.progress(0, total, 4), { hop: 0, t: 0, done: false });
  assert.equal(RouteReveal.progress(hop * 1.5, total, 4).hop, 1);
  assert.ok(Math.abs(RouteReveal.progress(hop * 1.5, total, 4).t - 0.5) < 1e-9, 'halfway through a hop, halfway along it');
  assert.equal(RouteReveal.progress(hop * 3.999, total, 4).hop, 3);
  assert.deepEqual(RouteReveal.progress(total, total, 4), { hop: 4, t: 0, done: true });
  assert.equal(RouteReveal.progress(total * 2, total, 4).done, true);
  // Gentle at both ends of a hop: slow to leave, slow to arrive.
  assert.ok(RouteReveal.ease(0.1) < 0.02 && RouteReveal.ease(0.9) > 0.98);
  assert.equal(RouteReveal.ease(0), 0);
  assert.equal(RouteReveal.ease(1), 1);
  // Systems are reached at the end of each hop.
  assert.equal(RouteReveal.arrivalMs(0, total, 4), 0);
  assert.ok(Math.abs(RouteReveal.arrivalMs(4, total, 4) - total) < 1e-9);
});

test('a jump arc grows along its own path, bowed as the map draws it', () => {
  // The arc's control point: 18% of the jump's length off to one side, at most 140 px.
  const [cx, cy] = RouteReveal.jumpArc(0, 0, 100, 0);
  assert.ok(Math.abs(cx - 50) < 1e-9 && Math.abs(cy - 18) < 1e-9);
  assert.ok(Math.abs(RouteReveal.jumpArc(0, 0, 2000, 0)[1] - 140) < 1e-9, 'capped on a long jump');
  // Any part of it, drawn as its own shorter curve, lies exactly on the whole.
  const quad = (a, c, b, t) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;
  const [ax, ay, bx, by] = [10, 20, 310, -40];
  const [qx, qy] = RouteReveal.jumpArc(ax, ay, bx, by);
  for (const t of [0.2, 0.5, 0.85, 1]) {
    const [px, py, ex, ey] = RouteReveal.partialQuad(ax, ay, qx, qy, bx, by, t);
    for (const u of [0, 0.3, 0.7, 1]) {
      const sx = quad(ax, px, ex, u), sy = quad(ay, py, ey, u);
      const wx = quad(ax, qx, bx, t * u), wy = quad(ay, qy, by, t * u);
      assert.ok(Math.hypot(sx - wx, sy - wy) < 1e-9, `on the arc at t=${t}, u=${u}`);
    }
  }
});
