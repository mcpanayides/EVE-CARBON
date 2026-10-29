// ─── route-reveal.js — a plotted route drawing itself in, hop by hop ─────────
// No DOM, no globals: unit-testable under Node (`node --test`) and reused in the
// browser via window.RouteReveal. Loaded as a plain <script> before map.js,
// which owns the canvas and does the drawing.
//
// A route that simply appears says nothing about its shape: which way it runs,
// where it doubles back, which hop is the long one. Drawn in from its start, it
// reads as the journey it is - each hop eases out of one system and settles
// into the next, and the eye is carried all the way to the destination.
//
// TIMING
//
// About 1.2 s a hop on a short route, and never more than 15 s however long
// the route: a 42-jump gate route at 1.2 s a hop would take most of a minute.
// The whole takes 15 s x (1 - e^(-1.2 n / 15)) for n hops - 1.2 s for one,
// 2.2 s for two, 8 s for ten, 14.5 s for forty - so a short route keeps the
// pace of a hop and a long one only quickens as it nears the cap.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node / tests
  if (typeof window !== 'undefined') window.RouteReveal = api;                 // renderer
})(this, function () {
  'use strict';

  const PACE = {
    perHop: 1.2,   // s a hop takes on a short route
    cap:    15,    // s the whole route may take at most
  };

  /** How long a route of `hops` jumps takes to draw in, in ms. */
  function durationMs(hops) {
    if (!(hops > 0)) return 0;
    return 1000 * PACE.cap * (1 - Math.exp(-PACE.perHop * hops / PACE.cap));
  }

  /** Ease in and out (cubic): a hop leaves its system gently and settles into the next. */
  function ease(u) {
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  }

  /**
   * Where a reveal is, `elapsed` ms into `total`: how many hops are complete,
   * and how far along the current one it has got, eased 0..1. Every hop gets
   * the same share of the time - a hop is one jump, whatever its length on screen.
   */
  function progress(elapsed, total, hops) {
    if (!(hops > 0) || !(total > 0) || elapsed >= total) return { hop: Math.max(0, hops), t: 0, done: true };
    const x = (Math.max(0, elapsed) / total) * hops;
    const hop = Math.min(hops - 1, Math.floor(x));
    return { hop, t: ease(x - hop), done: false };
  }

  /** When system `k` of the route is reached, in ms from the start (system 0 at once). */
  function arrivalMs(k, total, hops) {
    return hops > 0 ? (total * k) / hops : 0;
  }

  /**
   * The arc a capital jump is drawn with, from a to b: bowed out to one side by
   * 18% of its length, never more than 140 px. Returns the control point.
   */
  function jumpArc(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const h = Math.min(len * 0.18, 140);
    return [(ax + bx) / 2 + (-dy / len) * h, (ay + by) / 2 + (dx / len) * h];
  }

  /**
   * The first stretch of a quadratic curve a -> b bent through c, up to t: the
   * control point and end of the shorter curve that traces exactly that part
   * (de Casteljau), so a growing jump arc stays on its own path.
   */
  function partialQuad(ax, ay, cx, cy, bx, by, t) {
    const qx = ax + (cx - ax) * t, qy = ay + (cy - ay) * t;
    const rx = cx + (bx - cx) * t, ry = cy + (by - cy) * t;
    return [qx, qy, qx + (rx - qx) * t, qy + (ry - qy) * t];
  }

  return { PACE, durationMs, ease, progress, arrivalMs, jumpArc, partialQuad };
});
