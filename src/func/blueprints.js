// ─── Blueprint Library ────────────────────────────────────────────────────────
// Reads blueprint data from character_information.db (SQLite) via the
// 'get-all-blueprints-from-db' IPC handler.
// The View button queries SDE materials and applies the blueprint's real ME/TE.

// NOTE: allLibBPs, filterPerfectOnly, searchTimer, manualSearchTimer,
// currentIndustryTab, selectedBpTypeId, selectedME, selectedTE, and ESI_IMAGE
// are all declared in state.js which loads before this file. Do not re-declare them here.

// ─── Load & filter ────────────────────────────────────────────────────────────

let _bpLibLoading = false;

async function loadBlueprintLibrary() {
  _bpLibLoading = true;
  _renderBpLibLoadingState();   // show bar immediately if the tab is already open

  try {
    let bps = [];
    try {
      bps = await window.eveAPI.getAllBlueprintsFromDb();
    } catch (_) {
      bps = await window.eveAPI.getAllBlueprints();
    }

    allLibBPs = Array.isArray(bps) ? bps : [];
    allLibBPs.sort((a, b) => (a.type_name || a.name || '').localeCompare(b.type_name || b.name || ''));

    allLibBPs = allLibBPs.map(bp => ({
      ...bp,
      name:  bp.type_name || bp.name || `Type ${bp.type_id}`,
      me:    bp.me    ?? 0,
      te:    bp.te    ?? 0,
      runs:  bp.runs  ?? -1,
      isBPC: bp.is_bpc ? true : (bp.isBPC ?? (bp.quantity === -2)),
    }));

    renderBlueprintList(allLibBPs);
  } catch (err) {
    console.error('Failed to load blueprint library from DB:', err);
    showToast('Error loading blueprints from database.', 'error');
    _renderBpLibLoadingState(true);
  } finally {
    _bpLibLoading = false;
  }
}

function _renderBpLibLoadingState(isError = false) {
  const listDiv = document.getElementById('bpLibList');
  if (!listDiv) return;

  if (isError) {
    listDiv.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:48px 20px;
                  font-family:var(--mono);font-size:11px;color:var(--danger);">
        ⚠ FAILED TO LOAD BLUEPRINT LIBRARY
      </div>`;
    return;
  }

  // Build shimmer skeleton cards that match the real bp-lib-item shape
  const card = () => `
    <div class="bp-skel-card">
      <!-- thumb -->
      <div class="bp-skel-block" style="width:48px;height:48px;border-radius:14px;flex-shrink:0;"></div>
      <!-- content -->
      <div style="flex:1;display:flex;flex-direction:column;gap:8px;min-width:0;">
        <div class="bp-skel-block" style="height:14px;width:65%;"></div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <div class="bp-skel-block" style="width:32px;height:8px;"></div>
            <div class="bp-skel-block" style="flex:1;height:5px;border-radius:3px;"></div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <div class="bp-skel-block" style="width:32px;height:8px;"></div>
            <div class="bp-skel-block" style="flex:1;height:5px;border-radius:3px;"></div>
          </div>
        </div>
      </div>
      <!-- right: portrait + badge + button -->
      <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
        <div class="bp-skel-block" style="width:36px;height:36px;border-radius:4px;"></div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
          <div class="bp-skel-block" style="width:56px;height:18px;border-radius:3px;"></div>
          <div class="bp-skel-block" style="width:48px;height:22px;border-radius:4px;"></div>
        </div>
      </div>
    </div>`;

  // Fill the grid with 16 skeleton cards (enough to cover a typical screen)
  listDiv.innerHTML = Array.from({ length: 16 }, card).join('');
}

function handleLibraryFilter() {
  const query      = (document.getElementById('bpLibSearch')?.value   || '').toLowerCase();
  const filterMode = document.getElementById('bpLibFilter')?.value    || 'all';
  const sortBy     = document.getElementById('bpLibSort')?.value      || 'name';
  const minME      = parseInt(document.getElementById('bpLibMinME')?.value)   || 0;
  const minTE      = parseInt(document.getElementById('bpLibMinTE')?.value)   || 0;
  const minRuns    = parseInt(document.getElementById('bpLibMinRuns')?.value) || 0;

  const filtered = allLibBPs.filter(bp => {
    const matchesName    = bp.name.toLowerCase().includes(query);
    const matchesType    = filterMode === 'all'
                        || (filterMode === 'bpo' && !bp.isBPC)
                        || (filterMode === 'bpc' &&  bp.isBPC);
    const matchesME      = bp.me >= minME;
    const matchesTE      = bp.te >= minTE;
    const matchesRuns    = !bp.isBPC || bp.runs >= minRuns;
    const matchesPerfect = !filterPerfectOnly || (bp.me === 10 && bp.te === 20);
    return matchesName && matchesType && matchesME && matchesTE && matchesRuns && matchesPerfect;
  });

  renderBlueprintList(sortBlueprints(filtered, sortBy));
}

function togglePerfectFilter(value) {
  filterPerfectOnly = typeof value === 'boolean' ? value : !filterPerfectOnly;
  showToast(filterPerfectOnly ? 'Filtering: perfect blueprints only' : 'Showing all blueprints', 'info');
  handleLibraryFilter();
}

function sortBlueprints(bps, criteria) {
  return [...bps].sort((a, b) => {
    if (criteria === 'me')   return b.me - a.me;
    if (criteria === 'te')   return b.te - a.te;
    if (criteria === 'runs') return (b.runs || 0) - (a.runs || 0);
    return a.name.localeCompare(b.name);
  });
}

// ─── Render card list ─────────────────────────────────────────────────────────

function renderBlueprintList(bps) {
  const listDiv   = document.getElementById('bpLibList');
  const countSpan = document.getElementById('bpLibCount');
  if (!listDiv) return;
  if (countSpan) countSpan.textContent = bps.length;
  listDiv.innerHTML = '';

  if (bps.length === 0) {
    listDiv.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;margin-top:40px;">
        <div class="empty-icon">⬡</div>
        <div class="empty-title">NO BLUEPRINTS FOUND</div>
        <div class="empty-sub">Sync a character or adjust your advanced filter settings.</div>
      </div>`;
    return;
  }

  bps.forEach(bp => {
    const item = document.createElement('div');
    item.className = 'bp-lib-item';

    const mePct = Math.min(100, Math.max(0, (bp.me / 10) * 100));
    const tePct = Math.min(100, Math.max(0, (bp.te / 20) * 100));

    const isTech2   = /\b(?:tech\s*ii|tech\s*2|t2|mk\s*ii|mark\s*ii|\bII\b)\b/i.test(bp.name);
    const isFaction = /\b(?:faction|navy|pirate|guristas|serpentis|angel cartel|blood raiders|sansha|angel|mordu|sisters|drifter|triglavian)\b/i.test(bp.name);

    const dots = [];
    if (bp.me === 10 && bp.te === 20) dots.push('<span class="card-perfect-dot" title="Perfect BP"></span>');
    if (isTech2)   dots.push('<span class="card-tier-dot tech2"   title="Tech II Blueprint"></span>');
    if (isFaction) dots.push('<span class="card-tier-dot faction" title="Faction Blueprint"></span>');

    const badgeStyle = 'display:inline-block;min-width:65px;text-align:center;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:bold;flex-shrink:0;';
    const typeBadge  = bp.isBPC
      ? `<span style="${badgeStyle}background:#1b2a40;color:#4ada8a;">${bp.runs > 0 ? bp.runs : '∞'} RUNS</span>`
      : `<span style="${badgeStyle}background:#1b2a40;color:#ab7ab8;">BPO</span>`;

    // characterId may be stored as a number in the DB row
    const charId   = bp.characterId   || bp.character_id   || '';
    const charName = bp.characterName || bp.character_name || 'Unknown';

    item.innerHTML = `
      <img class="bp-lib-thumb"
           src="${ESI_IMAGE}/${bp.type_id}/bp?size=32"
           onerror="this.onerror=null;this.src='${ESI_IMAGE}/${bp.type_id}/icon?size=32';"
           alt="bp-icon">
      <div class="bp-lib-content">
        <div class="bp-lib-title">${escHtml(bp.name)}</div>
        <div class="bp-stats-vert">
          <div class="bp-stat">
            <div class="bp-stat-label">ME ${bp.me}</div>
            <div class="bp-stat-track"><div class="bp-stat-fill me" style="width:${mePct}%"></div></div>
          </div>
          <div class="bp-stat">
            <div class="bp-stat-label">TE ${bp.te}</div>
            <div class="bp-stat-track"><div class="bp-stat-fill te" style="width:${tePct}%"></div></div>
          </div>
        </div>
      </div>
      <div class="bp-lib-right">
        ${charId
          ? `<img class="bp-lib-portrait"
                  src="https://images.evetech.net/characters/${charId}/portrait?size=64"
                  loading="lazy" title="Owned by ${escHtml(charName)}" alt="owner portrait">`
          : `<div class="bp-lib-portrait" style="background:var(--bg-card);border:1px solid var(--border);
                    display:flex;align-items:center;justify-content:center;color:var(--text-3);
                    font-size:18px;">⬡</div>`
        }
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
          ${typeBadge}
          <button class="bp-view-btn" type="button">View</button>
        </div>
      </div>
      <div class="card-indicator-row">${dots.join('')}</div>`;

    // ── View button: open SDE-accurate detail panel ──────────────────────────
    item.querySelector('.bp-view-btn').addEventListener('click', async (event) => {
      event.stopPropagation();
      await openBlueprintDetail(bp);
    });

    const cardDot = item.querySelector('.card-perfect-dot');
    if (cardDot) cardDot.addEventListener('click', (ev) => { ev.stopPropagation(); togglePerfectFilter(); });

    listDiv.appendChild(item);
  });
}

function bindLibraryEvents() {
  const libInputs = [
    document.getElementById('bpLibSearch'),
    document.getElementById('bpLibMinME'),
    document.getElementById('bpLibMinTE'),
    document.getElementById('bpLibMinRuns'),
  ];
  libInputs.forEach(input => {
    if (input) input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => handleLibraryFilter(), 300);
    });
  });

  const libFilter = document.getElementById('bpLibFilter');
  if (libFilter) libFilter.addEventListener('change', () => handleLibraryFilter());

  const libSort = document.getElementById('bpLibSort');
  if (libSort) libSort.addEventListener('change', () => handleLibraryFilter());

  const toggleBtn = document.getElementById('toggleLibraryBtn');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleLibraryView);
}

// ─── Blueprint Detail Panel ───────────────────────────────────────────────────
// Opens a detail view for the given `bp` object (from the local DB).
// Queries SDE for the canonical material list and applies the blueprint's real ME.

async function openBlueprintDetail(bp) {
  // Show the results panel and hide the list
  const listSection = document.getElementById('bpLibList')?.closest('div[style*="flex-direction:column"]')
                   || document.getElementById('bpLibList')?.parentElement;
  const resultsDiv  = document.getElementById('results');
  if (!resultsDiv) return;

  // Render a loading skeleton immediately
  resultsDiv.style.display = 'block';
  if (listSection) listSection.style.display = 'none';

  resultsDiv.innerHTML = `
    <div class="panel" style="padding:24px;overflow-y:auto;height:100%;">
      <button id="backToBpLib" style="margin-bottom:20px;padding:6px 14px;
        background:var(--bg-hover);border:1px solid var(--border);color:var(--text-1);
        cursor:pointer;border-radius:var(--radius);font-family:var(--mono);font-size:11px;">
        ← BACK TO LIBRARY
      </button>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;">
        <img src="${ESI_IMAGE}/${bp.type_id}/bp?size=64"
             onerror="this.onerror=null;this.src='${ESI_IMAGE}/${bp.type_id}/icon?size=64';"
             style="width:64px;height:64px;border-radius:4px;border:1px solid var(--border);">
        <div>
          <h2 style="font-size:22px;margin:0 0 6px;color:var(--text-1);">${escHtml(bp.name)}</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <span class="bp-detail-badge" style="background:var(--bg-card);padding:3px 10px;border-radius:3px;
                         font-family:var(--mono);font-size:11px;border:1px solid var(--border);">
              ME <span style="color:var(--success);">${bp.me}</span>
            </span>
            <span class="bp-detail-badge" style="background:var(--bg-card);padding:3px 10px;border-radius:3px;
                         font-family:var(--mono);font-size:11px;border:1px solid var(--border);">
              TE <span style="color:var(--accent);">${bp.te}</span>
            </span>
            <span class="bp-detail-badge" style="background:var(--bg-card);padding:3px 10px;border-radius:3px;
                         font-family:var(--mono);font-size:11px;border:1px solid var(--border);">
              ${bp.isBPC ? `BPC · <span style="color:#4ada8a;">${bp.runs > 0 ? bp.runs + ' runs' : '∞ runs'}</span>` : 'BPO'}
            </span>
          </div>
        </div>
      </div>
      <div id="bpDetailBody" style="background:var(--bg-panel);padding:20px;border:1px solid var(--border);border-radius:6px;">
        <div style="font-family:var(--mono);font-size:11px;color:var(--text-3);letter-spacing:0.08em;">
          LOADING MATERIALS FROM SDE…
        </div>
        <div class="bp-loading-bar" style="margin-top:12px;height:2px;background:var(--bg-card);border-radius:1px;overflow:hidden;">
          <div style="height:100%;width:40%;background:var(--accent);animation:bpLoadSlide 1.2s ease-in-out infinite;"></div>
        </div>
      </div>
    </div>
    <style>
      @keyframes bpLoadSlide {
        0%   { margin-left:-40%; }
        100% { margin-left:140%; }
      }
    </style>`;

  document.getElementById('backToBpLib')?.addEventListener('click', () => {
    resultsDiv.style.display   = 'none';
    resultsDiv.innerHTML       = '';
    if (listSection) listSection.style.display = 'flex';
  });

  // ── Fetch SDE materials ──────────────────────────────────────────────────────
  let sdeResult = null;
  try {
    sdeResult = await window.eveAPI.sdeBlueprintMaterials(bp.type_id, bp.me);
  } catch (err) {
    console.warn('[BpDetail] SDE materials failed, falling back to Fuzzwork:', err.message);
  }

  if (!sdeResult || !sdeResult.materials || sdeResult.materials.length === 0) {
    // Fallback: Fuzzwork API with the blueprint's real ME
    try {
      sdeResult = await fetchFuzzworkMaterials(bp.type_id, bp.me);
    } catch (err) {
      console.error('[BpDetail] Fuzzwork fallback also failed:', err.message);
    }
  }

  const detailBody = document.getElementById('bpDetailBody');
  if (!detailBody) return;   // user navigated away

  if (!sdeResult || !sdeResult.materials || sdeResult.materials.length === 0) {
    detailBody.innerHTML = `
      <div style="font-family:var(--mono);font-size:11px;color:var(--text-3);">
        No material data found for this blueprint in the SDE or Fuzzwork.<br>
        It may be a reaction, PI schematic, or an item without manufacturing activity.
      </div>`;
    return;
  }

  // ── Fetch Jita prices for materials ─────────────────────────────────────────
  const { materials, productTypeId, productName, productQty, runs } = sdeResult;
  const matTypeIds = materials.map(m => m.typeId);
  let prices = {};
  try { prices = await window.eveAPI.getJitaPrices(matTypeIds) || {}; } catch (_) {}

  // ── Render materials table ───────────────────────────────────────────────────
  const productImg = productTypeId
    ? `<img src="${ESI_IMAGE}/${productTypeId}/icon?size=32"
            onerror="this.src='${ESI_IMAGE}/0/icon?size=32';"
            style="width:24px;height:24px;vertical-align:middle;margin-right:6px;border-radius:2px;">`
    : '';

  // Calculate total build cost
  let totalCost = 0;
  materials.forEach(mat => {
    const p = prices[mat.typeId];
    const unit = p?.sell > 0 ? p.sell : (p?.buy || 0);
    totalCost += unit * mat.adjustedQty;
  });

  detailBody.innerHTML = `
    <div style="margin-bottom:16px;">
      <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;margin-bottom:8px;">PRODUCES</div>
      <div style="display:flex;align-items:center;padding:8px 12px;background:var(--bg-card);
                  border:1px solid var(--border);border-radius:4px;gap:8px;">
        ${productImg}
        <span style="color:var(--text-1);font-size:13px;">${escHtml(productName || 'Unknown Product')}</span>
        ${productQty > 1
          ? `<span style="font-family:var(--mono);color:var(--text-2);margin-left:auto;">×${productQty.toLocaleString()}</span>`
          : ''}
      </div>
    </div>

    <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;margin-bottom:6px;">
      MATERIALS — 1 RUN · ME${bp.me}
      <span style="font-size:9px;margin-left:8px;">(quantities rounded up per EVE rules)</span>
    </div>

    <!-- Column headers -->
    <div style="display:flex;align-items:center;gap:10px;padding:3px 10px;
                font-family:var(--mono);font-size:9px;color:var(--text-3);letter-spacing:0.08em;
                margin-bottom:2px;">
      <span style="width:28px;flex-shrink:0;"></span>
      <span style="flex:1;">MATERIAL</span>
      <span style="min-width:70px;text-align:right;">QTY</span>
      <span style="min-width:100px;text-align:right;">JITA SELL/UNIT</span>
      <span style="min-width:110px;text-align:right;">TOTAL COST</span>
    </div>

    <div id="bpMatTable" style="display:flex;flex-direction:column;gap:3px;">
      ${materials.map(mat => renderMaterialRow(mat, prices)).join('')}
    </div>

    ${totalCost > 0 ? `
    <div style="margin-top:14px;padding:12px 16px;background:var(--bg-card);
                border:1px solid var(--border);border-radius:6px;
                display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;">
      <div>
        <div style="font-family:var(--mono);font-size:9px;color:var(--text-3);
                    letter-spacing:0.12em;margin-bottom:4px;">
          ESTIMATED BUILD COST · 1 RUN · ME${bp.me} · JITA SELL
        </div>
        <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:var(--accent);">
          ${formatNumber(totalCost)} ISK
        </div>
      </div>
      <div style="margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--text-3);">
        Based on Jita 4-4 sell orders
      </div>
    </div>` : ''}

    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);
                display:flex;gap:8px;flex-wrap:wrap;">
      <button id="bpCalcBtn" class="bp-view-btn" type="button"
              style="padding:6px 16px;font-size:11px;">
        ◈ OPEN FULL CALCULATOR
      </button>
      <button id="bpTreeBtn" class="bp-view-btn" type="button"
              style="padding:6px 16px;font-size:11px;background:var(--bg-hover);">
        ⬡ SHOW COMPONENT TREE
      </button>
      <button id="bpAddToListBtn" class="bp-view-btn" type="button"
              style="padding:6px 16px;font-size:11px;background:var(--bg-hover);margin-left:auto;">
        ➕ ADD TO SHOPPING LIST
      </button>
    </div>
    <div id="bpComponentTree" style="display:none;margin-top:16px;"></div>`;

  // Full calculator button
  document.getElementById('bpCalcBtn')?.addEventListener('click', () => {
    if (typeof selectedBpTypeId !== 'undefined') selectedBpTypeId = bp.type_id;
    if (typeof selectedME      !== 'undefined') selectedME       = bp.me;
    if (typeof selectedTE      !== 'undefined') selectedTE       = bp.te;
    navigateIndustryTab('calculator');
  });

  // Add to Shopping List
  document.getElementById('bpAddToListBtn')?.addEventListener('click', () => {
    const slMats = materials.map(m => ({ typeId: m.typeId, name: m.name, qty: m.adjustedQty }));
    if (typeof showAddToShoppingListModal === 'function') {
      showAddToShoppingListModal(slMats, bp.name || `Type ${bp.type_id}`);
    }
  });

  // Component tree toggle — passes SDE materials so root level never needs Fuzzwork
  document.getElementById('bpTreeBtn')?.addEventListener('click', async () => {
    const treeDiv = document.getElementById('bpComponentTree');
    if (!treeDiv) return;
    if (treeDiv.style.display !== 'none') {
      treeDiv.style.display = 'none';
      document.getElementById('bpTreeBtn').textContent = '⬡ SHOW COMPONENT TREE';
      return;
    }
    treeDiv.style.display = 'block';
    document.getElementById('bpTreeBtn').textContent = '⬡ HIDE COMPONENT TREE';
    await renderComponentTreePanel(treeDiv, bp, sdeResult.materials);
  });
}

// ─── Component Tree Panel ─────────────────────────────────────────────────────
// Renders the full manufacturing breakdown with tier depth + reaction controls.
// tierDepth: how many blueprint layers to recurse into before treating a node as
//   a "buy this" leaf.  0 = only T0 raw (minerals/moon goo), 4 = stop at capital
//   components, 99 = fully flatten everything.
// includeReactions: if false, reaction products are treated as leaves (buy off market).

// Build a tree starting from already-known SDE materials (avoids Fuzzwork for root).
// For each material, tries findBpForProduct to check for sub-blueprints, then recurses.
async function buildTreeFromSdeMaterials(sdeMaterials, maxDepth, includeReactions) {
  const REACTION_ACTIVITY = 11;
  const nodes = [];
  for (const mat of sdeMaterials) {
    let subTree    = null;
    let isReaction = false;
    if (maxDepth > 0) {
      try {
        const found = await window.eveAPI.findBpForProduct(mat.typeId);
        const entry = found?.[mat.typeId];
        if (entry?.blueprintDetails) {
          const actId = entry.blueprintDetails.activityID ?? 1;
          isReaction  = actId === REACTION_ACTIVITY;
          if (!isReaction || includeReactions) {
            const subBpId = entry.blueprintDetails.blueprintTypeID;
            subTree = await buildRecursiveMaterialTree(subBpId, mat.adjustedQty, 0, maxDepth - 1, includeReactions);
          }
        }
      } catch (_) {}
    }
    nodes.push({ typeid: mat.typeId, name: mat.name, quantity: mat.adjustedQty, subTree, isReaction, depth: 0 });
  }
  return nodes;
}

async function renderComponentTreePanel(container, bp, rootMaterials = null) {
  container.innerHTML = `
    <div id="ctrlBar" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;
         padding:10px 12px;background:var(--bg-card);border:1px solid var(--border);
         border-radius:4px;margin-bottom:12px;">
      <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                   letter-spacing:0.08em;flex-shrink:0;">BREAK DOWN TO:</span>

      <div style="display:flex;gap:4px;flex-wrap:wrap;" id="tierBtns">
        <button class="tier-btn active" data-depth="1"
                style="padding:3px 10px;border-radius:3px;border:1px solid var(--accent);
                       background:var(--accent);color:#000;font-family:var(--mono);
                       font-size:10px;cursor:pointer;font-weight:700;">
          T1 Components
        </button>
        <button class="tier-btn" data-depth="2"
                style="padding:3px 10px;border-radius:3px;border:1px solid var(--border);
                       background:transparent;color:var(--text-2);font-family:var(--mono);
                       font-size:10px;cursor:pointer;">
          T2 Sub-Components
        </button>
        <button class="tier-btn" data-depth="99"
                style="padding:3px 10px;border-radius:3px;border:1px solid var(--border);
                       background:transparent;color:var(--text-2);font-family:var(--mono);
                       font-size:10px;cursor:pointer;">
          Raw (minerals / moon goo)
        </button>
      </div>

      <label style="display:flex;align-items:center;gap:6px;font-family:var(--mono);
                    font-size:10px;color:var(--text-2);margin-left:auto;cursor:pointer;">
        <input type="checkbox" id="includeReactions" checked
               style="accent-color:var(--accent);width:13px;height:13px;">
        Include reaction items
      </label>
    </div>

    <div id="treeOutput" style="font-family:var(--mono);font-size:11px;color:var(--text-3);
         padding:12px;">Building component tree…</div>`;

  // Wire tier buttons
  let currentDepth    = 1;
  let includeReactions = true;

  const rebuild = async () => {
    const out = document.getElementById('treeOutput');
    if (!out) return;
    out.innerHTML = `<div style="padding:12px;color:var(--text-3);">Building component tree…</div>`;
    try {
      // Use SDE materials as root if available (avoids Fuzzwork for capital/special BPs).
      // Fall back to Fuzzwork for blueprints where we don't have root materials cached.
      const tree = rootMaterials?.length
        ? await buildTreeFromSdeMaterials(rootMaterials, currentDepth, includeReactions)
        : await buildRecursiveMaterialTree(bp.type_id, 1, 0, currentDepth, includeReactions);

      if (!tree || tree.length === 0) {
        out.innerHTML = `<div style="padding:12px;color:var(--text-3);">
          No sub-components found — all materials are raw inputs.</div>`;
        return;
      }

      const flat = flattenTreeToLeaves(tree);

      // Fetch Jita prices for the flat leaf list
      let leafPrices = {};
      try {
        const leafIds = [...flat.keys()];
        if (leafIds.length) leafPrices = await window.eveAPI.getJitaPrices(leafIds) || {};
      } catch (_) {}

      out.innerHTML = renderFlatMaterialList(flat, currentDepth, leafPrices);
    } catch (e) {
      out.innerHTML = `<div style="padding:12px;color:var(--danger);">
        ⚠ Component tree error: ${escHtml(e.message)}</div>`;
      console.error('[ComponentTree]', e);
    }
  };

  container.querySelectorAll('.tier-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentDepth = parseInt(btn.dataset.depth);
      container.querySelectorAll('.tier-btn').forEach(b => {
        const active = b === btn;
        b.style.background  = active ? 'var(--accent)' : 'transparent';
        b.style.color       = active ? '#000'          : 'var(--text-2)';
        b.style.border      = active ? '1px solid var(--accent)' : '1px solid var(--border)';
        b.style.fontWeight  = active ? '700' : '400';
      });
      rebuild();
    });
  });

  container.querySelector('#includeReactions')?.addEventListener('change', e => {
    includeReactions = e.target.checked;
    rebuild();
  });

  await rebuild();
}

