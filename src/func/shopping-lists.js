// ─── Shopping Lists ───────────────────────────────────────────────────────────
// Persistent multi-list system.  Each list holds aggregated material items.
// Storage: localStorage key 'eveCarbon_shoppingLists'.
// "Send to Game" copies EVE multi-buy clipboard format (Name\tQty per line).

const SL_KEY       = 'eveCarbon_shoppingLists';
const ESI_IMG_SL   = 'https://images.evetech.net/types';
let   _slActiveId  = null;   // currently-selected list ID in the tab
let   _slPrices    = {};     // typeId → {sell,buy} — in-memory cache, avoids re-fetching on qty changes

// ─── Storage helpers ──────────────────────────────────────────────────────────

function slLoad() {
  try { return JSON.parse(localStorage.getItem(SL_KEY) || '{"lists":[]}'); }
  catch (_) { return { lists: [] }; }
}
function slSave(data) {
  try { localStorage.setItem(SL_KEY, JSON.stringify(data)); } catch (_) {}
}
function slGetAll()  { return slLoad().lists; }

function slCreate(name) {
  const data = slLoad();
  const list = {
    id:        (typeof crypto !== 'undefined' && crypto.randomUUID)
                 ? crypto.randomUUID()
                 : `sl_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name:      name.trim() || 'New List',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items:     [],
  };
  data.lists.push(list);
  slSave(data);
  return list;
}

function slDelete(id) {
  const data = slLoad();
  data.lists = data.lists.filter(l => l.id !== id);
  slSave(data);
  if (_slActiveId === id) _slActiveId = null;
}

function slRename(id, name) {
  const data = slLoad();
  const list = data.lists.find(l => l.id === id);
  if (list) { list.name = name.trim() || list.name; list.updatedAt = Date.now(); }
  slSave(data);
}

function slClear(id) {
  const data = slLoad();
  const list = data.lists.find(l => l.id === id);
  if (list) { list.items = []; list.updatedAt = Date.now(); }
  slSave(data);
}

// Add or merge materials into a list.
// items: [{ typeId, name, qty }], sourceName: display string for the source blueprint
function slAddItems(listId, items, sourceName) {
  const data = slLoad();
  let list   = data.lists.find(l => l.id === listId);
  if (!list) return;
  items.forEach(({ typeId, name, qty }) => {
    const existing = list.items.find(i => i.typeId === typeId);
    if (existing) {
      existing.qty += qty;
      if (!existing.sources.includes(sourceName)) existing.sources.push(sourceName);
    } else {
      list.items.push({ typeId, name, qty, sources: [sourceName] });
    }
  });
  list.updatedAt = Date.now();
  slSave(data);
}

function slRemoveItem(listId, typeId) {
  const data = slLoad();
  const list = data.lists.find(l => l.id === listId);
  if (list) { list.items = list.items.filter(i => i.typeId !== typeId); list.updatedAt = Date.now(); }
  slSave(data);
}

function slUpdateItemQty(listId, typeId, qty) {
  const data = slLoad();
  const list = data.lists.find(l => l.id === listId);
  if (!list) return;
  const item = list.items.find(i => i.typeId === typeId);
  if (item) { item.qty = Math.max(1, qty); list.updatedAt = Date.now(); }
  slSave(data);
}

// ─── EVE multi-buy clipboard format ──────────────────────────────────────────

function slToGameFormat(items) {
  return items
    .filter(i => i.qty > 0)
    .map(i => `${i.name}\t${Math.ceil(i.qty)}`)
    .join('\n');
}

// ─── "Add to Shopping List" modal ────────────────────────────────────────────
// materials: [{ typeId, name, qty }]

function showAddToShoppingListModal(materials, sourceName) {
  document.getElementById('slModalBackdrop')?.remove();

  const lists = slGetAll();

  const backdrop = document.createElement('div');
  backdrop.id    = 'slModalBackdrop';
  backdrop.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9000;
    display:flex;align-items:center;justify-content:center;`;

  backdrop.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:10px;
                padding:24px;width:420px;max-width:95vw;font-family:var(--font);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div style="font-size:14px;font-weight:700;color:var(--text-1);">ADD TO SHOPPING LIST</div>
        <button id="slModalClose" style="background:none;border:none;color:var(--text-3);
                cursor:pointer;font-size:18px;padding:0;">✕</button>
      </div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--text-3);margin-bottom:14px;">
        ${materials.length} material${materials.length !== 1 ? 's' : ''} from
        <strong style="color:var(--text-2);">${escHtml(sourceName)}</strong>
      </div>

      ${lists.length ? `
      <div style="margin-bottom:12px;">
        <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                    letter-spacing:0.08em;margin-bottom:6px;">ADD TO EXISTING LIST</div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;">
          ${lists.map(l => `
            <button class="sl-pick-btn" data-id="${l.id}" style="
              display:flex;align-items:center;gap:10px;padding:8px 12px;
              background:var(--bg-card);border:1px solid var(--border);border-radius:6px;
              cursor:pointer;text-align:left;color:var(--text-1);font-family:var(--font);
              font-size:12px;">
              <span style="flex:1;">${escHtml(l.name)}</span>
              <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);">
                ${l.items.length} items
              </span>
            </button>`).join('')}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <div style="flex:1;height:1px;background:var(--border);"></div>
        <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);">OR</span>
        <div style="flex:1;height:1px;background:var(--border);"></div>
      </div>
      ` : ''}

      <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                  letter-spacing:0.08em;margin-bottom:6px;">CREATE NEW LIST</div>
      <div style="display:flex;gap:8px;">
        <input id="slNewListName" class="field-input" placeholder="List name…"
               style="flex:1;" value="${escHtml(sourceName)}"/>
        <button id="slCreateAndAdd" class="bp-view-btn" style="padding:6px 14px;font-size:11px;
                white-space:nowrap;">CREATE & ADD</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();

  backdrop.querySelector('#slModalClose').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  // Add to existing list
  backdrop.querySelectorAll('.sl-pick-btn').forEach(btn => {
    btn.addEventListener('mouseenter', () => { btn.style.borderColor = 'var(--accent)'; btn.style.color = 'var(--accent)'; });
    btn.addEventListener('mouseleave', () => { btn.style.borderColor = 'var(--border)'; btn.style.color = 'var(--text-1)'; });
    btn.addEventListener('click', () => {
      slAddItems(btn.dataset.id, materials, sourceName);
      showToast(`Added ${materials.length} items to "${slGetAll().find(l=>l.id===btn.dataset.id)?.name}"`, 'success');
      close();
      if (typeof navigateIndustryTab === 'function') {
        _slActiveId = btn.dataset.id;
        // Refresh tab if already open
        if (document.getElementById('slTabWrap')) renderShoppingLists(document.getElementById('industryTabContent'));
      }
    });
  });

  // Create new list and add
  const createBtn  = backdrop.querySelector('#slCreateAndAdd');
  const nameInput  = backdrop.querySelector('#slNewListName');
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });
  createBtn.addEventListener('click', () => {
    const name = nameInput.value.trim() || sourceName;
    const list = slCreate(name);
    slAddItems(list.id, materials, sourceName);
    showToast(`Created "${list.name}" with ${materials.length} items`, 'success');
    close();
    if (typeof navigateIndustryTab === 'function') {
      _slActiveId = list.id;
      if (document.getElementById('slTabWrap')) renderShoppingLists(document.getElementById('industryTabContent'));
    }
  });

  nameInput.focus();
  nameInput.select();
}

