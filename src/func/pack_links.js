// pack_links.js — what the picked alliance pack offers, around Settings.
//
// The pack is picked in Settings → Jabber (#jabberPackSelect). It can name web
// pages, listed under the picker (members-only ones for members), a Jabber
// server and a forum (both filled in for anyone who picks it), and, for its
// members, defaults for empty Calendar fields: its forum and public feeds. Who
// counts as a member, and what each pack may name, is src/shared/alliance_pack.js.
//
// A default goes into an empty field, or replaces what a pack put there: the
// field remembers it filled itself in (data-pack-default), and the server and
// the forum also recognise any pack's server or forum, even a saved one. So
// picking another pack swaps them, while anything the pilot typed that no pack
// names stays untouched.

/**
 * The picked pack and the alliances of the pilot's characters. Reads the live
 * select, so a pack picked a moment ago counts before SAVE. Before Settings has
 * filled the select (the basics tour ends without it), the saved pack, and with
 * none saved, Goonswarm's, the one main reads (resolvePackFile).
 */
async function packContext(packId) {
  let id = packId || document.getElementById('jabberPackSelect')?.value || '';
  if (!id) {
    const cfg = await window.eveAPI.getAppConfig().catch(() => null);
    id = (cfg && cfg.app && cfg.app.jabber && cfg.app.jabber.pack) || 'gsf_sigs';
  }
  const [packs, allianceIds] = await Promise.all([
    window.eveAPI.getPacks().catch(() => []),
    window.eveAPI.getCharacterAlliances().catch(() => []),
  ]);
  const pack = (Array.isArray(packs) ? packs : []).find(p => p.id === id) || null;
  return { pack, allianceIds: Array.isArray(allianceIds) ? allianceIds : [] };
}

// The plain EVE names for the things a pack can rename for its members.
const PACK_TERM_DEFAULTS = { sov_upgrades: 'sovereignty upgrades' };

/** What to call one of the app's things for this pilot: the pack's word for its members, else the plain name. */
function packTerm(key, ctx) {
  const own = ctx && ctx.pack ? AlliancePack.term(ctx.pack, key, ctx.allianceIds) : null;
  return own || PACK_TERM_DEFAULTS[key] || key;
}

function _packTermCase(text, mode) {
  if (mode === 'title')    return text.replace(/(^|\s)(\S)/g, (m, space, c) => space + c.toUpperCase());
  if (mode === 'sentence') return text.charAt(0).toUpperCase() + text.slice(1);
  return text;
}

/**
 * Every [data-pack-term] in the page takes the pilot's word for that thing:
 * "GEZ tracker" for Goonswarm pilots with its pack, "sovereignty upgrades" for
 * everyone else. data-term-case is title (headings, the Settings menu),
 * sentence (a label's start) or left out (mid-sentence).
 */
async function applyPackTerms(ctx) {
  const c = ctx || await packContext();
  for (const el of document.querySelectorAll('[data-pack-term]')) {
    el.textContent = _packTermCase(packTerm(el.dataset.packTerm, c), el.dataset.termCase);
  }
}

/** The pack's pages, as buttons that open the browser, under the picker in Settings → Jabber. */
async function renderPackLinks(pack) {
  const host = document.getElementById('jabberPackLinks');
  if (!host) return;
  const draw = (host._draw = (host._draw || 0) + 1);
  if (!host._wired) {
    host._wired = true;
    host.addEventListener('click', (e) => {
      const btn = e.target.closest('.pack-link');
      if (btn?.dataset.href) window.eveAPI.openExternalUrl?.(btn.dataset.href)?.catch?.(() => {});
    });
  }
  const allianceIds = pack?.links ? await window.eveAPI.getCharacterAlliances().catch(() => []) : [];
  if (draw !== host._draw) return;                    // a later pick is being drawn
  const links = pack ? AlliancePack.links(pack, allianceIds) : [];
  host.innerHTML = links.map(l => `
    <button type="button" class="pack-link" data-href="${escHtml(l.href)}" title="Opens ${escHtml(l.host)} in your browser">
      <span class="pack-link-text">${escHtml(l.label)}</span>
      <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
    </button>`).join('');
}