// Renders a single material row with EVE icon, name, quantity, and optional Jita price
function renderMaterialRow(mat, prices = {}) {
  const isComponent = mat.isComponent;
  const p           = prices[mat.typeId];
  const unitPrice   = p?.sell > 0 ? p.sell : (p?.buy || 0);
  const totalCost   = unitPrice * mat.adjustedQty;
  const saved       = mat.baseQty - mat.adjustedQty;

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;
                border-radius:4px;
                background:${isComponent ? 'var(--bg-card)' : 'transparent'};
                border:1px solid ${isComponent ? 'var(--border)' : 'transparent'};">
      <img src="${ESI_IMAGE}/${mat.typeId}/icon?size=32"
           onerror="this.src='${ESI_IMAGE}/0/icon?size=32';"
           style="width:28px;height:28px;border-radius:3px;flex-shrink:0;">
      <span style="flex:1;color:${isComponent ? 'var(--tier-top)' : 'var(--text-1)'};
                   font-family:var(--font);font-size:13px;font-weight:${isComponent ? '600' : '400'};">
        ${isComponent ? '◈ ' : ''}${escHtml(mat.name || `Type ${mat.typeId}`)}
      </span>
      <span style="font-family:var(--mono);color:var(--text-1);font-size:12px;
                   font-weight:600;min-width:70px;text-align:right;flex-shrink:0;">
        ×${mat.adjustedQty.toLocaleString()}
        ${saved > 0
          ? `<span style="font-size:9px;color:var(--success);margin-left:3px;" title="ME saves ${saved.toLocaleString()}">−${saved.toLocaleString()}</span>`
          : ''}
      </span>
      <span style="font-family:var(--mono);color:var(--text-3);font-size:11px;
                   min-width:100px;text-align:right;flex-shrink:0;">
        ${unitPrice > 0 ? formatNumber(unitPrice) + ' ISK' : '—'}
      </span>
      <span style="font-family:var(--mono);font-size:11px;font-weight:${totalCost > 0 ? '600' : '400'};
                   color:${totalCost > 0 ? 'var(--text-1)' : 'var(--text-3)'};
                   min-width:110px;text-align:right;flex-shrink:0;">
        ${totalCost > 0 ? formatNumber(totalCost) : '—'}
      </span>
    </div>`;
}

// ─── Fuzzwork fallback ────────────────────────────────────────────────────────
// Used when SDE is unavailable. Applies ME bonus to Fuzzwork base quantities.

async function fetchFuzzworkMaterials(typeId, me) {
  const data = await window.eveAPI.getBlueprintMaterials(typeId);
  if (!data || !data.materials?.length) return null;

  const materials = data.materials.map(mat => {
    const baseQty    = mat.quantity;
    const adjustedQty = applyMEBonus(baseQty, me);
    return {
      typeId:      mat.typeid,
      name:        mat.name || `Type ${mat.typeid}`,
      baseQty,
      adjustedQty,
      isComponent: false,
    };
  });

  return {
    materials,
    productTypeId: null,
    productName:   null,
    productQty:    1,
  };
}

// ─── ME bonus formula (EVE industry standard) ────────────────────────────────
// Adjusted qty = max(1, ceil( baseQty × (1 − ME/100) ))
// ME 0 = 0% saving; ME 10 = 10% saving (max).

function applyMEBonus(baseQty, me) {
  if (baseQty <= 1) return 1;
  const factor = 1 - (me / 100);
  return Math.max(1, Math.ceil(baseQty * factor));
}

// ─── Recursive component tree ─────────────────────────────────────────────────
// blueprintTypeId : the blueprint (or reaction formula) type ID to expand

async function getCachedBlueprintMaterials(typeId) {
  const key    = `bp_materials_${typeId}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  const data = await window.eveAPI.getBlueprintMaterials(typeId);
  await cacheSet(key, data, 7);
  return data;
}