// ─── Shopping Lists tab ───────────────────────────────────────────────────────

function renderShoppingLists(container) {
  container.innerHTML = `
    <div id="slTabWrap" style="display:flex;height:100%;overflow:hidden;">

      <!-- ── Left sidebar: list of lists ── -->
      <div id="slSidebar" style="width:220px;flex-shrink:0;border-right:1px solid var(--border);
                                  display:flex;flex-direction:column;overflow:hidden;">
        <div style="padding:12px;border-bottom:1px solid var(--border);background:var(--bg-card);">
          <button id="slNewListBtn" class="bp-view-btn"
                  style="width:100%;padding:7px 0;font-size:11px;text-align:center;">
            + NEW SHOPPING LIST
          </button>
        </div>
        <div id="slListItems" style="flex:1;overflow-y:auto;padding:8px 0;"></div>
      </div>

      <!-- ── Right panel: selected list contents ── -->
      <div id="slMain" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;">
        <div id="slContent" style="flex:1;overflow-y:auto;"></div>
      </div>

    </div>`;

  _renderSlSidebar();
  _renderSlContent();

  // New list button
  document.getElementById('slNewListBtn').addEventListener('click', () => {
    const name = prompt('Shopping list name:');
    if (!name?.trim()) return;
    const list = slCreate(name);
    _slActiveId = list.id;
    _renderSlSidebar();
    _renderSlContent();
  });
}

