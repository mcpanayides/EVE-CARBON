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

// Zarzakh — the Triglavian hub. Routing *through* it is a trap: entering via a
// regional gate triggers a 6-hour "Emanation Lock" that bars leaving via any other
// regional gate, so it's never the quick cross-region shortcut the gate graph makes
// it look like. The planners avoid it by default (toggle off to allow).
const JP_ZARZAKH_ID = 30100000;
// Cyno-jammed systems: jump drives and cynosural fields are disabled, so capitals
// can only transit them via stargates (never cyno in or out). Zarzakh is the
// permanent one.
const JP_CYNO_JAMMED = new Set([JP_ZARZAKH_ID]);

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

// Saved Ansiblex bridges live in the encrypted main-process store (NOT
// localStorage). _jpBridgeCache holds them in memory so routing can read them
// synchronously; it's filled by _jpLoadBridges() when the planner opens.
let _jpBridgeCache = [];

// Cost (in LY-equivalent) the router pays to traverse one inter-regional ("regional")
// stargate in cyno mode. Set low so a single regional gate is preferred over jumping
// the same region boundary in multiple cyno hops — i.e. regional gates act as
// long-haul shortcuts. Safety weighting still multiplies this like any other edge.
const JP_REGIONAL_GATE_COST = 1.5;

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
let _jpStandings   = {};    // contactId → standing, from the main/favourite char's ALLIANCE contacts
let _jpStandingsError = null; // 'reauth' | message | null — why alliance standings are unavailable
let _jpRegionalGates = {};  // id → [neighbour ids] reachable via an inter-regional stargate
let _jpWaypoints   = [];    // ordered [system id, …] forced intermediate stops (manual)
let _jpLastRoute   = null;  // last plotted route, so Minimize can redraw it on the map
let _jpLastPlotCtx = null;  // { fromId, toId, mode, safest, rangeLY, … } to re-plot after edits
let _jpAvoid       = new Set(); // systems the user removed from the route — routed around

async function _jpLoadBridges() {
  try { _jpBridgeCache = await window.eveAPI.getJumpBridges() || []; }
  catch (_) { _jpBridgeCache = []; }
}
function _jpGetBridges() { return _jpBridgeCache; }
function _jpSaveBridges(b) {
  _jpBridgeCache = Array.isArray(b) ? b : [];
  if (window.eveAPI && window.eveAPI.saveJumpBridges) window.eveAPI.saveJumpBridges(_jpBridgeCache).catch(() => {});
  if (typeof window.mapReloadBridges === 'function') window.mapReloadBridges();   // live-update the map arcs
}

// ── Load + index galaxy data (once) ─────────────────────────────────────────────
async function _jpLoadData() {
  if (_jpReady) return true;
  const [galaxy, sov] = await Promise.all([
    window.eveAPI.mapGetGalaxy().catch(() => null),
    window.eveAPI.mapGetSovereignty().catch(() => ({})),
  ]);
  if (!galaxy || !Array.isArray(galaxy.systems)) return false;

  const regions = galaxy.regions || {};
  _jpById = {}; _jpNames = []; _jpNameIndex = {}; _jpAdj = {}; _jpJumpable = []; _jpRegionalGates = {};
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
    // Cyno-jammed systems stay out of the jump grid so nothing can cyno INTO them
    // (they remain in _jpById/_jpRegionalGates so caps can still gate through).
    if (obj.sec < JP_JUMPABLE_MAX_SEC && !JP_CYNO_JAMMED.has(obj.id)) _jpJumpable.push(obj);
  }
  _jpNames.sort((a, b) => a.name.localeCompare(b.name));

  for (const j of (galaxy.jumps || [])) {
    (_jpAdj[j.from] || (_jpAdj[j.from] = [])).push(j.to);
    // Regional gate = a stargate whose two endpoints sit in different regions.
    // We only keep those a capital could actually use: both ends must be jumpable
    // (low/null), since caps can't take a gate into high-sec. The jumps table holds
    // both directions, so building a directional map here is sufficient.
    const a = _jpById[j.from], b = _jpById[j.to];
    if (a && b && a.regionId !== b.regionId
        && a.sec < JP_JUMPABLE_MAX_SEC && b.sec < JP_JUMPABLE_MAX_SEC) {
      (_jpRegionalGates[j.from] || (_jpRegionalGates[j.from] = [])).push(j.to);
    }
  }

  // Spatial grid (~5 LY cells) so cyno neighbour search isn't O(n) per node.
  _jpCell = 5 * JP_LY;
  _jpGrid = new Map();
  for (const s of _jpJumpable) {
    const k = _jpGridKey(s.x, s.y, s.z);
    (_jpGrid.get(k) || _jpGrid.set(k, []).get(k)).push(s);
  }

  _jpReady = true;
  return true;
}

// Resolve the main/favourite character and load its ALLIANCE-set standings (blue/red).
// Run on every planner open (cheap, server-cached) so re-authenticating a character
// to grant the alliance-contacts scope takes effect without an app restart.
// Preference order: a favourited character, then the selected one, then the first.
async function _jpRefreshAllianceStandings() {
  _jpStandings = {}; _jpStandingsError = null;
  try {
    const accounts = (await window.eveAPI.getAccounts().catch(() => [])) || [];
    let favId = null;
    try {
      const favs = JSON.parse(localStorage.getItem('char_favorites') || '[]');
      favId = (Array.isArray(favs) ? favs : []).map(String)
        .find(f => accounts.some(a => String(a.characterId) === f));
    } catch (_) {}
    const cid = favId
      || (typeof selectedCharacterId !== 'undefined' && selectedCharacterId ? selectedCharacterId : null)
      || accounts[0]?.characterId;
    if (!cid) return;
    const data = await window.eveAPI.getCharacterData(cid).catch(() => null);
    _jpAllianceId = data?.info?.alliance_id || null;
    if (!_jpAllianceId) { _jpStandingsError = 'no-alliance'; return; }
    const res = await window.eveAPI.getAllianceContacts(cid, _jpAllianceId);
    if (res && res.ok) _jpStandings = res.standings || {};
    else _jpStandingsError = res?.needsReauth ? 'reauth' : (res?.error || 'unavailable');
  } catch (e) { _jpStandingsError = e.message || 'unavailable'; }
}