// quantityRequired: how many of the product we need
// depth           : current recursion depth (starts at 0)
// maxDepth        : stop recursing at this depth; treat node as a leaf (buy it)
// includeReactions: if false, reaction products are treated as leaves

// Known reaction activity IDs in the SDE / Fuzzwork schema.
// Fuzzwork's findBpForProduct returns a `activityID` field on blueprintDetails.
// Manufacturing = 1, Reactions = 11.
const REACTION_ACTIVITY_ID = 11;

async function buildRecursiveMaterialTree(
  blueprintTypeId,
  quantityRequired = 1,
  depth            = 0,
  maxDepth         = 1,
  includeReactions = true
) {
  const data = await getCachedBlueprintMaterials(blueprintTypeId);
  if (!data)                   throw new Error(`No data for blueprint ${blueprintTypeId}`);
  if (!data.materials?.length) return [];

  const components = [];
  for (const mat of data.materials) {
    const totalQty = mat.quantity * quantityRequired;
    let subTree      = null;
    let isReaction   = false;

    // Only try to recurse if we haven't hit the depth ceiling
    if (depth < maxDepth) {
      try {
        const subBpData = await window.eveAPI.findBpForProduct(mat.typeid);
        const entry     = subBpData?.[mat.typeid];
        if (entry?.blueprintDetails) {
          const activityId = entry.blueprintDetails.activityID ?? 1;
          isReaction = (activityId === REACTION_ACTIVITY_ID);

          // Recurse if: it's a manufacturing BP, or reactions are included
          if (!isReaction || includeReactions) {
            const nextBpId = entry.blueprintDetails.blueprintTypeID;
            subTree = await buildRecursiveMaterialTree(
              nextBpId, totalQty, depth + 1, maxDepth, includeReactions
            );
          }
        }
      } catch (e) { /* raw material — no sub-blueprint */ }
    }

    components.push({
      typeid:     mat.typeid,
      name:       mat.name || `Type ${mat.typeid}`,
      quantity:   totalQty,
      subTree,          // null = leaf (buy this); array = has sub-materials
      isReaction,       // true = produced via reaction formula
      depth,
    });
  }
  return components;
}

// Flatten the tree into a deduplicated leaf-level shopping list.
// Nodes with no subTree (or whose subTree is empty) are leaves = things to buy.
function flattenTreeToLeaves(nodes, accumulated = new Map()) {
  if (!nodes?.length) return accumulated;
  for (const node of nodes) {
    const hasChildren = node.subTree && node.subTree.length > 0;
    if (!hasChildren) {
      // Leaf — aggregate quantity
      const existing = accumulated.get(node.typeid);
      if (existing) {
        existing.quantity += node.quantity;
      } else {
        accumulated.set(node.typeid, {
          typeid:     node.typeid,
          name:       node.name,
          quantity:   node.quantity,
          isReaction: node.isReaction,
        });
      }
    } else {
      // Intermediate node — recurse into children
      flattenTreeToLeaves(node.subTree, accumulated);
    }
  }
  return accumulated;
}

// Render the flat (aggregated) shopping list as a clean table with Jita prices
function renderFlatMaterialList(flatMap, depth, prices = {}) {
  if (!flatMap.size) return '<div style="padding:12px;color:var(--text-3);">No materials found.</div>';

  const rows = [...flatMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  const depthLabel = depth === 99 ? 'Raw inputs (minerals / moon goo / PI)'
                   : depth === 1  ? 'T1 component breakdown'
                   : depth === 2  ? 'T2 sub-component breakdown'
                   : `Tier ${depth} breakdown`;

  let grandTotal = 0;
  const renderedRows = rows.map(row => {
    const p         = prices[row.typeid];
    const unitPrice = p?.sell > 0 ? p.sell : (p?.buy || 0);
    const rowTotal  = unitPrice * row.quantity;
    if (rowTotal > 0) grandTotal += rowTotal;

    const sourceLabel = row.isReaction
      ? `<span style="color:#ab7ab8;font-size:10px;">⚗ REACT</span>`
      : `<span style="color:var(--text-3);font-size:10px;">◈ MANUF</span>`;

    return `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
        <td style="padding:7px 8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="https://images.evetech.net/types/${row.typeid}/icon?size=32"
                 onerror="this.onerror=null;this.style.display='none';"
                 style="width:22px;height:22px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">
            <span style="color:var(--text-1);">${escHtml(row.name)}</span>
          </div>
        </td>
        <td style="padding:7px 8px;text-align:right;color:var(--text-1);
                   font-family:var(--mono);font-weight:600;white-space:nowrap;">
          ${row.quantity.toLocaleString()}
        </td>
        <td style="padding:7px 8px;text-align:right;font-family:var(--mono);
                   font-size:11px;color:var(--text-3);white-space:nowrap;">
          ${unitPrice > 0 ? formatNumber(unitPrice) + ' ISK' : '—'}
        </td>
        <td style="padding:7px 8px;text-align:right;font-family:var(--mono);
                   font-size:11px;font-weight:600;color:${rowTotal > 0 ? 'var(--text-1)' : 'var(--text-3)'};
                   white-space:nowrap;">
          ${rowTotal > 0 ? formatNumber(rowTotal) : '—'}
        </td>
        <td style="padding:7px 8px;text-align:center;">${sourceLabel}</td>
      </tr>`;
  }).join('');

  return `
    <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                letter-spacing:0.1em;margin-bottom:6px;padding:0 2px;">
      ${escHtml(depthLabel)} — ${rows.length} item${rows.length !== 1 ? 's' : ''} to source
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="border-bottom:1px solid var(--border);">
          <th style="text-align:left;padding:6px 8px;font-family:var(--mono);font-size:9px;
                     color:var(--text-3);font-weight:500;letter-spacing:0.08em;">ITEM</th>
          <th style="text-align:right;padding:6px 8px;font-family:var(--mono);font-size:9px;
                     color:var(--text-3);font-weight:500;letter-spacing:0.08em;">QTY</th>
          <th style="text-align:right;padding:6px 8px;font-family:var(--mono);font-size:9px;
                     color:var(--text-3);font-weight:500;letter-spacing:0.08em;">JITA SELL/UNIT</th>
          <th style="text-align:right;padding:6px 8px;font-family:var(--mono);font-size:9px;
                     color:var(--accent);font-weight:500;letter-spacing:0.08em;">TOTAL COST</th>
          <th style="text-align:center;padding:6px 8px;font-family:var(--mono);font-size:9px;
                     color:var(--text-3);font-weight:500;letter-spacing:0.08em;">SOURCE</th>
        </tr>
      </thead>
      <tbody>${renderedRows}</tbody>
    </table>
    ${grandTotal > 0 ? `
    <div style="margin-top:12px;padding:10px 14px;background:var(--bg-card);
                border:1px solid var(--border);border-radius:6px;
                display:flex;align-items:baseline;gap:12px;">
      <span style="font-family:var(--mono);font-size:9px;color:var(--text-3);letter-spacing:0.12em;">
        TOTAL MATERIAL COST (JITA SELL)
      </span>
      <span style="font-family:var(--mono);font-size:18px;font-weight:700;color:var(--accent);margin-left:auto;">
        ${formatNumber(grandTotal)} ISK
      </span>
    </div>` : ''}`;
}

// Legacy tree HTML renderer (kept for renderTreeResults compatibility)
function generateTreeHTML(treeNodes) {
  if (!treeNodes?.length) return '';
  return `
    <ul style="list-style:none;padding-left:20px;border-left:1px dashed var(--border);margin-top:8px;">
      ${treeNodes.map(node => {
        const isComponent = node.subTree && node.subTree.length > 0;
        return `
          <li style="margin:8px 0;">
            <div style="display:flex;justify-content:space-between;align-items:center;
                        padding:6px 10px;
                        background:${isComponent ? 'var(--bg-card)' : 'transparent'};
                        border:1px solid ${isComponent ? 'var(--border)' : 'transparent'};
                        border-radius:var(--radius);">
              <span style="color:${isComponent ? 'var(--tier-top)' : 'var(--text-1)'};
                           font-family:var(--font);font-weight:${isComponent ? '600' : '400'};">
                ${isComponent ? '◈' : '⬡'} ${escHtml(node.name)}
              </span>
              <span style="font-family:var(--mono);color:var(--text-2);">×${node.quantity.toLocaleString()}</span>
            </div>
            ${isComponent ? generateTreeHTML(node.subTree) : ''}
          </li>`;
      }).join('')}
    </ul>`;
}

function renderTreeResults(blueprintName, meLevel, materialTree) {
  const resArea = document.getElementById('results');
  resArea.innerHTML = `
    <div class="panel" style="padding:20px;overflow-y:auto;height:100%;">
      <button onclick="backToLibrary()" style="margin-bottom:20px;padding:6px 12px;
        background:var(--bg-hover);border:1px solid var(--border);color:var(--text-1);
        cursor:pointer;border-radius:var(--radius);font-family:var(--mono);font-size:11px;">
        ← BACK TO LIBRARY
      </button>
      <h2 style="font-size:26px;margin-bottom:8px;color:var(--text-1);">${escHtml(blueprintName)}</h2>
      <div style="display:flex;gap:10px;margin-bottom:24px;">
        <span style="background:var(--bg-card);padding:4px 8px;border-radius:3px;
                     font-family:var(--mono);font-size:11px;border:1px solid var(--border);">
          ME: <span style="color:var(--success);">${meLevel}</span>
        </span>
        <span style="background:var(--bg-card);padding:4px 8px;border-radius:3px;
                     font-family:var(--mono);font-size:11px;border:1px solid var(--border);">
          BATCH: <span style="color:var(--accent);">1 RUN</span>
        </span>
      </div>
      <div style="background:var(--bg-panel);padding:20px;border:1px solid var(--border);border-radius:6px;">
        <h3 style="font-size:12px;letter-spacing:0.1em;color:var(--text-3);
                   margin-bottom:15px;font-family:var(--mono);">FULL MANUFACTURING CHAIN</h3>
        ${generateTreeHTML(materialTree)}
      </div>
    </div>`;
}

function backToLibrary() {
  document.getElementById('mainLibraryView').style.display = 'flex';
  document.getElementById('results').style.display         = 'none';
}

// ─── Industry page tab routing ────────────────────────────────────────────────

function initIndustryPage() {
  document.querySelectorAll('.industry-sub-btn').forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      const tab = newBtn.dataset.industryTab;
      if (tab) navigateIndustryTab(tab);
    });
  });

  // Auto-open blueprints if the panel has no rendered content yet.
  // Uses querySelector(:scope > *) so HTML comments don't count as content.
  const content = document.getElementById('industryTabContent');
  if (content && !content.querySelector(':scope > *')) {
    navigateIndustryTab('blueprints');
  }
}

