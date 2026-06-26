const { BrowserWindow, session, net } = require('electron');

// Persistent session partition for the alliance IP.Board forum. Login cookies
// live here (on disk, OS-isolated) — we never store the user's password.
const FORUM_PARTITION = 'persist:forum';

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

  // Clear the forum login session.
  ipcHandle('forum-logout', async () => {
    try { await session.fromPartition(FORUM_PARTITION).clearStorageData(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { registerForumHandlers };
