// ─── market.js ───────────────────────────────────────────────────────────────
// Market tab — a trader's view of every active SELL order across all
// characters, each compared to the live Jita 4-4 price with a green/red
// indicator (green = priced at or above Jita, red = below).
//
// Data sources (all already available):
//   • window.eveAPI.getCharacterOrders(charId) — live ESI character orders
//   • window.eveAPI.getNames(typeIds)          — item names (SDE-first)
//   • window.eveAPI.getJitaPrices(typeIds)     — { typeId: { buy, sell } } @ Jita 4-4
//   • window.eveAPI.resolveLocation(id, charId)— station/structure name + system/region
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

async function renderMarket() {
  const body    = document.getElementById('marketOrdersBody');
  const summary = document.getElementById('marketSummary');
  if (!body) return;

  body.innerHTML = '<tr><td colspan="7" class="loading-row">Loading market orders from ESI…</td></tr>';
  if (summary) summary.textContent = 'Loading…';

  try {
    const accounts = await window.eveAPI.getAccounts().catch(() => []);
    if (!accounts.length) {
      body.innerHTML = '<tr><td colspan="7" class="loading-row">No characters. Add one on the Characters page.</td></tr>';
      if (summary) summary.textContent = '';
      return;
    }

    // ── Pull every character's orders; keep sell orders only ─────────────────
    const orderRows = [];
    await Promise.all(accounts.map(async (acc) => {
      let orders = [];
      try { orders = await window.eveAPI.getCharacterOrders(acc.characterId); } catch (_) {}
      (Array.isArray(orders) ? orders : []).forEach(o => {
        if (!o.is_buy_order) orderRows.push({ acc, o });
      });
    }));

    if (!orderRows.length) {
      body.innerHTML = '<tr><td colspan="7" class="loading-row">No active sell orders found across your characters.</td></tr>';
      if (summary) summary.textContent = '0 active sell orders';
      return;
    }

    // ── Resolve item names + Jita 4-4 prices in batch ────────────────────────
    const typeIds = [...new Set(orderRows.map(r => r.o.type_id).filter(Boolean))];
    const [namesArr, jita] = await Promise.all([
      window.eveAPI.getNames(typeIds).catch(() => []),
      window.eveAPI.getJitaPrices(typeIds).catch(() => ({})),
    ]);
    const nameMap = {};
    (Array.isArray(namesArr) ? namesArr : []).forEach(n => { if (n && n.id) nameMap[n.id] = n.name; });

    // ── Resolve each distinct location (the locator caches these) ────────────
    const locMap = {};
    const locIds = [...new Set(orderRows.map(r => r.o.location_id).filter(Boolean))];
    await Promise.all(locIds.map(async (id) => {
      const owner = orderRows.find(r => r.o.location_id === id)?.acc?.characterId;
      try { const loc = await window.eveAPI.resolveLocation(id, owner); if (loc) locMap[id] = loc; } catch (_) {}
    }));

    // ── Build + sort display rows (by location, then item) ───────────────────
    const built = orderRows.map(({ acc, o }) => {
      const loc = locMap[o.location_id] || {};
      const jp  = jita[o.type_id] || {};
      return {
        charId:   acc.characterId,
        charName: acc.characterName || `Char ${acc.characterId}`,
        typeId:   o.type_id,
        name:     nameMap[o.type_id] || `Type ${o.type_id}`,
        locName:  loc.name || `Location ${o.location_id}`,
        sub:      [loc.solar_system_name, loc.region_name].filter(Boolean).join(' · '),
        qty:      o.volume_remain || 0,
        price:    o.price || 0,
        jita:     jp.sell || jp.buy || 0,
      };
    }).sort((a, b) => a.locName.localeCompare(b.locName) || a.name.localeCompare(b.name));

    body.innerHTML = built.map(r => {
      const hasJita = r.jita > 0;
      const above   = hasJita && r.price >= r.jita;          // green = at/above Jita
      const color   = hasJita ? (above ? '#4ecbb0' : '#e05252') : '#666';
      const diffPct = hasJita ? ((r.price - r.jita) / r.jita * 100) : null;
      const diffTxt = diffPct === null ? '—' : `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%`;

      return `
        <tr>
          <td style="padding:4px 8px;text-align:center;vertical-align:middle;">
            <img src="https://images.evetech.net/characters/${r.charId}/portrait?size=32"
                 title="${escHtml(r.charName)}" alt="${escHtml(r.charName)}"
                 style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);object-fit:cover;"
                 onerror="this.style.display='none'">
          </td>
          <td style="padding:5px 10px;vertical-align:middle;white-space:nowrap;">
            <span style="display:inline-flex;align-items:center;gap:8px;">
              <img src="https://images.evetech.net/types/${r.typeId}/icon?size=32" alt="" loading="lazy"
                   style="width:28px;height:28px;border-radius:2px;flex-shrink:0;background:rgba(255,255,255,0.03);">
              <span style="color:var(--text-1);">${escHtml(r.name)}</span>
            </span>
          </td>
          <td style="padding:5px 10px;vertical-align:middle;">
            <div style="color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px;">${escHtml(r.locName)}</div>
            ${r.sub ? `<div style="font-size:10px;color:var(--text-3);font-family:var(--mono);">${escHtml(r.sub)}</div>` : ''}
          </td>
          <td style="padding:5px 10px;text-align:right;font-family:var(--mono);color:var(--text-2);white-space:nowrap;vertical-align:middle;">${r.qty.toLocaleString()}</td>
          <td style="padding:5px 10px;text-align:right;font-family:var(--mono);color:var(--text-1);white-space:nowrap;vertical-align:middle;">${formatISK(r.price)}</td>
          <td style="padding:5px 10px;text-align:right;font-family:var(--mono);color:var(--text-3);white-space:nowrap;vertical-align:middle;">${hasJita ? formatISK(r.jita) : '—'}</td>
          <td style="padding:5px 12px 5px 10px;text-align:right;white-space:nowrap;vertical-align:middle;">
            <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};box-shadow:0 0 6px ${color}88;margin-right:6px;vertical-align:middle;"></span>
            <span style="font-family:var(--mono);color:${color};font-size:11px;">${diffTxt}</span>
          </td>
        </tr>`;
    }).join('');

    const charCount = new Set(built.map(r => r.charId)).size;
    if (summary) {
      summary.textContent =
        `${built.length} active sell order${built.length !== 1 ? 's' : ''} across ${charCount} character${charCount !== 1 ? 's' : ''} · Jita 4-4 sell reference`;
    }

  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="loading-row">Failed to load market orders: ${escHtml(err.message)}</td></tr>`;
    if (summary) summary.textContent = 'Load failed.';
  }
}
