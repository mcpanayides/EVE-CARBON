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

  // Show a loading indicator immediately so the user knows something is happening
  dropdown.innerHTML = `
    <div class="dropdown-item" style="color:var(--text-3);cursor:default;justify-content:center;">
      Searching…
    </div>`;
  dropdown.style.display = 'block';

  // Search local SDE first (fast, no ESI dependency)
  let results = [];
  try {
    results = await window.eveAPI.searchTypes(query, 15);
  } catch (_) {}

  if (!results.length) {
    dropdown.innerHTML = `
      <div class="dropdown-item" style="color:var(--text-3);cursor:default;justify-content:center;">
        No results for "${escHtml(query)}"
      </div>`;
    return;
  }

  dropdown.innerHTML = '';
  results.forEach(({ id, name }) => {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.innerHTML = `<span>${escHtml(name)}</span><small>#${id}</small>`;
    item.addEventListener('click', () => selectManualSearchItem({ id, name }));
    dropdown.appendChild(item);
  });
  dropdown.style.display = 'block';
}

async function selectManualSearchItem(item) {
  const input    = document.getElementById('bpName');
  const dropdown = document.getElementById('searchDropdown');
  if (input)    input.value          = item.name;
  if (dropdown) dropdown.style.display = 'none';
  await loadManualBlueprintSearch(item.id, item.name);
}

