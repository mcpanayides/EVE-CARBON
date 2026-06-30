// ─── donation.js — donation / feedback prompts ───────────────────────────────
// Gently nudges users to support the developer (Ms Moirai / Shadow State) and to
// send feedback. Two triggers, both opening the existing donate modal
// (window.openDonateModal):
//
//   1. After 30 minutes of use in a session (capped to once per day so it never
//      nags repeatedly across restarts).
//   2. On the 1st of each month, the first time the app is opened that month
//      (persistent — stays until the user closes it).
//
// State persists in localStorage; the recipient + in-game "Open" action live in
// the donate modal itself (see index.html → openDonateCharInGame).

const DONATION_USAGE_MS = 30 * 60 * 1000;   // 30 minutes
let   _donationUsageTimer = null;

function _dayKey(d = new Date())   { return d.toISOString().slice(0, 10); }            // YYYY-MM-DD
function _monthKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

function _showDonate(reason) {
  if (typeof window.openDonateModal === 'function') window.openDonateModal(reason);
}

function initDonationPrompts() {
  // ── 1) 30-minute usage prompt (max once per calendar day) ──────────────────
  try {
    if (localStorage.getItem('donationUsageShownDay') !== _dayKey()) {
      clearTimeout(_donationUsageTimer);
      _donationUsageTimer = setTimeout(() => {
        // Re-check the day in case the app was left running past midnight.
        if (localStorage.getItem('donationUsageShownDay') === _dayKey()) return;
        try { localStorage.setItem('donationUsageShownDay', _dayKey()); } catch (_) {}
        _showDonate('usage');
      }, DONATION_USAGE_MS);
    }
  } catch (_) {}

  // ── 2) Monthly prompt on the 1st, once per month ───────────────────────────
  try {
    const now = new Date();
    if (now.getDate() === 1) {
      const key = _monthKey(now);
      if (localStorage.getItem('donationMonthlyShown') !== key) {
        // Small delay so it doesn't fight the initial page render.
        setTimeout(() => {
          try { localStorage.setItem('donationMonthlyShown', key); } catch (_) {}
          _showDonate('monthly');
        }, 4000);
      }
    }
  } catch (_) {}
}
