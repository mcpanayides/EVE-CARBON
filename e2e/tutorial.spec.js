// The guided tour (src/func/tutorial.js). Started from Settings → General, it
// walks the real app with everything but the explained control dimmed, waits
// for real actions (a page opened, a widget added), and remembers that it ran.
//
// The fixture profile already has a character, which is the path a returning
// pilot takes through the basics: "Add more characters", then their own card.
// The first-launch path (no characters, opening by itself) needs SSO to go
// further than the add step, so that is checked by the unit tests for
// shouldAutoStart and by the suppression test below.
const { test, expect } = require('./support/electron-app');
const fs = require('fs');
const path = require('path');

const title = (w) => w.locator('.tour-card .tour-title');
const count = (w) => w.locator('.tour-card .tour-count');
const btn = (w, label) => w.locator('.tour-card .tour-btn', { hasText: label });

async function openGeneral(window) {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.locator('#openSettingsBtn').click();
  await window.locator('[data-settings-tab="general"]').click();
  await expect(window.locator('#settingsTabGeneral')).toBeVisible({ timeout: 15_000 });
}

// The ring is drawn around the control it is talking about: around the part of
// it that can be seen, when it is taller than the area it scrolls in (a
// character card is, at this window size).
async function ringSurrounds(window, selector, scrollArea) {
  const ring = await window.locator('.tour-ring').boundingBox();
  let el = await window.locator(selector).first().boundingBox();
  if (el && scrollArea) {
    const area = await window.locator(scrollArea).boundingBox();
    const top = Math.max(el.y, area.y), bottom = Math.min(el.y + el.height, area.y + area.height);
    el = { ...el, y: top, height: bottom - top };
  }
  return !!ring && !!el
    && ring.x <= el.x + 1 && ring.y <= el.y + 1
    && ring.x + ring.width >= el.x + el.width - 1 && ring.y + ring.height >= el.y + el.height - 1;
}

function savedTutorial(profile) {
  return JSON.parse(fs.readFileSync(path.join(profile.userDataDir, 'config.json'), 'utf8')).app?.tutorial || {};
}

test('the basics walk the real app, wait for real actions, and remember they ran', async ({ window, profile }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));

  await openGeneral(window);
  await window.locator('#tutorialStartBtn').click();
  await expect(window.locator('#uiSettingsDrawer')).toBeHidden();      // the basics start in the menu
  await expect(title(window)).toHaveText('Welcome to EVE Carbon');
  await btn(window, 'Start the tour').click();

  // The app opened on the dashboard, so the tour first asks for Characters.
  await expect(title(window)).toHaveText('Start with your characters');
  // The ring glides between controls, so wait for it to arrive.
  await expect.poll(() => ringSurrounds(window, '.nav-btn[data-page="characters"]')).toBe(true);

  // A click on the dimmed page is held: nothing behind the tour reacts to it.
  await window.mouse.click(1200, 600);
  expect(await window.evaluate(() => currentPage)).toBe('dashboard');

  // The real nav button, through the hole: the tour moves on when the page opens.
  await window.locator('.nav-btn[data-page="characters"]').click();
  await expect(title(window)).toHaveText('Add more characters', { timeout: 5_000 });
  await expect(window.locator('.tour-card')).toContainText('You have 1 character here');
  await btn(window, 'Next').click();

  await expect(title(window)).toHaveText('Each card is a character');
  await expect.poll(() => ringSurrounds(window, '#accountsListNav .character-card', '#accountsListNav')).toBe(true);
  await btn(window, 'Next').click();

  // The main character: with one, it already is; the stop says what the ◆ does.
  await expect(title(window)).toHaveText('Pick your main character');
  await expect.poll(() => ringSurrounds(window, '#accountsListNav .character-card', '#accountsListNav')).toBe(true);
  await expect(window.locator('.tour-card')).toContainText('The ◆ marks your main character');
  await expect(window.locator('.tour-card')).toContainText('When you add more characters');
  await expect(window.locator('#accountsListNav .character-card .character-fav-btn')).toHaveText('◆');
  await btn(window, 'Next').click();

  await expect(title(window)).toHaveText('Open your dashboard');
  await window.locator('.nav-btn[data-page="dashboard"]').click();

  // The total holds while the chapter goes on: 2 of 3 before the widget exists.
  await expect(title(window)).toHaveText('Add a widget', { timeout: 5_000 });
  await expect(count(window)).toHaveText('2 of 3');
  await window.locator('.dashboard-add-widget-btn').click();
  await window.locator('#dashboardAddWidgetMenu .dashboard-add-item:not(.is-note)').first().click();
  // A widget that needs a subject asks for it in the same menu.
  const second = window.locator('#dashboardAddWidgetMenu .dashboard-add-item:not(.is-note)').first();
  if (await window.locator('#dashboardAddWidgetMenu').isVisible() && await second.count()) await second.click();

  await expect(title(window)).toHaveText('Make it yours', { timeout: 5_000 });
  await expect(count(window)).toHaveText('3 of 3');

  for (const next of ['EVE Mail', 'Industry', 'Everything else', 'Settings', 'That’s the basics']) {
    await btn(window, 'Next').click();
    await expect(title(window)).toHaveText(next);
  }
  await btn(window, 'Finish').click();
  await expect(window.locator('.tour-root')).toHaveCount(0);
  await expect(window.locator('body')).not.toHaveClass(/tour-active/);

  await expect.poll(() => savedTutorial(profile)).toMatchObject({ seen: true, basicDone: true });
  expect(errors).toEqual([]);
});

