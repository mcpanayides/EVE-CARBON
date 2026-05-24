// ─── Settings Drawer ──────────────────────────────────────────────────────────

function setSettingsTab(tab) {
  currentSettingsTab = tab;
  document.querySelectorAll('.settings-menu-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.settingsTab === tab);
  });
  document.querySelectorAll('.settings-tab').forEach(panel => {
    const target = `settingsTab${tab.charAt(0).toUpperCase() + tab.slice(1)}`;
    panel.style.display = panel.id === target ? 'block' : 'none';
  });
}

function bindUISettings() {
  const openBtn  = document.getElementById('openSettingsBtn');
  const drawer   = document.getElementById('uiSettingsDrawer');
  const saveBtn  = document.getElementById('saveSettingsBtn');
  const closeBtn = document.getElementById('closeSettingsBtn');

  if (openBtn) {
    openBtn.addEventListener('click', async () => {
      if (drawer) {
        drawer.style.display = 'flex';
        await populateSettingsInputs();
        setSettingsTab(currentSettingsTab);
      }
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', () => { if (drawer) drawer.style.display = 'none'; });
  }
  drawer?.addEventListener('click', e => { if (e.target === drawer) drawer.style.display = 'none'; });
  document.querySelectorAll('.settings-menu-btn').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.settingsTab) setSettingsTab(btn.dataset.settingsTab); });
  });
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      await saveAllSettings();
      if (drawer) drawer.style.display = 'none';
      showToast('Settings saved.', 'success');
    });
  }
}

async function populateSettingsInputs() {
  await populateJabberSettings();
}

async function saveAllSettings() {
  const jabber = gatherJabberSettings();
  await window.eveAPI.saveAppConfig({ jabber });
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function bindNavigation() {
  const toggleBtn = document.getElementById('navToggleBtn');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleNavigation);

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateToPage(btn.dataset.page));
  });

  const industryMenuBtn = document.getElementById('industryMenuBtn');
  const industryMenu    = document.getElementById('industryMenu');
  if (industryMenuBtn && industryMenu) {
    industryMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      industryMenu.style.display = industryMenu.style.display === 'flex' ? 'none' : 'flex';
    });
    industryMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('.industry-menu-btn');
      if (!btn) return;
      e.stopPropagation();
      if (btn.id === 'menuMyBlueprints') toggleLibraryView();
      else if (btn.dataset?.page) navigateToPage(btn.dataset.page);
      industryMenu.style.display = 'none';
    });
    document.addEventListener('click', () => { industryMenu.style.display = 'none'; });
  }
}

function toggleNavigation() {
  navCollapsed = !navCollapsed;
  const nav       = document.getElementById('sidebarNav');
  const toggleBtn = document.getElementById('navToggleBtn');
  if (navCollapsed) {
    nav.classList.add('nav-collapsed');
    toggleBtn.classList.add('collapsed');
    toggleBtn.textContent = '◀';
  } else {
    nav.classList.remove('nav-collapsed');
    toggleBtn.classList.remove('collapsed');
    toggleBtn.textContent = '▶';
  }
}

function navigateToPage(page) {
  const mainLibrary = document.getElementById('mainLibraryView');
  if (mainLibrary) mainLibrary.style.display = 'none';

  const pagesContainer = document.getElementById('navPagesContainer');
  if (pagesContainer) pagesContainer.style.display = 'flex';

  document.querySelectorAll('.nav-page').forEach(p => p.classList.remove('active'));
  const selectedPage = document.getElementById(`page-${page}`);
  if (selectedPage) selectedPage.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  currentPage = page;

  if (page === 'characters') loadAccounts();
  if (page === 'dashboard')  loadDashboard();
  if (page === 'assets')     loadAssets();
  if (page === 'wallets')    renderWallets();
  if (page === 'industry')   initIndustryPage();
  if (page === 'pi')         loadPlanetaryInteraction();
}

// ─── Nav Status Lights ────────────────────────────────────────────────────────

function setNavStatusLight(id, online) {
  const status = document.getElementById(id);
  if (!status) return;
  const light = status.querySelector('.status-light');
  if (!light) return;
  light.classList.toggle('status-online', online);
  light.classList.toggle('status-offline', !online);
  light.title = online ? 'Connected' : 'Disconnected';
}

function updateNavStatusIndicators() {
  setNavStatusLight('jabberNavStatus', jabberConnected);
}

function updateNavCharacterBtn(account) {
  const btn = document.querySelector('.nav-btn-characters');
  if (!btn) return;
  btn.innerHTML = '';
  if (account) {
    const img = document.createElement('img');
    img.className = 'nav-icon-portrait';
    img.alt = account.characterName;
    img.onerror = function () {
      this.onerror = null;
      const tried = this.dataset.tried || '';
      if (!tried.includes('64')) {
        this.dataset.tried = tried + ' 64';
        this.src = `https://images.evetech.net/characters/${account.characterId}/portrait?size=64`;
      } else {
        this.style.display = 'none';
      }
    };
    img.src = `https://images.evetech.net/characters/${account.characterId}/portrait?size=128`;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'nav-active-char-name';
    nameSpan.textContent = account.characterName;
    btn.appendChild(img);
    btn.appendChild(nameSpan);
    btn.title = `Active: ${account.characterName}`;
  } else {
    const icon = document.createElement('span');
    icon.className = 'nav-icon';
    icon.textContent = '⚔';
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = 'Characters';
    btn.appendChild(icon);
    btn.appendChild(label);
    btn.title = 'Characters';
  }
}

function toggleLibraryView() {
  const library   = document.getElementById('mainLibraryView');
  const toggleBtn = document.getElementById('toggleLibraryBtn');
  if (!library || !toggleBtn) return;
  isLibraryVisible = !isLibraryVisible;
  library.style.display = isLibraryVisible ? 'flex' : 'none';
  toggleBtn.textContent = isLibraryVisible ? 'Hide my blueprint library' : 'Show my blueprint library';
  toggleBtn.title       = toggleBtn.textContent;
}

function clearSelection() {
  const card = document.getElementById('selectedBpCard');
  if (!card) return;
  card.style.display = 'none';
  document.getElementById('selectedBpIcon').src = '';
  document.getElementById('selectedBpName').textContent = '';
  document.getElementById('selectedBpMeta').textContent = '';
}