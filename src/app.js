// ─── State ────────────────────────────────────────────────────────────────────
let selectedBpTypeId = null;
let selectedBpName   = null;
let selectedME       = 3;
let selectedTE       = 2;
let currentResults   = null;
let allLibBPs        = [];
let searchTimer      = null;
let currentSort = 'name'; // Default sort

const ESI_IMAGE = 'https://images.evetech.net/types';

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // BYPASS SETUP SCREEN
  const setupScreen = document.querySelector('.setup-container, #setup-screen, .client-id-gate'); 
  if (setupScreen) {
    setupScreen.style.display = 'none';
  }

  await loadAccounts();
  await loadBlueprintLibrary();
  buildCategoryBrowse();
  bindEvents();

  // Listen for account-added from main process
  window.eveAPI.on('account-added', async ({ characterId, characterName }) => {
    showToast(`✓ ${characterName} added!`, 'success');
    await loadAccounts();
  });
  window.eveAPI.on('auth-error', (msg) => showToast(`Auth failed: ${msg}`, 'error'));
});

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('results').innerHTML = `<div class="empty-state">
    <div class="empty-icon" style="color:var(--danger)">⚠</div>
    <div class="empty-title">Error</div>
    <div class="empty-sub">${escHtml(msg)}</div>
  </div>`;
}

function scrollToResults() {
  document.querySelector('.main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:4px;
    font-family:var(--mono);font-size:12px;z-index:9999;border:1px solid;
    background:var(--bg-card);
    color:${type==='success'?'var(--success)':type==='error'?'var(--danger)':'var(--accent)'};
    border-color:${type==='success'?'var(--success)':type==='error'?'var(--danger)':'var(--accent)'};`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function openExternal(url) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.click();
}

// ─── Event Binding ────────────────────────────────────────────────────────────
function bindEvents() {
  const addAccountBtn = document.querySelector('.accounts-header .btn, #add-account-btn, .add-btn');
  if (addAccountBtn) {
    addAccountBtn.addEventListener('click', async () => {
      try {
        showToast('Opening EVE SSO Login...', 'info');
        await window.eveAPI.startSSOLogin(); 
      } catch (err) {
        showToast(`Failed to start login: ${err.message}`, 'error');
      }
    });
  }
  // Sort Filter Dropdown
  const libSort = document.getElementById('bpLibSort');
  if (libSort) {
    libSort.addEventListener('change', () => handleLibraryFilter());
  }
  // Wire up Library Search & Advanced Filters
  const libInputs = [
    document.getElementById('bpLibSearch'),
    document.getElementById('bpLibMinME'),
    document.getElementById('bpLibMinTE'),
    document.getElementById('bpLibMinRuns')
  ];

  libInputs.forEach(input => {
    if (input) input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => handleLibraryFilter(), 300);
    });
  });
  
  const libFilter = document.getElementById('bpLibFilter');
  if (libFilter) {
    libFilter.addEventListener('change', () => handleLibraryFilter());
  }
}

// ─── Accounts Management ──────────────────────────────────────────────────────
async function loadAccounts() {
  try {
    const accounts = await window.eveAPI.getAccounts();
    const listDiv = document.getElementById('accountsList');

    if (!listDiv) return;
    listDiv.innerHTML = ''; 

    if (!accounts || accounts.length === 0) {
      listDiv.innerHTML = '<div class="accounts-empty">No characters added yet.<br/>Click + to log in with EVE SSO.</div>';
      return;
    }

    // Draw the accounts
    accounts.forEach(acc => {
      const accEl = document.createElement('div');
      accEl.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px; background:var(--bg-card); margin-bottom:4px; border-radius:4px; border:1px solid var(--border);';
      
      accEl.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px;">
          <img src="https://images.evetech.net/characters/${acc.characterId}/portrait?size=32" 
               alt="portrait" 
               style="border-radius:50%; width:24px; height:24px; border:1px solid var(--accent);">
          <span style="font-family:var(--mono); font-size:12px; color:var(--text-main);">${escHtml(acc.characterName)}</span>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="sync-btn" data-id="${acc.characterId}" style="background:var(--accent); color:#000; border:none; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px;">SYNC BPs</button>
          <button class="remove-btn" data-id="${acc.characterId}" style="background:transparent; border:none; color:var(--danger); cursor:pointer;" title="Remove Account">✕</button>
        </div>
      `;
      listDiv.appendChild(accEl);
    });

    // Wire up dynamic buttons (Remove)
    listDiv.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
         const id = e.currentTarget.getAttribute('data-id'); 
         await window.eveAPI.removeAccount(id);
         showToast('Account removed.', 'info');
         loadAccounts(); 
         loadBlueprintLibrary(); // Refresh library when account removed
      });
    });

    // Wire up dynamic buttons (Sync)
    listDiv.querySelectorAll('.sync-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
         const id = e.currentTarget.getAttribute('data-id');
         const originalText = e.currentTarget.textContent;
         e.currentTarget.textContent = 'SYNCING...';
         e.currentTarget.disabled = true;
         
         try {
           showToast('Downloading blueprints from ESI...', 'info');
           const result = await window.eveAPI.syncBlueprints(id);
           showToast(`✓ Synced ${result.count} blueprints!`, 'success');
           // Instantly draw the new blueprints!
           await loadBlueprintLibrary(); 
         } catch (err) {
           showToast(`Sync failed: ${err.message}`, 'error');
         } finally {
           e.currentTarget.textContent = originalText;
           e.currentTarget.disabled = false;
         }
      });
    });

  } catch (err) {
    console.error("Failed to load accounts:", err);
    showToast("Error loading saved accounts.", "error");
  }
}

