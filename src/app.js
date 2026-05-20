// ─── State ────────────────────────────────────────────────────────────────────
let selectedBpTypeId = null;
let selectedBpName   = null;
let selectedME       = 3;
let selectedTE       = 2;
let currentResults   = null;
let allLibBPs        = [];
let searchTimer      = null;

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
  // 1. Wire up the "Add Account" (+) button
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

  // 2. Wire up Manual Blueprint Search
  const libSearch = document.getElementById('bpLibSearch');
  const libFilter = document.getElementById('bpLibFilter');

  if (libSearch) {
    libSearch.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => handleLibraryFilter(), 300);
    });
  }
  
  if (libFilter) {
    libFilter.addEventListener('change', () => handleLibraryFilter());
  }
} // <--- THIS BRACKET WAS MISSING, WHICH CRASHED THE APP!

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

function handleLibraryFilter() {
  const query = (document.getElementById('bpLibSearch')?.value || '').toLowerCase();
  const filterMode = document.getElementById('bpLibFilter')?.value || 'all';

  const filtered = allLibBPs.filter(bp => {
    const matchesName = bp.name.toLowerCase().includes(query);
    const matchesType = filterMode === 'all' || 
                       (filterMode === 'bpo' && !bp.isBPC) || 
                       (filterMode === 'bpc' && bp.isBPC);
    return matchesName && matchesType;
  });

  renderBlueprintList(filtered);
}

function renderBlueprintList(bps) {
  const listDiv = document.getElementById('bpLibList');
  const countSpan = document.getElementById('bpLibCount');
  
  if (!listDiv) return;

  // Update the counter
  if (countSpan) countSpan.textContent = bps.length;

  listDiv.innerHTML = '';

  if (bps.length === 0) {
    listDiv.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1; margin-top: 40px;">
      <div class="empty-icon">⬡</div>
      <div class="empty-title">NO BLUEPRINTS FOUND</div>
      <div class="empty-sub">Sync a character or change your filter settings.</div>
    </div>`;
    return;
  }

  // Draw each blueprint card
  bps.forEach(bp => {
    const item = document.createElement('div');
    // Upgraded Grid Card Styling
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

    // --- NEW PROGRESS BAR LOGIC ---
    // Calculate percentages (Max ME is 10, Max TE is 20)
    const mePct = Math.min(100, Math.max(0, (bp.me / 10) * 100));
    const tePct = Math.min(100, Math.max(0, (bp.te / 20) * 100));

    // Pop the colors to neon if they are fully researched, otherwise keep them muted
    const meColor = bp.me === 10 ? 'var(--success)' : '#6888a8';
    const teColor = bp.te === 20 ? 'var(--accent)' : '#6888a8';

    const typeBadge = bp.isBPC 
      ? `<span style="background:#1b2a40; color:#4ada8a; padding:2px 6px; border-radius:3px; font-size:10px; font-weight:bold;">${bp.runs} RUNS</span>`
      : `<span style="background:#1b2a40; color:#ab7ab8; padding:2px 6px; border-radius:3px; font-size:10px; font-weight:bold;">BPO</span>`;

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
    
    item.onclick = () => console.log(`Selected ${bp.name}`); 
    
    listDiv.appendChild(item);
  });
}

// ─── Placeholder Functions (To prevent crashes) ───────────────────────────────
function buildCategoryBrowse() { console.log("Category build stub"); }
function handleBlueprintSearch(query) { console.log("Search stub:", query); }