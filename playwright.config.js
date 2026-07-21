// ─── playwright.config.js ─────────────────────────────────────────────────────
// Drives the real Electron app (see e2e/support/electron-app.js) — not a
// browser. No `use.browserName`/projects needed; each spec launches its own
// isolated app instance via the electronApp fixture.
// ─────────────────────────────────────────────────────────────────────────────

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,   // one Electron instance at a time — keeps CI resource use predictable
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
});