test('alliance tools open each Settings tab with its block lit, and SAVE finishes', async ({ window, profile }) => {
  await openGeneral(window);
  await window.locator('#tutorialAdvancedBtn').click();
  await expect(title(window)).toHaveText('Set up your alliance tools');
  await btn(window, 'Start').click();

  const stops = [
    ['Pick your alliance pack', '#settingsTabJabber', '#jabberPackSelect'],
    ['Sign in to Jabber',       '#settingsTabJabber', '#jabberService'],
    ['Connect your forum',      '#settingsTabForums', '#forumUrlInput'],
    // GEZ is Goonswarm's word; this pilot's alliance is made up, so the plain one.
    ['Add your sovereignty upgrades', '#settingsTabIndustry', '#industrySheetUrl'],
    ['Your jump gates',         '#settingsTabJumpgates', '#beaconImportInput'],
  ];
  for (const [i, [name, tab, field]] of stops.entries()) {
    if (i) await btn(window, 'Next').click();
    await expect(title(window)).toHaveText(name);
    await expect(window.locator(tab)).toBeVisible();
    await expect.poll(() => ringSurrounds(window, field)).toBe(true);
    // Every pack that comes built in is named at the pack stop, in order.
    if (field === '#jabberPackSelect') {
      await expect(window.locator('.tour-card .tour-hint'))
        .toContainText('Brave Collective, The Imperium, The Initiative and Winter Coalition.');
    }
    // The Imperium, picked by default, names its server: filled in for anyone
    // who picks the pack, members or not.
    if (field === '#jabberService') {
      await expect(window.locator('.tour-card .tour-hint-label')).toHaveText('The Imperium');
      await expect(window.locator('.tour-card .tour-hint'))
        .toContainText('Your pack fills in the server, xmpp://goonfleet.com:5222. Your Jabber address ends in @goonfleet.com.');
      await expect(window.locator('#jabberService')).toHaveValue('xmpp://goonfleet.com:5222');
    }
    // The picked pack's forum. Its address is public (applicants need it too), so
    // this pilot gets the hint without being a member. It is Goonswarm's forum,
    // in the Imperium's pack, and labelled so.
    if (field === '#forumUrlInput') {
      await expect(window.locator('.tour-card .tour-hint-label')).toHaveText('Goonswarm Federation');
      await expect(window.locator('.tour-card .tour-hint')).toContainText('The address is https://goonfleet.com/');
    }
    // The fixture pilot's alliance is made up, so neither the GEZ stop nor the
    // jump gate stop offers Goonswarm's pages in the Imperium's pack (tests below do).
    if (field === '#industrySheetUrl' || field === '#beaconImportInput') {
      await expect(window.locator('.tour-card .tour-hint')).toHaveCount(0);
    }
  }

  await btn(window, 'Next').click();
  await expect(title(window)).toHaveText('Save what you entered');
  await window.locator('#saveSettingsBtn').click();                 // through the hole
  await expect(title(window)).toHaveText('You’re set up');
  await expect(window.locator('#uiSettingsDrawer')).toBeHidden();
  await btn(window, 'Done').click();
  await expect(window.locator('.tour-root')).toHaveCount(0);
  await expect.poll(() => savedTutorial(profile)).toMatchObject({ seen: true, advancedDone: true });
});