function navigateIndustryTab(tab) {
  currentIndustryTab = tab;
  document.querySelectorAll('.industry-sub-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.industryTab === tab);
  });

  const right = document.getElementById('industryTabContent');
  if (!right) return;

  if (tab === 'blueprints') {
    right.innerHTML = `
      <div id="bpLibWrapper" style="display:flex;flex-direction:column;height:100%;">
        <div class="bp-filter-row" style="padding:12px 16px;border-bottom:1px solid var(--border);
             display:flex;flex-wrap:wrap;gap:10px;background:var(--bg-card);align-items:center;">
          <input id="bpLibSearch"  class="field-input" style="flex:1;min-width:180px;" placeholder="Search your blueprint library..."/>
          <select id="bpLibFilter" class="field-input" style="width:140px;">
            <option value="all">All Blueprints</option>
            <option value="bpo">BPO Only</option>
            <option value="bpc">BPC Only</option>
          </select>
          <select id="bpLibSort" class="field-input" style="width:130px;">
            <option value="name">Name</option>
            <option value="me">ME High-Low</option>
            <option value="te">TE High-Low</option>
            <option value="runs">Runs</option>
          </select>
          <input id="bpLibMinME"   class="field-input" type="number" placeholder="Min ME"   style="width:75px;" min="0" max="10"/>
          <input id="bpLibMinTE"   class="field-input" type="number" placeholder="Min TE"   style="width:75px;" min="0" max="20"/>
          <input id="bpLibMinRuns" class="field-input" type="number" placeholder="Min Runs" style="width:85px;" min="0"/>
          <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);margin-left:auto;">
            <span id="bpLibCount">0</span> blueprints
          </span>
        </div>
        <div id="bpLibList" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));
             gap:12px;padding:16px;overflow-y:auto;flex:1;"></div>
      </div>
      <div id="results" style="display:none;height:100%;overflow-y:auto;"></div>`;
    bindLibraryEvents();
    // Always render shimmer skeleton first so the user sees something immediately.
    // If data is already loaded, defer the real render to the next event-loop tick
    // so the browser has a chance to paint the skeleton before the heavy DOM work.
    _renderBpLibLoadingState();
    if (!_bpLibLoading) {
      setTimeout(() => renderBlueprintList(allLibBPs), 0);
    }
    // If _bpLibLoading is true, loadBlueprintLibrary() will call renderBlueprintList
    // when it finishes — no extra action needed here.

  } else if (tab === 'search') {
    right.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;">
        <div style="padding:14px 20px 12px;border-bottom:1px solid var(--border);
                    background:var(--bg-card);flex-shrink:0;position:relative;z-index:10;">
          <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                      letter-spacing:0.1em;margin-bottom:8px;">BLUEPRINT SEARCH — ALL EVE BLUEPRINTS</div>
          <div style="position:relative;">
            <input id="bpName" class="field-input"
                   placeholder="Search for any blueprint or item name…"
                   style="width:100%;box-sizing:border-box;padding-right:120px;"/>
            <div style="position:absolute;right:10px;top:50%;transform:translateY(-50%);
                        font-family:var(--mono);font-size:10px;color:var(--text-3);pointer-events:none;">
              ESI TYPE SEARCH
            </div>
            <div id="searchDropdown" class="dropdown" style="display:none;"></div>
          </div>
        </div>
        <div id="results" style="flex:1;overflow-y:auto;min-height:0;"></div>
      </div>`;
    const inp = document.getElementById('bpName');
    if (inp) {
      inp.addEventListener('input', () => {
        clearTimeout(manualSearchTimer);
        manualSearchTimer = setTimeout(handleManualSearchInput, 250);
      });
      inp.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = document.querySelector('#searchDropdown .dropdown-item');
          if (first) first.click();
        }
      });
    }
  } else if (tab === 'cost-index') {
    renderCostIndex(right);

  } else if (tab === 'ore') {
    renderOreCalculator(right);

  } else if (tab === 'ice') {
    renderIceCalculator(right);

  } else if (tab === 'gas') {
    renderGasCalculator(right);

  } else if (tab === 'salvage') {
    if (typeof renderSalvageCalculator === 'function') renderSalvageCalculator(right);

  } else if (tab === 'active-jobs') {
    renderActiveJobsPage(right);

  } else if (tab === 'shopping-lists') {
    if (typeof renderShoppingLists === 'function') renderShoppingLists(right);

  } else if (tab === 'moon') {
    renderMoonReformatter(right);

  } else if (tab === 'planet-size') {
    renderPlanetSizeMapper(right);

  } else {
    const labels = {
      'calculator':     'Blueprint Calculator',
      'shopping-lists': 'Shopping Lists',
      'reactions':      'Reactions Profit',
    };
    right.innerHTML = `
      <div class="empty-state" style="margin-top:80px;">
        <div class="empty-icon">◈</div>
        <div class="empty-title">${escHtml(labels[tab] || tab).toUpperCase()}</div>
        <div class="empty-sub">Coming soon.</div>
      </div>`;
  }
}

// ─── Moon Scan Reformatter ────────────────────────────────────────────────────
// Takes EVE's raw moon-scan paste (the "Moon Distribution" copy) and reformats
// it into readable per-moon ore lists with percentages — same idea as
// Fuzzwork's ore/reformat tool. Pure client-side text transform; no ESI/SDE.
//
// EVE paste format (tab-separated):
//   Goinard III - Moon 1<tab><tab><tab>
//   <tab>Pyroxeres<tab>0.19<tab>1224<tab>30002053<tab>40137334<tab>40137335
//   <tab>Cobaltite<tab>0.30<tab>45495<tab>...
//   Goinard III - Moon 2<tab>...
// Ore lines start with a tab (empty first column); a non-empty first column is
// a moon header.
function parseMoonScan(text) {
  const moons = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols  = line.split('\t');
    const first = (cols[0] || '').trim();
    const frac  = parseFloat(cols[2]);
    if (!first && cols[1] && cols[1].trim() && !isNaN(frac)) {
      // ore line — only kept if it belongs to a moon header we've seen
      if (cur) cur.ores.push({ name: cols[1].trim(), pct: frac * 100, typeId: (cols[3] || '').trim() });
    } else if (first) {
      cur = { name: first, ores: [] };
      moons.push(cur);
    }
  }
  return moons.filter(m => m.ores.length);
}

function formatMoons(moons, fmt) {
  if (!moons.length) return '';
  const pct  = (p) => p.toFixed(1) + '%';
  // Highest-percentage ore first within each moon.
  const sorted = moons.map(m => ({ name: m.name, ores: m.ores.slice().sort((a, b) => b.pct - a.pct) }));

  if (fmt === 'oneline') {
    return sorted.map(m => `${m.name}: ${m.ores.map(o => `${o.name} ${pct(o.pct)}`).join(', ')}`).join('\n');
  }
  if (fmt === 'tsv') {
    const rows = ['Moon\tOre\tPercent'];
    sorted.forEach(m => m.ores.forEach(o => rows.push(`${m.name}\t${o.name}\t${o.pct.toFixed(1)}`)));
    return rows.join('\n');
  }
  // multiline (default): aligned ore name + right-aligned percentage
  return sorted.map(m => {
    const w = Math.max(0, ...m.ores.map(o => o.name.length));
    const lines = m.ores.map(o => `  ${o.name.padEnd(w)}  ${pct(o.pct).padStart(6)}`);
    return `${m.name}\n${lines.join('\n')}`;
  }).join('\n\n');
}

function renderMoonReformatter(container) {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                  padding:12px 18px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);letter-spacing:0.1em;">MOON SCAN REFORMATTER</span>
        <span id="moonStat" style="font-family:var(--mono);font-size:11px;color:var(--text-2);"></span>
        <div style="display:flex;gap:6px;margin-left:auto;align-items:center;">
          <label style="font-size:11px;color:var(--text-3);">Format</label>
          <select id="moonFormat" class="field-input" style="width:170px;padding:4px 8px;font-size:11px;cursor:pointer;">
            <option value="multiline">Multiline</option>
            <option value="oneline">One line per moon</option>
            <option value="tsv">Tab-separated (spreadsheet)</option>
          </select>
          <button id="moonCopyBtn"  class="icon-btn" style="padding:4px 12px;font-size:11px;">⧉ COPY</button>
          <button id="moonClearBtn" class="icon-btn" style="padding:4px 12px;font-size:11px;">✕ CLEAR</button>
        </div>
      </div>
      <div style="flex:1;display:flex;min-height:0;">
        <div style="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--border);">
          <div style="font-size:10px;color:var(--text-3);font-family:var(--mono);letter-spacing:0.1em;padding:8px 14px;">PASTE MOON SCAN</div>
          <textarea id="moonInput" spellcheck="false" placeholder="Paste your moon scan from EVE here (Moon Distribution → copy)…"
            style="flex:1;resize:none;border:none;background:var(--bg-input);color:var(--text-1);font-family:var(--mono);font-size:12px;line-height:1.5;padding:12px 14px;outline:none;min-height:0;"></textarea>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
          <div style="font-size:10px;color:var(--text-3);font-family:var(--mono);letter-spacing:0.1em;padding:8px 14px;">REFORMATTED OUTPUT</div>
          <textarea id="moonOutput" readonly spellcheck="false" placeholder="Reformatted scan appears here…"
            style="flex:1;resize:none;border:none;background:var(--bg-deep);color:var(--text-1);font-family:var(--mono);font-size:12px;line-height:1.5;padding:12px 14px;outline:none;min-height:0;"></textarea>
        </div>
      </div>
    </div>`;

  const input  = container.querySelector('#moonInput');
  const output = container.querySelector('#moonOutput');
  const fmtSel = container.querySelector('#moonFormat');
  const stat   = container.querySelector('#moonStat');

  function refresh() {
    const moons = parseMoonScan(input.value);
    output.value = formatMoons(moons, fmtSel.value);
    const ores  = moons.reduce((n, m) => n + m.ores.length, 0);
    stat.textContent = moons.length
      ? `${moons.length} moon${moons.length !== 1 ? 's' : ''} · ${ores} ore entries`
      : (input.value.trim() ? 'No moon scan data found in paste' : '');
  }

  input.addEventListener('input', refresh);
  fmtSel.addEventListener('change', refresh);
  container.querySelector('#moonCopyBtn').addEventListener('click', () => {
    if (!output.value) return;
    navigator.clipboard.writeText(output.value)
      .then(() => { if (typeof showToast === 'function') showToast('Copied reformatted scan.', 'success'); })
      .catch(() => {});
  });
  container.querySelector('#moonClearBtn').addEventListener('click', () => {
    input.value = ''; refresh(); input.focus();
  });
  refresh();
}

// ─── Planet Size Mapper ───────────────────────────────────────────────────────
// Lists every planet in a region with its diameter (km), grouped by
// constellation, biggest first. Bigger planets give more room to spread PI
// extractor heads — shorter runs, more nodes. All from the local SDE, no ESI.
const PLANET_TYPE_COLORS = {
  Barren: '#b8956a', Temperate: '#4ec9b0', Gas: '#9b8cc4', Ice: '#7fb4d4',
  Lava: '#e0712d', Oceanic: '#3a8fd0', Plasma: '#d04ec0', Storm: '#c4a23a',
};

