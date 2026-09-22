// Jabber page: autoConnectJabber() reads jabber credentials from app config —
// the fixture never sets any (app.jabber is absent), so it must show the
// "credentials missing" status rather than attempting a live XMPP connection.
// The ping table falls back to its local DB history (empty for a fresh fixture).
const { test, expect } = require('./support/electron-app');

test('shows missing-credentials status and an empty ping table', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));

  await window.locator('.nav-btn[data-page="jabber"]').click();
  await expect(window.locator('#page-jabber')).toBeVisible({ timeout: 15_000 });

  await expect(window.locator('#jabberStatus')).toContainText(
    'Jabber credentials missing',
    { timeout: 10_000 }
  );
  await expect(window.locator('#jabberTable')).toContainText('No messages received yet.', { timeout: 10_000 });
  await expect(window.locator('#jabberSummary')).toContainText('0 pings');

  expect(errors).toEqual([]);
});

// The rooms rail sits beside the ping feed. With no rooms configured it must
// still show Broadcasts and stay on it — the feed this page was built for cannot
// become unreachable just because the rooms feature was added around it.
test('rooms rail shows Broadcasts and an empty room list', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));

  await window.locator('.nav-btn[data-page="jabber"]').click();
  await expect(window.locator('#page-jabber')).toBeVisible({ timeout: 15_000 });

  const rail = window.locator('#page-jabber .jabber-rail');
  await expect(rail).toBeVisible();
  await expect(rail.locator('.jabber-room-btn[data-room="__pings__"]')).toHaveClass(/active/);
  await expect(window.locator('#jabberRoomList .jabber-room-btn')).toHaveCount(0);
  await expect(window.locator('#jabberRoomHint')).toContainText('No rooms yet', { timeout: 10_000 });

  // Broadcasts is the visible pane; the chat pane stays out of the way.
  await expect(window.locator('#jabberPingsPane')).toBeVisible();
  await expect(window.locator('#jabberRoomPane')).toBeHidden();
  await expect(window.locator('#jabberAddRoomBtn')).toBeVisible();

  expect(errors).toEqual([]);
});

// Add room must open a real dialog. Electron's window.prompt() is a no-op that
// returns undefined, so the first version of this button silently did nothing —
// which no assertion on the button itself would have caught.
test('add room opens a dialog and adds the room to the rail', async ({ window }) => {
  await window.locator('.nav-btn[data-page="jabber"]').click();
  await expect(window.locator('#page-jabber')).toBeVisible({ timeout: 15_000 });

  await window.locator('#jabberAddRoomBtn').click();
  const modal = window.locator('.jabber-room-modal');
  await expect(modal).toBeVisible();

  // Empty address is refused without closing the dialog.
  await modal.locator('.jabber-room-modal-add').click();
  await expect(modal).toBeVisible();

  await window.locator('#jrRoomJidInput').fill('corp@conference.example.com');
  await window.locator('#jrRoomNameInput').fill('Corp Chat');
  await modal.locator('.jabber-room-modal-add').click();

  await expect(modal).toBeHidden();
  const room = window.locator('#jabberRoomList .jabber-room-btn');
  await expect(room).toHaveCount(1);
  await expect(room).toContainText('Corp Chat');

  // Opening it switches panes and offers the composer.
  await room.click();
  await expect(window.locator('#jabberRoomPane')).toBeVisible();
  await expect(window.locator('#jabberPingsPane')).toBeHidden();
  await expect(window.locator('#jabberRoomJid')).toHaveText('corp@conference.example.com');
  // Not connected, so sending is disabled rather than failing silently.
  await expect(window.locator('#jabberRoomSend')).toBeDisabled();
});

