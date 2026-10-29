// ─── demo-seed.js — the demo profile's localStorage ───────────────────────────
// Some tools keep their state in the renderer's localStorage rather than in the
// database the demo seeder writes: skill plans, shopping lists, the GEZ tracker's
// structures. Without these, Skills opens on "no plans yet" and Station Checkout
// on "you have no shopping lists" — the tools look unused rather than useful.
//
// Runs before any page module reads its key, in demo mode only, and only when
// main reports that this launch rebuilt the demo profile (eveAPI.demoSeed is
// absent under --demo-keep, so a kept profile keeps whatever was changed in it).
// Every id below is a real SDE id, checked when written.
(function () {
  const api = window.eveAPI;
  if (!api || !api.isDemo || !api.demoSeed) return;
  try { if (localStorage.getItem('demoSeededLaunch') === api.demoSeed) return; }
  catch (_) { return; }
  const set = (k, v) => { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (_) {} };
  const now = Date.now(), DAY = 86400000;

  // Kaska is the default character (the ◆ on her card) and the cards run main,
  // industrialist, scout. Without this the app opens on whichever id sorts
  // first — the scout.
  set('char_favorites', ['3010026']);
  set('char_card_order', ['3010026', '3010075', '3010035']);

  // A dashboard with every widget on it (bar Beehive, which is one alliance's),
  // at each widget's own measured default size — the default five-tile layout
  // showed a fifth of what the dashboard can do. Gridstack packs upward, so the
  // y values only have to keep each column in order. Format: dashboard.js
  // _saveDashLayout (v must match DASH_LAYOUT_VERSION).
  set('dashboardGridLayout', { v: 2, items: [
    { id: 'networth',          x: 0, y: 0,  w: 4,  h: 6  },
    { id: 'walletBalance',     x: 0, y: 6,  w: 4,  h: 8  },
    { id: 'skillQueue',        x: 0, y: 14, w: 4,  h: 10 },
    { id: 'marketQuicklook',   x: 0, y: 24, w: 4,  h: 10 },
    { id: 'wealthGrowth',      x: 4, y: 0,  w: 5,  h: 11 },
    { id: 'activeJobs',        x: 4, y: 11, w: 5,  h: 10 },
    { id: 'marketOrders',      x: 4, y: 21, w: 5,  h: 10 },
    { id: 'wealthByChar',      x: 9, y: 0,  w: 3,  h: 11 },
    { id: 'jobWatch~demo1',    x: 9, y: 11, w: 3,  h: 8  },
    { id: 'charWallet~demo1',  x: 9, y: 19, w: 3,  h: 6  },
    { id: 'latestPing',        x: 0, y: 34, w: 5,  h: 15 },
    { id: 'earlyWarning',      x: 5, y: 34, w: 7,  h: 11 },
    { id: 'pi',                x: 5, y: 45, w: 7,  h: 9  },
    { id: 'killTicker~demo1',  x: 0, y: 54, w: 12, h: 10 },
    { id: 'fwTug~demo1',       x: 0, y: 64, w: 5,  h: 11 },
    { id: 'fwSystems~demo1',   x: 5, y: 64, w: 4,  h: 10 },
    { id: 'fwBoard~demo1',     x: 9, y: 64, w: 3,  h: 11 },
    { id: 'killFeed~demo1',    x: 0, y: 75, w: 4,  h: 14 },
    { id: 'corpActiveJobs',    x: 4, y: 75, w: 8,  h: 10 },
  ] });
  // What each multi-instance tile was pointed at when "added".
  set('dashboardJobWatch',   { 'jobWatch~demo1': '70001' });           // Kaska's Drake run
  set('dashboardCharWallet', { 'charWallet~demo1': '3010075' });       // Sirene
  set('dashboardKillTicker', { 'killTicker~demo1': 'all' });
  set('dashboardKillFeed',   { 'killFeed~demo1': { v: 'all', label: 'All characters' } });
  set('dashboardFwTug',      { 'fwTug~demo1': 'ama-min' });             // Tovan's warzone
  set('dashboardFwSystems',  { 'fwSystems~demo1': 'all' });
  set('dashboardFwBoard',    { 'fwBoard~demo1': 'kills:active_total' });
  set('dashboardMarketWatch', [
    { typeId: 44992, name: 'PLEX' }, { typeId: 40520, name: 'Large Skill Injector' },
    { typeId: 12015, name: 'Muninn' }, { typeId: 621, name: 'Caracal' },
    { typeId: 40, name: 'Megacyte' }, { typeId: 34, name: 'Tritanium' },
  ]);

  // Skill plans: { id, name, createdAt, entries: [{ skillId, level }] } (skills.js).
  set('eveCarbon_skillPlans', [
    { id: 'demo-plan-muninn', name: 'Muninn — fleet ready', createdAt: now - 12 * DAY, entries: [
      { skillId: 3333, level: 5 }, { skillId: 16591, level: 4 }, { skillId: 3305, level: 5 },
      { skillId: 12202, level: 4 }, { skillId: 3425, level: 5 }, { skillId: 3432, level: 4 },
      { skillId: 3310, level: 4 }, { skillId: 3315, level: 4 } ] },
    { id: 'demo-plan-industry', name: 'Industry — T2 production', createdAt: now - 30 * DAY, entries: [
      { skillId: 3380, level: 5 }, { skillId: 3388, level: 5 }, { skillId: 3387, level: 5 },
      { skillId: 24625, level: 4 }, { skillId: 3402, level: 5 }, { skillId: 11452, level: 4 },
      { skillId: 11453, level: 4 }, { skillId: 11454, level: 4 } ] },
    { id: 'demo-plan-dread', name: 'Capitals — first dreadnought', createdAt: now - 4 * DAY, entries: [
      { skillId: 20533, level: 3 }, { skillId: 20532, level: 3 }, { skillId: 21667, level: 3 },
      { skillId: 3456, level: 5 }, { skillId: 21611, level: 4 }, { skillId: 21610, level: 4 },
      { skillId: 3420, level: 4 } ] },
  ]);

  // Shopping lists: { lists: [{ id, name, createdAt, updatedAt, items: [{ typeId, name, qty, sources }] }] }.
  // The Caracal list is the blueprint's real bill of materials, 20 runs at ME 10.
  set('eveCarbon_shoppingLists', { lists: [
    { id: 'demo-list-muninn', name: 'Muninn doctrine restock', createdAt: now - 3 * DAY, updatedAt: now - 2 * DAY, items: [
      { typeId: 2969,  name: '720mm Howitzer Artillery II',     qty: 50,     sources: ['Muninn — Vaelin fleet ×10'] },
      { typeId: 519,   name: 'Gyrostabilizer II',               qty: 30,     sources: ['Muninn — Vaelin fleet ×10'] },
      { typeId: 3841,  name: 'Large Shield Extender II',        qty: 20,     sources: ['Muninn — Vaelin fleet ×10'] },
      { typeId: 12076, name: '50MN Microwarpdrive II',          qty: 10,     sources: ['Muninn — Vaelin fleet ×10'] },
      { typeId: 2281,  name: 'Multispectrum Shield Hardener II', qty: 10,    sources: ['Muninn — Vaelin fleet ×10'] },
      { typeId: 21922, name: 'Republic Fleet Phased Plasma M',  qty: 24000,  sources: ['Muninn — Vaelin fleet ×10'] },
    ] },
    { id: 'demo-list-caracal', name: 'Caracal ×20 — Vaelin Shipyards', createdAt: now - 1 * DAY, updatedAt: now - 5 * 3600000, items: [
      { typeId: 34, name: 'Tritanium', qty: 9720000, sources: ['Caracal Blueprint ×20'] },
      { typeId: 35, name: 'Pyerite',   qty: 3240000, sources: ['Caracal Blueprint ×20'] },
      { typeId: 36, name: 'Mexallon',  qty: 648000,  sources: ['Caracal Blueprint ×20'] },
      { typeId: 37, name: 'Isogen',    qty: 180000,  sources: ['Caracal Blueprint ×20'] },
      { typeId: 38, name: 'Nocxium',   qty: 27000,   sources: ['Caracal Blueprint ×20'] },
      { typeId: 39, name: 'Zydrine',   qty: 6300,    sources: ['Caracal Blueprint ×20'] },
      { typeId: 40, name: 'Megacyte',  qty: 2520,    sources: ['Caracal Blueprint ×20'] },
    ] },
  ] });

  // The GEZ tracker: the sheet link (answered locally — src/demo/text.js) and
  // the structures a sync of it produces, so "My Structures" is already filled.
  set('eve-carbon-industry-sheet-url', 'https://docs.google.com/spreadsheets/d/vaelin-collective-gez-demo/edit');
  set('eve-carbon-industry-structures', [
    { name: 'Vaelin Shipyards — 1DQ1-A',  systemName: '1DQ1-A', systemId: 30004759, facility: 'ec',    structureSize: 'XL', secStatus: 'null', matRig: 't2',   timeRig: 't2',   taxRate: 0 },
    { name: 'Vaelin Components — 1DQ1-A', systemName: '1DQ1-A', systemId: 30004759, facility: 'ec',    structureSize: 'L',  secStatus: 'null', matRig: 't2',   timeRig: 't2',   taxRate: 0 },
    { name: 'Forward Raitaru — 319-3D',   systemName: '319-3D', systemId: 30004722, facility: 'ec',    structureSize: 'M',  secStatus: 'null', matRig: 't2',   timeRig: 't1',   taxRate: 0 },
    { name: 'Moon Refinery — T5ZI-S',     systemName: 'T5ZI-S', systemId: 30004735, facility: 'other', structureSize: 'M',  secStatus: 'null', matRig: 'none', timeRig: 'none', taxRate: 0 },
    { name: 'Reaction Farm — 5BTK-M',     systemName: '5BTK-M', systemId: 30004761, facility: 'other', structureSize: 'L',  secStatus: 'null', matRig: 'none', timeRig: 'none', taxRate: 0 },
  ]);

  set('demoSeededLaunch', api.demoSeed);
})();
