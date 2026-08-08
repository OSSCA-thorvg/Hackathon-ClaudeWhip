/**
 * Shared E2E fixtures and helpers.
 *
 * Follow two principles and this game tests reliably:
 *
 * 1. **Observe through the `window.__claudewhip` handle.** The characters live inside the canvas
 *    so they're not in the DOM, and the simulation lives inside the worker. Instead of comparing
 *    pixels we look at the real state/events.
 *    (The DOM is used only to verify text — the connection bar and the session labels.)
 * 2. **No fixed sleeps.** The worker runs at 60Hz, rendering is on rAF, and the debug handle's
 *    state subscription coalesces at 50ms (main.ts). Everything waits on a condition via
 *    `waitForFunction` (rAF polling by default).
 *    **Movement alone, though, isn't served by polling** — the polling interval plus the IPC
 *    round trip turns directly into overshoot and lands outside the hit band (120px). Movement is
 *    driven from inside the page instead (`holdUntil` below).
 *
 * No coordinate or hit-detection number is invented here — slot coordinates are derived from the
 * running app's `stage.geometry()`, and the hit band from `assets/manifest.ts`.
 */
import { expect, test as base, type Page } from '@playwright/test';

import { CHARACTER_ASSETS } from '../../packages/client/src/assets/manifest.js';
import { hitBand as solveHitBand, type Band } from '../../packages/client/src/game/hitbox.js';
import { WHIP_STRIKE_OFFSET } from '../../packages/client/src/game/simulation.js';
import { startFakeBridge, type FakeBridge, type FakeBridgeInit } from './fake-bridge.js';
import type { ClaudeWhipDebugState } from './debug-handle.js';

/** Starts a new fake bridge. It is cleaned up automatically when the test ends */
export type BridgeFactory = (init?: FakeBridgeInit) => Promise<FakeBridge>;

interface Fixtures {
  /** A fake bridge already listening on an arbitrary port (starts with zero sessions) */
  bridge: FakeBridge;
  /** For scenarios that need to start and kill the bridge by hand (drop/recovery) */
  startBridge: BridgeFactory;
}

export const test = base.extend<Fixtures>({
  startBridge: async ({}, use) => {
    const started: FakeBridge[] = [];
    await use(async (init) => {
      const bridge = await startFakeBridge(init);
      started.push(bridge);
      return bridge;
    });
    for (const bridge of started) await bridge.close().catch(() => undefined);
  },

  bridge: async ({ startBridge }, use) => {
    await use(await startBridge());
  },
});

export { expect };

/* ── Booting / observing the app ────────────────────────────── */

/**
 * Opens the page and waits until the game is actually running.
 * The criterion is not "the handle exists" but **the first game_state_updated has arrived**
 * (player !== null) — before that the worker isn't attached yet, so sending input does nothing.
 */
export async function bootApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__claudewhip?.state().player != null, undefined, {
    timeout: 30_000,
  });
}

export function readState(page: Page): Promise<ClaudeWhipDebugState> {
  return page.evaluate(() => window.__claudewhip!.state());
}

/** The **same** slot coordinates the worker uses (the render layout is the single source, layout.ts) */
export function readGeometry(page: Page) {
  return page.evaluate(() => window.__claudewhip!.stage.geometry());
}

/** Recent events collected by the debug handle (optionally filtered by name) */
export function readLog(page: Page, name?: string) {
  return page.evaluate(
    (wanted) =>
      window.__claudewhip!.log.filter((entry) => wanted === undefined || entry.name === wanted),
    name,
  );
}

/** Clears the log — call it before asserting "no X happened after this point" */
export function clearLog(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.__claudewhip!.log.length = 0;
  });
}

/* ── The connection bar ─────────────────────────────────────── */

export function connectBar(page: Page) {
  return page.locator('.connect-bar');
}

/**
 * Connects exactly the way a user would: type the address and press the button (there is no
 * auto-connect). The button handler also blurs the input, so Space/arrow keys after
 * this go to the game (connect-ui.ts).
 */
export async function connectTo(page: Page, url: string): Promise<void> {
  await page.locator('.connect-bar__input').fill(url);
  await page.locator('.connect-bar__button').click();
  await expect(connectBar(page)).toHaveAttribute('data-state', 'connected');
}

/** Root element of a session label (the two-line shell prompt block) */
export function sessionLabel(page: Page, sessionId: string) {
  return page.locator(`.session-label[data-session-id="${sessionId}"]`);
}

/**
 * Waits until these sessions are standing as characters — until **both the renderer and the
 * simulation** reflect them.
 *
 * Membership flows in this order: [snapshot → stage sync (async Lottie load) → worker geometry
 * resend → game_state_updated]. Moving on after checking only the stage (`sessionIds`) makes the
 * very next line — which reads the worker state (`targets`) — one beat too early (an observed flake).
 */
