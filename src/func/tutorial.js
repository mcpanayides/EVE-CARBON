// ─── Tutorial ─────────────────────────────────────────────────────────────────
// A guided tour of the real app. Everything except the control being explained
// is dimmed and blurred, and the clicks it would take are held, so the tour
// keeps the user on the thing it is talking about. Where a step asks for
// something (add a character, add a widget, open a page) it waits for the user
// to do it for real and carries on when it happens: there is no separate
// tutorial mode, and nothing it shows is staged.
//
// Two tours. The basics (about two minutes) run on a first launch and take a new
// pilot from no characters to their own data on the dashboard. Alliance tools
// (about two more) walk through Jabber, the forum, the GEZ tracker and jump
// gates in Settings. Both can be run again from Settings, General.
//
// The decisions and the geometry (when it opens by itself, which steps apply,
// how they are counted, where the spotlight and the card go) live in
// shared/tutorial_model.js, which is tested without Electron. This file only
// measures the page, draws, and listens.

let _tut = null;                       // the running tour, or null
let _tutStarting = false;              // between startTutorial() and the tour existing
let _tutDeciding = false;              // a first launch still deciding whether to open one

/**
 * Whether other prompts should hold off: a tour is running, starting, or a first
 * launch has not yet decided whether to open one. A modal landing on the welcome
 * card would bury it, and the tour's dimming would cover that modal's close
 * button. The donation nudge (func/donation.js) waits on this, then on the
 * 'tutorial-idle' event this file sends when nothing is left running.
 */
function tutorialBusy() { return !!_tut || _tutStarting || _tutDeciding; }

function _tutAnnounceIdle() {
  if (!tutorialBusy()) document.dispatchEvent(new CustomEvent('tutorial-idle'));
}

/**
 * A dialog lifted above the tour (tutorial.css) is open: a confirm, or the
 * donate window from the menu the "Everything else" step leaves clickable. Esc
 * is that dialog's, or one press would close the dialog and the tour together.
 */
function _tutDialogAbove() {
  if (document.querySelector('.cf-backdrop')) return true;
  const donate = document.getElementById('donateBackdrop');
  return !!donate && getComputedStyle(donate).display !== 'none';
}

// Labels for the full sync's steps, for the first-sync card's live status line.
const _TUT_SYNC_STEPS = {
  character_info: 'Character sheet', wallet: 'Wallet',
  location: 'Location', ship: 'Ship', implants: 'Implants and clones',
  pi: 'Planets', trade_profile: 'Skills', assets: 'Assets',
  blueprints: 'Blueprints', wallet_journal: 'Wallet journal',
  transactions: 'Transactions', loyalty_points: 'Loyalty points',
};

function _tutGo(page) {
  if (typeof navigateToPage === 'function' && typeof currentPage !== 'undefined' && currentPage !== page) {
    navigateToPage(page);
  }
}

// The settings block an input lives in: what the advanced tour lights up.
function _tutBlockOf(id) {
  return () => [document.getElementById(id)?.closest('.settings-panel-block')];
}

async function _tutSettings(tab) {
  if (typeof openSettingsAt === 'function') await openSettingsAt(tab);
}

