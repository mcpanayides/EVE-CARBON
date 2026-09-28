// anim_idle.js — stop animating when nobody is looking at the window.
//
// Loaded as a plain <script> by every window that can end up behind a game:
// the main window, the floating intel widget and the dashboard pop-outs.
//
// ── Why ───────────────────────────────────────────────────────────────────────
//
// A CSS animation with `infinite` never stops. Two of ours run for the whole
// session — the kill ticker and the market ticker, both 120s loops — and each
// one keeps the renderer producing frames forever, whether or not anything is
// on screen to see them.
//
// That is cheap on a desktop and expensive behind a game. The main window sits
// underneath a fullscreen client for an entire fleet op, still animating, and
// every frame it produces is another pass through the desktop compositor. The
// window is invisible the whole time.
//
// Chromium already knows when that has happened: native occlusion tracking is
// what drives Electron's backgroundThrottling, and it flips visibilityState to
// 'hidden' when a window is fully covered, minimised or hidden. So the signal
// is free — it just was not wired to anything.
//
// Pausing is deliberately blunt: EVERY animation stops, not a curated list, so
// a new one added later is covered without anybody having to remember this
// file. `animation-play-state` freezes an animation in place rather than
// cancelling it, so a paused spinner resumes mid-spin instead of jumping.
(function () {
  if (typeof document === 'undefined' || !document.documentElement) return;

  const root  = document.documentElement;
  const apply = () => {
    // Guard the whole thing: a window that somehow reports no visibility state
    // should keep animating, not freeze solid.
    const hidden = document.visibilityState === 'hidden';
    root.classList.toggle('anim-idle', hidden);
  };

  document.addEventListener('visibilitychange', apply);
  apply();
})();
