// ─── Blueprint Library ────────────────────────────────────────────────────────

async function loadBlueprintLibrary() {
  try {
    allLibBPs = await window.eveAPI.getAllBlueprints();
    allLibBPs.sort((a, b) => a.name.localeCompare(b.name));
    renderBlueprintList(allLibBPs);
  } catch (err) {
    console.error('Failed to load library', err);
    showToast('Error loading blueprints from database.', 'error');
  }
}

function handleLibraryFilter() {
  const query      = (document.getElementById('bpLibSearch')?.value || '').toLowerCase();
  const filterMode = document.getElementById('bpLibFilter')?.value  || 'all';
  const sortBy     = document.getElementById('bpLibSort')?.value    || 'name';
  const minME      = parseInt(document.getElementById('bpLibMinME')?.value)    || 0;
  const minTE      = parseInt(document.getElementById('bpLibMinTE')?.value)    || 0;
  const minRuns    = parseInt(document.getElementById('bpLibMinRuns')?.value)  || 0;

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
    const item    = document.createElement('div');
    item.className = 'bp-lib-item';

    const mePct = Math.min(100, Math.max(0, (bp.me / 10)  * 100));
    const tePct = Math.min(100, Math.max(0, (bp.te / 20)  * 100));

    const isTech2   = /\b(?:tech\s*ii|tech\s*2|t2|mk\s*ii|mark\s*ii|\bII\b)\b/i.test(bp.name);
    const isFaction = /\b(?:faction|navy|pirate|guristas|serpentis|angel cartel|blood raiders|sansha|angel|mordu|sisters|drifter|triglavian)\b/i.test(bp.name);

    const dots = [];
    if (bp.me === 10 && bp.te === 20) dots.push('<span class="card-perfect-dot" title="Perfect BP"></span>');
    if (isTech2)   dots.push('<span class="card-tier-dot tech2"   title="Tech II Blueprint"></span>');
    if (isFaction) dots.push('<span class="card-tier-dot faction" title="Faction Blueprint"></span>');

    const badgeStyle = 'display:inline-block;min-width:65px;text-align:center;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:bold;flex-shrink:0;';
    const typeBadge  = bp.isBPC
      ? `<span style="${badgeStyle}background:#1b2a40;color:#4ada8a;">${bp.runs} RUNS</span>`
      : `<span style="${badgeStyle}background:#1b2a40;color:#ab7ab8;">BPO</span>`;

    item.innerHTML = `
      <img class="bp-lib-thumb"
           src="${ESI_IMAGE}/${bp.type_id}/bp?size=32"
           onerror="this.onerror=null;this.src='${ESI_IMAGE}/${bp.type_id}/icon?size=32';"
           alt="bp-icon">
      <div class="bp-lib-content">
        <div class="bp-lib-title">${escHtml(bp.name)}</div>
        <div class="bp-stats-vert">
          <div class="bp-stat">
            <div class="bp-stat-label">ME</div>
            <div class="bp-stat-track"><div class="bp-stat-fill me" style="width:${mePct}%"></div></div>
          </div>
          <div class="bp-stat">
            <div class="bp-stat-label">TE</div>
            <div class="bp-stat-track"><div class="bp-stat-fill te" style="width:${tePct}%"></div></div>
          </div>
        </div>
      </div>
      <div class="bp-lib-right">
        <img class="bp-lib-portrait"
             src="https://images.evetech.net/characters/${bp.characterId}/portrait?size=64"
             loading="lazy" title="Owned by ${escHtml(bp.characterName)}" alt="owner portrait">
        <button class="bp-view-btn" type="button">View</button>
      </div>
      <div class="card-indicator-row">${dots.join('')}</div>`;

    item.querySelector('.bp-view-btn').addEventListener('click', async (event) => {
      event.stopPropagation();
      showToast('Calculating materials...', 'info');
      await openMaterialsInTab(bp.type_id);
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

// ─── Blueprint Detail / Tree ──────────────────────────────────────────────────

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
  if (!data)                              throw new Error(`No data returned for blueprint type ID ${blueprintTypeId}`);
  if (!data.materials?.length)            return [];

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
              <span style="font-family:var(--mono);color:var(--text-2);">x ${node.quantity.toLocaleString()}</span>
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
  // Bind left-hand sub-nav buttons every time the industry page is opened
  document.querySelectorAll('.industry-sub-btn').forEach(btn => {
    // Remove any previous listener to avoid duplicates
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
      <div style="display:flex;flex-direction:column;height:100%;">
        <div class="bp-filter-row" style="padding:12px 16px;border-bottom:1px solid var(--border);
             display:flex;flex-wrap:wrap;gap:10px;background:var(--bg-card);align-items:center;">
          <input id="bpLibSearch"  class="field-input" style="flex:1;min-width:180px;"  placeholder="Search your blueprint library..."/>
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
      <div id="results" style="display:none;"></div>`;
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