// ── The basics ────────────────────────────────────────────────────────────────
function _tutBasicSteps() {
  return [
    {
      id: 'welcome',
      kicker: 'About two minutes',
      title: 'Welcome to EVE Carbon',
      body: 'Every character you fly, in one window: wallets, skills, industry, mail, planets and fleet tools. '
          + 'This tour shows you around with your own characters. Leave it whenever you like.',
      primary: { label: 'Start the tour', act: 'next' },
      secondary: { label: 'Not now', act: 'exit', reason: 'declined' },
    },
    {
      id: 'characters-nav', chapter: 'Characters',
      when: () => typeof currentPage === 'undefined' || currentPage !== 'characters',
      target: '.nav-btn[data-page="characters"]',
      title: 'Start with your characters',
      body: 'Everything here comes from the characters you add. Open the Characters page.',
      prompt: 'Click Characters in the menu.',
      until: () => typeof currentPage !== 'undefined' && currentPage === 'characters',
      secondary: { label: 'Skip', act: 'next' },
    },
    {
      id: 'add-character', chapter: 'Characters',
      before: () => _tutGo('characters'),
      target: '#addCharacterNavBtn',
      placement: ['bottom', 'left', 'right', 'top'],
      title: ctx => ctx.accountCount ? 'Add more characters' : 'Add your first character',
      body: ctx => ctx.accountCount
        ? `You have ${ctx.accountCount} character${ctx.accountCount === 1 ? '' : 's'} here. Add another the same way `
          + 'whenever you like: it opens EVE’s sign-in page in your browser.'
        : 'This opens EVE’s own sign-in page in your browser. Sign in, pick the character, and come back here. '
          + 'Your login is kept on this computer and never leaves it.',
      hint: ctx => ctx.accountCount ? null : {
        label: 'Which account?',
        text: 'The one you sign in to the EVE launcher with. Each sign-in adds one character, so add your alts '
            + 'the same way, on this account or any other.',
      },
      waitFor: ctx => ctx.accountCount ? null : 'account-added',
      prompt: 'Click Add character.',
      onTargetClick: (ctx, api) => {
        if (ctx.accountCount) return;
        ctx.signingIn = true;
        api.status('Finish signing in in your browser. This carries on when your character arrives.');
      },
      primary: ctx => ctx.accountCount ? { label: 'Next', act: 'next' } : null,
      secondary: ctx => ctx.accountCount ? null : { label: 'I’ll do this later', act: () => {
        ctx.skippedCharacter = true;
        _tutNext();
      } },
    },
    {
      id: 'first-sync', chapter: 'Characters',
      when: ctx => !!ctx.added || ctx.accountCount > 0,
      // Counted from the start of the chapter, so its total holds, unless the
      // user chose to add a character later.
      countWhen: ctx => !!ctx.added || ctx.accountCount > 0 || !ctx.skippedCharacter,
      before: () => _tutGo('characters'),
      target: ctx => ctx.added
        ? `.character-card[data-character-id="${String(ctx.added.characterId).replace(/"/g, '')}"]`
        : '#accountsListNav .character-card',
      placement: ['right', 'bottom', 'left', 'top'],
      // Not "is syncing": the title stays up after the status line says it is done.
      title: ctx => ctx.added ? `${ctx.added.characterName} added` : 'Each card is a character',
      body: ctx => ctx.added
        ? 'The first sync pulls this character’s wallet, skills, assets, industry and planets from EVE’s API. '
          + 'It can take a minute or two and runs in the background, so carry on. After that it all refreshes by itself.'
        : 'Your characters’ data refreshes by itself in the background, on the schedule EVE’s API allows.',
      hint: { label: 'Want it now?', text: 'SYNC on a card refreshes that character, and RESYNC ALL refreshes everyone.' },
      liveStatus: ctx => ctx.added ? ctx.sync : null,
    },
    {
      id: 'main-character', chapter: 'Characters',
      when: ctx => !!ctx.added || ctx.accountCount > 0,
      countWhen: ctx => !!ctx.added || ctx.accountCount > 0 || !ctx.skippedCharacter,
      before: async (ctx) => {
        await _tutGo('characters');
        const accounts = await window.eveAPI.getAccounts().catch(() => []);
        ctx.characterCount = Array.isArray(accounts) ? accounts.length : 0;
      },
      // Every card, so any ◇ can be clicked. The main's card is first.
      target: () => [...document.querySelectorAll('#accountsListNav .character-card')],
      placement: ['right', 'bottom', 'left', 'top'],
      title: 'Pick your main character',
      body: ctx => 'The ◆ marks your main character. Its portrait sits at the top of the menu, the dashboard shows it, '
          + 'and its card stays first. '
          + (ctx.characterCount > 1
            ? 'Click the ◇ on the character you fly most to make it your main.'
            : 'When you add more characters, click the ◇ on any card to switch.'),
      prompt: ctx => ctx.characterCount > 1 ? 'Click a ◇ to pick your main.' : null,
      // Moves on when the main changes; Next keeps the one there is.
      waitFor: ctx => ctx.characterCount > 1 ? 'main-character' : null,
      primary: { label: 'Next', act: 'next' },
    },
    {
      id: 'dashboard-nav', chapter: 'Dashboard',
      when: () => typeof currentPage === 'undefined' || currentPage !== 'dashboard',
      target: '.nav-btn[data-page="dashboard"]',
      title: 'Open your dashboard',
      body: 'The dashboard is your home page, with every character at a glance.',
      prompt: 'Click Dashboard in the menu.',
      until: () => typeof currentPage !== 'undefined' && currentPage === 'dashboard',
      secondary: { label: 'Skip', act: 'next' },
    },
    {
      id: 'add-widget', chapter: 'Dashboard',
      before: () => _tutGo('dashboard'),
      // The menu opens below the button, outside its box, so both are lit.
      target: ['.dashboard-add-widget-btn', '#dashboardAddWidgetMenu'],
      placement: ['right', 'bottom', 'left', 'top'],
      title: 'Add a widget',
      body: 'Widgets are the tiles on this page, each showing one thing: a wallet, a skill queue, your planets, '
          + 'the latest ping. Click Add Widget and pick one.',
      prompt: 'Click Add Widget, then choose one.',
      waitFor: 'widget-added',
      secondary: { label: 'Skip', act: (ctx) => { ctx.skippedWidget = true; _tutNext(); } },
    },
    {
      id: 'arrange', chapter: 'Dashboard',
      when: ctx => !!ctx.widgetId,
      countWhen: ctx => !!ctx.widgetId || !ctx.skippedWidget,
      target: ctx => `.grid-stack-item[gs-id="${String(ctx.widgetId).replace(/"/g, '')}"]`,
      title: 'Make it yours',
      body: 'Drag a widget by its title to move it, and drag its corner to resize it. Hover over it for the buttons '
          + 'that pop it out into its own window or remove it.',
    },
    {
      id: 'mail', chapter: 'Around the app',
      target: '.nav-btn[data-page="mail"]',
      title: 'EVE Mail',
      body: 'Read and send mail for every character without opening the game: to pilots, corporations, alliances '
          + 'and mailing lists. Your notifications are here too.',
      clickAdvances: true,
    },
    {
      id: 'industry', chapter: 'Around the app',
      target: '.nav-btn[data-page="industry"]',
      title: 'Industry',
      body: 'Your blueprints with their build cost against Jita, materials with your ME applied, jobs, reactions, '
          + 'the cost index, the mining ledger, appraisals and shopping lists.',
      clickAdvances: true,
    },
    {
      id: 'everything-else', chapter: 'Around the app',
      target: '#sidebarNav',
      title: 'Everything else',
      body: 'Skills, the killboard, Faction Warfare, assets, finances, fleet tools, the map, planets and the '
          + 'calendar each have a page here, and every page covers all your characters.',
    },
    {
      id: 'settings', chapter: 'Around the app',
      target: '#openSettingsBtn',
      title: 'Settings',
      body: 'Your wallpaper and colours, Jabber, your forum and the rest of the setup live here. '
          + 'You can also run this tour again from Settings, General.',
    },
    {
      id: 'basics-done',
      kicker: 'Tour complete',
      title: 'That’s the basics',
      body: ctx => `Next you can connect your alliance tools: Jabber pings, your forum, your ${ctx.sovTerm} and your `
          + 'jump gates, which come straight from EVE. It takes about two more minutes, and you can skip anything '
          + 'your alliance doesn’t use.',
      primary: { label: 'Set up alliance tools', act: () => {
        exitTutorial('finished', { quiet: true });
        startTutorial('advanced', { fromBasic: true });
      } },
      secondary: { label: 'Finish', act: 'finish' },
    },
  ];
}

