// ─── Characters ───────────────────────────────────────────────────────────────

// ─── Manual sync queue ────────────────────────────────────────────────────────
// A full character sync is an ESI-heavy, paginated operation. Letting the user
// fire several at once (or spam one button) hammers ESI and triggers rate
// limits. This queue serialises manual syncs so only ONE runs at a time, and
// adds two guards:
//   • dedupe   — a character already queued or running is never enqueued twice.
//   • cooldown — after a character syncs, repeat requests are ignored for 60 s.
// Together these collapse a 6×-button-mash into a single sync followed by a
// one-minute timeout, exactly as intended.
const _syncQueue         = [];          // characterIds waiting their turn
const _syncInFlight      = new Set();   // ids queued OR running (dedupe)
const _syncCooldownUntil = {};          // id -> timestamp until which clicks are ignored
let   _syncWorkerRunning = false;
const SYNC_COOLDOWN_MS    = 60 * 1000;  // 1 minute

function _findSyncCard(id) {
  const card = document.querySelector(`.character-card[data-character-id="${String(id)}"]`);
  return { card, btn: card ? card.querySelector('.character-sync-btn') : null };
}

function _ensureCardSpinner(card, btn) {
  if (!card || !btn) return null;
  let spinner = card.querySelector('.char-sync-spinner');
  if (!spinner) {
    spinner = document.createElement('span');
    spinner.className = 'char-sync-spinner sync-spinner spin';
    spinner.style.cssText = 'width:14px;height:14px;margin-left:6px;display:inline-block;flex-shrink:0;';
    btn.insertAdjacentElement('afterend', spinner);
  }
  spinner.style.display = 'inline-block';
  return spinner;
}

// Re-apply queued/syncing visuals to a freshly-rendered card. loadAccounts()
// can rebuild the list while the queue is still draining (e.g. an auto-sync
// 'done' event), which would otherwise reset an in-flight card to plain SYNC.
function _applyManualSyncStateIfActive(id, card) {
  id = String(id);
  if (!_syncInFlight.has(id)) return;
  const btn = card.querySelector('.character-sync-btn');
  if (!btn) return;
  btn.textContent = _syncQueue.includes(id) ? 'QUEUED' : 'SYNCING';
  btn.disabled    = true;
  btn.classList.remove('success', 'failure');
  _ensureCardSpinner(card, btn);
}

// Public entry point wired to every SYNC button. Decides whether to enqueue.
// `silent` suppresses the cooldown toast — used by Resync All so a batch of
// recently-synced characters doesn't fire a toast per character.
function requestCharacterSync(id, silent = false) {
  id = String(id);

  // Cooldown gate — collapses post-sync re-clicks into a no-op for 60 s.
  const until = _syncCooldownUntil[id] || 0;
  if (Date.now() < until) {
    if (!silent) {
      const secs = Math.ceil((until - Date.now()) / 1000);
      showToast(`Synced recently — try again in ${secs}s.`, 'info');
    }
    return;
  }

  // Dedupe gate — already queued or running, so ignore silently (the button
  // already shows QUEUED/SYNCING, giving the user feedback).
  if (_syncInFlight.has(id)) return;

  _syncInFlight.add(id);
  _syncQueue.push(id);

  // Reflect state on the card: next-up shows SYNCING once the worker reaches it,
  // anything behind it shows QUEUED.
  const { card, btn } = _findSyncCard(id);
  if (btn) {
    btn.textContent = _syncWorkerRunning ? 'QUEUED' : 'SYNCING';
    btn.disabled    = true;
    btn.classList.remove('success', 'failure');
    _ensureCardSpinner(card, btn);
  }

  _runSyncWorker();
}

// Drains the queue one character at a time. Idempotent — safe to call on every
// enqueue; only one worker loop ever runs.
async function _runSyncWorker() {
  if (_syncWorkerRunning) return;
  _syncWorkerRunning = true;
  try {
    while (_syncQueue.length) {
      const id = _syncQueue.shift();
      await _performCharacterSync(id);
    }
  } finally {
    _syncWorkerRunning = false;
  }
}

