/**
 * Scenario 4 — **the strike**. There is exactly one hit rule: "AABB overlap between the whip box
 * on the crack frame and the target's body box" (game/hitbox.ts).
 *
 * Not a single coordinate is written by hand:
 *   - Slot centers come from the running app's `stage.geometry()` (= the output of
 *     render/layout.ts, i.e. the values the worker receives)
 *   - The range of hitting positions is the band solved from whipStrikeBox/bodyBox in
 *     `assets/manifest.ts` (`hitBand` in fixtures/app.ts)
 * So re-measuring the assets or changing the slot pitch automatically moves this test to the new
 * values.
 *
 * ⚠️ Of all the traces a hit leaves, **only the event log is permanent.** The hit reaction (30f)
 * and the label inverse disappear after 0.5s, so catch them with rAF polling (waitForFunction),
 * or — for a DOM assertion like the label — start polling **before** the swing.
 */
import {
  bootApp,
  clearLog,
  connectTo,
  expect,
  expectTargets,
  hitBand,
  inBand,
  movePlayerToX,
  movePlayerToY,
  readGeometry,
  readLog,
  readState,
  sessionLabel,
  swing,
  test,
  waitForSwingToEnd,
} from './fixtures/app.js';
import { makeSession } from './fixtures/fake-bridge.js';

const SESSIONS = [
  makeSession({ sessionId: 'top', status: 'working' }),
  makeSession({ sessionId: 'below', status: 'idle' }),
];

test.beforeEach(async ({ page, bridge }) => {
  await bootApp(page);
  await connectTo(page, bridge.url);
  await bridge.waitForClient();
  bridge.setSessions(SESSIONS);
  await expectTargets(page, ['top', 'below']);
});

test('lands a hit when swinging at the target height', async ({ page }) => {
  const geometry = await readGeometry(page);
  const slot = geometry.slots.find((s) => s.sessionId === 'top');
  expect(slot).toBeDefined();
  const band = hitBand(slot!);

  // Move right to get in range, then up to the slot center height (the detection band)
  await movePlayerToX(page, band.x.min + 30);
  await movePlayerToY(page, slot!.centerY);

  const player = (await readState(page)).player!;
  expect(inBand(player.x, band.x), `x=${player.x} not in ${JSON.stringify(band.x)}`).toBe(true);
  expect(inBand(player.y, band.y), `y=${player.y} not in ${JSON.stringify(band.y)}`).toBe(true);

  await clearLog(page);
  // The label inverse is a transient state that only holds while hit plays — start polling in
  // advance so we don't miss the window
  const labelFlashed = expect(sessionLabel(page, 'top')).toHaveClass(/is-hit/);

  await swing(page);

  // 1) Detection happens inside the worker → verify it via the event
  await page.waitForFunction(() =>
    window.__claudewhip!.log.some(
      (entry) =>
        entry.name === 'target_hit' && (entry.payload as { sessionId: string }).sessionId === 'top',
    ),
  );
  // 2) It's reflected in the simulation state too (a target mid-reaction is excluded from the
  //    next detection pass). The neighboring slot isn't caught up in it — slot pitch 288px vs a
  //    strike box only 57px tall
  await page.waitForFunction(() => {
    const targets = window.__claudewhip?.state().targets ?? [];
    return (
      targets.find((t) => t.sessionId === 'top')?.hitReacting === true &&
      targets.find((t) => t.sessionId === 'below')?.hitReacting === false
    );
  });
  // 3) The animation: the sprite switches to the hit marker (inside the canvas, so invisible to the DOM)
  await page.waitForFunction(
    () => window.__claudewhip?.state().render.targetMarkers['top'] === 'hit',
  );
  await labelFlashed;

  await waitForSwingToEnd(page);
  const hits = await readLog(page, 'target_hit');
  // One swing = one detection pass (once, on the tick that enters the crack window)
  expect(hits.map((h) => (h.payload as { sessionId: string }).sessionId)).toEqual(['top']);
});

test('hits nobody when swinging between targets', async ({ page }) => {
  const geometry = await readGeometry(page);
  const top = geometry.slots.find((s) => s.sessionId === 'top')!;
  const below = geometry.slots.find((s) => s.sessionId === 'below')!;
  // Exactly halfway between the two slot centers — a gap that falls in neither band
  const gapY = (top.centerY + below.centerY) / 2;

  await movePlayerToX(page, hitBand(top).x.min + 30);
  await movePlayerToY(page, gapY);

  const player = (await readState(page)).player!;
  // Pins down that the miss is caused by the vertical offset — horizontally we're still in range
  expect(inBand(player.x, hitBand(top).x)).toBe(true);
  expect(inBand(player.y, hitBand(top).y)).toBe(false);
  expect(inBand(player.y, hitBand(below).y)).toBe(false);

  await clearLog(page);
  await swing(page);
  await waitForSwingToEnd(page);

  expect(await readLog(page, 'target_hit')).toEqual([]);
  const state = await readState(page);
  expect(state.targets.every((t) => !t.hitReacting)).toBe(true);
});
