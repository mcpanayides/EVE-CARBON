// ─── Characters ───────────────────────────────────────────────────────────────

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

    // Respect saved drag order
    let orderedAccounts = accounts;
    try {
      const savedOrder = JSON.parse(localStorage.getItem('char_card_order') || 'null');
      if (savedOrder && Array.isArray(savedOrder)) {
        const orderMap = {};
        savedOrder.forEach((id, i) => { orderMap[String(id)] = i; });
        orderedAccounts = [...accounts].sort((a, b) => {
          const ai = orderMap[String(a.characterId)] ?? 999;
          const bi = orderMap[String(b.characterId)] ?? 999;
          return ai - bi;
        });
      }
    } catch (e) { /* ignore */ }

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
        ${isActive ? '<div class="character-active-badge">● ACTIVE</div>' : ''}`;

      const rightDiv  = document.createElement('div');
      rightDiv.className = 'character-card-right';

      const syncBtn = document.createElement('button');
      syncBtn.className = 'character-sync-btn sync-btn bp-view-btn';
      syncBtn.dataset.id = acc.characterId;
      syncBtn.textContent = 'SYNC';

      const removeBtn = document.createElement('button');
      removeBtn.className = 'character-remove-btn remove-btn';
      removeBtn.dataset.id = acc.characterId;
      removeBtn.title = 'Remove Account';
      removeBtn.textContent = '✕';

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

    // Wire sync buttons
    listDiv.querySelectorAll('.sync-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const target       = e.currentTarget;
        const id           = target.getAttribute('data-id');
        const originalText = target.textContent;
        target.textContent = 'SYNCING...';
        target.disabled    = true;
        target.classList.remove('success', 'failure');
        try {
          showToast('Downloading blueprints from ESI...', 'info');
          const result = await window.eveAPI.syncBlueprints(id);
          showToast(`✓ Synced ${result.count} blueprints!`, 'success');
          target.textContent = 'SYNCED';
          target.classList.add('success');
          await loadBlueprintLibrary();
        } catch (err) {
          showToast(`Sync failed: ${err.message}`, 'error');
          target.textContent = 'FAILED';
          target.classList.add('failure');
        } finally {
          setTimeout(() => {
            target.textContent = originalText;
            target.disabled    = false;
            target.classList.remove('success', 'failure');
          }, 5000);
        }
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

  document.querySelectorAll('.character-card').forEach(card => {
    const isThis = String(card.dataset.characterId) === String(account.characterId);
    card.classList.toggle('selected', isThis);
    const portrait = card.querySelector('.character-card-portrait');
    if (portrait) portrait.style.borderColor = isThis ? '#00b3a6' : '';
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