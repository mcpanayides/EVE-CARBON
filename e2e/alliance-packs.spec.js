// Alliance packs beyond Jabber, and the jump gate imports.
//
//   • The picked pack's pages, under the picker in Settings → Jabber: public ones
//     for anyone, members-only ones for pilots with a character in one of the
//     pack's alliances (src/shared/alliance_pack.js).
//   • Its forum, for anyone who picks it: Settings → Forums takes the picked
//     pack's forum, over another pack's forum even when that one was saved. An
//     address the pilot typed that no pack names stays.
//   • The Calendar's forum, filled into an empty field for members only.
//   • The Jabber server it names, for anyone who picks it: The Imperium's
//     goonfleet.com; any other pack puts the app's default back. A server the
//     pilot typed stays.
//   • Export Pack, and Delete asking in the app's own dialog.
//   • The pack's words: GEZ for Goonswarm pilots, sovereignty upgrades for others.
//   • Jump gates: pasted lists (ours, and theirs in red), the hourly read from EVE,
//     and other alliances' gates on the map. Main reads nothing from ESI under
//     e2e (the fixture's login is fake), so stand-in handlers answer for it.
const { test, expect, FAKE_CHAR_ID, FAKE_CHAR_NAME } = require('./support/electron-app');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function openSettings(window, tab) {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.locator('#openSettingsBtn').click();
  await window.locator(`[data-settings-tab="${tab}"]`).click();
}
async function showTab(window, tab) {
  await window.locator(`[data-settings-tab="${tab}"]`).click();
}
const packLinks = (w) => w.locator('#jabberPackLinks .pack-link-text');

// A pack of the pilot's own, as someone would import it.
const USER_PACK_ID = 'user:corp_pack.yaml';
const USER_PACK_YAML = [
  'pack_info:',
  '  name: "Corp Pack"',
  '  alliance: "Test Alliance"',
  'groups:',
  '  - name: "All"',
  '    display_name: "[A] All"',
  '    type: "ALL"',
  '',
].join('\n');

test('The Imperium, The Initiative, Winter Coalition and Brave come built in, with the Imperium still the default', async ({ window }) => {
  await openSettings(window, 'jabber');
  const select = window.locator('#jabberPackSelect');
  await expect(select).toHaveValue('gsf_sigs');                                   // the old id, so saved settings still find it
  await expect(select.locator('option:checked')).toHaveText('The Imperium');
  const ids = await select.locator('option').evaluateAll(os => os.map(o => o.value));
  expect(ids).toEqual(expect.arrayContaining(['gsf_sigs', 'initiative', 'winterco', 'brave']));
});

const JABBER_DEFAULT = 'xmpp://jabber.eveonline.com:5222';
const IMPERIUM_JABBER = 'xmpp://goonfleet.com:5222';
const serviceNote = (w) => w.locator('[data-pack-note-for="jabberService"]');

const forumNote = (w) => w.locator('[data-pack-note-for="forumUrlInput"]');

test('a pilot outside the alliance sees the public pages only, and gets the pack’s server and forum', async ({ window }) => {
  await openSettings(window, 'jabber');
  await expect(packLinks(window)).toHaveText(['goonfleet.com']);
  // Picking the pack is the choice: its server and its forum are filled in for anyone.
  await expect(window.locator('#jabberService')).toHaveValue(IMPERIUM_JABBER);
  await expect(serviceNote(window)).toHaveText('Filled in from your pack (The Imperium).');
  await showTab(window, 'forums');
  await expect(window.locator('#forumUrlInput')).toHaveValue('https://goonfleet.com/');
  await expect(forumNote(window)).toHaveText('Filled in from your pack (The Imperium).');
  // Reading the forum's calendar needs a Goonswarm sign-in.
  await showTab(window, 'calendar');
  await expect(window.locator('#calForumUrl')).toHaveValue('');
});

