const { BrowserWindow, session, net } = require('electron');

// Persistent session partition for the alliance IP.Board forum. Login cookies
// live here (on disk, OS-isolated) — we never store the user's password.
const FORUM_PARTITION = 'persist:forum';

// Runs INSIDE the loaded forum page (via executeJavaScript) to read the two
// member-only blocks goonfleet.com shows on its forum index: "Upcoming Events"
// (Title / Start Time / Time To Event) and "Upcoming Moon Extractions" (Moon /
// Region / Arrival / Autofrack / Composition / Time to Event). Tables are matched
// by their header signature — not by fragile class names — so a theme change
// won't break it. Returns plain rows; all date strings are EVE/UTC. Async because
// the moon block can sit behind a "Show" toggle that we click and wait out.
async function _forumScraper() {
  const norm  = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait for either block's text to appear (server-rendered or JS-injected).
  const ready = () => /upcoming events|moon extraction/i.test((document.body && document.body.innerText) || '');
  for (let i = 0; i < 30 && !ready(); i++) await sleep(200);

  // Read a <table> into { heads:[lowercased], data:[{head:value}] }.
  function tableData(t) {
    const rows = Array.from(t.querySelectorAll('tr'));
    if (!rows.length) return { heads: [], data: [] };
    const headerRow = rows.find((r) => r.querySelector('th')) || rows[0];
    const heads = Array.from(headerRow.children).map((c) => norm(c.textContent).toLowerCase());
    const data = [];
    for (const r of rows) {
      if (r === headerRow) continue;
      const cells = Array.from(r.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
      if (!cells.length) continue;
      const obj = {};
      cells.forEach((c, i) => { obj[heads[i] || ('col' + i)] = norm(c.textContent); });
      data.push(obj);
    }
    return { heads, data };
  }

  // Classify every table on the page by its header columns.
  function classify() {
    let events = [], moons = [];
    for (const t of Array.from(document.querySelectorAll('table'))) {
      const { heads, data } = tableData(t);
      if (!data.length) continue;
      const sig = heads.join('|');
      if (/\btitle\b/.test(sig) && /start time/.test(sig)) {
        events = data
          .map((r) => ({ title: r['title'] || '', start: r['start time'] || '', timeToEvent: r['time to event'] || '' }))
          .filter((r) => r.title && r.start);
      } else if (/\bmoon\b/.test(sig) && /arrival/.test(sig)) {
        moons = data
          .map((r) => ({
            moon:        r['moon'] || '',
            region:      r['region'] || '',
            arrival:     r['arrival'] || '',
            autofrack:   r['autofrack'] || r['auto frack'] || r['autofrac'] || '',
            composition: r['composition'] || '',
            timeToEvent: r['time to event'] || '',
          }))
          .filter((r) => r.moon && r.arrival);
      }
    }
    return { events, moons };
  }

  let out = classify();

  // Moon block collapsed behind a "Show" toggle? Click it and re-read.
  if (!out.moons.length) {
    const toggle = Array.from(document.querySelectorAll('a,button,span,div'))
      .find((e) => /^show$/i.test(norm(e.textContent)) && norm(e.textContent).length <= 6);
    if (toggle) {
      try { toggle.click(); } catch (_) {}
      for (let i = 0; i < 15; i++) { await sleep(200); out = classify(); if (out.moons.length) break; }
    }
  }

  return { url: location.href, events: out.events, moons: out.moons };
}
const FORUM_SCRAPER_SRC = _forumScraper.toString();

/**
 * registerForumHandlers
 *
 * Lets the Calendar read member-only IP.Board calendar feeds/pages by logging in
 * through an embedded browser window and reusing that session's cookies.
 *
 * @param {object} deps
 * @param {function} deps.ipcHandle - safe ipcMain.handle wrapper
 */
function registerForumHandlers({ ipcHandle }) {

  // Open the forum in an embedded browser so the user can log in (2FA handled in
  // the window). Resolves when the window is closed. Cookies persist in
  // FORUM_PARTITION for later authenticated fetches.
  ipcHandle('forum-login', async (_, baseUrl) => {
    let url = String(baseUrl || '').trim();
    if (!url) throw new Error('No forum URL');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1000, height: 840, title: 'Forum Login',
        autoHideMenuBar: true,
        webPreferences: { partition: FORUM_PARTITION, nodeIntegration: false, contextIsolation: true },
      });
      win.setMenuBarVisibility(false);
      win.loadURL(url).catch(() => {});
      win.on('closed', () => resolve({ ok: true }));
    });
  });

  // Best-effort "are we logged in?" check from the partition's cookies.
  // IP.Board (Invision Community) sets ips4_member_id / ips4_login_key on login.
  ipcHandle('forum-session-status', async () => {
    try {
      const cookies = await session.fromPartition(FORUM_PARTITION).cookies.get({});
      const loggedIn = cookies.some(c =>
        /member_id|login_key/i.test(c.name) && c.value && c.value !== '0' && c.value !== 'deleted');
      return { loggedIn };
    } catch (_) {
      return { loggedIn: false };
    }
  });

  // Fetch a URL through the forum session so member-only ICS feeds / pages load
  // with the logged-in cookies. https only; follows redirects.
  ipcHandle('forum-fetch-text', async (_, url) => {
    const u = String(url || '');
    if (!/^https:\/\//i.test(u)) throw new Error('Only https URLs are allowed');
    return new Promise((resolve, reject) => {
      const request = net.request({ url: u, partition: FORUM_PARTITION, redirect: 'follow' });
      request.setHeader('User-Agent', 'EVE-Carbon/1.0');
      request.setHeader('Accept', 'text/calendar,text/plain,*/*');
      let data = '';
      request.on('response', (response) => {
        if (response.statusCode >= 400) {
          response.on('data', () => {});
          response.on('end', () => reject(new Error(`HTTP ${response.statusCode}`)));
          return;
        }
        response.on('data', chunk => { data += chunk.toString('utf8'); });
        response.on('end', () => resolve(data));
      });
      request.on('error', reject);
      request.end();
    });
  });

  // Scrape the goonfleet.com forum index for its member-only "Upcoming Events" and
  // "Upcoming Moon Extractions" blocks. Loads the forum in a hidden window that
  // shares the saved login session (FORUM_PARTITION), reads the rendered tables,
  // then disposes the window. Returns { url, events:[], moons:[] }. Best-effort:
  // an empty result (logged out, blocks absent) is normal, never an error.
  let _scrapeBusy = false;
  ipcHandle('forum-scrape-events', async (_, baseUrl) => {
    if (_scrapeBusy) return { events: [], moons: [], busy: true };
    let url = String(baseUrl || 'https://goonfleet.com/').trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    _scrapeBusy = true;
    const win = new BrowserWindow({
      show: false, width: 1500, height: 1400,
      webPreferences: { partition: FORUM_PARTITION, nodeIntegration: false, contextIsolation: true, images: false },
    });
    try {
      await win.loadURL(url).catch(() => {});   // resolves on main-frame load; ignore sub-resource errors
      const data = await win.webContents.executeJavaScript('(' + FORUM_SCRAPER_SRC + ')()', true);
      return data && typeof data === 'object' ? data : { events: [], moons: [] };
    } catch (e) {
      return { events: [], moons: [], error: e.message };
    } finally {
      try { win.destroy(); } catch (_) {}
      _scrapeBusy = false;
    }
  });

  // Clear the forum login session.
  ipcHandle('forum-logout', async () => {
    try { await session.fromPartition(FORUM_PARTITION).clearStorageData(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { registerForumHandlers };
