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
//
// Neither prompt shows during the guided tour (func/tutorial.js), which is
// someone setting the app up: the modal would bury the card they are reading,
// and the tour's dimming would cover its close button. A prompt that falls due
// while a tour runs, or while a first launch is still deciding whether to open
// one, is held, then shown a few minutes after the tour ends. Its "shown" key is
// written only when it really shows, so one still held when the app closes is
// due again next time.

const DONATION_USAGE_MS      = 30 * 60 * 1000;  // 30 minutes
const DONATION_AFTER_TOUR_MS =  3 * 60 * 1000;  // a held prompt waits this long after the tour
let   _donationUsageTimer   = null;
let   _donationHeld         = null;             // { reason, markShown } held for the tour
let   _donationReleaseTimer = null;

function _dayKey(d = new Date())   { return d.toISOString().slice(0, 10); }            // YYYY-MM-DD
function _monthKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

function _donationTourBusy() {
  return typeof tutorialBusy === 'function' && tutorialBusy();
}

function _showDonate(reason, markShown) {
  if (_donationTourBusy()) {
    // One held at a time. Another that falls due meanwhile is dropped without
    // being marked shown, so it comes round again on its own schedule.
    if (!_donationHeld) _donationHeld = { reason, markShown };
    return;
  }
  if (typeof window.openDonateModal !== 'function') return;
  try { markShown?.(); } catch (_) {}
  window.openDonateModal(reason);
}

// Sent by the tour once nothing is left running (not between the basics and
// alliance tools, which count as one go). The wait means the first thing after
// the last card is the app, not a request for ISK.
document.addEventListener('tutorial-idle', () => {
  if (!_donationHeld) return;
  clearTimeout(_donationReleaseTimer);
  _donationReleaseTimer = setTimeout(() => {
    const held = _donationHeld;
    if (!held || _donationTourBusy()) return;  // another tour began; its end sends this again
    _donationHeld = null;
    _showDonate(held.reason, held.markShown);
  }, DONATION_AFTER_TOUR_MS);
});

function initDonationPrompts() {
  // Not under the e2e harness. Both prompts are gated on localStorage keys, and
  // every test run gets a brand-new profile, so the monthly prompt fires on the
  // 1st of EVERY month and its modal backdrop then swallows clicks for the rest
  // of the suite. That is a hard release gate failing one calendar day in thirty,
  // with a "target closed" timeout that points nowhere near the cause.
  // Nor in demo mode, which exists to be recorded: the 30-minute prompt would
  // land in the middle of a take, and a fresh demo profile opens on the monthly one.
  if (window.eveAPI?.isAutomated || window.eveAPI?.isDemo) return;

  // ── 1) 30-minute usage prompt (max once per calendar day) ──────────────────
  try {
    if (localStorage.getItem('donationUsageShownDay') !== _dayKey()) {
      clearTimeout(_donationUsageTimer);
      _donationUsageTimer = setTimeout(() => {
        // Re-check the day in case the app was left running past midnight.
        if (localStorage.getItem('donationUsageShownDay') === _dayKey()) return;
        _showDonate('usage', () => localStorage.setItem('donationUsageShownDay', _dayKey()));
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
          _showDonate('monthly', () => localStorage.setItem('donationMonthlyShown', key));
        }, 4000);
      }
    }
  } catch (_) {}
}
