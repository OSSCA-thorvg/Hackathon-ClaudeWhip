/**
 * Scenario 1 — **booting without a server**.
 *
 * This game has to open from static hosting (GitHub Pages): with no bridge server the page still
 * comes up, there are zero targets, and the player still moves and cracks the whip in that state.
 * There's no auto-connect either — the top bar must stay `disconnected`.
 */
import { BRIDGE_PORT } from '../packages/shared/src/index.js';
import { bootApp, expect, readState, swing, test, waitForSwingToEnd } from './fixtures/app.js';

test.describe('without a server', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  test('boots with zero targets and does not auto-connect', async ({ page }) => {
    const state = await readState(page);

    expect(state.sessionIds).toEqual([]);
    expect(state.targets).toEqual([]);
    expect(state.render.visibleTargets).toBe(0);
    // The player exists regardless of the server
    expect(state.player).not.toBeNull();
    expect(state.player?.facing).toBe('right');

    // The user is the one who initiates the connection
    await expect(page.locator('.connect-bar')).toHaveAttribute('data-state', 'disconnected');
    await expect(page.locator('.connect-bar__text')).toHaveText('[disconnected]');
    // The default address comes from shared's BRIDGE_PORT — it isn't hardcoded in the HTML
    await expect(page.locator('.connect-bar__input')).toHaveValue(
      `ws://localhost:${BRIDGE_PORT}`,
    );
  });

  test('arrow key input changes the player coordinates', async ({ page }) => {
    const before = (await readState(page)).player!;

    await page.keyboard.down('ArrowRight');
    await page.waitForFunction(
      (startX) => (window.__claudewhip?.state().player?.x ?? 0) > startX + 20,
      before.x,
    );
    await page.keyboard.up('ArrowRight');

    const afterRight = (await readState(page)).player!;
    expect(afterRight.x).toBeGreaterThan(before.x);
    expect(afterRight.facing).toBe('right');

    await page.keyboard.down('ArrowUp');
    await page.waitForFunction(
      (startY) => (window.__claudewhip?.state().player?.y ?? 0) < startY - 20,
      afterRight.y,
    );
    await page.keyboard.up('ArrowUp');

    const afterUp = (await readState(page)).player!;
    expect(afterUp.y).toBeLessThan(afterRight.y);
    // Up/down input never changes the sprite flip
    expect(afterUp.facing).toBe('right');

    // Releasing the key stops it (the movement input is exactly what justifies the walk loop)
    await page.waitForFunction(() => window.__claudewhip?.state().player?.moving === false);
  });

  test('swinging works even with no targets', async ({ page }) => {
    await swing(page);

    // It all happens inside the canvas, so the DOM can't show it — check the playing marker instead
    await page.waitForFunction(() => window.__claudewhip?.state().render.playerMarker === 'swing');

    // One swing plays to the end and finishes on its own (46 ticks)
    await waitForSwingToEnd(page);
  });
});
