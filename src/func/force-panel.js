// ─── force-panel.js — the Force Projection widget ──────────────────────────────
// A small panel in the map's top-left, shown while the Force Projection layer is
// on: pick one or more alliances, and every system within 20 LY of their
// capitals is ringed by Ansiblex fare zone, with spheres of influence drawn
// around each capital in the 3-D view. It sits on top of whatever overlay is
// active, so it combines with Sovereignty, Influence, bridges and wormholes.
//
// There is nothing to type in. Every alliance's sov capital comes from ESI
// (/sovereignty/systems, is_capital_system) as part of the sov data the map
// already loads, so choosing an alliance is the whole interaction.
//
// Loaded after map.js and reads its globals (_sovMap, _sysById, _fpSelected,
// _allianceNames, _allianceTickers) directly, the way every other renderer
// script in this app does.
'use strict';

/** Alliances that hold sov, largest first, with their capital if they have one. */
function _fpAlliances() {
  const count = new Map();
  for (const h of Object.values(_sovMap || {})) {
    const id = h && (h.allianceId || h.alliance_id);
    if (id) count.set(id, (count.get(id) || 0) + 1);
  }
  const caps = _fpState().capitals;
  return [...count.entries()]
    .map(([id, systems]) => ({ id: Number(id), systems, capitalId: caps[id] || null }))
    .sort((a, b) => b.systems - a.systems);
}

function _fpLabel(id) {
  const name = _allianceNames[id], tick = _allianceTickers[id];
  if (name && tick) return `${name} [${tick}]`;
  return name || (tick ? `[${tick}]` : `Alliance ${id}`);
}

function _fpEsc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function _fpRender() {
  const w = document.getElementById('mapFpWidget');
  if (!w) return;
  const all = _fpAlliances();
  const byId = new Map(all.map(a => [a.id, a]));

  // The picker: every sov-holding alliance not already chosen.
  const dl = document.getElementById('fpAllyList');
  if (dl) {
    dl.innerHTML = all.filter(a => !_fpSelected.has(a.id))
      .map(a => `<option value="${_fpEsc(_fpLabel(a.id))}"></option>`).join('');
  }

  // Chosen alliances, each with the capital ESI reports for it.
  const picked = document.getElementById('fpPicked');
  if (picked) {
    picked.innerHTML = [..._fpSelected].map(id => {
      const a = byId.get(id);
      const cap = a && a.capitalId ? _sysById[a.capitalId] : null;
      const where = cap ? _fpEsc(cap.name)
        : '<span class="fp-nocap">no sov capital</span>';
      return `<div class="fp-pick">
        <div class="fp-pick-main">
          <span class="fp-pick-name">${_fpEsc(_fpLabel(id))}</span>
          <span class="fp-pick-cap">${where}</span>
        </div>
        <button class="icon-btn fp-remove" data-alliance="${id}" title="Remove"
                aria-label="Remove ${_fpEsc(_fpLabel(id))}">✕</button>
      </div>`;
    }).join('');
    picked.querySelectorAll('.fp-remove').forEach(b => b.addEventListener('click', () => {
      _fpSelected.delete(Number(b.dataset.alliance));
      _fpCommit();
    }));
  }

  const hint = document.getElementById('fpHint');
  if (hint) {
    if (!Object.keys(_sovMap || {}).length) {
      hint.textContent = 'Waiting for sovereignty data…';
    } else if (!_fpSelected.size) {
      hint.textContent = 'Pick an alliance to see where it can project to.';
    } else if (_viewMode !== 'spatial' || _camFlat) {
      // Rings still mark every zone here; only the spheres need true distance.
      hint.textContent = 'Rings mark each zone. Spheres need true distance — use Spatial with Flat off.';
    } else {
      hint.textContent = '';
    }
  }
}

/** Persist the selection and redraw the map with it. */
function _fpCommit() {
  _fpSaveSelected();
  _fpRender();
  if (typeof _scheduleRender === 'function') _scheduleRender();
}

function _fpPick(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  const hit = _fpAlliances().find(a => _fpLabel(a.id).toLowerCase() === t)
    // A typed name or ticker without the other half still finds its alliance.
    || _fpAlliances().find(a => {
      const n = (_allianceNames[a.id] || '').toLowerCase(), k = (_allianceTickers[a.id] || '').toLowerCase();
      return n === t || k === t;
    });
  if (!hit) return false;
  _fpSelected.add(hit.id);
  _fpCommit();
  return true;
}

function _fpBuild() {
  const host = document.getElementById('mapViewport');
  if (!host || document.getElementById('mapFpWidget')) return;
  const w = document.createElement('div');
  w.id = 'mapFpWidget';
  w.className = 'map-fp-widget is-hidden';
  w.innerHTML = `
    <div class="map-legend-title">FORCE PROJECTION</div>
    <div id="fpPicked" class="fp-picked"></div>
    <input id="fpSearch" class="field-input fp-search" list="fpAllyList" autocomplete="off"
           spellcheck="false" placeholder="Select your alliance…" aria-label="Select an alliance">
    <datalist id="fpAllyList"></datalist>
    <div id="fpHint" class="fp-hint"></div>`;
  host.appendChild(w);

  const input = w.querySelector('#fpSearch');
  const tryPick = () => {
    if (_fpPick(input.value)) { input.value = ''; input.classList.remove('fp-bad'); }
    else if (input.value.trim()) input.classList.add('fp-bad');
  };
  // `change` fires when a datalist option is chosen; Enter covers a typed name.
  input.addEventListener('change', tryPick);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPick(); });
  input.addEventListener('input', () => input.classList.remove('fp-bad'));
}

/**
 * Show or hide the widget to match the Force Projection toggle. Called from
 * _updateLegend, which runs on every toggle and overlay change.
 */
async function _fpSyncWidget() {   // eslint-disable-line no-unused-vars
  _fpBuild();
  const w = document.getElementById('mapFpWidget');
  if (!w) return;
  const on = _showFp;
  w.classList.toggle('is-hidden', !on);
  if (!on) return;
  _fpRender();
  // Names turn a column of alliance ids into something you can pick from.
  const ids = _fpAlliances().map(a => a.id);
  if (ids.length && typeof _fetchAllianceIdents === 'function') {
    const changed = await _fetchAllianceIdents(ids).catch(() => false);
    if (changed) _fpRender();
  }
}
