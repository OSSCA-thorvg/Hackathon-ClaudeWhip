/**
 * Camera tests — dead-zone following is pure math, so we just run it.
 * Dead zone 25%–75%, exponential decay τ=90ms, exposed value is an integer.
 */
import { describe, expect, it } from 'vitest';

import { Camera, DEAD_ZONE_BOTTOM_RATIO, DEAD_ZONE_TOP_RATIO } from './camera.js';

const VIEWPORT = 800;
const DEAD_ZONE_TOP = VIEWPORT * DEAD_ZONE_TOP_RATIO; // 200
const DEAD_ZONE_BOTTOM = VIEWPORT * DEAD_ZONE_BOTTOM_RATIO; // 600
const FRAME_MS = 16;

/** Run frames until it converges (up to a generously chosen cap) */
function settle(camera: Camera, playerY: number, worldHeight: number): void {
  for (let i = 0; i < 400; i += 1) camera.update(playerY, VIEWPORT, worldHeight, FRAME_MS);
}

describe('initial state', () => {
  it('starts at 0', () => {
    const camera = new Camera();
    expect(camera.y).toBe(0);
    expect(camera.toScreenY(123)).toBe(123);
  });
});

describe('dead zone', () => {
  it('does not move the camera while inside the band', () => {
    const camera = new Camera();
    for (const y of [DEAD_ZONE_TOP, 300, 400, 500, DEAD_ZONE_BOTTOM]) {
      expect(camera.update(y, VIEWPORT, 4000, FRAME_MS)).toBe(false);
      expect(camera.y).toBe(0);
    }
  });

  it('follows once the player leaves the band downwards', () => {
    const camera = new Camera();
    expect(camera.update(DEAD_ZONE_BOTTOM + 100, VIEWPORT, 4000, FRAME_MS)).toBe(true);
    expect(camera.y).toBeGreaterThan(0);
  });

  it('parks the player on the band edge once it has caught up', () => {
    const camera = new Camera();
    const playerY = 1500;
    settle(camera, playerY, 4000);
    // The player left downwards, so the target is "screen y at the bottom band edge"
    expect(camera.y).toBe(playerY - DEAD_ZONE_BOTTOM);
    expect(camera.toScreenY(playerY)).toBe(DEAD_ZONE_BOTTOM);
  });

  it('parks on the top edge when the player leaves the band upwards', () => {
    const camera = new Camera();
    settle(camera, 2000, 4000);
    settle(camera, 1000, 4000);
    expect(camera.y).toBe(1000 - DEAD_ZONE_TOP);
    expect(camera.toScreenY(1000)).toBe(DEAD_ZONE_TOP);
  });

  it('stays still while the player moves inside the band after converging', () => {
    const camera = new Camera();
    settle(camera, 1500, 4000);
    const parked = camera.y; // screen y = bottom band edge
    expect(camera.toScreenY(1500)).toBe(DEAD_ZONE_BOTTOM);

    // While travelling back up to the top edge (band width 400px) the camera never moves
    for (let y = 1500; y >= 1500 - (DEAD_ZONE_BOTTOM - DEAD_ZONE_TOP); y -= 10) {
      expect(camera.update(y, VIEWPORT, 4000, FRAME_MS), `y=${y}`).toBe(false);
    }
    expect(camera.y).toBe(parked);

    // One more step up and it starts following
    expect(camera.update(1500 - (DEAD_ZONE_BOTTOM - DEAD_ZONE_TOP) - 20, VIEWPORT, 4000, FRAME_MS)).toBe(
      true,
    );
  });
});

describe('world boundary clamping', () => {
  it('never scrolls when the world is shorter than the viewport', () => {
    const camera = new Camera();
    settle(camera, 5000, VIEWPORT - 200);
    expect(camera.y).toBe(0);
  });

  it('does not scroll past the end of the world', () => {
    const camera = new Camera();
    const worldHeight = 2000;
    settle(camera, 9999, worldHeight);
    expect(camera.y).toBe(worldHeight - VIEWPORT); // 1200
  });

  it('does not scroll above 0', () => {
    const camera = new Camera();
    settle(camera, -500, 4000);
    expect(camera.y).toBe(0);
  });

  it('returns into range immediately when the world shrinks', () => {
    const camera = new Camera();
    settle(camera, 3500, 4000);
    expect(camera.y).toBeGreaterThan(1000);

    camera.update(3500, VIEWPORT, 1200, FRAME_MS);
    expect(camera.y).toBe(1200 - VIEWPORT);
  });
});

describe('decay and return value', () => {
  it('does not reach the target in a single frame (exponential decay)', () => {
    const camera = new Camera();
    camera.update(1500, VIEWPORT, 4000, FRAME_MS);
    expect(camera.y).toBeGreaterThan(0);
    expect(camera.y).toBeLessThan(1500 - DEAD_ZONE_BOTTOM);
  });

  it('follows further when dt is larger (framerate independent)', () => {
    const slow = new Camera();
    const fast = new Camera();
    slow.update(1500, VIEWPORT, 4000, 8);
    fast.update(1500, VIEWPORT, 4000, 32);
    expect(fast.y).toBeGreaterThan(slow.y);
  });

  it('is safe with a negative or zero dt', () => {
    const camera = new Camera();
    expect(camera.update(1500, VIEWPORT, 4000, -100)).toBe(false);
    expect(camera.y).toBe(0);
  });

  it('returns true only on frames where the exposed value changed', () => {
    const camera = new Camera();
    settle(camera, 1500, 4000);
    expect(camera.update(1500, VIEWPORT, 4000, FRAME_MS)).toBe(false);
  });

  it('always exposes an integer', () => {
    const camera = new Camera();
    for (let i = 0; i < 30; i += 1) {
      camera.update(1234.56, VIEWPORT, 4000, FRAME_MS);
      expect(Number.isInteger(camera.y)).toBe(true);
    }
  });
});

describe('visibleRange', () => {
  it('is the viewport range around the current offset plus the margin', () => {
    const camera = new Camera();
    expect(camera.visibleRange(VIEWPORT, 100)).toEqual({ top: -100, bottom: VIEWPORT + 100 });
  });

  it('moves the range down together with the camera', () => {
    const camera = new Camera();
    settle(camera, 1500, 4000);
    const offset = camera.y;
    expect(camera.visibleRange(VIEWPORT, 0)).toEqual({
      top: offset,
      bottom: offset + VIEWPORT,
    });
  });
});
