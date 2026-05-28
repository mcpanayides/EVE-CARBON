// ─── Blueprint Library ────────────────────────────────────────────────────────
// Reads blueprint data from character_information.db (SQLite) via the
// 'get-all-blueprints-from-db' IPC handler.
// The View button queries SDE materials and applies the blueprint's real ME/TE.

// NOTE: allLibBPs, filterPerfectOnly, searchTimer, manualSearchTimer,
// currentIndustryTab, selectedBpTypeId, selectedME, selectedTE, and ESI_IMAGE
// are all declared in state.js which loads before this file. Do not re-declare them here.

// ─── Load & filter ────────────────────────────────────────────────────────────

async function loadBlueprintLibrary() {
  try {
    // Pull from the SQLite character_information.db across ALL synced characters.
    // Falls back to the legacy blueprints.json if the new handler isn't registered yet.
    let bps = [];
    try {
      bps = await window.eveAPI.getAllBlueprintsFromDb();
    } catch (_) {
      // Graceful fallback to the old JSON-backed handler
      bps = await window.eveAPI.getAllBlueprints();
    }

    allLibBPs = Array.isArray(bps) ? bps : [];
    allLibBPs.sort((a, b) => (a.type_name || a.name || '').localeCompare(b.type_name || b.name || ''));

    // Normalise field names — the DB stores type_name; the old JSON stored name
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
  }
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

  // ── Render materials table ───────────────────────────────────────────────────
  const { materials, productTypeId, productName, productQty, runs } = sdeResult;

  const productImg = productTypeId
    ? `<img src="${ESI_IMAGE}/${productTypeId}/icon?size=32"
            onerror="this.src='${ESI_IMAGE}/0/icon?size=32';"
            style="width:24px;height:24px;vertical-align:middle;margin-right:6px;border-radius:2px;">`
    : '';

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

    <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;margin-bottom:10px;">
      MATERIALS — 1 RUN · ME${bp.me}
      <span style="color:var(--text-3);font-size:9px;margin-left:8px;">
        (quantities rounded up per EVE rules)
      </span>
    </div>

    <div id="bpMatTable" style="display:flex;flex-direction:column;gap:4px;">
      ${materials.map(mat => renderMaterialRow(mat)).join('')}
    </div>

    <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);
                display:flex;gap:8px;flex-wrap:wrap;">
      <button id="bpCalcBtn" class="bp-view-btn" type="button"
              style="padding:6px 16px;font-size:11px;">
        ◈ OPEN FULL CALCULATOR
      </button>
      <button id="bpTreeBtn" class="bp-view-btn" type="button"
              style="padding:6px 16px;font-size:11px;background:var(--bg-hover);">
        ⬡ SHOW COMPONENT TREE
      </button>
    </div>
    <div id="bpComponentTree" style="display:none;margin-top:16px;"></div>`;

  // Full calculator button
  document.getElementById('bpCalcBtn')?.addEventListener('click', async () => {
    if (typeof selectedBpTypeId !== 'undefined') selectedBpTypeId = bp.type_id;
    if (typeof selectedME      !== 'undefined') selectedME       = bp.me;
    if (typeof selectedTE      !== 'undefined') selectedTE       = bp.te;
    showToast('Opening full calculator…', 'info');
    if (typeof openMaterialsInTab === 'function') {
      await openMaterialsInTab(bp.type_id);
    } else {
      navigateIndustryTab('calculator');
    }
  });

  // Component tree toggle
  document.getElementById('bpTreeBtn')?.addEventListener('click', async () => {
    const treeDiv = document.getElementById('bpComponentTree');
    if (!treeDiv) return;
    if (treeDiv.style.display !== 'none') {
      treeDiv.style.display = 'none';
      return;
    }
    treeDiv.innerHTML = `<div style="font-family:var(--mono);font-size:11px;color:var(--text-3);">
      Building component tree…</div>`;
    treeDiv.style.display = 'block';
    try {
      const tree = await buildRecursiveMaterialTree(bp.type_id, 1);
      treeDiv.innerHTML = `
        <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                    letter-spacing:0.1em;margin-bottom:8px;">FULL MANUFACTURING CHAIN</div>
        ${generateTreeHTML(tree)}`;
    } catch (e) {
      treeDiv.innerHTML = `<div style="font-family:var(--mono);font-size:11px;color:var(--accent);">
        Component tree unavailable: ${escHtml(e.message)}</div>`;
    }
  });
}

// Renders a single material row with EVE icon + name + adjusted quantity
function renderMaterialRow(mat) {
  const isComponent = mat.isComponent;   // true = sub-component that can itself be manufactured
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
      <span style="font-family:var(--mono);color:var(--text-2);font-size:12px;flex-shrink:0;">
        ×${mat.adjustedQty.toLocaleString()}
      </span>
      ${mat.baseQty !== mat.adjustedQty
        ? `<span style="font-family:var(--mono);color:var(--text-3);font-size:10px;text-decoration:line-through;flex-shrink:0;">
             ${mat.baseQty.toLocaleString()}
           </span>`
        : ''}
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

// ─── Recursive component tree (unchanged; uses Fuzzwork) ─────────────────────

async function getCachedBlueprintMaterials(typeId) {
  const key    = `bp_materials_${typeId}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  const data = await window.eveAPI.getBlueprintMaterials(typeId);
  await cacheSet(key, data, 7);
  return data;
}