async function renderPlanetSizeMapper(container) {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                  padding:12px 18px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);letter-spacing:0.1em;">PLANET SIZE MAPPER</span>
        <span id="psStat" style="font-family:var(--mono);font-size:11px;color:var(--text-2);"></span>
        <div style="display:flex;gap:8px;margin-left:auto;align-items:center;">
          <select id="psRegion" class="field-input" style="width:210px;padding:5px 8px;font-size:12px;cursor:pointer;">
            <option value="">Select region…</option>
          </select>
          <select id="psType" class="field-input" style="width:140px;padding:5px 8px;font-size:12px;cursor:pointer;">
            <option value="">All types</option>
            ${Object.keys(PLANET_TYPE_COLORS).map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="psBody" style="flex:1;overflow-y:auto;min-height:0;">
        <div class="empty-state" style="margin-top:60px;">
          <div class="empty-icon">🪐</div>
          <div class="empty-title">Pick a region</div>
          <div class="empty-sub">Planet diameters help you spot the best PI worlds — bigger = more room to spread extractor heads.</div>
        </div>
      </div>
    </div>`;

  const regionSel = container.querySelector('#psRegion');
  const typeSel   = container.querySelector('#psType');
  const body      = container.querySelector('#psBody');
  const stat      = container.querySelector('#psStat');
  let _planets = [];

  try {
    const regions = await window.eveAPI.sdeGetPlanetRegions();
    (regions || []).forEach(r => {
      const o = document.createElement('option'); o.value = r.id; o.textContent = r.name; regionSel.appendChild(o);
    });
  } catch (_) {}

  async function loadRegion() {
    if (!regionSel.value) {
      body.innerHTML = `<div class="empty-state" style="margin-top:60px;"><div class="empty-icon">🪐</div><div class="empty-title">Pick a region</div></div>`;
      stat.textContent = ''; return;
    }
    body.innerHTML = `<div class="loading-row" style="padding:40px;text-align:center;">Loading planets…</div>`;
    try { _planets = await window.eveAPI.sdeGetRegionPlanets(Number(regionSel.value)) || []; }
    catch (_) { _planets = []; }
    render();
  }

  function render() {
    const type    = typeSel.value;
    const planets = type ? _planets.filter(p => p.type === type) : _planets;
    if (!planets.length) {
      body.innerHTML = `<div class="loading-row" style="padding:40px;text-align:center;">No planets match.</div>`;
      stat.textContent = '0 planets'; return;
    }
    // Group by constellation; constellations ordered by their biggest planet,
    // planets within each ordered by diameter (largest first).
    const groups = new Map();
    planets.forEach(p => { (groups.get(p.con) || groups.set(p.con, []).get(p.con)).push(p); });
    const sections = [...groups.entries()].map(([con, ps]) => {
      ps.sort((a, b) => b.diameterKm - a.diameterKm);
      return { con, ps, max: ps[0].diameterKm };
    }).sort((a, b) => b.max - a.max);

    body.innerHTML = sections.map(sec => `
      <div class="ps-con">
        <div class="ps-con-head">
          <span class="ps-chev">▼</span>
          <span class="ps-con-name">${escHtml(sec.con)}</span>
          <span class="ps-con-meta">${sec.ps.length} planet${sec.ps.length !== 1 ? 's' : ''} · biggest Ø ${sec.max.toLocaleString()} km</span>
        </div>
        <table class="ps-table"><tbody>
          ${sec.ps.map(p => `
            <tr>
              <td class="ps-pname">${escHtml(p.name)}</td>
              <td><span class="ps-type" style="color:${PLANET_TYPE_COLORS[p.type] || 'var(--text-2)'};">${escHtml(p.type)}</span></td>
              <td class="ps-dim">${escHtml(p.sys)}</td>
              <td class="ps-dim ps-right">${p.sec.toFixed(1)}</td>
              <td class="ps-diam ps-right">${p.diameterKm.toLocaleString()} km</td>
            </tr>`).join('')}
        </tbody></table>
      </div>`).join('');
    stat.textContent = `${planets.length} planets · ${sections.length} constellations`;

    body.querySelectorAll('.ps-con-head').forEach(h => h.addEventListener('click', () => {
      const tbl  = h.nextElementSibling;
      const chev = h.querySelector('.ps-chev');
      const hide = tbl.style.display !== 'none';
      tbl.style.display = hide ? 'none' : '';
      chev.textContent  = hide ? '▶' : '▼';
    }));
  }

  regionSel.addEventListener('change', loadRegion);
  typeSel.addEventListener('change', render);
}

// ─── Active Jobs Page ─────────────────────────────────────────────────────────

const _AJ_ACT = {
  1: { label: 'Manufacturing', color: '#4ecbb0' },
  3: { label: 'TE Research',   color: '#4a9fd4' },
  4: { label: 'ME Research',   color: '#ab7ab8' },
  5: { label: 'BP Copy',       color: '#9b59b6' },
  7: { label: 'Reverse Eng.',  color: '#c0392b' },
  8: { label: 'Invention',     color: '#f39c12' },
};

let _ajRefreshTimer = null;

function _ajFmtTime(ms) {
  if (ms <= 0) return 'Done';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function _ajFmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

async function renderActiveJobsPage(container) {
  if (_ajRefreshTimer) { clearInterval(_ajRefreshTimer); _ajRefreshTimer = null; }

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <!-- toolbar -->
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                  padding:12px 18px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;">ACTIVE INDUSTRY JOBS</span>
        <span id="ajJobCount" style="font-family:var(--mono);font-size:11px;
               color:var(--text-2);"></span>
        <div style="display:flex;gap:6px;margin-left:auto;">
          <select id="ajFilterActivity" class="field-input"
                  style="width:150px;padding:4px 8px;font-size:11px;">
            <option value="">All Activities</option>
            ${Object.entries(_AJ_ACT).map(([id, a]) =>
              `<option value="${id}">${a.label}</option>`).join('')}
          </select>
          <select id="ajFilterChar" class="field-input"
                  style="width:150px;padding:4px 8px;font-size:11px;">
            <option value="">All Characters</option>
          </select>
          <button id="ajRefreshBtn" class="icon-btn"
                  style="padding:4px 12px;font-size:11px;">⟳ REFRESH</button>
        </div>
      </div>
      <!-- table body -->
      <div style="flex:1;overflow-y:auto;min-height:0;">
        <table id="ajTable" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:var(--bg-card);border-bottom:2px solid var(--border);
                       position:sticky;top:0;z-index:1;">
              <th class="aj-th" data-col="char"
                  style="text-align:left;padding:10px 14px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;
                         cursor:pointer;white-space:nowrap;">CHARACTER ↕</th>
              <th style="text-align:left;padding:10px 8px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ITEM</th>
              <th style="text-align:left;padding:10px 8px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ACTIVITY</th>
              <th class="aj-th" data-col="progress"
                  style="text-align:left;padding:10px 14px;font-family:var(--mono);
                         font-size:10px;color:var(--accent);letter-spacing:0.1em;
                         cursor:pointer;white-space:nowrap;min-width:180px;">PROGRESS ↕</th>
              <th class="aj-th" data-col="end"
                  style="text-align:left;padding:10px 8px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;
                         cursor:pointer;white-space:nowrap;">ENDS ↕</th>
              <th class="aj-th" data-col="runs"
                  style="text-align:right;padding:10px 8px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;
                         cursor:pointer;">RUNS ↕</th>
              <th class="aj-th" data-col="cost"
                  style="text-align:right;padding:10px 14px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;
                         cursor:pointer;">COST ↕</th>
              <th style="text-align:left;padding:10px 8px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;">SYSTEM</th>
            </tr>
          </thead>
          <tbody id="ajTableBody">
            <tr><td colspan="8" style="text-align:center;padding:60px;
                font-family:var(--mono);font-size:12px;color:var(--text-3);">
              ⬡ Loading jobs…
            </td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  let _ajAllJobs   = [];
  let _ajSort      = { col: 'progress', dir: 1 };
  let _ajActFilter = '';
  let _ajCharFilter = '';

  async function loadJobs() {
    const btn = document.getElementById('ajRefreshBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⟳ LOADING…'; }

    try {
      const accounts = await window.eveAPI.getAccounts();
      if (!accounts?.length) {
        document.getElementById('ajTableBody').innerHTML = `
          <tr><td colspan="8" style="text-align:center;padding:60px;
              font-family:var(--mono);font-size:12px;color:var(--text-3);">
            No characters synced.
          </td></tr>`;
        return;
      }

      // Populate character filter
      const charSel = document.getElementById('ajFilterChar');
      if (charSel) {
        charSel.innerHTML = '<option value="">All Characters</option>'
          + accounts.map(a =>
              `<option value="${a.characterId}">${escHtml(a.characterName || a.characterId)}</option>`
            ).join('');
      }

      // Fetch jobs from all characters concurrently
      // character_id is NOT in the ESI response body — must be injected from the request context
      const allRaw = [];
      await Promise.allSettled(accounts.map(async acc => {
        try {
          const jobs = await window.eveAPI.getCharacterActiveJobs(acc.characterId);
          if (Array.isArray(jobs)) {
            jobs.forEach(j => allRaw.push({
              ...j,
              character_id: acc.characterId,
              _charName:    acc.characterName || `Char ${acc.characterId}`,
            }));
          }
        } catch (_) {}
      }));

      // Resolve type names for all blueprint + product IDs
      const typeIds = [...new Set(
        allRaw.flatMap(j => [j.blueprint_type_id, j.product_type_id].filter(Boolean))
      )];
      const nameMap = {};
      if (typeIds.length) {
        try {
          const arr = await window.eveAPI.getNames(typeIds);
          if (Array.isArray(arr)) arr.forEach(e => { if (e.id && e.name) nameMap[e.id] = e.name; });
        } catch (_) {}
        // SDE fallback for any still-missing
        await Promise.allSettled(typeIds.filter(id => !nameMap[id]).map(async id => {
          try { const n = await window.eveAPI.sdeGetName(id); if (n) nameMap[id] = n; } catch (_) {}
        }));
      }

      const activeRaw = allRaw.filter(j => ['active','ready','paused'].includes(j.status));

      // Resolve system names via SDE (offline, no ESI dependency)
      const sysIds = [...new Set(activeRaw.map(j => j.solar_system_id).filter(Boolean))];
      let sysNames = {};
      if (sysIds.length) {
        try { sysNames = await window.eveAPI.sdeGetSystemNames(sysIds) || {}; } catch (_) {}
        // ESI top-up for any SDE gaps
        const missing = sysIds.filter(id => !sysNames[id]);
        if (missing.length) {
          try {
            const esiMap = await window.eveAPI.resolveSystemNames(missing) || {};
            Object.assign(sysNames, esiMap);
          } catch (_) {}
        }
      }

      // Fallback: jobs where solar_system_id = 0 → resolve via facility_id (NPC stations in SDE)
      const facilityIds = [...new Set(
        activeRaw.filter(j => !j.solar_system_id && j.facility_id).map(j => j.facility_id)
      )];
      let facilityToSys = {};
      if (facilityIds.length) {
        try { facilityToSys = await window.eveAPI.sdeFacilityToSystem(facilityIds) || {}; } catch (_) {}
      }

      _ajAllJobs = activeRaw.map(j => ({
        ...j,
        _bpName:     nameMap[j.blueprint_type_id] || `Type ${j.blueprint_type_id}`,
        _prodName:   j.product_type_id ? (nameMap[j.product_type_id] || `Type ${j.product_type_id}`) : null,
        _displayId:  j.product_type_id || j.blueprint_type_id,
        _systemName: (j.solar_system_id && sysNames[j.solar_system_id])
                  || (j.facility_id    && facilityToSys[j.facility_id])
                  || (j.solar_system_id ? `System ${j.solar_system_id}` : null)
                  || '—',
      }));

      renderAJTable();
    } catch (err) {
      console.error('[ActiveJobs]', err);
      document.getElementById('ajTableBody').innerHTML = `
        <tr><td colspan="8" style="text-align:center;padding:60px;
            font-family:var(--mono);font-size:12px;color:var(--danger);">
          ⚠ Failed to load jobs: ${escHtml(err.message)}
        </td></tr>`;
    } finally {
      const btn2 = document.getElementById('ajRefreshBtn');
      if (btn2) { btn2.disabled = false; btn2.textContent = '⟳ REFRESH'; }
    }
  }

  function renderAJTable() {
    const body     = document.getElementById('ajTableBody');
    const countEl  = document.getElementById('ajJobCount');
    if (!body) return;

    const now = Date.now();
    let jobs = _ajAllJobs.slice();

    // Filters
    if (_ajActFilter) jobs = jobs.filter(j => String(j.activity_id) === _ajActFilter);
    if (_ajCharFilter) jobs = jobs.filter(j => String(j.character_id) === _ajCharFilter);

    // Sort
    const statusOrder = { active: 0, ready: 1, paused: 2 };
    jobs.sort((a, b) => {
      const d = _ajSort.dir;
      if (_ajSort.col === 'char')     return d * a._charName.localeCompare(b._charName);
      if (_ajSort.col === 'runs')     return d * ((a.runs ?? 1) - (b.runs ?? 1));
      if (_ajSort.col === 'cost')     return d * ((a.cost ?? 0) - (b.cost ?? 0));
      if (_ajSort.col === 'end') {
        return d * (new Date(a.end_date || 0) - new Date(b.end_date || 0));
      }
      // Default: progress (time remaining asc, ready last)
      const oa = statusOrder[a.status] ?? 3, ob = statusOrder[b.status] ?? 3;
      if (oa !== ob) return d * (oa - ob);
      return d * (new Date(a.end_date || 0) - new Date(b.end_date || 0));
    });

    if (countEl) {
      const chars = new Set(jobs.map(j => j.character_id)).size;
      countEl.textContent = jobs.length
        ? `${jobs.length} job${jobs.length !== 1 ? 's' : ''} · ${chars} character${chars !== 1 ? 's' : ''}`
        : '';
    }

    if (!jobs.length) {
      body.innerHTML = `
        <tr><td colspan="8" style="text-align:center;padding:60px;
            font-family:var(--mono);font-size:12px;color:var(--text-3);">
          ⬡ No active industry jobs.
        </td></tr>`;
      return;
    }

    body.innerHTML = jobs.map(job => {
      const act       = _AJ_ACT[job.activity_id] || { label: `Act ${job.activity_id}`, color: 'var(--text-3)' };
      const itemId    = job._displayId;
      const icon64    = `https://images.evetech.net/types/${itemId}/icon?size=64`;
      const icon32    = `https://images.evetech.net/types/${itemId}/icon?size=32`;
      const iconBp    = `https://images.evetech.net/types/${itemId}/bp?size=32`;

      const itemIcon = itemId
        ? `<img src="${icon64}" style="width:26px;height:26px;border-radius:3px;
                    border:1px solid var(--border);flex-shrink:0;background:var(--bg-deep);"
               onerror="if(this.src==='${icon64}'){this.src='${icon32}'}else if(this.src==='${icon32}'){this.src='${iconBp}'}else{this.style.display='none'}">`
        : '';

      const charPortrait = `<img src="https://images.evetech.net/characters/${job.character_id}/portrait?size=32"
        style="width:22px;height:22px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;"
        onerror="this.style.display='none'">`;

      // Item cell: bp name + arrow + product name (for mfg/invention)
      const nameDisplay = job._prodName && job._prodName !== job._bpName
        ? `<span style="color:var(--text-1);">${escHtml(job._prodName)}</span>
           <span style="font-size:10px;color:var(--text-3);font-family:var(--mono);display:block;">
             from ${escHtml(job._bpName)}
           </span>`
        : `<span style="color:var(--text-1);">${escHtml(job._bpName)}</span>`;

      // Progress cell
      let progressCell;
      if (job.status === 'ready') {
        progressCell = `
          <td style="padding:10px 14px;">
            <span style="font-family:var(--mono);font-size:11px;font-weight:700;
                         color:var(--success);letter-spacing:0.05em;">✓ READY TO DELIVER</span>
          </td>`;
      } else if (job.status === 'paused') {
        progressCell = `
          <td style="padding:10px 14px;">
            <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);">⏸ PAUSED</span>
          </td>`;
      } else {
        const start = new Date(job.start_date).getTime();
        const end   = new Date(job.end_date).getTime();
        const pct   = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
        const left  = Math.max(0, end - now);
        const fillCol = pct >= 90 ? '#4ecbb0' : pct >= 50 ? 'var(--accent)' : '#c0392b';
        progressCell = `
          <td style="padding:10px 14px;">
            <div style="display:flex;flex-direction:column;gap:4px;">
              <div style="height:5px;background:var(--bg-card);border-radius:3px;
                          overflow:hidden;min-width:140px;">
                <div style="height:100%;width:${pct.toFixed(1)}%;background:${fillCol};
                            border-radius:3px;transition:width 0.3s;"></div>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;">
                <span style="font-family:var(--mono);font-size:10px;color:var(--text-2);">
                  ${_ajFmtTime(left)} left
                </span>
                <span style="font-family:var(--mono);font-size:9px;color:var(--text-3);">
                  ${pct.toFixed(0)}%
                </span>
              </div>
            </div>
          </td>`;
      }

      const endDate = job.status === 'ready'
        ? `<td style="padding:10px 8px;font-family:var(--mono);font-size:10px;
                      color:var(--success);">Completed</td>`
        : `<td style="padding:10px 8px;font-family:var(--mono);font-size:10px;
                      color:var(--text-3);white-space:nowrap;">${_ajFmtDate(job.end_date)}</td>`;

      const costCell = job.cost > 0
        ? `<td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                      font-size:11px;color:var(--text-2);">${formatNumber(job.cost)}</td>`
        : `<td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                      font-size:11px;color:var(--text-3);">—</td>`;

      const probBadge = job.probability != null && job.activity_id === 8
        ? `<span style="font-family:var(--mono);font-size:9px;color:var(--text-3);
                        margin-left:4px;">${(job.probability * 100).toFixed(0)}%</span>`
        : '';

      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px 14px;white-space:nowrap;">
          <div style="display:flex;align-items:center;gap:7px;">
            ${charPortrait}
            <span style="color:var(--text-1);font-size:12px;">${escHtml(job._charName)}</span>
          </div>
        </td>
        <td style="padding:10px 8px;max-width:260px;">
          <div style="display:flex;align-items:flex-start;gap:8px;">
            ${itemIcon}
            <div>${nameDisplay}</div>
          </div>
        </td>
        <td style="padding:10px 8px;white-space:nowrap;">
          <span style="display:inline-block;padding:2px 9px;border-radius:3px;
                       font-family:var(--mono);font-size:10px;font-weight:700;
                       background:${act.color}22;color:${act.color};
                       border:1px solid ${act.color}44;">
            ${act.label}
          </span>
          ${probBadge}
        </td>
        ${progressCell}
        ${endDate}
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);
                   font-size:11px;color:var(--text-2);">${(job.runs ?? 1).toLocaleString()}×</td>
        ${costCell}
        <td style="padding:10px 8px;font-family:var(--mono);font-size:11px;
                   color:var(--text-3);white-space:nowrap;">
          ${escHtml(job._systemName || '—')}
        </td>
      </tr>`;
    }).join('');
  }

  // ── Wire controls ────────────────────────────────────────────────────────────
  container.addEventListener('change', e => {
    if (e.target.id === 'ajFilterActivity') { _ajActFilter  = e.target.value; renderAJTable(); }
    if (e.target.id === 'ajFilterChar')     { _ajCharFilter = e.target.value; renderAJTable(); }
  });

  container.addEventListener('click', e => {
    const th = e.target.closest('.aj-th');
    if (th) {
      const col = th.dataset.col;
      if (_ajSort.col === col) _ajSort.dir *= -1;
      else { _ajSort.col = col; _ajSort.dir = 1; }
      renderAJTable();
    }
    if (e.target.closest('#ajRefreshBtn')) loadJobs();
  });

  // ── Auto-refresh progress bars every 30s ─────────────────────────────────────
  _ajRefreshTimer = setInterval(() => {
    if (document.getElementById('ajTableBody')) renderAJTable();
    else { clearInterval(_ajRefreshTimer); _ajRefreshTimer = null; }
  }, 30000);

  await loadJobs();
}

// ─── Stubs (prevent crashes) ──────────────────────────────────────────────────
function buildCategoryBrowse()        { console.log('Category build stub'); }
function handleBlueprintSearch(query) { console.log('Search stub:', query); }
// handleManualSearchInput is expected to be defined in the search/calculator module.
// This fallback prevents a ReferenceError if it hasn't loaded yet.
if (typeof handleManualSearchInput === 'undefined') {
  window.handleManualSearchInput = function() {
    console.warn('handleManualSearchInput not yet loaded — search module missing?');
  };
}
// ─── Ore Calculator ───────────────────────────────────────────────────────────
// Mirrors the Fuzzwork ore/M3 page:
//   - Pulls Jita 4-4 sell prices for all minerals via the existing getJitaPrices IPC
//   - Displays ore refine yields, ISK/M3, ISK/unit, and raw ore sell price
//   - Lets the user adjust refining efficiency and tax
//   - Sortable columns
//   - Groups: Highsec / Lowsec & Null / Ice (ore only here; ice has its own tab)

// ── Ore data ─────────────────────────────────────────────────────────────────
// typeId matches ESI / SDE. Mineral yields are the base per-100-unit batch.
// volume = m³ per unit.  batchSize = units needed to refine (standard is 100).

const ORE_DATA = [
  // ── Highsec ──────────────────────────────────────────────────────────────
  {
    name:'Veldspar',    typeId:1230,  group:'Highsec',  volume:0.1,  batchSize:100,
    minerals:{ Tritanium:400 }
  },
  {
    name:'Scordite',    typeId:1228,  group:'Highsec',  volume:0.15, batchSize:100,
    minerals:{ Tritanium:150, Pyerite:90 }
  },
  {
    name:'Pyroxeres',   typeId:1224,  group:'Highsec',  volume:0.3,  batchSize:100,
    minerals:{ Pyerite:90, Mexallon:30 }
  },
  {
    name:'Plagioclase', typeId:18,    group:'Highsec',  volume:0.35, batchSize:100,
    minerals:{ Tritanium:175, Mexallon:70 }
  },
  // ── Lowsec ───────────────────────────────────────────────────────────────
  {
    name:'Omber',       typeId:1227,  group:'Lowsec',   volume:0.6,  batchSize:100,
    minerals:{ Pyerite:90, Isogen:75 }
  },
  {
    name:'Kernite',     typeId:20,    group:'Lowsec',   volume:1.2,  batchSize:100,
    minerals:{ Mexallon:60, Isogen:120 }
  },
  // ── Nullsec / 0.0 ────────────────────────────────────────────────────────
  {
    name:'Jaspet',      typeId:1226,  group:'Nullsec',  volume:2,    batchSize:100,
    minerals:{ Mexallon:150, Nocxium:50 }
  },
  {
    name:'Hemorphite',  typeId:1229,  group:'Nullsec',  volume:3,    batchSize:100,
    minerals:{ Isogen:240, Nocxium:90 }
  },
  {
    name:'Hedbergite',  typeId:21,    group:'Nullsec',  volume:3,    batchSize:100,
    minerals:{ Pyerite:450, Nocxium:120 }
  },
  {
    name:'Gneiss',      typeId:1229,  group:'Nullsec',  volume:5,    batchSize:100,
    minerals:{ Pyerite:2000, Mexallon:1500, Isogen:800 }
  },
  // NOTE: Gneiss typeId in SDE is 1229 — same number is used for Hemorphite above.
  // If prices appear wrong for Gneiss, override ORE_SELL_IDS['Gneiss'] to the correct
  // compressed variant ID once confirmed from your local SDE copy.
  {
    name:'Dark Ochre',  typeId:1232,  group:'Nullsec',  volume:8,    batchSize:100,
    minerals:{ Mexallon:1360, Isogen:1200, Nocxium:320 }
  },
  {
    name:'Crokite',     typeId:1225,  group:'Nullsec',  volume:16,   batchSize:100,
    minerals:{ Pyerite:800, Mexallon:2000, Nocxium:800 }
  },
  {
    name:'Spodumain',   typeId:19,    group:'Nullsec',  volume:16,   batchSize:100,
    minerals:{ Tritanium:48000, Isogen:1000, Nocxium:160, Zydrine:80, Megacyte:40 }
  },
  {
    name:'Bistot',      typeId:1223,  group:'Nullsec',  volume:16,   batchSize:100,
    minerals:{ Pyerite:3200, Mexallon:1200, Zydrine:160 }
  },
  {
    name:'Arkonor',     typeId:22,    group:'Nullsec',  volume:16,   batchSize:100,
    minerals:{ Pyerite:3200, Mexallon:1200, Megacyte:120 }
  },
  {
    name:'Mercoxit',    typeId:11396, group:'Nullsec',  volume:40,   batchSize:100,
    minerals:{ Morphite:140 }
  },
];

// Mineral type IDs (Jita prices fetched for these)
const MINERAL_IDS = {
  Tritanium: 34,
  Pyerite:   35,
  Mexallon:  36,
  Isogen:    37,
  Nocxium:   38,
  Zydrine:   39,
  Megacyte:  40,
  Morphite:  11399,
};

// Ore raw sell type IDs so we can show "sell raw" price too
// Most ores share the compressed variant IDs but we just need the base ore for now
// ⚠ Gneiss and Hemorphite both resolve to 1229 in the user's data — this is a known
//   collision. The EVE SDE base typeId for Gneiss is 1229 (Hemorphite) vs 1229.
//   TODO: verify from your local SDE and replace Gneiss:1229 with the correct ID.
const ORE_SELL_IDS = {
  Veldspar:1230, Scordite:1228, Pyroxeres:1224, Plagioclase:18,
  Omber:1227, Kernite:20, Jaspet:1226, Hemorphite:1229,
  Hedbergite:21, Gneiss:1229 /* ⚠ verify ID */, 'Dark Ochre':1232, Crokite:1225,
  Spodumain:19, Bistot:1223, Arkonor:22, Mercoxit:11396,
};

// ── State for the ore calculator ─────────────────────────────────────────────
let _oreRefineEff  = 72.36;   // % – the Fuzzwork default (perfect skills no implant)
let _oreTaxRate    = 5;        // %
let _oreSort       = { col: 'iskM3', dir: -1 };
let _orePrices     = {};       // typeId → { sell, buy }
let _oreLoading    = false;

async function renderOreCalculator(container) {
  container.innerHTML = `
    <div id="oreCalcWrap" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <!-- toolbar -->
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;
                  padding:12px 16px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;">ORE CALCULATOR · JITA 4-4</span>
        <div style="display:flex;align-items:center;gap:8px;margin-left:auto;">
          <label style="font-size:12px;color:var(--text-2);font-family:var(--mono);">REFINE EFF %</label>
          <input id="oreRefineEff" type="number" min="0" max="100" step="0.01"
                 value="${_oreRefineEff}"
                 class="field-input" style="width:76px;padding:5px 8px;font-size:12px;"
                 title="Refining efficiency (perfect skills + T2 implant ≈ 82.5%, NPC station max = 72.36%)"/>
          <label style="font-size:12px;color:var(--text-2);font-family:var(--mono);">TAX %</label>
          <input id="oreTaxRate" type="number" min="0" max="100" step="0.1"
                 value="${_oreTaxRate}"
                 class="field-input" style="width:58px;padding:5px 8px;font-size:12px;"/>
          <button id="oreRefreshBtn" class="icon-btn"
                  style="padding:5px 12px;font-size:12px;">⟳ REFRESH</button>
        </div>
        <div id="orePriceAge" style="font-size:10px;color:var(--text-3);font-family:var(--mono);"></div>
      </div>

      <!-- mineral price strip -->
      <div id="oreMineralStrip" style="display:flex;gap:0;border-bottom:1px solid var(--border);
           background:var(--bg-panel);flex-shrink:0;overflow-x:auto;">
        ${Object.keys(MINERAL_IDS).map(m => `
          <div style="padding:6px 14px;border-right:1px solid var(--border);white-space:nowrap;">
            <div style="font-size:9px;color:var(--text-3);font-family:var(--mono);letter-spacing:0.08em;">${m.toUpperCase()}</div>
            <div id="mPrice_${m}" style="font-size:11px;color:var(--accent);font-family:var(--mono);">…</div>
          </div>`).join('')}
      </div>

      <!-- table -->
      <div style="flex:1;overflow-y:auto;">
        <table id="oreTable" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);
                       position:sticky;top:0;z-index:1;">
              <th class="ore-th" data-col="group"   style="text-align:left;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">GROUP ↕</th>
              <th class="ore-th" data-col="name"    style="text-align:left;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ORE ↕</th>
              <th class="ore-th" data-col="vol"     style="text-align:right;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">M³/UNIT ↕</th>
              <th style="text-align:right;padding:10px 8px;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">MINERALS / BATCH</th>
              <th class="ore-th" data-col="iskUnit" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">REFINE ISK/UNIT ↕</th>
              <th class="ore-th" data-col="iskM3"   style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;color:var(--accent);">REFINE ISK/M³ ↕</th>
              <th class="ore-th" data-col="sellRaw" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">RAW SELL/UNIT ↕</th>
              <th class="ore-th" data-col="sellM3"  style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">RAW SELL/M³ ↕</th>
            </tr>
          </thead>
          <tbody id="oreTableBody">
            <tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-3);
                font-family:var(--mono);font-size:12px;">⬡ Fetching Jita prices…</td></tr>
          </tbody>
        </table>
      </div>

      <div style="padding:8px 16px;border-top:1px solid var(--border);background:var(--bg-card);
                  font-size:10px;color:var(--text-3);font-family:var(--mono);flex-shrink:0;">
        Prices from Jita 4-4 CNAP (5% sell orders). Refine ISK assumes perfect skills with your efficiency setting.
        Raw sell price = sell a single unit directly on the market.
      </div>
    </div>`;

  // Bind toolbar controls
  document.getElementById('oreRefineEff').addEventListener('change', e => {
    _oreRefineEff = parseFloat(e.target.value) || 72.36;
    buildOreTable();
  });
  document.getElementById('oreTaxRate').addEventListener('change', e => {
    _oreTaxRate = parseFloat(e.target.value) || 5;
    buildOreTable();
  });
  document.getElementById('oreRefreshBtn').addEventListener('click', () => loadOrePrices());

  // Sortable column headers
  document.querySelectorAll('#oreCalcWrap .ore-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_oreSort.col === col) _oreSort.dir *= -1;
      else { _oreSort.col = col; _oreSort.dir = -1; }
      buildOreTable();
    });
  });

  await loadOrePrices();
}

async function loadOrePrices() {
  if (_oreLoading) return;
  _oreLoading = true;
  const refreshBtn = document.getElementById('oreRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    // Collect all type IDs we need prices for: minerals + raw ores
    const mineralIds = Object.values(MINERAL_IDS);
    const oreIds     = Object.values(ORE_SELL_IDS);
    const allIds     = [...new Set([...mineralIds, ...oreIds])];

    const raw = await window.eveAPI.getJitaPrices(allIds);
    _orePrices = raw || {};

    // Update mineral price strip
    for (const [mName, mId] of Object.entries(MINERAL_IDS)) {
      const el = document.getElementById(`mPrice_${mName}`);
      if (!el) continue;
      const p = _orePrices[mId];
      el.textContent = p?.sell > 0 ? formatNumber(p.sell) + ' ISK' : '—';
    }

    const ageEl = document.getElementById('orePriceAge');
    if (ageEl) ageEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    buildOreTable();
  } catch (err) {
    logToConsole(`Ore prices fetch failed: ${err.message}`, 'error');
    const body = document.getElementById('oreTableBody');
    if (body) body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;
      color:var(--danger);font-family:var(--mono);font-size:12px;">
      ⚠ Failed to fetch prices: ${escHtml(err.message)}</td></tr>`;
  } finally {
    _oreLoading = false;
    const btn = document.getElementById('oreRefreshBtn');
    if (btn) btn.disabled = false;
  }
}

