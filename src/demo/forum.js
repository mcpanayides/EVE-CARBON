'use strict';
//
// ─── forum.js — the demo's alliance forum ─────────────────────────────────────
//
// The Forums page embeds a real IP.Board site in a <webview>. Demo mode points it
// at https://forum.vaelin.example/ — a host that can never exist (RFC 2606) —
// and main.js answers that host on the forum's session from here, so the page
// shows a working forum, signed in, without touching the network.
//
// Pages are rendered rather than shipped as files so times stay relative
// ("12 minutes ago" on every take) and so the forum agrees with the rest of the
// demo: its posters are the cast and CCP NPC agents, its calendar is the same
// feed the Calendar page subscribes to, and the scout broadcast's link to the
// intel rules topic opens that topic.

const { DOMAIN, VAELIN, CAST, pilot } = require('./cast');
const cal = require('./calendar');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const HOST = `forum.${DOMAIN}`;
const BASE = `https://${HOST}`;

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Forum icons are the forum's initials: the page loads no web fonts, so it
// renders the same offline as on.
const initials = (s) => s.replace(/&/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const portrait = (id, size = 64) => `https://images.evetech.net/characters/${id}/portrait?size=${size}`;

// People: the cast plus agents from the pool, each with a forum title.
const P = {
  kaska: { id: CAST.main.id,  name: CAST.main.name,  title: 'Fleet Commander', group: 'Leadership' },
  sirene:{ id: CAST.indy.id,  name: CAST.indy.name,  title: 'Industry Director', group: 'Leadership' },
  tovan: { id: CAST.scout.id, name: CAST.scout.name, title: 'Scout', group: 'Member' },
  tera:  { ...pickP(2),  title: 'Home Guard FC', group: 'FC Team' },
  rako:  { ...pickP(5),  title: 'Roam FC', group: 'FC Team' },
  ari:   { ...pickP(9),  title: 'Scout Lead', group: 'Division Lead' },
  yan:   { ...pickP(13), title: 'Capital Group Lead', group: 'Division Lead' },
  rau:   { ...pickP(17), title: 'Strategic FC', group: 'FC Team' },
  olk:   { ...pickP(21), title: 'Infrastructure', group: 'Tech Team' },
  m1:    { ...pickP(31), title: 'Member', group: 'Member' },
  m2:    { ...pickP(44), title: 'Member', group: 'Member' },
  m3:    { ...pickP(50), title: 'New Member', group: 'Member' },
  m4:    { ...pickP(57), title: 'Member', group: 'Member' },
  m5:    { ...pickP(64), title: 'Logistics Pilot', group: 'Member' },
};
function pickP(n) { const p = pilot(n); return { id: p.id, name: p.name }; }

// ── Content ──────────────────────────────────────────────────────────────────
// [id, title, starter, replies, views, minutes since the last post, last poster]
const FORUMS = [
  { cat: VAELIN.name, id: 2, name: 'Alliance Announcements', desc: 'News from leadership. Read-only for members.', 
    topics: [[2201, 'Deployment: staging moves to 319-3D', 'kaska', 48, 3120, 95, 'rau'],
             [2195, 'Town hall notes — October', 'kaska', 22, 1880, 1440 * 3, 'm2'],
             [2180, 'New SRP rules for strategic ops', 'rau', 61, 4210, 1440 * 5, 'm1'],
             [2166, 'Welcome to our new member corporations', 'kaska', 14, 960, 1440 * 9, 'm4']] },
  { cat: VAELIN.name, id: 3, name: 'Operations & Timers', desc: 'Sov timers, structure timers and CTA coordination.', 
    topics: [[2210, '319-3D Astrahus — armour timer', 'rau', 9, 410, 25, 'tera'],
             [2208, 'Sov hub timers this week', 'rau', 17, 1290, 300, 'kaska'],
             [2190, 'CTA debrief — 1DQ1-A defence', 'kaska', 73, 5120, 1440 * 2, 'm5']] },
  { cat: VAELIN.name, id: 4, name: 'Doctrines & Fits', desc: 'Official fits. Fly what is posted; ask here first.', 
    topics: [[2121, 'Muninn doctrine — updated fit', 'kaska', 112, 9040, 180, 'm1'],
             [2118, 'Ferox fleet fit and roles', 'rau', 64, 5530, 1440, 'm2'],
             [2102, 'Scimitar: links, cap and positioning', 'sirene', 38, 2770, 1440 * 4, 'm5']] },
  { cat: 'Divisions', id: 5, name: 'Industry & Mining', desc: 'Buyback, moon schedules and build plans.', 
    topics: [[2215, 'Moon fracture schedule — November', 'sirene', 21, 1640, 60, 'ari'],
             [2199, 'Caracal build margins — 31% this week', 'sirene', 15, 870, 1440, 'm4'],
             [2170, 'Ore buyback: now 92% Jita', 'sirene', 40, 3300, 1440 * 6, 'm3']] },
  { cat: 'Divisions', id: 6, name: 'Scouts & Intel', desc: 'Intel channel rules, shifts and reports.', 
    topics: [[2118.5, 'Intel channel rules', 'ari', 33, 2410, 1440 + 120, 'tovan'],
             [2160, 'Fountain border watch — sign-ups', 'ari', 27, 1180, 1440 * 4, 'tovan']] },
  { cat: 'Divisions', id: 7, name: 'Capital Group', desc: 'Moves, training and fatigue planning.', 
    topics: [[2203, 'Capital move op — 21:00 tonight', 'yan', 19, 1020, 240, 'kaska'],
             [2140, 'Dread bomb practice recap', 'yan', 26, 1400, 1440 * 5, 'm2']] },
  { cat: 'Community', id: 8, name: 'Newbro Help', desc: 'No question is stupid.', 
    topics: [[2212, 'How do I get into the strat op with only a frigate?', 'm3', 7, 190, 990, 'rako'],
             [2150, 'Welcome! Start here', 'rako', 85, 12030, 1440 * 3, 'm3']] },
  { cat: 'Community', id: 9, name: 'Off Topic', desc: 'Everything that is not spaceships. Mostly spaceships.', 
    topics: [[2216, 'Show your hangar', 'm1', 52, 2210, 35, 'tovan'],
             [2130, 'Vaelin TV — stream schedule', 'olk', 18, 990, 1440 * 2, 'm4']] },
];
// Fix the half-id used to keep the intel rules topic beside its forum:
FORUMS[4].topics[0][0] = 2118;
FORUMS[2].topics[1][0] = 2119;

// Full posts for the topics a viewer is most likely to open; every other topic
// renders its opening post and a reply or two in the same voice.
const POSTS = {
  2118: [['ari', 1440 + 300, 'Intel channel rules', [
    'These are the rules for <b>vaelin.intel</b>, <b>vaelin.home</b> and <b>vaelin.forward</b>. Read them before your next shift.',
    '<ol><li>Report <b>system, ship type and pilot</b> — in that order. Paste the local scan, do not describe it.</li><li>No chatter. Questions go to the scouts room on Jabber.</li><li>A clear report is still a report: <i>"YZ9-F6 clr"</i> tells the home guard FC something useful.</li><li>Cyno alerts go in caps.</li></ol>',
    'EVE Carbon’s Early Warning reads these channels — a clean format is what lets it work out jumps and ETAs for everyone.']],
    ['tovan', 1440 + 120, '', ['Read and understood. Is it okay to report wormhole spawns in vaelin.forward as well?']],
    ['ari', 1440 + 90, '', ['Yes — prefix them with <b>WH</b> so they do not get read as hostiles.']]],
  2121: [['kaska', 1440 * 6, 'Muninn doctrine — updated fit', [
    'The Muninn fit has changed. The old one is <b>no longer doctrine</b> from Sunday.',
    '<pre>[Muninn, Vaelin fleet]\nGyrostabilizer II\nGyrostabilizer II\nGyrostabilizer II\nTracking Enhancer II\nDamage Control II\n\n50MN Microwarpdrive II\nLarge Shield Extender II\nLarge Shield Extender II\nMultispectrum Shield Hardener II\n\n720mm Howitzer Artillery II x5\n\nMedium Core Defense Field Extender I x2</pre>',
    'It is in the in-game fittings as <i>Muninn — Vaelin fleet</i>. Import it into EVE Carbon’s Fitting Simulator to check you can fly it.']],
    ['m1', 1440 * 5, '', ['Is the second LSE mandatory? I am a bit short on CPU.']],
    ['kaska', 1440 * 5 - 30, '', ['Yes. Train Electronics Upgrades to IV — the Skills page will cost it against all your characters.']],
    ['m5', 180, '', ['Fit checks out in the simulator. See everyone on Sunday.']]],
  2215: [['sirene', 1440 * 2, 'Moon fracture schedule — November', [
    'Fractures for the month are on the forum calendar (and in EVE Carbon if you subscribe to it).',
    '<table class="t"><tr><th>Moon</th><th>Chunk</th><th>Fracture</th></tr><tr><td>T5ZI-S VII - Moon 3</td><td>R32</td><td>every other Monday, 20:00</td></tr><tr><td>319-3D IV - Moon 1</td><td>R64</td><td>10 days from now, 18:30</td></tr></table>',
    'Orca boosts on grid at every fracture. Buyback is 92% Jita for compressed ore.']],
    ['ari', 60, '', ['Home guard cover will be up for the R64 — bring the Rorquals.']]],
  2201: [['kaska', 1440 * 4, 'Deployment: staging moves to 319-3D', [
    'We are deploying. Move your doctrine hulls to <b>319-3D</b> by Friday.',
    'Jump freighter service runs from 1DQ1-A every evening; courier contracts to the alliance are SRP-free this week.',
    'Questions in Operations &amp; Timers, not here.']],
    ['rau', 95, '', ['Reminder: the capital move op is tonight at 21:00. Check your fatigue.']]],
};

// ── Layout ───────────────────────────────────────────────────────────────────
const CSS = `
:root{--bg:#14171c;--panel:#1c2027;--panel2:#222731;--line:#2c3240;--text:#d7dce4;--muted:#8a93a3;--accent:#c4453a;--accent2:#e0745c;--link:#7fb4e6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI",Roboto,Arial,sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.top{background:linear-gradient(180deg,#232a36,#1a1f28);border-bottom:1px solid var(--line)}
.wrap{max-width:1240px;margin:0 auto;padding:0 20px}
.brand{display:flex;align-items:center;gap:14px;padding:18px 0}
.logo{width:44px;height:44px;border-radius:10px;background:radial-gradient(circle at 30% 30%,var(--accent2),var(--accent) 60%,#5e1d18);display:grid;place-items:center;font-weight:800;color:#fff;letter-spacing:1px;box-shadow:0 0 0 1px #0006}
.brand h1{margin:0;font-size:22px;letter-spacing:.5px}.brand small{color:var(--muted)}
.user{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--muted)}.user img{width:34px;height:34px;border-radius:50%;border:2px solid var(--accent)}
.user b{color:var(--text)}
.nav{display:flex;gap:4px}.nav a{padding:10px 16px;color:var(--muted);border-bottom:2px solid transparent}.nav a.on,.nav a:hover{color:#fff;border-color:var(--accent);text-decoration:none}
.crumb{color:var(--muted);font-size:13px;padding:14px 0}
.cols{display:grid;grid-template-columns:1fr 300px;gap:20px;padding-bottom:40px}
.box{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:18px}
.box h2{margin:0;padding:12px 16px;font-size:15px;background:var(--panel2);border-bottom:1px solid var(--line);letter-spacing:.3px}
.row{display:grid;grid-template-columns:44px 1fr 110px 220px;gap:12px;align-items:center;padding:12px 16px;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}.ico{width:40px;height:40px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);display:grid;place-items:center;color:var(--accent2);font-weight:700;font-size:14px;letter-spacing:.5px}
.row .t{font-weight:600;font-size:15px}.row .d{color:var(--muted);font-size:13px}.stat{color:var(--muted);font-size:13px;text-align:right}.stat b{color:var(--text);display:block;font-size:15px}
.last{display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--muted);min-width:0}.last img{width:30px;height:30px;border-radius:50%}.last span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.last a{color:var(--text)}
.side h3{margin:0;padding:10px 14px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);background:var(--panel2);border-bottom:1px solid var(--line)}
.ev{padding:10px 14px;border-top:1px solid var(--line)}.ev:first-of-type{border-top:0}.ev .when{color:var(--accent2);font-size:12px;font-weight:600}.ev .what{font-weight:600}
.online{padding:12px 14px;display:flex;flex-wrap:wrap;gap:6px}.online img{width:30px;height:30px;border-radius:50%}
.post{display:grid;grid-template-columns:170px 1fr;border-top:1px solid var(--line)}.post:first-of-type{border-top:0}
.author{background:var(--panel2);padding:16px;text-align:center;border-right:1px solid var(--line)}.author img{width:96px;height:96px;border-radius:8px;display:block;margin:0 auto 8px}
.author .n{font-weight:700}.author .g{color:var(--accent2);font-size:12px}.author .m{color:var(--muted);font-size:12px}
.body{padding:16px 20px}.body .meta{color:var(--muted);font-size:12px;margin-bottom:10px}.body pre{background:#0f1216;border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;color:#cfe3c7}
.react{margin-top:14px;color:var(--muted);font-size:12px}.react b{color:var(--accent2)}
table.t{border-collapse:collapse;margin:8px 0}table.t td,table.t th{border:1px solid var(--line);padding:6px 10px;text-align:left}table.t th{background:var(--panel2)}
.btn{display:inline-block;background:var(--accent);color:#fff;padding:8px 16px;border-radius:6px;font-weight:600}.btn:hover{text-decoration:none;filter:brightness(1.1)}
.tl{display:grid;grid-template-columns:1fr 90px 90px 220px;gap:12px;padding:12px 16px;border-top:1px solid var(--line);align-items:center}
.tl .t a{font-weight:600;color:var(--text);font-size:15px}.tl .by{color:var(--muted);font-size:12.5px}
.head{display:flex;align-items:center;gap:14px;padding:14px 16px}
`;

function rel(minsAgo) {
  // Rendered in the page so it is right whenever the page is opened.
  return `<time data-ago="${Math.round(minsAgo)}"></time>`;
}
const SCRIPT = `<script>(function(){var n=Date.now(),t=document.querySelectorAll('time[data-ago]');for(var i=0;i<t.length;i++){var m=+t[i].getAttribute('data-ago'),s;if(m<1)s='just now';else if(m<60)s=m+' minute'+(m===1?'':'s')+' ago';else if(m<1440){var h=Math.round(m/60);s=h+' hour'+(h===1?'':'s')+' ago';}else{var d=Math.round(m/1440);s=d===1?'Yesterday':d+' days ago';}t[i].textContent=s;}})();</script>`;

function page(title, crumbs, main, side, nav = 'forums') {
  const me = P.kaska;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - ${esc(VAELIN.name)}</title>
<style>${CSS}</style></head><body>
<div class="top"><div class="wrap">
  <div class="brand"><div class="logo">${esc(VAELIN.ticker.slice(0, 2))}</div><div><h1>${esc(VAELIN.name)}</h1><small>Alliance forum · [${esc(VAELIN.ticker)}]</small></div>
  <div class="user"><img src="${portrait(me.id, 64)}" alt=""><div>Signed in as<br><b>${esc(me.name)}</b></div></div></div>
  <div class="nav"><a href="${BASE}/" class="${nav === 'forums' ? 'on' : ''}">Forums</a><a href="${BASE}/calendar/" class="${nav === 'calendar' ? 'on' : ''}">Calendar</a><a href="${BASE}/forum/4-doctrines-fits/">Doctrines</a><a href="${BASE}/forum/3-operations-timers/">Timers</a></div>
</div></div>
<div class="wrap"><div class="crumb">${crumbs.map(([t, h]) => (h ? `<a href="${h}">${esc(t)}</a>` : esc(t))).join(' &rsaquo; ')}</div>
<div class="cols"><div>${main}</div><div class="side">${side}</div></div></div>${SCRIPT}</body></html>`;
}

function sidebar(now) {
  // The same feed the Calendar page subscribes to, so the forum and the app
  // list the same upcoming ops.
  const ics = require('../func/ics-parse.js');
  const start = new Date(now), end = new Date(now + 10 * DAY);
  const upcoming = ics.parseIcs(cal.feed(cal.FORUM_FEED, now))
    .flatMap(ev => ics.expandRecurring(ev, start, end))
    .sort((a, b) => a.start - b.start).slice(0, 6);
  const fmt = (d) => d.toUTCString().slice(0, 22).replace(/:00$/, '') + ' EVE';
  const online = Object.values(P).slice(0, 12);
  return `<div class="box"><h3>Upcoming events</h3>${upcoming.map(e =>
      `<div class="ev"><div class="when">${esc(fmt(e.start))}</div><div class="what">${esc(e.summary)}</div><div class="d" style="color:var(--muted);font-size:12px">${esc(e.location || '')}</div></div>`).join('')}
      <div class="ev"><a class="btn" href="${BASE}/calendar/">Full calendar</a></div></div>
    <div class="box"><h3>Online now · ${online.length + 23}</h3><div class="online">${online.map(p => `<img title="${esc(p.name)}" src="${portrait(p.id, 32)}" alt="">`).join('')}</div></div>`;
}

function topicMeta(id) {
  for (const f of FORUMS) for (const t of f.topics) if (t[0] === id) return { forum: f, t };
  return null;
}

function renderIndex(now) {
  const cats = [...new Set(FORUMS.map(f => f.cat))];
  const main = cats.map(cat => `<div class="box"><h2>${esc(cat)}</h2>${FORUMS.filter(f => f.cat === cat).map(f => {
    const last = f.topics.slice().sort((a, b) => a[5] - b[5])[0];
    const lp = P[last[6]];
    const posts = f.topics.reduce((n, t) => n + t[3] + 1, 0);
    return `<div class="row"><div class="ico">${esc(initials(f.name))}</div>
      <div><div class="t"><a href="${BASE}/forum/${f.id}-${slug(f.name)}/">${esc(f.name)}</a></div><div class="d">${esc(f.desc)}</div></div>
      <div class="stat"><b>${(posts * 37).toLocaleString('en-US')}</b>posts</div>
      <div class="last"><img src="${portrait(lp.id, 32)}" alt=""><span><a href="${BASE}/topic/${last[0]}-${slug(last[1])}/">${esc(last[1])}</a><br>By ${esc(lp.name)}, ${rel(last[5])}</span></div></div>`;
  }).join('')}</div>`).join('');
  return page('Forums', [['Home', null]], main, sidebar(now));
}

function renderForum(id, now) {
  const f = FORUMS.find(x => x.id === id);
  if (!f) return null;
  const main = `<div class="box"><div class="head"><div class="ico">${esc(initials(f.name))}</div><div><h2 style="all:unset;font-size:20px;font-weight:700">${esc(f.name)}</h2><div class="d" style="color:var(--muted)">${esc(f.desc)}</div></div><a class="btn" style="margin-left:auto" href="#">Start new topic</a></div>
    ${f.topics.map(t => {
      const by = P[t[2]], lp = P[t[6]];
      return `<div class="tl"><div><div class="t"><a href="${BASE}/topic/${t[0]}-${slug(t[1])}/">${esc(t[1])}</a></div><div class="by">By ${esc(by.name)}</div></div>
        <div class="stat"><b>${t[3]}</b>replies</div><div class="stat"><b>${t[4].toLocaleString('en-US')}</b>views</div>
        <div class="last"><img src="${portrait(lp.id, 32)}" alt=""><span>${esc(lp.name)}<br>${rel(t[5])}</span></div></div>`;
    }).join('')}</div>`;
  return page(f.name, [['Home', `${BASE}/`], [f.cat, `${BASE}/`], [f.name, null]], main, sidebar(now));
}

function renderTopic(id, now) {
  const meta = topicMeta(id);
  if (!meta) return null;
  const { forum, t } = meta;
  const posts = POSTS[id] || [
    [t[2], t[5] + 600, t[1], [`${esc(t[1])} — details below. Questions in this thread, please.`]],
    [t[6], t[5], '', ['Thanks — noted, will be there.']],
  ];
  const main = `<div class="box"><div class="head"><div><h2 style="all:unset;font-size:20px;font-weight:700">${esc(t[1])}</h2>
      <div style="color:var(--muted);font-size:13px">Started by ${esc(P[t[2]].name)} in <a href="${BASE}/forum/${forum.id}-${slug(forum.name)}/">${esc(forum.name)}</a></div></div></div>
    ${posts.map(([who, mins, , paras], i) => {
      const p = P[who];
      return `<div class="post"><div class="author"><img src="${portrait(p.id, 128)}" alt=""><div class="n">${esc(p.name)}</div><div class="g">${esc(p.title)}</div><div class="m">${esc(p.group)}</div></div>
        <div class="body"><div class="meta">Posted ${rel(mins)}${i === 0 ? '' : ` · #${i + 1}`}</div>${paras.map(x => `<p>${x}</p>`).join('')}
        <div class="react"><b>&#9650; ${(t[3] * 3 + i * 7) % 41 + 2}</b> reactions</div></div></div>`;
    }).join('')}</div>`;
  return page(t[1], [['Home', `${BASE}/`], [forum.name, `${BASE}/forum/${forum.id}-${slug(forum.name)}/`], [t[1], null]], main, sidebar(now));
}

function renderCalendar(now) {
  const ics = require('../func/ics-parse.js');
  const start = new Date(now - DAY), end = new Date(now + 30 * DAY);
  const all = ics.parseIcs(cal.feed(cal.FORUM_FEED, now)).flatMap(ev => ics.expandRecurring(ev, start, end)).sort((a, b) => a.start - b.start);
  const main = `<div class="box"><div class="head"><div><h2 style="all:unset;font-size:20px;font-weight:700">Alliance Operations</h2>
      <div style="color:var(--muted);font-size:13px">Every op for the next 30 days. Subscribe to keep EVE Carbon’s calendar in step.</div></div>
      <a class="btn" style="margin-left:auto" href="${cal.FORUM_FEED}">Subscribe (iCal)</a></div>
    ${all.map(e => `<div class="tl" style="grid-template-columns:200px 1fr 160px"><div class="by" style="color:var(--accent2);font-weight:600">${esc(e.start.toUTCString().slice(0, 22))} EVE</div>
      <div class="t"><a href="${esc(e.url || '#')}">${esc(e.summary)}</a><div class="by">${esc(e.description || '')}</div></div><div class="by">${esc(e.location || '')}</div></div>`).join('')}</div>`;
  return page('Calendar', [['Home', `${BASE}/`], ['Calendar', null]], main, sidebar(now), 'calendar');
}

/**
 * Answer one request for the demo forum host.
 * @returns {{ status: number, type: string, body: string }|null} null when the
 *   URL is not the demo forum (the caller lets it through unchanged).
 */
function respond(url, now = Date.now()) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.hostname !== HOST) return null;
  const html = (body, status = 200) => ({ status, type: 'text/html; charset=utf-8', body });
  const path = u.pathname.replace(/\/+$/, '/') || '/';

  if (path.startsWith('/calendar/') && u.searchParams.get('do') === 'download') {
    return { status: 200, type: 'text/calendar; charset=utf-8', body: cal.feed(cal.FORUM_FEED, now) };
  }
  if (path === '/' ) return html(renderIndex(now));
  if (path.startsWith('/calendar')) return html(renderCalendar(now));
  let m = path.match(/^\/forum\/(\d+)/);
  if (m) { const r = renderForum(Number(m[1]), now); if (r) return html(r); }
  m = path.match(/^\/topic\/(\d+)/);
  if (m) { const r = renderTopic(Number(m[1]), now); if (r) return html(r); }
  if (path.startsWith('/login')) return html(renderIndex(now));
  return html(page('Not found', [['Home', `${BASE}/`], ['Not found', null]],
    `<div class="box"><div class="head"><div><h2 style="all:unset;font-size:20px;font-weight:700">Sorry, we couldn't find that!</h2><div style="color:var(--muted)">The page may have moved. <a href="${BASE}/">Back to the forums</a>.</div></div></div></div>`, sidebar(now)), 404);
}

module.exports = { HOST, BASE, respond };
