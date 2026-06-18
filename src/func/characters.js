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
function requestCharacterSync(id) {
  id = String(id);

  // Cooldown gate — collapses post-sync re-clicks into a no-op for 60 s.
  const until = _syncCooldownUntil[id] || 0;
  if (Date.now() < until) {
    const secs = Math.ceil((until - Date.now()) / 1000);
    showToast(`Synced recently — try again in ${secs}s.`, 'info');
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
  if (window.eveAPI && window.eveAPI.on) window.eveAPI.on('char-sync-progress', progressHandler);

  showToast(`Syncing all data for character ${id}…`, 'info');

  try {
    const result = await window.eveAPI.syncCharacterFull(id);
    ({ card, btn } = _findSyncCard(id)); // re-fetch in case the list re-rendered
    if (btn) { btn.textContent = 'SYNCED'; btn.classList.remove('failure'); btn.classList.add('success'); }
    if (typeof logToConsole === 'function') logToConsole(`✓ Full sync complete for ${result?.characterName || id}`, 'success');
    showToast('✓ Full sync complete!', 'success');
    if (typeof loadBlueprintLibrary === 'function') await loadBlueprintLibrary();
  } catch (err) {
    ({ card, btn } = _findSyncCard(id));
    if (btn) { btn.textContent = 'FAILED'; btn.classList.remove('success'); btn.classList.add('failure'); }
    if (typeof logToConsole === 'function') logToConsole(`✗ Sync failed: ${err.message}`, 'error');
    showToast(`Sync failed: ${err.message}`, 'error');
  } finally {
    if (window.eveAPI && window.eveAPI.off) window.eveAPI.off('char-sync-progress', progressHandler);

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

// ─── Favorites ────────────────────────────────────────────────────────────────
// Starred characters are pinned to the top of the list (before the saved drag
// order). Persisted in localStorage as an array of characterIds.
const FAV_KEY = 'char_favorites';
function getFavorites() {
  try {
    const arr = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    return new Set((Array.isArray(arr) ? arr : []).map(String));
  } catch (e) { return new Set(); }
}
function toggleFavorite(id) {
  const favs = getFavorites();
  id = String(id);
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])); } catch (e) { /* ignore */ }
  return favs.has(id);
}