async function buildRecursiveMaterialTree(blueprintTypeId, quantityRequired = 1) {
  const data = await getCachedBlueprintMaterials(blueprintTypeId);
  if (!data)                   throw new Error(`No data returned for blueprint type ID ${blueprintTypeId}`);
  if (!data.materials?.length) return [];

  const components = [];
  for (const mat of data.materials) {
    const totalQty = mat.quantity * quantityRequired;
    let subTree = null;
    try {
      const subBpData = await window.eveAPI.findBpForProduct(mat.typeid);
      if (subBpData?.[mat.typeid]?.blueprintDetails) {
        const nextBpId = subBpData[mat.typeid].blueprintDetails.blueprintTypeID;
        subTree = await buildRecursiveMaterialTree(nextBpId, totalQty);
      }
    } catch (e) { /* raw material — no sub-blueprint */ }
    components.push({ typeid: mat.typeid, name: mat.name, quantity: totalQty, subTree });
  }
  return components;
}

function generateTreeHTML(treeNodes) {
  if (!treeNodes?.length) return '';
  return `
    <ul style="list-style:none;padding-left:20px;border-left:1px dashed var(--border);margin-top:8px;">
      ${treeNodes.map(node => {
        const isComponent = node.subTree !== null;
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
    renderBlueprintList(allLibBPs);

  } else if (tab === 'search') {
    right.innerHTML = `
      <div style="padding:20px;">
        <div style="font-family:var(--mono);font-size:11px;color:var(--text-3);margin-bottom:12px;">BLUEPRINT SEARCH</div>
        <div style="position:relative;">
          <input id="bpName" class="field-input" placeholder="Search for any item..." style="width:100%;box-sizing:border-box;"/>
          <div id="searchDropdown" class="dropdown" style="display:none;"></div>
        </div>
        <div id="results" style="margin-top:16px;"></div>
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

  } else {
    const labels = {
      'active-jobs': 'Active Jobs', 'calculator': 'Blueprint Calculator',
      'shopping-lists': 'Shopping Lists',
      'invention': 'Invention Buddy', 'reactions': 'Reactions Profit',
      'moon': 'Moon Scanning Reformatter',
    };
    right.innerHTML = `
      <div class="empty-state" style="margin-top:80px;">
        <div class="empty-icon">◈</div>
        <div class="empty-title">${escHtml(labels[tab] || tab).toUpperCase()}</div>
        <div class="empty-sub">Coming soon.</div>
      </div>`;
  }
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