test('picking a pack puts its forum in Settings → Forums, over a forum saved from another pack', async ({ window }) => {
  // The forum an Imperium pilot would have saved, written the way people type it.
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => window.eveAPI.saveAppConfig({ forum: { url: 'https://goonfleet.com' } }));
  await openSettings(window, 'jabber');
  const select = window.locator('#jabberPackSelect');
  const forum = window.locator('#forumUrlInput');

  await select.selectOption('winterco');
  await showTab(window, 'forums');
  await expect(forum).toHaveValue('https://forums.winterco.org');
  await expect(forumNote(window)).toHaveText('Filled in from your pack (Winter Coalition).');

  // Brave's page; then a pack naming no forum empties the field; The Imperium puts its own back.
  for (const [pack, url] of [['brave', 'https://wiki.bravecollective.com/start'], ['initiative', ''], ['gsf_sigs', 'https://goonfleet.com/']]) {
    await showTab(window, 'jabber');
    await select.selectOption(pack);
    await showTab(window, 'forums');
    await expect(forum).toHaveValue(url);
  }
});

test('a forum saved that no pack names stays, whichever pack is picked', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => window.eveAPI.saveAppConfig({ forum: { url: 'https://forum.my-own-alliance.example/' } }));
  await openSettings(window, 'jabber');
  await window.locator('#jabberPackSelect').selectOption('winterco');
  await showTab(window, 'forums');
  await expect(window.locator('#forumUrlInput')).toHaveValue('https://forum.my-own-alliance.example/');
  await expect(forumNote(window)).toBeHidden();
});

test.describe('a pilot in Goonswarm Federation', () => {
  test.use({ allianceId: 1354830081 });

  test('sees the members-only pages, opens them in the browser, and gets the forum filled in', async ({ window, electronApp }) => {
    await electronApp.evaluate(({ shell }) => {
      global.__opened = [];
      shell.openExternal = async (url) => { global.__opened.push(url); };
    });
    await openSettings(window, 'jabber');
    await expect(packLinks(window)).toHaveText(['goonfleet.com', 'Goon Wiki', 'Goonswarm Economic Zones MkII', 'Alliance:Stargate']);
    const appUrl = window.url();
    await window.locator('#jabberPackLinks .pack-link', { hasText: 'Alliance:Stargate' }).click();
    await expect.poll(() => electronApp.evaluate(() => global.__opened)).toEqual(['https://wiki.goonswarm.org/w/Alliance:Stargate']);
    expect(window.url()).toBe(appUrl);

    await showTab(window, 'forums');
    await expect(window.locator('#forumUrlInput')).toHaveValue('https://goonfleet.com/');
    await expect(window.locator('[data-pack-note-for="forumUrlInput"]')).toHaveText('Filled in from your pack (The Imperium).');
    await showTab(window, 'calendar');
    await expect(window.locator('#calForumUrl')).toHaveValue('https://goonfleet.com');
  });

  test('another pack swaps what the pack filled in, but never what the pilot typed', async ({ window }) => {
    await openSettings(window, 'jabber');
    const select = window.locator('#jabberPackSelect');
    const forum = window.locator('#forumUrlInput');
    await expect(packLinks(window)).toHaveCount(4);

    // Winter Coalition's pages are public, and picking the pack puts its forum in,
    // though this pilot isn't one of its members.
    await select.selectOption('winterco');
    await expect(packLinks(window)).toHaveText(['Winter Coalition forums', 'Winter Coalition wiki']);
    await expect(forum).toHaveValue('https://forums.winterco.org');

    await select.selectOption('gsf_sigs');
    await expect(forum).toHaveValue('https://goonfleet.com/');

    await showTab(window, 'forums');
    await forum.fill('https://my-own-forum.example/');
    await showTab(window, 'jabber');
    await select.selectOption('brave');
    await expect(packLinks(window)).toHaveText(['Brave wiki']);
    await select.selectOption('gsf_sigs');
    await expect(forum).toHaveValue('https://my-own-forum.example/');
    await expect(window.locator('[data-pack-note-for="forumUrlInput"]')).toBeHidden();
  });
});