function calcOreRow(ore) {
  const effFactor  = (_oreRefineEff / 100);
  const taxFactor  = 1 - (_oreTaxRate / 100);
  const batchM3    = ore.batchSize * ore.volume;

  // Mineral value for one batch after refining efficiency + tax
  let batchMineralISK = 0;
  for (const [mName, baseQty] of Object.entries(ore.minerals)) {
    const mId    = MINERAL_IDS[mName];
    const p      = _orePrices[mId];
    const price  = p?.sell > 0 ? p.sell : (p?.buy || 0);
    const actual = Math.floor(baseQty * effFactor);   // EVE floors refined minerals
    batchMineralISK += actual * price * taxFactor;
  }

  const iskPerUnit = batchMineralISK / ore.batchSize;
  const iskPerM3   = iskPerUnit / ore.volume;

  // Raw ore sell price (per unit)
  const rawId       = ORE_SELL_IDS[ore.name];
  const rawP        = _orePrices[rawId];
  const rawSellUnit = rawP?.sell > 0 ? rawP.sell : (rawP?.buy || 0);
  const rawSellM3   = rawSellUnit / ore.volume;

  return { iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 };
}

function buildOreTable() {
  const body = document.getElementById('oreTableBody');
  if (!body) return;

  // Compute values for every ore, attach for sorting
  const rows = ORE_DATA.map(ore => {
    const { iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 } = calcOreRow(ore);
    return { ore, iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 };
  });

  // Sort
  const col = _oreSort.col;
  const dir = _oreSort.dir;
  rows.sort((a, b) => {
    let va, vb;
    if      (col === 'name')    { va = a.ore.name;  vb = b.ore.name; return dir * va.localeCompare(vb); }
    else if (col === 'group')   { va = a.ore.group; vb = b.ore.group; return dir * va.localeCompare(vb); }
    else if (col === 'vol')     { va = a.ore.volume; vb = b.ore.volume; }
    else if (col === 'iskUnit') { va = a.iskPerUnit; vb = b.iskPerUnit; }
    else if (col === 'iskM3')   { va = a.iskPerM3;   vb = b.iskPerM3; }
    else if (col === 'sellRaw') { va = a.rawSellUnit; vb = b.rawSellUnit; }
    else if (col === 'sellM3')  { va = a.rawSellM3;  vb = b.rawSellM3; }
    else                        { va = a.iskPerM3;   vb = b.iskPerM3; }
    return dir * (va - vb);
  });

  // Find max ISK/M3 for a visual bar
  const maxIskM3 = Math.max(...rows.map(r => r.iskPerM3), 1);

  // Group colour chips
  const groupColors = { Highsec: '#4ecbb0', Lowsec: '#e3a84d', Nullsec: '#c05c7e' };

  body.innerHTML = rows.map((r, i) => {
    const { ore, iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 } = r;
    const gc    = groupColors[ore.group] || 'var(--text-3)';
    const barW  = Math.round((iskPerM3 / maxIskM3) * 100);
    const isTop = i === 0;

    // Compact mineral yield summary
    const minSummary = Object.entries(ore.minerals).map(([mn, qty]) => {
      const actual = Math.floor(qty * (_oreRefineEff / 100));
      return `<span style="color:var(--text-2);">${mn.substring(0,3)}:</span>`
           + `<span style="color:var(--text-1);"> ${formatNumber(actual)}</span>`;
    }).join(' &nbsp;');

    return `
      <tr style="border-bottom:1px solid var(--border);
                 background:${isTop ? 'rgba(255,255,255,0.03)' : 'transparent'};
                 ${isTop ? 'outline:1px solid var(--accent);' : ''}">
        <td style="padding:10px 14px;white-space:nowrap;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                       background:${gc};margin-right:6px;vertical-align:middle;"></span>
          <span style="font-family:var(--mono);font-size:10px;color:${gc};">${ore.group}</span>
        </td>
        <td style="padding:10px 8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="https://images.evetech.net/types/${ore.typeId}/icon?size=32"
                 onerror="this.onerror=null;this.style.display='none';"
                 style="width:24px;height:24px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">
            <span style="color:var(--text-1);font-weight:600;">${escHtml(ore.name)}</span>
          </div>
        </td>
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${ore.volume.toFixed(2)}
        </td>
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--text-3);">
          ${minSummary}
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                   color:${iskPerUnit > rawSellUnit ? 'var(--success)' : 'var(--text-2)'};">
          ${iskPerUnit > 0 ? formatNumber(iskPerUnit) : '—'}
        </td>
        <td style="padding:10px 14px;text-align:right;">
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <div style="width:60px;height:4px;background:var(--bg-card);border-radius:2px;overflow:hidden;flex-shrink:0;">
              <div style="height:100%;width:${barW}%;background:${isTop ? 'var(--accent)' : 'var(--text-3)'};border-radius:2px;"></div>
            </div>
            <span style="font-family:var(--mono);font-weight:700;
                         color:${isTop ? 'var(--accent)' : 'var(--text-1)'};">
              ${iskPerM3 > 0 ? formatNumber(iskPerM3) : '—'}
            </span>
          </div>
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                   color:${rawSellUnit > iskPerUnit ? 'var(--success)' : 'var(--text-2)'};">
          ${rawSellUnit > 0 ? formatNumber(rawSellUnit) : '—'}
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${rawSellM3 > 0 ? formatNumber(rawSellM3) : '—'}
        </td>
      </tr>`;
  }).join('');
}
// ─── Ice Calculator ───────────────────────────────────────────────────────────
// Mirrors Fuzzwork's ice/M3 page:
//   - All 24 ice types (base + compressed) with correct Fuzzwork yields
//   - Pulls Jita 4-4 sell prices for all 7 ice products via getJitaPrices IPC
//   - ISK/M³ (primary sort, mini bar chart), ISK/unit, raw sell/unit, raw sell/M³
//   - Product price strip at the top
//   - Refining efficiency % (default 72.36%) and tax % (default 5%)
//   - Sortable columns, colour-coded groups, Refresh button
//   - Raw sell > refine cells highlighted green