// Runs a single full sync with the same UI/progress behaviour the inline
// handler used to have. Button/card are looked up fresh so a re-render of the
// card list mid-queue doesn't leave us pointing at a detached node.
async function _performCharacterSync(id) {
  id = String(id);
  let { card, btn } = _findSyncCard(id);
  let spinner = _ensureCardSpinner(card, btn);
  if (btn) {
    btn.textContent = 'SYNCING';
    btn.disabled    = true;
    btn.classList.remove('success', 'failure');
  }

  const stepLabels = {
    start:          'Starting full sync…',
    character_info: 'Character sheet',
    wallet:         'Wallet',
    location:       'Location',
    ship:           'Ship',
    implants:       'Implants & Clones',
    pi:             'Planetary Interaction',
    assets:         'Assets',
    blueprints:     'Blueprints',
    done:           'Sync complete',
    error:          'Sync error',
  };

  const progressHandler = (data) => {
    if (String(data.characterId) !== id) return;
    const { step, detail } = data;
    const label = stepLabels[step] || step;
    const msg   = detail ? `${label}: ${detail}` : label;
    if (typeof logToConsole === 'function') {
      const level = step === 'error' ? 'error' : step === 'done' ? 'success' : 'info';
      logToConsole(msg, level);
    }
  };
  const stopProgress = window.eveAPI?.on?.('char-sync-progress', progressHandler);

  showToast(`Syncing all data for character ${id}…`, 'info');

  try {
    const result = await window.eveAPI.syncCharacterFull(id);
    ({ card, btn } = _findSyncCard(id)); // re-fetch in case the list re-rendered
    if (btn) { btn.textContent = 'SYNCED'; btn.classList.remove('failure'); btn.classList.add('success'); }
    if (typeof logToConsole === 'function') logToConsole(`✓ Full sync complete for ${result?.characterName || id}`, 'success');
    showToast('✓ Full sync complete!', 'success');
    if (typeof loadBlueprintLibrary === 'function') await loadBlueprintLibrary();

    // New ESI permissions added since this character last logged in. Flag it
    // (see the ⚠ RE-LOGIN NEEDED card badge) rather than auto-launching SSO —
    // a bulk resync runs every character through here in sequence, and
    // auto-opening a browser tab per character spammed a tab for every one
    // of them before anyone could finish MFA on the first.
    if (result?.needsReauth) {
      const scopes = (result.missingScopes || []).join(', ');
      if (typeof logToConsole === 'function') logToConsole(`New permissions required (${scopes}) for ${result?.characterName || id} — re-login when convenient.`, 'info');
    }
  } catch (err) {
    ({ card, btn } = _findSyncCard(id));
    if (btn) { btn.textContent = 'FAILED'; btn.classList.remove('success'); btn.classList.add('failure'); }
    if (typeof logToConsole === 'function') logToConsole(`✗ Sync failed: ${err.message}`, 'error');
    showToast(`Sync failed: ${err.message}`, 'error');
  } finally {
    stopProgress?.();

    // Start the 1-minute cooldown now and free the dedupe slot.
    _syncCooldownUntil[id] = Date.now() + SYNC_COOLDOWN_MS;
    _syncInFlight.delete(id);

    // Restore the button after a short delay so the result stays visible.
    setTimeout(() => {
      const cur = _findSyncCard(id);
      const sp  = cur.card ? cur.card.querySelector('.char-sync-spinner') : null;
      if (sp) sp.style.display = 'none';
      if (cur.btn) {
        cur.btn.textContent = 'SYNC';
        cur.btn.disabled    = false;
        cur.btn.classList.remove('success', 'failure');
      }
    }, 4000);
  }
}

// ─── Main character ───────────────────────────────────────────────────────────
// The main character is the one the app speaks for: its portrait sits in the
// top-left slot of the menu, the dashboard's banner and skill queue are its, the
// map reads its alliance's standings, and character pickers start on it. It is
// the ◆ on its card, and its card always comes first. There is one whenever
// there is a character: the first card, until another card's ◇ is clicked.
//
// Kept in localStorage under char_favorites as a one-id array (the name is from
// when it was a "favourite"), so map.js, jump-planner.js and blueprints.js read
// it as favorites[0] unchanged.
const FAV_KEY = 'char_favorites';
function getMainCharacterId() {
  try {
    const arr = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    return Array.isArray(arr) && arr.length ? String(arr[0]) : null;
  } catch (e) { return null; }
}
function _saveMainCharacterId(id) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(id ? [String(id)] : [])); } catch (e) { /* ignore */ }
}

