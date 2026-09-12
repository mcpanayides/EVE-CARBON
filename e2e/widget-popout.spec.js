// Popped-out widget windows, and nano mode.
//
// Nano collapses a popout to its own title bar so it can be parked over the
// game. Half of that is CSS the renderer owns, but the half that can only be
// checked for real is the WINDOW: a popout is created with minHeight 160, so
// hiding the content in the page still left a box far taller than the bar it
// was now showing. Nano has to lower that floor, pin the height while it is
// collapsed, and put the window back exactly where it was on the way out.
//
// None of that is reachable from a unit test — it is Electron window state — so
// it is driven here through the real IPC the button calls.
const { test, expect } = require('./support/electron-app');

const ID = 'beehive';

/** Bounds and size limits of the popout, read from the main process. */
async function popoutState(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()
      .find(w => !w.isDestroyed() && /BEEHIVE/i.test(w.getTitle()));
    if (!win) return null;
    return {
      bounds: win.getBounds(),
      min:    win.getMinimumSize(),
      max:    win.getMaximumSize(),
    };
  });
}

test('nano mode collapses a popout to its bar and restores it exactly', async ({ window, electronApp }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });

  await window.evaluate(() => window.eveAPI.widgetPopoutOpen({
    id: 'beehive', title: 'BEEHIVE STATUS', w: 280, h: 200,
  }));

  // The window is created asynchronously; wait for main to actually have it.
  await expect.poll(async () => (await popoutState(electronApp)) !== null,
                    { timeout: 10_000 }).toBe(true);

  const before = await popoutState(electronApp);
  expect(before.min[1]).toBe(160);          // the floor that made this necessary
  expect(before.bounds.height).toBeGreaterThan(100);

  // ── collapse ──────────────────────────────────────────────────────────────
  await window.evaluate(() => window.eveAPI.widgetPopoutNano({
    id: 'beehive', nano: true, barHeight: 32,
  }));
  await expect.poll(async () => (await popoutState(electronApp)).bounds.height,
                    { timeout: 5_000 }).toBeLessThan(before.bounds.height);

  const nano = await popoutState(electronApp);
  // Roughly the bar, allowing for the resize border on a frameless window —
  // the handler adds that delta itself rather than assuming it is zero.
  expect(nano.bounds.height).toBeLessThanOrEqual(60);
  // Height is pinned: with the content hidden there is nothing for a stray
  // drag to reveal except a band of empty glass.
  expect(nano.min[1]).toBe(nano.bounds.height);
  expect(nano.max[1]).toBe(nano.bounds.height);
  // ...but width stays free, so the bar can be widened or tucked away.
  expect(nano.max[0]).toBeGreaterThan(nano.bounds.width);
  // It collapses in place rather than jumping to a corner.
  expect(nano.bounds.x).toBe(before.bounds.x);
  expect(nano.bounds.y).toBe(before.bounds.y);

  // ── expand ────────────────────────────────────────────────────────────────
  await window.evaluate(() => window.eveAPI.widgetPopoutNano({ id: 'beehive', nano: false }));
  await expect.poll(async () => (await popoutState(electronApp)).bounds.height,
                    { timeout: 5_000 }).toBe(before.bounds.height);

  const after = await popoutState(electronApp);
  // Leaving nano is undo, not "somewhere near the default size".
  expect(after.bounds).toEqual(before.bounds);
  expect(after.min).toEqual(before.min);
  expect(after.max[1]).toBe(0);             // 0 = limit cleared

  await window.evaluate(() => window.eveAPI.widgetPopoutClose('beehive'));
});

test('nano on a popout that has gone away does not throw', async ({ window }) => {
  // The button lives in the popout, but the channel is reachable from anywhere,
  // and a window can be closed between a click and the IPC landing.
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });
  const res = await window.evaluate(() => window.eveAPI.widgetPopoutNano({
    id: 'no-such-widget', nano: true, barHeight: 32,
  }));
  expect(res.success).toBe(false);
});