// ── Ice product type IDs ──────────────────────────────────────────────────────
const ICE_PRODUCT_IDS = {
  'Heavy Water':          16272,
  'Liquid Ozone':         16273,
  'Helium Isotopes':      16274,
  'Strontium Clathrates': 16275,
  'Hydrogen Isotopes':    17889,
  'Oxygen Isotopes':      17887,
  'Nitrogen Isotopes':    17888,
};

// ── Ice data — yields per single unit refined (batchSize = 1 for all ice) ────
// Volumes and yields match the Fuzzwork table exactly.
// group: Highsec / Lowsec / Nullsec / Wormhole / Compressed
const ICE_DATA = [
  // ── Highsec ──────────────────────────────────────────────────────────────
  {
    name: 'Clear Icicle',    typeId: 16262, group: 'Highsec',  volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Helium Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Glacial Mass',    typeId: 16263, group: 'Highsec',  volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Hydrogen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Blue Ice',        typeId: 16264, group: 'Highsec',  volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Oxygen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'White Glaze',     typeId: 16265, group: 'Highsec',  volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Nitrogen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  // ── Lowsec / Null ─────────────────────────────────────────────────────────
  {
    name: 'Glare Crust',     typeId: 16266, group: 'Lowsec',   volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 1381, 'Liquid Ozone': 691, 'Strontium Clathrates': 35 },
  },
  {
    name: 'Dark Glitter',    typeId: 16267, group: 'Lowsec',   volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 691, 'Liquid Ozone': 1381, 'Strontium Clathrates': 69 },
  },
  {
    name: 'Gelidus',         typeId: 16268, group: 'Lowsec',   volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 345, 'Liquid Ozone': 691, 'Strontium Clathrates': 104 },
  },
  {
    name: 'Krystallos',      typeId: 16269, group: 'Lowsec',   volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 173, 'Liquid Ozone': 691, 'Strontium Clathrates': 173 },
  },
  // ── Improved variants (Highsec enhanced) ─────────────────────────────────
  {
    name: 'Thick Blue Ice',           typeId: 17975, group: 'Highsec+', volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Oxygen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Pristine White Glaze',     typeId: 17976, group: 'Highsec+', volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Nitrogen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Smooth Glacial Mass',      typeId: 17977, group: 'Highsec+', volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Hydrogen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Enriched Clear Icicle',    typeId: 17978, group: 'Highsec+', volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Helium Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  // ── Compressed ───────────────────────────────────────────────────────────
  {
    name: 'Compressed Blue Ice',              typeId: 28433, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Oxygen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Clear Icicle',          typeId: 28443, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Helium Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Dark Glitter',          typeId: 28444, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 691, 'Liquid Ozone': 1381, 'Strontium Clathrates': 69 },
  },
  {
    name: 'Compressed Enriched Clear Icicle', typeId: 28445, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Helium Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Gelidus',               typeId: 28446, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 345, 'Liquid Ozone': 691, 'Strontium Clathrates': 104 },
  },
  {
    name: 'Compressed Glacial Mass',          typeId: 28447, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Hydrogen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Glare Crust',           typeId: 28448, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 1381, 'Liquid Ozone': 691, 'Strontium Clathrates': 35 },
  },
  {
    name: 'Compressed Krystallos',            typeId: 28449, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 173, 'Liquid Ozone': 691, 'Strontium Clathrates': 173 },
  },
  {
    name: 'Compressed Pristine White Glaze',  typeId: 28450, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Nitrogen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Smooth Glacial Mass',   typeId: 28451, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Hydrogen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Thick Blue Ice',        typeId: 28452, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Oxygen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed White Glaze',           typeId: 28453, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Nitrogen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
];

// Raw sell type IDs for ice (same as ICE_DATA typeIds — buying unrefined ice)
const ICE_SELL_IDS = Object.fromEntries(ICE_DATA.map(ice => [ice.name, ice.typeId]));

// ── Ice calculator state ──────────────────────────────────────────────────────
let _iceRefineEff = 72.36;
let _iceTaxRate   = 5;
let _iceSort      = { col: 'iskM3', dir: -1 };
let _icePrices    = {};
let _iceLoading   = false;

async function renderIceCalculator(container) {
  container.innerHTML = `
    <div id="iceCalcWrap" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <!-- toolbar -->
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;
                  padding:12px 16px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;">ICE CALCULATOR · JITA 4-4</span>
        <div style="display:flex;align-items:center;gap:8px;margin-left:auto;">
          <label style="font-size:12px;color:var(--text-2);font-family:var(--mono);">REFINE EFF %</label>
          <input id="iceRefineEff" type="number" min="0" max="100" step="0.01"
                 value="${_iceRefineEff}"
                 class="field-input" style="width:76px;padding:5px 8px;font-size:12px;"
                 title="Refining efficiency — perfect skills no implant = 72.36%, T2 implant = 82.5%"/>
          <label style="font-size:12px;color:var(--text-2);font-family:var(--mono);">TAX %</label>
          <input id="iceTaxRate" type="number" min="0" max="100" step="0.1"
                 value="${_iceTaxRate}"
                 class="field-input" style="width:58px;padding:5px 8px;font-size:12px;"/>
          <button id="iceRefreshBtn" class="icon-btn"
                  style="padding:5px 12px;font-size:12px;">⟳ REFRESH</button>
        </div>
        <div id="icePriceAge" style="font-size:10px;color:var(--text-3);font-family:var(--mono);"></div>
      </div>

      <!-- ice product price strip -->
      <div id="iceProductStrip" style="display:flex;gap:0;border-bottom:1px solid var(--border);
           background:var(--bg-panel);flex-shrink:0;overflow-x:auto;">
        ${Object.keys(ICE_PRODUCT_IDS).map(p => `
          <div style="padding:6px 14px;border-right:1px solid var(--border);white-space:nowrap;">
            <div style="font-size:9px;color:var(--text-3);font-family:var(--mono);letter-spacing:0.08em;">
              ${p.toUpperCase().replace(/ /g,'&nbsp;')}
            </div>
            <div id="icePrice_${p.replace(/ /g,'_')}"
                 style="font-size:11px;color:var(--accent);font-family:var(--mono);">…</div>
          </div>`).join('')}
      </div>

      <!-- table -->
      <div style="flex:1;overflow-y:auto;">
        <table id="iceTable" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);
                       position:sticky;top:0;z-index:1;">
              <th class="ice-th" data-col="group"   style="text-align:left;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">GROUP ↕</th>
              <th class="ice-th" data-col="name"    style="text-align:left;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ICE ↕</th>
              <th class="ice-th" data-col="vol"     style="text-align:right;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">M³/UNIT ↕</th>
              <th style="text-align:right;padding:10px 8px;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">PRODUCTS / UNIT</th>
              <th class="ice-th" data-col="iskUnit" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">REFINE ISK/UNIT ↕</th>
              <th class="ice-th" data-col="iskM3"   style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;letter-spacing:0.1em;color:var(--accent);">REFINE ISK/M³ ↕</th>
              <th class="ice-th" data-col="sellRaw" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">RAW SELL/UNIT ↕</th>
              <th class="ice-th" data-col="sellM3"  style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">RAW SELL/M³ ↕</th>
            </tr>
          </thead>
          <tbody id="iceTableBody">
            <tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-3);
                font-family:var(--mono);font-size:12px;">⬡ Fetching Jita prices…</td></tr>
          </tbody>
        </table>
      </div>

      <div style="padding:8px 16px;border-top:1px solid var(--border);background:var(--bg-card);
                  font-size:10px;color:var(--text-3);font-family:var(--mono);flex-shrink:0;">
        Prices from Jita 4-4 CNAP (sell orders). Ice does not use efficiency loss — all products
        are yielded at 100% of base quantity × your efficiency setting. Raw sell = sell unprocessed ice directly.
      </div>
    </div>`;

  // Bind toolbar
  document.getElementById('iceRefineEff').addEventListener('change', e => {
    _iceRefineEff = parseFloat(e.target.value) || 72.36;
    buildIceTable();
  });
  document.getElementById('iceTaxRate').addEventListener('change', e => {
    _iceTaxRate = parseFloat(e.target.value) || 5;
    buildIceTable();
  });
  document.getElementById('iceRefreshBtn').addEventListener('click', () => loadIcePrices());

  // Sortable headers
  document.querySelectorAll('#iceCalcWrap .ice-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_iceSort.col === col) _iceSort.dir *= -1;
      else { _iceSort.col = col; _iceSort.dir = -1; }
      buildIceTable();
    });
  });

  await loadIcePrices();
}