// The order the cards show in: the main first, then the order they were dragged into.
function _charCardOrder(accounts, mainId) {
  const orderMap = {};
  try {
    const saved = JSON.parse(localStorage.getItem('char_card_order') || 'null');
    if (Array.isArray(saved)) saved.forEach((id, i) => { orderMap[String(id)] = i; });
  } catch (e) { /* ignore */ }
  const rank = id => (String(id) === String(mainId) ? -1 : (orderMap[String(id)] ?? 999));
  return [...accounts].sort((a, b) => rank(a.characterId) - rank(b.characterId));
}

// The ◆ on the main's card and a ◇ on the others, with what clicking each one does.
function _paintMainDiamond(btn, isMain, name) {
  btn.classList.toggle('is-main', isMain);
  btn.textContent = isMain ? '◆' : '◇';
  btn.title = isMain ? 'Your main character' : 'Make this your main character';
  btn.setAttribute('aria-pressed', String(isMain));
  btn.setAttribute('aria-label', isMain ? `${name}, your main character` : `Make ${name} your main character`);
}

// ─── Resync all ───────────────────────────────────────────────────────────────
// Enqueues every saved character into the serialised sync queue. The queue's
// dedupe + cooldown guards make duplicates / recently-synced characters no-ops.
async function resyncAllCharacters() {
  let accounts = [];
  try { accounts = await window.eveAPI.getAccounts(); } catch (_) {}
  if (!accounts || !accounts.length) { showToast('No characters to sync.', 'info'); return; }
  showToast(`Queued ${accounts.length} character${accounts.length !== 1 ? 's' : ''} for re-sync.`, 'info');
  accounts.forEach(acc => requestCharacterSync(acc.characterId, true));
}

// Bloodline id → name (static EVE data). Used on the character ID cards.
// From the SDE's bloodlines — the table this replaced was a guess that put the
// wrong name on most pilots (4 read "Gallente" for a Brutor, 7 "Amarr" for a
// Gallente). Same table as the dashboard banner's.
const CHAR_BLOODLINE_NAMES = {
  1:'Deteis', 2:'Civire', 3:'Sebiestor', 4:'Brutor', 5:'Amarr', 6:'Ni-Kunni',
  7:'Gallente', 8:'Intaki', 11:'Achura', 12:'Jin-Mei', 13:'Khanid', 14:'Vherokior',
};

// A location name that's really a placeholder, not a real place.
function _charBadLocName(s) {
  return !s || /^(structure|location)\s/i.test(s) || /no structure found|not found|forbidden|error/i.test(s);
}