// The alliance pack names where members find the GEZ sheet and the gate list
// (pack_info.links). Goonswarm's pages sit behind its sign-in, so the tour sends
// members there, never to the sheet or the list. A member is a pilot with a
// character in the pack's alliance, and nothing else.
const GEZ_TOPIC = 'https://goonfleet.com/index.php/topic/361575-gez-goonswarm-economic-zones-mkii';
const STARGATE = 'https://wiki.goonswarm.org/w/Alliance:Stargate';
const hint = (w) => w.locator('.tour-card .tour-hint');
const hintLink = (w) => w.locator('.tour-card .tour-hint-link');
const hintLinkWords = (w) => w.locator('.tour-card .tour-hint-link-text');   // the button's text includes the glyph's name

async function walkToGez(window, { pack, jabber, forum } = {}) {
  await openGeneral(window);
  await window.locator('#tutorialAdvancedBtn').click();
  await btn(window, 'Start').click();
  await expect(title(window)).toHaveText('Pick your alliance pack');
  if (pack) await pack();
  await btn(window, 'Next').click();
  await expect(title(window)).toHaveText('Sign in to Jabber');
  if (jabber) await jabber();
  await btn(window, 'Next').click();
  await expect(title(window)).toHaveText('Connect your forum');
  if (forum) await forum();
  await btn(window, 'Next').click();
  // "GEZ tracker" for Goonswarm pilots, "sovereignty upgrades" for everyone else.
  await expect(title(window)).toHaveText(/^Add your (GEZ tracker|sovereignty upgrades)$/);
}

async function nextToGates(window) {
  await btn(window, 'Next').click();
  await expect(title(window)).toHaveText('Your jump gates');
}

// Another alliance's pack, for the fixture pilot's made-up alliance, as someone
// would import it. It names its own pages, on reserved .example hosts.
const TEST_PACK_ID = 'user:test_alliance.yaml';
function writeTestPack(profile) {
  fs.writeFileSync(path.join(profile.userDataDir, 'packs', 'test_alliance.yaml'), [
    'pack_info:',
    '  name: "Test Alliance"',
    '  alliance: "Test Alliance"',
    '  alliance_id: 99000001',
    '  links:',
    '    gez:',
    '      label: "Test GEZ thread"',
    '      url: "https://forum.test-alliance.example/topic/1-gez"',
    '    jump_gates: "https://wiki.test-alliance.example/gates"',
    'groups:',
    '  - name: "All"',
    '    display_name: "[A] All"',
    '    type: "ALL"',
    '',
  ].join('\n'));
}

test('a goonfleet.com Jabber address and forum alone do not get the Goonswarm pages', async ({ window }) => {
  // Someone still applying to join can have both set up. The fixture pilot's
  // alliance is made up, so this is not a member.
  await walkToGez(window, {
    jabber: () => window.locator('#jabberJid').fill('pilot@goonfleet.com'),
    forum: () => window.locator('#forumUrlInput').fill('https://goonfleet.com/'),
  });
  await expect(window.locator('#jabberJid')).toHaveValue('pilot@goonfleet.com');   // still there to be read
  await expect(hint(window)).toHaveCount(0);
  await nextToGates(window);
  await expect(hint(window)).toHaveCount(0);
});

test('another alliance’s pack offers its own pages, and keeps them through an edit', async ({ window, profile }) => {
  writeTestPack(profile);
  // Saved the way the Pack Editor saves it: the form has no fields for the
  // alliance id or the pages, and the edit must not drop them.
  expect(await window.evaluate((id) => window.eveAPI.savePack({
    id, packInfo: { name: 'Test Alliance', alliance: 'Test Alliance', description: 'Edited', author: 'e2e' },
    groups: [{ name: 'All', display_name: '[A] All', type: 'ALL', color: '#78909C' }], comms_channels: [],
  }), TEST_PACK_ID)).toMatchObject({ success: true, id: TEST_PACK_ID });

  await walkToGez(window, {
    pack: () => window.locator('#jabberPackSelect').selectOption(TEST_PACK_ID),
    // A pack naming no server leaves the app's default, and the stop says nothing about it.
    jabber: async () => {
      await expect(hint(window)).toHaveCount(0);
      await expect(window.locator('#jabberService')).toHaveValue('xmpp://jabber.eveonline.com:5222');
    },
  });
  await expect(window.locator('.tour-card .tour-hint-label')).toHaveText('Test Alliance');
  await expect(hintLinkWords(window)).toHaveText('Test GEZ thread');
  await nextToGates(window);
  await expect(hintLinkWords(window)).toHaveText('wiki.test-alliance.example');   // no label: named after its site
});