export async function expectTargets(page: Page, sessionIds: readonly string[]): Promise<void> {
  await page.waitForFunction(
    (wanted) => {
      const state = window.__claudewhip?.state();
      if (!state) return false;
      const matches = (ids: string[]): boolean =>
        ids.length === wanted.length && wanted.every((id) => ids.includes(id));
      return matches(state.sessionIds) && matches(state.targets.map((t) => t.sessionId));
    },
    [...sessionIds],
    { timeout: 20_000 },
  );
}

/* ── Hit geometry (derived from production code) ─────────────── */

export type { Band };

/**
 * Slot center → **the range of player positions that land a hit** (world space). Neither the
 * formula nor the whip box is invented here — the inverse of hit detection is owned by
 * game/hitbox.ts, and the strike box offset by game/simulation.ts.
 * Re-measure the assets or change the detection rule and this band follows automatically.
 */
export function hitBand(slot: { centerX: number; centerY: number }): { x: Band; y: Band } {
  return solveHitBand(slot, WHIP_STRIKE_OFFSET, CHARACTER_ASSETS.target.bodyBox);
}

export function inBand(value: number, band: Band): boolean {
  return value >= band.min && value <= band.max;
}

/* ── Input ──────────────────────────────────────────────────── */

/** The arrival condition handed to the browser (a function wouldn't serialize, so it's described as data) */
interface Goal {
  axis: 'x' | 'y';
  /** 'atLeast' = the increasing direction (right/down), 'atMost' = the decreasing one */
  bound: 'atLeast' | 'atMost';
  value: number;
  /** Turns an unreachable goal (clamping, etc.) into a failure instead of an infinite wait */
  timeoutMs: number;
}

const GOAL_KEY: Record<'x' | 'y', Record<'atLeast' | 'atMost', string>> = {
  x: { atLeast: 'ArrowRight', atMost: 'ArrowLeft' },
  y: { atLeast: 'ArrowDown', atMost: 'ArrowUp' },
};

/**
 * Holds an arrow key down until the goal is reached, then releases it — **from inside the page**.
 *
 * ⚠️ Do not use the `page.keyboard.down` + `waitForFunction` + `page.keyboard.up` combination.
 * The state-subscription coalescing (50ms, main.ts) plus rAF polling plus the keyup IPC round trip
 * stacked up into a measured overshoot of up to 68px (≈230ms worth), and since the hit band is
 * 120px that flipped the verdict outright (it gets worse the busier the CPU is with parallel
 * workers — the kind of flake that has no upper bound).
 *
 * So movement alone subscribes to the bus **directly** inside the page (no coalescing) and fires
 * keyup on the very tick it arrives → overshoot shrinks to one tick (≈5px). The input path itself
 * is still exercised end to end: dispatching a KeyboardEvent on `window` goes through
 * input/keyboard.ts's listener, its held set, and the bus publish (an event fired directly at
 * window has window as its target, so it doesn't trip the text-input guard either). Real key
 * input as such is verified by offline.spec.ts via `page.keyboard`.
 */
async function holdUntil(page: Page, goal: Goal): Promise<void> {
  const key = GOAL_KEY[goal.axis][goal.bound];
  await page.evaluate(
    ([target, code]) =>
      new Promise<void>((resolve, reject) => {
        const debug = window.__claudewhip;
        if (!debug) {
          reject(new Error('debug handle missing'));
          return;
        }
        let timer = 0;
        const release = (): void => {
          window.dispatchEvent(new KeyboardEvent('keyup', { code }));
          clearTimeout(timer);
          unsubscribe();
        };
        const unsubscribe = debug.bus.subscribe('game_state_updated', (ev) => {
          const player = ev.payload.player;
          const value = target.axis === 'x' ? player.x : player.y;
          if (target.bound === 'atLeast' ? value >= target.value : value <= target.value) {
            release();
            resolve();
          }
        });
        timer = window.setTimeout(() => {
          release();
          reject(new Error(`player never reached ${target.axis} ${target.bound} ${target.value}`));
        }, target.timeoutMs);
        window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      }),
    [goal, key] as const,
  );
}

/** Moves the player's body center to the target world y (up/down never change facing) */
export async function movePlayerToY(page: Page, targetY: number): Promise<void> {
  const from = (await readState(page)).player?.y ?? 0;
  if (Math.abs(from - targetY) < 1) return;
  await holdUntil(page, {
    axis: 'y',
    bound: targetY > from ? 'atLeast' : 'atMost',
    value: targetY,
    timeoutMs: 20_000,
  });
}

/** Moves the player to at least the target world x (right = toward the target column) */
export async function movePlayerToX(page: Page, minX: number): Promise<void> {
  await holdUntil(page, { axis: 'x', bound: 'atLeast', value: minX, timeoutMs: 20_000 });
}

/** One whip crack. Returns once the swing has actually started (detection comes 14–19 ticks later) */
export async function swing(page: Page): Promise<void> {
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__claudewhip?.state().player?.swinging === true);
}

/** Until one swing (46 ticks ≈ 0.77s) finishes — meaning the crack detection window (ticks 14–19) has passed */
export async function waitForSwingToEnd(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__claudewhip?.state().player?.swinging === false, null, {
    timeout: 10_000,
  });
}
