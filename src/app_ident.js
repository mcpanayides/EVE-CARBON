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

module.exports = { APP_USER_AGENT, APP_CONTACT, APP_SOURCE };