test.describe('a pilot in Goonswarm Federation', () => {
  test.use({ allianceId: 1354830081 });

  test('is sent to the GEZ topic and the Stargate page in the browser, and the app stays put', async ({ window, electronApp }) => {
    // What the browser would be asked to open, without opening one.
    await electronApp.evaluate(({ shell }) => {
      global.__opened = [];
      shell.openExternal = async (url) => { global.__opened.push(url); };
    });
    await walkToGez(window);                       // the Imperium's pack, picked by default; nothing else entered
    await expect(title(window)).toHaveText('Add your GEZ tracker');           // GEZ is their word
    await expect(window.locator('.tour-card .tour-hint-label')).toHaveText('Goonswarm Federation');
    await expect(hintLinkWords(window)).toHaveText('Goonswarm Economic Zones MkII');

    const appUrl = window.url();
    await hintLink(window).click();
    await expect.poll(() => electronApp.evaluate(() => global.__opened)).toEqual([GEZ_TOPIC]);

    await nextToGates(window);
    await expect(hintLinkWords(window)).toHaveText('Alliance:Stargate');
    await hintLink(window).click();
    await expect.poll(() => electronApp.evaluate(() => global.__opened)).toEqual([GEZ_TOPIC, STARGATE]);
    expect(window.url()).toBe(appUrl);
    await expect(title(window)).toHaveText('Your jump gates');
  });

  test('with another alliance’s pack picked, the Goonswarm pages stay hidden', async ({ window, profile }) => {
    writeTestPack(profile);
    await walkToGez(window, { pack: () => window.locator('#jabberPackSelect').selectOption(TEST_PACK_ID) });
    await expect(hint(window)).toHaveCount(0);
    await nextToGates(window);
    await expect(hint(window)).toHaveCount(0);
  });
});

// The rest of the Imperium: in the coalition's pack, but Goonswarm's word, topic
// and wiki page stay Goonswarm's. The server is for everyone who picks the pack.
test.describe('a pilot in Brave Collective, one of the Imperium’s alliances', () => {
  test.use({ allianceId: 99003214 });

  test('gets the Imperium’s server, and none of Goonswarm’s own pages', async ({ window }) => {
    await walkToGez(window, {
      jabber: () => expect(window.locator('.tour-card .tour-hint-label')).toHaveText('The Imperium'),
    });
    await expect(title(window)).toHaveText('Add your sovereignty upgrades');
    await expect(hint(window)).toHaveCount(0);
    await nextToGates(window);
    await expect(hint(window)).toHaveCount(0);
  });
});

// The main character's stop, with a choice to make: every card is lit, and a ◇
// clicked through the dimming moves the tour on once the card has moved first.
test.describe('with two characters', () => {
  test.use({ extraCharacters: [{ characterId: 90000002, characterName: 'E2E Second Pilot' }] });

  test('the tour asks for a main character, and moves on once one is picked', async ({ window }) => {
    await openGeneral(window);
    await window.locator('#tutorialStartBtn').click();
    await btn(window, 'Start the tour').click();
    await window.locator('.nav-btn[data-page="characters"]').click();
    await expect(title(window)).toHaveText('Add more characters', { timeout: 5_000 });
    await btn(window, 'Next').click();
    await expect(title(window)).toHaveText('Each card is a character');
    await btn(window, 'Next').click();

    await expect(title(window)).toHaveText('Pick your main character');
    await expect(window.locator('.tour-card')).toContainText('Click the ◇ on the character you fly most');
    await expect(window.locator('.tour-card .tour-status')).toHaveText('Click a ◇ to pick your main.');
    await expect(btn(window, 'Next')).toBeVisible();                     // or keep the one there is
    const second = window.locator('#accountsListNav .character-card[data-character-id="90000002"]');
    await expect.poll(() => ringSurrounds(window, '#accountsListNav .character-card[data-character-id="90000002"] .character-fav-btn')).toBe(true);
    await second.locator('.character-fav-btn').click();

    await expect(window.locator('#accountsListNav .character-card').first()).toHaveAttribute('data-character-id', '90000002');
    await expect(window.locator('.nav-btn-characters .nav-active-char-name')).toHaveText('E2E Second Pilot');
    await expect(title(window)).toHaveText('Open your dashboard', { timeout: 5_000 });
  });
});

