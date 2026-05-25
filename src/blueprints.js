// ─── Blueprint Library ────────────────────────────────────────────────────────
// Reads blueprint data from character_information.db (SQLite) via the
// 'get-all-blueprints-from-db' IPC handler.
// The View button queries SDE materials and applies the blueprint's real ME/TE.

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
    selectedBpTypeId = bp.type_id;
    selectedME = bp.me;
    selectedTE = bp.te;
    showToast('Opening full calculator…', 'info');
    await openMaterialsInTab(bp.type_id);
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
  } else {
    const labels = {
      'active-jobs': 'Active Jobs', 'calculator': 'Blueprint Calculator',
      'cost-index': 'Cost Index', 'shopping-lists': 'Shopping Lists',
      'invention': 'Invention Buddy', 'reactions': 'Reactions Profit',
      'ore': 'Ore Calculator', 'ice': 'Ice Calculator',
      'gas': 'Gas Calculator', 'moon': 'Moon Scanning Reformatter',
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