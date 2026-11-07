// The main character (src/func/characters.js): the ◆ on a card. It is the
// character the app speaks for: the portrait in the menu's top-left slot, the
// dashboard's banner and skill queue, the map's standings. Its card always
// comes first, there is always one, and a click on another card's ◇ moves it
// there at once, from what the app already has.
const { test, expect, FAKE_CHAR_ID, FAKE_CHAR_NAME } = require('./support/electron-app');

const SECOND = { characterId: 90000002, characterName: 'E2E Second Pilot' };

const menuName = (w) => w.locator('.nav-btn-characters .nav-active-char-name');
const bannerName = (w) => w.locator('#dashboardWelcomeBanner .dashboard-welcome-name');
const cards = (w) => w.locator('#accountsListNav .character-card');
const savedMain = (w) => w.evaluate(() => JSON.parse(localStorage.getItem('char_favorites') || '[]'));

async function openCharacters(window) {
  await window.locator('.nav-btn[data-page="characters"]').click();
  await expect(cards(window)).toHaveCount(2, { timeout: 10_000 });
}

test.describe('with two characters', () => {
  test.use({ extraCharacters: [SECOND] });

  test('the first character is the main until another is picked, and the card itself picks nothing', async ({ window }) => {
    await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
    await expect(menuName(window)).toHaveText(FAKE_CHAR_NAME);
    await expect(bannerName(window)).toContainText(FAKE_CHAR_NAME);
    expect(await savedMain(window)).toEqual([String(FAKE_CHAR_ID)]);      // settled and kept

    await openCharacters(window);
    const first = cards(window).first();
    await expect(first).toHaveAttribute('data-character-id', String(FAKE_CHAR_ID));
    await expect(first.locator('.character-fav-btn')).toHaveText('◆');
    await expect(first.locator('.character-fav-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(first.locator('.character-active-badge')).toHaveText('● MAIN');
    await expect(cards(window).nth(1).locator('.character-fav-btn')).toHaveText('◇');
    await expect(cards(window).nth(1).locator('.character-active-badge')).toHaveCount(0);

    // Only the diamond picks the main now.
    await cards(window).nth(1).locator('.character-card-name').click();
    await expect(menuName(window)).toHaveText(FAKE_CHAR_NAME);
    await expect(cards(window).first()).toHaveAttribute('data-character-id', String(FAKE_CHAR_ID));
  });

  test('a ◇ makes that character the main at once: first card, menu portrait, dashboard', async ({ window }) => {
    const errors = [];
    window.on('pageerror', (e) => errors.push(e.message));
    await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
    await expect(bannerName(window)).toContainText(FAKE_CHAR_NAME);
    await openCharacters(window);
    // Counts the dashboard's full draws from here on: a new main repaints in place.
    await window.evaluate(() => {
      window.__dashboardLoads = 0;
      const load = window.loadDashboard;
      window.loadDashboard = (...a) => { window.__dashboardLoads++; return load(...a); };
    });

    await cards(window).nth(1).locator('.character-fav-btn').click();

    // Its card takes the first slot, with the ◆ and the badge, and the old main's
    // card keeps a ◇ and can be dragged again.
    await expect(cards(window).first()).toHaveAttribute('data-character-id', String(SECOND.characterId));
    await expect(cards(window).first().locator('.character-fav-btn')).toHaveText('◆');
    await expect(cards(window).first().locator('.character-active-badge')).toHaveText('● MAIN');
    await expect(cards(window).first()).toHaveAttribute('draggable', 'false');
    await expect(cards(window).nth(1).locator('.character-fav-btn')).toHaveText('◇');
    await expect(cards(window).nth(1)).toHaveAttribute('draggable', 'true');
    await expect(window.locator('#consoleLog')).toContainText(`Main character: ${SECOND.characterName}`);   // the status bar's log

    // The menu's top-left portrait and the panel above the cards follow.
    await expect(menuName(window)).toHaveText(SECOND.characterName);
    await expect(window.locator('.nav-btn-characters .nav-icon-portrait'))
      .toHaveAttribute('src', new RegExp(`/characters/${SECOND.characterId}/portrait`));
    await expect(window.locator('#selectedCharName')).toHaveText(SECOND.characterName);
    expect(await savedMain(window)).toEqual([String(SECOND.characterId)]);

    // The dashboard already shows it, while still out of sight, and was not drawn again.
    await expect(bannerName(window)).toContainText(SECOND.characterName);
    await window.locator('.nav-btn[data-page="dashboard"]').click();
    await expect(bannerName(window)).toBeVisible();
    await expect(bannerName(window)).toContainText(SECOND.characterName);
    expect(await window.evaluate(() => window.__dashboardLoads)).toBe(0);

    // The main's own ◆ does nothing: there is always a main.
    await openCharacters(window);
    await cards(window).first().locator('.character-fav-btn').click();
    await expect(menuName(window)).toHaveText(SECOND.characterName);
    expect(await savedMain(window)).toEqual([String(SECOND.characterId)]);
    expect(errors).toEqual([]);
  });

  test('a slow paint of the old main never covers the new one', async ({ window, electronApp }) => {
    await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
    await expect(bannerName(window)).toContainText(FAKE_CHAR_NAME);
    // The old main's character data held back, the way a slow live refresh
    // would hold its repaint; the new main's comes straight back (never synced),
    // and so does its own live refresh, so nothing repaints it after the old one.
    await electronApp.evaluate(({ ipcMain }, oldId) => {
      let release;
      const held = new Promise(r => { release = r; });
      global.__releaseOld = () => release();
      ipcMain.removeHandler('get-character-info-db');
      ipcMain.handle('get-character-info-db', (_e, id) => (String(id) === String(oldId)
        ? held.then(() => ({ info: { birthday: '2010-01-01T00:00:00Z', security_status: 1 } }))
        : null));
      ipcMain.removeHandler('sync-character-status');
      ipcMain.handle('sync-character-status', () => ({ ok: true }));
    }, FAKE_CHAR_ID);
    await openCharacters(window);
    await window.evaluate(([id, name]) => {
      window.__oldPaint = _paintWelcomeBanner({ characterId: id, characterName: name }, { live: false });
    }, [FAKE_CHAR_ID, FAKE_CHAR_NAME]);

    await cards(window).nth(1).locator('.character-fav-btn').click();
    await expect(bannerName(window)).toContainText(SECOND.characterName);
    await window.waitForTimeout(500);                      // the new main's live repaint, done

    await electronApp.evaluate(() => global.__releaseOld());
    await window.evaluate(() => window.__oldPaint);
    await expect(bannerName(window)).toContainText(SECOND.characterName);
    await expect(bannerName(window)).not.toContainText(FAKE_CHAR_NAME);
  });

  test('the main stays the main, and first, when the app opens again', async ({ window }) => {
    await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
    await openCharacters(window);
    await cards(window).nth(1).locator('.character-fav-btn').click();
    await expect(menuName(window)).toHaveText(SECOND.characterName);

    await window.reload();
    await window.waitForLoadState('domcontentloaded');
    await expect(menuName(window)).toHaveText(SECOND.characterName, { timeout: 20_000 });
    await openCharacters(window);
    await expect(cards(window).first()).toHaveAttribute('data-character-id', String(SECOND.characterId));
    // Nothing announced for a main the app settled on by itself.
    await expect(window.locator('#consoleLog')).not.toContainText('Main character:');
  });

  test('no card can be dragged in front of the main’s', async ({ window }) => {
    await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
    await openCharacters(window);
    // The drag events the cards listen for, the second card held over the top
    // edge of the main's, where a drop would put it first.
    await window.evaluate(() => {
      const [main, other] = document.querySelectorAll('#accountsListNav .character-card');
      const dataTransfer = new DataTransfer();
      other.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      other.classList.add('dragging');                     // the card marks itself a tick later
      const r = main.getBoundingClientRect();
      main.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer, clientX: r.left + 20, clientY: r.top + 2,
      }));
      other.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    });
    await expect(cards(window).first()).toHaveAttribute('data-character-id', String(FAKE_CHAR_ID));
    await expect(cards(window).nth(1)).toHaveAttribute('data-character-id', String(SECOND.characterId));
  });
});

test('a lone character is the main without asking', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await expect(menuName(window)).toHaveText(FAKE_CHAR_NAME);
  await window.locator('.nav-btn[data-page="characters"]').click();
  await expect(cards(window)).toHaveCount(1, { timeout: 10_000 });
  await expect(cards(window).first().locator('.character-fav-btn')).toHaveText('◆');
  await expect(window.locator('#page-characters .page-description')).toContainText('main character');
});