// Classify a system's sov holder relative to the main char's alliance standings.
// Returns { kind, label, color, weight } — weight feeds the Safest routing cost.
function _jpSovClass(sys) {
  if (_jpAllianceId && sys.allianceId === _jpAllianceId) {
    return { kind: 'own', label: 'your sov', color: '#4ecbb0', weight: 1 };
  }
  if (sys.allianceId != null) {
    const st = _jpStandings[sys.allianceId];
    if (st != null && st >= 5)  return { kind: 'blue', label: `blue +${st}`, color: '#4aa3ff', weight: 2 };
    if (st != null && st <= -5) return { kind: 'red',  label: `red ${st}`,   color: '#e05252', weight: 14 };
    return { kind: 'sov', label: 'neutral sov', color: '#c9a14a', weight: 7 };
  }
  return { kind: 'none', label: 'neutral', color: '#777', weight: 5 };
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
// Lower = preferred. Your sov is cheapest; alliance-blue space is cheap; red sov is
// heavily penalised; low-sec adds gank risk. Weights come from _jpSovClass so the
// alliance's own standings (blue/red) drive the route, not just "mine vs theirs".
function _jpSafety(sys) {
  let w = _jpSovClass(sys).weight;
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
  const { mode, safest, rangeLY, avoidIncSet, useRegionalGates, avoidZarzakh } = opts;
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
      // User-removed systems are routed around (never the leg's own endpoints).
      if (_jpAvoid.has(toId) && toId !== endId && toId !== startId) return;
      // Zarzakh trap: its 6h gate lock means you can't gate straight out the far
      // side, so don't route through it unless it's an explicit endpoint.
      if (avoidZarzakh && toId === JP_ZARZAKH_ID && toId !== endId && toId !== startId) return;
      const w  = safest ? _jpSafety(_jpById[toId]) : 1;
      const nd = d + edgeCost * w;
      if (nd < (dist.has(toId) ? dist.get(toId) : Infinity)) {
        dist.set(toId, nd); prev.set(toId, id); kind.set(toId, k); heap.push(nd, toId);
      }
    };

    if (mode === 'cyno') {
      // only jumpable systems participate; start may be hi-sec only as origin if reachable — but caps can't, so require jumpable
      if (sys.sec >= JP_JUMPABLE_MAX_SEC && id !== startId) continue;
      // No cyno OUT of a cyno-jammed system (e.g. Zarzakh) — only gate transit.
      if (!JP_CYNO_JAMMED.has(id)) {
        for (const n of _jpNeighboursInRange(sys, rangeLY)) {
          relax(n.sys.id, n.ly, 'jump');     // cost = light-years
        }
      }
      // Optional: hop across a region boundary via a single regional stargate
      // instead of cyno-jumping it. Cheap fixed cost so it wins for long hauls.
      // (This is how a cap transits Zarzakh — gate in, gate out.)
      if (useRegionalGates) {
        for (const to of (_jpRegionalGates[id] || [])) relax(to, JP_REGIONAL_GATE_COST, 'rgate');
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

// ── Multi-stop routing (manual waypoints) ─────────────────────────────────────
// Routes through an ordered list of stops [from, …waypoints, to] by solving each
// consecutive leg independently and stitching the legs together. Returns the same
// { path, hops } shape plus a Set of the waypoint ids (so the UI can flag them),
// or { error:{ fromId, toId } } naming the leg that couldn't be routed.
function _jpRouteMulti(stopIds, opts) {
  let path = [], hops = [];
  for (let i = 0; i < stopIds.length - 1; i++) {
    const a = stopIds[i], b = stopIds[i + 1];
    if (a === b) continue;                       // skip a no-op leg
    const seg = _jpRoute(a, b, opts);
    if (!seg) return { error: { fromId: a, toId: b } };
    if (!path.length) path = seg.path.slice();
    else path = path.concat(seg.path.slice(1));  // drop the junction shared with prev leg
    hops = hops.concat(seg.hops);
  }
  return { path, hops, waypointIds: new Set(stopIds.slice(1, -1)) };
}

// ── UI ──────────────────────────────────────────────────────────────────────
async function openJumpPlanner() {
  let modal = document.getElementById('jumpPlannerModal');
  if (!modal) { modal = _jpBuildModal(); document.body.appendChild(modal); }
  modal.style.display = 'flex';
  const pill = document.getElementById('jpRestorePill');
  if (pill) pill.style.display = 'none';

  const status = modal.querySelector('#jpStatus');
  status.textContent = 'Loading galaxy data…';
  const ok = await _jpLoadData();
  await _jpRefreshAllianceStandings();   // refresh blue/red each open (post-reauth aware)
  if (!ok) {
    status.textContent = 'Failed to load galaxy data (check Settings → Database).';
  } else if (!_jpAllianceId) {
    status.textContent = 'No alliance detected — “safest” will just avoid hostile sov & low-sec.';
  } else if (_jpStandingsError === 'reauth') {
    status.textContent = '⚠ Alliance standings need access — re-add this character to grant the alliance-contacts scope.';
  } else if (Object.keys(_jpStandings).length) {
    status.textContent = `Blue/red from alliance standings (${Object.keys(_jpStandings).length} contacts).`;
  } else {
    status.textContent = '';
  }
  _jpPopulateDatalist();
  await _jpLoadBridges();   // pull the saved network from the encrypted store
  _jpRenderBridges(modal);
  _jpRenderWaypoints(modal);
  await _jpLoadCharSkills(modal);   // auto-fill JDC/JFC/JF from the selected character
  _jpUpdateRangeNote(modal);
  _jpApplyPendingEndpoints(modal, true);   // From/To set on the map → fill & auto-plot
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
  const pill = document.getElementById('jpRestorePill');
  if (pill) pill.style.display = 'none';
}

// ── Minimize / restore ────────────────────────────────────────────────────────
// Minimize hides the planner (its DOM — inputs, plotted route, waypoints — stays
// intact so everything is remembered) and draws the current route on the map so
// the user can study it. A floating pill restores the planner exactly as it was.
function _jpMinimize() {
  const m = document.getElementById('jumpPlannerModal');
  if (m) m.style.display = 'none';
  _jpShowRestorePill();
  if (_jpLastRoute && _jpLastRoute.path && _jpLastRoute.path.length) {
    if (typeof navigateToPage === 'function') navigateToPage('map');
    setTimeout(() => {
      if (typeof window.mapShowJumpRoute === 'function') {
        window.mapShowJumpRoute(_jpLastRoute.path, [...(_jpLastRoute.waypointIds || [])]);
      }
    }, 220);
  }
}

function _jpRestore() {
  const pill = document.getElementById('jpRestorePill');
  if (pill) pill.style.display = 'none';
  const m = document.getElementById('jumpPlannerModal');
  if (m) m.style.display = 'flex';   // state was never torn down — restores as-is
}

function _jpShowRestorePill() {
  let pill = document.getElementById('jpRestorePill');
  if (!pill) {
    pill = document.createElement('button');
    pill.id = 'jpRestorePill';
    pill.title = 'Restore Jump Route Planner';
    pill.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:10050;'
      + 'display:flex;align-items:center;gap:8px;background:var(--bg-card);'
      + 'border:1px solid var(--accent);color:var(--text-1);border-radius:20px;'
      + 'padding:8px 16px;font-size:12px;font-family:var(--mono,monospace);cursor:pointer;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,0.5);';
    pill.addEventListener('click', _jpRestore);
    document.body.appendChild(pill);
  }
  const jumps = _jpLastRoute ? _jpLastRoute.hops.length : 0;
  pill.innerHTML = `⤓ Jump Planner${jumps ? ` · ${jumps} jumps` : ''} <span style="opacity:.7;">▢</span>`;
  pill.style.display = 'flex';
}

// ── Map right-click → insert as a mid waypoint ─────────────────────────────────
// Entry point the map calls when a system is right-clicked. Shows a popup offering
// to splice the clicked system into the route as a mid, between the nearest pair of
// consecutive route systems that are both within jump range of it.
// True when a capital jump route is currently plotted (used by the map's context
// menu to decide whether to offer the jump-planner waypoint options).
window.jpHasActiveRoute = function () {
  return !!(_jpLastRoute && Array.isArray(_jpLastRoute.path) && _jpLastRoute.path.length > 1);
};

// Receive From/To from the map (right-click set start/destination). Stored as
// pending and applied — with an auto-plot — when the planner opens (or immediately
// if it's already open). Lets the same map selection drive both planners.
let _jpPendingFrom = null, _jpPendingTo = null;
window.jpSetEndpoints = function (fromId, toId) {
  _jpPendingFrom = fromId || null;
  _jpPendingTo   = toId   || null;
  const m = document.getElementById('jumpPlannerModal');
  if (m && m.style.display !== 'none' && _jpReady) _jpApplyPendingEndpoints(m, true);
};
function _jpApplyPendingEndpoints(m, autoPlot) {
  if (!m || (!_jpPendingFrom && !_jpPendingTo)) return;
  const fromSys = _jpPendingFrom != null ? _jpById[_jpPendingFrom] : null;
  const toSys   = _jpPendingTo   != null ? _jpById[_jpPendingTo]   : null;
  if (fromSys) m.querySelector('#jpFrom').value = fromSys.name;
  if (toSys)   m.querySelector('#jpTo').value   = toSys.name;
  const both = fromSys && toSys;
  _jpPendingFrom = _jpPendingTo = null;
  if (autoPlot && both) _jpPlot(m);
}

// Compute a capital jump route for the given endpoints and draw it on the map
// (pink arcs) WITHOUT opening the planner — so the jump and stargate plots show
// together when a route is set from the map. Uses the modal's current ship/skills
// if it's open, else defaults (Carrier, JDC 5). Skips fitting (the stargate route
// already centres the view) and bails if a capital couldn't make the trip.
window.jpPlotToMap = async function (fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  if (!_jpReady) await _jpLoadData();
  await _jpRefreshAllianceStandings();
  const from = _jpById[fromId], to = _jpById[toId];
  if (!from || !to || to.sec >= JP_JUMPABLE_MAX_SEC) return;   // can't jump INTO high-sec
  const m = document.getElementById('jumpPlannerModal');
  const shipId = m ? m.querySelector('#jpShip').value : 'carrier';
  const jdc    = m ? +m.querySelector('#jpJdc').value : 5;
  const safest = m ? m.querySelector('#jpSafest').checked : false;
  const useRG  = m ? m.querySelector('#jpRegional').checked : false;
  const avoidZarzakh = m ? m.querySelector('#jpAvoidZarzakh').checked : true;
  const route  = _jpRouteMulti([from.id, to.id], {
    mode: 'cyno', safest, rangeLY: _jpRangeFor(shipId, jdc), avoidIncSet: null, useRegionalGates: useRG, avoidZarzakh,
  });
  if (route.error) return;
  _jpLastRoute = route;
  if (typeof window.mapShowJumpRoute === 'function') {
    window.mapShowJumpRoute(route.path, [...(route.waypointIds || [])], false);
  }
};

window.jpHandleMapRightClick = function (systemId, clientX, clientY) {
  if (!_jpById[systemId]) {
    if (typeof showToast === 'function') showToast('Open the Jump Planner and plot a route first.', 'info');
    return;
  }
  _jpShowMapMenu(systemId, clientX, clientY);
};

// Consecutive route segments A→B where the clicked system X can sit as a mid
// (X within jump range of BOTH A and B). Sorted by least added distance.
function _jpReplaceCandidates(systemId) {
  const X = _jpById[systemId];
  const range = _jpLastPlotCtx ? _jpLastPlotCtx.rangeLY : 0;
  if (!X || !range || !_jpLastRoute || !Array.isArray(_jpLastRoute.path)) return [];
  const path = _jpLastRoute.path;
  const out = [], seen = new Set();
  for (let i = 0; i < path.length - 1; i++) {
    const A = _jpById[path[i]], B = _jpById[path[i + 1]];
    if (!A || !B) continue;
    const dAX = _jpDistLY(A, X), dXB = _jpDistLY(X, B);
    if (dAX <= range && dXB <= range) {
      const key = `${A.id}>${B.id}`;
      if (seen.has(key)) continue; seen.add(key);
      out.push({ i, A, B, dAX, dXB, detour: dAX + dXB - _jpDistLY(A, B) });
    }
  }
  out.sort((p, q) => p.detour - q.detour);
  return out.slice(0, 4);
}

// Alternative mids for an auto-generated route node: other jumpable systems that
// can bridge the SAME gap (within jump range of both its route neighbours A and B),
// excluding systems already on the route or avoided. Sorted by least added distance.
function _jpMidAlternatives(systemId) {
  if (!_jpLastRoute || !Array.isArray(_jpLastRoute.path)) return [];
  const path = _jpLastRoute.path;
  const i = path.indexOf(systemId);
  if (i < 1 || i >= path.length - 1) return [];
  const A = _jpById[path[i - 1]], B = _jpById[path[i + 1]];
  const range = _jpLastPlotCtx ? _jpLastPlotCtx.rangeLY : 0;
  if (!A || !B || !range) return [];
  const dAB = _jpDistLY(A, B);
  const onPath = new Set(path);
  const out = [];
  for (const { sys: Y } of _jpNeighboursInRange(A, range)) {
    if (Y.id === systemId || onPath.has(Y.id) || _jpAvoid.has(Y.id)) continue;
    if (Y.sec >= JP_JUMPABLE_MAX_SEC) continue;
    const dYB = _jpDistLY(Y, B);
    if (dYB > range) continue;
    out.push({ Y, dAY: _jpDistLY(A, Y), dYB, detour: _jpDistLY(A, Y) + dYB - dAB });
  }
  out.sort((p, q) => p.detour - q.detour);
  return out.slice(0, 6);
}

// Swap an auto mid for a chosen alternative: force the route through the alternative
// at that spot. The original mid drops out naturally (the direct A→alt→B path is
// cheaper than detouring back through it).
function _jpUseMidAlternative(midId, altId) {
  const i = (_jpLastRoute.path || []).indexOf(midId);
  if (i >= 1) _jpInsertWaypointAtSegment(altId, i - 1);
}

// Cheapest-insertion: the route-path segment (A→B) where slotting X in adds the
// least straight-line distance. Works for far systems too — the router then fills
// the A→X and X→B legs with however many cyno hops are needed. Returns -1 if none.
function _jpBestInsertionSegment(systemId) {
  const X = _jpById[systemId];
  if (!X || !_jpLastRoute || !Array.isArray(_jpLastRoute.path)) return -1;
  const path = _jpLastRoute.path;
  let bestI = -1, bestDetour = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const A = _jpById[path[i]], B = _jpById[path[i + 1]];
    if (!A || !B) continue;
    const detour = _jpDistLY(A, X) + _jpDistLY(X, B) - _jpDistLY(A, B);
    if (detour < bestDetour) { bestDetour = detour; bestI = i; }
  }
  return bestI;
}

// Splice X into the manual waypoint list so it's visited within segment i (A→B),
// then re-plot. Reverts cleanly if the new route can't be solved.
function _jpInsertWaypointAtSegment(systemId, segIndex) {
  if (_jpWaypoints.includes(systemId)) return;
  const path = _jpLastRoute.path;
  const wpSet = new Set(_jpWaypoints);
  let insertIdx = 0;
  for (let k = 0; k <= segIndex && k < path.length; k++) if (wpSet.has(path[k])) insertIdx++;
  _jpWaypoints.splice(insertIdx, 0, systemId);
  if (_jpReplot()) {
    if (typeof showToast === 'function') showToast(`Added ${_jpById[systemId].name} as a waypoint.`, 'success');
  } else {
    const idx = _jpWaypoints.indexOf(systemId);
    if (idx !== -1) _jpWaypoints.splice(idx, 1);
    if (typeof showToast === 'function') showToast('Could not route through that waypoint.', 'error');
  }
}

// Remove a waypoint (from the map context menu) and re-plot. Reverts on failure,
// though dropping a constraint should always remain routable.
function _jpRemoveWaypoint(systemId) {
  const i = _jpWaypoints.indexOf(systemId);
  if (i === -1) return;
  const snap = _jpWaypoints.slice();
  _jpWaypoints.splice(i, 1);
  if (_jpReplot()) {
    if (typeof showToast === 'function') showToast(`Removed waypoint ${_jpById[systemId]?.name || ''}`.trim(), 'success');
  } else {
    _jpWaypoints.length = 0; _jpWaypoints.push(...snap);
    if (typeof showToast === 'function') showToast('Could not re-route after removing that waypoint.', 'error');
  }
}

// Remove an auto-generated route node: avoid it and re-route around it. Reverts
// (un-avoids) if there's no alternative path.
function _jpAvoidSystem(systemId) {
  if (_jpAvoid.has(systemId)) return;
  _jpAvoid.add(systemId);
  if (_jpReplot()) {
    if (typeof showToast === 'function') showToast(`Routing around ${_jpById[systemId]?.name || 'that system'}.`, 'success');
  } else {
    _jpAvoid.delete(systemId);
    if (typeof showToast === 'function') showToast(`No alternative route that avoids ${_jpById[systemId]?.name || 'that system'}.`, 'error');
  }
}

// Allow a previously-avoided system back into routing.
function _jpUnavoidSystem(systemId) {
  if (!_jpAvoid.delete(systemId)) return;
  _jpReplot();
  if (typeof showToast === 'function') showToast(`No longer avoiding ${_jpById[systemId]?.name || 'that system'}.`, 'success');
}

// Re-solve the route from the stored plot context + current waypoints, update the
// planner's result table and the map overlay. Returns false if unroutable.
function _jpReplot() {
  const c = _jpLastPlotCtx;
  if (!c) return false;
  const stops = [c.fromId, ..._jpWaypoints.filter(id => _jpById[id]), c.toId];
  const route = _jpRouteMulti(stops, {
    mode: c.mode, safest: c.safest, rangeLY: c.rangeLY,
    avoidIncSet: c.avoidIncSet, useRegionalGates: c.useRegionalGates, avoidZarzakh: c.avoidZarzakh,
  });
  if (route.error) return false;
  const result = document.querySelector('#jumpPlannerModal #jpResult');
  if (result) {
    _jpRenderRoute(result, route, { mode: c.mode, safest: c.safest, shipId: c.shipId, jfc: c.jfc, jf: c.jf, useRegionalGates: c.useRegionalGates });
    // _jpRenderRoute already synced the map overlay.
  } else {
    _jpLastRoute = route;
    if (typeof window.mapShowJumpRoute === 'function') window.mapShowJumpRoute(route.path, [...(route.waypointIds || [])], false);
  }
  const m = document.getElementById('jumpPlannerModal');
  if (m) _jpRenderWaypoints(m);
  return true;
}

function _jpCloseMapMenu() {
  const menu = document.getElementById('jpMapMenu');
  if (menu) menu.remove();
}

function _jpMapMenuOutside(e) {
  const menu = document.getElementById('jpMapMenu');
  if (!menu) return;
  if (menu.contains(e.target)) document.addEventListener('click', _jpMapMenuOutside, { once: true });
  else _jpCloseMapMenu();
}

function _jpShowMapMenu(systemId, x, y) {
  _jpCloseMapMenu();
  const X = _jpById[systemId];
  if (!X) return;

  let body = `<div style="padding:8px 12px;border-bottom:1px solid var(--border);font-weight:700;">📍 ${escHtml(X.name)}</div>`;
  const hasRoute = _jpLastRoute && Array.isArray(_jpLastRoute.path) && _jpLastRoute.path.length > 1;

  const path     = hasRoute ? _jpLastRoute.path : [];
  const isEndpoint = hasRoute && (systemId === path[0] || systemId === path[path.length - 1]);
  const rmBtn = (label, cls) => `<button class="${cls}" style="display:block;width:100%;text-align:left;background:none;border:none;border-top:1px solid var(--border);color:#e05252;padding:9px 12px;cursor:pointer;font-family:inherit;font-size:12px;">${label}</button>`;

  if (!hasRoute) {
    body += `<div style="padding:10px 12px;color:var(--text-3);">Plot a route first, then right-click a nearby system to splice it in as a mid waypoint.</div>`;
  } else if (isEndpoint) {
    body += `<div style="padding:10px 12px;color:var(--text-3);">${escHtml(X.name)} is the route start/destination — change it in the planner's From/To.</div>`;
  } else if (_jpWaypoints.includes(systemId)) {
    // Manual waypoint → remove it.
    body += rmBtn('✕ Remove this waypoint', 'jp-map-remove');
  } else if (_jpAvoid.has(systemId)) {
    // Previously avoided → let the user put it back in play.
    body += `<button class="jp-map-unavoid" style="display:block;width:100%;text-align:left;background:none;border:none;border-top:1px solid var(--border);color:var(--text-1);padding:9px 12px;cursor:pointer;font-family:inherit;font-size:12px;">↩ Stop avoiding this system</button>`;
  } else if (path.includes(systemId)) {
    // Auto-generated route node → offer alternative mids + remove.
    const alts = _jpMidAlternatives(systemId);
    if (alts.length) {
      const A = _jpById[path[path.indexOf(systemId) - 1]];
      const B = _jpById[path[path.indexOf(systemId) + 1]];
      body += `<div style="padding:6px 12px;color:var(--text-3);font-size:10px;letter-spacing:0.08em;">SWAP MID — ${escHtml(A?.name || '')} ↔ ${escHtml(B?.name || '')}</div>`;
      body += alts.map((a, idx) => `
        <button class="jp-map-alt" data-i="${idx}" style="display:block;width:100%;text-align:left;background:none;border:none;border-top:1px solid var(--border);color:var(--text-1);padding:8px 12px;cursor:pointer;font-family:inherit;font-size:12px;">
          <span style="color:var(--accent);">↔</span> ${escHtml(a.Y.name)} <span style="color:var(--text-3);">· ${escHtml(a.Y.regionName || '—')}</span>
          <div style="color:var(--text-3);font-size:10px;margin-top:2px;">+${a.detour.toFixed(1)} LY vs current · hops ${a.dAY.toFixed(2)} / ${a.dYB.toFixed(2)} LY</div>
        </button>`).join('');
    }
    body += rmBtn('✕ Remove from route (avoid &amp; re-route around)', 'jp-map-avoid');
  } else if (X.sec >= JP_JUMPABLE_MAX_SEC) {
    body += `<div style="padding:10px 12px;color:var(--text-3);">${escHtml(X.name)} is high-sec — capitals can't jump there.</div>`;
  } else {
    const cands = _jpReplaceCandidates(systemId);
    if (cands.length) {
      // In-range "mid" segments — splice between two adjacent route systems.
      body += `<div style="padding:6px 12px;color:var(--text-3);font-size:10px;letter-spacing:0.08em;">NEAREST IN-RANGE SEGMENTS</div>`;
      body += cands.map((c, idx) => `
        <button class="jp-map-cand" data-i="${idx}" style="display:block;width:100%;text-align:left;background:none;border:none;border-top:1px solid var(--border);color:var(--text-1);padding:8px 12px;cursor:pointer;font-family:inherit;font-size:12px;">
          <span style="color:var(--accent);">↳</span> ${escHtml(c.A.name)} <span style="color:var(--text-3);">↔</span> ${escHtml(c.B.name)}
          <div style="color:var(--text-3);font-size:10px;margin-top:2px;">+${c.detour.toFixed(1)} LY detour · hops ${c.dAX.toFixed(2)} / ${c.dXB.toFixed(2)} LY</div>
        </button>`).join('');
    }
    // Always offer a general "route through it" that works even for far systems:
    // insert at the cheapest spot and let the router build the extra jumps.
    const seg = _jpBestInsertionSegment(systemId);
    if (seg >= 0) {
      const A = _jpById[path[seg]], B = _jpById[path[seg + 1]];
      const detour = _jpDistLY(A, X) + _jpDistLY(X, B) - _jpDistLY(A, B);
      body += `<button class="jp-map-route" style="display:block;width:100%;text-align:left;background:none;border:none;border-top:1px solid var(--border);color:var(--accent);padding:9px 12px;cursor:pointer;font-family:inherit;font-size:12px;">
        ↳ Route through ${escHtml(X.name)} ${cands.length ? '<span style="color:var(--text-3);">(elsewhere, cheapest)</span>' : ''}
        <div style="color:var(--text-3);font-size:10px;margin-top:2px;">Adds it as a waypoint near ${escHtml(A.name)} ↔ ${escHtml(B.name)} (+${detour.toFixed(1)} LY) — the router fills in the jumps.</div>
      </button>`;
    }
  }

  const menu = document.createElement('div');
  menu.id = 'jpMapMenu';
  menu.style.cssText = 'position:fixed;z-index:10060;min-width:240px;max-width:320px;'
    + 'background:var(--bg-card);border:1px solid var(--accent);border-radius:8px;'
    + 'box-shadow:0 6px 24px rgba(0,0,0,0.6);font-family:var(--mono,monospace);font-size:12px;'
    + 'color:var(--text-1);overflow:hidden;';
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.innerHTML  = body;
  document.body.appendChild(menu);

  // Keep the menu on-screen.
  const r = menu.getBoundingClientRect();
  if (r.right  > window.innerWidth)  menu.style.left = Math.max(8, window.innerWidth  - r.width  - 8) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top  = Math.max(8, window.innerHeight - r.height - 8) + 'px';

  menu.querySelectorAll('.jp-map-cand').forEach(btn => {
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-deep)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    btn.addEventListener('click', () => {
      const cands = _jpReplaceCandidates(systemId);
      const c = cands[+btn.dataset.i];
      _jpCloseMapMenu();
      if (c) _jpInsertWaypointAtSegment(systemId, c.i);
    });
  });

  const bindAction = (sel, fn, hoverBg) => {
    const b = menu.querySelector(sel);
    if (!b) return;
    b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
    b.addEventListener('mouseleave', () => { b.style.background = 'none'; });
    b.addEventListener('click', () => { _jpCloseMapMenu(); fn(systemId); });
  };
  bindAction('.jp-map-remove',  _jpRemoveWaypoint, 'rgba(224,82,82,0.12)');
  bindAction('.jp-map-avoid',   _jpAvoidSystem,    'rgba(224,82,82,0.12)');
  bindAction('.jp-map-unavoid', _jpUnavoidSystem,  'var(--bg-deep)');
  bindAction('.jp-map-route',   (id) => {
    const seg = _jpBestInsertionSegment(id);
    if (seg >= 0) _jpInsertWaypointAtSegment(id, seg);
  }, 'var(--bg-deep)');

  menu.querySelectorAll('.jp-map-alt').forEach(btn => {
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-deep)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    btn.addEventListener('click', () => {
      const a = _jpMidAlternatives(systemId)[+btn.dataset.i];
      _jpCloseMapMenu();
      if (a) _jpUseMidAlternative(systemId, a.Y.id);
    });
  });

  setTimeout(() => document.addEventListener('click', _jpMapMenuOutside, { once: true }), 0);
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
        <button class="icon-btn jp-min" title="Minimize — keep the route and view it on the map" style="margin-left:auto;font-size:16px;line-height:1;">—</button>
        <button class="icon-btn jp-close" title="Close" style="font-size:16px;">✕</button>
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
            <label class="jp-check"><input type="checkbox" id="jpRegional"> Use regional gates (stargates) <span class="jp-dim" style="font-weight:400;">— faster, needs a move op</span></label>
            <label class="jp-check"><input type="checkbox" id="jpAvoidZarzakh" checked> Avoid Zarzakh <span class="jp-dim" style="font-weight:400;">— 6 h gate lock; can't exit the other side</span></label>
          </div>

          <div class="jp-bridges">
            <div class="jp-bridges-title">Waypoints <span style="color:var(--text-3);font-weight:400;">(optional — force the route through these, in order)</span></div>
            <div style="display:flex;gap:6px;">
              <input id="jpWaypoint" class="field-input" placeholder="Add a system…" list="jpSysList" style="flex:1;">
              <button id="jpWaypointAdd" class="icon-btn" style="padding:4px 10px;">＋</button>
            </div>
            <div id="jpWaypointList" class="jp-bridge-list"></div>
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
  m.querySelector('.jp-min').addEventListener('click', _jpMinimize);
  m.querySelector('#jpJdc').addEventListener('input', e => { m.querySelector('#jpJdcVal').textContent = e.target.value; _jpUpdateRangeNote(m); });
  m.querySelector('#jpJfc').addEventListener('input', e => { m.querySelector('#jpJfcVal').textContent = e.target.value; });
  m.querySelector('#jpJf').addEventListener('input', e => { m.querySelector('#jpJfVal').textContent = e.target.value; });
  m.querySelector('#jpShip').addEventListener('change', () => _jpUpdateRangeNote(m));
  m.querySelector('#jpMode').addEventListener('change', () => _jpUpdateRangeNote(m));
  m.querySelector('#jpPlotBtn').addEventListener('click', () => _jpPlot(m));
  // Auto re-plot when any option (ship, mode, skills, toggles, From/To) changes —
  // only once a route has already been plotted, so we don't error on a blank form.
  ['#jpShip', '#jpMode', '#jpJdc', '#jpJfc', '#jpJf', '#jpSafest', '#jpAvoidInc', '#jpRegional', '#jpAvoidZarzakh', '#jpFrom', '#jpTo']
    .forEach(sel => { const el = m.querySelector(sel); if (el) el.addEventListener('change', () => _jpMaybeReplot(m)); });
  m.querySelector('#jpBridgeAdd').addEventListener('click', () => _jpAddBridge(m));
  m.querySelector('#jpWaypointAdd').addEventListener('click', () => _jpAddWaypoint(m));
  m.querySelector('#jpWaypoint').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); _jpAddWaypoint(m); }
  });
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