// ── Alliance tools ────────────────────────────────────────────────────────────

/**
 * The page the picked alliance pack names for one stop ('forum', 'gez' or
 * 'jump_gates', from pack_info.links in its YAML), or null. The Imperium's pack
 * names Goonswarm's GEZ topic on its forum and the Stargate page on its wiki,
 * both behind Goonswarm's sign-in, so the sheet and the gate list stay with
 * Goonswarm's pilots.
 *
 * Members-only pages go to pilots with a character in one of the alliances the
 * page (or else the pack) names (src/shared/alliance_pack.js). Read when the
 * step opens, so the pack picked at the first stop counts before SAVE, and the
 * characters are as they are now.
 */
async function _tutAllianceLink(key) {
  if (typeof packContext !== 'function') return null;
  const { pack, allianceIds } = await packContext();
  const link = pack ? AlliancePack.link(pack, key, allianceIds) : null;
  // Labelled with whoever runs the page (The Imperium's forum is Goonswarm's).
  return link && { ...link, alliance: link.owner || pack.alliance || pack.name || '' };
}

/**
 * The Jabber server the picked pack names, the host its addresses end in, and
 * who it is from, or null. The Imperium's names xmpp://goonfleet.com:5222; a
 * pack without one leaves Settings on the app's default.
 */
async function _tutJabberServer() {
  if (typeof packContext !== 'function') return null;
  const { pack } = await packContext();
  const service = pack ? AlliancePack.jabberService(pack) : null;
  const host = service && (service.match(/^xmpps?:\/\/([^:/]+)/i) || [])[1];
  return host ? { service, host, from: pack.alliance || pack.name || '' } : null;
}

// What to call one of the app's things for this pilot (src/func/pack_links.js).
async function _tutTerm(key) {
  if (typeof packContext !== 'function' || typeof packTerm !== 'function') return 'sovereignty upgrades';
  return packTerm(key, await packContext().catch(() => null));
}

// "A", "A and B", "A, B and C".
function _tutList(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] || '');
}

function _tutAllianceHint(link, text) {
  return link ? {
    label: link.alliance,
    text,
    link: { label: link.label, href: link.href, title: `Opens ${link.host} in your browser` },
  } : null;
}

