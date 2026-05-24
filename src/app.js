// ─── app.js — Bootstrap & Init ────────────────────────────────────────────────
// This file wires everything together on DOMContentLoaded.
// All feature functions live in their respective split files:
//   state.js, utils.js, ui.js, characters.js, assets.js,
//   blueprints.js, materials.js, jabber.js, dashboard.js

window.addEventListener('DOMContentLoaded', async () => {
  // Hide any legacy setup screens
  const setupScreen = document.querySelector('.setup-container, #setup-screen, .client-id-gate');
  if (setupScreen) setupScreen.style.display = 'none';

  await loadAccounts();
  await loadBlueprintLibrary();
  buildCategoryBrowse();
  bindEvents();
  bindUISettings();
  bindNavigation();
  bindIndustrySubNav();

  // Auto-navigate: dashboard if characters exist, otherwise characters page
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (accounts && accounts.length > 0) {
    navigateToPage('dashboard');
  } else {
    navigateToPage('characters');
  }

  await autoConnectJabber();
  prefetchAssetsBackground();
});

// ─── Industry sub-nav binding ─────────────────────────────────────────────────
// Binds the left-hand sub-buttons inside the Industry page.
// Must run after DOMContentLoaded. Re-called by navigateToPage('industry').
function bindIndustrySubNav() {
  document.querySelectorAll('.industry-sub-btn').forEach(btn => {
    // Clone node to clear out any old event listeners and prevent duplicates
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', () => {
      const tab = newBtn.dataset.industryTab;
      if (tab) navigateIndustryTab(tab);
    });
  });
}

// ─── navigateIndustryTab ──────────────────────────────────────────────────────
// Handles switching the visible pane and firing the appropriate data fetch
function navigateIndustryTab(tab) {
  // 1. Visually update the active button state
  document.querySelectorAll('.industry-sub-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.querySelector(`.industry-sub-btn[data-industry-tab="${tab}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  // 2. Hide all industry tab content areas
  document.querySelectorAll('.industry-tab-content').forEach(content => {
    content.style.display = 'none';
  });

  // 3. Show the newly selected tab content
  const targetContent = document.getElementById(`industryTab-${tab}`);
  if (targetContent) {
    targetContent.style.display = 'block'; 
  }

  // 4. Trigger specific data load logic based on the selected tab
  if (tab === 'blueprints') {
    if (typeof loadBlueprintLibrary === 'function') loadBlueprintLibrary();
  } else if (tab === 'pi') {
    // Execute the new Planetary Interaction module!
    if (typeof loadPlanetaryInteraction === 'function') loadPlanetaryInteraction();
  } else if (tab === 'jobs') {
    // Placeholder for jobs
  }
}

// ─── closePage ────────────────────────────────────────────────────────────────
// Called by the ✕ close buttons on each page (inline onclick in HTML).
function closePage(page) {
  currentPage = null;
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

  // Navigate somewhere sensible instead of revealing raw library.
  // Always fall back to 'characters' — avoids a loop when there are no
  // accounts and the user is already on the characters page.
  window.eveAPI.getAccounts().catch(() => []).then(accounts => {
    navigateToPage(accounts && accounts.length > 0 ? 'dashboard' : 'characters');
  });
}

// ─── syncME / syncTE ─────────────────────────────────────────────────────────
// Called from inline oninput on the sliders in the sidebar.
function syncME(value) {
  selectedME = Number(value);
  const display = document.getElementById('meDisplay');
  if (display) display.textContent = value;
}

function syncTE(value) {
  selectedTE = Number(value);
  const display = document.getElementById('teDisplay');
  if (display) display.textContent = value;
}

// ─── calculate ────────────────────────────────────────────────────────────────
// Called from inline onclick on the CALCULATE button in the sidebar.
async function calculate() {
  if (!selectedBpTypeId) {
    showToast('Select a blueprint first.', 'error');
    return;
  }
  showToast('Calculating materials...', 'info');
  await openMaterialsInTab(selectedBpTypeId);
}

// ─── bindEvents ────────────────────────────────────────────────────────
// Called from DOMContentLoaded to wire up all event listeners on the page, including
// character search, add character button, sync assets button, manual blueprint search,
// and account-added event from the main process. Also calls bindJabberEvents to wire
// up Jabber-specific listeners.

function bindEvents() {
  // Wire character search
  const charSearch = document.getElementById('charSearch');
  if (charSearch) charSearch.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#accountsListNav .character-card').forEach(card => {
      card.style.display = card.querySelector('.character-card-name')
        ?.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // Add character button
  const addBtn = document.getElementById('addCharacterNavBtn');
  if (addBtn) addBtn.addEventListener('click', () => window.eveAPI.startSSOLogin());

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) {
      const dd = document.getElementById('searchDropdown');
      if (dd) dd.style.display = 'none';
    }
  });

  // account-added event from main process
  window.eveAPI.on('account-added', () => {
    loadAccounts();
    loadBlueprintLibrary();
  });

  // Jabber events
  bindJabberEvents();
}