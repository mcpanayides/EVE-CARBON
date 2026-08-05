// ─── app_ident.js ─────────────────────────────────────────────────────────────
// Main-process view of the shared ESI client (src/shared/esi.js).
//
// This file used to hold its own copies of the identity string and the
// compatibility date, and src/utils.js and src/html/ping-alert.html held theirs.
// Three copies of a value that must agree is a value that eventually does not:
// ping-alert.html sent X-User-Agent but never X-Compatibility-Date, so that
// window was talking to a different snapshot of ESI than the rest of the app and
// nothing anywhere failed to say so.
//
// The definitions now live in src/shared/esi.js — one base URL, one date, one
// identity — and this re-exports them under the names the main process already
// imports. Change them THERE.
//
// Identity per ESI best practices
// (https://developers.eveonline.com/docs/services/esi/best-practices/):
// app name + version, a contact email, and the source repository. CCP uses this
// to reach us instead of banning when something misbehaves — which is exactly
// how both the Fuzzwork 404 flood and this review reached us.
// ──────────────────────────────────────────────────────────────────────────────

const { version } = require('../package.json');
const Esi = require('./shared/esi');

// The renderer asks for the version over IPC; here it comes off package.json.
Esi.setVersion(version);

const APP_USER_AGENT = Esi.userAgent();
const APP_CONTACT    = Esi.CONTACT;
const APP_SOURCE     = Esi.SOURCE;

// ESI is moving from per-route versions (/v4/, /v6/…) to a single
// X-Compatibility-Date header — see the blog post linked in src/shared/esi.js.
// Pinned, never `new Date()`: computing it daily would silently re-adopt
// whatever ESI does next and defeat the entire point of pinning.
const ESI_COMPATIBILITY_DATE = Esi.COMPAT_DATE;

module.exports = {
  APP_USER_AGENT, APP_CONTACT, APP_SOURCE, ESI_COMPATIBILITY_DATE,
  // Preferred for new code: Esi.url('/characters/…') builds an unversioned URL,
  // Esi.headers({ token }) the full header set.
  Esi,
  ESI_BASE: Esi.BASE,
};