async function loadManualBlueprintSearch(typeId, itemName) {
  const results = document.getElementById('results');
  if (!results) return;

  const ESI_IMG = 'https://images.evetech.net/types';

  // Loading skeleton
  results.innerHTML = `
    <div style="padding:20px;">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;">
        <img src="${ESI_IMG}/${typeId}/bp?size=64"
             onerror="this.onerror=null;this.src='${ESI_IMG}/${typeId}/icon?size=64';"
             style="width:64px;height:64px;border-radius:4px;border:1px solid var(--border);flex-shrink:0;">
        <div>
          <div style="font-size:18px;font-weight:700;color:var(--text-1);margin-bottom:4px;">
            ${escHtml(itemName)}
          </div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);">
            RESOLVING BLUEPRINT DATA…
          </div>
        </div>
      </div>
      <div style="height:2px;background:var(--bg-card);border-radius:1px;overflow:hidden;">
        <div style="height:100%;width:40%;background:var(--accent);
                    animation:bpLoadSlide 1.2s ease-in-out infinite;"></div>
      </div>
    </div>`;

  // Step 1: try treating typeId as a blueprint directly
  let blueprintTypeId = typeId;
  let sdeResult = null;

  try {
    sdeResult = await window.eveAPI.sdeBlueprintMaterials(typeId, 0);
  } catch (_) {}

  // Step 2: typeId might be a product — find its blueprint
  if (!sdeResult?.materials?.length) {
    try {
      const bpData = await window.eveAPI.findBpForProduct(typeId);
      const entry  = bpData?.[typeId];
      const bpId   = entry?.blueprintDetails?.blueprintTypeID;
      if (bpId) {
        blueprintTypeId = bpId;
        try {
          sdeResult = await window.eveAPI.sdeBlueprintMaterials(blueprintTypeId, 0);
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Step 3: Fuzzwork fallback
  if (!sdeResult?.materials?.length) {
    try {
      const fw = await window.eveAPI.getBlueprintMaterials(blueprintTypeId);
      if (fw?.materials?.length) {
        sdeResult = {
          materials: fw.materials.map(m => ({
            typeId:      m.typeid,
            name:        m.name || `Type ${m.typeid}`,
            baseQty:     m.quantity,
            adjustedQty: m.quantity,
            isComponent: false,
          })),
          productTypeId: null,
          productName:   null,
          productQty:    1,
        };
      }
    } catch (_) {}
  }

  if (!sdeResult?.materials?.length) {
    results.innerHTML = `
      <div style="padding:32px 20px;text-align:center;">
        <div style="font-size:28px;margin-bottom:12px;opacity:0.3;">⬡</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--text-3);">
          No blueprint data found for <strong style="color:var(--text-2);">${escHtml(itemName)}</strong>
        </div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);margin-top:8px;">
          This item may not have a manufacturing blueprint, or may be a reaction / PI schematic.
        </div>
      </div>`;
    return;
  }

  // Fetch Jita prices for all materials + the product
  const matTypeIds  = sdeResult.materials.map(m => m.typeId);
  const productId   = sdeResult.productTypeId || typeId;
  const priceIds    = [...new Set([...matTypeIds, productId])];
  let prices = {};
  try {
    prices = await window.eveAPI.getJitaPrices(priceIds) || {};
  } catch (_) {}

  renderBpSearchDetail(results, itemName, blueprintTypeId, productId, sdeResult, prices);
}

function renderBpSearchDetail(container, itemName, blueprintTypeId, productTypeId, sdeResult, prices) {
  const ESI_IMG    = 'https://images.evetech.net/types';
  const baseMats   = sdeResult.materials;    // store for ME recalculation
  const productQty = sdeResult.productQty || 1;
  const productName = sdeResult.productName || itemName;

  container.innerHTML = `
    <div id="bpSearchWrap" style="padding:20px;">

      <!-- ── Header ── -->
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;">
        <img src="${ESI_IMG}/${blueprintTypeId}/bp?size=64"
             onerror="this.onerror=null;this.src='${ESI_IMG}/${blueprintTypeId}/icon?size=64';"
             style="width:64px;height:64px;border-radius:4px;border:1px solid var(--border);flex-shrink:0;">
        <div style="flex:1;">
          <div style="font-size:18px;font-weight:700;color:var(--text-1);margin-bottom:6px;">
            ${escHtml(itemName)}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            <span style="background:var(--bg-card);border:1px solid var(--border);border-radius:3px;
                         padding:2px 10px;font-family:var(--mono);font-size:10px;color:var(--text-3);">
              BP ID ${blueprintTypeId}
            </span>
            ${sdeResult.productTypeId
              ? `<span style="background:var(--bg-card);border:1px solid var(--border);border-radius:3px;
                              padding:2px 10px;font-family:var(--mono);font-size:10px;color:var(--text-3);">
                   PRODUCT ID ${sdeResult.productTypeId}
                 </span>`
              : ''}
          </div>
        </div>
      </div>

      <!-- ── Controls: ME slider + Runs ── -->
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;
                  padding:12px 16px;background:var(--bg-card);border:1px solid var(--border);
                  border-radius:6px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                       letter-spacing:0.08em;white-space:nowrap;">MATERIAL EFFICIENCY</span>
          <input type="range" id="bpSearchME" min="0" max="10" value="0"
                 style="width:120px;accent-color:var(--accent);cursor:pointer;">
          <span id="bpSearchMELabel"
                style="font-family:var(--mono);font-size:13px;font-weight:700;
                       color:var(--success);min-width:36px;">ME 0</span>
        </div>
        <div style="width:1px;height:20px;background:var(--border);flex-shrink:0;"></div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                       letter-spacing:0.08em;white-space:nowrap;">RUNS</span>
          <input type="number" id="bpSearchRuns" min="1" max="99999" value="1"
                 class="field-input"
                 style="width:80px;padding:4px 8px;font-size:12px;font-family:var(--mono);">
        </div>
        <div style="display:flex;gap:8px;margin-left:auto;">
          <button id="bpSearchAddListBtn" class="bp-view-btn"
                  style="padding:5px 14px;font-size:11px;background:var(--bg-hover);">
            ➕ ADD TO LIST
          </button>
          <button id="bpSearchCalcBtn" class="bp-view-btn"
                  style="padding:5px 14px;font-size:11px;">
            ◈ OPEN IN CALCULATOR
          </button>
        </div>
      </div>

      <!-- ── Produces ── -->
      <div style="margin-bottom:14px;">
        <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                    letter-spacing:0.1em;margin-bottom:6px;">PRODUCES</div>
        <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;
                    background:var(--bg-card);border:1px solid var(--border);border-radius:4px;">
          <img src="${ESI_IMG}/${productTypeId}/icon?size=32"
               onerror="this.onerror=null;this.style.display='none';"
               style="width:28px;height:28px;border-radius:3px;flex-shrink:0;">
          <span style="color:var(--text-1);font-size:13px;flex:1;">${escHtml(productName)}</span>
          <span id="bpSearchProductQty"
                style="font-family:var(--mono);color:var(--text-2);font-size:12px;">
            ×${productQty.toLocaleString()}
          </span>
          ${(() => {
            const p = prices[productTypeId];
            const sell = p?.sell > 0 ? p.sell : null;
            return sell
              ? `<span style="font-family:var(--mono);font-size:11px;color:var(--accent);">
                   ${formatNumber(sell)} ISK/unit
                 </span>`
              : '';
          })()}
        </div>
      </div>

      <!-- ── Materials header ── -->
      <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                  letter-spacing:0.1em;margin-bottom:8px;" id="bpSearchMatHeader">
        MATERIALS — 1 RUN · ME0
      </div>

      <!-- ── Materials table ── -->
      <div id="bpSearchMatTable" style="display:flex;flex-direction:column;gap:3px;
                                        margin-bottom:16px;"></div>

      <!-- ── Cost summary ── -->
      <div id="bpSearchCostSummary" style="margin-bottom:16px;"></div>

      <!-- ── Component tree ── -->
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <button id="bpSearchTreeBtn" class="bp-view-btn"
                style="padding:5px 14px;font-size:11px;background:var(--bg-hover);">
          ⬡ SHOW COMPONENT TREE
        </button>
      </div>
      <div id="bpSearchTree" style="display:none;"></div>

    </div>`;

  // ── Initial render ────────────────────────────────────────────────────────
  _bpSearchUpdate(container, baseMats, prices, productQty, 0, 1);

  // ── ME slider ────────────────────────────────────────────────────────────
  container.querySelector('#bpSearchME').addEventListener('input', e => {
    const me   = parseInt(e.target.value);
    const runs = parseInt(container.querySelector('#bpSearchRuns').value) || 1;
    container.querySelector('#bpSearchMELabel').textContent = `ME ${me}`;
    _bpSearchUpdate(container, baseMats, prices, productQty, me, runs);
  });

  // ── Runs input ───────────────────────────────────────────────────────────
  container.querySelector('#bpSearchRuns').addEventListener('input', e => {
    const runs = Math.max(1, parseInt(e.target.value) || 1);
    const me   = parseInt(container.querySelector('#bpSearchME').value);
    _bpSearchUpdate(container, baseMats, prices, productQty, me, runs);
  });

  // ── Add to Shopping List ─────────────────────────────────────────────────
  container.querySelector('#bpSearchAddListBtn')?.addEventListener('click', () => {
    const me   = parseInt(container.querySelector('#bpSearchME').value) || 0;
    const runs = parseInt(container.querySelector('#bpSearchRuns').value) || 1;
    const slMats = baseMats.map(m => ({
      typeId: m.typeId,
      name:   m.name,
      qty:    Math.max(1, Math.ceil(m.baseQty * (1 - me / 100))) * runs,
    }));
    if (typeof showAddToShoppingListModal === 'function') {
      showAddToShoppingListModal(slMats, itemName);
    }
  });

  // ── Open in calculator ───────────────────────────────────────────────────
  container.querySelector('#bpSearchCalcBtn').addEventListener('click', () => {
    if (typeof selectedBpTypeId !== 'undefined') selectedBpTypeId = blueprintTypeId;
    if (typeof selectedME !== 'undefined') {
      selectedME = parseInt(container.querySelector('#bpSearchME').value);
    }
    if (typeof selectedTE !== 'undefined') selectedTE = 0;
    if (typeof navigateIndustryTab === 'function') navigateIndustryTab('calculator');
  });

  // ── Component tree ───────────────────────────────────────────────────────
  container.querySelector('#bpSearchTreeBtn').addEventListener('click', async () => {
    const treeDiv = container.querySelector('#bpSearchTree');
    const treeBtn = container.querySelector('#bpSearchTreeBtn');
    if (!treeDiv) return;
    if (treeDiv.style.display !== 'none') {
      treeDiv.style.display = 'none';
      treeBtn.textContent   = '⬡ SHOW COMPONENT TREE';
      return;
    }
    treeDiv.style.display = 'block';
    treeBtn.textContent   = '⬡ HIDE COMPONENT TREE';
    if (typeof renderComponentTreePanel === 'function') {
      const me = parseInt(container.querySelector('#bpSearchME').value);
      await renderComponentTreePanel(treeDiv, { type_id: blueprintTypeId, me, te: 0, name: itemName });
    }
  });
}

function _bpSearchUpdate(container, baseMats, prices, productQty, me, runs) {
  const matHeader = container.querySelector('#bpSearchMatHeader');
  const matTable  = container.querySelector('#bpSearchMatTable');
  const costSumm  = container.querySelector('#bpSearchCostSummary');
  const prodQtyEl = container.querySelector('#bpSearchProductQty');
  if (!matTable) return;

  if (matHeader) {
    matHeader.textContent = `MATERIALS — ${runs > 1 ? runs + ' RUNS' : '1 RUN'} · ME${me}`;
  }
  if (prodQtyEl) {
    prodQtyEl.textContent = `×${(productQty * runs).toLocaleString()}`;
  }

  const ESI_IMG = 'https://images.evetech.net/types';
  let totalCost = 0;
  let pricesAvailable = false;

  const rows = baseMats.map(mat => {
    const adjQty = Math.max(1, Math.ceil(mat.baseQty * (1 - me / 100))) * runs;
    const baseQtyDisplay = mat.baseQty * runs;

    const p = prices[mat.typeId];
    const unitPrice = p?.sell > 0 ? p.sell : (p?.buy > 0 ? p.buy : 0);
    const rowTotal  = unitPrice * adjQty;
    if (unitPrice > 0) { totalCost += rowTotal; pricesAvailable = true; }

    const isComponent = mat.isComponent;
    const saved = baseQtyDisplay - adjQty;

    return `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:4px;
                  background:${isComponent ? 'var(--bg-card)' : 'transparent'};
                  border:1px solid ${isComponent ? 'var(--border)' : 'transparent'};">
        <img src="${ESI_IMG}/${mat.typeId}/icon?size=32"
             onerror="this.onerror=null;this.style.display='none';"
             style="width:28px;height:28px;border-radius:3px;flex-shrink:0;">
        <span style="flex:1;color:${isComponent ? 'var(--tier-top)' : 'var(--text-1)'};
                     font-size:13px;font-weight:${isComponent ? '600' : '400'};">
          ${isComponent ? '◈ ' : ''}${escHtml(mat.name || `Type ${mat.typeId}`)}
        </span>
        <span style="font-family:var(--mono);color:var(--text-1);font-size:12px;
                     font-weight:600;flex-shrink:0;min-width:80px;text-align:right;">
          ×${adjQty.toLocaleString()}
        </span>
        ${saved > 0
          ? `<span style="font-family:var(--mono);color:var(--success);font-size:10px;
                          flex-shrink:0;" title="ME saves ${saved.toLocaleString()} units">
               −${saved.toLocaleString()}
             </span>`
          : '<span style="min-width:32px;"></span>'}
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     flex-shrink:0;min-width:90px;text-align:right;">
          ${unitPrice > 0 ? formatNumber(unitPrice) + ' ISK' : '—'}
        </span>
        <span style="font-family:var(--mono);font-size:12px;font-weight:600;
                     color:${unitPrice > 0 ? 'var(--text-1)' : 'var(--text-3)'};
                     flex-shrink:0;min-width:110px;text-align:right;">
          ${rowTotal > 0 ? formatNumber(rowTotal) : '—'}
        </span>
      </div>`;
  });

  // Column header row
  matTable.innerHTML = `
    <div style="display:flex;gap:10px;padding:4px 10px;font-family:var(--mono);
                font-size:9px;color:var(--text-3);letter-spacing:0.08em;">
      <span style="width:28px;flex-shrink:0;"></span>
      <span style="flex:1;">MATERIAL</span>
      <span style="min-width:80px;text-align:right;">QTY NEEDED</span>
      <span style="min-width:32px;text-align:right;">ME SAVING</span>
      <span style="min-width:90px;text-align:right;">JITA SELL/UNIT</span>
      <span style="min-width:110px;text-align:right;">TOTAL COST</span>
    </div>
    ${rows.join('')}`;

  // Cost summary
  if (costSumm) {
    if (!pricesAvailable) {
      costSumm.innerHTML = `
        <div style="padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);
                    border-radius:4px;font-family:var(--mono);font-size:11px;color:var(--text-3);">
          Market price data unavailable
        </div>`;
    } else {
      costSumm.innerHTML = `
        <div style="padding:14px 18px;background:var(--bg-card);border:1px solid var(--border);
                    border-radius:6px;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;">
          <div>
            <div style="font-family:var(--mono);font-size:9px;color:var(--text-3);
                        letter-spacing:0.12em;margin-bottom:4px;">
              ESTIMATED BUILD COST (${runs > 1 ? runs + ' RUNS' : '1 RUN'} · ME${me} · JITA SELL)
            </div>
            <div style="font-family:var(--mono);font-size:22px;font-weight:700;color:var(--accent);">
              ${formatNumber(totalCost)} ISK
            </div>
          </div>
          ${runs > 1
            ? `<div style="padding-left:16px;border-left:1px solid var(--border);">
                 <div style="font-family:var(--mono);font-size:9px;color:var(--text-3);
                             letter-spacing:0.12em;margin-bottom:4px;">PER RUN</div>
                 <div style="font-family:var(--mono);font-size:16px;color:var(--text-2);">
                   ${formatNumber(totalCost / runs)} ISK
                 </div>
               </div>`
            : ''}
          <div style="margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--text-3);">
            Based on Jita 4-4 sell orders
          </div>
        </div>`;
    }
  }
}