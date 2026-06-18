// ─── jump-planner.js ──────────────────────────────────────────────────────────
// Capital jump route planner for the Map page (DOTLAN-style).
//
//  • Pick a capital ship + Jump Drive Calibration / Fuel Conservation skills.
//  • Cyno mode  : jump-drive routing — hops between systems within ship range.
//  • Beacon mode: stargate + your manual Ansiblex bridge list (ESI can't expose
//                 real bridges, so you enter them once; stored locally).
//  • Shortest vs Safest toggle. Safest strongly prefers your own alliance's sov
//    and avoids hostile sov / low-sec (most likely place to be dropped on).
//
// All routing is pure client-side over data already served by the map IPCs
// (map-get-galaxy with x/y/z + stargates, map-get-sovereignty).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const JP_LY = 9.4607e15;            // metres per light-year
const JP_JUMPABLE_MAX_SEC = 0.45;   // can't jump to/from systems that display 0.5+

// Ship base jump range (LY, SDE dogma 867) + isotopes/LY (dogma 868).
// JDC adds +25% range per level; JFC cuts fuel 10% per level.
const JP_SHIPS = [
  { id: 'carrier', name: 'Carrier',         range: 3.5, fuel: 3000 },
  { id: 'dread',   name: 'Dreadnought',     range: 3.5, fuel: 3000 },
  { id: 'fax',     name: 'Force Auxiliary', range: 3.5, fuel: 3000 },
  { id: 'super',   name: 'Supercarrier',    range: 3.0, fuel: 3000 },
  { id: 'titan',   name: 'Titan',           range: 3.0, fuel: 3000 },
  { id: 'blops',   name: 'Black Ops',       range: 4.0, fuel: 700  },
  { id: 'jf',      name: 'Jump Freighter',  range: 5.0, fuel: 10000 },
  { id: 'rorqual', name: 'Rorqual',         range: 5.0, fuel: 4000 },
];

const JP_BRIDGE_KEY = 'jump_bridges_v1';   // localStorage: [[idA,idB], …]

// ── Module state ──────────────────────────────────────────────────────────────
let _jpReady       = false;
let _jpById        = {};    // id → { id, name, x, y, z, sec, regionId, regionName, allianceId }
let _jpNames       = [];    // [{ id, name }] sorted, for autocomplete
let _jpNameIndex   = {};    // lowercased name → id
let _jpAdj         = {};    // id → [neighbour ids]  (stargates)
let _jpJumpable    = [];    // system objects with sec < threshold (cyno candidates)
let _jpGrid        = new Map(); // spatial buckets of jumpable systems (cyno neighbour search)
let _jpCell        = 0;     // bucket size in metres
let _jpAllianceId  = null;

function _jpGetBridges() {
  try { const b = JSON.parse(localStorage.getItem(JP_BRIDGE_KEY) || '[]'); return Array.isArray(b) ? b : []; }
  catch (_) { return []; }
}
function _jpSaveBridges(b) { try { localStorage.setItem(JP_BRIDGE_KEY, JSON.stringify(b)); } catch (_) {} }

// ── Load + index galaxy data (once) ─────────────────────────────────────────────
async function _jpLoadData() {
  if (_jpReady) return true;
  const [galaxy, sov] = await Promise.all([
    window.eveAPI.mapGetGalaxy().catch(() => null),
    window.eveAPI.mapGetSovereignty().catch(() => ({})),
  ]);
  if (!galaxy || !Array.isArray(galaxy.systems)) return false;

  const regions = galaxy.regions || {};
  _jpById = {}; _jpNames = []; _jpNameIndex = {}; _jpAdj = {}; _jpJumpable = [];
  for (const s of galaxy.systems) {
    const sv = sov[s.id] || sov[String(s.id)] || {};
    const obj = {
      id: s.id, name: s.name,
      x: +s.x, y: +s.y, z: +s.z,
      sec: typeof s.sec === 'number' ? s.sec : 0,
      regionId: s.regionId, regionName: regions[s.regionId] || '',
      allianceId: sv.allianceId || null,
    };
    _jpById[s.id] = obj;
    _jpNames.push({ id: s.id, name: s.name });
    _jpNameIndex[s.name.toLowerCase()] = s.id;
    if (obj.sec < JP_JUMPABLE_MAX_SEC) _jpJumpable.push(obj);
  }
  _jpNames.sort((a, b) => a.name.localeCompare(b.name));

  for (const j of (galaxy.jumps || [])) {
    (_jpAdj[j.from] || (_jpAdj[j.from] = [])).push(j.to);
  }

  // Spatial grid (~5 LY cells) so cyno neighbour search isn't O(n) per node.
  _jpCell = 5 * JP_LY;
  _jpGrid = new Map();
  for (const s of _jpJumpable) {
    const k = _jpGridKey(s.x, s.y, s.z);
    (_jpGrid.get(k) || _jpGrid.set(k, []).get(k)).push(s);
  }

  // Own alliance from the selected (or first) character.
  try {
    const cid = (typeof selectedCharacterId !== 'undefined' && selectedCharacterId)
      ? selectedCharacterId
      : (await window.eveAPI.getAccounts().catch(() => []))[0]?.characterId;
    if (cid) {
      const data = await window.eveAPI.getCharacterData(cid).catch(() => null);
      _jpAllianceId = data?.info?.alliance_id || null;
    }
  } catch (_) {}

  _jpReady = true;
  return true;
}