// Find rooms opens the discovery dialog. The fixture has no Jabber credentials
// and never connects, so this exercises the whole renderer path — dialog, host
// suggestion, query, error reporting — without touching any real server.
test('find rooms opens a discovery dialog and reports that it needs a connection', async ({ window }) => {
  await window.locator('.nav-btn[data-page="jabber"]').click();
  await expect(window.locator('#page-jabber')).toBeVisible({ timeout: 15_000 });

  await window.locator('#jabberFindRoomsBtn').click();
  const modal = window.locator('.jabber-roomlist-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('#jrDiscoJoin')).toBeDisabled();   // nothing selected yet

  // Not connected: the dialog says so instead of showing an empty list, which
  // would read as "this server has no rooms".
  await window.locator('#jrDiscoHost').fill('conference.example.com');
  await modal.locator('#jrDiscoGo').click();
  await expect(window.locator('#jrDiscoStatus')).toContainText('Connect to Jabber first', { timeout: 10_000 });
  await expect(window.locator('#jrDiscoStatus')).toHaveClass(/jabber-disco-error/);
  await expect(window.locator('#jrDiscoList .jabber-disco-item')).toHaveCount(0);
});

// Load older must stay live after a failure. The auto-pull on first open runs
// while disconnected and fails; a bug where that failure marked the archive
// "complete" left the button permanently inert, answering every click with
// "No older messages" — inert AND untrue. The fixture is never connected, so
// this exercises exactly that path.
test('load older keeps reporting the real error, click after click', async ({ window }) => {
  await window.locator('.nav-btn[data-page="jabber"]').click();
  await expect(window.locator('#page-jabber')).toBeVisible({ timeout: 15_000 });

  await window.locator('#jabberAddRoomBtn').click();
  await window.locator('#jrRoomJidInput').fill('history@conference.example.com');
  await window.locator('.jabber-room-modal-add').click();
  await expect(window.locator('.jabber-room-modal')).toBeHidden();

  await window.locator('#jabberRoomList .jabber-room-btn').first().click();
  await expect(window.locator('#jabberRoomPane')).toBeVisible();

  const older = window.locator('#jabberLoadOlderBtn');
  await expect(older).toBeVisible();

  // Every click reaches the server layer and reports what it said — twice over,
  // because the regression only showed on the click AFTER the first failure.
  // Counted rather than matched: each click adds a toast to the stack, so a
  // second click that did nothing would leave the count at one.
  const connectToasts = window.locator('.app-toast', { hasText: 'Connect to Jabber first' });
  for (const attempt of [1, 2]) {
    await older.click();
    await expect(connectToasts, `click ${attempt} reported nothing`)
      .toHaveCount(attempt, { timeout: 10_000 });
  }

  // Never claims the archive is empty — it was never successfully read.
  await expect(window.locator('.app-toast', { hasText: 'No older messages' })).toHaveCount(0);
  await expect(older).toBeEnabled();
});

// The room view has three parts beyond the log: the MOTD banner, the occupant
// roster on the right, and the composer toolbar. All three are inert without a
// connection, but they must be present and correctly disabled.
test('room view shows a roster column and a composer toolbar', async ({ window }) => {
  await window.locator('.nav-btn[data-page="jabber"]').click();
  await expect(window.locator('#page-jabber')).toBeVisible({ timeout: 15_000 });

  await window.locator('#jabberAddRoomBtn').click();
  await window.locator('#jrRoomJidInput').fill('roster@conference.example.com');
  await window.locator('.jabber-room-modal-add').click();
  await window.locator('#jabberRoomList .jabber-room-btn').first().click();
  await expect(window.locator('#jabberRoomPane')).toBeVisible();

  // Roster: present, and honest about being empty rather than blank.
  await expect(window.locator('#jabberRosterCount')).toContainText('0 people in room');
  await expect(window.locator('#jabberRosterList .jabber-occupant')).toHaveCount(0);

  // No subject pushed, so the banner stays out of the way entirely.
  await expect(window.locator('#jabberRoomSubject')).toBeHidden();

  // Toolbar exists; formatting is disabled because the room is not joined.
  await expect(window.locator('.jabber-fmt-btn[data-fmt="b"]')).toBeDisabled();
  await expect(window.locator('#jabberEmojiBtn')).toBeVisible();
  await expect(window.locator('#jabberLinkBtn')).toBeVisible();
});

test('the link dialog builds a plain-text link', async ({ window }) => {
  await window.locator('.nav-btn[data-page="jabber"]').click();
  await expect(window.locator('#page-jabber')).toBeVisible({ timeout: 15_000 });

  // Link insertion works on the composer regardless of connection state, so it
  // can be exercised without a server.
  await window.evaluate(() => {
    const i = document.getElementById('jabberRoomInput');
    i.disabled = false; i.value = '';
    _jrInsertLink();
  });
  await expect(window.locator('#jrLinkUrl')).toBeVisible();

  await window.locator('#jrLinkUrl').fill('goonfleet.com/index.php?topic=331317');
  await window.locator('#jrLinkText').fill('Buyback thread');
  await window.locator('.jabber-room-modal-add').click();

  // A bare host becomes a real URL, and the label reads before it.
  await expect(window.locator('#jabberRoomInput'))
    .toHaveValue('Buyback thread https://goonfleet.com/index.php?topic=331317 ');
});

// The feed filter. Structure-alert bots post continuously; on a busy night they
// outnumber real broadcasts heavily, so the page defaults to broadcasts only.
test('the feed filter defaults to broadcasts and separates bot alerts', async ({ window }) => {
  await window.locator('.nav-btn[data-page="jabber"]').click();
  await expect(window.locator('#page-jabber')).toBeVisible({ timeout: 15_000 });

  await expect(window.locator('.jabber-feed-btn[data-feed="broadcast"]')).toHaveClass(/active/);

  // Feed the renderer one of each shape and check what each mode shows.
  const counts = await window.evaluate(() => {
    jabberMessages.length = 0;
    jabberMessages.push(
      { id: 1, raw_body: 'Form up now', sig: 'skirmishbot', gsol_member: 'somefc',
        eve_timecode: '2026-08-11 10:00:00', fc_name: 'Some FC' },
      { id: 2, raw_body: ':siren: CitadelAttack: Col - 310AE (Athanor) under attack! NID: 2434062086' },
      { id: 3, raw_body: 'CitadelAttack: another structure, no shortcode prefix' },
      { id: 4, raw_body: 'just someone talking in the room' },
    );
    const rows = () => document.querySelectorAll('#jabberTable tbody tr.loading-row, #jabberTable tbody tr').length;
    const shown = {};
    for (const mode of ['broadcast', 'alert', 'all']) {
      jabberSetFeedMode(mode);
      shown[mode] = [...document.querySelectorAll('#jabberTable tbody tr')]
        .filter(tr => !tr.querySelector('.loading-row')).length;
    }
    jabberSetFeedMode('broadcast');
    return { ...shown, total: jabberMessages.length, rows: rows() };
  });

  // Broadcasts: the real broadcast plus the unparsed human line — an unparsed
  // message is more likely a person than a bot, so it is not hidden.
  expect(counts.broadcast).toBe(2);
  // Alerts: both bot shapes, with and without the :siren: prefix.
  expect(counts.alert).toBe(2);
  expect(counts.all).toBe(4);
});

// ── XEP-0393 message styling ──────────────────────────────────────────────────
// Bold and italic arrived back in our own room view as literal asterisks: the
// composer sent XEP-0393 (the Stable standard; XHTML-IM is deprecated) and
// nothing rendered it. These drive the real renderer — _jrStyled builds the room
// log's message bodies — without a server: styling is a pure function of the
// body text, so no connection is needed or made.

test('room messages render their styling, with the directives still visible', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });
  const r = await window.evaluate(() => {
    const host = document.createElement('div');
    host.appendChild(_jrStyled('*undock* _slowly_ ~cancelled~ `J-GAMP` then *see https://example.test/a_b*'));
    const strong = host.querySelector('.jms-strong');
    return {
      strong:   host.querySelectorAll('.jms-strong').length,
      em:       !!host.querySelector('.jms-em'),
      strike:   !!host.querySelector('.jms-strike'),
      pre:      host.querySelector('code.jms-pre')?.textContent,
      // XEP-0393 recommends keeping the directives shown, styled like the text.
      strongText: strong?.textContent,
      dirs:     strong?.querySelectorAll('.jms-dir').length,
      // A link inside bold is still found and still opens externally.
      linkInBold: !!host.querySelector('.jms-strong .jabber-link'),
      linkText: host.querySelector('.jabber-link')?.textContent,
    };
  });
  expect(r.strong).toBe(2);
  expect(r.em).toBe(true);
  expect(r.strike).toBe(true);
  expect(r.pre).toBe('`J-GAMP`');
  expect(r.strongText).toBe('*undock*');
  expect(r.dirs).toBe(2);
  expect(r.linkInBold).toBe(true);
  expect(r.linkText).toBe('https://example.test/a_b');
});