test('the Jabber server follows the pack: the Imperium’s goonfleet.com, the default for the rest, and a typed one stays', async ({ window }) => {
  await openSettings(window, 'jabber');
  const select = window.locator('#jabberPackSelect');
  const service = window.locator('#jabberService');
  await expect(service).toHaveValue(IMPERIUM_JABBER);

  for (const other of ['brave', 'winterco', 'initiative']) {
    await select.selectOption(other);
    await expect(service).toHaveValue(JABBER_DEFAULT);
    await expect(serviceNote(window)).toBeHidden();
  }
  await select.selectOption('gsf_sigs');
  await expect(service).toHaveValue(IMPERIUM_JABBER);
  await expect(serviceNote(window)).toHaveText('Filled in from your pack (The Imperium).');

  // A server the pilot typed is theirs, whichever pack is picked after.
  await service.fill('xmpp://jabber.my-own-alliance.example:5222');
  await expect(serviceNote(window)).toBeHidden();
  await select.selectOption('brave');
  await select.selectOption('gsf_sigs');
  await expect(service).toHaveValue('xmpp://jabber.my-own-alliance.example:5222');

  // An emptied field takes the pack's server again.
  await service.fill('');
  await select.selectOption('winterco');
  await expect(service).toHaveValue(JABBER_DEFAULT);
});

test.describe('a pilot in Brave Collective, one of the Imperium’s alliances', () => {
  test.use({ allianceId: 99003214 });

  test('gets the coalition’s server and public forum, and none of Goonswarm’s own things', async ({ window }) => {
    await openSettings(window, 'jabber');
    await expect(packLinks(window)).toHaveText(['goonfleet.com']);                // no Goon Wiki, GEZ topic or Stargate page
    await expect(window.locator('#jabberService')).toHaveValue(IMPERIUM_JABBER);
    await showTab(window, 'forums');
    await expect(window.locator('#forumUrlInput')).toHaveValue('https://goonfleet.com/');   // the pack's public forum
    await showTab(window, 'calendar');
    await expect(window.locator('#calForumUrl')).toHaveValue('');                // its calendar is Goonswarm's
    await showTab(window, 'industry');
    await expect(window.locator('[data-settings-tab="industry"]')).toHaveText('Sovereignty Upgrades');   // GEZ is Goonswarm's word
  });
});

test('a pack made here exports as the same file, and deleting it asks in the app’s own dialog', async ({ window, electronApp, profile }) => {
  fs.writeFileSync(path.join(profile.userDataDir, 'packs', 'corp_pack.yaml'), USER_PACK_YAML);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-pack-export-')), 'shared.yaml');
  await electronApp.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, out);

  await openSettings(window, 'jabber');
  await expect(window.locator('#jabberExportPackBtn')).toBeHidden();             // built-in packs ship with the app
  await window.locator('#jabberPackSelect').selectOption(USER_PACK_ID);
  await window.locator('#jabberExportPackBtn').click();
  await expect.poll(() => fs.existsSync(out)).toBe(true);
  expect(fs.readFileSync(out, 'utf8')).toBe(USER_PACK_YAML);

  await window.locator('#jabberDeletePackBtn').click();
  await expect(window.locator('.cf-backdrop')).toBeVisible();
  await window.locator('.cf-backdrop .cf-cancel').click();
  await expect(window.locator('.cf-backdrop')).toHaveCount(0);
  await expect(window.locator('#jabberPackSelect')).toHaveValue(USER_PACK_ID);
  expect(fs.existsSync(path.join(profile.userDataDir, 'packs', 'corp_pack.yaml'))).toBe(true);
});

