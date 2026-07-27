// ─── Finances page ────────────────────────────────────────────────────────────
// Left TOOLS rail (like Industry/Skills). navigateFinancesTab() renders each
// tool into #financesTabContent. Wallets and Contracts are hosted here; LP Store
// and Trading live in their own modules (lpstore.js / trading.js).

let _currentFinancesTab = 'wallets';

function initFinancesPage() {
  document.querySelectorAll('.finances-sub-btn').forEach(btn => {
    btn.onclick = () => { const t = btn.dataset.financesTab; if (t) navigateFinancesTab(t); };
  });
  navigateFinancesTab(_currentFinancesTab || 'wallets');
}

function navigateFinancesTab(tab) {
  _currentFinancesTab = tab;
  document.querySelectorAll('.finances-sub-btn').forEach(b => b.classList.toggle('active', b.dataset.financesTab === tab));
  const host = document.getElementById('financesTabContent');
  if (!host) return;

  if (tab === 'wallets') {
    // The wallet summary/total/grid elements renderWallets() (assets.js) targets
    // by id must exist before it runs, so inject them here first.
    host.innerHTML = `
      <div class="fin-tab-fill">
        <div class="fin-wallets-bar">
          <span id="walletsSummary" class="asset-summary"></span>
        </div>
        <div id="walletsTotalRow" class="fin-wallets-total" style="display:none;">
          <span class="fin-wallets-total-label">COMBINED LIQUID WEALTH</span>
          <span id="walletsTotalValue" class="fin-wallets-total-value">0.00 ISK</span>
        </div>
        <div class="page-content fin-wallets-scroll">
          <div class="wallets-grid" id="walletsGrid"></div>
        </div>
      </div>`;
    if (typeof renderWallets === 'function') renderWallets();

  } else if (tab === 'contracts') {
    host.innerHTML = '<div id="contractsTab" class="fin-tab-fill"></div>';
    if (typeof initContractsTab === 'function') initContractsTab();

  } else if (tab === 'lpstore') {
    if (typeof renderLpStore === 'function') renderLpStore(host);
    else host.innerHTML = '<div class="fin-empty">LP Store tool unavailable.</div>';

  } else if (tab === 'trading') {
    if (typeof renderTrading === 'function') renderTrading(host);
    else host.innerHTML = '<div class="fin-empty">Trading tool unavailable.</div>';
  }
}
