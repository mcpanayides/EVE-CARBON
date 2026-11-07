'use strict';
//
// What an alliance pack offers a pilot (src/shared/alliance_pack.js): its pages,
// to members or to all, its Jabber server, and the defaults it fills into empty
// Settings fields. Members are pilots with a character in one of the pack's
// alliances, or in the alliances one item names for itself; that a goonfleet.com
// Jabber address or forum doesn't make one is checked end to end in
// e2e/tutorial.spec.js.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const yaml   = require('js-yaml');

const AP = require('../src/shared/alliance_pack');

const PACK = {
  name: 'Test Alliance', alliance: 'Test Alliance', alliance_id: 99000001,
  links: {
    forum:      { label: 'Test forums', url: 'https://forum.test-alliance.example/', public: true },
    gez:        { label: 'GEZ thread', url: 'https://forum.test-alliance.example/topic/1-gez' },
    jump_gates: ' https://wiki.test-alliance.example/gates ',
  },
  calendar: { forum_base: 'https://forum.test-alliance.example', feeds: ['https://calendar.test-alliance.example/ops.ics', 'file:///C:/ops.ics'] },
};

// A coalition whose leading alliance keeps some things to itself.
const LEAD = 99000001, ALLY = 99000002, STRANGER = 99000009;
const COALITION = {
  name: 'Test Coalition', alliance_ids: [LEAD, ALLY],
  jabber: { service: 'xmpp://jabber.test-alliance.example:5222' },
  links: {
    forum: { label: 'Lead forums', url: 'https://forum.test-alliance.example/', public: true, owner: 'Lead Alliance', alliance_ids: [LEAD] },
    wiki:  { label: 'Lead wiki', url: 'https://wiki.test-alliance.example/', owner: 'Lead Alliance', alliance_ids: [LEAD] },
    gez:   { label: 'Coalition sheet topic', url: 'https://forum.test-alliance.example/topic/2' },
  },
  terms: { sov_upgrades: { word: 'Lead tracker', alliance_ids: [LEAD] } },
  calendar: { forum_base: 'https://forum.test-alliance.example', alliance_ids: [LEAD] },
};

// ─── alliances ────────────────────────────────────────────────────────────────

test('a pack names its alliances in alliance_id, alliance_ids or both', () => {
  assert.deepStrictEqual(AP.allianceIds({ alliance_id: 1354830081 }), [1354830081]);
  assert.deepStrictEqual(AP.allianceIds({ alliance_ids: [99003581, '498125261'], alliance_id: 99003581 }), [99003581, 498125261]);
  assert.deepStrictEqual(AP.allianceIds({ alliance_ids: [0, -4, 'x', null, 1.5] }), []);
  assert.deepStrictEqual(AP.allianceIds(null), []);
});

test('a member is a pilot with a character in one of the pack’s alliances', () => {
  const coalition = { alliance_ids: [99003581, 498125261] };
  assert.strictEqual(AP.isMember(coalition, [1354830081, '498125261']), true);   // any one character; an id may be text
  assert.strictEqual(AP.isMember(coalition, [1354830081]), false);
  assert.strictEqual(AP.isMember(coalition, []), false);
  assert.strictEqual(AP.isMember({}, [99003581]), false);                         // a pack naming no alliance has no members
});

// ─── pages ────────────────────────────────────────────────────────────────────

test('members get every page; anyone gets the public ones', () => {
  assert.deepStrictEqual(AP.link(PACK, 'gez', [99000001]), {
    key: 'gez', href: 'https://forum.test-alliance.example/topic/1-gez', host: 'forum.test-alliance.example',
    label: 'GEZ thread', public: false, owner: null,
  });
  assert.strictEqual(AP.link(PACK, 'gez', [1354830081]), null);
  assert.strictEqual(AP.link(PACK, 'gez'), null);
  assert.deepStrictEqual(AP.link(PACK, 'forum', []), {
    key: 'forum', href: 'https://forum.test-alliance.example/', host: 'forum.test-alliance.example',
    label: 'Test forums', public: true, owner: null,
  });
});