async function loadAccounts() {
  try {
    const accounts = await window.eveAPI.getAccounts();
    const listDiv  = document.getElementById('accountsListNav');
    if (!listDiv) return;
    listDiv.innerHTML = '';

    if (!accounts || accounts.length === 0) {
      listDiv.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="empty-icon">⬡</div>
          <div class="empty-title">NO CHARACTERS</div>
          <div class="empty-sub">Click + ADD CHARACTER to login with EVE SSO.</div>
        </div>`;
      return;
    }

    // Sort: favorites first, then the saved drag order within each group.
    const favs = getFavorites();
    const orderMap = {};
    try {
      const savedOrder = JSON.parse(localStorage.getItem('char_card_order') || 'null');
      if (savedOrder && Array.isArray(savedOrder)) savedOrder.forEach((id, i) => { orderMap[String(id)] = i; });
    } catch (e) { /* ignore */ }
    const orderedAccounts = [...accounts].sort((a, b) => {
      const fa = favs.has(String(a.characterId)) ? 0 : 1;
      const fb = favs.has(String(b.characterId)) ? 0 : 1;
      if (fa !== fb) return fa - fb;                       // favorites pinned to top
      return (orderMap[String(a.characterId)] ?? 999) - (orderMap[String(b.characterId)] ?? 999);
    });

    orderedAccounts.forEach(acc => {
      const isActive = String(acc.characterId) === String(selectedCharacterId);
      const item     = document.createElement('div');
      item.className = 'character-card' + (isActive ? ' selected' : '');
      item.dataset.characterId = acc.characterId;
      item.draggable = true;

      const portrait = document.createElement('img');
      portrait.className = 'character-card-portrait';
      portrait.alt     = acc.characterName;
      portrait.loading = 'lazy';
      portrait.title   = acc.characterName;
      portrait.onerror = function () {
        this.onerror = null;
        const tried = this.dataset.tried || '';
        if (!tried.includes('128')) {
          this.dataset.tried = tried + ' 128';
          this.src = `https://images.evetech.net/characters/${acc.characterId}/portrait?size=128`;
        } else if (!tried.includes('64')) {
          this.dataset.tried = tried + ' 64';
          this.src = `https://images.evetech.net/characters/${acc.characterId}/portrait?size=64`;
        }
      };
      portrait.src = `https://images.evetech.net/characters/${acc.characterId}/portrait?size=128`;

      const infoDiv = document.createElement('div');
      infoDiv.className = 'character-card-content';
      infoDiv.innerHTML = `
        <div class="character-card-name">${escHtml(acc.characterName)}</div>
        <div class="character-card-meta">
          <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);">${acc.characterId}</span>
        </div>
        <div class="character-card-location" style="font-family:var(--mono);font-size:10px;color:var(--text-2);margin-top:2px;"></div>
        ${isActive ? '<div class="character-active-badge">● ACTIVE</div>' : ''}`;

      // Current location from the local DB (no network) — filled per card.
      window.eveAPI.getCharacterData(acc.characterId).then(d => {
        const locEl = infoDiv.querySelector('.character-card-location');
        if (!locEl) return;
        const sys = d && d.location && d.location.solar_system_name;
        locEl.textContent = sys ? `⌖ ${sys}` : '';
      }).catch(() => {});

      const rightDiv  = document.createElement('div');
      rightDiv.className = 'character-card-right';

      const isFav = favs.has(String(acc.characterId));
      const favBtn = document.createElement('button');
      favBtn.className = 'character-fav-btn';
      favBtn.dataset.id = acc.characterId;
      favBtn.textContent = isFav ? '★' : '☆';
      favBtn.title = isFav ? 'Unfavorite' : 'Favorite — pin to top';
      favBtn.style.cssText = `background:none;border:none;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;flex-shrink:0;color:${isFav ? '#e3c14d' : 'var(--text-3)'};`;

      const syncBtn = document.createElement('button');
      syncBtn.className = 'character-sync-btn sync-btn bp-view-btn';
      syncBtn.dataset.id = acc.characterId;
      syncBtn.textContent = 'SYNC';

      const removeBtn = document.createElement('button');
      removeBtn.className = 'character-remove-btn remove-btn';
      removeBtn.dataset.id = acc.characterId;
      removeBtn.title = 'Remove Account';
      removeBtn.textContent = '✕';

      rightDiv.appendChild(favBtn);
      rightDiv.appendChild(syncBtn);
      rightDiv.appendChild(removeBtn);
      item.appendChild(portrait);
      item.appendChild(infoDiv);
      item.appendChild(rightDiv);

      // Click to select
      item.addEventListener('click', (e) => {
        if (!e.target.closest('.character-card-right')) selectCharacter(acc);
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
          if (e.clientY < rect.top + rect.height / 2) listDiv.insertBefore(dragging, item);
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

    if (!selectedCharacterId && orderedAccounts.length > 0) selectCharacter(orderedAccounts[0]);

    // Wire remove buttons
    listDiv.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = e.currentTarget.getAttribute('data-id');
        await window.eveAPI.removeAccount(id);
        showToast('Account removed.', 'info');
        loadAccounts();
        loadBlueprintLibrary();
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

    // Wire favorite stars — toggle persisted state and re-render so the list
    // re-sorts with favorites pinned to the top.
    listDiv.querySelectorAll('.character-fav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(e.currentTarget.getAttribute('data-id'));
        loadAccounts();
      });
    });
  } catch (err) {
    console.error('Failed to load accounts:', err);
    showToast('Error loading saved accounts.', 'error');
  }
}

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
    const portrait = card.querySelector('.character-card-portrait');
    if (portrait) portrait.style.borderColor = isThis ? getComputedStyle(document.documentElement).getPropertyValue('--teal').trim() : '';
    const content = card.querySelector('.character-card-content');
    if (!content) return;
    const existing = content.querySelector('.character-active-badge');
    if (isThis && !existing) {
      const badge = document.createElement('div');
      badge.className = 'character-active-badge';
      badge.textContent = '● ACTIVE';
      content.appendChild(badge);
    } else if (!isThis && existing) {
      existing.remove();
    }
  });

  updateNavCharacterBtn(account);
  showToast(`Active: ${account.characterName}`, 'success');
}

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
    const portrait = card.querySelector('.character-card-portrait');
    if (portrait) portrait.style.borderColor = '';
  });
  updateNavCharacterBtn(null);
  showToast('Character selection cleared', 'info');
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
      // Refresh the card list so ACTIVE badge / portrait updates
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