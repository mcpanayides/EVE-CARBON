// ─── Notification feed ────────────────────────────────────────────────────────
// The in-game notification list (structure attacks, war decs, bills, moon
// extractions, insurance payouts…), shown as the second tab of the EVE Mail
// page — the same place the EVE client keeps them.
//
// Read-only by design: ESI has no write route for notifications, so "unread"
// reflects what you've opened in the game client and can't be changed from here.
// Bodies arrive already parsed from YAML by the main process (see notif-get).

let _notifChar   = null;
let _notifItems  = [];
let _notifCat    = 'All';
let _notifOpenId = null;
let _notifNames  = {};   // entity id → name

// Friendly labels for the id fields that show up across notification bodies.
// Anything not listed falls back to a generic camelCase → Title Case rule.
const _NOTIF_KEY_LABELS = {
  aggressorID: 'Aggressor', aggressorCorpID: 'Aggressor Corp', aggressorAllianceID: 'Aggressor Alliance',
  allianceID: 'Alliance', charID: 'Character', corpID: 'Corporation', victimID: 'Victim',
  solarsystemID: 'Solar System', solarSystemID: 'Solar System', systemID: 'Solar System',
  structureID: 'Structure', structureTypeID: 'Structure Type', typeID: 'Type', moonID: 'Moon',
  planetID: 'Planet', stationID: 'Station', regionID: 'Region', constellationID: 'Constellation',
  ownerCorpID: 'Owner Corp', declaredByID: 'Declared By', againstID: 'Against',
};

// /universe/names/ resolves characters, corps, alliances, systems, stations,
// types and regions — but NOT player structures (their ids are far larger and
// need docking access). Keep resolution to ids that endpoint can actually take.
const _notifResolvable = (v) => typeof v === 'number' && v > 0 && v < 1e12;

async function initNotifications(characterId) {
  _notifChar = characterId;
  _notifOpenId = null;
  _notifRenderDetail(null);
  _notifStatus('Loading notifications…');

  const res = await window.eveAPI.notifGet(characterId).catch(e => ({ ok: false, error: e.message }));
  if (!res.ok) { _notifShowError(res); _notifStatus(''); return; }

  _notifItems = res.notifications || [];
  _notifStatus('');

  // Resolve every id we might display, in one batch.
  const ids = [];
  _notifItems.forEach(n => {
    if (_notifResolvable(n.senderId)) ids.push(n.senderId);
    if (n.data) Object.entries(n.data).forEach(([k, v]) => { if (/id$/i.test(k) && _notifResolvable(v)) ids.push(v); });
  });
  await _notifResolveNames(ids);

  _notifRenderFilters();
  _notifRenderList();
}

async function _notifResolveNames(ids) {
  const missing = [...new Set(ids.filter(id => id && !_notifNames[id]))];
  if (!missing.length) return;
  try {
    const r = await window.eveAPI.getNames(missing);
    if (Array.isArray(r)) r.forEach(({ id, name }) => { if (id && name) _notifNames[id] = name; });
    else if (r && typeof r === 'object') Object.assign(_notifNames, r);
  } catch (_) { /* unresolved ids render as the raw number */ }
}

const _notifName = (id) => _notifNames[id] || `ID ${id}`;

function _notifFiltered() {
  return _notifCat === 'All' ? _notifItems : _notifItems.filter(n => n.category === _notifCat);
}

function _notifRenderFilters() {
  const host = document.getElementById('notifFilters');
  if (!host) return;
  // Only offer categories that actually occur, with counts, newest-heavy first.
  const counts = new Map();
  _notifItems.forEach(n => counts.set(n.category, (counts.get(n.category) || 0) + 1));
  const cats = ['All', ...[...counts.keys()].sort()];
  host.innerHTML = cats.map(c => `
    <button class="notif-filter${c === _notifCat ? ' active' : ''}" data-cat="${escHtml(c)}">
      ${escHtml(c)}<span class="notif-filter-n">${c === 'All' ? _notifItems.length : counts.get(c)}</span>
    </button>`).join('');
  host.querySelectorAll('.notif-filter').forEach(b => {
    b.onclick = () => { _notifCat = b.dataset.cat; _notifRenderFilters(); _notifRenderList(); };
  });
}

