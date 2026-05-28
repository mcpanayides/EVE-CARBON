// ─── wallets.js ───────────────────────────────────────────────────────────────
// Handles:
//   • renderWallets()          — wallet balance grid on the Wallets page
//   • openWalletJournal(charId)— modal with 3 tabs:
//       - Overview   (donut chart: income / expense by category)
//       - Transactions (market buy/sell table)
//       - LP Standings (loyalty points per corp)
// Data comes from character_information.db via IPC, synced every 30 min inside
// coreCharacterSync / fullCharacterSync in main.js.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ─── Wallet page ──────────────────────────────────────────────────────────────

async function renderWallets() {
  const grid    = document.getElementById('walletsGrid');
  const summary = document.getElementById('walletsSummary');
  const totalRow = document.getElementById('walletsTotalRow');
  const totalEl  = document.getElementById('walletsTotalValue');

  if (!grid) return;
  grid.innerHTML = '<div style="padding:24px;color:var(--text-3);font-family:var(--mono);font-size:12px;">Loading wallets…</div>';

  try {
    const accounts = await window.eveAPI.getAccounts();
    if (!accounts || accounts.length === 0) {
      grid.innerHTML = '<div style="padding:24px;color:var(--text-3);font-family:var(--mono);font-size:12px;">No characters found. Add a character on the Characters page.</div>';
      return;
    }

    // Fetch balance for every character in parallel
    const rows = await Promise.all(accounts.map(async acc => {
      try {
        const data    = await window.eveAPI.getCharacterData(acc.characterId);
        const balance = data?.wallet?.balance ?? 0;
        return { ...acc, balance };
      } catch (_) {
        return { ...acc, balance: 0 };
      }
    }));

    const total = rows.reduce((s, r) => s + r.balance, 0);

    // Render total bar
    if (totalRow) totalRow.style.display = 'flex';
    if (totalEl)  totalEl.textContent = formatISK(total);
    if (summary)  summary.textContent  = `${rows.length} character${rows.length !== 1 ? 's' : ''}`;

    grid.innerHTML = '';
    rows.sort((a, b) => b.balance - a.balance).forEach(r => {
      const card = document.createElement('div');
      card.className = 'wallet-card';
      card.style.cssText = `
        display:flex; align-items:center; gap:14px;
        background:var(--bg-card); border:1px solid var(--border);
        border-radius:6px; padding:16px 18px; cursor:pointer;
        transition:border-color .15s;`;
      card.title = 'View Journal';

      card.innerHTML = `
        <img src="https://images.evetech.net/characters/${r.characterId}/portrait?size=64"
             alt="${escHtml(r.characterName)}"
             style="width:48px;height:48px;border-radius:50%;border:1px solid var(--border);object-fit:cover;"
             onerror="this.style.display='none'">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${escHtml(r.characterName)}
          </div>
          <div style="font-size:18px;font-weight:700;color:var(--accent);font-family:var(--mono);margin-top:4px;">
            ${formatISK(r.balance)}
          </div>
        </div>
        <div style="color:var(--text-3);font-size:18px;" title="View Journal">📋</div>`;

      card.addEventListener('mouseenter', () => card.style.borderColor = 'var(--accent)');
      card.addEventListener('mouseleave', () => card.style.borderColor = 'var(--border)');
      card.addEventListener('click', () => openWalletJournal(r.characterId, r.characterName));

      grid.appendChild(card);
    });

  } catch (err) {
    console.error('[Wallets] renderWallets error:', err);
    grid.innerHTML = `<div style="padding:24px;color:var(--danger);font-family:var(--mono);font-size:12px;">⚠ Failed to load wallets: ${escHtml(err.message)}</div>`;
  }
}

// ─── Journal modal ────────────────────────────────────────────────────────────

let _journalCharId   = null;
let _journalRingChart = null;   // Chart.js instance — destroyed on re-open