// Re-plot when an option changes — but only if a route has already been plotted
// and both endpoints still resolve, so toggles don't error on an empty form.
function _jpMaybeReplot(m) {
  if (!_jpLastRoute) return;
  const from = _jpResolveSystem(m.querySelector('#jpFrom').value);
  const to   = _jpResolveSystem(m.querySelector('#jpTo').value);
  if (from && to && from.id !== to.id) _jpPlot(m);
}

async function _jpPlot(m) {
  const result = m.querySelector('#jpResult');
  const from = _jpResolveSystem(m.querySelector('#jpFrom').value);
  const to   = _jpResolveSystem(m.querySelector('#jpTo').value);
  if (!from || !to) { result.innerHTML = `<div class="jp-empty jp-err">Pick valid start and destination systems.</div>`; return; }
  if (from.id === to.id) { result.innerHTML = `<div class="jp-empty">Start and destination are the same system.</div>`; return; }

  const mode    = m.querySelector('#jpMode').value;
  const safest  = m.querySelector('#jpSafest').checked;
  const useRegionalGates = m.querySelector('#jpRegional').checked;
  const avoidZarzakh = m.querySelector('#jpAvoidZarzakh').checked;
  const shipId  = m.querySelector('#jpShip').value;
  const jdc     = +m.querySelector('#jpJdc').value;
  const jfc     = +m.querySelector('#jpJfc').value;
  const jf      = +m.querySelector('#jpJf').value;
  const rangeLY = _jpRangeFor(shipId, jdc);

  // Full ordered stop list: start, manual waypoints (skipping any that duplicate a
  // neighbour), destination.
  const stops = [from.id, ..._jpWaypoints.filter(id => _jpById[id]), to.id];

  if (mode === 'cyno') {
    // You can jump OUT of high-sec (the origin may be high-sec, as long as a low/null
    // system is in range), but never INTO it. So only the destination and waypoints
    // — every stop except the origin — must be jumpable.
    const badStop = stops.slice(1).map(id => _jpById[id]).find(s => s && s.sec >= JP_JUMPABLE_MAX_SEC);
    if (badStop) {
      result.innerHTML = `<div class="jp-empty jp-err">Capitals can't jump <b>into</b> high-sec (${escHtml(badStop.name)}). The start may be high-sec, but the destination and waypoints must be low-sec/null. (Or use Beacon mode.)</div>`;
      return;
    }
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
    const route = _jpRouteMulti(stops, { mode, safest, rangeLY, avoidIncSet, useRegionalGates, avoidZarzakh });
    if (route.error) {
      const a = _jpById[route.error.fromId]?.name || route.error.fromId;
      const b = _jpById[route.error.toId]?.name   || route.error.toId;
      result.innerHTML = `<div class="jp-empty jp-err">No route found for leg ${escHtml(a)} → ${escHtml(b)}${mode === 'cyno' ? ' within jump range' : ''}.${mode === 'beacon' ? ' Add bridges or try Cyno mode.' : ''}</div>`;
      return;
    }
    _jpRenderRoute(result, route, { mode, safest, shipId, jfc, jf, useRegionalGates });
    // Remember everything needed to re-plot after a map-driven waypoint edit.
    _jpLastPlotCtx = { fromId: from.id, toId: to.id, mode, safest, rangeLY, useRegionalGates, avoidIncSet, avoidZarzakh, shipId, jfc, jf };
  }, 20);
}