function _jpGridKey(x, y, z) {
  return `${Math.floor(x / _jpCell)}|${Math.floor(y / _jpCell)}|${Math.floor(z / _jpCell)}`;
}
function _jpDistLY(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / JP_LY;
}

// Jumpable systems within `rangeLY` of `sys` (uses the spatial grid).
function _jpNeighboursInRange(sys, rangeLY) {
  const out  = [];
  const span = Math.ceil((rangeLY * JP_LY) / _jpCell) + 1;
  const cx = Math.floor(sys.x / _jpCell), cy = Math.floor(sys.y / _jpCell), cz = Math.floor(sys.z / _jpCell);
  for (let ix = -span; ix <= span; ix++)
    for (let iy = -span; iy <= span; iy++)
      for (let iz = -span; iz <= span; iz++) {
        const bucket = _jpGrid.get(`${cx + ix}|${cy + iy}|${cz + iz}`);
        if (!bucket) continue;
        for (const o of bucket) {
          if (o.id === sys.id) continue;
          const d = _jpDistLY(sys, o);
          if (d <= rangeLY) out.push({ sys: o, ly: d });
        }
      }
  return out;
}

// ── Safety weighting (Safest mode) ───────────────────────────────────────────
// Lower = preferred. Own-alliance space is cheapest; hostile sov / low-sec are
// heavily penalised (most likely to be tackled).
function _jpSafety(sys) {
  let w;
  if (_jpAllianceId && sys.allianceId === _jpAllianceId) w = 1;       // your sov
  else if (sys.allianceId)                               w = 12;      // someone else's sov
  else                                                   w = 5;       // neutral / NPC-null / empty
  if (sys.sec >= 0.0 && sys.sec < JP_JUMPABLE_MAX_SEC && sys.sec > 0) w *= 1.4; // low-sec gank risk
  return w;
}