test('a page with no label is named after its site, and only web pages are offered', () => {
  assert.strictEqual(AP.link(PACK, 'jump_gates', [99000001]).label, 'wiki.test-alliance.example');
  assert.strictEqual(AP.link(PACK, 'jump_gates', [99000001]).href, 'https://wiki.test-alliance.example/gates');
  for (const url of ['javascript:alert(1)', 'file:///C:/gez.xlsx', 'goonfleet.com', '', '   ']) {
    assert.strictEqual(AP.link({ ...PACK, links: { forum: { url, public: true } } }, 'forum', [99000001]), null, url);
  }
  assert.strictEqual(AP.link({ ...PACK, links: { forum: { label: 'no url', public: true } } }, 'forum', []), null);
  assert.strictEqual(AP.link(PACK, 'wiki', [99000001]), null);                    // a page the pack doesn't name
  assert.strictEqual(AP.link(null, 'forum', []), null);
});

test('the list of pages keeps a fixed order and each address once', () => {
  const same = { ...PACK, links: { ...PACK.links, wiki: { url: 'https://forum.test-alliance.example/', public: true } } };
  assert.deepStrictEqual(AP.links(same, [99000001]).map(l => l.key), ['forum', 'gez', 'jump_gates']);
  assert.deepStrictEqual(AP.links(PACK, []).map(l => l.key), ['forum']);
});

test('a page that names its own alliances is for their pilots only, and says whose it is', () => {
  // The lead's wiki: its pilots get it, the rest of the coalition doesn't.
  assert.strictEqual(AP.link(COALITION, 'wiki', [LEAD]).owner, 'Lead Alliance');
  assert.strictEqual(AP.link(COALITION, 'wiki', [ALLY]), null);
  assert.strictEqual(AP.link(COALITION, 'wiki', [STRANGER]), null);
  // A page that names no alliances of its own is for the whole coalition.
  assert.strictEqual(AP.link(COALITION, 'gez', [ALLY]).href, 'https://forum.test-alliance.example/topic/2');
  assert.strictEqual(AP.link(COALITION, 'gez', [STRANGER]), null);
  // Public stays public whoever's it is.
  assert.strictEqual(AP.link(COALITION, 'forum', [STRANGER]).owner, 'Lead Alliance');
  // An item's alliance list that names nothing real falls back to the pack's.
  const loose = { ...COALITION, links: { wiki: { url: 'https://wiki.test-alliance.example/', alliance_ids: ['x', 0] } } };
  assert.ok(AP.link(loose, 'wiki', [ALLY]));
});

// ─── the Jabber server ────────────────────────────────────────────────────────

test('a pack’s Jabber server is for anyone who picks the pack, when it is an xmpp address', () => {
  assert.strictEqual(AP.jabberService(COALITION), 'xmpp://jabber.test-alliance.example:5222');
  assert.strictEqual(AP.jabberService({ jabber: { service: ' xmpps://jabber.test-alliance.example ' } }), 'xmpps://jabber.test-alliance.example');
  for (const service of ['https://jabber.test-alliance.example', 'jabber.test-alliance.example:5222',
                         'xmpp://jabber.test-alliance.example:5222/x?y', 'xmpp://', 42, '']) {
    assert.strictEqual(AP.jabberService({ jabber: { service } }), null, String(service));
  }
  assert.strictEqual(AP.jabberService(PACK), null);
  assert.strictEqual(AP.jabberService(null), null);
});

// ─── defaults ─────────────────────────────────────────────────────────────────

test('picking a pack fills in its public forum for anyone; its calendar is for members', () => {
  assert.deepStrictEqual(AP.defaults(PACK, [99000001]), {
    forum: 'https://forum.test-alliance.example/',
    calendarForum: 'https://forum.test-alliance.example',
    calendarFeeds: ['https://calendar.test-alliance.example/ops.ics'],             // not the file: one
    jabberService: '',
  });
  const forumOnly = { forum: 'https://forum.test-alliance.example/', calendarForum: '', calendarFeeds: [], jabberService: '' };
  assert.deepStrictEqual(AP.defaults(PACK, [1354830081]), forumOnly);
  assert.deepStrictEqual(AP.defaults(PACK, []), forumOnly);
  const none = { forum: '', calendarForum: '', calendarFeeds: [], jabberService: '' };
  assert.deepStrictEqual(AP.defaults(null, [99000001]), none);
  assert.deepStrictEqual(AP.defaults({ alliance_id: 99000001 }, [99000001]), none);
});

