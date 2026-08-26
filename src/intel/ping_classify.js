'use strict';
//
// Decides whether a Jabber message is a director broadcast worth interrupting
// someone for, and whether it should raise the full-screen ping window.
//
// Why this is not just a regex on the sender:
//
// `createPingAlertWindow()` CLOSES the current alert before opening the next
// one, so alerts never stack — the newest always wins. That is right for fleet
// pings, which are rare and individually important, and wrong for structure
// alerts, which arrive in bulk. During an attack wave every tower notification
// replaces the window, so the fleet ping an FC actually needs is destroyed by
// the noise arriving behind it. Suppressing the popup for structure alerts is
// therefore not about tidiness; it is what keeps a real ping on screen.
//
// Structure alerts legitimately come FROM a director address — that is how the
// monitoring bot is authorised to broadcast — so the sender cannot separate
// them. The body can.
//
// Two deliberate conservatisms, because a missed ping is far worse than an
// extra one:
//
//   • Suppression only ever affects the POPUP. The message is still stored,
//     still broadcast to the Jabber panel, and still flagged isDirector.
//   • An explicit fleet signal BEATS structure suppression. "Structure under
//     attack, form up and undock" is a fleet ping that happens to mention a
//     structure, and it pops.

// Tokenise and match, rather than one boundary regex. A boundary rule has to
// choose between `directorbot` (a real broadcast account shape, must match) and
// `directory` (must not) — they differ only by which letters follow, so no
// boundary gets both. Matching a token containing "director" and then excluding
// the handful of English words that merely contain it does get both, and says
// out loud which words those are.
const DIRECTOR_RE  = /director/i;
const NOT_DIRECTOR = /^(?:redirectors?|director(?:y|ies)|directions?|directives?)$/i;

/** Does any word in `text` name a director, ignoring look-alikes? */
function hasDirectorToken(text) {
  return String(text || '')
    .split(/[^a-z0-9]+/i)
    .some(t => t && DIRECTOR_RE.test(t) && !NOT_DIRECTOR.test(t));
}

// Phrases specific to structure/POS notification bots. Deliberately phrases,
// not single words: "shield" alone appears in "bring shield ships", and
// "structure" alone appears in half of all fleet pings.
const STRUCTURE_RE = new RegExp([
  'under attack',
  'has entered (?:its )?(?:shield|armou?r|hull)',
  'entered reinforce',
  'reinforc(?:ed|ement)',
  'anchoring|unanchoring',
  'fuel (?:is )?(?:low|expiring|expired|runs out)',
  'out of fuel',
  'low ?power(?: mode)?',
  'structure (?:lost|destroyed|damaged)',
  'has been (?:destroyed|onlined|offlined)',
].join('|'), 'i');

// Signals that a human is calling for bodies. These override structure
// suppression — see the note above.
const FLEET_RE = new RegExp([
  '(?:^|[^a-z])form(?:ing)?(?: up)?(?:[^a-z]|$)',
  'undock',
  'x ?up',
  '(?:^|[^a-z])ping(?:[^a-z]|$)',
  '(?:^|[^a-z])fleet(?:[^a-z]|$)',
  'strat(?:egic)? ?op',
  'home ?defen[cs]e',
  'get in',
  'on grid',
].join('|'), 'i');

/** Localpart of a JID: `director@example.org/resource` -> `director`. */
function jidNode(jid) {
  const bare = String(jid || '').split('/')[0];
  const at = bare.indexOf('@');
  return at === -1 ? bare : bare.slice(0, at);
}

/**
 * @param {{from?: string, body?: string, type?: string}} msg
 * @returns {{isDirector: boolean, isStructureAlert: boolean, shouldPopup: boolean}}
 */
function classifyPing(msg) {
  const from = String(msg?.from || '');
  const body = String(msg?.body || '');
  const type = String(msg?.type || 'chat');

  // The NODE, not the whole JID. Matching the whole JID meant the domain and
  // the resource counted too, so anything hosted at a `director.*` domain, or
  // connected with a resource like `/director-console`, was a fleet ping.
  const fromDirector = hasDirectorToken(jidNode(from));
  const bodyDirector = hasDirectorToken(body);

  // Unchanged meaning, so the stored is_director column and every filter built
  // on it keep working.
  const isDirector = fromDirector || bodyDirector;

  // A one-to-one chat that merely CONTAINS the word is not a broadcast. Someone
  // typing "ask the director when he's on" used to raise a full-screen alert
  // over whatever you were doing. Alliance pings come from a broadcast account,
  // so they match on the sender and are unaffected.
  const popupEligible = fromDirector || (bodyDirector && type !== 'chat');

  const isStructureAlert = isDirector && STRUCTURE_RE.test(body) && !FLEET_RE.test(body);

  return { isDirector, isStructureAlert, shouldPopup: popupEligible && !isStructureAlert };
}

module.exports = { classifyPing, jidNode, DIRECTOR_RE, STRUCTURE_RE, FLEET_RE };