test('pasted lists: "A » B" lines are ours, unfriendly rows and lists marked as theirs go red', async ({ window }) => {
  await openSettings(window, 'jumpgates');
  const input = window.locator('#beaconImportInput'), result = window.locator('#beaconImportResult');
  const count = window.locator('#beaconImportCount');
  await input.fill([
    'Our gates',
    '1DQ1-A » T5ZI-S - Spur',
    'T5ZI-S » 1DQ1-A - Spur',
    '8WA-Z6 -> N-8YET',
    ['Delve', '4O-239', 'Q-JQSG', 'Online', 'Someone', '', '1.2', '', 'No'].join('\t'),
  ].join('\n'));
  await window.locator('#beaconImportBtn').click();
  await expect(result).toContainText('Imported 2 gates of yours.');
  await expect(result).toContainText("1 of another alliance's, red on the map.");
  await expect(result).toContainText('1 already saved.');                     // the same gate from its other end
  await expect(count).toHaveText('2 gates saved · 1 of other alliances');

  await input.fill('0-WT2D » 1M4-FK - Bastion');
  await window.locator('#beaconImportTheirs').check();
  await window.locator('#beaconImportBtn').click();
  await expect(result).toContainText('Imported 0 gates of yours.');
  await expect(count).toHaveText('2 gates saved · 2 of other alliances');

  await window.locator('#beaconClearBtn').click();
  await expect(count).toHaveText('0 gates saved');
});

test('other alliances’ gates show on the map, in the legend and in a system’s panel, apart from ours', async ({ window, electronApp }) => {
  // The slow day that once left the legend without its red row: the map settled,
  // legend drawn, before other alliances' gates arrive, and sovereignty, whose load
  // would otherwise redraw the legend, never arriving. Their gates are held until
  // the map has settled; then only the gates' own load can redraw the legend.
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('map-get-sovereignty');
    ipcMain.handle('map-get-sovereignty', () => new Promise(() => {}));
    let release;
    const held = new Promise(r => { release = r; });
    global.__releaseTheirGates = () => release();
    ipcMain.removeHandler('get-jump-bridges-other');
    ipcMain.handle('get-jump-bridges-other', () => held.then(() => [[30004759, 30004746]]));   // 1DQ1-A ↔ 4O-239
  });
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => window.eveAPI.saveJumpBridges([[30004759, 30004735]]));   // 1DQ1-A ↔ T5ZI-S: ours
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  const legend = window.locator('#mapLegend');
  await expect(legend).toContainText('Jump bridge', { timeout: 15_000 });
  await window.waitForFunction(() => _loaded && !_layerBusy, null, { timeout: 20_000 });
  await window.waitForTimeout(500);
  expect(await legend.innerText()).not.toContain('Another alliance’s jump bridge');
  await electronApp.evaluate(() => global.__releaseTheirGates());
  await expect(legend).toContainText('Another alliance’s jump bridge', { timeout: 5_000 });
  await window.evaluate(() => window.mapJumpToSystem(30004759));
  const panel = window.locator('#mapInfoBody');
  await expect(panel).toContainText('Ours, to T5ZI-S');
  await expect(panel).toContainText('Another alliance’s, to 4O-239');
  // The router never takes their gate: only ours is in the list it reads.
  expect(await window.evaluate(() => _savedBridges)).toEqual([[30004759, 30004735]]);
});

test('GEZ is Goonswarm’s word: everyone else sees sovereignty upgrades', async ({ window }) => {
  await openSettings(window, 'industry');
  await expect(window.locator('[data-settings-tab="industry"]')).toHaveText('Sovereignty Upgrades');
  await expect(window.locator('#settingsTabIndustry .settings-panel-title')).toHaveText('Sovereignty Upgrades');
  await expect(window.locator('#settingsTabIndustry label')).toContainText('Sovereignty upgrades sheet link');
});

test.describe('a Goonswarm pilot', () => {
  test.use({ allianceId: 1354830081 });
  test('sees GEZ', async ({ window }) => {
    await openSettings(window, 'industry');
    await expect(window.locator('[data-settings-tab="industry"]')).toHaveText('GEZ Tracker');
    await expect(window.locator('#settingsTabIndustry label')).toContainText('GEZ tracker sheet link');
  });
});

