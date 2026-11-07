// alliance_pack.js — what an alliance pack offers this pilot.
//
// Loaded by the renderer as a <script> tag (window.AlliancePack), by main through
// require(), and by the unit tests. A pack is a YAML file (built in under yaml/,
// or the pilot's own under userData/packs/) whose pack_info can name:
//
//   alliance_id, alliance_ids  the alliances whose pilots are members: one
//                              alliance, or a whole coalition
//   links.<key>                a web page: a URL, or { url, label, public,
//                              owner, alliance_ids }
//   calendar                   { forum_base, feeds, alliance_ids } for
//                              Settings → Calendar
//   terms.<key>                the alliance's own word for one of the app's
//                              things: a string, or { word, alliance_ids }
//   jabber                     { service }: Settings → Jabber's server
//
// The link keys the app uses:
//   forum       the Forums page's address, and the tour's forum stop
//   wiki        the alliance wiki, listed under the pack in Settings
//   gez         the tour's GEZ stop
//   jump_gates  the tour's jump gate stop
//
// Who an item is for: a link is for members unless it says `public: true`.
// Members are pilots with a character in one of the pack's alliances, and
// nothing else counts: a Jabber address or forum login only shows someone is
// trying to get in. An item that names its own `alliance_ids` is for pilots in
// those alliances only, which is how a coalition's pack keeps one alliance's
// things (Goonswarm's GEZ, its wiki) to that alliance. Only web pages are offered.
// Picking a pack is a choice of its own: its Jabber server and its public forum
// go into Settings for anyone who picks it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlliancePack = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const LINK_KEYS = ['forum', 'wiki', 'gez', 'jump_gates'];

  /** Every alliance id the pack names, from alliance_id and alliance_ids. */
  function allianceIds(pack) {
    const info = pack || {};
    const list = [].concat(Array.isArray(info.alliance_ids) ? info.alliance_ids : [],
                           info.alliance_id != null ? [info.alliance_id] : []);
    return [...new Set(list.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  }

  // The alliances an item is for: its own list when it names one, else the pack's.
  function scopeOf(pack, item) {
    const own = item && typeof item === 'object' ? allianceIds({ alliance_ids: item.alliance_ids }) : [];
    return own.length ? own : allianceIds(pack);
  }

  function inScope(pack, item, characterAllianceIds) {
    const mine = new Set((Array.isArray(characterAllianceIds) ? characterAllianceIds : []).map(Number));
    return scopeOf(pack, item).some(id => mine.has(id));
  }

  /** Whether any of the pilot's characters (their alliance ids) is in one of the pack's alliances. */
  function isMember(pack, characterAllianceIds) {
    return inScope(pack, null, characterAllianceIds);
  }

  function webPage(raw) {
    const href = String(raw || '').trim();
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      return { href, host: url.hostname };
    } catch (_) { return null; }
  }

  /**
   * One of the pack's pages for this pilot: { key, href, label, host, public,
   * owner }, or null. With no label, a link is named after its site; `owner` is
   * whose page it is, when the pack says (Goonswarm's, in the Imperium's pack).
   */
  function link(pack, key, characterAllianceIds) {
    const raw = pack && pack.links && pack.links[key];
    if (!raw) return null;
    const named = typeof raw === 'object';
    const page = webPage(named ? raw.url : raw);
    if (!page) return null;
    const isPublic = named && raw.public === true;
    if (!isPublic && !inScope(pack, named ? raw : null, characterAllianceIds)) return null;
    return { key, href: page.href, host: page.host,
             label: (named && String(raw.label || '').trim()) || page.host, public: isPublic,
             owner: (named && String(raw.owner || '').trim()) || null };
  }

  /** Every page the pilot can be offered, in LINK_KEYS order, each address once. */
  function links(pack, characterAllianceIds) {
    const out = [], seen = new Set();
    for (const key of LINK_KEYS) {
      const l = link(pack, key, characterAllianceIds);
      if (l && !seen.has(l.href)) { seen.add(l.href); out.push(l); }
    }
    return out;
  }

  /** The pack's Jabber server ("xmpp://host:port"), or null. For anyone who picks the pack. */
  function jabberService(pack) {
    const s = String((pack && pack.jabber && pack.jabber.service) || '').trim();
    return /^xmpps?:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/i.test(s) ? s : null;
  }

  /**
   * One key per web address, so the same page written a little differently is
   * still recognised as that page: no scheme, no "www.", no trailing slash, any
   * case. "https://goonfleet.com/" and "goonfleet.com" are one address. '' for
   * anything that isn't a web address.
   */
  function addressKey(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      return (url.hostname.replace(/^www\./i, '') + url.pathname.replace(/\/+$/, '') + url.search).toLowerCase();
    } catch (_) { return ''; }
  }

  /**
   * What the pack fills into Settings:
   *   jabberService  Settings → Jabber's server, for anyone who picks the pack
   *   forum          the Forums page's address, for everyone the pack shows its
   *                  forum to: anyone who picks the pack when the forum is
   *                  public (they all are), else its members
   *   calendarForum, calendarFeeds  Settings → Calendar, for members (of the
   *                  calendar's own alliances, when it names them): reading a
   *                  forum's calendar needs a member's sign-in
   */
  function defaults(pack, characterAllianceIds) {
    const out = { forum: '', calendarForum: '', calendarFeeds: [], jabberService: '' };
    if (!pack) return out;
    out.jabberService = jabberService(pack) || '';
    const forum = link(pack, 'forum', characterAllianceIds);
    if (forum) out.forum = forum.href;
    const cal = (pack.calendar && typeof pack.calendar === 'object') ? pack.calendar : null;
    if (cal && inScope(pack, cal, characterAllianceIds)) {
      const base = webPage(cal.forum_base);
      if (base) out.calendarForum = base.href;
      out.calendarFeeds = (Array.isArray(cal.feeds) ? cal.feeds : []).map(webPage).filter(Boolean).map(p => p.href);
    }
    return out;
  }

  /**
   * What the pack calls one of the app's things, for the pilots it's for, or
   * null. The Imperium's pack calls sovereignty upgrades the "GEZ tracker"
   * (Goonswarm Economic Zones), for Goonswarm pilots only: the word is
   * Goonswarm's own, so everyone else gets the plain EVE name from the caller.
   */
  function term(pack, key, characterAllianceIds) {
    const raw = pack && pack.terms && pack.terms[key];
    const named = raw && typeof raw === 'object';
    const word = named ? raw.word : raw;
    if (typeof word !== 'string' || !word.trim()) return null;
    return inScope(pack, named ? raw : null, characterAllianceIds) ? word.trim() : null;
  }

  return { LINK_KEYS, allianceIds, isMember, link, links, defaults, term, jabberService, addressKey };
});