test('a message body can never inject markup into the room view', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });
  const r = await window.evaluate(async () => {
    window.__pwned = false;
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.appendChild(_jrStyled(
      '*<img src=x onerror="window.__pwned=true">* _<script>window.__pwned=true</script>_ ' +
      '`<b onmouseover="window.__pwned=true">x</b>`'));
    await new Promise(r => setTimeout(r, 300));    // give any payload the chance to fire
    const out = {
      pwned:   window.__pwned,
      img:     host.querySelectorAll('img').length,
      script:  host.querySelectorAll('script').length,
      b:       host.querySelectorAll('b').length,
      // Every tag the renderer emitted is one of its own.
      foreign: [...host.querySelectorAll('*')].filter(e => !/^(SPAN|CODE|A|BR|PRE|BLOCKQUOTE)$/.test(e.tagName)).length,
      text:    host.textContent.includes('<img src=x'),
    };
    host.remove();
    return out;
  });
  expect(r.pwned).toBe(false);
  expect(r.img).toBe(0);
  expect(r.script).toBe(0);
  expect(r.b).toBe(0);
  expect(r.foreign).toBe(0);
  expect(r.text, 'the markup survives as the text the sender typed').toBe(true);
});

test('a message whose sender opted out of styling is shown as typed', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });
  const r = await window.evaluate(() => {
    const host = document.createElement('div');
    host.appendChild(_jrStyled('config: a=*x* b=_y_', true));
    return { styled: host.querySelectorAll('.jms-strong, .jms-em').length, text: host.textContent };
  });
  expect(r.styled).toBe(0);
  expect(r.text).toBe('config: a=*x* b=_y_');
});

test('the composer only offers formatting the standard defines', async ({ window }) => {
  await window.locator('.nav-btn[data-page="jabber"]').click();
  await expect(window.locator('#page-jabber')).toBeVisible({ timeout: 15_000 });
  // XEP-0393 has no underline; the old button sent `__text__`, which renders in
  // no client at all. Strikethrough is what the spec has in that slot.
  await expect(window.locator('.jabber-fmt-btn[data-fmt="u"]')).toHaveCount(0);
  await expect(window.locator('.jabber-fmt-btn[data-fmt="s"]')).toHaveCount(1);

  const wrapped = await window.evaluate(() => {
    const i = document.getElementById('jabberRoomInput');
    i.disabled = false; i.value = 'cancel the op'; i.setSelectionRange(7, 13);
    _jrWrapSelection(_JR_MARKER.s);
    return i.value;
  });
  expect(wrapped).toBe('cancel ~the op~');
});