function _jpSecColor(sec) {
  if (sec >= 0.45) return '#48f0c0';
  if (sec >= 0.25) return '#f0b000';
  if (sec > 0.0)   return '#f06000';
  return '#e05252';
}

function _jpRenderRoute(container, route, opts) {
  _jpLastRoute = route;   // remembered so Minimize can redraw it on the map
  // Keep the map's pink jump overlay in sync with every (re)plot — no refit so the
  // view doesn't jump while you tweak options/waypoints.
  if (typeof window.mapShowJumpRoute === 'function') {
    window.mapShowJumpRoute(route.path, [...(route.waypointIds || [])], false);
  }
  const { mode, safest, shipId, jfc, jf, useRegionalGates } = opts;
  const ship = _jpShipById(shipId);
  const isJF = ship.id === 'jf';   // Jump Freighters skill only reduces JF fuel
  const waypointIds = route.waypointIds || new Set();
  let totalLY = 0, totalFuel = 0, regionalGateCount = 0;

  const rows = route.hops.map((hop, i) => {
    const sys = _jpById[hop.to];
    const sc = _jpSovClass(sys);
    const sovDot = sc.color, sovTxt = sc.label;
    let kindCell, fuel = 0;
    if (hop.kind === 'jump') {
      totalLY += hop.ly;
      fuel = JumpMath.jumpHopFuel(hop.ly, ship.fuel, jfc, jf, isJF);
      totalFuel += fuel;
      kindCell = `${hop.ly.toFixed(2)} LY`;
    } else if (hop.kind === 'rgate') {
      regionalGateCount++;
      kindCell = `<span style="color:#f0b000;font-weight:600;">⚠ regional gate</span>`;
    } else {
      kindCell = hop.kind === 'bridge' ? '◈ bridge' : 'gate';
    }
    // Waypoint rows carry inline reorder/remove controls (moved here from the
    // sidebar list) so they're managed in context, right on the route.
    const isWp = waypointIds.has(hop.to);
    let sysCell;
    if (isWp) {
      const btn = 'background:none;border:1px solid var(--border);border-radius:3px;color:var(--text-2);cursor:pointer;font-size:10px;line-height:1;padding:1px 5px;';
      sysCell = `<div style="display:flex;align-items:center;gap:6px;">
        <span class="jp-secdot" style="background:${_jpSecColor(sys.sec)}"></span>
        <span>${escHtml(sys.name)}</span>
        <span style="font-size:9px;font-weight:700;letter-spacing:0.06em;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:0 4px;">WP</span>
        <span style="margin-left:auto;display:inline-flex;gap:3px;">
          <button class="jp-wp-ctl" data-wp="${hop.to}" data-act="up"   title="Move waypoint earlier" style="${btn}">▲</button>
          <button class="jp-wp-ctl" data-wp="${hop.to}" data-act="down" title="Move waypoint later"   style="${btn}">▼</button>
          <button class="jp-wp-ctl" data-wp="${hop.to}" data-act="del"  title="Remove waypoint"        style="${btn}">✕</button>
        </span>
      </div>`;
    } else {
      sysCell = `<span class="jp-secdot" style="background:${_jpSecColor(sys.sec)}"></span>${escHtml(sys.name)}`;
    }
    return `
      <tr data-sys="${hop.to}"${hop.kind === 'rgate' ? ' style="background:rgba(240,176,0,0.07);"' : ''}>
        <td class="jp-num">${i + 1}</td>
        <td>${sysCell}</td>
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

  // Big move-op warning whenever the route relies on regional (inter-region) gates.
  const rgateWarn = regionalGateCount > 0
    ? `<div class="jp-banner" style="background:rgba(240,176,0,0.14);border:1px solid #f0b000;color:#f5d98a;font-weight:600;">⚠ This route uses ${regionalGateCount} regional gate${regionalGateCount > 1 ? 's' : ''} (stargates). Taking a capital/super through gates is dangerous — bring support and <u>wait for a move op</u>.</div>`
    : '';
  // Recommend the option when a cyno-only route is long and gates could help.
  const rgateTip = (!useRegionalGates && mode === 'cyno' && jumps >= 10)
    ? `<div class="jp-banner" style="background:rgba(78,203,176,0.08);">💡 Long route (${jumps} jumps) — enabling “Use regional gates” may cut jumps and fuel by routing over inter-regional stargates (then wait for a move op).</div>`
    : '';

  container.innerHTML = `
    ${banner}${rgateWarn}${rgateTip}
    <div class="jp-totals">
      <div><span class="jp-tot-num">${jumps}</span><span class="jp-tot-lbl">${mode === 'cyno' ? 'jumps' : 'hops'}</span></div>
      ${mode === 'cyno' ? `<div><span class="jp-tot-num">${totalLY.toFixed(1)}</span><span class="jp-tot-lbl">LY total</span></div>
                           <div><span class="jp-tot-num">${totalFuel.toLocaleString()}</span><span class="jp-tot-lbl">isotopes</span></div>` : ''}
      ${regionalGateCount > 0 ? `<div><span class="jp-tot-num" style="color:#f0b000;">${regionalGateCount}</span><span class="jp-tot-lbl">regional gates</span></div>` : ''}
    </div>
    <button id="jpShowMapBtn" class="icon-btn" style="width:100%;margin:4px 0 8px;padding:6px;font-size:12px;cursor:pointer;">🗺 Show route on map</button>
    <table class="jp-route-table">
      <thead><tr><th></th><th>System</th><th>Region</th><th class="jp-right">${mode === 'cyno' ? 'Range' : 'Via'}</th><th class="jp-right">Fuel</th><th>Sov</th></tr></thead>
      <tbody>
        <tr class="jp-origin" data-sys="${route.path[0]}">
          <td class="jp-num">●</td>
          <td><span class="jp-secdot" style="background:${_jpSecColor(startSys.sec)}"></span>${escHtml(startSys.name)} <span class="jp-dim">(start)</span></td>
          <td class="jp-dim">${escHtml(startSys.regionName)}</td>
          <td class="jp-right">—</td><td class="jp-right jp-dim">—</td>
          <td><span class="jp-secdot" style="background:${_jpSovClass(startSys).color}"></span><span class="jp-dim">${_jpSovClass(startSys).label}</span></td>
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
    setTimeout(() => {
      if (typeof window.mapShowJumpRoute === 'function') {
        window.mapShowJumpRoute(route.path, [...(route.waypointIds || [])]);
      }
    }, 220);
  });

  // Right-click any route row → the same context menu the map uses (remove /
  // avoid / swap an auto mid for an alternative / route through, etc.).
  const routeTable = container.querySelector('.jp-route-table');
  if (routeTable) routeTable.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr[data-sys]');
    if (!tr) return;
    e.preventDefault();
    _jpShowMapMenu(+tr.dataset.sys, e.clientX, e.clientY);
  });

  // Inline waypoint reorder/remove controls on the route rows.
  container.querySelectorAll('.jp-wp-ctl').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = +btn.dataset.wp, act = btn.dataset.act;
      const i  = _jpWaypoints.indexOf(id);
      if (i === -1) return;
      const snap = _jpWaypoints.slice();   // restore on an unroutable reorder
      if      (act === 'del')                                       _jpWaypoints.splice(i, 1);
      else if (act === 'up'   && i > 0)                             [_jpWaypoints[i - 1], _jpWaypoints[i]] = [_jpWaypoints[i], _jpWaypoints[i - 1]];
      else if (act === 'down' && i < _jpWaypoints.length - 1)       [_jpWaypoints[i + 1], _jpWaypoints[i]] = [_jpWaypoints[i], _jpWaypoints[i + 1]];
      else return;                          // no-op (already at an edge)
      if (!_jpReplot()) {
        _jpWaypoints.length = 0; _jpWaypoints.push(...snap);
        if (typeof showToast === 'function') showToast('That waypoint change leaves an unroutable leg.', 'error');
      }
    });
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

