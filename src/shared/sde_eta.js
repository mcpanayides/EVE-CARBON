// sde_eta.js — how far along an SDE update is, and how long it has left.
//
// Loaded by the renderer as a <script> tag (window.SdeEta) and by the unit tests
// through require(). Pure: it is handed the progress events main sends
// ('sde-update-progress': { phase, stage, percent, downloaded, total, step,
// label }) and the time, and answers with a percentage and an estimate.
//
// WHY THE ESTIMATE IS MOSTLY THE BUILD
//
// Timed on a real update (build 3670638, 2026-11-08): 120 s in all, and the
// 94.7 MB download was only 17 s of it. Unpacking took 4 s and building the
// database 98 s, two thirds of that in two steps: item attributes (40 s) and
// the planets, moons and stargates table (37 s). A download-only estimate would
// have said "17 seconds left" for something with two minutes to go. So the
// estimate always carries the rest of the job, from those measured shares, and
// rescales them by how fast this machine turns out to be once steps finish.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SdeEta = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Measured on the update above, on a fast desktop. Only a starting point:
  // the build's share is rescaled by this machine's own speed as steps finish.
  const EXTRACT_MS = 4000;
  const BUILD_MS   = 98000;

  // Each build step's share of the build, from the same run. Matched on how
  // the step's label starts (src/sde_build.js); a step not listed here counts
  // as 1%, so a new step costs some accuracy rather than breaking anything.
  const BUILD_STEPS = [
    ['Creating schema',              0.003],
    ['Loading lookup maps',          0.027],
    ['Populating invCategories',     0.002],
    ['Populating invTypes',          0.069],
    ['Populating invTraits',         0.003],
    ['Populating invTypeMaterials',  0.026],
    ['Populating dgmTypeAttributes', 0.409],
    ['Populating planetSchematics',  0.001],
    ['Populating dgmEffects',        0.002],
    ['Populating blueprints',        0.037],
    ['Populating mapRegions',        0.009],
    ['Deriving mapSolarSystemJumps', 0.009],
    ['Populating mapDenormalize',    0.372],
    ['Populating staStations',       0.004],
    ['Appending stations',           0.004],
    ['Creating indexes',             0.023],
  ];
  const UNKNOWN_STEP = 0.01;

  // Before this long of downloading, or this much data, a rate is noise.
  const MIN_RATE_MS = 1500;
  const MIN_RATE_BYTES = 512 * 1024;

  function stepShare(label) {
    const hit = BUILD_STEPS.find(([start]) => String(label || '').startsWith(start));
    return hit ? hit[1] : UNKNOWN_STEP;
  }

  /**
   * One update's progress. `update(evt, now)` takes each progress event;
   * `snapshot(now)` can be asked at any time, so the estimate keeps moving
   * through a long step that sends nothing.
   */
  function create({ extractMs = EXTRACT_MS, buildMs = BUILD_MS } = {}) {
    const s = {
      startedAt: null, phase: 'check', phaseAt: null,
      downloaded: 0, total: 0, firstByteAt: null, rate: 0, rateAt: null, rateBytes: 0,
      buildDone: 0,                // share of the build in finished steps
      buildDoneMs: 0,              // how long those finished steps took here
      step: 0, stepShare: 0, stepAt: null, steps: BUILD_STEPS.length,
      speed: 1,                    // this machine's build time / the measured one
      percent: 0,
    };

    function update(evt, now) {
      if (s.startedAt == null) s.startedAt = now;
      const phase = (evt && evt.phase) || s.phase;
      if (phase !== s.phase) {
        if (s.phase === 'build' && s.stepAt != null) closeStep(now);
        // Unpacking is the same kind of work as the build (disk, then CPU), so
        // how long it took here is the first guess at this machine's speed. The
        // build's own steps replace the guess once enough of them have run.
        if (s.phase === 'extract' && s.phaseAt != null) {
          s.speed = Math.max(0.5, Math.min(5, (now - s.phaseAt) / extractMs));
        }
        s.phase = phase;
        s.phaseAt = now;
      } else if (s.phaseAt == null) s.phaseAt = now;

      if (phase === 'download') {
        const got = Number(evt.downloaded) || 0;
        if (Number(evt.total) > 0) s.total = Number(evt.total);
        if (got > 0 && s.firstByteAt == null) { s.firstByteAt = now; s.rateAt = now; s.rateBytes = got; }
        // A smoothed rate: one slow second shouldn't swing the estimate by a minute.
        if (s.rateAt != null && now - s.rateAt >= 250 && got > s.rateBytes) {
          const inst = (got - s.rateBytes) / ((now - s.rateAt) / 1000);
          s.rate = s.rate ? s.rate * 0.7 + inst * 0.3 : inst;
          s.rateAt = now; s.rateBytes = got;
        }
        s.downloaded = got;
      } else if (phase === 'build' && evt && evt.label && /\.\.\.$/.test(evt.label)) {
        // A new step: the one before it is finished.
        if (s.stepAt != null) closeStep(now);
        s.step = evt.step || s.step + 1;
        s.stepShare = stepShare(evt.label);
        s.stepAt = now;
      }
      return snapshot(now);
    }

    function closeStep(now) {
      s.buildDone += s.stepShare;
      s.buildDoneMs += now - s.stepAt;
      s.stepAt = null;
      // Once enough of the build has run to say anything, rescale the rest by it.
      if (s.buildDone >= 0.05) s.speed = Math.max(0.2, Math.min(10, s.buildDoneMs / (s.buildDone * buildMs)));
    }

    function buildLeftMs(now) {
      const total = buildMs * s.speed;
      if (s.phase !== 'build') return total;
      let done = s.buildDone;
      if (s.stepAt != null) {
        // Inside a step that reports nothing until it ends, count it done in
        // proportion to its expected time, up to 90%: an overrun holds the
        // estimate rather than letting it reach zero and sit there.
        const expected = s.stepShare * total;
        done += s.stepShare * Math.min(0.9, expected > 0 ? (now - s.stepAt) / expected : 0);
      }
      return Math.max(0, (1 - Math.min(1, done)) * total);
    }

    /** { phase, percent, etaMs (null while unknown), downloaded, total, step, steps } */
    function snapshot(now) {
      let etaMs = null;
      const inPhase = s.phaseAt != null ? now - s.phaseAt : 0;
      if (s.phase === 'download') {
        const enough = s.firstByteAt != null && now - s.firstByteAt >= MIN_RATE_MS && s.downloaded >= MIN_RATE_BYTES;
        if (enough && s.rate > 0 && s.total > 0) {
          etaMs = Math.max(0, s.total - s.downloaded) / s.rate * 1000 + extractMs + buildLeftMs(now);
        }
      } else if (s.phase === 'extract') {
        etaMs = Math.max(500, extractMs - inPhase) + buildLeftMs(now);
      } else if (s.phase === 'build') {
        etaMs = buildLeftMs(now);
      } else if (s.phase === 'finish') {
        etaMs = 500;
      } else if (s.phase === 'done') {
        etaMs = 0;
      }
      // The bar is time-based, elapsed against elapsed-plus-remaining, so it
      // agrees with the estimate; it never moves backwards.
      if (s.phase === 'done') s.percent = 100;
      else if (etaMs != null && s.startedAt != null) {
        const elapsed = now - s.startedAt;
        const p = Math.min(99, (elapsed / Math.max(1, elapsed + etaMs)) * 100);
        if (p > s.percent) s.percent = p;
      }
      return {
        phase: s.phase, percent: Math.round(s.percent), etaMs,
        downloaded: s.downloaded, total: s.total, step: s.step, steps: s.steps,
      };
    }

    return { update, snapshot };
  }

  /** "About 1 min 20 s left": rounded so it doesn't flicker every second. */
  function formatEta(ms) {
    if (ms == null) return 'Working out the time left…';
    const s = Math.round(ms / 1000);
    if (s < 10) return 'Almost done';
    if (s < 60) return `About ${Math.round(s / 5) * 5} s left`;
    if (s < 600) {
      const r = Math.round(s / 10) * 10;
      const m = Math.floor(r / 60), sec = r % 60;
      return sec ? `About ${m} min ${sec} s left` : `About ${m} min left`;
    }
    return `About ${Math.round(s / 60)} min left`;
  }

  /** 99,331,072 bytes → "94.7 MB" */
  function formatMB(bytes) {
    return `${(Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1)} MB`;
  }

  return { create, formatEta, formatMB, stepShare, BUILD_STEPS, EXTRACT_MS, BUILD_MS };
});
