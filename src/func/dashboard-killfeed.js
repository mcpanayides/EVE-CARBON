// ─── Killfeed dashboard widget ────────────────────────────────────────────────
// A chronological feed of killmails — newest first — for one of three subjects,
// chosen when the widget is added:
//
//   all           every character you have added, merged into one feed
//   char:<id>     one of your characters
//   corp:<id>     ANY corporation, found by name or ticker
//
// Distinct from TOP KILLS · 90 DAYS next door, which is a marquee of your most
// VALUABLE kills. This one is ordered by time and answers "what just happened",
// which is the question a feed exists for.
//
// ── On zKillboard ────────────────────────────────────────────────────────────
// Every row comes from get-zkill-feed, the same main-process fetch the Killboard
// page uses: 10-minute cache, 30-day stale fallback, one shape of row. zKill is
// a free service that asks consumers to cache hard, so this deliberately opens
// no second route to it and adds no request a Killboard visit would not.
// Instances sharing a subject are fetched once (see the byKey grouping below),
// and the poll interval is the cache TTL rather than anything faster.
//
// These files share ONE global scope (scripts/lint.js enforces it), hence the
// _kf / kf prefixes.

const KF_POLL_MS = 10 * 60 * 1000;   // the zKill cache TTL — no point asking sooner
const KF_ROWS    = 14;               // fetched per subject; the tile shows what fits
let _kfTimer = null;
let _kfNames = {};                   // id → name, shared across every instance

// ── Per-instance subject ──────────────────────────────────────────────────────
// Stored as { v, label }: a searched corporation's NAME cannot be recovered from
// its id without another ESI round trip, and the widget needs it to title itself
// before the first fetch resolves.
const KF_KEY = 'dashboardKillFeed';

function _kfMap() {
  try {
    const m = JSON.parse(localStorage.getItem(KF_KEY) || '{}');
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch (_) { return {}; }
}
function _kfGet(instId) {
  const v = _kfMap()[instId];
  if (!v) return null;
  // Tolerate the bare-string shape in case anything ever wrote one.
  return typeof v === 'string' ? { v, label: null } : v;
}
function kfSetSubject(instId, value, label) {
  try {
    const m = _kfMap();
    if (value != null) m[instId] = { v: String(value), label: label || null };
    else delete m[instId];
    localStorage.setItem(KF_KEY, JSON.stringify(m));
  } catch (_) {}
}
function kfForgetSubject(instId) {
  if (String(instId).split('~')[0] === 'killFeed') kfSetSubject(instId, null);
}

/**
 * The zKill entities a stored subject fans out to.
 * Mirrors the Killboard page's _kbEntities so both agree on what a subject means.
 */
function kfEntities(subject, accounts) {
  const v = subject && subject.v;
  if (!v) return [];
  if (v === 'all') return (accounts || []).map(a => ({ kind: 'character', id: Number(a.characterId) }));
  const [kind, id] = String(v).split(':');
  if (kind === 'char' && id) return [{ kind: 'character',   id: Number(id) }];
  if (kind === 'corp' && id) return [{ kind: 'corporation', id: Number(id) }];
  return [];
}

/** Merge several zKill feeds into one, newest first. */
function kfMerge(feeds, limit) {
  const seen = new Set();
  const out  = [];
  for (const rows of (feeds || [])) {
    for (const k of (rows || [])) {
      // The same killmail reaches two of your characters when they were both on
      // it. One row, not two.
      if (!k || seen.has(k.killmailId)) continue;
      seen.add(k.killmailId);
      out.push(k);
    }
  }
  return out
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, limit || KF_ROWS);
}

