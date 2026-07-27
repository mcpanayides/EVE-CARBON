// ─── Station Checkout (Industry → Station Checkout) ─────────────────────────────
// Cross-references a shopping list against what you already have in a chosen
// location — an NPC station, an Upwell structure, or even a specific container —
// and tells you exactly what's still MISSING. From the missing set you can copy a
// multibuy string to the clipboard or spin it out into its own shopping list (to
// buy or to break down & build).
//
// Assets come from the local DB (getCharacterAssetsDb — no ESI). Every distinct
// asset location_id is selectable, so a locked station container is just another
// pickable "location". Nothing is stored beyond a list you explicitly create.

let _scChar     = 'all';   // 'all' or a characterId
let _scLocId    = '';      // selected location_id (string)
let _scListId   = '';      // selected shopping-list id
let _scAssets   = [];      // merged asset rows for the in-scope character(s)
let _scLocs     = [];      // [{ id, name, sub, count }]
let _scAccounts = [];

async function renderStationCheckout(host) {
  if (!host) return;
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!Array.isArray(accounts) || !accounts.length) {
    host.innerHTML = '<div class="fin-empty">Add a character to use Station Checkout.</div>';
    return;
  }
  _scAccounts = accounts;
  if (_scChar !== 'all' && !accounts.some(a => String(a.characterId) === String(_scChar))) _scChar = 'all';

  const lists = (typeof slGetAll === 'function' ? slGetAll() : []) || [];
  if (!lists.length) {
    host.innerHTML = `<div class="fin-firstrun"><h3>Station Checkout</h3>
      <p>You have no shopping lists yet. Build one first — add materials from a blueprint (My Blueprints →
      component tree → <b>Add this breakdown</b>) or create one on the <b>Shopping Lists</b> tab — then come back here to
      check it against a station's stock.</p></div>`;
    return;
  }
  if (!_scListId || !lists.some(l => l.id === _scListId)) _scListId = lists[0].id;

  host.innerHTML = `
    <div class="fin-tab-fill fw-scroll sc-wrap">
      <div class="lp-bar tr-bar">
        <label class="sc-field">Character
          <select id="scChar" class="field-input ml-mini">
            <option value="all"${_scChar === 'all' ? ' selected' : ''}>All characters</option>
            ${accounts.map(a => `<option value="${a.characterId}"${String(a.characterId) === String(_scChar) ? ' selected' : ''}>${escHtml(a.characterName)}</option>`).join('')}
          </select>
        </label>
        <label class="sc-field">Location
          <select id="scLoc" class="field-input ml-mini" style="min-width:240px;"><option value="">Loading assets…</option></select>
        </label>
        <label class="sc-field">Shopping list
          <select id="scList" class="field-input ml-mini" style="min-width:180px;">
            ${lists.map(l => `<option value="${l.id}"${l.id === _scListId ? ' selected' : ''}>${escHtml(l.name)} (${l.items.length})</option>`).join('')}
          </select>
        </label>
        <span class="lp-status" id="scStatus"></span>
      </div>
      <div id="scResult" class="sc-result"><div class="fin-empty">Pick a location to compare against.</div></div>
    </div>`;

  document.getElementById('scChar').onchange = (e) => { _scChar = e.target.value; _scLocId = ''; _scLoadAssets(); };
  document.getElementById('scLoc').onchange  = (e) => { _scLocId = e.target.value; _scCompute(); };
  document.getElementById('scList').onchange = (e) => { _scListId = e.target.value; _scCompute(); };

  await _scLoadAssets();
}

function _scStatus(m) { const el = document.getElementById('scStatus'); if (el) el.textContent = m || ''; }
function _scScope() { return _scChar === 'all' ? _scAccounts : _scAccounts.filter(a => String(a.characterId) === String(_scChar)); }

// Load + merge assets for the in-scope character(s), then build the location list.
async function _scLoadAssets() {
  _scStatus('Loading assets…');
  const rows = [];
  for (const acc of _scScope()) {
    try {
      const list = await window.eveAPI.getCharacterAssetsDb(acc.characterId);
      if (Array.isArray(list)) rows.push(...list);
    } catch (_) {}
  }
  _scAssets = rows;
  _scStatus('');

  // Distinct locations, each with an item count. Containers appear as their own
  // location_id, so a locked container is selectable just like a station.
  const byLoc = new Map();
  for (const a of rows) {
    if (a.location_id == null) continue;
    const key = String(a.location_id);
    const cur = byLoc.get(key) || {
      id: key,
      name: (a.location_name && !/^Location \d+$/.test(a.location_name)) ? a.location_name : `Location ${a.location_id}`,
      sub: a.solar_system_name || a.region_name || '',
      count: 0,
    };
    cur.count += 1;
    if (!cur.sub && a.solar_system_name) cur.sub = a.solar_system_name;
    byLoc.set(key, cur);
  }
  _scLocs = [...byLoc.values()].sort((x, y) => (x.sub + x.name).localeCompare(y.sub + y.name));

  const sel = document.getElementById('scLoc');
  if (sel) {
    if (!_scLocs.length) {
      sel.innerHTML = '<option value="">No assets found for this character</option>';
    } else {
      if (!_scLocId || !_scLocs.some(l => l.id === _scLocId)) _scLocId = _scLocs[0].id;
      sel.innerHTML = _scLocs.map(l =>
        `<option value="${l.id}"${l.id === _scLocId ? ' selected' : ''}>${escHtml(`${l.name}${l.sub ? ' — ' + l.sub : ''}`)} · ${l.count} stacks</option>`).join('');
    }
  }
  _scCompute();
}