async function openWalletJournal(characterId, characterName) {
  _journalCharId = characterId;

  const backdrop = document.getElementById('walletJournalBackdrop');
  if (!backdrop) return;
  backdrop.style.display = 'flex';

  // Header portrait + name
  const portrait = document.getElementById('journalCharPortrait');
  const nameEl   = document.getElementById('journalCharName');
  if (portrait) portrait.src = `https://images.evetech.net/characters/${characterId}/portrait?size=64`;
  if (nameEl)   nameEl.textContent = characterName || '';

  // Bind tab buttons (clone to strip old listeners)
  document.querySelectorAll('.journal-tab-btn').forEach(btn => {
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => _switchJournalTab(fresh.dataset.tab));
  });

  // Default to overview tab
  _switchJournalTab('overview');

  // Load all 3 tabs
  await Promise.all([
    _loadJournalOverview(characterId),
    _loadJournalTransactions(characterId),
    _loadJournalLP(characterId),
  ]);
}

function closeWalletJournal() {
  const backdrop = document.getElementById('walletJournalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
  _journalCharId = null;
}

// Wire backdrop click-outside to close
(function () {
  document.addEventListener('DOMContentLoaded', () => {
    const backdrop = document.getElementById('walletJournalBackdrop');
    if (backdrop) backdrop.addEventListener('click', e => {
      if (e.target === backdrop) closeWalletJournal();
    });
  });
})();

function _switchJournalTab(tab) {
  document.querySelectorAll('.journal-tab-btn').forEach(b => {
    const active = b.dataset.tab === tab;
    b.style.background = active ? 'var(--accent)' : 'none';
    b.style.color       = active ? '#000'          : 'var(--text-2)';
  });
  document.querySelectorAll('.journal-tab-content').forEach(p => {
    p.style.display = p.id === `journalTab-${tab}` ? 'flex' : 'none';
  });
}

// ── Tab: Overview (donut chart income vs expense by ref_type) ─────────────────

const REF_TYPE_LABELS = {
  market_transaction:    'Market',
  bounty_prizes:         'Bounties',
  bounty_prize:          'Bounties',
  player_trading:        'Trading',
  manufacturing:         'Manufacturing',
  contract_price:        'Contracts',
  contract_reward:       'Contracts',
  contract_collateral:   'Contracts',
  agent_mission_reward:  'Missions',
  agent_mission_time_bonus_reward: 'Missions',
  insurance:             'Insurance',
  transaction_tax:       'Taxes',
  brokers_fee:           'Broker Fees',
  industry_job_tax:      'Industry Tax',
  planetary_export_tax:  'PI Tax',
  planetary_import_tax:  'PI Tax',
  skill_purchase:        'Skills',
  corp_account_withdrawal: 'Corp',
  corporation_account_withdrawal: 'Corp',
  reprocessing_tax:      'Reprocessing',
  structure_gate_jump:   'Jump',
  jump_clone_activation: 'Clone Jump',
  jump_clone_installation: 'Clone Jump',
};

function _refLabel(refType) {
  return REF_TYPE_LABELS[refType] || _titleCase(refType.replace(/_/g, ' '));
}

function _titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

const PALETTE = [
  '#4ada8a','#ab7ab8','#f5c842','#e24b4a','#4ab8f5',
  '#f58c42','#42f5c8','#f542a1','#a1f542','#8c42f5',
];

async function _loadJournalOverview(characterId) {
  const incomeEl  = document.getElementById('journalIncomeTotal');
  const expenseEl = document.getElementById('journalExpenseTotal');
  const legendEl  = document.getElementById('journalLegend');
  const ringCenter = document.getElementById('journalRingValue');

  if (incomeEl)  incomeEl.textContent  = '—';
  if (expenseEl) expenseEl.textContent = '—';
  if (legendEl)  legendEl.innerHTML    = '<span style="color:var(--text-3);font-size:11px;font-family:var(--mono);">Loading…</span>';

  try {
    const entries = await window.eveAPI.getWalletJournal(characterId);

    if (!entries || entries.length === 0) {
      if (legendEl) legendEl.innerHTML = '<span style="color:var(--text-3);font-size:11px;font-family:var(--mono);">No journal entries. Sync to fetch data.</span>';
      return;
    }

    // Bucket by income / expense
    const incomeByLabel  = {};
    const expenseByLabel = {};
    let totalIncome = 0, totalExpense = 0;

    entries.forEach(e => {
      const amt   = e.amount || 0;
      const label = _refLabel(e.ref_type || 'other');
      if (amt >= 0) {
        incomeByLabel[label]  = (incomeByLabel[label]  || 0) + amt;
        totalIncome  += amt;
      } else {
        expenseByLabel[label] = (expenseByLabel[label] || 0) + Math.abs(amt);
        totalExpense += Math.abs(amt);
      }
    });

    if (incomeEl)  incomeEl.textContent  = formatISK(totalIncome);
    if (expenseEl) expenseEl.textContent = formatISK(totalExpense);
    if (ringCenter) ringCenter.textContent = formatISK(totalIncome - totalExpense);

    // Build donut datasets — top 8 income categories, rest merged
    const sortedIncome = Object.entries(incomeByLabel).sort((a, b) => b[1] - a[1]);
    const topIncome    = sortedIncome.slice(0, 8);
    const otherIncome  = sortedIncome.slice(8).reduce((s, [, v]) => s + v, 0);
    if (otherIncome > 0) topIncome.push(['Other Income', otherIncome]);

    const donutLabels = topIncome.map(([l]) => l);
    const donutData   = topIncome.map(([, v]) => v);
    const donutColors = PALETTE.slice(0, donutLabels.length);

    // Destroy old chart instance before creating a new one
    if (_journalRingChart) { _journalRingChart.destroy(); _journalRingChart = null; }

    const canvas = document.getElementById('journalRingChart');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      _journalRingChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels:   donutLabels,
          datasets: [{ data: donutData, backgroundColor: donutColors, borderWidth: 2, borderColor: 'var(--bg-card)' }],
        },
        options: {
          cutout: '72%',
          plugins: { legend: { display: false }, tooltip: {
            callbacks: { label: ctx => ` ${ctx.label}: ${formatISK(ctx.raw)}` }
          }},
          animation: { duration: 600 },
        },
      });
    }

    // Legend
    if (legendEl) {
      legendEl.innerHTML = '';
      topIncome.forEach(([label, value], i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;';
        row.innerHTML = `
          <span style="width:12px;height:12px;border-radius:2px;flex-shrink:0;background:${donutColors[i]};display:inline-block;"></span>
          <span style="flex:1;font-size:11px;color:var(--text-2);font-family:var(--mono);">${escHtml(label)}</span>
          <span style="font-size:11px;color:var(--text-1);font-family:var(--mono);font-weight:600;">${formatISK(value)}</span>`;
        legendEl.appendChild(row);
      });

      // Expense summary row
      if (Object.keys(expenseByLabel).length > 0) {
        const divider = document.createElement('div');
        divider.style.cssText = 'border-top:1px solid var(--border);margin:8px 0;';
        legendEl.appendChild(divider);

        Object.entries(expenseByLabel)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .forEach(([label, value]) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:10px;';
            row.innerHTML = `
              <span style="width:12px;height:12px;border-radius:2px;flex-shrink:0;background:var(--danger);display:inline-block;"></span>
              <span style="flex:1;font-size:11px;color:var(--text-2);font-family:var(--mono);">${escHtml(label)}</span>
              <span style="font-size:11px;color:var(--danger);font-family:var(--mono);font-weight:600;">-${formatISK(value)}</span>`;
            legendEl.appendChild(row);
          });
      }
    }

  } catch (err) {
    console.error('[Wallets] overview error:', err);
    if (legendEl) legendEl.innerHTML = `<span style="color:var(--danger);font-size:11px;font-family:var(--mono);">⚠ ${escHtml(err.message)}</span>`;
  }
}

