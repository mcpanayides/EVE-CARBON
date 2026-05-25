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

  // Auto-open "My Blueprints" whenever the industry page is entered so
  // #industryTabContent is never a blank placeholder.
  // Guard: only fire if the content area is actually empty (first entry or
  // after a page close/reopen) to avoid clobbering an already-open tab.
  const content = document.getElementById('industryTabContent');
  if (content && !content.hasChildNodes()) {
    navigateIndustryTab('blueprints');
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
// Called from inline oninput on sliders (e.g. inside the full calculator tab).
// The sidebar sliders have been removed; these are now only used by
// calculator-tab controls injected dynamically by navigateIndustryTab().
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
// Called from the CALCULATE button inside the full calculator tab.
// The "My Blueprints" View button uses openBlueprintDetail() directly instead.
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