// Compare the chosen list against on-hand quantities at the chosen location.
async function _scCompute() {
  const out = document.getElementById('scResult');
  if (!out) return;
  const lists = (typeof slGetAll === 'function' ? slGetAll() : []) || [];
  const list  = lists.find(l => l.id === _scListId);
  if (!list) { out.innerHTML = '<div class="fin-empty">Select a shopping list.</div>'; return; }
  if (!_scLocId) { out.innerHTML = '<div class="fin-empty">Select a location to compare against.</div>'; return; }
  if (!list.items.length) { out.innerHTML = '<div class="fin-empty">This shopping list is empty.</div>'; return; }

  // On-hand quantity per type at the chosen location.
  const have = {};
  for (const a of _scAssets) {
    if (String(a.location_id) !== String(_scLocId)) continue;
    have[a.type_id] = (have[a.type_id] || 0) + (a.quantity || 0);
  }

  const rows = list.items.map(it => {
    const h = have[it.typeId] || 0;
    const need = Math.ceil(it.qty || 0);
    return { typeId: it.typeId, name: it.name, need, have: h, missing: Math.max(0, need - h) };
  });
  const missing = rows.filter(r => r.missing > 0);

  // Price the missing set (Jita) so the user sees the buy cost.
  let prices = {};
  if (missing.length) {
    _scStatus('Pricing missing items…');
    try { prices = await window.eveAPI.getJitaPrices(missing.map(r => r.typeId)) || {}; } catch (_) {}
    _scStatus('');
  }
  const missCost = missing.reduce((s, r) => {
    const p = prices[r.typeId]; const u = p ? (p.sell > 0 ? p.sell : p.buy || 0) : 0;
    r._unit = u; return s + u * r.missing;
  }, 0);

  const loc = _scLocs.find(l => l.id === _scLocId);
  const locName = loc ? `${loc.name}${loc.sub ? ' · ' + loc.sub : ''}` : `Location ${_scLocId}`;

  const bodyRows = rows.sort((a, b) => b.missing - a.missing || a.name.localeCompare(b.name)).map(r => {
    const ok = r.missing === 0;
    const icon = `<img class="tr-icon" src="https://images.evetech.net/types/${r.typeId}/icon?size=32" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
    return `<tr class="${ok ? '' : 'sc-missing-row'}">
      <td class="tr-td-name">${icon}<span class="lp-name-txt">${escHtml(r.name)}</span></td>
      <td class="lp-num">${formatNumber(r.need)}</td>
      <td class="lp-num lp-dim">${formatNumber(r.have)}</td>
      <td class="lp-num ${ok ? 'lp-pos' : 'lp-neg lp-strong'}">${ok ? '✓ in stock' : formatNumber(r.missing)}</td>
      <td class="lp-num lp-dim">${r._unit ? formatISK(r._unit * r.missing) : (ok ? '—' : '—')}</td>
    </tr>`;
  }).join('');

  out.innerHTML = `
    <div class="tr-summary sc-summary">
      ${missing.length === 0
        ? `<span class="lp-pos lp-strong">✓ Fully stocked</span> — every item in “${escHtml(list.name)}” is already in ${escHtml(locName)}.`
        : `<span class="lp-neg lp-strong">${missing.length} of ${rows.length} item${rows.length !== 1 ? 's' : ''} missing</span>
           from ${escHtml(locName)} · buy cost <span class="lp-strong">${formatISK(missCost)}</span> <span class="lp-dim">(Jita)</span>`}
    </div>
    <div class="lp-table-wrap">
      <table class="tr-table">
        <thead><tr><th>Item</th><th class="lp-num">Need</th><th class="lp-num">Have here</th><th class="lp-num">Missing</th><th class="lp-num">Buy cost</th></tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    ${missing.length ? `
    <div class="sc-actions">
      <button id="scCopyBtn" class="bp-view-btn" type="button" title="Copy the missing items as an EVE multibuy string">↗ COPY MISSING TO MULTIBUY</button>
      <button id="scListBtn" class="bp-view-btn" type="button" title="Create a new shopping list from just the missing items">➕ NEW LIST FROM MISSING</button>
    </div>
    <div class="lp-note">“Copy to Multibuy” puts the missing items on your clipboard — in EVE open Market → Multibuy → paste.
      “New list from missing” makes a fresh shopping list you can buy from or break down &amp; build in My Blueprints.</div>
    ` : `<div class="lp-note">Nothing to buy — this list is fully covered at the selected location.</div>`}`;

  if (missing.length) {
    const missItems = missing.map(r => ({ typeId: r.typeId, name: r.name, qty: r.missing }));
    document.getElementById('scCopyBtn').onclick = () => {
      const text = slToGameFormat(missItems.map(m => ({ name: m.name, qty: m.qty })));
      const done = () => pushCenterToast(`Copied ${missItems.length} missing item${missItems.length !== 1 ? 's' : ''} — in EVE open Market → Multibuy → paste`, 'success', 2600);
      navigator.clipboard.writeText(text).then(done).catch(() => {
        const el = document.createElement('textarea'); el.value = text; document.body.appendChild(el); el.select(); document.execCommand('copy'); el.remove(); done();
      });
    };
    document.getElementById('scListBtn').onclick = () => {
      const name = `${list.name} — missing @ ${loc ? loc.name : 'location'}`;
      const created = slCreate(name);
      slAddItems(created.id, missItems, name);
      pushCenterToast(`Created “${created.name}” with ${missItems.length} item${missItems.length !== 1 ? 's' : ''}`, 'success', 2600);
    };
  }
}