test('a forum that isn’t public is filled in for members only, like its link', () => {
  const closed = { ...PACK, links: { forum: { label: 'Members forum', url: 'https://forum.test-alliance.example/' } } };
  assert.strictEqual(AP.defaults(closed, [99000001]).forum, 'https://forum.test-alliance.example/');
  assert.strictEqual(AP.defaults(closed, [1354830081]).forum, '');
  assert.strictEqual(AP.defaults({ ...closed, links: { forum: 'https://forum.test-alliance.example/' } }, []).forum, '');
});

test('in a coalition’s pack the server and the public forum are for everyone, the lead’s calendar for the lead', () => {
  const server = 'xmpp://jabber.test-alliance.example:5222';
  assert.deepStrictEqual(AP.defaults(COALITION, [LEAD]), {
    forum: 'https://forum.test-alliance.example/', calendarForum: 'https://forum.test-alliance.example',
    calendarFeeds: [], jabberService: server,
  });
  const serverAndForum = { forum: 'https://forum.test-alliance.example/', calendarForum: '', calendarFeeds: [], jabberService: server };
  assert.deepStrictEqual(AP.defaults(COALITION, [ALLY]), serverAndForum);
  assert.deepStrictEqual(AP.defaults(COALITION, [STRANGER]), serverAndForum);
  assert.deepStrictEqual(AP.defaults(COALITION, []), serverAndForum);
});

test('one address, however it is written: scheme, www., trailing slash and case aside', () => {
  const key = AP.addressKey('https://goonfleet.com/');
  assert.strictEqual(key, 'goonfleet.com');
  for (const same of ['https://goonfleet.com', 'http://www.GoonFleet.com/', 'goonfleet.com', ' goonfleet.com// ']) {
    assert.strictEqual(AP.addressKey(same), key, same);
  }
  assert.strictEqual(AP.addressKey('https://goonfleet.com/index.php'), 'goonfleet.com/index.php');   // another page
  assert.strictEqual(AP.addressKey('https://forums.winterco.org'), 'forums.winterco.org');
  for (const notAPage of ['', '   ', null, 'javascript:alert(1)', 'file:///C:/forum.html', 'xmpp://goonfleet.com:5222']) {
    assert.strictEqual(AP.addressKey(notAPage), '', String(notAPage));
  }
});

// ─── words ────────────────────────────────────────────────────────────────────

test('a pack’s own word for a thing is for its members; everyone else gets the plain name', () => {
  const pack = { alliance_id: 1354830081, terms: { sov_upgrades: ' GEZ tracker ' } };
  assert.strictEqual(AP.term(pack, 'sov_upgrades', [1354830081]), 'GEZ tracker');
  assert.strictEqual(AP.term(pack, 'sov_upgrades', [99000001]), null);
  assert.strictEqual(AP.term(pack, 'sov_upgrades', []), null);
  assert.strictEqual(AP.term(pack, 'something_else', [1354830081]), null);
  assert.strictEqual(AP.term({ ...pack, terms: { sov_upgrades: 42 } }, 'sov_upgrades', [1354830081]), null);
  assert.strictEqual(AP.term(null, 'sov_upgrades', [1354830081]), null);
});

test('a word that names its own alliances is theirs alone, even inside the coalition', () => {
  assert.strictEqual(AP.term(COALITION, 'sov_upgrades', [LEAD]), 'Lead tracker');
  assert.strictEqual(AP.term(COALITION, 'sov_upgrades', [ALLY]), null);
  assert.strictEqual(AP.term(COALITION, 'sov_upgrades', [STRANGER]), null);
  assert.strictEqual(AP.term({ ...COALITION, terms: { sov_upgrades: { word: '  ', alliance_ids: [LEAD] } } }, 'sov_upgrades', [LEAD]), null);
});

// ─── the packs that ship ──────────────────────────────────────────────────────
// Read the way main's get-packs reads them.

