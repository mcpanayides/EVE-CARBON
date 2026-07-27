// ─── Contracts ────────────────────────────────────────────────────────────────
// Browse a character's contracts (item exchange, courier, auction, loan) from
// the Finances page's Contracts tab. Uses esi-contracts.read_character_contracts,
// which the app has requested for a long time — so this needs no re-auth.
//
// Contracts are live-fetched and not stored; item lists are pulled lazily when a
// contract is expanded, because most are never opened.

let _ctChar    = null;
let _ctList    = [];
let _ctFilter  = 'all';       // all | item_exchange | courier | auction | outstanding
let _ctOpenId  = null;
let _ctItems   = {};          // contractId → items[]
let _ctNames   = {};          // entity/type/location id → name
let _ctLoaded  = false;

const CT_TYPE_LABEL = {
  item_exchange: 'Item Exchange', courier: 'Courier', auction: 'Auction', loan: 'Loan', unknown: 'Unknown',
};

async function initContractsTab() {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!Array.isArray(accounts) || !accounts.length) {
    _ctSet('<div class="ct-empty">Add a character on the Characters page to see contracts.</div>');
    return;
  }
  if (!_ctChar || !accounts.some(a => String(a.characterId) === String(_ctChar))) {
    const main = accounts.find(a => String(a.characterId) === String(typeof selectedCharacterId !== 'undefined' ? selectedCharacterId : '')) || accounts[0];
    _ctChar = main.characterId;
  }

  const host = document.getElementById('contractsTab');
  if (!host) return;
  host.innerHTML = `
    <div class="ct-bar">
      <select id="ctCharSelect" class="field-input">
        ${accounts.map(a => `<option value="${a.characterId}"${String(a.characterId) === String(_ctChar) ? ' selected' : ''}>${escHtml(a.characterName)}</option>`).join('')}
      </select>
      <div class="ct-filters">
        ${[['all', 'All'], ['outstanding', 'Outstanding'], ['item_exchange', 'Item Exchange'], ['courier', 'Courier'], ['auction', 'Auction']]
          .map(([k, l]) => `<button class="ct-filter${k === _ctFilter ? ' active' : ''}" data-ctf="${k}">${l}</button>`).join('')}
      </div>
      <button class="ct-btn" id="ctRefreshBtn">Refresh</button>
      <span class="ct-status" id="ctStatus"></span>
    </div>
    <div class="ct-list" id="ctList"><div class="ct-empty">Loading contracts…</div></div>`;

  document.getElementById('ctCharSelect').onchange = (e) => { _ctChar = Number(e.target.value); _ctLoad(); };
  document.getElementById('ctRefreshBtn').onclick = () => _ctLoad();
  host.querySelectorAll('[data-ctf]').forEach(b => b.onclick = () => {
    _ctFilter = b.dataset.ctf;
    host.querySelectorAll('[data-ctf]').forEach(x => x.classList.toggle('active', x === b));
    _ctRender();
  });

  await _ctLoad();
}

function _ctSet(html) {
  const host = document.getElementById('contractsTab');
  if (host) host.innerHTML = html;
}
function _ctStatus(msg) {
  const el = document.getElementById('ctStatus');
  if (el) el.textContent = msg || '';
}

async function _ctLoad() {
  _ctOpenId = null;
  _ctStatus('Loading…');
  const list = document.getElementById('ctList');
  if (list) list.innerHTML = '<div class="ct-empty">Loading contracts…</div>';

  const res = await window.eveAPI.contractsGet(_ctChar).catch(e => ({ ok: false, error: e.message }));
  _ctStatus('');
  if (!res.ok) {
    if (list) list.innerHTML = res.needsReauth
      ? `<div class="ct-empty">Contract access hasn't been granted for this character yet.<br><br>
           Open the <b>Characters</b> page and re-authenticate it.</div>`
      : `<div class="ct-empty">${escHtml(res.error || 'Could not load contracts.')}</div>`;
    return;
  }
  _ctList = res.contracts || [];
  _ctLoaded = true;
  await _ctResolveNames();
  _ctRender();
}

