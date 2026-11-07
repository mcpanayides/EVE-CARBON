// tutorial_model.js — the pure half of the tutorial.
//
// Loaded by the renderer as a <script> tag (window.TutorialModel) and by the
// unit tests through require(). Everything here is arithmetic and decisions:
// when the tour opens on its own, which of its steps apply right now, how they
// are counted, and where the spotlight, the click blockers and the card go. The
// tour engine (func/tutorial.js) measures the page and hands this rectangles,
// which is what lets all of it be tested without Electron. What an alliance
// pack offers is src/shared/alliance_pack.js.
//
// A rectangle is { left, top, width, height } in window pixels.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TutorialModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Whether the basic tour opens by itself at launch.
   *
   * First launch means never seen AND no characters yet. Someone upgrading with
   * a roster has an app that is already set up and did not ask for a tour, and
   * a tour that has been seen once, finished or not, is never forced again.
   * Demo mode exists for capture and never opens it unasked; neither does an
   * e2e run (`suppress`), where it would sit over every test that removes its
   * last character and reloads.
   */
  function shouldAutoStart({ state, accountCount, demo, suppress } = {}) {
    if (demo || suppress) return false;
    if (state && state.seen) return false;
    return !(Number(accountCount) > 0);
  }

  // A step applies unless its `when(ctx)` says otherwise. Asked fresh every time:
  // what a tour shows depends on what has happened in it (a character added, a
  // widget placed), so it cannot be decided once at the start.
  function applies(step, ctx) {
    if (!step) return false;
    try { return typeof step.when === 'function' ? !!step.when(ctx) : true; }
    catch (_) { return false; }
  }

  /** The next applicable step from `from` in direction `dir` (+1 or -1), or -1. */
  function nextIndex(steps, from, dir, ctx) {
    const list = Array.isArray(steps) ? steps : [];
    for (let i = from + dir; i >= 0 && i < list.length; i += dir) {
      if (applies(list[i], ctx)) return i;
    }
    return -1;
  }

  /**
   * How far through the tour step `index` is, for the card's counter and bar.
   *
   * Only steps with a `chapter` are counted: the welcome and closing cards frame
   * the tour rather than being part of it. `n of of` counts within the current
   * chapter, because a long flat count reads as a chore, while a chapter of
   * three says how much of this part is left. `segments` lists every counted
   * step, in order, for the progress bar.
   *
   * The total must not jump about while someone is in a chapter, so a step is
   * counted when it is the current one, when it has been `visited`, or, if it
   * is still ahead, when it is expected: `countWhen(ctx)` where a step has one
   * (a step that only appears after something else happens, counted unless that
   * something was skipped), otherwise its `when`. A step behind that was never
   * visited was skipped and is not counted.
   */
  function progress(steps, index, ctx, visited) {
    const seen = visited instanceof Set ? visited : new Set(visited || []);
    const expected = (s) => {
      try { return typeof s.countWhen === 'function' ? !!s.countWhen(ctx) : applies(s, ctx); }
      catch (_) { return false; }
    };
    const list = (Array.isArray(steps) ? steps : [])
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s && s.chapter
        && (i === index || seen.has(i) || (i > index && expected(s))));
    const at = list.findIndex(({ i }) => i === index);
    if (at < 0) return null;
    const chapter = list[at].s.chapter;
    const inChapter = list.filter(({ s }) => s.chapter === chapter);
    return {
      chapter,
      n: inChapter.findIndex(({ i }) => i === index) + 1,
      of: inChapter.length,
      position: at,
      segments: list.map(({ s, i }) => ({ chapter: s.chapter, state: i < index ? 'done' : i === index ? 'current' : 'todo' })),
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /**
   * The spotlight: the union of the target rectangles, padded, kept inside the
   * viewport. Several targets make one hole, so a button and the menu it opens
   * can be lit together. Zero-sized rectangles (hidden elements) are ignored;
   * nothing visible gives null, and the card is then shown on its own.
   */
  function holeRect(rects, pad, vp) {
    const rs = (rects || []).filter(r => r && r.width > 0 && r.height > 0);
    if (!rs.length) return null;
    const p = Number(pad) || 0;
    const left   = Math.max(vp.left, Math.min(...rs.map(r => r.left)) - p);
    const top    = Math.max(vp.top,  Math.min(...rs.map(r => r.top)) - p);
    const right  = Math.min(vp.left + vp.width,  Math.max(...rs.map(r => r.left + r.width)) + p);
    const bottom = Math.min(vp.top + vp.height,  Math.max(...rs.map(r => r.top + r.height)) + p);
    if (right <= left || bottom <= top) return null;
    return { left, top, width: right - left, height: bottom - top };
  }

  /**
   * The four panels around the hole that dim the page and take its clicks.
   * Clicks inside the hole reach the real control underneath; everything else
   * is held, so the tour keeps the user on the thing it is talking about. With
   * no hole, one panel covers the whole viewport.
   */
  function blockers(hole, vp) {
    if (!hole) return [{ left: vp.left, top: vp.top, width: vp.width, height: vp.height }];
    const right = hole.left + hole.width, bottom = hole.top + hole.height;
    const vRight = vp.left + vp.width, vBottom = vp.top + vp.height;
    return [
      { left: vp.left, top: vp.top,  width: vp.width,          height: hole.top - vp.top },   // above
      { left: vp.left, top: bottom,  width: vp.width,          height: vBottom - bottom },    // below
      { left: vp.left, top: hole.top, width: hole.left - vp.left, height: hole.height },      // left
      { left: right,   top: hole.top, width: vRight - right,   height: hole.height },         // right
    ].map(r => ({ ...r, width: Math.max(0, r.width), height: Math.max(0, r.height) }));
  }

  /**
   * Where the card sits relative to the hole.
   *
   * Takes the first side in `order` with room for the whole card; failing that,
   * whichever side has the most room. Always kept `margin` inside the viewport.
   * `arrow` is how far along the card's facing edge its pointer goes, aimed at
   * the hole's centre but kept off the rounded corners. No hole centres the card.
   */
  function placeCard(hole, card, vp, opts = {}) {
    const gap = opts.gap ?? 14, margin = opts.margin ?? 16;
    const order = opts.order || ['right', 'bottom', 'top', 'left'];
    const w = card.width, h = card.height;
    const centred = {
      left: Math.round(vp.left + (vp.width - w) / 2),
      top:  Math.round(vp.top + (vp.height - h) / 2),
      side: 'center', arrow: null,
    };
    if (!hole) return centred;

    const room = {
      right:  vp.left + vp.width - (hole.left + hole.width) - margin,
      left:   hole.left - vp.left - margin,
      bottom: vp.top + vp.height - (hole.top + hole.height) - margin,
      top:    hole.top - vp.top - margin,
    };
    const need = { right: w + gap, left: w + gap, bottom: h + gap, top: h + gap };
    let side = order.find(s => room[s] >= need[s]);
    if (!side) side = Object.keys(room).sort((a, b) => room[b] - room[a])[0];

    const cx = hole.left + hole.width / 2, cy = hole.top + hole.height / 2;
    let left, top;
    if (side === 'right')       { left = hole.left + hole.width + gap; top = cy - h / 2; }
    else if (side === 'left')   { left = hole.left - gap - w;          top = cy - h / 2; }
    else if (side === 'bottom') { top = hole.top + hole.height + gap;  left = cx - w / 2; }
    else                        { top = hole.top - gap - h;            left = cx - w / 2; }

    left = clamp(left, vp.left + margin, vp.left + vp.width - margin - w);
    top  = clamp(top,  vp.top + margin,  vp.top + vp.height - margin - h);
    const arrow = (side === 'right' || side === 'left')
      ? clamp(cy - top, 18, h - 18)
      : clamp(cx - left, 18, w - 18);
    return { left: Math.round(left), top: Math.round(top), side, arrow: Math.round(arrow) };
  }

  /** True when two rectangles (or two nulls) are the same to within half a pixel. */
  function sameRect(a, b) {
    if (!a || !b) return a === b;
    return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5
        && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
  }

  return {
    shouldAutoStart,
    applies, nextIndex, progress, holeRect, blockers, placeCard, sameRect,
  };
});
