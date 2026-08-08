/**
 * Scenario 5 — **drop / recovery**.
 *
 * One character = one session that is alive right now, so once the bridge dies any character left
 * on screen is a lie — the adapter publishes an **empty snapshot** to send them all off
 * (ws-adapter.ts). And since the user didn't disconnect, backoff retries keep running
 * (0.5s → up to 8s).
 *
 * That's why this test alone is so slow. We still wait on conditions rather than fixed sleeps,
 * just with generous timeouts.
 */
import {
  bootApp,
  clearLog,
  connectBar,
  connectTo,
  expect,
  expectTargets,
  readLog,
  test,
} from './fixtures/app.js';
import { makeSession } from './fixtures/fake-bridge.js';

const SESSIONS = [
  makeSession({ sessionId: 'one', status: 'working' }),
  makeSession({ sessionId: 'two', status: 'idle' }),
];

test('characters disappear when the bridge dies and come back when it revives', async ({ page, startBridge }) => {
  // This test alone is unusually slow — the reconnect backoff stretches to 8s (the others use the
  // default 30s)
  test.setTimeout(90_000);
  const bridge = await startBridge({ sessions: SESSIONS });
  await bootApp(page);
  await connectTo(page, bridge.url);
  await expectTargets(page, ['one', 'two']);

  // ── Kill it ───────────────────────────────────────────────
  const port = bridge.port;
  await bridge.close();

  // No stale characters are left behind (the empty snapshot)
  await expectTargets(page, []);
  await expect(page.locator('.session-label')).toHaveCount(0);

  // The user didn't disconnect, so retries keep running — the state oscillates connecting ↔ error
  await page.waitForFunction(
    () =>
      window.__claudewhip!.log.some(
        (entry) =>
          entry.name === 'server_connection_changed' &&
          (entry.payload as { state: string }).state === 'connecting',
      ),
    null,
    { timeout: 20_000 },
  );
  const states = (await readLog(page, 'server_connection_changed')).map(
    (entry) => (entry.payload as { state: string }).state,
  );
  // This is an established connection dropping, not a bad address (ws-adapter's `opened` distinction)
  expect(states).toContain('disconnected');

  // ── Revive it on the same port ───────────────────────────
  const revived = await startBridge({ port, sessions: SESSIONS });

  // The backoff can stretch to as much as 8 seconds
  await expect(connectBar(page)).toHaveAttribute('data-state', 'connected', { timeout: 40_000 });
  // The revived bridge also sends a snapshot immediately on connect → the characters come right back
  await expectTargets(page, ['one', 'two']);
  expect(revived.clientCount()).toBe(1);
});

test('characters disappear and no retry happens when the user disconnects', async ({ page, bridge }) => {
  await bootApp(page);
  await connectTo(page, bridge.url);
  bridge.setSessions(SESSIONS);
  await expectTargets(page, ['one', 'two']);

  await page.locator('.connect-bar__button').click();

  await expect(connectBar(page)).toHaveAttribute('data-state', 'disconnected');
  await expectTargets(page, []);

  // This is a **proof of absence** — that no retry happens — so waiting out a window is
  // unavoidable. The backoff floor is 0.5s, so within 1s a live retry would certainly leave a
  // trace (connecting/error). Looking at the state attribute alone would miss a round trip that
  // came back, so we assert that no event occurred at all in between.
  await clearLog(page);
  await page.waitForTimeout(1_000);
  expect(await readLog(page, 'server_connection_changed')).toEqual([]);
  await expect(connectBar(page)).toHaveAttribute('data-state', 'disconnected');
  expect(bridge.clientCount()).toBe(0);
});