function _tutAdvancedSteps() {
  const CH = 'Alliance tools';
  return [
    {
      id: 'advanced-welcome',
      when: ctx => !ctx.fromBasic,
      kicker: 'About two minutes',
      title: 'Set up your alliance tools',
      body: ctx => `Four connections, each one optional: Jabber for fleet pings, your alliance forum, your ${ctx.sovTerm} `
          + 'and your jump gate network. Settings opens alongside so you can fill each one in as you go.',
      primary: { label: 'Start', act: 'next' },
      secondary: { label: 'Not now', act: 'exit', reason: 'declined' },
    },
    {
      id: 'jabber-pack', chapter: CH,
      before: async (ctx) => {
        await _tutSettings('jabber');
        const packs = await window.eveAPI.getPacks().catch(() => []);
        ctx.builtinPacks = (Array.isArray(packs) ? packs : []).filter(p => p.source === 'builtin')
          .map(p => p.name).sort((a, b) => a.localeCompare(b));
      },
      target: _tutBlockOf('jabberPackSelect'),
      title: 'Pick your alliance pack',
      body: 'A pack tells the Jabber page about your alliance’s SIGs, squads and comms channels, so each ping shows '
          + 'who it is for and where to join. It can also bring your alliance’s wiki and forum.',
      hint: ctx => (ctx.builtinPacks || []).length
        ? { label: 'Built in', text: `${_tutList(ctx.builtinPacks)}. Pick yours, or make one with + New Pack.` }
        : null,
    },
    {
      id: 'jabber-login', chapter: CH,
      // Read when the step opens, so a pack picked at the stop before counts.
      before: async (ctx) => {
        await _tutSettings('jabber');
        ctx.jabberServer = await _tutJabberServer().catch(() => null);
      },
      target: _tutBlockOf('jabberService'),
      title: 'Sign in to Jabber',
      body: 'Enter your Jabber server, your Jabber address and its password. EVE Carbon connects when it starts and '
          + 'pops director pings up over the game. Your password stays on this computer.',
      hint: ctx => ctx.jabberServer ? {
        label: ctx.jabberServer.from,
        text: `Your pack fills in the server, ${ctx.jabberServer.service}. Your Jabber address ends in `
            + `@${ctx.jabberServer.host}.`,
      } : null,
    },
    {
      id: 'forum', chapter: CH,
      // The picked pack's forum. Its address is public (applicants need it too),
      // so anyone with the pack picked sees it, and gets it filled in.
      before: async (ctx) => {
        await _tutSettings('forums');
        ctx.forumLink = await _tutAllianceLink('forum').catch(() => null);
      },
      target: _tutBlockOf('forumUrlInput'),
      title: 'Connect your forum',
      body: 'Enter your alliance forum’s address, then log in once. The Forums page shows it inside the app, and '
          + 'your session is kept without storing your password.',
      hint: ctx => ctx.forumLink ? { label: ctx.forumLink.alliance, text: `The address is ${ctx.forumLink.href}` } : null,
    },
    {
      id: 'gez', chapter: CH,
      before: async (ctx) => {
        await _tutSettings('industry');
        ctx.sovTerm = await _tutTerm('sov_upgrades');
        ctx.gezLink = await _tutAllianceLink('gez').catch(() => null);
      },
      target: _tutBlockOf('industrySheetUrl'),
      title: ctx => `Add your ${ctx.sovTerm}`,
      body: ctx => `Paste the link to your ${ctx.sovTerm} sheet and press Sync. Each structure on it becomes a build `
          + 'location in the Blueprints calculator, with its rigs counted.',
      hint: ctx => _tutAllianceHint(ctx.gezLink,
        'Your alliance shares the GEZ tracker sheet on the page below. Sign in, copy the sheet’s link and paste it here.'),
    },
    {
      id: 'jump-gates', chapter: CH,
      before: async (ctx) => {
        await _tutSettings('jumpgates');
        ctx.gateLink = await _tutAllianceLink('jump_gates').catch(() => null);
      },
      target: _tutBlockOf('beaconImportInput'),
      title: 'Your jump gates',
      body: 'Allow one character and EVE Carbon reads your alliance’s gates from EVE every hour, green on the map, and '
          + 'the jump planner routes through them. Other alliances’ gates your other characters can see show red, so '
          + 'you can see where a target’s bridge comes out. A pasted list works too.',
      hint: ctx => _tutAllianceHint(ctx.gateLink,
        'Your alliance also keeps a gate list on the page below. Sign in, copy it and paste it here: rows marked not friendly show red.'),
    },
    {
      id: 'save', chapter: CH,
      before: async () => {
        const drawer = document.getElementById('uiSettingsDrawer');
        if (!drawer || drawer.style.display !== 'flex') await _tutSettings('jabber');
      },
      target: '#saveSettingsBtn',
      placement: ['top', 'left', 'right', 'bottom'],
      title: 'Save what you entered',
      body: 'SAVE keeps your Jabber details and forum address. Your structures and jump gates are saved as they '
          + 'come in.',
      prompt: 'Click SAVE.',
      clickAdvances: true,
      primary: null,
      secondary: { label: 'Skip', act: 'next' },
    },
    {
      id: 'advanced-done',
      kicker: 'All set',
      title: 'You’re set up',
      body: 'You can run either tour again from Settings, General.',
      primary: { label: 'Done', act: 'finish' },
    },
  ];
}

// ── State ─────────────────────────────────────────────────────────────────────
async function _tutState() {
  try { return (await window.eveAPI.getTutorialState()) || {}; } catch (_) { return {}; }
}

async function _tutSave(patch) {
  try {
    const { suppressAutoStart, ...keep } = await _tutState();
    await window.eveAPI.saveAppConfig({ tutorial: { ...keep, ...patch } });
  } catch (_) { /* a tour that cannot remember it ran is still a tour */ }
}

// ── Page geometry ─────────────────────────────────────────────────────────────
// The tour stays below the title bar, so the window can always be moved,
// minimised and closed while it runs.
function _tutViewport() {
  const bar = document.querySelector('.titlebar');
  const top = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
  return { left: 0, top, width: window.innerWidth, height: Math.max(0, window.innerHeight - top) };
}