// Characters/corps and station locations both resolve through /universe/names/.
// Player structures have ids above that endpoint's range, so they stay numeric.
async function _ctResolveNames() {
  const ids = [];
  _ctList.forEach(c => {
    [c.issuerId, c.assigneeId, c.acceptorId, c.startLocationId, c.endLocationId]
      .forEach(id => { if (id && id < 1e12 && !_ctNames[id]) ids.push(id); });
  });
  const missing = [...new Set(ids)];
  if (!missing.length) return;
  try {
    const r = await window.eveAPI.getNames(missing);
    if (Array.isArray(r)) r.forEach(({ id, name }) => { if (id && name) _ctNames[id] = name; });
    else if (r && typeof r === 'object') Object.assign(_ctNames, r);
  } catch (_) { /* falls back to the raw id */ }
}

const _ctName = (id) => {
  if (!id) return '—';
  if (_ctNames[id]) return _ctNames[id];
  return id > 1e12 ? 'Player structure' : `ID ${id}`;
};

function _ctFiltered() {
  if (_ctFilter === 'all') return _ctList;
  if (_ctFilter === 'outstanding') return _ctList.filter(c => c.status === 'outstanding' || c.status === 'in_progress');
  return _ctList.filter(c => c.type === _ctFilter);
}

function _ctFmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: '2-digit' });
}

// Days until expiry — the number that actually matters on an outstanding contract.
function _ctExpiry(c) {
  if (!c.dateExpired) return null;
  const ms = new Date(c.dateExpired) - new Date();
  if (isNaN(ms)) return null;
  if (ms <= 0) return { text: 'expired', urgent: true };
  const days = Math.floor(ms / 86400000);
  const hrs = Math.floor((ms % 86400000) / 3600000);
  return { text: days > 0 ? `${days}d ${hrs}h left` : `${hrs}h left`, urgent: days < 1 };
}

function _ctRender() {
  const host = document.getElementById('ctList');
  if (!host) return;
  const rows = _ctFiltered();
  if (!rows.length) {
    host.innerHTML = `<div class="ct-empty">No ${_ctFilter === 'all' ? '' : _ctFilter.replace('_', ' ') + ' '}contracts for this character.</div>`;
    return;
  }

  host.innerHTML = rows.map(c => {
    const exp = _ctExpiry(c);
    // Courier contracts are about reward/collateral; the rest are about price.
    const money = c.type === 'courier'
      ? `<span class="ct-money"><i>Reward</i><b class="ct-pos">${formatISK(c.reward)}</b></span>
         <span class="ct-money"><i>Collateral</i><b>${formatISK(c.collateral)}</b></span>`
      : `<span class="ct-money"><i>${c.type === 'auction' ? 'Current bid' : 'Price'}</i><b>${formatISK(c.price || c.buyout)}</b></span>`;
    return `
      <div class="ct-row${c.contractId === _ctOpenId ? ' open' : ''}">
        <button class="ct-head" data-ct="${c.contractId}">
          <span class="ct-type ct-${escHtml(c.type)}">${escHtml(CT_TYPE_LABEL[c.type] || c.type)}</span>
          <span class="ct-main">
            <span class="ct-title">${escHtml(c.title || '(no title)')}</span>
            <span class="ct-sub">
              ${escHtml(_ctName(c.issuerId))} · ${escHtml(_ctName(c.startLocationId))}
              ${c.type === 'courier' && c.endLocationId ? ` → ${escHtml(_ctName(c.endLocationId))}` : ''}
              ${c.volume ? ` · ${formatNumber(Math.round(c.volume))} m³` : ''}
            </span>
          </span>
          <span class="ct-right">
            ${money}
            <span class="ct-meta">
              <span class="ct-status-tag ct-st-${escHtml(c.status)}">${escHtml(c.status.replace(/_/g, ' '))}</span>
              <span class="ct-dim">${exp ? `<span class="${exp.urgent ? 'ct-urgent' : ''}">${escHtml(exp.text)}</span>` : _ctFmtDate(c.dateIssued)}</span>
            </span>
          </span>
        </button>
        ${c.contractId === _ctOpenId ? `<div class="ct-detail" id="ctDetail-${c.contractId}"><div class="ct-dim">Loading items…</div></div>` : ''}
      </div>`;
  }).join('');

  host.querySelectorAll('[data-ct]').forEach(b => b.onclick = () => _ctToggle(Number(b.dataset.ct)));
  if (_ctOpenId) _ctRenderDetail(_ctOpenId);
}