// ─── Blueprint Library ────────────────────────────────────────────────────────
async function loadBlueprintLibrary() {
  try {
    allLibBPs = await window.eveAPI.getAllBlueprints();
    allLibBPs.sort((a, b) => a.name.localeCompare(b.name));
    renderBlueprintList(allLibBPs);
  } catch (err) {
    console.error("Failed to load library", err);
    showToast("Error loading blueprints from database.", "error");
  }
}

// ─── Filter Logic ─────────────────────────────────────────────────────────────
function handleLibraryFilter() {
  // 1. Get the UI values first
  const query = (document.getElementById('bpLibSearch')?.value || '').toLowerCase();
  const filterMode = document.getElementById('bpLibFilter')?.value || 'all';
  const sortBy = document.getElementById('bpLibSort')?.value || 'name'; // Correctly fetch sort value
  
  // Grab the advanced filter values
  const minME = parseInt(document.getElementById('bpLibMinME')?.value) || 0;
  const minTE = parseInt(document.getElementById('bpLibMinTE')?.value) || 0;
  const minRuns = parseInt(document.getElementById('bpLibMinRuns')?.value) || 0;

  // 2. Perform the filtering
  const filtered = allLibBPs.filter(bp => {
    const matchesName = bp.name.toLowerCase().includes(query);
    const matchesType = filterMode === 'all' || 
                       (filterMode === 'bpo' && !bp.isBPC) || 
                       (filterMode === 'bpc' && bp.isBPC);
    
    const matchesME = bp.me >= minME;
    const matchesTE = bp.te >= minTE;
    const matchesRuns = (!bp.isBPC) || (bp.runs >= minRuns);

    return matchesName && matchesType && matchesME && matchesTE && matchesRuns;
  });

  // 3. Perform the sort
  const sorted = sortBlueprints(filtered, sortBy);
  
  // 4. Update the UI
  renderBlueprintList(sorted);
}