test('Esc leaves the tour and says where to start it again', async ({ window, profile }) => {
  await openGeneral(window);
  await window.locator('#tutorialStartBtn').click();
  await expect(title(window)).toHaveText('Welcome to EVE Carbon');
  await window.keyboard.press('Escape');
  await expect(window.locator('.tour-root')).toHaveCount(0);
  await expect(window.locator('#appToastStack')).toContainText('Settings, General');
  await expect.poll(() => savedTutorial(profile)).toMatchObject({ seen: true });
  expect(savedTutorial(profile).basicDone).toBeFalsy();
});

test('donate prompts wait for the tour to end, and a donate click mid-tour opens above it', async ({ window }) => {
  // donation.js holds a prompt that falls due during a tour and shows it a few
  // minutes after the tour ends. Its timers never arm under e2e, so the prompt is
  // asked for directly, the way they ask. The 3-minute wait after the tour is
  // cut to 1 s by patching setTimeout for that one delay (nothing else in the
  // renderer waits 180 000 ms).
  await openGeneral(window);
  await window.evaluate(() => {
    window.__idle = 0;
    document.addEventListener('tutorial-idle', () => { window.__idle++; });
    const orig = window.setTimeout;
    window.setTimeout = (fn, ms, ...a) => orig.call(window, fn, ms === 180_000 ? 1_000 : ms, ...a);
  });
  const donate = window.locator('#donateBackdrop');
  const marked = () => window.evaluate(() => localStorage.getItem('donationUsageShownDay'));

  await window.locator('#tutorialStartBtn').click();
  await expect(title(window)).toHaveText('Welcome to EVE Carbon');
  await window.evaluate(() => _showDonate('usage', () => localStorage.setItem('donationUsageShownDay', 'e2e')));
  await window.waitForTimeout(300);
  await expect(donate).toBeHidden();
  expect(await marked()).toBeNull();                      // held, so not yet shown today

  // Asked for on purpose (the menu stays clickable on "Everything else"), the
  // window opens above the dimming, and Esc closes it without ending the tour.
  await window.evaluate(() => openDonateModal());
  await expect(donate).toBeVisible();
  expect(await window.evaluate(() => {
    const r = document.getElementById('donateBackdrop').firstElementChild.getBoundingClientRect();
    return !!document.elementFromPoint(r.left + r.width / 2, r.top + 12)?.closest('#donateBackdrop');
  })).toBe(true);
  await window.keyboard.press('Escape');
  await expect(donate).toBeHidden();
  await expect(window.locator('.tour-root')).toHaveCount(1);

  // The basics handing over to alliance tools is one go: nothing hears an end.
  await window.evaluate(() => { exitTutorial('finished', { quiet: true }); startTutorial('advanced', { fromBasic: true }); });
  await expect(title(window)).toHaveText('Pick your alliance pack');
  await window.waitForTimeout(1_500);                      // longer than the shortened wait
  expect(await window.evaluate(() => window.__idle)).toBe(0);
  await expect(donate).toBeHidden();

  // The tour ends: the prompt follows after the wait, and only then counts as shown.
  // Timed from before the click, so a slow machine can only make it later.
  const closedAt = Date.now();
  await window.locator('.tour-card .tour-close').click();
  await expect(window.locator('.tour-root')).toHaveCount(0);
  await expect.poll(() => window.evaluate(() => window.__idle)).toBe(1);
  await expect(donate).toBeVisible({ timeout: 5_000 });
  expect(Date.now() - closedAt).toBeGreaterThanOrEqual(1_000);
  expect(await marked()).toBe('e2e');
});

test('an e2e run never opens the tour by itself, even with no characters left', async ({ window }) => {
  // The case the main process's suppressAutoStart exists for: a test that
  // removes its last character and reloads would otherwise land on a first
  // launch, and the tour would sit over everything it does next.
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  expect(await window.evaluate(() => window.eveAPI.getTutorialState())).toMatchObject({ suppressAutoStart: true });
  await window.evaluate(() => window.eveAPI.removeAllAccounts());
  await window.reload();
  await window.waitForLoadState('domcontentloaded');
  await expect(window.locator('#page-characters')).toBeVisible({ timeout: 20_000 });
  await window.waitForTimeout(1_500);
  await expect(window.locator('.tour-root')).toHaveCount(0);
});
