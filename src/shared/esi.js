// esi.js — THE one place that knows how to talk to ESI.
//
// Loaded by BOTH processes:
//   • main    — `require('./shared/esi')` (src/app_ident.js re-exports it, so the
//               existing APP_USER_AGENT / ESI_COMPATIBILITY_DATE imports still work)
//   • renderer— a <script> tag; attaches window.Esi, used by the fetch wrapper in
//               src/utils.js and by src/html/ping-alert.html
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// CCP's developer relations reviewed this repo and made two points, both fair:
//
//   1. `const ESI_BASE = 'https://esi.evetech.net'` was declared in EIGHT files,
//      with full URLs hard-coded in a dozen more. Changing anything about how we
//      reach ESI meant finding every copy.
//
//   2. The identity plumbing was duplicated the same way — and it had already
//      drifted. The compatibility date was written out in three places, and
//      src/html/ping-alert.html sent X-User-Agent but NOT X-Compatibility-Date,
//      so that window was quietly talking to a different snapshot of the API
//      than the rest of the app. Nothing failed; it just silently disagreed.
//
// So: one base, one date, one identity string, one place to change them.
//
// ── Versioned routes are the deprecated way ─────────────────────────────────
//
// Per developers.eveonline.com/blog/changing-versions-v42-was-getting-out-of-hand,
// `/vN/` paths are superseded by unversioned paths plus an X-Compatibility-Date
// header, which says "give me the API as it behaved on this date". Existing
// versioned routes keep working "for the foreseeable future", but every NEW
// route CCP ships is unversioned-only — so staying on /vN/ is a slow-motion
// breakage with no fixed date attached to it.
//
// The concrete cost of the old way, from this very codebase: fetching a
// character's fittings looped over ['v2', 'v1'] and treated a 404 as "wrong
// guess, try the other one", because the route's version had changed underneath
// us. Under a compatibility date that entire dance is one call.
//
// ── The date is pinned, not `today` ────────────────────────────────────────
//
// COMPAT_DATE is a tested behaviour snapshot. Bumping it is a deliberate act:
// re-verify the payload shapes we parse, then change it HERE — one edit that
// every window picks up.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Esi = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const BASE = 'https://esi.evetech.net';

  // A deliberately-tested snapshot of ESI behaviour — never "whatever today is".
  // CCP keeps at least a year of backwards compatibility and rejects future
  // dates (the day rolls at 11:00 UTC).
  const COMPAT_DATE = '2026-07-20';

  const CONTACT = 'miachristinapanayides@gmail.com';
  const SOURCE  = 'https://github.com/mcpanayides/EVE-CARBON';

  // Set once at startup: main reads it from package.json, the renderer asks over
  // IPC. Until then requests still identify us, just without a version.
  let _version = 'dev';
  const setVersion = (v) => { if (v) _version = String(v); };
  const userAgent  = () => `EVE-Carbon/${_version} (${CONTACT}; +${SOURCE})`;

  const isEsi = (url) => /(^|\/\/)esi\.evetech\.net/i.test(String(url || ''));

  /**
   * Build an ESI URL from an UNVERSIONED path.
   *
   *   url('/characters/123/wallet/')        -> …/characters/123/wallet/?datasource=tranquility
   *   url('/markets/10000002/history/', { type_id: 34 })
   *
   * Passing a `/vN/` path still works — it just leaves you on the deprecated
   * scheme, which is what this module exists to move away from.
   */
  function url(path, params) {
    const p = String(path || '').replace(/^\/+/, '');
    const q = new URLSearchParams({ datasource: 'tranquility', ...(params || {}) });
    return `${BASE}/${p}${p.includes('?') ? '&' : '?'}${q.toString()}`;
  }

  /**
   * The headers every ESI request needs.
   *
   * `renderer: true` swaps User-Agent for X-User-Agent — Chromium silently drops
   * User-Agent overrides on fetch(), and X-User-Agent is ESI's documented
   * fallback for exactly that case. Getting this wrong makes us anonymous to
   * CCP, which is how an app ends up blocked rather than contacted.
   */
  function headers({ token, renderer = false, extra } = {}) {
    const h = { 'X-Compatibility-Date': COMPAT_DATE, ...(extra || {}) };
    h[renderer ? 'X-User-Agent' : 'User-Agent'] = userAgent();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  return { BASE, COMPAT_DATE, CONTACT, SOURCE, setVersion, userAgent, url, headers, isEsi };
});
