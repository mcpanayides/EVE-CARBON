// ─── app_ident.js ─────────────────────────────────────────────────────────────
// ONE identity string for every outbound request, per ESI best practices
// (https://developers.eveonline.com/docs/services/esi/best-practices/):
// app name + version, a contact email, and the source repository. CCP uses
// this to reach us instead of banning when something misbehaves — never send
// an anonymous or stale User-Agent again.
//
// Main process: require this and use APP_USER_AGENT for the User-Agent header.
// Renderer: Chromium drops User-Agent overrides — send the same string as the
// X-User-Agent header instead (see the fetch wrapper in src/utils.js).
// ──────────────────────────────────────────────────────────────────────────────

const { version } = require('../package.json');

const APP_CONTACT = 'miachristinapanayides@gmail.com';
const APP_SOURCE  = 'https://github.com/mcpanayides/EVE-CARBON';

const APP_USER_AGENT = `EVE-Carbon/${version} (${APP_CONTACT}; +${APP_SOURCE})`;

// ESI is moving from per-route versions (/v4/, /v6/...) to a single
// X-Compatibility-Date header (see https://developers.eveonline.com/blog/
// changing-versions-v42-was-getting-out-of-hand) — "you now version your
// entire application against ESI at a specific date in time" instead of
// per-endpoint. Old /vN/ URLs still work ("at least one year" backwards
// compatibility promised as of that post), but sending this pins us to a
// known-good, deliberately-tested ESI behaviour snapshot instead of silently
// drifting onto whatever "today" defaults to. Bump this only after testing
// against ESI's current behaviour on a newer date — do NOT compute it as
// `new Date()`, which would just silently re-adopt "no header" behaviour
// every day and defeat the point of pinning it.
const ESI_COMPATIBILITY_DATE = '2026-07-20';

module.exports = { APP_USER_AGENT, APP_CONTACT, APP_SOURCE, ESI_COMPATIBILITY_DATE };
