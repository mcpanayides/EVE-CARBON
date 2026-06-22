// orehold-reprocess.js — Orehold Minerals Calculator
//
// Paste the contents of your ore hold (as copied from the EVE inventory) and see
// how many minerals / ice products / moon materials reprocessing yields at three
// skill tiers: no reprocessing skills, all skills at V, and all skills + a
// reprocessing implant. Reprocessing content comes from the local SDE via the
// `reprocess-from-names` IPC, so it works for ore, ice and moon ore alike.

// ── State ──────────────────────────────────────────────────────────────────────
let _oreholdBaseYield = 50;   // station/structure base rate %; NPC station = 50
let _oreholdImplant   = 4;    // reprocessing implant %: 0 / 1 / 2 / 4 (RX-804 = max)
let _oreholdResults   = null; // last computed result so toolbar tweaks can re-render
let _oreholdPrices    = {};   // typeId -> { buy, sell } @ Jita 4-4, fetched on Calculate
let _oreholdPriceMode = 'sell'; // 'sell' | 'buy' — which Jita price to value output at

// Skill multiplier when every relevant reprocessing skill is at V:
//   Reprocessing (+3%/lvl → 1.15) × Reprocessing Efficiency (+2%/lvl → 1.10)
//   × ore/ice-specific Processing (+2%/lvl → 1.10)
const OREHOLD_MAX_SKILL_MULT = 1.15 * 1.10 * 1.10; // ≈ 1.3915

// Reprocessing implants actually available in EVE (Zainou 'Beancounter').
const OREHOLD_IMPLANTS = [
  { pct: 0, label: 'None' },
  { pct: 1, label: 'RX-801 (+1%)' },
  { pct: 2, label: 'RX-802 (+2%)' },
  { pct: 4, label: 'RX-804 (+4%) — max' },
];

// Display order: core minerals first, then everything else (ice/moon) alphabetically.
const OREHOLD_MINERAL_ORDER = [
  'Tritanium', 'Pyerite', 'Mexallon', 'Isogen',
  'Nocxium', 'Zydrine', 'Megacyte', 'Morphite',
];

