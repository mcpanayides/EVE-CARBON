// ─── calendar.js — Calendar page: ICS feeds + IP.Board forum events ─────────────
// Aggregates events from configured iCal feed URLs, the alliance IP.Board forum
// (via its personal iCal feed and/or an authenticated login session), and
// one-off imported .ics files. Read-only month grid + agenda, times shown in
// both EVE/UTC and local. Pure ICS parsing lives in window.IcsParse.

// ── State ──────────────────────────────────────────────────────────────────────
let _calCfg       = { forumBaseUrl: '', feeds: [], extraFeeds: [], useSession: false };
let _calSources   = [];     // [{ label, color, events:[parsed], kind:'forum'|'feed'|'file' }]
let _calMonth     = _calFirstOfMonth(new Date());
let _calView      = 'month';
let _calSourceVis = {};     // label → visible bool
let _calLoading   = false;

const CAL_COLORS = ['#5b9bd5', '#4ecbb0', '#e3a84d', '#c05c7e', '#ab7ab8', '#7fb069', '#d9655b', '#8f9bb3'];
const CAL_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CAL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Helpers ─────────────────────────────────────────────────────────────────────
function _calFirstOfMonth(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
function _calPad(n) { return String(n).padStart(2, '0'); }
function _calSameUTCDay(a, b) {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}
function _calFmtEve(d)   { return `${d.getUTCFullYear()}-${_calPad(d.getUTCMonth() + 1)}-${_calPad(d.getUTCDate())} ${_calPad(d.getUTCHours())}:${_calPad(d.getUTCMinutes())}`; }
function _calFmtEveTime(d) { return `${_calPad(d.getUTCHours())}:${_calPad(d.getUTCMinutes())}`; }
function _calFmtLocal(d) { return d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
// "2026-06-25 18:00 EVE · 25/06 11:00 local"
function _calFmtEveLocal(d, allDay) {
  if (allDay) return `${d.getUTCFullYear()}-${_calPad(d.getUTCMonth() + 1)}-${_calPad(d.getUTCDate())} (all day)`;
  return `${_calFmtEve(d)} EVE · ${_calFmtLocal(d)} local`;
}

// ── Entry point ─────────────────────────────────────────────────────────────────
async function renderCalendar() {
  const page = document.getElementById('page-calendar');
  if (!page) return;
  let body = document.getElementById('calendarBody');
  if (!body) return;

  body.innerHTML = `
    <div class="cal-toolbar">
      <div class="cal-nav">
        <button class="cal-btn" id="calPrev" title="Previous month">‹</button>
        <span class="cal-title" id="calTitle"></span>
        <button class="cal-btn" id="calNext" title="Next month">›</button>
        <button class="cal-btn cal-today" id="calToday">Today</button>
      </div>
      <div class="cal-views">
        <button class="cal-view-btn" data-cal-view="month">Month</button>
        <button class="cal-view-btn" data-cal-view="agenda">Agenda</button>
      </div>
      <div class="cal-actions">
        <span class="cal-legend" id="calLegend"></span>
        <button class="cal-btn" id="calRefresh" title="Reload feeds">⟳ Refresh</button>
      </div>
    </div>
    <div id="calContent" class="cal-content"></div>`;

  body.querySelector('#calPrev').addEventListener('click', () => { _calMonth = new Date(Date.UTC(_calMonth.getUTCFullYear(), _calMonth.getUTCMonth() - 1, 1)); _calRender(); });
  body.querySelector('#calNext').addEventListener('click', () => { _calMonth = new Date(Date.UTC(_calMonth.getUTCFullYear(), _calMonth.getUTCMonth() + 1, 1)); _calRender(); });
  body.querySelector('#calToday').addEventListener('click', () => { _calMonth = _calFirstOfMonth(new Date()); _calRender(); });
  body.querySelectorAll('.cal-view-btn').forEach(b => b.addEventListener('click', () => { _calView = b.dataset.calView; _calRender(); }));
  body.querySelector('#calRefresh').addEventListener('click', () => _calLoadEvents().then(_calRender));

  _calRender();                 // paint shell immediately (empty)
  await _calLoadConfig();

  // Stale-while-revalidate: paint last session's events instantly from the
  // persistent cache, then refresh feeds/timers in the background and update.
  try {
    const cached = await window.eveAPI.cacheGet('calendar_sources_v1');
    if (Array.isArray(cached) && cached.length) {
      _calSources = _calReviveSources(cached);
      _calSources.forEach(s => { if (_calSourceVis[s.label] === undefined) _calSourceVis[s.label] = true; });
      _calRender();
    }
  } catch (_) { /* no cache yet */ }

  await _calLoadEvents();        // fresh pull (feeds/PI/jobs, now in parallel)
  window.eveAPI.cacheSet('calendar_sources_v1', _calSources, 1 / 24).catch(() => {}); // 1h TTL
  _calRender();
}

// Cached sources serialize Dates to ISO strings — turn start/end back into Dates.
function _calReviveSources(arr) {
  return arr.map(s => ({
    ...s,
    events: (s.events || []).map(e => ({
      ...e,
      start: e.start ? new Date(e.start) : null,
      end:   e.end   ? new Date(e.end)   : null,
    })),
  }));
}

async function _calLoadConfig() {
  try {
    const cfg = await window.eveAPI.getAppConfig();
    const app = (cfg && cfg.app) || {};
    const c = app.calendar || {};
    _calCfg = {
      forumBaseUrl: c.forumBaseUrl || '',
      // The Forums page stores its own URL (app.forum.url); fall back to the
      // calendar's forum base. Used to detect a goonfleet.com forum for scraping.
      forumUrl:     (app.forum && app.forum.url) || c.forumBaseUrl || '',
      feeds:        Array.isArray(c.feeds) ? c.feeds : [],
      extraFeeds:   Array.isArray(c.extraFeeds) ? c.extraFeeds : [],
      useSession:   !!c.useSession,
      showPi:       c.showPi   !== false,   // default on
      showJobs:     c.showJobs !== false,   // default on
    };
  } catch (_) {}
}

// Imported .ics files are persisted in localStorage (raw text + a user label so
// you can tell e.g. Capital Ops from Regular Ops). Managed from Settings.
const CAL_IMPORTS_KEY = 'eve-carbon-calendar-imports';
function _calGetImports() {
  try { const a = JSON.parse(localStorage.getItem(CAL_IMPORTS_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}
function _calSaveImports(arr) { try { localStorage.setItem(CAL_IMPORTS_KEY, JSON.stringify(arr)); } catch (_) {} }

// Build every event source: configured feeds, imported .ics, and the EVE auto
// timers (PI extractions + industry job completions).
async function _calLoadEvents() {
  if (_calLoading) return;
  _calLoading = true;
  const refreshBtn = document.getElementById('calRefresh');
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '⟳ …'; }

  let colorIdx = 0;
  const addColor = () => CAL_COLORS[colorIdx++ % CAL_COLORS.length];

  // Kick every network source off at once (feeds, PI, jobs) rather than awaiting
  // them one-by-one — colours are assigned up front so order stays stable.
  const tasks = [];
  for (const url of (_calCfg.feeds || []).filter(Boolean)) {
    tasks.push(_calFetchSource(url, true, _calLabelFor(url, 'Forum'), addColor()));
  }
  for (const url of (_calCfg.extraFeeds || []).filter(Boolean)) {
    tasks.push(_calFetchSource(url, false, _calLabelFor(url, 'Feed'), addColor()));
  }
  if (_calCfg.showPi)   tasks.push(_calBuildPiSource(addColor()));
  if (_calCfg.showJobs) tasks.push(_calBuildJobsSource(addColor()));
  // goonfleet.com surfaces alliance events + moon extractions on its forum index —
  // scrape them (returns up to two sources: events and moons).
  if (_calIsGoon()) tasks.push(_calBuildGoonSource(addColor(), addColor()));

  // Imported .ics files are local — parse them synchronously, no network wait.
  const importSources = _calGetImports().map(imp => {
    let events = [];
    try { events = window.IcsParse.parseIcs(imp.ics || ''); } catch (_) {}
    return { label: imp.label || imp.name || 'Imported', color: addColor(), kind: 'file', events };
  });

  // .flat() because a builder may return several sources (the goon scrape returns
  // separate Events and Moon-Extraction sources so each can be toggled on its own).
  const settled = (await Promise.all(tasks)).flat();
  _calSources = [...settled, ...importSources].filter(Boolean);
  _calSources.forEach(s => { if (_calSourceVis[s.label] === undefined) _calSourceVis[s.label] = true; });

  _calLoading = false;
  if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '⟳ Refresh'; }
}

// Gather all characters' PI colonies → an event at each colony's extractor expiry.
async function _calBuildPiSource(color) {
  try {
    const accounts = await window.eveAPI.getAccounts() || {};
    const list = Array.isArray(accounts) ? accounts : Object.entries(accounts).map(([id, a]) => ({ characterId: id, characterName: a.characterName }));
    const events = [];
    await Promise.all(list.map(async acc => {
      const charId = acc.characterId ?? acc.character_id ?? acc.id;
      const name = acc.characterName || `Char ${charId}`;
      let cols = [];
      try { cols = await window.eveAPI.getPIColonies(charId) || []; } catch (_) {}
      for (const col of cols) {
        const exp = col.extractor_expires_at;
        if (!exp) continue;
        const where = [col.planet_type ? _calCap(col.planet_type) : null, col.solar_system_name].filter(Boolean).join(' · ');
        const d = new Date(exp);
        events.push({ uid: `pi-${charId}-${col.planet_id}`, summary: `⛏ PI extraction ends — ${where || 'colony'}`,
          description: `Extractor heads finish on ${name}'s colony. Reset the extraction to keep it running.`,
          start: d, end: d, allDay: false });
      }
    }));
    return events.length ? { label: 'PI Extractions', color, kind: 'pi', events } : null;
  } catch (_) { return null; }
}

// Gather all characters' active industry jobs → an event at each job's finish time.
async function _calBuildJobsSource(color) {
  try {
    const accounts = await window.eveAPI.getAccounts() || {};
    const list = Array.isArray(accounts) ? accounts : Object.entries(accounts).map(([id, a]) => ({ characterId: id, characterName: a.characterName }));
    const jobs = [];
    await Promise.all(list.map(async acc => {
      const charId = acc.characterId ?? acc.character_id ?? acc.id;
      const name = acc.characterName || `Char ${charId}`;
      let js = [];
      try { js = await window.eveAPI.getCharacterActiveJobs(charId) || []; } catch (_) {}
      js.forEach(j => { if (j.end_date) jobs.push({ ...j, _charName: name }); });
    }));
    if (!jobs.length) return null;

    // Resolve product/blueprint type names in one batch.
    const ids = [...new Set(jobs.flatMap(j => [j.product_type_id, j.blueprint_type_id].filter(Boolean)))];
    let names = {};
    try { (await window.eveAPI.getNames(ids) || []).forEach(n => { names[n.id] = n.name; }); } catch (_) {}

    const ACT = { 1: 'Manufacturing', 3: 'TE Research', 4: 'ME Research', 5: 'Copying', 8: 'Invention', 11: 'Reaction' };
    const events = jobs.map(j => {
      const tid = j.product_type_id || j.blueprint_type_id;
      const item = (tid && names[tid]) || (tid ? `Type ${tid}` : 'Job');
      const act = ACT[j.activity_id] || 'Industry job';
      const d = new Date(j.end_date);
      return { uid: `job-${j.job_id || j.jobID || (j.character_id + '-' + j.end_date)}`,
        summary: `🏭 ${item} ready — ${act}`,
        description: `${act} job finishes on ${j._charName}. ${j.runs ? j.runs + ' run(s).' : ''}`.trim(),
        start: d, end: d, allDay: false,
        // Structured payload powering the rich industry-job popup (see _calOpenEvent).
        _job: { typeId: tid || null, item, activity: act, runs: j.runs || null, character: j._charName || '', end: d } };
    });
    return { label: 'Industry Jobs', color, kind: 'jobs', events };
  } catch (_) { return null; }
}

function _calCap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }

// ── Goonfleet forum scrape (alliance events + moon extractions) ──────────────────
// When the configured forum is goonfleet.com, its forum index shows two member-only
// blocks — "Upcoming Events" and "Upcoming Moon Extractions". We scrape those
// (main process, through the logged-in forum session) and surface them as calendar
// sources. The times in those tables are EVE/UTC.
function _calNormUrl(u) {
  u = String(u || '').trim();
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
function _calIsGoon() {
  try { return /(^|\.)goonfleet\.com$/i.test(new URL(_calNormUrl(_calCfg.forumUrl)).hostname); }
  catch (_) { return false; }
}
function _calSlug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
// Parse "YYYY-MM-DD HH:MM[:SS]" (EVE/UTC) → Date, or null if unparseable.
function _calParseEveTs(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  return isNaN(d.getTime()) ? null : d;
}

// The 20 moon-ore types → type IDs, for EVE item icons in the extraction popup.
const _CAL_MOON_ORE_IDS = {
  bitumens: 45492, coesite: 45493, sylvite: 45491, zeolites: 45490,         // ubiquitous
  cobaltite: 45494, euxenite: 45495, scheelite: 45497, titanite: 45496,     // common
  chromite: 45501, otavite: 45498, sperrylite: 45499, vanadinite: 45500,    // uncommon
  carnotite: 45502, cinnabar: 45506, pollucite: 45504, zircon: 45503,       // rare
  loparite: 45512, monazite: 45511, xenotime: 45510, ytterbite: 45513,      // exceptional
};
function _calMoonOreId(name) { return _CAL_MOON_ORE_IDS[String(name || '').trim().toLowerCase()] || null; }

// "Sylvite: 27.48%, Zeolites: 52.52%" → [{ ore, pct, typeId }] sorted high→low.
function _calParseComposition(str) {
  const out = [];
  const re = /([A-Za-z][A-Za-z ]*?):\s*([\d.]+)\s*%/g;
  let m;
  while ((m = re.exec(String(str || '')))) {
    const ore = m[1].trim();
    out.push({ ore, pct: parseFloat(m[2]) || 0, typeId: _calMoonOreId(ore) });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

// Returns an array of 0–2 sources: alliance events and/or moon extractions.
async function _calBuildGoonSource(eventColor, moonColor) {
  // The member blocks only render for a logged-in session — skip the scrape (and
  // the hidden window it spawns) entirely when logged out.
  try { const s = await window.eveAPI.forumSessionStatus(); if (!s || !s.loggedIn) return []; }
  catch (_) { return []; }

  let data;
  try { data = await window.eveAPI.scrapeForumEvents(_calNormUrl(_calCfg.forumUrl)); }
  catch (e) { console.warn('[calendar] goon scrape failed:', e?.message); return []; }
  if (!data) return [];

  const url = data.url || _calNormUrl(_calCfg.forumUrl);
  const sources = [];

  const eventEvents = [];
  for (const e of (data.events || [])) {
    const start = _calParseEveTs(e.start);
    if (!start) continue;
    eventEvents.push({
      uid: `goon-evt-${_calSlug(e.title)}-${start.getTime()}`,
      summary: `📣 ${e.title}`,
      description: `Alliance event from the goonfleet.com forum.${e.timeToEvent ? `\nStarts in ${e.timeToEvent}.` : ''}`,
      start, end: start, allDay: false, url,
    });
  }
  if (eventEvents.length) sources.push({ label: 'GSF Events', color: eventColor, kind: 'forum', events: eventEvents });

  const moonEvents = [];
  for (const m of (data.moons || [])) {
    const start = _calParseEveTs(m.arrival);
    if (!start) continue;
    const desc = [
      m.region      ? `Region: ${m.region}` : null,
      m.autofrack   ? `Auto-fracture: ${m.autofrack} EVE` : null,
      m.composition ? `Composition: ${m.composition}` : null,
    ].filter(Boolean).join('\n');
    moonEvents.push({
      uid: `goon-moon-${_calSlug(m.moon)}-${start.getTime()}`,
      summary: `🌙 ${m.moon} — extraction arrives`,
      description: desc || 'Moon extraction.',
      start, end: start, allDay: false, url,
      // Structured payload powering the rich extraction popup (see _calOpenEvent).
      _moon: {
        name:      m.moon,
        system:    String(m.moon || '').trim().split(/\s+/)[0] || '',   // "MJ-LGH VI - Moon 16" → "MJ-LGH"
        region:    m.region || '',
        arrival:   start,
        autofrack: _calParseEveTs(m.autofrack),
        comp:      _calParseComposition(m.composition),
      },
    });
  }
  if (moonEvents.length) sources.push({ label: 'GSF Moon Extractions', color: moonColor, kind: 'forum', events: moonEvents });

  return sources;
}

function _calLabelFor(url, fallback) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return fallback; }
}

async function _calFetchSource(url, isForum, label, color) {
  try {
    const fn = (isForum && _calCfg.useSession && window.eveAPI.forumFetchText)
      ? window.eveAPI.forumFetchText : window.eveAPI.httpGetText;
    const text = await fn(url);
    const events = window.IcsParse.parseIcs(text);
    return { label: (isForum ? 'Forum · ' : '') + label, color, kind: isForum ? 'forum' : 'feed', events, url };
  } catch (e) {
    console.warn('[calendar] feed failed:', url, e?.message);
    showToast(`Calendar feed failed: ${label}`, 'error');
    return { label: (isForum ? 'Forum · ' : '') + label, color, kind: isForum ? 'forum' : 'feed', events: [], url, error: true };
  }
}

// Read a local .ics file into a session-only source.
function _calOnFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const events = window.IcsParse.parseIcs(String(reader.result || ''));
      const color = CAL_COLORS[_calSources.length % CAL_COLORS.length];
      const label = file.name.replace(/\.ics$/i, '');
      _calSources.push({ label, color, kind: 'file', events });
      _calSourceVis[label] = true;
      showToast(`Imported ${events.length} event${events.length === 1 ? '' : 's'} from ${file.name}.`, 'success');
      _calRender();
    } catch (err) {
      showToast('Could not parse that .ics file.', 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// All visible occurrences overlapping [start,end), flattened from every source.
function _calOccurrences(rangeStart, rangeEnd) {
  const out = [];
  for (const src of _calSources) {
    if (!_calSourceVis[src.label]) continue;
    for (const ev of src.events) {
      for (const occ of window.IcsParse.expandRecurring(ev, rangeStart, rangeEnd)) {
        out.push({ ...occ, _label: src.label, _color: src.color });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ── Render ───────────────────────────────────────────────────────────────────────
function _calRender() {
  const titleEl = document.getElementById('calTitle');
  if (titleEl) titleEl.textContent = `${CAL_MONTHS[_calMonth.getUTCMonth()]} ${_calMonth.getUTCFullYear()}`;
  document.querySelectorAll('.cal-view-btn').forEach(b => b.classList.toggle('active', b.dataset.calView === _calView));
  _calRenderLegend();

  const content = document.getElementById('calContent');
  if (!content) return;
  if (_calView === 'agenda') _calRenderAgenda(content);
  else _calRenderMonth(content);
}

function _calRenderLegend() {
  const el = document.getElementById('calLegend');
  if (!el) return;
  if (!_calSources.length) { el.innerHTML = '<span class="cal-legend-empty">No sources — add feeds in Settings → Calendar</span>'; return; }
  el.innerHTML = _calSources.map(s => `
    <button class="cal-legend-item ${_calSourceVis[s.label] ? '' : 'off'}" data-cal-src="${escHtml(s.label)}" title="Toggle">
      <span class="cal-legend-dot" style="background:${s.color};"></span>${escHtml(s.label)}
    </button>`).join('');
  el.querySelectorAll('.cal-legend-item').forEach(b => b.addEventListener('click', () => {
    const lbl = b.dataset.calSrc; _calSourceVis[lbl] = !_calSourceVis[lbl]; _calRender();
  }));
}

function _calRenderMonth(content) {
  const year = _calMonth.getUTCFullYear(), month = _calMonth.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  // Grid starts Monday.
  const startOffset = (first.getUTCDay() + 6) % 7;
  const gridStart = new Date(Date.UTC(year, month, 1 - startOffset));
  const weeks = 6;
  const gridEnd = new Date(gridStart.getTime() + weeks * 7 * 86400000);
  const today = new Date();
  const occ = _calOccurrences(gridStart, gridEnd);

  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const day = new Date(gridStart.getTime() + i * 86400000);
    const inMonth = day.getUTCMonth() === month;
    const isToday = _calSameUTCDay(day, today);
    const dayEvents = occ.filter(e => _calEventOnDay(e, day));
    const chips = dayEvents.slice(0, 4).map((e, idx) => `
      <div class="cal-chip" data-cal-occ="${_calOccKey(e)}" style="border-left-color:${e._color};">
        <span class="cal-chip-time">${e.allDay ? '' : _calFmtEveTime(e.start)}</span>${escHtml(e.summary || '(untitled)')}
      </div>`).join('');
    const more = dayEvents.length > 4 ? `<div class="cal-more">+${dayEvents.length - 4} more</div>` : '';
    cells += `
      <div class="cal-cell ${inMonth ? '' : 'cal-cell-dim'} ${isToday ? 'cal-cell-today' : ''}">
        <div class="cal-cell-num">${day.getUTCDate()}</div>
        ${chips}${more}
      </div>`;
  }

  content.innerHTML = `
    <div class="cal-weekhdr">${CAL_WEEKDAYS.map(d => `<div>${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>`;
  _calBindOccClicks(content, gridStart, gridEnd);
}

function _calRenderAgenda(content) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 86400000);   // next 60 days
  const occ = _calOccurrences(start, end);
  if (!occ.length) {
    content.innerHTML = `<div class="cal-empty">No upcoming events in the next 60 days.</div>`;
    return;
  }
  // Group by UTC day
  const groups = [];
  let curKey = null, cur = null;
  for (const e of occ) {
    const key = `${e.start.getUTCFullYear()}-${e.start.getUTCMonth()}-${e.start.getUTCDate()}`;
    if (key !== curKey) { curKey = key; cur = { day: e.start, items: [] }; groups.push(cur); }
    cur.items.push(e);
  }
  content.innerHTML = `<div class="cal-agenda">${groups.map(g => `
    <div class="cal-agenda-day">
      <div class="cal-agenda-date">${CAL_WEEKDAYS[(g.day.getUTCDay() + 6) % 7]} ${g.day.getUTCDate()} ${CAL_MONTHS[g.day.getUTCMonth()].slice(0,3)}</div>
      <div class="cal-agenda-items">
        ${g.items.map(e => `
          <div class="cal-agenda-item" data-cal-occ="${_calOccKey(e)}">
            <span class="cal-agenda-dot" style="background:${e._color};"></span>
            <span class="cal-agenda-time">${e.allDay ? 'All day' : _calFmtEveTime(e.start) + ' EVE'}</span>
            <span class="cal-agenda-title">${escHtml(e.summary || '(untitled)')}</span>
            <span class="cal-agenda-src">${escHtml(e._label)}</span>
          </div>`).join('')}
      </div>
    </div>`).join('')}</div>`;
  _calBindOccClicks(content, start, end);
}

function _calEventOnDay(e, day) {
  const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const dayEnd = dayStart + 86400000;
  const s = e.start.getTime();
  const en = (e.end ? e.end.getTime() : s);
  return s < dayEnd && en > dayStart;
}

function _calOccKey(e) { return `${e.uid || ''}|${e.start.getTime()}`; }

// Rebuild the occurrence list for the current window and open a detail popover.
function _calBindOccClicks(content, rangeStart, rangeEnd) {
  const occ = _calOccurrences(rangeStart, rangeEnd);
  const byKey = new Map(occ.map(e => [_calOccKey(e), e]));
  content.querySelectorAll('[data-cal-occ]').forEach(el => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const e = byKey.get(el.dataset.calOcc);
    if (e) _calOpenEvent(e);
  }));
}

function _calOpenEvent(e) {
  document.getElementById('calEventModal')?.remove();
  const back = document.createElement('div');
  back.id = 'calEventModal';
  back.className = 'cal-modal-backdrop';
  back.innerHTML = e._moon ? _calMoonModalInner(e)
                 : e._job  ? _calJobModalInner(e)
                 :           _calGenericModalInner(e);
  document.body.appendChild(back);

  // Common: close button + backdrop click.
  back.querySelector('#calModalClose')?.addEventListener('click', () => back.remove());
  back.addEventListener('click', ev => { if (ev.target === back) back.remove(); });

  const openForum = (ev) => {
    ev.preventDefault();
    if (window.eveAPI && window.eveAPI.openExternalUrl) window.eveAPI.openExternalUrl(e.url);
    else window.open(e.url, '_blank');
  };
  back.querySelector('#calModalLink')?.addEventListener('click', openForum);
  back.querySelector('#calMoonForumBtn')?.addEventListener('click', openForum);

  // Moon: "View on map" → jump to the system and close.
  back.querySelector('#calMoonMapBtn')?.addEventListener('click', () => {
    back.remove();
    if (typeof mapGoToSystem === 'function') mapGoToSystem(e._moon.system);
  });
}

function _calGenericModalInner(e) {
  const endStr = e.end && !e.allDay && e.end - e.start > 0 ? ` → ${_calFmtEveTime(e.end)} EVE` : '';
  return `
    <div class="cal-modal">
      <div class="cal-modal-head" style="border-left:4px solid ${e._color};">
        <div class="cal-modal-title">${escHtml(e.summary || '(untitled)')}</div>
        <button class="cal-modal-close" id="calModalClose">✕</button>
      </div>
      <div class="cal-modal-body">
        <div class="cal-modal-row"><span class="k">When</span><span class="v">${_calFmtEveLocal(e.start, e.allDay)}${endStr}</span></div>
        ${e.location ? `<div class="cal-modal-row"><span class="k">Where</span><span class="v">${escHtml(e.location)}</span></div>` : ''}
        <div class="cal-modal-row"><span class="k">Source</span><span class="v">${escHtml(e._label)}</span></div>
        ${e.description ? `<div class="cal-modal-desc">${escHtml(e.description)}</div>` : ''}
        ${e.url ? `<a class="cal-modal-link" href="#" id="calModalLink">Open in forum ↗</a>` : ''}
      </div>
    </div>`;
}

// Rich popup for a moon extraction: EVE ore icons + composition bars, arrival /
// auto-fracture times in EVE + local, and a jump-to-system map link.
function _calMoonModalInner(e) {
  const m = e._moon;
  // Dates may arrive as ISO strings after a disk-cache round-trip (only top-level
  // start/end are revived) — coerce back to Date for formatting.
  const toDate = (v) => { if (!v) return null; const d = (v instanceof Date) ? v : new Date(v); return isNaN(d.getTime()) ? null : d; };
  const timeRow = (icon, label, v) => {
    const d = toDate(v);
    return `
    <div class="cal-rich-time">
      <span class="cal-rich-time-k"><span class="material-symbols-outlined">${icon}</span>${label}</span>
      <span class="cal-rich-time-v">${d ? `${_calFmtEve(d)} <em>EVE</em> · ${_calFmtLocal(d)}` : '—'}</span>
    </div>`;
  };

  const comp = (m.comp || []).map(c => {
    const icon = c.typeId
      ? `<img class="cal-ore-icon" src="${ESI_IMAGE}/${c.typeId}/icon?size=32" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>`
      : `<span class="cal-ore-icon cal-ore-icon-blank material-symbols-outlined">diamond</span>`;
    return `
      <div class="cal-ore-row">
        ${icon}
        <span class="cal-ore-name">${escHtml(c.ore)}</span>
        <span class="cal-ore-bar"><span class="cal-ore-bar-fill" style="width:${Math.max(2, Math.min(100, c.pct))}%;"></span></span>
        <span class="cal-ore-pct">${c.pct.toFixed(1)}%</span>
      </div>`;
  }).join('');

  return `
    <div class="cal-modal cal-rich-modal is-moon">
      <div class="cal-modal-head cal-rich-head">
        <span class="cal-rich-badge material-symbols-outlined">dark_mode</span>
        <div class="cal-rich-headtext">
          <div class="cal-modal-title">${escHtml(m.name)}</div>
          <div class="cal-rich-sub">Moon extraction${m.region ? ` · ${escHtml(m.region)}` : ''}</div>
        </div>
        <button class="cal-modal-close" id="calModalClose">✕</button>
      </div>
      <div class="cal-modal-body">
        <div class="cal-rich-times">
          ${timeRow('schedule', 'Chunk arrives', m.arrival)}
          ${timeRow('bolt', 'Auto-fracture', m.autofrack)}
        </div>
        ${comp ? `<div class="cal-moon-comp"><div class="cal-moon-comp-hd">Composition</div>${comp}</div>` : ''}
        <div class="cal-rich-actions">
          ${m.system ? `<button class="cal-rich-btn" id="calMoonMapBtn"><span class="material-symbols-outlined">public</span>View ${escHtml(m.system)} on map</button>` : ''}
          ${e.url ? `<a class="cal-rich-btn cal-rich-btn-ghost" id="calMoonForumBtn" href="#"><span class="material-symbols-outlined">open_in_new</span>Open in forum</a>` : ''}
        </div>
      </div>
    </div>`;
}

// Rich popup for an industry job: the product/blueprint icon, completion time in
// EVE + local, and the activity / runs / character behind it.
function _calJobModalInner(e) {
  const j = e._job;
  const toDate = (v) => { if (!v) return null; const d = (v instanceof Date) ? v : new Date(v); return isNaN(d.getTime()) ? null : d; };
  const done = toDate(j.end || e.start);

  const badge = j.typeId
    ? `<span class="cal-rich-badge"><img src="${ESI_IMAGE}/${j.typeId}/icon?size=64" alt="" loading="lazy" onerror="this.parentNode.classList.add('material-symbols-outlined');this.parentNode.textContent='precision_manufacturing';"/></span>`
    : `<span class="cal-rich-badge material-symbols-outlined">precision_manufacturing</span>`;

  const ACT_ICON = { 'Manufacturing': 'precision_manufacturing', 'TE Research': 'schedule', 'ME Research': 'tune',
                     'Copying': 'content_copy', 'Invention': 'science', 'Reaction': 'experiment' };
  const row = (icon, label, value) => value
    ? `<div class="cal-rich-row"><span class="material-symbols-outlined">${icon}</span><span class="k">${label}</span><span class="v">${escHtml(String(value))}</span></div>`
    : '';

  return `
    <div class="cal-modal cal-rich-modal is-job">
      <div class="cal-modal-head cal-rich-head">
        ${badge}
        <div class="cal-rich-headtext">
          <div class="cal-modal-title">${escHtml(j.item || 'Industry job')}</div>
          <div class="cal-rich-sub">${escHtml(j.activity || 'Industry job')}${j.character ? ` · ${escHtml(j.character)}` : ''}</div>
        </div>
        <button class="cal-modal-close" id="calModalClose">✕</button>
      </div>
      <div class="cal-modal-body">
        <div class="cal-rich-times">
          <div class="cal-rich-time">
            <span class="cal-rich-time-k"><span class="material-symbols-outlined">schedule</span>Completes</span>
            <span class="cal-rich-time-v">${done ? `${_calFmtEve(done)} <em>EVE</em> · ${_calFmtLocal(done)}` : '—'}</span>
          </div>
        </div>
        ${row(ACT_ICON[j.activity] || 'build', 'Activity', j.activity)}
        ${row('tag', 'Runs', j.runs)}
        ${row('person', 'Character', j.character)}
      </div>
    </div>`;
}

// ── Settings panel wiring (Settings → Calendar) ─────────────────────────────────
function gatherCalendarSettings() {
  const lines = id => (document.getElementById(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
  return {
    forumBaseUrl: (document.getElementById('calForumUrl')?.value || '').trim(),
    feeds:        lines('calForumFeeds'),
    extraFeeds:   lines('calExtraFeeds'),
    useSession:   !!document.getElementById('calUseSession')?.checked,
  };
}

async function populateCalendarSettings() {
  try {
    const cfg = await window.eveAPI.getAppConfig();
    const c = (cfg && cfg.app && cfg.app.calendar) || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('calForumUrl', c.forumBaseUrl || '');
    set('calForumFeeds', (c.feeds || []).join('\n'));
    set('calExtraFeeds', (c.extraFeeds || []).join('\n'));
    const chk = document.getElementById('calUseSession'); if (chk) chk.checked = !!c.useSession;
  } catch (_) {}
  _calUpdateLoginStatus();
}

function bindCalendarSettings() {
  const loginBtn = document.getElementById('calForumLoginBtn');
  if (loginBtn && loginBtn.dataset.wired !== '1') {
    loginBtn.dataset.wired = '1';
    loginBtn.addEventListener('click', async () => {
      const base = (document.getElementById('calForumUrl')?.value || '').trim();
      if (!base) { showToast('Enter your forum base URL first.', 'info'); return; }
      loginBtn.disabled = true; loginBtn.textContent = 'Opening login…';
      try {
        await window.eveAPI.forumLogin(base);
        showToast('Forum login window closed — session saved.', 'success');
      } catch (e) {
        showToast('Forum login failed to open.', 'error');
      } finally {
        loginBtn.disabled = false; loginBtn.textContent = 'Log in to forum';
        _calUpdateLoginStatus();
      }
    });
  }
}

async function _calUpdateLoginStatus() {
  const el = document.getElementById('calForumLoginStatus');
  if (!el || !window.eveAPI.forumSessionStatus) return;
  try {
    const s = await window.eveAPI.forumSessionStatus();
    el.textContent = s && s.loggedIn ? 'Session active' : 'Not logged in';
    el.style.color = s && s.loggedIn ? 'var(--success)' : 'var(--text-3)';
  } catch (_) {}
}
