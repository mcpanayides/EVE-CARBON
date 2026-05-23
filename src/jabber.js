// ─── Jabber ───────────────────────────────────────────────────────────────────

function renderJabberTable() {
  const tbody = document.querySelector('#jabberTable tbody');
  if (!tbody) return;
  const rows = jabberFilterDirectorOnly
    ? jabberMessages.filter(m => m.isDirector)
    : jabberMessages;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">No messages received yet.</td></tr>`;
    updateJabberSummary();
    return;
  }

  tbody.innerHTML = rows.map(msg => `
    <tr>
      <td>${escHtml(msg.from)}</td>
      <td>${escHtml(msg.body)}</td>
      <td>${escHtml(msg.type)}</td>
      <td>${msg.isDirector ? 'Yes' : 'No'}</td>
    </tr>`).join('');

  updateJabberSummary();
}

function updateJabberSummary() {
  const summary = document.getElementById('jabberSummary');
  if (!summary) return;
  const count = jabberFilterDirectorOnly
    ? jabberMessages.filter(m => m.isDirector).length
    : jabberMessages.length;
  summary.textContent = `${count} message${count === 1 ? '' : 's'} received`;
}

async function populateJabberSettings() {
  const cfg    = await window.eveAPI.getAppConfig();
  const jabber = cfg?.app?.jabber || cfg?.jabber || {};

  jabberSettings = {
    service:     jabber.service     || 'xmpp://jabber.eveonline.com:5222',
    jid:         jabber.jid         || '',
    password:    jabber.password    || '',
    directorOnly: typeof jabber.directorOnly === 'boolean' ? jabber.directorOnly : true,
  };

  const serviceInput  = document.getElementById('jabberService');
  const jidInput      = document.getElementById('jabberJid');
  const passwordInput = document.getElementById('jabberPassword');
  const directorCheck = document.getElementById('jabberDirectorOnly');

  if (serviceInput)  serviceInput.value   = jabberSettings.service;
  if (jidInput)      jidInput.value       = jabberSettings.jid;
  if (passwordInput) passwordInput.value  = jabberSettings.password;
  if (directorCheck) directorCheck.checked = jabberSettings.directorOnly;
}

function gatherJabberSettings() {
  return {
    service:     document.getElementById('jabberService')?.value.trim()  || 'xmpp://jabber.eveonline.com:5222',
    jid:         document.getElementById('jabberJid')?.value.trim()      || '',
    password:    document.getElementById('jabberPassword')?.value        || '',
    directorOnly: document.getElementById('jabberDirectorOnly')?.checked ?? true,
  };
}

async function autoConnectJabber() {
  const cfg      = await window.eveAPI.getAppConfig();
  const jabber   = cfg?.app?.jabber || cfg?.jabber || {};
  const service  = jabber.service?.trim();
  const jid      = jabber.jid?.trim();
  const password = jabber.password || '';
  const label    = document.getElementById('jabberStatus');

  if (!service || !jid || !password) {
    if (label) label.textContent = 'Jabber credentials missing; set them in Settings.';
    return;
  }

  if (label) label.textContent = 'Auto-connecting to Jabber...';
  try {
    const result = await window.eveAPI.connectJabber({ service, jid, password });
    if (!result.success) {
      showToast(`Jabber auto-connect failed: ${result.message}`, 'error');
      if (label) label.textContent = 'Jabber disconnected.';
    }
  } catch (err) {
    showToast(`Jabber auto-connect error: ${err.message}`, 'error');
    if (label) label.textContent = 'Jabber disconnected.';
  }
}

// Wire up Jabber-specific event listeners (called from bindEvents)
function bindJabberEvents() {
  const jabberDirectorOnly = document.getElementById('jabberDirectorOnly');
  if (jabberDirectorOnly) {
    jabberDirectorOnly.addEventListener('change', () => {
      jabberFilterDirectorOnly = jabberDirectorOnly.checked;
      renderJabberTable();
    });
  }

  // Listen for incoming messages and status updates from main process
  window.eveAPI.on('jabber-message', (msg) => {
    jabberMessages.push(msg);
    renderJabberTable();
  });

  window.eveAPI.on('jabber-status', (status) => {
    jabberConnected = status.status === 'online';
    updateNavStatusIndicators();
    const label = document.getElementById('jabberStatus');
    if (label) label.textContent = status.message || '';
  });
}