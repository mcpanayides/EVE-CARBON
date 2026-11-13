// Performance mode in a secondary window: the widget pop-outs, Early Warning and
// the ping alert. The main window's own handling is func/perf_mode.js.
//
// The page's pre-paint script sets body.perf-mode from the launch argument (main
// passes --perf-mode, the preload exposes it) and leaves glass off with it. This
// follows a change made in Settings while the window is open: performance.css
// does the rest, and glass comes back with Quality only if the saved glass
// settings have it on. The window's acrylic material is main's job
// (applyWidgetGlass), on the same broadcast.
(function () {
  function glassSaved() {
    try {
      var g = JSON.parse(localStorage.getItem('eve-glass') || 'null');
      return !g || g.enabled !== false;
    } catch (e) { return true; }
  }
  function apply(mode) {
    if (!document.body) return;
    var on = mode === 'performance';
    document.body.classList.toggle('perf-mode', on);
    document.body.classList.toggle('glass-on', !on && glassSaved());
  }
  if (window.eveAPI && typeof window.eveAPI.on === 'function') window.eveAPI.on('performance-mode', apply);
})();