test.describe('gates from EVE', () => {
  // Stand-ins for main's handlers: who may search and how the last read went, the
  // pick, a read, and the login. What each was asked is kept. Main reads nothing
  // under e2e; these stand in for what it would answer.
  async function standIns(electronApp, status) {
    await electronApp.evaluate(({ ipcMain }, status) => {
      global.__asked = { pick: [], login: [], sync: 0 };
      for (const ch of ['jump-gates-esi-status', 'jump-gates-esi-set-character', 'jump-gates-esi-sync', 'start-sso-login']) {
        ipcMain.removeHandler(ch);
      }
      ipcMain.handle('jump-gates-esi-status', () => status);
      ipcMain.handle('jump-gates-esi-set-character', (event, id) => {
        global.__asked.pick.push(id);
        event.sender.send('jump-gates-esi-progress', { done: 3, total: 6, characterName: 'Scout Alt' });
        return { ok: true };
      });
      ipcMain.handle('jump-gates-esi-sync', () => { global.__asked.sync++; return { ok: true }; });
      ipcMain.handle('start-sso-login', (_e, opts) => { global.__asked.login.push(opts); return { ok: true }; });
    }, status);
  }
  const allowed = (characterId, characterName) => ({ characterId, characterName, canSearch: true, needsReauth: false });

  test('with nobody allowed yet, it asks EVE for the one extra permission', async ({ window, electronApp }) => {
    await standIns(electronApp, { enabled: true, characters: [{ ...allowed(FAKE_CHAR_ID, FAKE_CHAR_NAME), canSearch: false }], characterId: null });
    await openSettings(window, 'jumpgates');
    await expect(window.locator('#beaconEsiAllow')).toBeVisible();
    await expect(window.locator('#beaconEsiFind')).toBeHidden();
    await window.locator('#beaconEsiAllowBtn').click();
    await expect.poll(() => electronApp.evaluate(() => global.__asked.login))
      .toEqual([{ extraScopes: ['esi-search.search_structures.v1'] }]);
    await expect(window.locator('#beaconEsiStatus')).toContainText('EVE’s login is open in your browser');
  });

  test('says whose gates are ours and how the last read went, with no button to press', async ({ window, electronApp }) => {
    await standIns(electronApp, {
      enabled: true, running: false, characters: [allowed(FAKE_CHAR_ID, FAKE_CHAR_NAME), allowed(2, 'Scout Alt')],
      characterId: FAKE_CHAR_ID, checkedAt: Date.now() - 5 * 60_000, characterName: FAKE_CHAR_NAME,
      mine: 143, theirs: 12, complete: true, error: null,
    });
    await openSettings(window, 'jumpgates');
    await expect(window.locator('#beaconEsiCharacter option')).toHaveText([FAKE_CHAR_NAME, 'Scout Alt']);
    await expect(window.locator('#beaconEsiCharacter')).toHaveValue(String(FAKE_CHAR_ID));
    const status = window.locator('#beaconEsiStatus');
    await expect(status).toContainText(`Kept up to date from EVE every hour. Read 5 min ago: 143 gates ${FAKE_CHAR_NAME} can use, green on the map`);
    await expect(status).toContainText('12 gates of other alliances your other characters can see, red');
    await expect(window.locator('#settingsTabJumpgates button', { hasText: 'Find my gates' })).toHaveCount(0);

    // Another character's gates become ours: main is told, and its read shows.
    await window.locator('#beaconEsiCharacter').selectOption('2');
    await expect.poll(() => electronApp.evaluate(() => global.__asked.pick)).toEqual(['2']);
  });

  test('when a read lands, the counts follow without a reload', async ({ window, electronApp }) => {
    await standIns(electronApp, { enabled: true, characters: [allowed(FAKE_CHAR_ID, FAKE_CHAR_NAME)], characterId: FAKE_CHAR_ID });
    await openSettings(window, 'jumpgates');
    await expect(window.locator('#beaconImportCount')).toHaveText('0 gates saved');
    await window.evaluate(async () => {
      await window.eveAPI.saveJumpBridges([[30004759, 30004735]]);
      await window.eveAPI.saveJumpBridgesOther([[30004759, 30004746], [30003947, 30003952]]);
    });
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send('jump-gates-updated', { ok: true, mine: 1, theirs: 2 }));
    });
    await expect(window.locator('#beaconImportCount')).toHaveText('1 gate saved · 2 of other alliances');
  });
});
