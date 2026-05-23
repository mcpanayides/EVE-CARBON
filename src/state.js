// ─── Shared Application State ─────────────────────────────────────────────────
// All mutable globals live here so every module can import from one place.
// In a plain-script (non-module) setup these are just window-level vars.

let selectedBpTypeId     = null;
let selectedBpName       = null;
let selectedME           = 3;
let selectedTE           = 2;
let currentResults       = null;
let allLibBPs            = [];
let searchTimer          = null;
let manualSearchTimer    = null;
let currentSort          = 'name';
let isLibraryVisible     = true;
let filterPerfectOnly    = false;
let navCollapsed         = false;
let currentPage          = null;
let currentSettingsTab   = 'jabber';
let selectedCharacterId  = null;
let currentIndustryTab   = null;

let jabberSettings = {
  service:     'xmpp://jabber.eveonline.com:5222',
  jid:         '',
  password:    '',
  directorOnly: true,
};
let jabberMessages            = [];
let jabberFilterDirectorOnly  = true;
let jabberConnected           = false;

let allAssetsCache  = null;
let assetsRenderPos = 0;

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