// ─── bugs.js — Bug Report Modal ───────────────────────────────────────────────
// Renders and manages the "File a Bug Report" modal overlay.
// Sends reports via mailto: to bugs@vertexstudios.co.za
// Styled to match the existing VS Code-dark / EVE Carbon material design.

(function () {

  // owner/repo used to auto-open a pre-filled GitHub issue on submit, in addition
  // to the mailto: email. Change this if you fork the project.
  const GITHUB_REPO = 'mcpanayides/EVE-CARBON';

  // ─── Modal HTML ─────────────────────────────────────────────────────────────
  const BUG_MODAL_HTML = `
<div id="bugReportBackdrop" class="modal-backdrop bug-backdrop" style="display:none;">
  <div class="modal bug-modal">

    <!-- Header -->
    <div class="bug-modal-header">
      <div class="bug-modal-header-left">
        <span class="bug-modal-icon">⚠</span>
        <div>
          <div class="bug-modal-title">FILE A BUG REPORT</div>
          <div class="bug-modal-subtitle">Opens an email draft and a pre-filled GitHub issue</div>
        </div>
      </div>
      <button class="icon-btn bug-close-btn" id="closeBugReportBtn" title="Close">✕</button>
    </div>

    <!-- Top row: Summary / Category / Account -->
    <div class="bug-top-row">
      <div class="bug-field bug-field-summary">
        <label class="bug-label">Summary <span class="bug-required">*</span></label>
        <input type="text" id="bugSummary" class="field-input bug-input"
               placeholder="A one-line title to describe what's wrong" autocomplete="off"/>
      </div>
      <div class="bug-field bug-field-category">
        <label class="bug-label">Category <span class="bug-required">*</span></label>
        <select id="bugCategory" class="field-input bug-input">
          <option value="Launcher">Launcher</option>
          <option value="Characters">Characters</option>
          <option value="Dashboard">Dashboard</option>
          <option value="Industry">Industry</option>
          <option value="Blueprints">Blueprints</option>
          <option value="Materials">Materials</option>
          <option value="Assets">Assets</option>
          <option value="Wallets">Wallets</option>
          <option value="Fleet Commander">Fleet Commander</option>
          <option value="Jabber">Jabber</option>
          <option value="Market">Market</option>
          <option value="Map">Map</option>
          <option value="Planetary Interaction">Planetary Interaction</option>
          <option value="UI / Visuals">UI / Visuals</option>
          <option value="Performance">Performance</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <div class="bug-field bug-field-account">
        <label class="bug-label">Account</label>
        <select id="bugAccount" class="field-input bug-input">
          <option value="">-- Select character --</option>
        </select>
      </div>
    </div>

    <!-- Description -->
    <div class="bug-field">
      <label class="bug-label">Description <span class="bug-required">*</span></label>
      <textarea id="bugDescription" class="field-input bug-textarea bug-textarea-lg"
        placeholder="Please describe what is wrong, and what you expected to happen instead.

It helps if you can include any error messages you received.

If the issue happens within the EVE Carbon client itself, include which page or panel you were using."></textarea>
    </div>

    <!-- Repro steps + Severity side by side -->
    <div class="bug-mid-row">
      <div class="bug-field bug-field-repro">
        <label class="bug-label">Reproduction Steps <span class="bug-required">*</span></label>
        <textarea id="bugRepro" class="field-input bug-textarea bug-textarea-md"
          placeholder="Please describe the steps you took to encounter this issue.

If you are unsure, please describe what you were doing before the issue occurred.

Example:
1. Add an account to the launcher.
2. Navigate to Industry &gt; Blueprints.
3. Search for 'Rifter'.
4. Observe that results do not appear."></textarea>
      </div>

      <div class="bug-field bug-field-severity">
        <label class="bug-label">Severity</label>
        <div class="bug-severity-grid" id="bugSeverityGrid">
          <button class="bug-sev-btn" data-sev="Low">
            <span class="bug-sev-icon">🟢</span>
            <span class="bug-sev-label">LOW</span>
            <span class="bug-sev-desc">Minor cosmetic or non-blocking</span>
          </button>
          <button class="bug-sev-btn bug-sev-active" data-sev="Medium">
            <span class="bug-sev-icon">🟡</span>
            <span class="bug-sev-label">MEDIUM</span>
            <span class="bug-sev-desc">Feature broken, workaround exists</span>
          </button>
          <button class="bug-sev-btn" data-sev="High">
            <span class="bug-sev-icon">🟠</span>
            <span class="bug-sev-label">HIGH</span>
            <span class="bug-sev-desc">Core feature unusable</span>
          </button>
          <button class="bug-sev-btn" data-sev="Critical">
            <span class="bug-sev-icon">🔴</span>
            <span class="bug-sev-label">CRITICAL</span>
            <span class="bug-sev-desc">App crash or data loss</span>
          </button>
        </div>

        <div class="bug-field" style="margin-top:16px;">
          <label class="bug-label">Additional Notes</label>
          <textarea id="bugNotes" class="field-input bug-textarea"
            style="height:80px;"
            placeholder="Any extra context, links, or workarounds you've found..."></textarea>
        </div>

        <!-- Shown only when diagnostic logging is switched on. The report goes to
             a PUBLIC issue tracker, so attaching the log is an explicit, visible
             choice with a preview rather than something that happens quietly. -->
        <div class="bug-field" id="bugLogField" style="margin-top:16px; display:none;">
          <label class="bug-label" style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="bugIncludeLog" checked>
            Attach the last part of the diagnostic log
          </label>
          <div class="bug-required-note" id="bugLogSummary" style="margin-top:4px;"></div>
          <button class="icon-btn" id="bugLogPreviewBtn" type="button"
                  style="margin-top:6px;">PREVIEW WHAT WILL BE SENT</button>
          <pre id="bugLogPreview" class="field-input"
               style="display:none; max-height:180px; overflow:auto; white-space:pre-wrap;
                      font-size:11px; margin-top:6px;"></pre>
        </div>
      </div>
    </div>

    <!-- Footer actions -->
    <div class="bug-footer">
      <div class="bug-footer-left">
        <span class="bug-required-note"><span class="bug-required">*</span> Required fields</span>
      </div>
      <div class="bug-footer-right">
        <button class="icon-btn" id="resetBugReportBtn">RESET</button>
        <button class="calc-btn bug-submit-btn" id="submitBugReportBtn">
          <span class="bug-submit-icon">⬡</span> SUBMIT REPORT
        </button>
      </div>
    </div>

  </div>
</div>`;

  // ─── Inject HTML ────────────────────────────────────────────────────────────
  function injectBugModal() {
    if (document.getElementById('bugReportBackdrop')) return;
    document.body.insertAdjacentHTML('beforeend', BUG_MODAL_HTML);
  }

  // ─── Populate account dropdown from loaded accounts ─────────────────────────
  async function populateBugAccounts() {
    const sel = document.getElementById('bugAccount');
    if (!sel) return;
    try {
      const accounts = await window.eveAPI.getAccounts();
      sel.innerHTML = '<option value="">-- Select character --</option>';
      if (accounts && accounts.length > 0) {
        accounts.forEach(acc => {
          const opt = document.createElement('option');
          opt.value = acc.characterName || acc.characterId || '';
          opt.textContent = acc.characterName || `Character ${acc.characterId}`;
          sel.appendChild(opt);
        });
      }
    } catch (_) {
      // eveAPI may not be available in non-Electron contexts; that's fine
    }
  }

  // ─── Open / Close ────────────────────────────────────────────────────────────
  function openBugReport() {
    injectBugModal();
    populateBugAccounts();
    bindBugEvents();
    populateBugLogSection();
    document.getElementById('bugReportBackdrop').style.display = 'flex';
    document.getElementById('bugSummary').focus();
  }

  // ─── Diagnostic log attachment ───────────────────────────────────────────────
  // Only offered when logging is actually on (Settings → General). This report
  // opens a PUBLIC GitHub issue, so attaching a log has to be a visible, checked
  // decision with a preview of the exact text — never something that happens
  // quietly on the user's behalf. The log is redacted before it is ever written
  // (see src/file_log.js), and the preview shows the same text that gets sent, so
  // what you see is genuinely what leaves the machine.
  let bugLogTail = '';

  async function populateBugLogSection() {
    const field   = document.getElementById('bugLogField');
    const summary = document.getElementById('bugLogSummary');
    const preview = document.getElementById('bugLogPreview');
    if (!field || !summary) return;

    bugLogTail = '';
    field.style.display = 'none';
    if (preview) { preview.style.display = 'none'; preview.textContent = ''; }

    if (!window.eveAPI?.logGetState) return;
    let state;
    try { state = await window.eveAPI.logGetState(); } catch (_) { return; }
    if (!state?.enabled || !state.exists) return;   // nothing worth offering

    try { bugLogTail = await window.eveAPI.logTail(); } catch (_) { return; }
    if (!bugLogTail) return;

    field.style.display = '';
    const lines = bugLogTail.split('\n').length;
    summary.textContent =
      `${lines} recent lines. Access tokens, sign-in codes and your user folder are removed. ` +
      `This report opens a public GitHub issue — check the preview before submitting.`;

    const btn = document.getElementById('bugLogPreviewBtn');
    if (btn && preview) {
      btn.onclick = () => {
        const showing = preview.style.display !== 'none';
        preview.style.display = showing ? 'none' : '';
        preview.textContent = bugLogTail;
        btn.textContent = showing ? 'PREVIEW WHAT WILL BE SENT' : 'HIDE PREVIEW';
      };
    }
  }

  /** The log block to append, or '' when there is nothing or it was declined. */
  function bugLogBlock() {
    const box = document.getElementById('bugIncludeLog');
    if (!bugLogTail || !box || !box.checked) return '';
    return bugLogTail;
  }

  function closeBugReport() {
    const backdrop = document.getElementById('bugReportBackdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  // ─── Reset ───────────────────────────────────────────────────────────────────
  function resetBugReport() {
    const fields = ['bugSummary', 'bugDescription', 'bugRepro', 'bugNotes'];
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const cat = document.getElementById('bugCategory');
    if (cat) cat.value = 'Launcher';
    const acc = document.getElementById('bugAccount');
    if (acc) acc.value = '';
    // Reset severity to Medium
    document.querySelectorAll('.bug-sev-btn').forEach(b => b.classList.remove('bug-sev-active'));
    const medBtn = document.querySelector('.bug-sev-btn[data-sev="Medium"]');
    if (medBtn) medBtn.classList.add('bug-sev-active');
  }

  // ─── Validation ──────────────────────────────────────────────────────────────
  function validateBugReport() {
    const summary     = document.getElementById('bugSummary')?.value.trim();
    const description = document.getElementById('bugDescription')?.value.trim();
    const repro       = document.getElementById('bugRepro')?.value.trim();

    if (!summary) {
      showToast('Please enter a summary.', 'error');
      document.getElementById('bugSummary').focus();
      return false;
    }
    if (!description) {
      showToast('Please enter a description.', 'error');
      document.getElementById('bugDescription').focus();
      return false;
    }
    if (!repro) {
      showToast('Please enter reproduction steps.', 'error');
      document.getElementById('bugRepro').focus();
      return false;
    }
    return true;
  }

  // ─── Submit: open an email draft AND a pre-filled GitHub issue ────────────────
  async function submitBugReport() {
    if (!validateBugReport()) return;

    const summary     = document.getElementById('bugSummary').value.trim();
    const category    = document.getElementById('bugCategory').value;
    const account     = document.getElementById('bugAccount').value || 'Not specified';
    const description = document.getElementById('bugDescription').value.trim();
    const repro       = document.getElementById('bugRepro').value.trim();
    const notes       = document.getElementById('bugNotes').value.trim() || 'N/A';
    const activeSev   = document.querySelector('.bug-sev-btn.bug-sev-active');
    const severity    = activeSev ? activeSev.dataset.sev : 'Medium';

    let appVersion = 'unknown';
    try {
      if (window.eveAPI && window.eveAPI.getAppVersion) {
        appVersion = await window.eveAPI.getAppVersion();
      }
    } catch (_) { /* non-Electron context — leave as 'unknown' */ }
    const timestamp   = new Date().toISOString();

    const subject = `[EVE Carbon Bug] [${severity}] [${category}] ${summary}`;

    const body = [
      '═══════════════════════════════════════════════',
      '  EVE CARBON — BUG REPORT',
      '═══════════════════════════════════════════════',
      '',
      `SUMMARY   : ${summary}`,
      `CATEGORY  : ${category}`,
      `SEVERITY  : ${severity}`,
      `ACCOUNT   : ${account}`,
      `TIMESTAMP : ${timestamp}`,
      `APP VER   : ${appVersion}`,
      '',
      '───────────────────────────────────────────────',
      'DESCRIPTION',
      '───────────────────────────────────────────────',
      description,
      '',
      '───────────────────────────────────────────────',
      'REPRODUCTION STEPS',
      '───────────────────────────────────────────────',
      repro,
      '',
      '───────────────────────────────────────────────',
      'ADDITIONAL NOTES',
      '───────────────────────────────────────────────',
      notes,
      '',
      ...(bugLogBlock() ? [
        '───────────────────────────────────────────────',
        'DIAGNOSTIC LOG (last lines, redacted)',
        '───────────────────────────────────────────────',
        bugLogBlock(),
        '',
      ] : []),
      '═══════════════════════════════════════════════',
    ].join('\n');

    // ── 1) Email draft via the OS default mail client ──────────────────────────
    const mailto = `mailto:bugs@vertexstudios.co.za`
      + `?subject=${encodeURIComponent(subject)}`
      + `&body=${encodeURIComponent(body)}`;
    const a = document.createElement('a');
    a.href = mailto;
    a.click();

    // ── 2) Pre-filled GitHub issue, opened in the default browser ───────────────
    // Markdown body so it renders cleanly in the issue. Opened via
    // shell.openExternal (open-external-url already whitelists https://).
    const issueBody = [
      `**Severity:** ${severity}`,
      `**Category:** ${category}`,
      `**Account:** ${account}`,
      `**App version:** ${appVersion}`,
      `**Timestamp:** ${timestamp}`,
      '',
      '### Description',
      description,
      '',
      '### Reproduction steps',
      repro,
      '',
      '### Additional notes',
      notes,
      ...(bugLogBlock() ? [
        '',
        '<details><summary>Diagnostic log (last lines, redacted)</summary>',
        '',
        '```',
        bugLogBlock(),
        '```',
        '</details>',
      ] : []),
    ].join('\n');

    let issueUrl = `https://github.com/${GITHUB_REPO}/issues/new`
      + `?title=${encodeURIComponent(subject)}`
      + `&labels=bug`
      + `&body=${encodeURIComponent(issueBody)}`;

    // A GitHub issue is created by navigating to a URL, and browsers give up
    // somewhere past ~8k characters — silently, by simply not opening. The log
    // is the expendable part, so it is dropped rather than losing the report the
    // user actually wrote, and they are told it happened.
    const URL_LIMIT = 7500;
    let logDropped = false;
    if (issueUrl.length > URL_LIMIT && bugLogBlock()) {
      const withoutLog = issueBody.slice(0, issueBody.indexOf('<details>')).trimEnd()
        + '\n\n_(Diagnostic log omitted — too long for a pre-filled issue. '
        + 'It is in the email draft, and on disk via Settings → General → Show log file.)_';
      issueUrl = `https://github.com/${GITHUB_REPO}/issues/new`
        + `?title=${encodeURIComponent(subject)}`
        + `&labels=bug`
        + `&body=${encodeURIComponent(withoutLog)}`;
      logDropped = true;
    }

    try {
      if (window.eveAPI && window.eveAPI.openExternalUrl) {
        await window.eveAPI.openExternalUrl(issueUrl);
      } else {
        window.open(issueUrl, '_blank');   // plain-browser fallback
      }
    } catch (_) { /* ignore — the email draft still opened */ }

    showToast(logDropped
      ? 'Opened an email draft and a GitHub issue — the log was too long for the issue, but it is in the email.'
      : 'Opened an email draft and a pre-filled GitHub issue.', 'success');
    logToConsole(`Bug report: mail client + GitHub issue (${GITHUB_REPO}).`, 'success');
    closeBugReport();
  }

  // ─── Bind Events (idempotent) ─────────────────────────────────────────────────
  let _bugEventsBound = false;
  function bindBugEvents() {
    if (_bugEventsBound) return;
    _bugEventsBound = true;

    // Close button
    document.addEventListener('click', (e) => {
      if (e.target.closest('#closeBugReportBtn')) closeBugReport();
    });

    // Reset button
    document.addEventListener('click', (e) => {
      if (e.target.closest('#resetBugReportBtn')) resetBugReport();
    });

    // Submit button
    document.addEventListener('click', (e) => {
      if (e.target.closest('#submitBugReportBtn')) submitBugReport();
    });

    // Backdrop click to close
    document.addEventListener('click', (e) => {
      const backdrop = document.getElementById('bugReportBackdrop');
      if (e.target === backdrop) closeBugReport();
    });

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const backdrop = document.getElementById('bugReportBackdrop');
        if (backdrop && backdrop.style.display !== 'none') closeBugReport();
      }
    });

    // Severity button toggle
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.bug-sev-btn');
      if (!btn) return;
      document.querySelectorAll('.bug-sev-btn').forEach(b => b.classList.remove('bug-sev-active'));
      btn.classList.add('bug-sev-active');
    });
  }

  // ─── Expose globally ──────────────────────────────────────────────────────────
  window.openBugReport  = openBugReport;
  window.closeBugReport = closeBugReport;

})();