/** "3m", "4h", "6d" — a feed is read by how recent, not by the date. */
function kfAgo(iso, now) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, ((now || Date.now()) - t) / 1000);
  if (s < 60)      return `${Math.floor(s)}s`;
  if (s < 3600)    return `${Math.floor(s / 60)}m`;
  if (s < 86400)   return `${Math.floor(s / 3600)}h`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 2592000)}mo`;
}

// ── The pickable subjects ─────────────────────────────────────────────────────
async function kfOptions() {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  const list = Array.isArray(accounts) ? accounts : [];
  return (list.length > 1 ? [{ value: 'all', label: 'All characters', icon: 'groups' }] : [])
    .concat(list.map(a => ({
      value: `char:${a.characterId}`,
      label: a.characterName || `Char ${a.characterId}`,
      icon:  'person',
    })));
}

/**
 * Find a corporation by name or ticker.
 *
 * /universe/ids, not /search. CCP removed the PUBLIC search endpoint (it is
 * absent from /meta/openapi.json), and the one that replaced it —
 * /characters/{id}/search — is authenticated and needs esi-search.search_
 * structures.v1, a scope this app does not hold and cannot add without every
 * existing user re-authorising. /universe/ids needs no scope at all and matches
 * a corporation by its full name OR its ticker, case-insensitively.
 *
 * The trade is that it is exact-match, not type-ahead: "goonwaffe" resolves,
 * "goonw" does not. The placeholder says so rather than leaving you to guess why
 * a half-typed name finds nothing.
 */
async function kfSearchCorps(query) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];
  let data;
  try {
    const res = await fetch(Esi.url('/universe/ids'), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify([q]),
    });
    if (!res.ok) return [];
    data = await res.json();
  } catch (_) { return []; }

  const corps = (data && data.corporations) || [];
  const out = corps.map(c => ({ value: `corp:${c.id}`, label: c.name, icon: 'corporate_fare' }));

  // An alliance name is the likeliest near-miss — "Goonswarm Federation" is an
  // alliance, and typing it and getting silence would read as a broken search.
  // zKill has alliance feeds but this widget does not, so say so plainly.
  const alliances = (data && data.alliances) || [];
  if (!out.length && alliances.length) {
    return [{ value: '', label: `${alliances[0].name} is an alliance, not a corporation`, icon: 'info', disabled: true }];
  }
  return out;
}

// ── Title ─────────────────────────────────────────────────────────────────────
function kfTitle(instId) {
  const s = _kfGet(instId);
  if (!s) return 'KILLFEED';
  if (s.v === 'all') return 'KILLFEED · ALL CHARACTERS';
  if (s.label) return `KILLFEED · ${String(s.label).toUpperCase()}`;
  const [kind, id] = String(s.v).split(':');
  return `KILLFEED · ${kind === 'corp' ? 'CORP' : 'CHAR'} ${id || ''}`.trim();
}

// ── Render ────────────────────────────────────────────────────────────────────
function _kfName(id) { return (id && _kfNames[id]) || '—'; }

function kfRowHtml(k, now) {
  // On a kill we name what was shot; on a loss, who landed the final blow — the
  // same reading the Killboard page uses, so a row means the same in both.
  const otherId = k.isLoss ? k.finalBlowCharId : k.victimCharId;
  const shipId  = k.victimShipTypeId;
  return `<a class="kf-row ${k.isLoss ? 'is-loss' : 'is-kill'}" href="#" data-km="${k.killmailId}"
             title="${k.isLoss ? 'Loss' : 'Kill'} · ${escHtml(_kfName(k.systemId))} · ${escHtml(formatISK(k.totalValue))}">
    <img class="kf-ship" src="https://images.evetech.net/types/${shipId}/icon?size=32" alt="" loading="lazy"
         onerror="this.style.visibility='hidden'">
    <span class="kf-main">
      <span class="kf-ship-name">${escHtml(_kfName(shipId))}</span>
      <span class="kf-sub">${k.isLoss ? 'lost to' : 'killed'} ${escHtml(_kfName(otherId))}${
        k.attackerCount > 1 ? ` <span class="kf-dim">+${k.attackerCount - 1}</span>` : ''} · ${escHtml(_kfName(k.systemId))}</span>
    </span>
    <span class="kf-right">
      <span class="kf-isk">${escHtml(formatISK(k.totalValue))}</span>
      <span class="kf-age">${kfAgo(k.time, now)}</span>
    </span>
  </a>`;
}

async function _kfRenderInstance(body, rows) {
  if (!rows) {
    body.innerHTML = '<div class="dashboard-empty dash-widget-failed">Couldn’t reach zKillboard. It retries on its own.</div>';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<div class="dashboard-empty">No killmails in the last pages of this feed.</div>';
    return;
  }
  const now = Date.now();
  body.innerHTML = `<div class="kf-list">${rows.map(k => kfRowHtml(k, now)).join('')}</div>`;
  body.querySelectorAll('.kf-row').forEach(r => {
    r.addEventListener('click', (e) => {
      e.preventDefault();
      // Same helper the Killboard page's rows use (_kbOpen).
      try { window.eveAPI.openExternalUrl(`https://zkillboard.com/kill/${r.dataset.km}/`); } catch (_) {}
    });
  });
}