function _renderSlSidebar() {
  const sidebar = document.getElementById('slListItems');
  if (!sidebar) return;
  const lists = slGetAll();

  if (!lists.length) {
    sidebar.innerHTML = `
      <div style="padding:20px 12px;font-family:var(--mono);font-size:10px;
                  color:var(--text-3);text-align:center;line-height:1.7;">
        No lists yet.<br>Add materials from a blueprint to create one.
      </div>`;
    return;
  }

  // Ensure a valid active ID
  if (!_slActiveId || !lists.find(l => l.id === _slActiveId)) {
    _slActiveId = lists[0].id;
  }

  sidebar.innerHTML = lists.map(list => {
    const active = list.id === _slActiveId;
    return `
      <div class="sl-sidebar-item ${active ? 'sl-sidebar-active' : ''}"
           data-id="${list.id}"
           style="display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;
                  background:${active ? 'var(--bg-hover)' : 'transparent'};
                  border-left:3px solid ${active ? 'var(--accent)' : 'transparent'};
                  border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;color:${active ? 'var(--accent)' : 'var(--text-1)'};
                      font-weight:${active ? '600' : '400'};
                      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${escHtml(list.name)}
          </div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);margin-top:2px;">
            ${list.items.length} item${list.items.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  sidebar.querySelectorAll('.sl-sidebar-item').forEach(el => {
    el.addEventListener('click', () => {
      _slActiveId = el.dataset.id;
      _renderSlSidebar();
      _renderSlContent();
    });
  });
}

async function _renderSlContent() {
  const main = document.getElementById('slContent');
  if (!main) return;

  const lists = slGetAll();
  if (!lists.length || !_slActiveId) {
    main.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  height:100%;gap:12px;color:var(--text-3);">
        <div style="font-size:32px;opacity:0.3;">◈</div>
        <div style="font-family:var(--mono);font-size:12px;">No list selected.</div>
        <div style="font-family:var(--mono);font-size:10px;text-align:center;max-width:260px;">
          Create a list then add materials from any blueprint detail or BP Search panel.
        </div>
      </div>`;
    return;
  }

  const list = lists.find(l => l.id === _slActiveId);
  if (!list) return;

  // Fetch Jita prices — only request IDs not already in the in-memory cache
  // so that +/- clicks re-render instantly without hitting the API each time
  const missing = list.items.map(i => i.typeId).filter(id => !_slPrices[id]);
  if (missing.length) {
    try {
      const fresh = await window.eveAPI.getJitaPrices(missing) || {};
      Object.assign(_slPrices, fresh);
    } catch (_) {}
  }
  const prices = _slPrices;

  let totalCost = 0;
  list.items.forEach(item => {
    const p = prices[item.typeId];
    const u = p?.sell > 0 ? p.sell : (p?.buy || 0);
    totalCost += u * item.qty;
  });

  const rows = list.items.map(item => {
    const p     = prices[item.typeId];
    const unit  = p?.sell > 0 ? p.sell : (p?.buy || 0);
    const total = unit * item.qty;

    return `
      <tr style="border-bottom:1px solid var(--border);"
          data-typeid="${item.typeId}">
        <td style="padding:8px 12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <img src="${ESI_IMG_SL}/${item.typeId}/icon?size=32"
                 onerror="this.style.display='none'"
                 style="width:26px;height:26px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">
            <div>
              <div style="font-size:12px;color:var(--text-1);">${escHtml(item.name)}</div>
              ${item.sources?.length
                ? `<div style="font-family:var(--mono);font-size:9px;color:var(--text-3);">
                     ${item.sources.map(s => escHtml(s)).join(', ')}
                   </div>`
                : ''}
            </div>
          </div>
        </td>
        <td style="padding:6px 8px;white-space:nowrap;">
          <div style="display:inline-flex;align-items:center;gap:3px;">
            <button class="sl-decr-btn" data-typeid="${item.typeId}"
                    style="width:24px;height:26px;border:1px solid var(--border);border-radius:3px;
                           background:var(--bg-hover);color:var(--text-2);cursor:pointer;
                           font-size:14px;line-height:1;flex-shrink:0;">−</button>
            <input type="number" class="sl-qty-input field-input"
                   data-typeid="${item.typeId}"
                   value="${item.qty}" min="1"
                   style="width:80px;padding:4px 6px;font-size:11px;
                          font-family:var(--mono);text-align:center;">
            <button class="sl-incr-btn" data-typeid="${item.typeId}"
                    style="width:24px;height:26px;border:1px solid var(--border);border-radius:3px;
                           background:var(--bg-hover);color:var(--accent);cursor:pointer;
                           font-size:14px;line-height:1;flex-shrink:0;">+</button>
          </div>
        </td>
        <td style="padding:8px 12px;text-align:right;font-family:var(--mono);
                   font-size:11px;color:var(--text-3);white-space:nowrap;">
          ${unit > 0 ? formatNumber(unit) + ' ISK' : '—'}
        </td>
        <td style="padding:8px 12px;text-align:right;font-family:var(--mono);
                   font-size:11px;font-weight:600;
                   color:${total > 0 ? 'var(--text-1)' : 'var(--text-3)'};white-space:nowrap;">
          ${total > 0 ? formatNumber(total) : '—'}
        </td>
        <td style="padding:8px;text-align:center;">
          <button class="sl-remove-btn" data-typeid="${item.typeId}"
                  style="background:none;border:none;color:var(--text-3);cursor:pointer;
                         font-size:14px;padding:2px 6px;" title="Remove">✕</button>
        </td>
      </tr>`;
  }).join('');

  main.innerHTML = `
    <!-- Toolbar -->
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;
                padding:12px 16px;border-bottom:1px solid var(--border);
                background:var(--bg-card);flex-shrink:0;">
      <span style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--text-1);
                   flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${escHtml(list.name)}
      </span>
      <button id="slRenameBtn" class="icon-btn" style="padding:4px 10px;font-size:10px;">RENAME</button>
      <button id="slClearBtn"  class="icon-btn" style="padding:4px 10px;font-size:10px;">CLEAR</button>
      <button id="slDeleteBtn" class="icon-btn"
              style="padding:4px 10px;font-size:10px;color:var(--danger);border-color:var(--danger);">
        DELETE
      </button>
      <button id="slSendBtn"
              style="padding:5px 14px;font-size:11px;font-family:var(--mono);font-weight:600;
                     letter-spacing:0.06em;cursor:pointer;border-radius:var(--radius);
                     background:transparent;border:1px solid var(--danger);color:var(--danger);
                     white-space:nowrap;transition:background 0.15s;"
              onmouseover="this.style.background='rgba(231,76,60,0.12)'"
              onmouseout="this.style.background='transparent'">
        ↗ SEND TO GAME
      </button>
    </div>

    ${!list.items.length ? `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  height:60%;gap:10px;color:var(--text-3);">
        <div style="font-size:28px;opacity:0.3;">◈</div>
        <div style="font-family:var(--mono);font-size:11px;">This list is empty.</div>
        <div style="font-family:var(--mono);font-size:10px;text-align:center;max-width:260px;">
          Open any blueprint or BP Search result and click "Add to Shopping List".
        </div>
      </div>
    ` : `
      <!-- Column headers -->
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:var(--bg-card);border-bottom:2px solid var(--border);
                       position:sticky;top:0;z-index:1;">
              <th style="text-align:left;padding:8px 12px;font-family:var(--mono);
                         font-size:9px;color:var(--text-3);letter-spacing:0.08em;font-weight:500;">ITEM</th>
              <th style="text-align:right;padding:8px;font-family:var(--mono);
                         font-size:9px;color:var(--text-3);letter-spacing:0.08em;font-weight:500;">QUANTITY</th>
              <th style="text-align:right;padding:8px 12px;font-family:var(--mono);
                         font-size:9px;color:var(--text-3);letter-spacing:0.08em;font-weight:500;">JITA SELL/UNIT</th>
              <th style="text-align:right;padding:8px 12px;font-family:var(--mono);
                         font-size:9px;color:var(--accent);letter-spacing:0.08em;font-weight:500;">TOTAL COST</th>
              <th style="width:40px;"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <!-- Cost summary -->
      ${totalCost > 0 ? `
      <div style="padding:12px 16px;border-top:1px solid var(--border);background:var(--bg-card);
                  display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;flex-shrink:0;">
        <div>
          <div style="font-family:var(--mono);font-size:9px;color:var(--text-3);
                      letter-spacing:0.12em;margin-bottom:3px;">
            TOTAL ESTIMATED COST · JITA 4-4 SELL
          </div>
          <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:var(--accent);">
            ${formatNumber(totalCost)} ISK
          </div>
        </div>
        <div style="margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--text-3);">
          ${list.items.length} item${list.items.length !== 1 ? 's' : ''} · Jita 4-4 sell orders
        </div>
      </div>` : ''}
    `}`;

  // ── Toolbar button wiring ─────────────────────────────────────────────────
  document.getElementById('slRenameBtn')?.addEventListener('click', () => {
    const name = prompt('New list name:', list.name);
    if (name?.trim()) {
      slRename(_slActiveId, name);
      _renderSlSidebar();
      _renderSlContent();
    }
  });

  document.getElementById('slClearBtn')?.addEventListener('click', () => {
    if (!confirm(`Clear all items from "${list.name}"?`)) return;
    slClear(_slActiveId);
    _renderSlSidebar();
    _renderSlContent();
  });

  document.getElementById('slDeleteBtn')?.addEventListener('click', () => {
    if (!confirm(`Delete list "${list.name}"?`)) return;
    slDelete(_slActiveId);
    _slActiveId = null;
    _renderSlSidebar();
    _renderSlContent();
  });

  document.getElementById('slSendBtn')?.addEventListener('click', () => {
    if (!list.items.length) { showToast('Shopping list is empty.', 'error'); return; }
    const text = slToGameFormat(list.items);
    navigator.clipboard.writeText(text)
      .then(() => showToast('Copied! Open EVE → Market → Multi-buy → Paste', 'success'))
      .catch(() => {
        // Electron fallback
        const el = document.createElement('textarea');
        el.value = text;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        el.remove();
        showToast('Copied! Open EVE → Market → Multi-buy → Paste', 'success');
      });
  });

  // Quantity: typed value
  main.querySelectorAll('.sl-qty-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const qty = parseInt(inp.value);
      if (qty > 0) {
        slUpdateItemQty(_slActiveId, parseInt(inp.dataset.typeid), qty);
        _renderSlContent();
      }
    });
  });

  // Quantity: − button (halve or subtract step)
  main.querySelectorAll('.sl-decr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeId = parseInt(btn.dataset.typeid);
      const item   = slGetAll().find(l => l.id === _slActiveId)?.items.find(i => i.typeId === typeId);
      if (!item) return;
      const step = item.qty >= 1000 ? 100 : item.qty >= 100 ? 10 : 1;
      slUpdateItemQty(_slActiveId, typeId, Math.max(1, item.qty - step));
      _renderSlContent();
    });
  });

  // Quantity: + button (increment by step)
  main.querySelectorAll('.sl-incr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeId = parseInt(btn.dataset.typeid);
      const item   = slGetAll().find(l => l.id === _slActiveId)?.items.find(i => i.typeId === typeId);
      if (!item) return;
      const step = item.qty >= 1000 ? 100 : item.qty >= 100 ? 10 : 1;
      slUpdateItemQty(_slActiveId, typeId, item.qty + step);
      _renderSlContent();
    });
  });

  // Remove item
  main.querySelectorAll('.sl-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      slRemoveItem(_slActiveId, parseInt(btn.dataset.typeid));
      _renderSlSidebar();
      _renderSlContent();
    });
  });
}