// ── Tab: Transactions ─────────────────────────────────────────────────────────

async function _loadJournalTransactions(characterId) {
  const tbody = document.getElementById('journalTransactionBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-3);font-size:11px;font-family:var(--mono);">Loading…</td></tr>';

  try {
    const txns = await window.eveAPI.getWalletTransactions(characterId);

    if (!txns || txns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-3);font-size:11px;font-family:var(--mono);">No transactions found. Sync to fetch data.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    txns.forEach(t => {
      const isBuy   = t.is_buy === 1 || t.is_buy === true;
      const total   = (t.quantity || 0) * (t.unit_price || 0);
      const date    = t.date ? new Date(t.date).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—';
      const tr      = document.createElement('tr');
      tr.innerHTML = `
        <td style="padding:6px 10px;font-size:11px;font-family:var(--mono);color:var(--text-3);white-space:nowrap;">${escHtml(date)}</td>
        <td style="padding:6px 10px;font-size:11px;color:${isBuy ? 'var(--danger)' : 'var(--success)'};font-weight:600;">
          ${isBuy ? 'BUY' : 'SELL'}
        </td>
        <td style="padding:6px 10px;font-size:11px;color:var(--text-1);">${escHtml(t.type_name || `Type ${t.type_id}`)}</td>
        <td style="padding:6px 10px;font-size:11px;font-family:var(--mono);text-align:right;color:var(--text-2);">${(t.quantity || 0).toLocaleString()}</td>
        <td style="padding:6px 10px;font-size:11px;font-family:var(--mono);text-align:right;color:var(--text-2);">${formatISK(t.unit_price || 0)}</td>
        <td style="padding:6px 10px;font-size:11px;font-family:var(--mono);text-align:right;font-weight:600;
            color:${isBuy ? 'var(--danger)' : 'var(--success)'};">
          ${isBuy ? '-' : '+'}${formatISK(total)}
        </td>`;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error('[Wallets] transactions error:', err);
    tbody.innerHTML = `<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--danger);font-size:11px;font-family:var(--mono);">⚠ ${escHtml(err.message)}</td></tr>`;
  }
}

// ── Tab: LP Standings ─────────────────────────────────────────────────────────

async function _loadJournalLP(characterId) {
  const tbody = document.getElementById('journalLPBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--text-3);font-size:11px;font-family:var(--mono);">Loading…</td></tr>';

  try {
    const rows = await window.eveAPI.getLoyaltyPoints(characterId);

    if (!rows || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--text-3);font-size:11px;font-family:var(--mono);">No LP data found. Sync to fetch data.</td></tr>';
      return;
    }

    const maxLP = Math.max(...rows.map(r => r.loyalty_points || 0), 1);

    tbody.innerHTML = '';
    rows.forEach(r => {
      const pct = Math.round(((r.loyalty_points || 0) / maxLP) * 100);
      const tr  = document.createElement('tr');
      tr.innerHTML = `
        <td style="padding:8px 12px;font-size:12px;color:var(--text-1);">
          <div style="display:flex;align-items:center;gap:10px;">
            <img src="https://images.evetech.net/corporations/${r.corporation_id}/logo?size=32"
                 alt="" style="width:24px;height:24px;border-radius:3px;border:1px solid var(--border);"
                 onerror="this.style.display='none'">
            <span>${escHtml(r.corporation_name || `Corp ${r.corporation_id}`)}</span>
          </div>
        </td>
        <td style="padding:8px 12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="flex:1;height:6px;background:var(--bg-panel);border-radius:3px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:3px;transition:width .4s;"></div>
            </div>
            <span style="font-size:12px;font-family:var(--mono);font-weight:700;color:var(--accent);min-width:80px;text-align:right;">
              ${(r.loyalty_points || 0).toLocaleString()} LP
            </span>
          </div>
        </td>
        <td style="padding:8px 12px;font-size:11px;color:var(--text-3);font-family:var(--mono);">—</td>`;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error('[Wallets] LP error:', err);
    tbody.innerHTML = `<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--danger);font-size:11px;font-family:var(--mono);">⚠ ${escHtml(err.message)}</td></tr>`;
  }
}