// ─── Shared Application State ─────────────────────────────────────────────────
// All mutable globals live here so every module can import from one place.
// In a plain-script (non-module) setup these are just window-level vars.

let selectedBpTypeId     = null;
let selectedBpName       = null;
let currentResults       = null;
let allLibBPs            = [];
let searchTimer          = null;
let manualSearchTimer    = null;
let currentSort          = 'name';
let filterPerfectOnly    = false;
let navCollapsed         = false;
let currentPage          = null;
let currentSettingsTab   = 'jabber';
let selectedCharacterId  = null;
let currentIndustryTab   = null;

// The Jabber server Settings shows when nothing is saved and the picked alliance
// pack names none of its own (The Imperium's names goonfleet.com; see
// src/func/pack_links.js).
const JABBER_DEFAULT_SERVICE = 'xmpp://jabber.eveonline.com:5222';

let jabberSettings = {
  service:     JABBER_DEFAULT_SERVICE,
  jid:         '',
  password:    '',
};
let jabberMessages            = [];
let jabberConnected           = false;

let allAssetsCache     = null;
let filteredAssetsCache = null;   // subset shown after search/filter
let assetsRenderPos    = 0;

const ASSET_CHUNK = 200;
const priceCache  = {};  // typeId => { buy, sell }
const ESI_IMAGE   = 'https://images.evetech.net/types';

// Blueprint name → bpId lookup built from categories.js
const BP_LOOKUP = {};
EVE_CATEGORIES.forEach(cat => {
  cat.items.forEach(item => {
    BP_LOOKUP[item.name.toLowerCase()] = item.bpId;
  });
});

function getBpIdFromName(name) {
  return BP_LOOKUP[name.toLowerCase()];
}