function _notifRenderList() {
  const host = document.getElementById('notifList');
  if (!host) return;
  const rows = _notifFiltered();
  if (!rows.length) {
    host.innerHTML = '<div class="mail-empty">No notifications in this category.</div>';
    return;
  }
  host.innerHTML = rows.map(n => `
    <button class="mail-row notif-row${n.isRead ? '' : ' unread'}${n.id === _notifOpenId ? ' active' : ''}" data-id="${n.id}">
      <div class="mail-row-top">
        <span class="mail-row-from">${escHtml(n.label)}</span>
        <span class="mail-row-date">${_notifFmtDate(n.timestamp)}</span>
      </div>
      <div class="mail-row-subject">
        <span class="notif-cat">${escHtml(n.category)}</span>
        ${escHtml(_notifResolvable(n.senderId) ? _notifName(n.senderId) : (n.senderType || ''))}
      </div>
    </button>`).join('');
  host.querySelectorAll('.notif-row').forEach(r => {
    r.onclick = () => { _notifOpenId = Number(r.dataset.id); _notifRenderList(); _notifRenderDetail(_notifItems.find(n => n.id === _notifOpenId)); };
  });
}

function _notifRenderDetail(n) {
  const host = document.getElementById('notifReader');
  if (!host) return;
  host.innerHTML = '';
  if (!n) {
    const d = document.createElement('div');
    d.className = 'mail-empty';
    d.textContent = 'Select a notification to read.';
    host.appendChild(d);
    return;
  }

  const head = document.createElement('div');
  head.className = 'mail-reader-head';
  head.innerHTML = `
    <div class="mail-reader-subject">${escHtml(n.label)}</div>
    <div class="mail-reader-meta">
      <span><span class="mail-meta-label">Category</span> ${escHtml(n.category)}</span>
      <span><span class="mail-meta-label">Received</span> ${_notifFmtDate(n.timestamp, true)}</span>
      ${_notifResolvable(n.senderId) ? `<span><span class="mail-meta-label">From</span> ${escHtml(_notifName(n.senderId))}</span>` : ''}
    </div>
    <div class="mail-reader-meta">
      <span><span class="mail-meta-label">Type</span> <code class="notif-type">${escHtml(n.type)}</code></span>
    </div>`;
  host.appendChild(head);

  if (n.data && Object.keys(n.data).length) {
    host.appendChild(_notifDetailTable(n.data));
  } else if (n.raw) {
    // Unparseable body — show it verbatim rather than pretending it's empty.
    const pre = document.createElement('pre');
    pre.className = 'notif-raw';
    pre.textContent = n.raw;
    host.appendChild(pre);
  } else {
    const d = document.createElement('div');
    d.className = 'mail-empty';
    d.textContent = 'This notification carries no additional detail.';
    host.appendChild(d);
  }
}

// Render the parsed YAML as a readable field table. Built with DOM nodes and
// textContent (never innerHTML) — the values are third-party content.
function _notifDetailTable(data) {
  const table = document.createElement('div');
  table.className = 'notif-fields';
  for (const [key, value] of Object.entries(data)) {
    const row = document.createElement('div');
    row.className = 'notif-field';

    const k = document.createElement('span');
    k.className = 'notif-field-key';
    k.textContent = _NOTIF_KEY_LABELS[key] || _notifHumanKey(key);
    row.appendChild(k);

    const v = document.createElement('span');
    v.className = 'notif-field-val';
    v.textContent = _notifFormatValue(key, value);
    row.appendChild(v);

    table.appendChild(row);
  }
  return table;
}

function _notifHumanKey(key) {
  return String(key)
    .replace(/(ID|Id)s?$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase())
    .trim() || key;
}

function _notifFormatValue(key, value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(x => _notifFormatValue(key, x)).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${_notifHumanKey(k)}: ${_notifFormatValue(k, v)}`).join(' · ');
  }
  if (typeof value === 'number') {
    // An id-looking field resolves to a name where we have one.
    if (/id$/i.test(key) && _notifResolvable(value) && _notifNames[value]) return _notifNames[value];
    // ISK-ish fields read better formatted.
    if (/(isk|amount|cost|value|bounty|reward|price)$/i.test(key) && typeof formatISK === 'function') {
      return formatISK(value);
    }
    return String(value);
  }
  return String(value);
}

function _notifFmtDate(iso, full = false) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  if (full) return d.toLocaleString();
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

function _notifStatus(msg) {
  const el = document.getElementById('mailStatus');
  if (el) el.textContent = msg || '';
}

function _notifShowError(res) {
  const host = document.getElementById('notifList');
  if (!host) return;
  host.innerHTML = res.needsReauth
    ? `<div class="mail-empty">Notification access hasn't been granted for this character yet.<br><br>
         Open the <b>Characters</b> page and re-authenticate it to grant access.</div>`
    : `<div class="mail-empty">${escHtml(res.error || 'Could not load notifications.')}</div>`;
}