// Fill the async fields of a character ID card from the local DB + the shared
// net-worth cache. Never throws — leaves placeholders on failure.
async function _populateCharCard(card, acc, nwCache) {
  const id = acc.characterId;
  const set = (field, html) => {
    const el = card.querySelector(`[data-cc-field="${field}"]`);
    if (el) el.innerHTML = html;
  };

  let d = null;
  try { d = await window.eveAPI.getCharacterData(id); } catch (_) {}
  const info   = (d && d.info)   || {};
  const loc    = (d && d.location) || {};
  const ship   = (d && d.ship)   || {};
  const wallet = (d && d.wallet && d.wallet.balance) || 0;

  if (!d || !d.info) {
    ['born','sec','bloodline','home','location','gender','networth']
      .forEach(f => set(f, '<span style="color:var(--text-3);">—</span>'));
    set('implants', '<span style="color:var(--text-3);font-size:11px;">Sync to populate</span>');
    set('ship',     '<span style="color:var(--text-3);font-size:11px;">Sync this character</span>');
    return;
  }

  // Born
  let born = '—';
  if (info.birthday) { try { born = new Date(info.birthday).toISOString().slice(0,10).replace(/-/g,'.'); } catch (_) {} }
  set('born', escHtml(born));

  // Security status (coloured)
  if (typeof info.security_status === 'number') {
    const s   = info.security_status;
    const col = s > 0 ? 'var(--success)' : s < 0 ? 'var(--danger)' : 'var(--text-2)';
    set('sec', `<span style="color:${col};font-weight:700;">${s.toFixed(1)}</span>`);
  } else set('sec', '—');

  // Home station + current system
  const home = (!_charBadLocName(loc.station_name) && loc.station_name) || loc.solar_system_name || '—';
  set('home',     escHtml(home));
  set('location', escHtml(loc.solar_system_name || '—'));

  // Gender + bloodline
  set('gender', escHtml(info.gender ? info.gender.charAt(0).toUpperCase() + info.gender.slice(1) : '—'));
  set('bloodline', escHtml(info.bloodline_id ? (CHAR_BLOODLINE_NAMES[info.bloodline_id] || `ID ${info.bloodline_id}`) : '—'));

  // Net worth = cached asset value + market escrow + liquid wallet
  const nw       = nwCache && nwCache.perChar && nwCache.perChar[String(id)];
  const netWorth = (nw && nw.assetValue || 0) + (nw && nw.escrow || 0) + wallet;
  set('networth', netWorth > 0
    ? `<span style="color:var(--liquidisk);">${formatISK(netWorth)}</span>`
    : (wallet > 0 ? formatISK(wallet) : '<span style="color:var(--text-3);">—</span>'));

  // Corp + alliance logos
  const corpLogo = card.querySelector('[data-cc-field="corp-logo"]');
  const allyLogo = card.querySelector('[data-cc-field="ally-logo"]');
  const allySep  = card.querySelector('[data-cc-field="ally-sep"]');
  if (corpLogo && info.corporation_id) {
    corpLogo.src = `https://images.evetech.net/corporations/${info.corporation_id}/logo?size=32`;
    corpLogo.style.display = '';
  }
  if (allyLogo && info.alliance_id) {
    allyLogo.src = `https://images.evetech.net/alliances/${info.alliance_id}/logo?size=32`;
    allyLogo.style.display = '';
    if (allySep) allySep.textContent = '·';
  }

  // Corp + alliance names (bulk name resolver returns [{id,name}] → map it)
  if (info.corporation_id || info.alliance_id) {
    try {
      const ids = [info.corporation_id, info.alliance_id].filter(Boolean);
      const arr = await window.eveAPI.getNames(ids);
      const nm  = {};
      if (Array.isArray(arr)) arr.forEach(r => { if (r && !/^Type\s/.test(r.name)) nm[r.id] = r.name; });
      const corpEl = card.querySelector('[data-cc-field="corp-name"]');
      const allyEl = card.querySelector('[data-cc-field="ally-name"]');
      if (corpEl && nm[info.corporation_id]) corpEl.textContent = nm[info.corporation_id];
      if (allyEl && info.alliance_id) allyEl.textContent = nm[info.alliance_id] || '';
    } catch (_) {}
  }

  // Implants (slot icons)
  const raw = (d.implants || d.implantsList || d.character_implants || info.implants || []);
  const implants = (Array.isArray(raw) ? raw : [])
    .map(r => ({ id: r.implant_id || r.type_id || r.id, name: r.type_name || r.name || '' }))
    .filter(r => r.id);
  set('implants', implants.length
    ? implants.map(im =>
        `<img class="char-cc-implant" src="${ESI_IMAGE}/${im.id}/icon?size=32"
              title="${escHtml(im.name || `Implant ${im.id}`)}" alt="" loading="lazy"
              onerror="this.style.display='none'">`).join('')
    : '<span style="color:var(--text-3);font-size:11px;">No implants</span>');

  // Current ship
  const shipId = ship.ship_type_id, shipName = ship.ship_type_name;
  set('ship', shipId
    ? `<img class="char-cc-ship-icon" src="${ESI_IMAGE}/${shipId}/icon?size=32" alt="" loading="lazy"
            onerror="this.style.display='none'">
       <span class="char-cc-ship-name">${escHtml(ship.ship_name || shipName || `Type ${shipId}`)}</span>`
    : '<span style="color:var(--text-3);font-size:11px;">Unknown — sync this character</span>');
}

let _reauthToastShown = false; // one nudge per session, not once per loadAccounts() call