// ─── Sort Helper (Must be outside the filter function) ─────────────────────────
function sortBlueprints(bps, criteria) {
  // We use [...bps] to create a copy so we don't mutate the original array
  return [...bps].sort((a, b) => {
    if (criteria === 'me') return b.me - a.me;
    if (criteria === 'te') return b.te - a.te;
    if (criteria === 'runs') return (b.runs || 0) - (a.runs || 0);
    return a.name.localeCompare(b.name); // Default: Name
  });
}
// ─── Render Library ───────────────────────────────────────────────────────────
function renderBlueprintList(bps) {
  const listDiv = document.getElementById('bpLibList');
  const countSpan = document.getElementById('bpLibCount');
  
  if (!listDiv) return;
  if (countSpan) countSpan.textContent = bps.length;

  listDiv.innerHTML = '';

  if (bps.length === 0) {
    listDiv.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1; margin-top: 40px;">
      <div class="empty-icon">⬡</div>
      <div class="empty-title">NO BLUEPRINTS FOUND</div>
      <div class="empty-sub">Sync a character or adjust your advanced filter settings.</div>
    </div>`;
    return;
  }

  bps.forEach(bp => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex; gap:15px; padding:15px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; cursor:pointer; align-items:center; transition:all 0.2s ease; box-shadow: 0 4px 6px rgba(0,0,0,0.3);';
    
    item.onmouseenter = () => {
      item.style.background = '#111724';
      item.style.borderColor = 'var(--accent)';
      item.style.transform = 'translateY(-2px)';
    };
    item.onmouseleave = () => {
      item.style.background = 'var(--bg-card)';
      item.style.borderColor = 'var(--border)';
      item.style.transform = 'translateY(0)';
    };

    const mePct = Math.min(100, Math.max(0, (bp.me / 10) * 100));
    const tePct = Math.min(100, Math.max(0, (bp.te / 20) * 100));

    // CONSTANT BLUE & GREEN COLORS (Added an extra neon glow if they hit max!)
    const meColor = bp.me === 10 ? '#51e923' : '#77c99c'; // Green
    const teColor = bp.te === 20 ? '#00e5ff' : '#46b8c5'; // Blue

    // --- STANDARDIZED BADGE STYLE ---
    const badgeStyle = "display:inline-block; min-width:65px; text-align:center; padding:2px 8px; border-radius:3px; font-size:10px; font-weight:bold; flex-shrink:0;";
    
    const typeBadge = bp.isBPC 
      ? `<span style="${badgeStyle} background:#1b2a40; color:#4ada8a;">${bp.runs} RUNS</span>`
      : `<span style="${badgeStyle} background:#1b2a40; color:#ab7ab8;">BPO</span>`;

    item.innerHTML = `
      <img src="https://images.evetech.net/types/${bp.type_id}/bp?size=64" 
           loading="lazy"
           onerror="this.src='https://images.evetech.net/types/9/bp?size=64';"
           style="width:40px; height:40px; border-radius:4px; border:1px solid #2a3a50; background:var(--bg-card);" 
           alt="bp-icon">
      
      <div style="flex:1; min-width:0;">
        <div style="font-size:13px; font-weight:bold; color:var(--text-main); margin-bottom:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escHtml(bp.name)}</div>
        <div style="display:flex; gap:6px; font-family:var(--mono); font-size:10px; align-items:center;">
          
          <div style="display:flex; align-items:center; background:#1b2a40; padding:2px 6px; border-radius:3px; gap:4px;">
            <span style="color:${meColor}; min-width:28px;">ME ${bp.me}</span>
            <div style="width:30px; height:4px; background:rgba(0,0,0,0.4); border-radius:2px; overflow:hidden;">
              <div style="width:${mePct}%; height:100%; background:${meColor};"></div>
            </div>
          </div>

          <div style="display:flex; align-items:center; background:#1b2a40; padding:2px 6px; border-radius:3px; gap:4px;">
            <span style="color:${teColor}; min-width:28px;">TE ${bp.te}</span>
            <div style="width:30px; height:4px; background:rgba(0,0,0,0.4); border-radius:2px; overflow:hidden;">
              <div style="width:${tePct}%; height:100%; background:${teColor};"></div>
            </div>
          </div>

          ${typeBadge}
        </div>
      </div>
      <img src="https://images.evetech.net/characters/${bp.characterId}/portrait?size=32" 
           loading="lazy"
           title="Owned by ${escHtml(bp.characterName)}" 
           style="width:24px; height:24px; border-radius:50%; border:1px solid var(--border); opacity: 0.6;">
    `;
    
    item.onclick = () => loadBpDetails(bp); 
    
    listDiv.appendChild(item);
  });
}

// ─── Blueprint Details Engine ────────────────────────────────────────────────
async function loadBpDetails(bp) {
  showToast(`Loading materials for ${bp.name}...`, 'info');
  
  // 1. Fetch from Fuzzwork (via your main.js IPC)
  const data = await window.eveAPI.getBlueprintMaterials(bp.type_id);
  
  if (!data) {
    showToast("Could not fetch materials.", "error");
    return;
  }

  // 2. Clear library view and show the results area
  document.getElementById('mainLibraryView').style.display = 'none';
  const resArea = document.getElementById('results');
  resArea.style.display = 'block';
  
  // 3. Render the Materials (using a simple template for now)
  resArea.innerHTML = `
    <div class="panel" style="padding:20px;">
      <button onclick="backToLibrary()" style="margin-bottom:10px;">← Back to Library</button>
      <h2>${bp.name}</h2>
      <p>Materials for 1 run (ME ${bp.me}):</p>
      <ul style="list-style:none;">
        ${data.materials.map(m => `<li>${m.name} x ${m.quantity}</li>`).join('')}
      </ul>
    </div>
  `;
}

function backToLibrary() {
  document.getElementById('mainLibraryView').style.display = 'flex';
  document.getElementById('results').style.display = 'none';
}

// ─── Placeholder Functions (To prevent crashes) ───────────────────────────────
function buildCategoryBrowse() { console.log("Category build stub"); }
function handleBlueprintSearch(query) { console.log("Search stub:", query); }