/**
 * Scenarios 2 and 3 — **manual connect → pop-in**, and **membership changes**.
 *
 * The only path that changes session membership is the `session_snapshot` comparison (CLAUDE.md).
 * The fake bridge also sends started/ended just like the real server, so if the client ever started
 * changing membership from those two as well, it's performance (duplicate syncing) that would
 * degrade first rather than this test — what's verified here is that "exactly the sessions in the
 * snapshot, and no others, are standing".
 */
import {
  bootApp,
  connectTo,
  expect,
  expectTargets,
  readLog,
  readState,
  sessionLabel,
  test,
} from './fixtures/app.js';
import { makeSession } from './fixtures/fake-bridge.js';

const ALPHA = makeSession({ sessionId: 'alpha', gitBranch: 'main', status: 'working' });
const BRAVO = makeSession({ sessionId: 'bravo', status: 'idle' });
const CHARLIE = makeSession({ sessionId: 'charlie', gitBranch: 'feat/x', status: 'working' });

test('stands up one character per session once a snapshot arrives after a manual connect', async ({ page, bridge }) => {
  await bootApp(page);

  // connectTo returns only after confirming data-state=connected (fixtures/app.ts)
  await connectTo(page, bridge.url);
  await expect(page.locator('.connect-bar__text')).toHaveText('[connected]');
  await bridge.waitForClient();
  // Connecting alone stands nobody up (the bridge's initial session list is empty)
  await expectTargets(page, []);

  bridge.setSessions([ALPHA, BRAVO, CHARLIE]);
  await expectTargets(page, ['alpha', 'bravo', 'charlie']);

  // expectTargets already checked membership on both the render and worker sides — here we only
  // look at the slot assignment
  const state = await readState(page);
  expect(state.targets.map((t) => t.slot).sort()).toEqual([0, 1, 2]);

  // The label = a two-line shell prompt block (`~/Documents/alpha main` / `❯ claude █`)
  const alpha = sessionLabel(page, 'alpha');
  await expect(alpha).toBeVisible();
  await expect(alpha.locator('.session-label__dir')).toHaveText('alpha');
  await expect(alpha.locator('.session-label__path')).toContainText('~/Documents/');
  await expect(alpha.locator('.session-label__branch')).toHaveText('main');
  await expect(alpha.locator('.session-label__prompt')).toHaveText('❯');
  await expect(alpha.locator('.session-label__cmd')).toHaveText('claude');
  // When working, the block cursor is visible (when idle it's display:none — styles.css)
  await expect(alpha).toHaveAttribute('data-status', 'working');
  await expect(alpha.locator('.session-label__cursor')).toBeVisible();

  const bravo = sessionLabel(page, 'bravo');
  await expect(bravo).toHaveAttribute('data-status', 'idle');
  await expect(bravo.locator('.session-label__cursor')).toBeHidden();
  // A session without a branch collapses that fragment entirely (so the flex gap doesn't leave a hole)
  await expect(bravo.locator('.session-label__branch')).toBeHidden();

  // The characters also run different loops depending on the session status
  await page.waitForFunction(() => {
    const markers = window.__claudewhip?.state().render.targetMarkers ?? {};
    return markers['alpha'] === 'working' && markers['bravo'] === 'idle';
  });
});

test('characters appear and disappear as the snapshot changes', async ({ page, bridge }) => {
  await bootApp(page);
  await connectTo(page, bridge.url);
  await bridge.waitForClient();

  bridge.setSessions([ALPHA, BRAVO]);
  await expectTargets(page, ['alpha', 'bravo']);

  // Addition — existing characters keep their slots and the new session is appended (stage.syncSessions)
  bridge.setSessions([ALPHA, BRAVO, CHARLIE]);
  await expectTargets(page, ['alpha', 'bravo', 'charlie']);
  expect((await readState(page)).sessionIds).toEqual(['alpha', 'bravo', 'charlie']);

  // Even when a removal and an addition happen at once, one snapshot comparison sorts it out
  bridge.setSessions([BRAVO, CHARLIE]);
  await expectTargets(page, ['bravo', 'charlie']);
  await expect(sessionLabel(page, 'alpha')).toHaveCount(0);

  // When they all disappear it goes back to zero (the player remains)
  bridge.setSessions([]);
  await expectTargets(page, []);
  expect((await readState(page)).player).not.toBeNull();
  // Even the exit animation gets reclaimed — anything left here is a node leak (a CLAUDE.md pitfall)
  await page.waitForFunction(() => window.__claudewhip?.state().render.exitingTargets === 0);

  // The signals the server sent did flow per the contract (they just don't change membership — they
  // don't vanish)
  const names = (await readLog(page)).map((entry) => entry.name);
  expect(names).toContain('session_started');
  expect(names).toContain('session_ended');
});