function _packNote(id, text) {
  const note = document.querySelector(`[data-pack-note-for="${id}"]`);
  if (note) note.textContent = text;
}

// `known` (optional) holds the AlliancePack.addressKey() of every address any
// pack names for this field: a field holding one of those, even one saved
// earlier, came from a pack, so the next pack picked replaces it.
function _packFill(id, value, from, known) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!el._packWatch) {
    // Typing makes the field the pilot's own: no note, and no later pack replaces it.
    el._packWatch = true;
    el.addEventListener('input', () => { delete el.dataset.packDefault; _packNote(id, ''); });
  }
  const current = el.value.trim();
  const fromAPack = current === el.dataset.packDefault || !!(known && known.has(AlliancePack.addressKey(current)));
  if (current && !fromAPack) return;   // the pilot's own
  el.value = value || '';
  if (value) el.dataset.packDefault = value;
  else delete el.dataset.packDefault;
  _packNote(id, value ? `Filled in from your pack (${from}).` : '');
}

// Every address the packs name for one of their pages, as addressKey()s.
function _packAddresses(packs, key) {
  const out = new Set();
  for (const p of packs) {
    const raw = p && p.links && p.links[key];
    const k = AlliancePack.addressKey(raw && typeof raw === 'object' ? raw.url : raw);
    if (k) out.add(k);
  }
  return out;
}

/**
 * Settings → Jabber's server follows the picked pack, for anyone who picks it:
 * The Imperium's names xmpp://goonfleet.com:5222, and any other pack gets the
 * app's default. A server the pilot typed is theirs and stays: the field only
 * moves while it holds nothing, the default, or a pack's server.
 */
function _packFillService(pack, allPacks) {
  const el = document.getElementById('jabberService');
  if (!el) return;
  if (!el._packWatch) {
    el._packWatch = true;
    el.addEventListener('input', () => { delete el.dataset.packDefault; _packNote('jabberService', ''); });
  }
  const current = el.value.trim();
  const known = new Set([JABBER_DEFAULT_SERVICE, ...allPacks.map(p => AlliancePack.jabberService(p)).filter(Boolean)]);
  if (current && !known.has(current) && current !== el.dataset.packDefault) return;   // the pilot's own
  const own = pack ? AlliancePack.jabberService(pack) : null;
  el.value = own || JABBER_DEFAULT_SERVICE;
  el.dataset.packDefault = el.value;
  _packNote('jabberService', own ? `Filled in from your pack (${pack.alliance || pack.name}).` : '');
}

/**
 * Fills the fields the picked pack has defaults for. For anyone who picks the
 * pack: Settings → Jabber's server, and the Forums page address (Winter
 * Coalition's forum for Winter Coalition, goonfleet.com for The Imperium),
 * replacing another pack's forum, even a saved one, but never an address the
 * pilot typed that no pack names. For its members: the Calendar's forum and
 * feeds, when they are empty. Called once Settings holds its saved values, and
 * again whenever another pack is picked.
 */
async function applyPackDefaults(pack) {
  const p = pack === undefined ? (await packContext()).pack : pack;
  const [allianceIds, allPacks] = await Promise.all([
    p ? window.eveAPI.getCharacterAlliances().catch(() => []) : [],
    window.eveAPI.getPacks().catch(() => []),
  ]);
  const packs = Array.isArray(allPacks) ? allPacks : [];
  const d = AlliancePack.defaults(p, allianceIds);
  const from = (p && (p.alliance || p.name)) || '';
  _packFillService(p, packs);
  _packFill('forumUrlInput', d.forum, from, _packAddresses(packs, 'forum'));
  _packFill('calForumUrl', d.calendarForum, from);
  _packFill('calExtraFeeds', d.calendarFeeds.join('\n'), from);
}
