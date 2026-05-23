// ─── Materials Modal ──────────────────────────────────────────────────────────

async function openMaterialsInTab(typeId) {
  showToast('Calculating materials...', 'info');
  try {
    const allBps = await window.eveAPI.getAllBlueprints();
    const bp     = allBps.find(b => b.type_id === typeId);
    const bpName = bp ? bp.name : `Type ${typeId}`;
    const mLevel = bp ? bp.me  : 0;

    let tree       = null;
    let usedTypeId = typeId;

    try {
      tree = await buildRecursiveMaterialTree(typeId, 1);
    } catch (e) {
      // Fallback: try the product type ID instead
      try {
        const productTypeId = await window.eveAPI.getProductForBlueprint(typeId);
        if (productTypeId && productTypeId !== typeId) {
          tree       = await buildRecursiveMaterialTree(productTypeId, 1);
          usedTypeId = productTypeId;
        }
      } catch (crossCheckError) { /* ignore */ }
      if (!tree?.length) tree = [];
    }

    showMaterialsModal(typeId, bpName, mLevel, tree);
  } catch (e) {
    console.error('Materials loading error:', e);
    showToast(`Failed to load materials: ${e.message}`, 'error');
  }
}

function closeMaterialsModal() {
  const backdrop = document.getElementById('materialsModalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

async function showMaterialsModal(typeId, bpName, meLevel, materialTree) {
  const backdrop = document.getElementById('materialsModalBackdrop');
  const icon     = document.getElementById('materialsModalIcon');
  const title    = document.getElementById('materialsModalTitle');
  const body     = document.getElementById('materialsModalBody');
  if (!backdrop) return;

  icon.src      = `https://images.evetech.net/types/${typeId}/bp?size=64`;
  icon.onerror  = () => { icon.onerror = null; icon.src = `https://images.evetech.net/types/${typeId}/icon?size=64`; };
  title.textContent = escHtml(bpName);
  body.innerHTML    = '<div style="text-align:center;padding:20px;color:var(--text-2);">⬡ Fetching market prices...</div>';
  backdrop.style.display = 'flex';

  try {
    if (!materialTree?.length) {
      body.innerHTML = `
        <div style="padding:20px;">
          <div style="padding:12px;background:var(--bg-card);border:1px solid var(--border);
                      border-radius:4px;margin-bottom:12px;">
            <div style="font-size:12px;color:var(--text-3);margin-bottom:8px;font-family:var(--mono);">
              ⚠ BLUEPRINT NOT IN PUBLIC DATABASE
            </div>
            <div style="font-size:11px;color:var(--text-2);line-height:1.5;">
              Type ID <strong style="font-family:var(--mono);">${typeId}</strong> is not in Fuzzwork's public API database.
              <br/><br/>Try the EVE wiki, in-game blueprint copies, or a third-party industry tool.
            </div>
          </div>
        </div>`;
      return;
    }

    // Flatten tree → unique type IDs, fetch prices
    const items = new Map();
    const flattenTree = (nodes) => {
      if (!nodes) return;
      nodes.forEach(node => {
        items.set(node.typeid, (items.get(node.typeid) || 0) + node.quantity);
        if (node.subTree) flattenTree(node.subTree);
      });
    };
    flattenTree(materialTree);

    let jitaPrice = 0;
    let priceData = {};
    let priceError = null;

    try {
      const typeIds = Array.from(items.keys());
      if (typeIds.length) {
        priceData = await window.eveAPI.getJitaPrices(typeIds);
        for (const [tid, qty] of items.entries()) {
          const entry    = priceData[tid] || {};
          const unitPrice = entry.sell > 0 ? entry.sell : entry.buy;
          if (unitPrice) jitaPrice += unitPrice * qty;
        }
      }
    } catch (e) {
      priceError = e.message;
    }

    const materialsHtml = generateMaterialsTable(materialTree, priceData);

    let priceDisplay;
    if (priceError) {
      priceDisplay = `<div style="padding:12px;background:var(--bg-card);border:1px solid var(--border);
                           border-radius:4px;margin-bottom:16px;color:var(--text-3);
                           text-align:center;font-size:12px;">
        ⚠ Price data unavailable (${priceError})
      </div>`;
    } else if (jitaPrice > 0) {
      priceDisplay = `<div style="padding:12px;background:var(--bg-card);border:1px solid var(--border);
                           border-radius:4px;margin-bottom:16px;">
        <div style="font-size:11px;color:var(--text-3);margin-bottom:4px;font-family:var(--mono);">ESTIMATED JITA COST (1 RUN)</div>
        <div style="font-size:20px;color:var(--accent);font-weight:600;font-family:var(--mono);">${formatNumber(jitaPrice)} ISK</div>
        <div style="font-size:10px;color:var(--text-3);margin-top:6px;font-family:var(--mono);">Based on current Jita 4-4 market prices</div>
      </div>`;
    } else {
      priceDisplay = `<div style="padding:12px;background:var(--bg-card);border:1px solid var(--border);
                           border-radius:4px;margin-bottom:16px;color:var(--text-3);
                           text-align:center;font-size:12px;">Price data loading...</div>`;
    }

    body.innerHTML = `
      <div style="padding:12px 0;">
        <div style="font-size:12px;color:var(--text-2);margin-bottom:12px;font-family:var(--mono);">
          <span style="background:var(--bg-card);padding:3px 8px;border-radius:3px;display:inline-block;">ME ${meLevel}</span>
        </div>
        ${priceDisplay}
        <div style="font-size:11px;color:var(--text-3);margin-bottom:8px;
                    font-family:var(--mono);letter-spacing:0.1em;">MATERIALS REQUIRED</div>
        ${materialsHtml}
      </div>`;
  } catch (e) {
    console.error('Modal display error:', e);
    body.innerHTML = `
      <div style="text-align:center;padding:20px;color:var(--danger);">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px;">⚠ Error Loading Materials</div>
        <div style="font-size:12px;color:var(--text-2);">${escHtml(e.message)}</div>
      </div>`;
  }
}

function generateMaterialsTable(treeNodes, priceData = {}) {
  if (!treeNodes?.length) return '<div style="color:var(--text-3);">No materials required</div>';
  return `
    <table style="width:100%;border-collapse:collapse;font-size:12px;font-family:var(--mono);">
      <thead style="border-bottom:1px solid var(--border);">
        <tr style="color:var(--text-3);">
          <th style="text-align:left;padding:6px 0;font-weight:500;">Item</th>
          <th style="text-align:right;padding:6px 0;font-weight:500;">Quantity</th>
          <th style="text-align:right;padding:6px 0;font-weight:500;">Unit Price</th>
          <th style="text-align:right;padding:6px 0;font-weight:500;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${treeNodes.map(node => {
          const price    = priceData[node.typeid];
          const unitPrice = price?.sell > 0 ? price.sell : (price?.buy > 0 ? price.buy : 0);
          const totalPrice = unitPrice * node.quantity;
          return `
            <tr style="border-bottom:1px solid var(--border);
                       background:${node.subTree ? 'var(--bg-card)' : 'transparent'};">
              <td style="padding:8px 0;color:${node.subTree ? 'var(--accent)' : 'var(--text-1)'};
                         font-weight:${node.subTree ? '500' : '400'};">
                ${node.subTree ? '◈' : '⬡'} ${escHtml(node.name)}
              </td>
              <td style="text-align:right;padding:8px 0;color:var(--text-2);">${formatNumber(node.quantity)}</td>
              <td style="text-align:right;padding:8px 0;color:var(--text-2);">${unitPrice  > 0 ? formatNumber(unitPrice)  : '—'}</td>
              <td style="text-align:right;padding:8px 0;color:var(--text-1);">${totalPrice > 0 ? formatNumber(totalPrice) : '—'}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ─── Manual Blueprint Search ──────────────────────────────────────────────────

async function handleManualSearchInput() {
  const input    = document.getElementById('bpName');
  const dropdown = document.getElementById('searchDropdown');
  if (!input || !dropdown) return;

  const query = input.value.trim();
  if (query.length < 2) { dropdown.style.display = 'none'; return; }

  try {
    const data = await window.eveAPI.search(query);
    const ids  = (data?.inventory_type || []).slice(0, 12);
    if (!ids.length) { dropdown.style.display = 'none'; return; }

    const names = {};
    for (const id of ids) {
      try { const n = await window.eveAPI.sdeGetName(id); if (n) names[id] = n; } catch (e) { /* ignore */ }
    }
    try {
      const esiNames = await window.eveAPI.getNames(ids);
      Object.assign(names, esiNames || {});
    } catch (e) { /* ignore */ }

    dropdown.innerHTML = '';
    ids.forEach(id => {
      const name = names[id] || `Type ${id}`;
      const item = document.createElement('div');
      item.className = 'dropdown-item';
      item.innerHTML = `<span>${escHtml(name)}</span><small>#${id}</small>`;
      item.addEventListener('click', () => selectManualSearchItem({ id, name }));
      dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
  } catch (err) {
    dropdown.style.display = 'none';
  }
}

async function selectManualSearchItem(item) {
  const input    = document.getElementById('bpName');
  const dropdown = document.getElementById('searchDropdown');
  if (input)    input.value          = item.name;
  if (dropdown) dropdown.style.display = 'none';
  await loadManualBlueprintSearch(item.id, item.name);
}

async function loadManualBlueprintSearch(typeId, itemName) {
  const card    = document.getElementById('selectedBpCard');
  const icon    = document.getElementById('selectedBpIcon');
  const nameEl  = document.getElementById('selectedBpName');
  const metaEl  = document.getElementById('selectedBpMeta');
  const results = document.getElementById('results');

  if (card)   card.style.display = 'flex';
  if (icon)   { icon.src = `https://images.evetech.net/types/${typeId}/bp?size=64`; icon.alt = itemName; }
  if (nameEl) nameEl.textContent = itemName;

  let blueprintDetails = null;
  try {
    const data    = await window.eveAPI.findBpForProduct(typeId);
    const payload = data?.[typeId] || data;
    blueprintDetails = payload?.blueprintDetails || null;
  } catch (err) { /* not found */ }

  if (metaEl) {
    metaEl.textContent = blueprintDetails
      ? `Blueprint ID ${blueprintDetails.blueprintTypeID} • Runs ${blueprintDetails.maxProductionLimit ?? 'N/A'}`
      : 'No public blueprint copy found on Fuzzwork.';
  }

  if (results) {
    results.style.display = 'block';
    results.innerHTML = `
      <div class="panel" style="display:flex;gap:12px;align-items:center;padding:12px;">
        <img src="https://images.evetech.net/types/${typeId}/bp?size=64"
             style="width:48px;height:48px;border-radius:6px;border:1px solid var(--border);"
             onerror="this.onerror=null;this.src='https://images.evetech.net/types/${typeId}/icon?size=64';"/>
        <div style="flex:1;">
          <div style="font-weight:700;color:var(--text-1);">${escHtml(itemName)}</div>
          <div style="font-size:11px;color:var(--text-2);">Type ID: ${typeId}</div>
          <div style="margin-top:8px;font-size:12px;color:var(--text-3);">${escHtml(metaEl ? metaEl.textContent : '')}</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="manual-view-materials" class="calc-btn">View Materials</button>
        </div>
      </div>`;

    const mvBtn = document.getElementById('manual-view-materials');
    if (mvBtn) {
      mvBtn.addEventListener('click', async () => {
        showToast('Calculating materials...', 'info');
        await openMaterialsInTab(typeId);
      });
    }
  }
}