async function _ctToggle(contractId) {
  _ctOpenId = _ctOpenId === contractId ? null : contractId;
  _ctRender();
  if (!_ctOpenId) return;
  if (!_ctItems[contractId]) {
    const res = await window.eveAPI.contractsGetItems(_ctChar, contractId).catch(e => ({ ok: false, error: e.message }));
    _ctItems[contractId] = res.ok ? res.items : [];
    // Resolve the item type names in one batch.
    const ids = _ctItems[contractId].map(i => i.typeId).filter(id => id && !_ctNames[id]);
    if (ids.length) {
      try {
        const r = await window.eveAPI.getNames([...new Set(ids)]);
        if (Array.isArray(r)) r.forEach(({ id, name }) => { if (id && name) _ctNames[id] = name; });
        else if (r && typeof r === 'object') Object.assign(_ctNames, r);
      } catch (_) { /* ids shown raw */ }
    }
  }
  _ctRenderDetail(contractId);
}

function _ctRenderDetail(contractId) {
  const host = document.getElementById(`ctDetail-${contractId}`);
  if (!host) return;
  const c = _ctList.find(x => x.contractId === contractId);
  const items = _ctItems[contractId];
  if (!c) return;
  if (!items) { host.innerHTML = '<div class="ct-dim">Loading items…</div>'; return; }

  // Contracts can both offer and request items; separate them so it's obvious.
  const offered  = items.filter(i => i.isIncluded);
  const wanted   = items.filter(i => !i.isIncluded);
  const itemList = (arr, label, cls) => !arr.length ? '' : `
    <div class="ct-itemgroup">
      <div class="ct-itemlabel ${cls}">${label}</div>
      ${arr.map(i => `
        <div class="ct-item">
          <img src="https://images.evetech.net/types/${i.typeId}/icon?size=32" alt="" loading="lazy" onerror="this.style.display='none'"/>
          <span>${escHtml(_ctName(i.typeId))}${i.isBlueprintCopy ? ' <span class="ct-bpc">BPC</span>' : ''}
            ${i.runs != null && i.runs > 0 ? `<span class="ct-dim"> · ${i.runs} runs</span>` : ''}
            ${i.me != null ? `<span class="ct-dim"> · ME ${i.me}/TE ${i.te ?? 0}</span>` : ''}
          </span>
          <b>×${formatNumber(i.quantity)}</b>
        </div>`).join('')}
    </div>`;

  host.innerHTML = `
    <div class="ct-detail-grid">
      <div><i>Issued</i><b>${_ctFmtDate(c.dateIssued)}</b></div>
      <div><i>Expires</i><b>${_ctFmtDate(c.dateExpired)}</b></div>
      ${c.assigneeId ? `<div><i>Assigned to</i><b>${escHtml(_ctName(c.assigneeId))}</b></div>` : ''}
      ${c.acceptorId ? `<div><i>Accepted by</i><b>${escHtml(_ctName(c.acceptorId))}</b></div>` : ''}
      ${c.type === 'courier' ? `<div><i>To complete</i><b>${c.daysToComplete} days</b></div>` : ''}
      ${c.buyout ? `<div><i>Buyout</i><b>${formatISK(c.buyout)}</b></div>` : ''}
      <div><i>Availability</i><b>${escHtml(c.availability)}${c.forCorp ? ' (corp)' : ''}</b></div>
    </div>
    ${itemList(offered, 'INCLUDED', 'ct-in')}
    ${itemList(wanted, 'REQUESTED FROM BUYER', 'ct-out')}
    ${!items.length ? '<div class="ct-dim">This contract has no item list (courier and loan contracts carry none).</div>' : ''}`;
}