// ── Paste parser ────────────────────────────────────────────────────────────────
// Tolerant of the formats people actually paste:
//   • EVE inventory copy (tab-separated: "Name\tQty\tGroup\t…")
//   • multibuy ("Veldspar x1000", "Veldspar 1000", "1000 Veldspar")
//   • bare name (assumed quantity 1)
// Quantities are whole numbers, so any grouping (",", ".", spaces) is stripped.
function parseOreholdText(text) {
  const agg = new Map(); // lowerName -> { name, qty }
  const toQty = (s) => {
    const n = parseInt(String(s).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : NaN;
  };
  const add = (name, qty) => {
    name = String(name || '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    const q = (Number.isFinite(qty) && qty > 0) ? qty : 1;
    const cur = agg.get(key);
    if (cur) cur.qty += q;
    else agg.set(key, { name, qty: q });
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (rawLine.includes('\t')) {            // EVE inventory copy
      const parts = rawLine.split('\t');
      add(parts[0], toQty(parts[1]));
      continue;
    }
    let m;
    if ((m = line.match(/^(.+?)\s+x\s*([\d.,\s]+)$/i))) { add(m[1], toQty(m[2])); continue; } // Name x1000
    if ((m = line.match(/^(.+?)\s+([\d.,\s]+)$/)))       { add(m[1], toQty(m[2])); continue; } // Name 1000
    if ((m = line.match(/^([\d.,\s]+)\s+(.+)$/)))        { add(m[2], toQty(m[1])); continue; } // 1000 Name
    add(line, 1);                            // bare name
  }
  return [...agg.values()];
}

// ── Entry point ──────────────────────────────────────────────────────────────
function renderOreholdCalc(container) {
  const implantOpts = OREHOLD_IMPLANTS.map(i =>
    `<option value="${i.pct}" ${i.pct === _oreholdImplant ? 'selected' : ''}>${i.label}</option>`
  ).join('');

  container.innerHTML = `
    <div id="oreholdWrap" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <!-- Toolbar -->
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;
                  padding:10px 16px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;flex-shrink:0;">OREHOLD MINERALS CALC</span>
        <div style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;">
          <label style="font-size:11px;color:var(--text-2);font-family:var(--mono);">BASE YIELD %</label>
          <input id="oreholdBaseYield" type="number" min="0" max="100" step="0.01"
                 value="${_oreholdBaseYield}"
                 class="field-input" style="width:74px;padding:5px 8px;font-size:12px;"
                 title="Station/structure base reprocessing rate. NPC stations = 50%. Engineering Complexes with reprocessing rigs are higher."/>
          <label style="font-size:11px;color:var(--text-2);font-family:var(--mono);">IMPLANT</label>
          <select id="oreholdImplant" class="field-input"
                  style="width:170px;padding:5px 8px;font-size:12px;cursor:pointer;">${implantOpts}</select>
          <label style="font-size:11px;color:var(--text-2);font-family:var(--mono);">PRICE</label>
          <select id="oreholdPriceMode" class="field-input"
                  style="width:110px;padding:5px 8px;font-size:12px;cursor:pointer;"
                  title="Value the reprocessed materials at Jita 4-4 sell or buy prices.">
            <option value="sell" ${_oreholdPriceMode === 'sell' ? 'selected' : ''}>Jita Sell</option>
            <option value="buy" ${_oreholdPriceMode === 'buy' ? 'selected' : ''}>Jita Buy</option>
          </select>
        </div>
      </div>

      <!-- Body: paste on the left, results on the right -->
      <div style="display:flex;flex:1;overflow:hidden;">

        <!-- Paste column -->
        <div style="display:flex;flex-direction:column;width:340px;flex-shrink:0;
                    border-right:1px solid var(--border);background:var(--bg-panel);">
          <div style="padding:10px 14px 6px;font-family:var(--mono);font-size:10px;
                      color:var(--text-3);letter-spacing:0.1em;">PASTE ORE HOLD CONTENTS</div>
          <textarea id="oreholdInput" spellcheck="false"
                    placeholder="Select everything in your ore hold in EVE, Ctrl+C, then paste here.&#10;&#10;Veldspar	12,500&#10;Compressed Scordite	3,000&#10;Blue Ice	40"
                    style="flex:1;margin:0 14px;resize:none;background:var(--bg-deep);
                           border:1px solid var(--border);border-radius:6px;color:var(--text-1);
                           font-family:var(--mono);font-size:12px;padding:10px;line-height:1.5;
                           min-height:120px;"></textarea>
          <div style="display:flex;gap:8px;padding:10px 14px;">
            <button id="oreholdCalcBtn" class="calc-btn"
                    style="flex:1;font-size:12px;">CALCULATE</button>
            <button id="oreholdClearBtn" class="icon-btn"
                    style="padding:6px 12px;font-size:12px;">CLEAR</button>
          </div>
          <div id="oreholdParsed" style="padding:0 14px 12px;overflow-y:auto;max-height:40%;"></div>
        </div>

        <!-- Results column -->
        <div id="oreholdResults" style="flex:1;overflow-y:auto;padding:16px;">
          <div class="empty-state" style="margin-top:60px;">
            <div class="empty-icon">⬡</div>
            <div class="empty-title">OREHOLD MINERALS</div>
            <div class="empty-sub">Paste your ore hold and press Calculate to see mineral yields.</div>
          </div>
        </div>
      </div>

      <div style="padding:8px 16px;border-top:1px solid var(--border);background:var(--bg-card);
                  font-size:10px;color:var(--text-3);font-family:var(--mono);flex-shrink:0;">
        Yields = base × skill tier, floored per ore type (EVE reprocesses in whole batches).
        "Max Skills" assumes Reprocessing V, Reprocessing Efficiency V and the relevant ore/ice Processing skill at V.
        ISK values use live Jita 4-4 prices (sell or buy, per the toolbar).
      </div>
    </div>`;

  document.getElementById('oreholdCalcBtn').addEventListener('click', runOreholdCalc);
  document.getElementById('oreholdClearBtn').addEventListener('click', () => {
    document.getElementById('oreholdInput').value = '';
    document.getElementById('oreholdParsed').innerHTML = '';
    _oreholdResults = null;
    renderOreholdResults();
  });
  // Ctrl/Cmd+Enter in the textarea triggers a calculation.
  document.getElementById('oreholdInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runOreholdCalc(); }
  });
  // Toolbar tweaks re-render the existing result without another DB round-trip.
  document.getElementById('oreholdBaseYield').addEventListener('change', (e) => {
    _oreholdBaseYield = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
    if (_oreholdResults) renderOreholdResults();
  });
  document.getElementById('oreholdImplant').addEventListener('change', (e) => {
    _oreholdImplant = parseFloat(e.target.value) || 0;
    if (_oreholdResults) renderOreholdResults();
  });
  document.getElementById('oreholdPriceMode').addEventListener('change', (e) => {
    _oreholdPriceMode = e.target.value === 'buy' ? 'buy' : 'sell';
    if (_oreholdResults) renderOreholdResults();
  });
}

// ── Resolve + store the paste, then render ──────────────────────────────────────
async function runOreholdCalc() {
  const ta = document.getElementById('oreholdInput');
  if (!ta) return;
  const items = parseOreholdText(ta.value);
  if (!items.length) { showToast('Paste your ore hold contents first.', 'error'); return; }

  const btn = document.getElementById('oreholdCalcBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'RESOLVING…'; }

  try {
    const data = await window.eveAPI.reprocessFromNames(items.map(i => i.name)) || {};
    // Attach the SDE entry (or null) to each parsed item.
    _oreholdResults = items.map(it => ({
      input:  it,
      entry:  data[it.name.toLowerCase()] || null,
    }));

    // Fetch Jita 4-4 prices for every output material so the table can value them.
    const matIds = [...new Set(
      _oreholdResults.flatMap(r => r.entry ? r.entry.materials.map(m => m.id) : [])
    )];
    if (matIds.length) {
      if (btn) btn.textContent = 'PRICING…';
      try { _oreholdPrices = await window.eveAPI.getJitaPrices(matIds) || {}; }
      catch (_) { _oreholdPrices = {}; }
    }

    renderOreholdResults();
    renderOreholdParsed();
  } catch (e) {
    showToast(`Reprocessing lookup failed: ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'CALCULATE'; }
  }
}

// ── Compute the three efficiency tiers from the toolbar settings ─────────────────
function oreholdEfficiencies() {
  const base = _oreholdBaseYield / 100;
  const none = Math.min(base, 1);
  const max  = Math.min(base * OREHOLD_MAX_SKILL_MULT, 1);
  const imp  = Math.min(base * OREHOLD_MAX_SKILL_MULT * (1 + _oreholdImplant / 100), 1);
  return { none, max, imp };
}

// ── Render the parsed-items confirmation panel (left column) ─────────────────────
function renderOreholdParsed() {
  const el = document.getElementById('oreholdParsed');
  if (!el || !_oreholdResults) return;

  const rows = _oreholdResults.map(r => {
    const { input, entry } = r;
    if (!entry || !entry.materials.length) {
      return `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;
                          font-family:var(--mono);font-size:11px;color:var(--danger);">
                <span title="Not found in the SDE, or not reprocessable">⚠ ${escHtml(input.name)}</span>
                <span>${formatNumber(input.qty)}</span>
              </div>`;
    }
    const batches  = Math.floor(input.qty / entry.portionSize);
    const leftover = input.qty - batches * entry.portionSize;
    const warn = batches <= 0
      ? `<span style="color:var(--warning);" title="Fewer than one full batch of ${entry.portionSize} — nothing refines">below batch</span>`
      : (leftover > 0
          ? `<span style="color:var(--text-3);" title="${leftover} unit(s) left over below a full batch">+${formatNumber(leftover)} rem</span>`
          : '');
    return `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;
                        font-family:var(--mono);font-size:11px;color:var(--text-2);">
              <span>${escHtml(entry.name)}</span>
              <span>${formatNumber(input.qty)} ${warn}</span>
            </div>`;
  }).join('');

  el.innerHTML = `
    <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                letter-spacing:0.1em;margin:8px 0 4px;">PARSED (${_oreholdResults.length})</div>
    ${rows}`;
}

// ── Render the mineral-yield table (right column) ────────────────────────────────
function renderOreholdResults() {
  const el = document.getElementById('oreholdResults');
  if (!el) return;

  if (!_oreholdResults) {
    el.innerHTML = `
      <div class="empty-state" style="margin-top:60px;">
        <div class="empty-icon">⬡</div>
        <div class="empty-title">OREHOLD MINERALS</div>
        <div class="empty-sub">Paste your ore hold and press Calculate to see mineral yields.</div>
      </div>`;
    return;
  }

  const eff = oreholdEfficiencies();
  const totals = new Map(); // matName -> { id, name, none, max, imp }

  for (const { input, entry } of _oreholdResults) {
    if (!entry || !entry.materials.length) continue;
    const batches = Math.floor(input.qty / entry.portionSize);
    if (batches <= 0) continue;
    for (const mat of entry.materials) {
      const raw = batches * mat.quantity;
      const t = totals.get(mat.name) || { id: mat.id, name: mat.name, none: 0, max: 0, imp: 0 };
      t.none += Math.floor(raw * eff.none);
      t.max  += Math.floor(raw * eff.max);
      t.imp  += Math.floor(raw * eff.imp);
      totals.set(mat.name, t);
    }
  }

  const unresolved = _oreholdResults.filter(r => !r.entry || !r.entry.materials.length);

  if (!totals.size) {
    el.innerHTML = `
      <div class="empty-state" style="margin-top:60px;">
        <div class="empty-icon">⚠</div>
        <div class="empty-title">NOTHING TO REPROCESS</div>
        <div class="empty-sub">None of the pasted items resolved to a reprocessable type${
          unresolved.length ? ` (${unresolved.length} unmatched)` : ''}. Check the names match EVE exactly.</div>
      </div>`;
    return;
  }

  // Sort: known minerals in canonical order, then the rest alphabetically.
  const rows = [...totals.values()].sort((a, b) => {
    const ia = OREHOLD_MINERAL_ORDER.indexOf(a.name);
    const ib = OREHOLD_MINERAL_ORDER.indexOf(b.name);
    if (ia !== -1 || ib !== -1) {
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    }
    return a.name.localeCompare(b.name);
  });

  const implantLabel = _oreholdImplant > 0 ? `+${_oreholdImplant}% implant` : 'no implant';
  const pct = (v) => (v * 100).toFixed(2) + '%';

  // Jita price for a material in the chosen mode (sell/buy); 0 when unknown.
  const priceOf = (id) => {
    const p = _oreholdPrices[id];
    if (!p) return 0;
    return (_oreholdPriceMode === 'buy' ? p.buy : p.sell) || 0;
  };
  const fmtUnit = (v) => v > 0 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  const priceModeLabel = _oreholdPriceMode === 'buy' ? 'Jita Buy' : 'Jita Sell';

  let totNone = 0, totMax = 0, totImp = 0;
  const bodyRows = rows.map(r => {
    const price = priceOf(r.id);
    const vNone = r.none * price, vMax = r.max * price, vImp = r.imp * price;
    totNone += vNone; totMax += vMax; totImp += vImp;
    const sub = (v) => price > 0
      ? `<div style="font-size:10px;color:var(--text-3);">${formatISK(v)}</div>` : '';
    return `
    <tr style="border-bottom:1px solid var(--border);">
      <td style="padding:8px 14px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <img src="https://images.evetech.net/types/${r.id}/icon?size=32"
               onerror="this.onerror=null;this.style.display='none';"
               style="width:22px;height:22px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">
          <span style="color:var(--text-1);">${escHtml(r.name)}</span>
        </div>
      </td>
      <td style="padding:8px 14px;text-align:right;font-family:var(--mono);color:var(--text-3);">${fmtUnit(price)}</td>
      <td style="padding:8px 14px;text-align:right;font-family:var(--mono);color:var(--text-2);">${formatNumber(r.none)}${sub(vNone)}</td>
      <td style="padding:8px 14px;text-align:right;font-family:var(--mono);color:var(--text-1);">${formatNumber(r.max)}${sub(vMax)}</td>
      <td style="padding:8px 14px;text-align:right;font-family:var(--mono);font-weight:700;color:var(--accent);">${formatNumber(r.imp)}${sub(vImp)}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <!-- Efficiency summary chips -->
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:8px 14px;">
        <div style="font-size:9px;font-family:var(--mono);color:var(--text-3);letter-spacing:0.08em;">NO SKILLS</div>
        <div style="font-size:14px;font-family:var(--mono);color:var(--text-2);">${pct(eff.none)}</div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--text-3);">${formatISK(totNone)}</div>
      </div>
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:8px 14px;">
        <div style="font-size:9px;font-family:var(--mono);color:var(--text-3);letter-spacing:0.08em;">MAX SKILLS</div>
        <div style="font-size:14px;font-family:var(--mono);color:var(--text-1);">${pct(eff.max)}</div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--text-2);">${formatISK(totMax)}</div>
      </div>
      <div style="background:var(--bg-card);border:1px solid var(--accent);border-radius:8px;padding:8px 14px;">
        <div style="font-size:9px;font-family:var(--mono);color:var(--text-3);letter-spacing:0.08em;">MAX + ${implantLabel.toUpperCase()}</div>
        <div style="font-size:14px;font-family:var(--mono);color:var(--accent);font-weight:700;">${pct(eff.imp)}</div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--accent);">${formatISK(totImp)}</div>
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);position:sticky;top:0;">
          <th style="text-align:left;padding:10px 14px;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">MATERIAL</th>
          <th style="text-align:right;padding:10px 14px;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">UNIT · ${priceModeLabel.toUpperCase()}</th>
          <th style="text-align:right;padding:10px 14px;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">NO SKILLS</th>
          <th style="text-align:right;padding:10px 14px;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">MAX SKILLS</th>
          <th style="text-align:right;padding:10px 14px;font-family:var(--mono);font-size:10px;color:var(--accent);letter-spacing:0.1em;">MAX + IMPLANT</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>
        <tr style="border-top:2px solid var(--border);background:var(--bg-card);">
          <td colspan="2" style="padding:10px 14px;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">TOTAL VALUE</td>
          <td style="padding:10px 14px;text-align:right;font-family:var(--mono);font-weight:700;color:var(--text-2);">${formatISK(totNone)}</td>
          <td style="padding:10px 14px;text-align:right;font-family:var(--mono);font-weight:700;color:var(--text-1);">${formatISK(totMax)}</td>
          <td style="padding:10px 14px;text-align:right;font-family:var(--mono);font-weight:700;color:var(--accent);">${formatISK(totImp)}</td>
        </tr>
      </tfoot>
    </table>

    ${unresolved.length ? `
      <div style="margin-top:14px;padding:10px 14px;border:1px solid var(--danger);border-radius:8px;
                  background:rgba(201,64,64,0.08);font-size:11px;color:var(--text-2);font-family:var(--mono);">
        ⚠ ${unresolved.length} item(s) couldn't be matched and were skipped:
        ${unresolved.map(u => escHtml(u.input.name)).join(', ')}
      </div>` : ''}`;
}