async function loadAccounts() {
  try {
    const accounts = await window.eveAPI.getAccounts();
    const listDiv  = document.getElementById('accountsListNav');
    if (!listDiv) return;

    const reauthCount = (accounts || []).filter(a => a.needsReauth).length;
    if (reauthCount > 0 && !_reauthToastShown) {
      _reauthToastShown = true;
      showToast(`${reauthCount} character${reauthCount > 1 ? 's' : ''} need${reauthCount > 1 ? '' : 's'} to log back in — see the Characters page.`, 'warning');
    }

    listDiv.innerHTML = '';

    if (!accounts || accounts.length === 0) {
      listDiv.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="empty-icon">⬡</div>
          <div class="empty-title">NO CHARACTERS</div>
          <div class="empty-sub">Click + ADD CHARACTER to login with EVE SSO.</div>
        </div>`;
      // No characters, no main: the menu goes back to its Characters button.
      if (selectedCharacterId != null || getMainCharacterId()) {
        _saveMainCharacterId(null);
        clearSelectedCharacter();
      }
      return;
    }

    // The main character: the saved one while it is still here, else the first
    // card. The main goes first, then the order the cards were dragged into.
    const savedMain = getMainCharacterId();
    const mainAcc = accounts.find(a => String(a.characterId) === savedMain) || _charCardOrder(accounts, null)[0];
    const orderedAccounts = _charCardOrder(accounts, mainAcc.characterId);

    // Shared net-worth cache (asset value + escrow per character), computed by
    // the dashboard. Read once; each card adds its own liquid wallet on top.
    const nwCache = await window.eveAPI.cacheGet('dashboard_asset_value').catch(() => null);

    orderedAccounts.forEach(acc => {
      const id       = acc.characterId;
      const isMain   = String(id) === String(mainAcc.characterId);
      const item     = document.createElement('div');
      item.className = 'character-card character-id-card' + (isMain ? ' selected' : '');
      item.dataset.characterId = id;
      item.draggable = !isMain;   // the main's card stays first

      item.innerHTML = `
        <button type="button" class="character-fav-btn" data-id="${id}"></button>

        <div class="character-card-actions">
          <button class="character-sync-btn sync-btn bp-view-btn" data-id="${id}">SYNC</button>
          <span class="char-sync-spinner sync-spinner spin" style="width:14px;height:14px;display:none;"></span>
          <button class="character-remove-btn remove-btn" data-id="${id}" title="Remove Account">✕</button>
        </div>

        <div class="character-card-hero">
          <img class="character-card-portrait" alt="${escHtml(acc.characterName)}" title="${escHtml(acc.characterName)}"
               loading="lazy"
               src="https://images.evetech.net/characters/${id}/portrait?size=256"
               onerror="this.onerror=null;this.src='https://images.evetech.net/characters/${id}/portrait?size=128';">
          <div class="character-card-name">${escHtml(acc.characterName)}</div>
          <div class="character-card-affil">
            <img class="char-cc-corp-logo" data-cc-field="corp-logo" alt="" style="display:none;"
                 onerror="this.style.display='none'">
            <span class="char-cc-affil-name" data-cc-field="corp-name"></span>
            <span class="char-cc-affil-sep" data-cc-field="ally-sep"></span>
            <img class="char-cc-ally-logo" data-cc-field="ally-logo" alt="" style="display:none;"
                 onerror="this.style.display='none'">
            <span class="char-cc-affil-name char-cc-ally" data-cc-field="ally-name"></span>
          </div>
        </div>

        <div class="character-card-content">
          <div class="char-cc-stats">
            <div class="char-cc-row"><span class="char-cc-k">Born</span><span class="char-cc-v" data-cc-field="born">…</span></div>
            <div class="char-cc-row"><span class="char-cc-k">Sec Status</span><span class="char-cc-v" data-cc-field="sec">…</span></div>
            <div class="char-cc-row"><span class="char-cc-k">Bloodline</span><span class="char-cc-v" data-cc-field="bloodline">…</span></div>
            <div class="char-cc-row"><span class="char-cc-k">Home</span><span class="char-cc-v" data-cc-field="home">…</span></div>
            <div class="char-cc-row"><span class="char-cc-k">Location</span><span class="char-cc-v" data-cc-field="location">…</span></div>
            <div class="char-cc-row"><span class="char-cc-k">Gender</span><span class="char-cc-v" data-cc-field="gender">…</span></div>
            <div class="char-cc-row"><span class="char-cc-k">Net Worth</span><span class="char-cc-v" data-cc-field="networth">…</span></div>
          </div>
          <div class="char-cc-section">
            <div class="char-cc-section-label">Active Implants</div>
            <div class="char-cc-implants" data-cc-field="implants">…</div>
          </div>
          <div class="char-cc-section">
            <div class="char-cc-section-label">Current Ship</div>
            <div class="char-cc-ship" data-cc-field="ship">…</div>
          </div>
          ${isMain ? '<div class="character-active-badge">● MAIN</div>' : ''}
          ${acc.needsReauth ? '<div class="character-reauth-badge" title="Click to log back in">⚠ RE-LOGIN NEEDED</div>' : ''}
        </div>`;
      _paintMainDiamond(item.querySelector('.character-fav-btn'), isMain, acc.characterName);

      // Fill the async fields (DB + net-worth cache + corp/alliance names).
      _populateCharCard(item, acc, nwCache);

      // The ◇ picks the main character (wired below); the card itself only
      // answers its re-login badge.
      item.addEventListener('click', (e) => {
        if (e.target.closest('.character-reauth-badge')) window.eveAPI.startSSOLogin();
      });

      // Drag to reorder
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(acc.characterId));
        setTimeout(() => item.classList.add('dragging'), 0);
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        listDiv.querySelectorAll('.character-card').forEach(c => c.classList.remove('drag-over'));
        saveCharacterOrder();
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        const dragging = listDiv.querySelector('.character-card.dragging');
        if (dragging && dragging !== item) {
          listDiv.querySelectorAll('.character-card').forEach(c => c.classList.remove('drag-over'));
          item.classList.add('drag-over');
          const rect = item.getBoundingClientRect();
          // Nothing goes in front of the main's card.
          const onMain = String(item.dataset.characterId) === String(selectedCharacterId);
          if (!onMain && e.clientY < rect.top + rect.height / 2) listDiv.insertBefore(dragging, item);
          else listDiv.insertBefore(dragging, item.nextSibling);
        }
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', (e) => { e.preventDefault(); item.classList.remove('drag-over'); });

      listDiv.appendChild(item);

      // If this character is currently being auto-synced (e.g. the user
      // navigated to the Characters page mid-refresh), apply the syncing
      // state immediately so the card doesn't falsely show SYNC.
      if (typeof window._applyAutoSyncStateIfActive === 'function') {
        window._applyAutoSyncStateIfActive(acc.characterId, item);
      }
      // Same, for a manual sync still queued/running on this character.
      _applyManualSyncStateIfActive(acc.characterId, item);
    });

    // Settle the main quietly: on launch, when the saved main was removed, or
    // the first time there is a character. A click on a ◇ announces itself.
    setMainCharacter(mainAcc, { announce: false });

    // Wire remove buttons
    listDiv.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = e.currentTarget.getAttribute('data-id');
        try {
          await window.eveAPI.removeAccount(id);
          showToast('Account removed.', 'info');
          // Roster changed — drop session page memory so pages rebuild without
          // the removed character next time they're opened.
          if (typeof _pageInitialized !== 'undefined') _pageInitialized.clear();
          loadAccounts();
          loadBlueprintLibrary();
        } catch (err) {
          showToast(`Failed to remove account: ${err.message || err}`, 'error');
        }
      });
    });

    // Wire sync buttons — every click routes through the serialised sync queue
    // (see requestCharacterSync) so concurrent syncs and button-spam can't
    // overwhelm ESI.
    listDiv.querySelectorAll('.sync-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        requestCharacterSync(e.currentTarget.getAttribute('data-id'));
      });
    });

    // Wire the diamonds: a ◇ makes that character the main, at once. Clicking
    // the main's ◆ does nothing: there is always a main.
    listDiv.querySelectorAll('.character-fav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = e.currentTarget.getAttribute('data-id');
        if (String(id) === String(selectedCharacterId)) return;
        const acc = accounts.find(a => String(a.characterId) === String(id));
        if (acc) setMainCharacter(acc);
      });
    });
  } catch (err) {
    console.error('Failed to load accounts:', err);
    showToast('Error loading saved accounts.', 'error');
  }
}

/**
 * Makes `account` the main character, at once and from what is already here:
 * saved, its card moved to the first slot with the ◆, its portrait in the
 * menu's top-left slot, and a 'main-character-changed' event for everything
 * else that follows the main (the dashboard repaints its banner and skill
 * queue, the map re-reads its standings, the tour moves on). `announce` shows a
 * toast; loadAccounts settles the main quietly.
 */
function setMainCharacter(account, { announce = true } = {}) {
  if (!account) return;
  const id = String(account.characterId);
  const changed = String(selectedCharacterId ?? '') !== id;
  if (getMainCharacterId() !== id) _saveMainCharacterId(id);
  // The panel, the card marks and the menu portrait, when the main is new. The
  // cards redrawn after every sync come marked already, and the menu portrait
  // isn't rebuilt each time, so it never flickers.
  if (changed) selectCharacter(account);

  const listDiv = document.getElementById('accountsListNav');
  if (listDiv) {
    // Moves the cards already drawn, in the order the next full draw would use,
    // so nothing flickers and nothing jumps later.
    const cards = [...listDiv.querySelectorAll('.character-card[data-character-id]')];
    const byId = new Map(cards.map(c => [String(c.dataset.characterId), c]));
    _charCardOrder(cards.map(c => ({ characterId: c.dataset.characterId })), id)
      .forEach(a => listDiv.appendChild(byId.get(String(a.characterId))));
  }

  if (!changed) return;
  if (announce) showToast(`Main character: ${account.characterName}`, 'success');
  document.dispatchEvent(new CustomEvent('main-character-changed', {
    detail: { characterId: id, characterName: account.characterName },
  }));
}

// Shows `account` as the main: the panel above the cards, the card marks and
// the menu portrait. setMainCharacter is what makes it the main.
function selectCharacter(account) {
  selectedCharacterId = account.characterId;

  const section = document.getElementById('selectedCharacterSection');
  if (section) section.style.display = 'block';

  const selPortrait = document.getElementById('selectedCharPortrait');
  if (selPortrait) selPortrait.src = `https://images.evetech.net/characters/${account.characterId}/portrait?size=128`;
  const selName = document.getElementById('selectedCharName');
  if (selName) selName.textContent = account.characterName;
  const selMeta = document.getElementById('selectedCharMeta');
  if (selMeta) selMeta.textContent = `ID: ${account.characterId}`;

  // Current location (solar system, station if known) — from the last sync.
  const selLoc = document.getElementById('selectedCharLocation');
  if (selLoc) {
    selLoc.textContent = '⌖ Locating…';
    window.eveAPI.getCharacterData(account.characterId)
      .then(d => {
        const sys = d && d.location && d.location.solar_system_name;
        const st  = d && d.location && d.location.station_name;
        selLoc.textContent = sys
          ? `⌖ ${sys}${st ? ' · ' + st : ''}`
          : '⌖ Location unknown — sync this character';
      })
      .catch(() => { selLoc.textContent = ''; });
  }

  document.querySelectorAll('.character-card').forEach(card => {
    const isThis = String(card.dataset.characterId) === String(account.characterId);
    card.classList.toggle('selected', isThis);
    card.draggable = !isThis;
    const diamond = card.querySelector('.character-fav-btn');
    if (diamond) _paintMainDiamond(diamond, isThis, card.querySelector('.character-card-name')?.textContent || 'this character');
    const content = card.querySelector('.character-card-content');
    if (!content) return;
    const existing = content.querySelector('.character-active-badge');
    if (isThis && !existing) {
      const badge = document.createElement('div');
      badge.className = 'character-active-badge';
      badge.textContent = '● MAIN';
      // Before the re-login badge, where the first draw puts it.
      content.insertBefore(badge, content.querySelector('.character-reauth-badge'));
    } else if (!isThis && existing) {
      existing.remove();
    }
  });

  updateNavCharacterBtn(account);
}

// No characters left: no main, and the menu shows its Characters button again.
function clearSelectedCharacter() {
  selectedCharacterId = null;
  const section = document.getElementById('selectedCharacterSection');
  if (section) section.style.display = 'none';
  const selLoc = document.getElementById('selectedCharLocation');
  if (selLoc) selLoc.textContent = '';
  document.querySelectorAll('.character-card').forEach(card => {
    card.classList.remove('selected');
    const badge    = card.querySelector('.character-active-badge');
    if (badge) badge.remove();
  });
  updateNavCharacterBtn(null);
}

function saveCharacterOrder() {
  const listDiv = document.getElementById('accountsListNav');
  if (!listDiv) return;
  const order = Array.from(listDiv.querySelectorAll('.character-card'))
    .map(c => c.dataset.characterId);
  try { localStorage.setItem('char_card_order', JSON.stringify(order)); } catch (e) { /* ignore */ }
}
// ─── Auto-sync progress listener ─────────────────────────────────────────────
// Picks up char-sync-progress events from main process (fired after SSO login
// and during manual re-syncs) and routes them to the app console bar.
(function initCharSyncProgressListener() {
  if (!window.eveAPI || !window.eveAPI.on) return;

  window.eveAPI.on('char-sync-progress', (data) => {
    if (!data) return;
    const { characterName, step, detail, summary } = data;
    const name = characterName || `Character ${data.characterId}`;

    const stepLabels = {
      start:          `Starting full sync for ${name}…`,
      character_info: `[${name}] Character sheet`,
      wallet:         `[${name}] Wallet balance`,
      location:       `[${name}] Current location`,
      ship:           `[${name}] Current ship`,
      implants:       `[${name}] Implants & jump clones`,
      pi:             `[${name}] Planetary Interaction`,
      assets:         `[${name}] Assets`,
      blueprints:     `[${name}] Blueprints`,
      done:           `✓ Full sync complete for ${name}`,
      error:          `✗ Sync error for ${name}`,
    };

    const label = stepLabels[step] || `[${name}] ${step}`;
    const msg   = detail ? `${label}: ${detail}` : label;
    const level = step === 'error' ? 'error' : step === 'done' ? 'success' : 'info';

    if (typeof logToConsole === 'function') logToConsole(msg, level);
    if (step === 'done' && typeof loadAccounts === 'function') {
      // Refresh the card list so the MAIN badge / portrait updates
      loadAccounts();
    }
  });
})();

// ─── Auto-sync card state ─────────────────────────────────────────────────────
// Listens for 'auto-sync' CustomEvents fired by autoRefreshStaleCharacters()
// in dashboard.js and mirrors the exact spinner + button state that manual
// sync uses, so the character card looks the same regardless of what triggered
// the sync. Also handles cards that are rendered AFTER the event fires by
// checking _autoSyncingIds on card creation (inside loadAccounts).
(function initAutoSyncCardListener() {
  // _syncCardTimers: characterId -> setTimeout handle for the post-sync reset
  const _syncCardTimers = {};

  function getCardElements(characterId) {
    const id   = String(characterId);
    const card = document.querySelector(`.character-card[data-character-id="${id}"]`);
    if (!card) return null;
    const btn     = card.querySelector('.character-sync-btn');
    const spinner = card.querySelector('.char-sync-spinner');
    return { card, btn, spinner };
  }

  function ensureSpinner(card, btn) {
    let spinner = card.querySelector('.char-sync-spinner');
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.className = 'char-sync-spinner sync-spinner spin';
      spinner.style.cssText = 'width:14px;height:14px;margin-left:6px;display:inline-block;flex-shrink:0;';
      btn.insertAdjacentElement('afterend', spinner);
    }
    spinner.style.display = 'inline-block';
    return spinner;
  }

  // Called when a card is first built — if the character is already mid-sync
  // (auto-refresh started before the characters page was open) apply the
  // syncing state immediately so it doesn't show a stale SYNC button.
  window._applyAutoSyncStateIfActive = function(characterId, card) {
    // _autoSyncingIds is defined in dashboard.js (same page scope)
    if (typeof _autoSyncingIds === 'undefined') return;
    const id = String(characterId);
    if (!_autoSyncingIds.has(id)) return;
    const btn = card.querySelector('.character-sync-btn');
    if (!btn) return;
    btn.dataset.autoOriginalText = btn.dataset.autoOriginalText || btn.textContent;
    btn.textContent = 'SYNCING';
    btn.disabled    = true;
    btn.classList.remove('success', 'failure');
    ensureSpinner(card, btn);
  };

  document.addEventListener('auto-sync', (e) => {
    const { characterId, phase, success } = e.detail;
    const els = getCardElements(characterId);

    if (phase === 'start') {
      if (!els) return; // card not rendered yet; _applyAutoSyncStateIfActive handles that
      const { card, btn } = els;
      if (!btn) return;

      // Don't stomp a manual sync already in progress on this card
      if (btn.disabled && !btn.dataset.autoSync) return;

      btn.dataset.autoSync         = '1';
      btn.dataset.autoOriginalText = btn.textContent;
      btn.textContent = 'SYNCING';
      btn.disabled    = true;
      btn.classList.remove('success', 'failure');
      ensureSpinner(card, btn);

    } else if (phase === 'done' || phase === 'error') {
      if (!els) return;
      const { card, btn, spinner } = els;
      if (!btn || !btn.dataset.autoSync) return;

      btn.textContent = success ? 'SYNCED' : 'FAILED';
      btn.classList.add(success ? 'success' : 'failure');

      // Clear any previous reset timer for this card
      if (_syncCardTimers[characterId]) clearTimeout(_syncCardTimers[characterId]);
      _syncCardTimers[characterId] = setTimeout(() => {
        if (spinner) spinner.style.display = 'none';
        btn.textContent = btn.dataset.autoOriginalText || 'SYNC';
        btn.disabled    = false;
        btn.classList.remove('success', 'failure');
        delete btn.dataset.autoSync;
        delete btn.dataset.autoOriginalText;
        delete _syncCardTimers[characterId];
      }, 3000);
    }
  });
})();