const YAML_DIR = path.join(__dirname, '..', 'yaml');
const builtIn = fs.readdirSync(YAML_DIR).filter(f => /\.ya?ml$/.test(f))
  .map(f => ({ file: f, info: (yaml.load(fs.readFileSync(path.join(YAML_DIR, f), 'utf8')) || {}).pack_info || {} }));
const pack = (file) => builtIn.find(p => p.file === file).info;

// Every id an item names must be a real alliance id, and one of the pack's own.
function assertItemScope(file, where, info, raw) {
  if (!raw || typeof raw !== 'object' || raw.alliance_ids == null) return;
  assert.ok(Array.isArray(raw.alliance_ids) && raw.alliance_ids.length, `${file}: ${where} alliance_ids must list ids`);
  const ids = AP.allianceIds({ alliance_ids: raw.alliance_ids });
  assert.strictEqual(ids.length, raw.alliance_ids.length, `${file}: ${where} names an alliance id that isn't one`);
  for (const id of ids) assert.ok(AP.allianceIds(info).includes(id), `${file}: ${where} names ${id}, which the pack doesn't`);
}

test('every built-in pack has a name, sound alliance ids, labelled web pages and a sound server', () => {
  assert.ok(builtIn.length >= 4, builtIn.map(p => p.file).join(', '));
  for (const { file, info } of builtIn) {
    assert.ok(String(info.name || '').trim(), `${file}: name`);
    const ids = [].concat(info.alliance_ids || [], info.alliance_id != null ? [info.alliance_id] : []);
    assert.deepStrictEqual(AP.allianceIds(info).length, new Set(ids.map(Number)).size, `${file}: an alliance id that isn't one`);
    for (const [key, raw] of Object.entries(info.links || {})) {
      assert.ok(AP.LINK_KEYS.includes(key), `${file}: unknown link ${key}`);
      assert.ok(typeof raw === 'object' && String(raw.label || '').trim(), `${file}: ${key} needs a label`);
      assert.match(String(raw.url), /^https:\/\//, `${file}: ${key} must be an https page`);
      assertItemScope(file, `links.${key}`, info, raw);
    }
    for (const [key, raw] of Object.entries(info.terms || {})) {
      const word = raw && typeof raw === 'object' ? raw.word : raw;
      assert.ok(typeof word === 'string' && word.trim(), `${file}: term ${key} must be words`);
      assertItemScope(file, `terms.${key}`, info, raw);
    }
    assertItemScope(file, 'calendar', info, info.calendar);
    if (info.jabber) assert.ok(AP.jabberService(info), `${file}: jabber.service must be an xmpp:// address`);
  }
});

test('the built-in packs are the four coalitions, by these names', () => {
  assert.deepStrictEqual(builtIn.map(p => [p.file, p.info.name]).sort(), [
    ['brave.yaml', 'Brave Collective'],
    ['gsf_sigs.yaml', 'The Imperium'],
    ['initiative.yaml', 'The Initiative'],
    ['winterco.yaml', 'Winter Coalition'],
  ]);
  // The Imperium's file keeps its old id, so saved settings pointing at it still work.
  assert.strictEqual(pack('gsf_sigs.yaml').id, 'gsf_sigs');
});

test('The Imperium: the coalition, its server for anyone, and Goonswarm’s own things for Goonswarm', () => {
  const GSF = 1354830081, BRAVE = 99003214;
  const imp = pack('gsf_sigs.yaml');
  // Its alliances, each checked against ESI on 2026-11-06.
  assert.strictEqual(AP.allianceIds(imp).length, 14);
  for (const id of [GSF, 99009163, BRAVE, 99003995, 99011223, 99010079, 99010877, 131511956,
                    99012042, 99011239, 99001969, 99008165, 99009331, 99012849]) {
    assert.ok(AP.allianceIds(imp).includes(id), `The Imperium is missing ${id}`);
  }
  assert.ok(!AP.allianceIds(imp).includes(1900696668));                          // not The Initiative

  // The server, for anyone who picks the pack.
  assert.strictEqual(AP.jabberService(imp), 'xmpp://goonfleet.com:5222');
  for (const ids of [[GSF], [BRAVE], [STRANGER], []]) {
    assert.strictEqual(AP.defaults(imp, ids).jabberService, 'xmpp://goonfleet.com:5222', JSON.stringify(ids));
  }

  // Goonswarm's pages: all of them for its pilots, labelled as Goonswarm's.
  assert.deepStrictEqual(AP.links(imp, [GSF]).map(l => [l.key, l.href, l.owner]), [
    ['forum', 'https://goonfleet.com/', 'Goonswarm Federation'],
    ['wiki', 'https://wiki.goonswarm.org/w/Main_Page', 'Goonswarm Federation'],
    ['gez', 'https://goonfleet.com/index.php/topic/361575-gez-goonswarm-economic-zones-mkii', 'Goonswarm Federation'],
    ['jump_gates', 'https://wiki.goonswarm.org/w/Alliance:Stargate', 'Goonswarm Federation'],
  ]);
  // The rest of the coalition, and strangers, get the public forum only.
  assert.deepStrictEqual(AP.links(imp, [BRAVE]).map(l => l.href), ['https://goonfleet.com/']);
  assert.deepStrictEqual(AP.links(imp, [STRANGER]).map(l => l.href), ['https://goonfleet.com/']);

  // goonfleet.com, its public forum, goes into the Forums settings of anyone who
  // picks the pack; reading the forum's calendar needs a Goonswarm sign-in.
  assert.deepStrictEqual(AP.defaults(imp, [GSF]), {
    forum: 'https://goonfleet.com/', calendarForum: 'https://goonfleet.com', calendarFeeds: [],
    jabberService: 'xmpp://goonfleet.com:5222',
  });
  for (const ids of [[BRAVE], [STRANGER]]) {
    const d = AP.defaults(imp, ids);
    assert.strictEqual(d.forum, 'https://goonfleet.com/', JSON.stringify(ids));
    assert.strictEqual(d.calendarForum, '', JSON.stringify(ids));
  }

  // GEZ is Goonswarm's word for sovereignty upgrades: Goons see it, allies don't.
  assert.strictEqual(AP.term(imp, 'sov_upgrades', [GSF]), 'GEZ tracker');
  assert.strictEqual(AP.term(imp, 'sov_upgrades', [BRAVE]), null);
  assert.strictEqual(AP.term(imp, 'sov_upgrades', [STRANGER]), null);
});

test('The Initiative: its alliance, and nothing else known yet', () => {
  const init = pack('initiative.yaml');
  assert.deepStrictEqual(AP.allianceIds(init), [1900696668]);                    // The Initiative., checked against ESI 2026-11-06
  assert.deepStrictEqual(AP.links(init, [1900696668]), []);
  assert.strictEqual(AP.jabberService(init), null);
  assert.deepStrictEqual(AP.defaults(init, [1900696668]), { forum: '', calendarForum: '', calendarFeeds: [], jabberService: '' });
});

test('the Winter Coalition and Brave packs cover their alliances, with public pages and no server', () => {
  const wc = pack('winterco.yaml');
  for (const id of [99003581, 498125261, 1727758877, 386292982]) {               // FRT, TEST, NC., PL
    assert.ok(AP.allianceIds(wc).includes(id), `WinterCo is missing ${id}`);
  }
  assert.strictEqual(AP.allianceIds(wc).length, 13);
  assert.ok(!AP.allianceIds(wc).includes(1354830081));
  assert.deepStrictEqual(AP.links(wc, []).map(l => l.href), ['https://forums.winterco.org', 'https://wiki.winterco.org/en/start']);
  // Its forum, for anyone who picks the pack: a member, or a Goon having a look.
  assert.strictEqual(AP.defaults(wc, [99003581]).forum, 'https://forums.winterco.org');
  assert.strictEqual(AP.defaults(wc, [1354830081]).forum, 'https://forums.winterco.org');
  assert.strictEqual(AP.defaults(wc, []).forum, 'https://forums.winterco.org');
  assert.strictEqual(AP.jabberService(wc), null);                                // Settings keeps the app's default

  const brave = pack('brave.yaml');
  assert.deepStrictEqual(AP.allianceIds(brave), [99003214, 99010079]);
  assert.deepStrictEqual(AP.links(brave, []).map(l => l.href), ['https://wiki.bravecollective.com/start']);
  assert.strictEqual(AP.jabberService(brave), null);
});