// The part of an element that can actually be seen: its box cut down by every
// scrolling or clipping ancestor. The nav list is taller than its scroll area,
// and lit whole it put a column of light straight through the status bars.
function _tutVisibleRect(el) {
  const r = el.getBoundingClientRect();
  let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    left = Math.max(left, pr.left);   top = Math.max(top, pr.top);
    right = Math.min(right, pr.right); bottom = Math.min(bottom, pr.bottom);
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function _tutTargets(step, ctx) {
  let spec = typeof step.target === 'function' ? step.target(ctx) : step.target;
  if (!spec) return [];
  if (!Array.isArray(spec)) spec = [spec];
  return spec
    .map(s => (typeof s === 'string' ? document.querySelector(s) : s))
    .filter(el => el && el.isConnected && el.getClientRects().length > 0);
}

function _tutVal(v, ctx) { return typeof v === 'function' ? v(ctx) : v; }

function _tutPrimary(step, ctx) {
  if ('primary' in step) return _tutVal(step.primary, ctx);
  return _tutWaits(step, ctx) ? null : { label: 'Next', act: 'next' };
}

// Whether a step moves on by itself when the user does something, rather than
// on a Next button.
function _tutWaits(step, ctx) {
  return !!(_tutVal(step.waitFor, ctx) || step.until);
}

function _tutPlace(el, r) {
  el.style.left = `${r.left}px`; el.style.top = `${r.top}px`;
  el.style.width = `${r.width}px`; el.style.height = `${r.height}px`;
}

function _tutLayout(force) {
  const t = _tut;
  if (!t || document.hidden) return;
  const step = t.steps[t.index];
  if (!step) return;
  const vp = _tutViewport();
  const els = step.target ? _tutTargets(step, t.ctx) : [];
  const hole = step.target ? TutorialModel.holeRect(els.map(_tutVisibleRect), step.pad ?? 6, vp) : null;
  if (!force && TutorialModel.sameRect(hole, t.lastHole) && TutorialModel.sameRect(vp, t.lastVp)) return;
  t.lastHole = hole; t.lastVp = vp;

  const panels = TutorialModel.blockers(hole, vp);
  t.blockers.forEach((b, i) => {
    if (panels[i]) { _tutPlace(b, panels[i]); b.hidden = false; } else { b.hidden = true; }
  });

  if (hole) {
    _tutPlace(t.ring, hole);
    // Follow the control's own corners, opened out by the padding, so the ring
    // reads as a halo around that control rather than a box drawn over the page.
    const r = els.length === 1 ? parseFloat(getComputedStyle(els[0]).borderTopLeftRadius) || 0 : 6;
    t.ring.style.borderRadius = `${Math.min(24, r + (step.pad ?? 6))}px`;
    t.ring.hidden = false;
  } else {
    t.ring.hidden = true;
  }

  const card = t.card;
  const pos = TutorialModel.placeCard(hole, { width: card.offsetWidth, height: card.offsetHeight }, vp,
    { order: step.placement });
  card.style.left = `${pos.left}px`;
  card.style.top = `${pos.top}px`;
  card.dataset.side = pos.side;
  if (pos.arrow != null) card.style.setProperty('--tour-arrow', `${pos.arrow}px`);
}

// ── Drawing the card ──────────────────────────────────────────────────────────
function _tutRender() {
  const t = _tut;
  const step = t.steps[t.index];
  const ctx = t.ctx;
  const prog = TutorialModel.progress(t.steps, t.index, ctx, t.visited);
  const hint = _tutVal(step.hint, ctx);
  const primary = _tutPrimary(step, ctx);
  const secondary = _tutVal(step.secondary, ctx);
  const canBack = t.index !== t.firstIndex && TutorialModel.nextIndex(t.steps, t.index, -1, ctx) >= 0;
  const close = '<button class="tour-close" data-act="close" title="Close the tour" aria-label="Close the tour">'
              + '<span class="material-symbols-outlined" aria-hidden="true">close</span></button>';

  let head;
  if (prog) {
    let lastChapter = null;
    const segs = prog.segments.map(s => {
      const starts = s.chapter !== lastChapter && lastChapter !== null;
      lastChapter = s.chapter;
      return `<span class="tour-seg is-${s.state}${starts ? ' starts-chapter' : ''}"></span>`;
    }).join('');
    head = `<div class="tour-card-head">
        <span class="tour-chapter">${escHtml(prog.chapter)}</span>
        <span class="tour-count">${prog.n} of ${prog.of}</span>${close}
      </div>
      <div class="tour-progress" aria-hidden="true">${segs}</div>`;
  } else {
    head = `<div class="tour-card-head">
        ${step.kicker ? `<span class="tour-chapter">${escHtml(step.kicker)}</span>` : ''}${close}
      </div>`;
  }

  t.card.className = 'tour-card' + (prog ? '' : ' is-framing');
  t.card.innerHTML = `${head}
    <h2 class="tour-title" id="tourCardTitle">${escHtml(_tutVal(step.title, ctx))}</h2>
    <p class="tour-body" id="tourCardBody">${escHtml(_tutVal(step.body, ctx))}</p>
    ${hint ? `<div class="tour-hint"><span class="tour-hint-label">${escHtml(hint.label)}</span>
      <span class="tour-hint-text">${escHtml(hint.text)}</span>${hint.link ? `
      <button type="button" class="tour-hint-link" data-act="hint-link" title="${escHtml(hint.link.title || '')}">
        <span class="tour-hint-link-text">${escHtml(hint.link.label)}</span>
        <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span></button>` : ''}</div>` : ''}
    <div class="tour-status" aria-live="polite"></div>
    <div class="tour-actions">
      ${canBack ? '<button class="tour-btn tour-btn-ghost" data-act="back">Back</button>' : ''}
      <span class="tour-actions-gap"></span>
      ${secondary ? `<button class="tour-btn tour-btn-ghost" data-act="secondary">${escHtml(secondary.label)}</button>` : ''}
      ${primary ? `<button class="tour-btn tour-btn-primary" data-act="primary">${escHtml(primary.label)}</button>` : ''}
    </div>
    <span class="tour-arrow" aria-hidden="true"></span>`;

  t.ring.classList.toggle('is-waiting', _tutWaits(step, ctx) || !!step.clickAdvances);
  _tutRefreshStatus();

  // Enter from the side the card sits on, once per step: the one authored
  // moment in the tour. Reduced motion skips it in the stylesheet.
  t.card.classList.remove('is-entering');
  void t.card.offsetWidth;
  t.card.classList.add('is-entering');
}

// The status line: what the step is waiting for, or live news (the first sync).
function _tutRefreshStatus(text, tone) {
  const t = _tut;
  if (!t) return;
  const el = t.card.querySelector('.tour-status');
  if (!el) return;
  const step = t.steps[t.index];
  const live = text != null ? { text, tone } : _tutVal(step.liveStatus, t.ctx);
  const shown = live && live.text ? live
    : (_tutWaits(step, t.ctx) || step.clickAdvances) && step.prompt ? { text: _tutVal(step.prompt, t.ctx) } : null;
  el.textContent = shown ? shown.text : '';
  el.dataset.tone = shown && shown.tone ? shown.tone : '';
  el.hidden = !shown;
  _tutLayout(true);
}

// ── Moving between steps ──────────────────────────────────────────────────────
async function _tutGoto(index) {
  const t = _tut;
  if (!t || index < 0) return;
  const seq = ++t.seq;
  t.stepCleanups.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
  t.index = index;
  t.visited.add(index);
  t.status = null;
  const step = t.steps[index];

  if (step.before) {
    try { await step.before(t.ctx); } catch (e) { console.warn('[tutorial] step setup failed:', e?.message || e); }
  }
  if (!_tut || _tut.seq !== seq) return;

  // A page or drawer just opened may not have drawn the control yet. Wait a
  // little for it; failing that, the card shows on its own, so the tour can
  // never strand someone on a step that points at nothing.
  let els = [];
  if (step.target) {
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      els = _tutTargets(step, t.ctx);
      if (els.length) break;
      await new Promise(r => setTimeout(r, 80));
      if (!_tut || _tut.seq !== seq) return;
    }
    if (els[0]) els[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  _tutRender();
  _tutLayout(true);

  // A click on the lit control: the click goes through to the control itself
  // first, then the tour reacts.
  els.forEach(el => {
    const onClick = () => {
      if (!_tut || _tut.seq !== seq) return;
      if (step.onTargetClick) step.onTargetClick(t.ctx, _tutApi(seq));
      if (step.clickAdvances) setTimeout(() => { if (_tut && _tut.seq === seq) _tutNext(); }, 0);
    };
    el.addEventListener('click', onClick);
    t.stepCleanups.push(() => el.removeEventListener('click', onClick));
  });

  const focusTarget = t.card.querySelector('[data-act="primary"]') || t.card;
  focusTarget.focus({ preventScroll: true });
}

function _tutApi(seq) {
  return {
    status: (text, tone) => { if (_tut && _tut.seq === seq) _tutRefreshStatus(text, tone); },
    next: () => { if (_tut && _tut.seq === seq) _tutNext(); },
  };
}

function _tutNext() {
  const t = _tut;
  if (!t) return;
  const i = TutorialModel.nextIndex(t.steps, t.index, +1, t.ctx);
  if (i < 0) exitTutorial('finished');
  else _tutGoto(i);
}

function _tutAct(which) {
  const t = _tut;
  if (!t) return;
  if (!t.marked) { t.marked = true; _tutSave({ seen: true }); }
  const step = t.steps[t.index];
  if (which === 'close') return exitTutorial('closed');
  if (which === 'back') return _tutGoto(TutorialModel.nextIndex(t.steps, t.index, -1, t.ctx));
  if (which === 'hint-link') {
    // A page on the web: the browser opens it, never this window.
    const link = _tutVal(step.hint, t.ctx)?.link;
    if (link?.href) window.eveAPI.openExternalUrl?.(link.href)?.catch?.(() => {});
    return;
  }
  const spec = which === 'primary' ? _tutPrimary(step, t.ctx) : _tutVal(step.secondary, t.ctx);
  if (!spec) return;
  if (typeof spec.act === 'function') return spec.act(t.ctx);
  if (spec.act === 'next') return _tutNext();
  if (spec.act === 'finish') return exitTutorial('finished');
  if (spec.act === 'exit') return exitTutorial(spec.reason || 'closed');
}

// ── Starting and stopping ─────────────────────────────────────────────────────
async function startTutorial(kind = 'basic', opts = {}) {
  // Busy from the first line until the tour is up, so the basics handing over to
  // alliance tools never looks like the end of the tour to anything waiting for
  // it, and a start that fails part-way can't leave those things waiting forever.
  _tutStarting = true;
  try {
    await _tutBegin(kind, opts);
  } finally {
    _tutStarting = false;
    _tutAnnounceIdle();
  }
}

async function _tutBegin(kind, opts) {
  if (_tut) exitTutorial('replaced', { quiet: true });
  if (typeof TutorialModel === 'undefined') return;

  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  const steps = kind === 'advanced' ? _tutAdvancedSteps() : _tutBasicSteps();
  const ctx = {
    accountCount: Array.isArray(accounts) ? accounts.length : 0,
    added: null, widgetId: null, signingIn: false, sync: null,
    fromBasic: !!opts.fromBasic,
    // GEZ is Goonswarm's word: "GEZ tracker" for its pilots, "sovereignty
    // upgrades" for everyone else. Asked again at that stop, after a pack pick.
    sovTerm: await _tutTerm('sov_upgrades'),
  };

  const root = document.createElement('div');
  root.className = 'tour-root';
  root.innerHTML = '<div class="tour-blocker"></div><div class="tour-blocker"></div>'
                 + '<div class="tour-blocker"></div><div class="tour-blocker"></div>'
                 + '<div class="tour-ring" aria-hidden="true" hidden></div>'
                 + '<div class="tour-card" role="dialog" aria-labelledby="tourCardTitle" '
                 + 'aria-describedby="tourCardBody" tabindex="-1"></div>';
  document.body.appendChild(root);
  document.body.classList.add('tour-active');

  _tut = {
    kind, steps, ctx, root, seq: 0, index: -1, marked: !!opts.fromBasic,
    blockers: [...root.querySelectorAll('.tour-blocker')],
    ring: root.querySelector('.tour-ring'),
    card: root.querySelector('.tour-card'),
    lastHole: undefined, lastVp: undefined, visited: new Set(),
    stepCleanups: [], cleanups: [],
  };
  const t = _tut;

  t.card.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) _tutAct(btn.dataset.act);
  });

  // A click on the dimmed page is held. Nudge the card so that reads as the
  // tour asking for attention, not as the app ignoring the click.
  t.blockers.forEach(b => b.addEventListener('click', () => {
    t.card.classList.remove('is-nudged');
    void t.card.offsetWidth;
    t.card.classList.add('is-nudged');
  }));

  // Esc leaves the tour, except while typing: the advanced tour asks people to
  // fill in fields, and losing the tour to a keystroke there would be a trap.
  const onKey = (e) => {
    if (e.key !== 'Escape' || !_tut || _tutDialogAbove()) return;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
    if (typing && !t.card.contains(e.target)) return;
    e.preventDefault();
    _tutAct('close');
  };
  document.addEventListener('keydown', onKey, true);
  t.cleanups.push(() => document.removeEventListener('keydown', onKey, true));

  // Keep the spotlight on its control as the page moves: window resizes and
  // scrolls straight away, everything else (a page drawing in, a tile loading)
  // on a light poll that also answers the steps waiting for a page to open.
  let raf = 0;
  const relayout = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; _tutLayout(); }); };
  window.addEventListener('resize', relayout);
  document.addEventListener('scroll', relayout, true);
  t.cleanups.push(() => {
    window.removeEventListener('resize', relayout);
    document.removeEventListener('scroll', relayout, true);
    if (raf) cancelAnimationFrame(raf);
  });
  const timer = setInterval(() => {
    if (!_tut) return;
    const step = _tut.steps[_tut.index];
    if (step && step.until && step.until(_tut.ctx)) { _tutNext(); return; }
    _tutLayout();
  }, 200);
  t.cleanups.push(() => clearInterval(timer));

  // What the steps wait for. Held for the whole tour, not per step, so a
  // character that arrives while the user is reading another card still counts.
  const offAdded = window.eveAPI.on?.('account-added', (d) => {
    if (!_tut) return;
    // Asked before the count changes: the add step stops waiting once there is
    // a character, which is exactly the moment it has to move on.
    const waiting = _tutVal(_tut.steps[_tut.index].waitFor, ctx) === 'account-added';
    ctx.added = { characterId: d?.characterId, characterName: d?.characterName || 'Your character' };
    ctx.accountCount += 1;
    ctx.signingIn = false;
    ctx.sync = { text: 'Starting the first sync…' };
    if (waiting) _tutNext();
  });
  const offAuthErr = window.eveAPI.on?.('auth-error', (msg) => {
    if (!_tut || _tut.steps[_tut.index]?.id !== 'add-character') return;
    ctx.signingIn = false;
    _tutRefreshStatus(`Sign-in didn’t finish (${msg || 'unknown error'}). Click Add character to try again.`, 'error');
  });
  const offSync = window.eveAPI.on?.('char-sync-progress', (d) => {
    if (!_tut || !ctx.added || String(d?.characterId) !== String(ctx.added.characterId)) return;
    if (d.step === 'done')       ctx.sync = { text: 'First sync complete.', tone: 'ok' };
    else if (d.step === 'error') ctx.sync = { text: `The first sync hit a problem (${d.detail || 'unknown'}). Try SYNC on the card.`, tone: 'error' };
    else if (d.step === 'start') ctx.sync = { text: 'Starting the first sync…' };
    else ctx.sync = { text: `Syncing: ${_TUT_SYNC_STEPS[d.step] || String(d.step || '').replace(/_/g, ' ')}…` };
    if (_tut.steps[_tut.index]?.liveStatus) _tutRefreshStatus();
  });
  const onWidget = (e) => {
    if (!_tut) return;
    ctx.widgetId = e.detail?.id || null;
    const step = _tut.steps[_tut.index];
    if (_tutVal(step.waitFor, ctx) === 'widget-added') setTimeout(() => _tut && _tutNext(), 350);
  };
  document.addEventListener('dashboard-widget-added', onWidget);
  // A new main character: held long enough to see its card move to the front
  // and its portrait take the top of the menu.
  const onMain = () => {
    if (!_tut) return;
    const step = _tut.steps[_tut.index];
    if (_tutVal(step.waitFor, ctx) !== 'main-character') return;
    const at = _tut.index;
    setTimeout(() => { if (_tut && _tut.index === at) _tutNext(); }, 900);
  };
  document.addEventListener('main-character-changed', onMain);
  t.cleanups.push(() => {
    [offAdded, offAuthErr, offSync].forEach(off => { try { off?.(); } catch (_) {} });
    document.removeEventListener('dashboard-widget-added', onWidget);
    document.removeEventListener('main-character-changed', onMain);
  });

  t.firstIndex = TutorialModel.nextIndex(steps, -1, +1, ctx);
  await _tutGoto(t.firstIndex);
}

