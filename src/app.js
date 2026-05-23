// ─── app.js — Bootstrap & Init ────────────────────────────────────────────────
// This file wires everything together on DOMContentLoaded.
// All feature functions live in their respective split files:
//   state.js, utils.js, ui.js, characters.js, assets.js,
//   blueprints.js, materials.js, jabber.js, dashboard.js

window.addEventListener('DOMContentLoaded', async () => {
  // Hide any legacy setup screens
  const setupScreen = document.querySelector('.setup-container, #setup-screen, .client-id-gate');
  if (setupScreen) setupScreen.style.display = 'none';

  await loadUITheme();
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
    btn.addEventListener('click', () => {
      const tab = btn.dataset.industryTab;
      if (tab) navigateIndustryTab(tab);
    });
  });
}

// ─── closePage ────────────────────────────────────────────────────────────────
// Called by the ✕ close buttons on each page (inline onclick in HTML).
function closePage(page) {
  currentPage = null;
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

  // Navigate somewhere sensible instead of revealing raw library
  window.eveAPI.getAccounts().catch(() => []).then(accounts => {
    if (accounts && accounts.length > 0) {
      navigateToPage('dashboard');
    } else {
      navigateToPage('characters');
    }
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

  // Sync assets button
  const syncBtn = document.getElementById('syncAssetsBtn');
  if (syncBtn) syncBtn.addEventListener('click', syncAllAssets);

  // Manual blueprint search
  const bpInput = document.getElementById('bpName');
  if (bpInput) {
    bpInput.addEventListener('input', () => {
      clearTimeout(manualSearchTimer);
      manualSearchTimer = setTimeout(handleManualSearchInput, 250);
    });
    bpInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.querySelector('#searchDropdown .dropdown-item')?.click();
      }
    });
  }

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

// ─── bindLibraryEvents ────────────────────────────────────────────────────────
// Called by blueprints.js navigateIndustryTab when injecting the blueprints tab UI.
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