async function loadIcePrices() {
  if (_iceLoading) return;
  _iceLoading = true;
  const refreshBtn = document.getElementById('iceRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const productIds = Object.values(ICE_PRODUCT_IDS);
    const rawIceIds  = Object.values(ICE_SELL_IDS);
    const allIds     = [...new Set([...productIds, ...rawIceIds])];

    const raw = await window.eveAPI.getJitaPrices(allIds);
    _icePrices = raw || {};

    // Update product price strip
    for (const [pName, pId] of Object.entries(ICE_PRODUCT_IDS)) {
      const el = document.getElementById(`icePrice_${pName.replace(/ /g, '_')}`);
      if (!el) continue;
      const p = _icePrices[pId];
      el.textContent = p?.sell > 0 ? formatNumber(p.sell) + ' ISK' : '—';
    }

    const ageEl = document.getElementById('icePriceAge');
    if (ageEl) ageEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    buildIceTable();
  } catch (err) {
    logToConsole(`Ice prices fetch failed: ${err.message}`, 'error');
    const body = document.getElementById('iceTableBody');
    if (body) body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;
      color:var(--danger);font-family:var(--mono);font-size:12px;">
      ⚠ Failed to fetch prices: ${escHtml(err.message)}</td></tr>`;
  } finally {
    _iceLoading = false;
    const btn = document.getElementById('iceRefreshBtn');
    if (btn) btn.disabled = false;
  }
}

function calcIceRow(ice) {
  const effFactor = _iceRefineEff / 100;
  const taxFactor = 1 - (_iceTaxRate / 100);

  // Ice refining: EVE floors the product quantities, then applies tax
  let refineISK = 0;
  for (const [pName, baseQty] of Object.entries(ice.products)) {
    const pId    = ICE_PRODUCT_IDS[pName];
    const p      = _icePrices[pId];
    const price  = p?.sell > 0 ? p.sell : (p?.buy || 0);
    const actual = Math.floor(baseQty * effFactor);
    refineISK   += actual * price * taxFactor;
  }

  const iskPerUnit = refineISK;                   // batchSize = 1 for all ice
  const iskPerM3   = iskPerUnit / ice.volume;

  // Raw sell price for the unrefined ice unit
  const rawId       = ice.typeId;
  const rawP        = _icePrices[rawId];
  const rawSellUnit = rawP?.sell > 0 ? rawP.sell : (rawP?.buy || 0);
  const rawSellM3   = rawSellUnit / ice.volume;

  return { iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 };
}

function buildIceTable() {
  const body = document.getElementById('iceTableBody');
  if (!body) return;

  const rows = ICE_DATA.map(ice => {
    const { iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 } = calcIceRow(ice);
    return { ice, iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 };
  });

  // Sort
  const col = _iceSort.col;
  const dir = _iceSort.dir;
  rows.sort((a, b) => {
    let va, vb;
    if      (col === 'name')    { return dir * a.ice.name.localeCompare(b.ice.name); }
    else if (col === 'group')   { return dir * a.ice.group.localeCompare(b.ice.group); }
    else if (col === 'vol')     { va = a.ice.volume;   vb = b.ice.volume; }
    else if (col === 'iskUnit') { va = a.iskPerUnit;   vb = b.iskPerUnit; }
    else if (col === 'iskM3')   { va = a.iskPerM3;     vb = b.iskPerM3; }
    else if (col === 'sellRaw') { va = a.rawSellUnit;  vb = b.rawSellUnit; }
    else if (col === 'sellM3')  { va = a.rawSellM3;    vb = b.rawSellM3; }
    else                        { va = a.iskPerM3;     vb = b.iskPerM3; }
    return dir * (va - vb);
  });

  const maxIskM3 = Math.max(...rows.map(r => r.iskPerM3), 1);

  // Group colour coding: Highsec green, Highsec+ teal, Lowsec amber, Compressed purple
  const groupColors = {
    'Highsec':    '#4ecbb0',
    'Highsec+':   '#3ab8d4',
    'Lowsec':     '#e3a84d',
    'Compressed': '#ab7ab8',
  };

  body.innerHTML = rows.map((r, i) => {
    const { ice, iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 } = r;
    const gc    = groupColors[ice.group] || 'var(--text-3)';
    const barW  = Math.round((iskPerM3 / maxIskM3) * 100);
    const isTop = i === 0;

    // Product yield summary
    const prodSummary = Object.entries(ice.products).map(([pn, qty]) => {
      const actual = Math.floor(qty * (_iceRefineEff / 100));
      // Use short abbreviations so the column stays compact
      const abbr = pn.split(' ').map(w => w[0]).join('');
      return `<span style="color:var(--text-2);">${abbr}:</span>`
           + `<span style="color:var(--text-1);"> ${formatNumber(actual)}</span>`;
    }).join(' &nbsp;');

    return `
      <tr style="border-bottom:1px solid var(--border);
                 background:${isTop ? 'rgba(255,255,255,0.03)' : 'transparent'};
                 ${isTop ? 'outline:1px solid var(--accent);' : ''}">
        <td style="padding:10px 14px;white-space:nowrap;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                       background:${gc};margin-right:6px;vertical-align:middle;"></span>
          <span style="font-family:var(--mono);font-size:10px;color:${gc};">${ice.group}</span>
        </td>
        <td style="padding:10px 8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="https://images.evetech.net/types/${ice.typeId}/icon?size=32"
                 onerror="this.onerror=null;this.style.display='none';"
                 style="width:24px;height:24px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">
            <span style="color:var(--text-1);font-weight:600;">${escHtml(ice.name)}</span>
          </div>
        </td>
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${ice.volume.toLocaleString()}
        </td>
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--text-3);">
          ${prodSummary}
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                   color:${iskPerUnit > rawSellUnit ? 'var(--success)' : 'var(--text-2)'};">
          ${iskPerUnit > 0 ? formatNumber(iskPerUnit) : '—'}
        </td>
        <td style="padding:10px 14px;text-align:right;">
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <div style="width:60px;height:4px;background:var(--bg-card);border-radius:2px;overflow:hidden;flex-shrink:0;">
              <div style="height:100%;width:${barW}%;background:${isTop ? 'var(--accent)' : 'var(--text-3)'};border-radius:2px;"></div>
            </div>
            <span style="font-family:var(--mono);font-weight:700;
                         color:${isTop ? 'var(--accent)' : 'var(--text-1)'};">
              ${iskPerM3 > 0 ? formatNumber(iskPerM3) : '—'}
            </span>
          </div>
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                   color:${rawSellUnit > iskPerUnit ? 'var(--success)' : 'var(--text-2)'};">
          ${rawSellUnit > 0 ? formatNumber(rawSellUnit) : '—'}
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${rawSellM3 > 0 ? formatNumber(rawSellM3) : '—'}
        </td>
      </tr>`;
  }).join('');
}

// ─── Gas Calculator ───────────────────────────────────────────────────────────
// Gas is a raw-sell calculator — there is no refining step for gas in EVE.
// Value = Jita sell price per unit, ISK/m³, and ISK/full Venture hold (5000 m³).
// Groups: Cytoserocin (lowsec), Mykoserocin (nullsec), Fullerites (wormhole),
//         Hiemal Tricarboxyl Vapor (pochven).

// ── Gas type data ─────────────────────────────────────────────────────────────
// typeId from EVE SDE. volume = m³ per unit.
// ventureHold: the standard Venture gas-cloud scoop cargo hold is 5000 m³,
//   so ventureUnits = 5000 / volume.
const GAS_DATA = [
  // ── Cytoserocin — Lowsec booster gas ────────────────────────────────────
  { name: 'Amber Cytoserocin',     typeId: 25268, group: 'Cytoserocin', volume: 10 },
  { name: 'Azure Cytoserocin',     typeId: 25279, group: 'Cytoserocin', volume: 10 },
  { name: 'Celadon Cytoserocin',   typeId: 25275, group: 'Cytoserocin', volume: 10 },
  { name: 'Golden Cytoserocin',    typeId: 25273, group: 'Cytoserocin', volume: 10 },
  { name: 'Lime Cytoserocin',      typeId: 25277, group: 'Cytoserocin', volume: 10 },
  { name: 'Malachite Cytoserocin', typeId: 25281, group: 'Cytoserocin', volume: 10 },
  { name: 'Vermillion Cytoserocin',typeId: 25271, group: 'Cytoserocin', volume: 10 },
  { name: 'Viridian Cytoserocin',  typeId: 25269, group: 'Cytoserocin', volume: 10 },
  // ── Mykoserocin — Nullsec booster gas ───────────────────────────────────
  { name: 'Amber Mykoserocin',     typeId: 28694, group: 'Mykoserocin', volume: 10 },
  { name: 'Azure Mykoserocin',     typeId: 28700, group: 'Mykoserocin', volume: 10 },
  { name: 'Celadon Mykoserocin',   typeId: 28698, group: 'Mykoserocin', volume: 10 },
  { name: 'Golden Mykoserocin',    typeId: 28696, group: 'Mykoserocin', volume: 10 },
  { name: 'Lime Mykoserocin',      typeId: 28702, group: 'Mykoserocin', volume: 10 },
  { name: 'Malachite Mykoserocin', typeId: 28704, group: 'Mykoserocin', volume: 10 },
  { name: 'Vermillion Mykoserocin',typeId: 28706, group: 'Mykoserocin', volume: 10 },
  { name: 'Viridian Mykoserocin',  typeId: 28708, group: 'Mykoserocin', volume: 10 },
  // ── Fullerites — Wormhole reaction gas ──────────────────────────────────
  { name: 'Fullerite-C50',  typeId: 30370, group: 'Fullerite', volume: 1  },
  { name: 'Fullerite-C60',  typeId: 30371, group: 'Fullerite', volume: 1  },
  { name: 'Fullerite-C70',  typeId: 30372, group: 'Fullerite', volume: 1  },
  { name: 'Fullerite-C72',  typeId: 30373, group: 'Fullerite', volume: 2  },
  { name: 'Fullerite-C84',  typeId: 30374, group: 'Fullerite', volume: 2  },
  { name: 'Fullerite-C28',  typeId: 30375, group: 'Fullerite', volume: 2  },
  { name: 'Fullerite-C32',  typeId: 30376, group: 'Fullerite', volume: 5  },
  { name: 'Fullerite-C320', typeId: 30377, group: 'Fullerite', volume: 5  },
  { name: 'Fullerite-C540', typeId: 30378, group: 'Fullerite', volume: 10 },
  // ── Hiemal — Pochven ────────────────────────────────────────────────────
  { name: 'Hiemal Tricarboxyl Vapor', typeId: 52306, group: 'Pochven', volume: 10 },
];

// Venture gas hold = 5000 m³
const VENTURE_HOLD_M3 = 5000;

// ── Gas calculator state ──────────────────────────────────────────────────────
let _gasSort    = { col: 'iskM3', dir: -1 };
let _gasPrices  = {};
let _gasLoading = false;

async function renderGasCalculator(container) {
  container.innerHTML = `
    <div id="gasCalcWrap" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <!-- toolbar -->
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;
                  padding:12px 16px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;">GAS CALCULATOR · JITA 4-4</span>
        <div style="display:flex;align-items:center;gap:8px;margin-left:auto;">
          <button id="gasRefreshBtn" class="icon-btn"
                  style="padding:5px 12px;font-size:12px;">⟳ REFRESH</button>
        </div>
        <div id="gasPriceAge" style="font-size:10px;color:var(--text-3);font-family:var(--mono);"></div>
      </div>

      <!-- legend strip -->
      <div style="display:flex;gap:0;border-bottom:1px solid var(--border);
                  background:var(--bg-panel);flex-shrink:0;padding:8px 16px;
                  align-items:center;gap:20px;flex-wrap:wrap;">
        ${[
          ['Cytoserocin', '#e3a84d', 'Lowsec booster gas'],
          ['Mykoserocin',  '#4ecbb0', 'Nullsec booster gas'],
          ['Fullerite',    '#ab7ab8', 'Wormhole reaction gas'],
          ['Pochven',      '#c05c7e', 'Pochven special gas'],
        ].map(([label, color, tip]) => `
          <span style="display:flex;align-items:center;gap:6px;font-size:10px;
                       font-family:var(--mono);color:var(--text-2);" title="${tip}">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                         background:${color};flex-shrink:0;"></span>
            ${label}
          </span>`).join('')}
        <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);margin-left:auto;">
          Venture hold = ${VENTURE_HOLD_M3.toLocaleString()} m³ &nbsp;·&nbsp;
          Gas is sold raw — no refining step
        </span>
      </div>

      <!-- table -->
      <div style="flex:1;overflow-y:auto;">
        <table id="gasTable" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);
                       position:sticky;top:0;z-index:1;">
              <th class="gas-th" data-col="group"   style="text-align:left;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">GROUP ↕</th>
              <th class="gas-th" data-col="name"    style="text-align:left;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">GAS TYPE ↕</th>
              <th class="gas-th" data-col="vol"     style="text-align:right;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">M³/UNIT ↕</th>
              <th class="gas-th" data-col="iskUnit" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ISK/UNIT ↕</th>
              <th class="gas-th" data-col="iskM3"   style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;letter-spacing:0.1em;color:var(--accent);">ISK/M³ ↕</th>
              <th class="gas-th" data-col="venture" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ISK/VENTURE ↕</th>
            </tr>
          </thead>
          <tbody id="gasTableBody">
            <tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-3);
                font-family:var(--mono);font-size:12px;">⬡ Fetching Jita prices…</td></tr>
          </tbody>
        </table>
      </div>

      <div style="padding:8px 16px;border-top:1px solid var(--border);background:var(--bg-card);
                  font-size:10px;color:var(--text-3);font-family:var(--mono);flex-shrink:0;">
        Prices from Jita 4-4 CNAP (sell orders). Gas is sold raw — no refining or tax applies.
        ISK/Venture assumes a full ${VENTURE_HOLD_M3.toLocaleString()} m³ Venture gas hold.
      </div>
    </div>`;

  // Sortable headers
  document.querySelectorAll('#gasCalcWrap .gas-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_gasSort.col === col) _gasSort.dir *= -1;
      else { _gasSort.col = col; _gasSort.dir = -1; }
      buildGasTable();
    });
  });

  document.getElementById('gasRefreshBtn').addEventListener('click', () => loadGasPrices());

  await loadGasPrices();
}

async function loadGasPrices() {
  if (_gasLoading) return;
  _gasLoading = true;
  const refreshBtn = document.getElementById('gasRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const allIds = [...new Set(GAS_DATA.map(g => g.typeId))];
    const raw    = await window.eveAPI.getJitaPrices(allIds);
    _gasPrices   = raw || {};

    const ageEl = document.getElementById('gasPriceAge');
    if (ageEl) ageEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    buildGasTable();
  } catch (err) {
    logToConsole(`Gas prices fetch failed: ${err.message}`, 'error');
    const body = document.getElementById('gasTableBody');
    if (body) body.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;
      color:var(--danger);font-family:var(--mono);font-size:12px;">
      ⚠ Failed to fetch prices: ${escHtml(err.message)}</td></tr>`;
  } finally {
    _gasLoading = false;
    const btn = document.getElementById('gasRefreshBtn');
    if (btn) btn.disabled = false;
  }
}

function buildGasTable() {
  const body = document.getElementById('gasTableBody');
  if (!body) return;

  const rows = GAS_DATA.map(gas => {
    const p           = _gasPrices[gas.typeId];
    const iskPerUnit  = p?.sell > 0 ? p.sell : (p?.buy || 0);
    const iskPerM3    = gas.volume > 0 ? iskPerUnit / gas.volume : 0;
    const ventureUnits = Math.floor(VENTURE_HOLD_M3 / gas.volume);
    const iskVenture  = iskPerUnit * ventureUnits;
    return { gas, iskPerUnit, iskPerM3, iskVenture, ventureUnits };
  });

  // Sort
  const col = _gasSort.col;
  const dir = _gasSort.dir;
  rows.sort((a, b) => {
    if      (col === 'name')    return dir * a.gas.name.localeCompare(b.gas.name);
    else if (col === 'group')   return dir * a.gas.group.localeCompare(b.gas.group);
    else if (col === 'vol')     return dir * (a.gas.volume    - b.gas.volume);
    else if (col === 'iskUnit') return dir * (a.iskPerUnit    - b.iskPerUnit);
    else if (col === 'iskM3')   return dir * (a.iskPerM3      - b.iskPerM3);
    else if (col === 'venture') return dir * (a.iskVenture    - b.iskVenture);
    return dir * (a.iskPerM3 - b.iskPerM3);
  });

  const maxIskM3 = Math.max(...rows.map(r => r.iskPerM3), 1);

  const groupColors = {
    'Cytoserocin': '#e3a84d',
    'Mykoserocin': '#4ecbb0',
    'Fullerite':   '#ab7ab8',
    'Pochven':     '#c05c7e',
  };

  body.innerHTML = rows.map((r, i) => {
    const { gas, iskPerUnit, iskPerM3, iskVenture, ventureUnits } = r;
    const gc    = groupColors[gas.group] || 'var(--text-3)';
    const barW  = Math.round((iskPerM3 / maxIskM3) * 100);
    const isTop = i === 0;

    return `
      <tr style="border-bottom:1px solid var(--border);
                 background:${isTop ? 'rgba(255,255,255,0.03)' : 'transparent'};
                 ${isTop ? 'outline:1px solid var(--accent);' : ''}">
        <td style="padding:10px 14px;white-space:nowrap;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                       background:${gc};margin-right:6px;vertical-align:middle;"></span>
          <span style="font-family:var(--mono);font-size:10px;color:${gc};">${gas.group}</span>
        </td>
        <td style="padding:10px 8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="https://images.evetech.net/types/${gas.typeId}/icon?size=32"
                 onerror="this.onerror=null;this.style.display='none';"
                 style="width:24px;height:24px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">
            <span style="color:var(--text-1);font-weight:600;">${escHtml(gas.name)}</span>
          </div>
        </td>
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${gas.volume.toFixed(0)}
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${iskPerUnit > 0 ? formatNumber(iskPerUnit) : '—'}
        </td>
        <td style="padding:10px 14px;text-align:right;">
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <div style="width:60px;height:4px;background:var(--bg-card);border-radius:2px;overflow:hidden;flex-shrink:0;">
              <div style="height:100%;width:${barW}%;background:${isTop ? 'var(--accent)' : 'var(--text-3)'};border-radius:2px;"></div>
            </div>
            <span style="font-family:var(--mono);font-weight:700;
                         color:${isTop ? 'var(--accent)' : 'var(--text-1)'};">
              ${iskPerM3 > 0 ? formatNumber(iskPerM3) : '—'}
            </span>
          </div>
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                   color:${isTop ? 'var(--accent)' : 'var(--text-2)'};"
            title="${ventureUnits.toLocaleString()} units × ${formatNumber(iskPerUnit)} ISK">
          ${iskVenture > 0 ? formatNumber(iskVenture) : '—'}
        </td>
      </tr>`;
  }).join('');
}