// ── Manual waypoints ──────────────────────────────────────────────────────────
// Ordered intermediate stops the route is forced through. Kept in session state
// (not persisted like bridges) since they're specific to the trip being planned.
function _jpAddWaypoint(m) {
  const input = m.querySelector('#jpWaypoint');
  const sys = _jpResolveSystem(input.value);
  if (!sys) {
    if (typeof showToast === 'function') showToast('Enter a valid system to add as a waypoint.', 'error');
    return;
  }
  if (!_jpWaypoints.includes(sys.id)) _jpWaypoints.push(sys.id);
  input.value = '';
  _jpRenderWaypoints(m);
}

function _jpRenderWaypoints(m) {
  const list = m.querySelector('#jpWaypointList');
  if (!list) return;
  if (!_jpWaypoints.length) {
    list.innerHTML = `<div class="jp-dim" style="padding:6px 0;font-size:11px;">No waypoints — route goes direct.</div>`;
    return;
  }
  // Read-only list — reorder/remove now live on the route rows in the result panel.
  list.innerHTML = _jpWaypoints.map((id, i) =>
    `<div class="jp-bridge-row"><span>${i + 1}. ${escHtml(_jpById[id]?.name || id)}</span></div>`
  ).join('')
    + `<div class="jp-dim" style="padding:4px 0 0;font-size:10px;">Reorder / remove on the route table after plotting.</div>`;
}

// Populate the system datalist when data is ready (called from _jpLoadData via openJumpPlanner).
function _jpPopulateDatalist() {
  const dl = document.getElementById('jpSysList');
  if (!dl || dl._filled || !_jpNames.length) return;
  dl.innerHTML = _jpNames.map(s => `<option value="${escHtml(s.name)}"></option>`).join('');
  dl._filled = true;
}