// ── Min-heap (Dijkstra priority queue) ────────────────────────────────────────
function _jpHeap() {
  const a = [];
  return {
    size: () => a.length,
    push(cost, id) {
      a.push([cost, id]); let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
    },
    pop() {
      const top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0;
        for (;;) { let l = 2 * i + 1, r = l + 1, m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
      return top;
    },
  };
}

// ── Routing ───────────────────────────────────────────────────────────────────
// Returns { path:[ids], hops:[{from,to,ly,kind}] } or null if unreachable.
function _jpRoute(startId, endId, opts) {
  const { mode, safest, rangeLY, avoidIncSet } = opts;
  const dist = new Map(), prev = new Map(), kind = new Map(), done = new Set();
  const heap = _jpHeap();
  dist.set(startId, 0); heap.push(0, startId);

  // Beacon mode adjacency: stargates + manual bridges.
  let bridgeAdj = null;
  if (mode === 'beacon') {
    bridgeAdj = {};
    for (const [a, b] of _jpGetBridges()) {
      (bridgeAdj[a] || (bridgeAdj[a] = [])).push(b);
      (bridgeAdj[b] || (bridgeAdj[b] = [])).push(a);
    }
  }

  while (heap.size()) {
    const [d, id] = heap.pop();
    if (done.has(id)) continue;
    done.add(id);
    if (id === endId) break;
    const sys = _jpById[id];
    if (!sys) continue;

    const relax = (toId, edgeCost, k) => {
      if (avoidIncSet && avoidIncSet.has(toId) && toId !== endId) return;
      const w  = safest ? _jpSafety(_jpById[toId]) : 1;
      const nd = d + edgeCost * w;
      if (nd < (dist.has(toId) ? dist.get(toId) : Infinity)) {
        dist.set(toId, nd); prev.set(toId, id); kind.set(toId, k); heap.push(nd, toId);
      }
    };

    if (mode === 'cyno') {
      // only jumpable systems participate; start may be hi-sec only as origin if reachable — but caps can't, so require jumpable
      if (sys.sec >= JP_JUMPABLE_MAX_SEC && id !== startId) continue;
      for (const n of _jpNeighboursInRange(sys, rangeLY)) {
        relax(n.sys.id, n.ly, 'jump');     // cost = light-years
      }
    } else {
      for (const to of (_jpAdj[id] || []))            relax(to, 1, 'gate');   // gate = 1 jump
      for (const to of (bridgeAdj[id] || []))         relax(to, 1, 'bridge'); // bridge = 1 jump
    }
  }

  if (!prev.has(endId) && startId !== endId) return null;
  const path = [endId], hops = [];
  let cur = endId;
  while (cur !== startId) {
    const p = prev.get(cur);
    if (p === undefined) break;
    hops.unshift({ from: p, to: cur, kind: kind.get(cur), ly: _jpDistLY(_jpById[p], _jpById[cur]) });
    path.unshift(p); cur = p;
  }
  return { path, hops };
}

// ── UI ──────────────────────────────────────────────────────────────────────
async function openJumpPlanner() {
  let modal = document.getElementById('jumpPlannerModal');
  if (!modal) { modal = _jpBuildModal(); document.body.appendChild(modal); }
  modal.style.display = 'flex';

  const status = modal.querySelector('#jpStatus');
  status.textContent = 'Loading galaxy data…';
  const ok = await _jpLoadData();
  status.textContent = ok
    ? (_jpAllianceId ? '' : 'No alliance detected — “safest” will just avoid hostile sov & low-sec.')
    : 'Failed to load galaxy data (check Settings → Database).';
  _jpPopulateDatalist();
  _jpRenderBridges(modal);
  await _jpLoadCharSkills(modal);   // auto-fill JDC/JFC/JF from the selected character
  _jpUpdateRangeNote(modal);
}

// Auto-load the selected character's jump skills into the sliders (no-op if no
// character is selected or it hasn't been synced). Skill type IDs: Jump Drive
// Calibration 21611, Jump Fuel Conservation 21610, Jump Freighters 29029.
async function _jpLoadCharSkills(m) {
  const cid = (typeof selectedCharacterId !== 'undefined' && selectedCharacterId)
    ? selectedCharacterId : null;
  if (!cid || !window.eveAPI || !window.eveAPI.getSkillLevels) return;
  const JDC = 21611, JFC = 21610, JF = 29029;
  try {
    const lv = await window.eveAPI.getSkillLevels(cid, [JDC, JFC, JF]);
    if (!lv) return;
    const set = (sliderSel, valSel, level) => {
      if (level == null) return;
      const sl = m.querySelector(sliderSel), vl = m.querySelector(valSel);
      if (sl) sl.value = level;
      if (vl) vl.textContent = level;
    };
    set('#jpJdc', '#jpJdcVal', lv[JDC]);
    set('#jpJfc', '#jpJfcVal', lv[JFC]);
    set('#jpJf',  '#jpJfVal',  lv[JF]);
  } catch (_) { /* keep slider defaults */ }
}

function _jpCloseModal() {
  const m = document.getElementById('jumpPlannerModal');
  if (m) m.style.display = 'none';
}

function _jpBuildModal() {
  const m = document.createElement('div');
  m.id = 'jumpPlannerModal';
  m.className = 'jp-modal-backdrop';
  m.innerHTML = `
    <div class="jp-modal">
      <div class="jp-modal-header">
        <span class="panel-icon">⤓</span><span>Jump Route Planner</span>
        <span id="jpStatus" class="jp-status"></span>
        <button class="icon-btn jp-close" title="Close" style="margin-left:auto;font-size:16px;">✕</button>
      </div>
      <div class="jp-modal-body">
        <div class="jp-form">
          <div class="jp-field">
            <label>From</label>
            <input id="jpFrom" class="field-input" autocomplete="off" spellcheck="false" placeholder="Start system…" list="jpSysList">
          </div>
          <div class="jp-field">
            <label>To</label>
            <input id="jpTo" class="field-input" autocomplete="off" spellcheck="false" placeholder="Destination system…" list="jpSysList">
          </div>
          <datalist id="jpSysList"></datalist>
          <div class="jp-field">
            <label>Ship</label>
            <select id="jpShip" class="field-input" style="cursor:pointer;">
              ${JP_SHIPS.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
            </select>
          </div>
          <div class="jp-field">
            <label>Mode</label>
            <select id="jpMode" class="field-input" style="cursor:pointer;">
              <option value="cyno">Cyno (jump drive)</option>
              <option value="beacon">Beacon network (your bridges)</option>
            </select>
          </div>
          <div class="jp-field">
            <label>Jump Drive Calibration <span id="jpJdcVal" class="jp-skillval">5</span></label>
            <input id="jpJdc" type="range" min="0" max="5" value="5">
          </div>
          <div class="jp-field">
            <label>Jump Fuel Conservation <span id="jpJfcVal" class="jp-skillval">5</span></label>
            <input id="jpJfc" type="range" min="0" max="5" value="5">
          </div>
          <div class="jp-field">
            <label>Jump Freighters <span class="jp-dim" style="font-weight:400;">(JF only)</span> <span id="jpJfVal" class="jp-skillval">5</span></label>
            <input id="jpJf" type="range" min="0" max="5" value="5">
          </div>
          <div class="jp-toggles">
            <label class="jp-check"><input type="checkbox" id="jpSafest"> Safest route (prefer your space)</label>
            <label class="jp-check"><input type="checkbox" id="jpAvoidInc"> Avoid incursions</label>
          </div>
          <button id="jpPlotBtn" class="calc-btn" style="width:100%;margin-top:6px;">PLOT ROUTE</button>
          <div class="jp-range-note" id="jpRangeNote"></div>

          <div class="jp-bridges">
            <div class="jp-bridges-title">Beacon network <span style="color:var(--text-3);font-weight:400;">(Ansiblex bridges — entered manually)</span></div>
            <div style="display:flex;gap:6px;">
              <input id="jpBridgeA" class="field-input" placeholder="System A" list="jpSysList" style="flex:1;">
              <input id="jpBridgeB" class="field-input" placeholder="System B" list="jpSysList" style="flex:1;">
              <button id="jpBridgeAdd" class="icon-btn" style="padding:4px 10px;">＋</button>
            </div>
            <div id="jpBridgeList" class="jp-bridge-list"></div>
          </div>
        </div>
        <div class="jp-result" id="jpResult">
          <div class="jp-empty">Enter a start and destination, then plot a route.</div>
        </div>
      </div>
    </div>`;

  // Populate the shared system datalist once.
  m.addEventListener('click', (e) => { if (e.target === m) _jpCloseModal(); });
  m.querySelector('.jp-close').addEventListener('click', _jpCloseModal);
  m.querySelector('#jpJdc').addEventListener('input', e => { m.querySelector('#jpJdcVal').textContent = e.target.value; _jpUpdateRangeNote(m); });
  m.querySelector('#jpJfc').addEventListener('input', e => { m.querySelector('#jpJfcVal').textContent = e.target.value; });
  m.querySelector('#jpJf').addEventListener('input', e => { m.querySelector('#jpJfVal').textContent = e.target.value; });
  m.querySelector('#jpShip').addEventListener('change', () => _jpUpdateRangeNote(m));
  m.querySelector('#jpMode').addEventListener('change', () => _jpUpdateRangeNote(m));
  m.querySelector('#jpPlotBtn').addEventListener('click', () => _jpPlot(m));
  m.querySelector('#jpBridgeAdd').addEventListener('click', () => _jpAddBridge(m));
  return m;
}

function _jpShipById(id) { return JP_SHIPS.find(s => s.id === id) || JP_SHIPS[0]; }
function _jpRangeFor(shipId, jdc) { return JumpMath.jumpRange(_jpShipById(shipId).range, jdc); }

function _jpUpdateRangeNote(m) {
  const ship = _jpShipById(m.querySelector('#jpShip').value);
  const jdc  = +m.querySelector('#jpJdc').value;
  const note = m.querySelector('#jpRangeNote');
  if (m.querySelector('#jpMode').value === 'beacon') {
    note.textContent = 'Beacon mode routes over stargates + your saved bridges (ship range ignored).';
  } else {
    note.textContent = `${ship.name} jump range: ${_jpRangeFor(ship.id, jdc).toFixed(2)} LY (JDC ${jdc}).`;
  }
}

// Resolve a typed system name (datalist may store the exact name).
function _jpResolveSystem(text) {
  if (!text) return null;
  const id = _jpNameIndex[text.trim().toLowerCase()];
  return id ? _jpById[id] : null;
}

async function _jpPlot(m) {
  const result = m.querySelector('#jpResult');
  const from = _jpResolveSystem(m.querySelector('#jpFrom').value);
  const to   = _jpResolveSystem(m.querySelector('#jpTo').value);
  if (!from || !to) { result.innerHTML = `<div class="jp-empty jp-err">Pick valid start and destination systems.</div>`; return; }
  if (from.id === to.id) { result.innerHTML = `<div class="jp-empty">Start and destination are the same system.</div>`; return; }

  const mode    = m.querySelector('#jpMode').value;
  const safest  = m.querySelector('#jpSafest').checked;
  const shipId  = m.querySelector('#jpShip').value;
  const jdc     = +m.querySelector('#jpJdc').value;
  const jfc     = +m.querySelector('#jpJfc').value;
  const jf      = +m.querySelector('#jpJf').value;
  const rangeLY = _jpRangeFor(shipId, jdc);

  if (mode === 'cyno' && (from.sec >= JP_JUMPABLE_MAX_SEC || to.sec >= JP_JUMPABLE_MAX_SEC)) {
    result.innerHTML = `<div class="jp-empty jp-err">Capitals can't jump to/from high-sec. Use Beacon mode, or pick low-sec/null endpoints.</div>`;
    return;
  }

  let avoidIncSet = null;
  if (m.querySelector('#jpAvoidInc').checked) {
    try {
      const inc = await window.eveAPI.mapGetIncursions();
      avoidIncSet = new Set(Array.isArray(inc) ? inc : []);
    } catch (_) {}
  }

  result.innerHTML = `<div class="jp-empty">Plotting…</div>`;
  // Defer so the "Plotting…" paint happens before the (synchronous) search.
  setTimeout(() => {
    const route = _jpRoute(from.id, to.id, { mode, safest, rangeLY, avoidIncSet });
    if (!route) {
      result.innerHTML = `<div class="jp-empty jp-err">No route found${mode === 'cyno' ? ' within jump range' : ''}.${mode === 'beacon' ? ' Add bridges or try Cyno mode.' : ''}</div>`;
      return;
    }
    _jpRenderRoute(result, route, { mode, safest, shipId, jfc, jf });
  }, 20);
}

function _jpSecColor(sec) {
  if (sec >= 0.45) return '#48f0c0';
  if (sec >= 0.25) return '#f0b000';
  if (sec > 0.0)   return '#f06000';
  return '#e05252';
}

function _jpRenderRoute(container, route, opts) {
  const { mode, safest, shipId, jfc, jf } = opts;
  const ship = _jpShipById(shipId);
  const isJF = ship.id === 'jf';   // Jump Freighters skill only reduces JF fuel
  let totalLY = 0, totalFuel = 0;

  const rows = route.hops.map((hop, i) => {
    const sys = _jpById[hop.to];
    const own = _jpAllianceId && sys.allianceId === _jpAllianceId;
    const sovDot = own ? '#4ecbb0' : (sys.allianceId ? '#e05252' : '#777');
    const sovTxt = own ? 'your sov' : (sys.allianceId ? 'hostile sov' : 'neutral');
    let kindCell, fuel = 0;
    if (hop.kind === 'jump') {
      totalLY += hop.ly;
      fuel = JumpMath.jumpHopFuel(hop.ly, ship.fuel, jfc, jf, isJF);
      totalFuel += fuel;
      kindCell = `${hop.ly.toFixed(2)} LY`;
    } else {
      kindCell = hop.kind === 'bridge' ? '◈ bridge' : 'gate';
    }
    return `
      <tr>
        <td class="jp-num">${i + 1}</td>
        <td><span class="jp-secdot" style="background:${_jpSecColor(sys.sec)}"></span>${escHtml(sys.name)}</td>
        <td class="jp-dim">${escHtml(sys.regionName)}</td>
        <td class="jp-right">${kindCell}</td>
        <td class="jp-right jp-dim">${hop.kind === 'jump' ? fuel.toLocaleString() : '—'}</td>
        <td><span class="jp-secdot" style="background:${sovDot}"></span><span class="jp-dim">${sovTxt}</span></td>
      </tr>`;
  }).join('');

  const startSys = _jpById[route.path[0]];
  const jumps = route.hops.length;
  const banner = safest
    ? `<div class="jp-banner jp-banner-safe">🛡 Safest route — prefers your alliance space and avoids hostile sov / low-sec. May be longer than the shortest path.</div>`
    : `<div class="jp-banner">⤓ Shortest route — minimises ${mode === 'cyno' ? 'total light-years' : 'jumps'}, ignoring safety.</div>`;

  container.innerHTML = `
    ${banner}
    <div class="jp-totals">
      <div><span class="jp-tot-num">${jumps}</span><span class="jp-tot-lbl">${mode === 'cyno' ? 'jumps' : 'hops'}</span></div>
      ${mode === 'cyno' ? `<div><span class="jp-tot-num">${totalLY.toFixed(1)}</span><span class="jp-tot-lbl">LY total</span></div>
                           <div><span class="jp-tot-num">${totalFuel.toLocaleString()}</span><span class="jp-tot-lbl">isotopes</span></div>` : ''}
    </div>
    <button id="jpShowMapBtn" class="icon-btn" style="width:100%;margin:4px 0 8px;padding:6px;font-size:12px;cursor:pointer;">🗺 Show route on map</button>
    <table class="jp-route-table">
      <thead><tr><th></th><th>System</th><th>Region</th><th class="jp-right">${mode === 'cyno' ? 'Range' : 'Via'}</th><th class="jp-right">Fuel</th><th>Sov</th></tr></thead>
      <tbody>
        <tr class="jp-origin">
          <td class="jp-num">●</td>
          <td><span class="jp-secdot" style="background:${_jpSecColor(startSys.sec)}"></span>${escHtml(startSys.name)} <span class="jp-dim">(start)</span></td>
          <td class="jp-dim">${escHtml(startSys.regionName)}</td>
          <td class="jp-right">—</td><td class="jp-right jp-dim">—</td>
          <td><span class="jp-secdot" style="background:${(_jpAllianceId && startSys.allianceId === _jpAllianceId) ? '#4ecbb0' : (startSys.allianceId ? '#e05252' : '#777')}"></span></td>
        </tr>
        ${rows}
      </tbody>
    </table>`;

  // "Show route on map" — close the planner, open the Map page, draw the route.
  const mapBtn = container.querySelector('#jpShowMapBtn');
  if (mapBtn) mapBtn.addEventListener('click', () => {
    _jpCloseModal();
    if (typeof navigateToPage === 'function') navigateToPage('map');
    // Give the map page a moment to mount before drawing the route.
    setTimeout(() => { if (typeof window.mapShowRoute === 'function') window.mapShowRoute(route.path); }, 220);
  });
}

// ── Manual bridge list ────────────────────────────────────────────────────────
function _jpAddBridge(m) {
  const a = _jpResolveSystem(m.querySelector('#jpBridgeA').value);
  const b = _jpResolveSystem(m.querySelector('#jpBridgeB').value);
  if (!a || !b || a.id === b.id) {
    if (typeof showToast === 'function') showToast('Enter two valid, different systems for the bridge.', 'error');
    return;
  }
  const bridges = _jpGetBridges();
  if (!bridges.some(([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id))) {
    bridges.push([a.id, b.id]);
    _jpSaveBridges(bridges);
  }
  m.querySelector('#jpBridgeA').value = '';
  m.querySelector('#jpBridgeB').value = '';
  _jpRenderBridges(m);
}

function _jpRenderBridges(m) {
  const list = m.querySelector('#jpBridgeList');
  if (!list) return;
  const bridges = _jpGetBridges();
  if (!bridges.length) { list.innerHTML = `<div class="jp-dim" style="padding:6px 0;font-size:11px;">No bridges saved.</div>`; return; }
  list.innerHTML = bridges.map(([a, b], i) => `
    <div class="jp-bridge-row">
      <span>◈ ${escHtml(_jpById[a]?.name || a)} ↔ ${escHtml(_jpById[b]?.name || b)}</span>
      <button class="jp-bridge-del" data-i="${i}" title="Remove">✕</button>
    </div>`).join('');
  list.querySelectorAll('.jp-bridge-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const bridges = _jpGetBridges();
      bridges.splice(+btn.dataset.i, 1);
      _jpSaveBridges(bridges);
      _jpRenderBridges(m);
    });
  });
}

// Populate the system datalist when data is ready (called from _jpLoadData via openJumpPlanner).
function _jpPopulateDatalist() {
  const dl = document.getElementById('jpSysList');
  if (!dl || dl._filled || !_jpNames.length) return;
  dl.innerHTML = _jpNames.map(s => `<option value="${escHtml(s.name)}"></option>`).join('');
  dl._filled = true;
}