async function renderAllKillFeeds(accounts) {
  const panels = document.querySelectorAll(
    '#dashboardGrid [data-widget-base="killFeed"], #dashPopoutHost [data-widget-base="killFeed"]');
  if (!panels.length) return;

  // Instances watching the same subject fetch once. Two feeds on the same corp
  // should not be two rounds of requests to a free service.
  const byKey = new Map();
  panels.forEach(p => {
    const s   = _kfGet(p.dataset.widgetId);
    const key = s ? s.v : 'all';
    if (!byKey.has(key)) byKey.set(key, { subject: s || { v: 'all' }, panels: [] });
    byKey.get(key).panels.push(p);
  });

  await Promise.all([...byKey.values()].map(async ({ subject, panels: group }) => {
    const bodies   = group.map(p => p.querySelector('.dashboard-widget-body')).filter(Boolean);
    const entities = kfEntities(subject, accounts);
    if (!entities.length) {
      bodies.forEach(b => {
        b.innerHTML = '<div class="dashboard-empty">That subject is gone. Remove this widget and add another.</div>';
      });
      return;
    }

    let feeds;
    try {
      feeds = await Promise.all(entities.map(e =>
        window.eveAPI.getZkillFeed(e.kind, e.id, 1).catch(() => null)));
    } catch (_) { feeds = null; }

    // Every entity failing is an outage; some failing is one character with no
    // killboard, which is not worth blanking the tile over.
    if (!feeds || feeds.every(f => f == null)) {
      bodies.forEach(b => _kfRenderInstance(b, null));
      return;
    }

    const rows = kfMerge(feeds, KF_ROWS);
    await _kfResolveNames(rows);
    bodies.forEach(b => _kfRenderInstance(b, rows));
  }));
}

// Ship types, systems and pilots, in one batch for everything on screen.
async function _kfResolveNames(rows) {
  const want = new Set();
  for (const k of rows) {
    [k.victimShipTypeId, k.systemId, k.isLoss ? k.finalBlowCharId : k.victimCharId]
      .forEach(id => { if (id && !_kfNames[id]) want.add(id); });
  }
  if (!want.size) return;
  try {
    const r = await window.eveAPI.getNames([...want]);
    if (Array.isArray(r)) r.forEach(n => { if (n && n.id) _kfNames[n.id] = n.name; });
    else if (r && typeof r === 'object') Object.assign(_kfNames, r);
  } catch (_) { /* rows fall back to "—"; the next pass retries */ }
}

// Paint now, then keep to zKill's own cache cadence. The timer stops itself once
// the last feed leaves the grid.
function initKillFeedWidgets(accounts) {
  renderAllKillFeeds(accounts).catch(() => {});
  if (_kfTimer) clearInterval(_kfTimer);
  _kfTimer = setInterval(async () => {
    if (!document.querySelector('#dashboardGrid [data-widget-base="killFeed"], #dashPopoutHost [data-widget-base="killFeed"]')) {
      clearInterval(_kfTimer); _kfTimer = null; return;
    }
    const accs = await window.eveAPI.getAccounts().catch(() => []);
    renderAllKillFeeds(Array.isArray(accs) ? accs : []).catch(() => {});
  }, KF_POLL_MS);
}