/**
 * Leave the tour. `reason` is what gets remembered: finishing marks that tour
 * done; closing or declining only marks it seen, which is what stops it opening
 * by itself again. Either way it can be run again from Settings, General.
 */
function exitTutorial(reason = 'closed', { quiet = false } = {}) {
  const t = _tut;
  if (!t) return;
  _tut = null;
  t.stepCleanups.forEach(fn => { try { fn(); } catch (_) {} });
  t.cleanups.forEach(fn => { try { fn(); } catch (_) {} });
  t.root.remove();
  document.body.classList.remove('tour-active');

  const patch = { seen: true };
  if (reason === 'finished') patch[t.kind === 'advanced' ? 'advancedDone' : 'basicDone'] = true;
  _tutSave(patch);

  if (!quiet && (reason === 'closed' || reason === 'declined') && typeof pushAppToast === 'function') {
    pushAppToast({ title: 'Tour closed', body: 'You can run it again from Settings, General.', kind: 'info', timeout: 6000 });
  }
  // Next tick, so a tour started straight after this one (the basics handing
  // over to alliance tools) is already under way and nothing hears an end.
  setTimeout(_tutAnnounceIdle, 0);
}

/** On a first launch (never seen, no characters yet), open the basics. */
async function maybeStartTutorialOnFirstLaunch() {
  _tutDeciding = true;
  try {
    const [state, accounts] = await Promise.all([_tutState(), window.eveAPI.getAccounts().catch(() => [])]);
    const go = TutorialModel.shouldAutoStart({
      state,
      accountCount: Array.isArray(accounts) ? accounts.length : 0,
      demo: !!window.eveAPI?.isDemo,
      suppress: !!state.suppressAutoStart,
    });
    if (go) await startTutorial('basic');
  } catch (e) {
    console.warn('[tutorial] first-launch check failed:', e?.message || e);
  } finally {
    _tutDeciding = false;
    _tutAnnounceIdle();
  }
}

// Settings, General: run either tour again. The basics close Settings first,
// since the tour starts in the menu; alliance tools open Settings themselves.
(function bindTutorialSettings() {
  const basic = document.getElementById('tutorialStartBtn');
  const advanced = document.getElementById('tutorialAdvancedBtn');
  if (basic) basic.addEventListener('click', () => {
    document.getElementById('closeSettingsBtn')?.click();
    startTutorial('basic');
  });
  if (advanced) advanced.addEventListener('click', () => startTutorial('advanced'));
})();
