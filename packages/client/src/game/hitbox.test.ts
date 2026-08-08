/**
 * Hit-detection regression tests — "you only connect when the whip actually reaches": the
 * boundaries of the analytic hit band, zero hits in the gap between targets (the miss gap), and
 * every body the box straddles getting hit.
 *
 * ⚠️ The hit geometry **comes from the assets** — do not copy the numbers here, derive them
 * from the manifest.
 * (For the v1 assets the band was `[cy−44, cy+65]`. With the v2 assets the same formula gives
 *  `[cy−41.5, cy+78.5]` — the formula is what is under regression, not the numbers.)
 */
import { describe, expect, it } from 'vitest';

import { CHARACTER_ASSETS } from '../assets/manifest.js';
import { SLOT_STEP } from '../render/layout.js';
import { hitBand as solveHitBand, pickHitTargets, type HitCandidate } from './hitbox.js';
import { WHIP_STRIKE_OFFSET as WHIP_OFFSET } from './simulation.js';

const { target } = CHARACTER_ASSETS;

const BODY = target.bodyBox;

/**
 * The analytic hit band — the range of player.y in which the whip box and the body slab
 * overlap vertically.
 * Uses the production inverse (`hitbox.hitBand`) directly — writing the formula out again
 * here would let the tests keep passing with the old equation even after hit detection changes.
 */
function hitBand(centerY: number): { top: number; bottom: number } {
  const { y } = solveHitBand({ centerX: 0, centerY }, WHIP_OFFSET, BODY);
  return { top: y.min, bottom: y.max };
}

/** Places the target at a distance that definitely connects horizontally (so the band only
 * exercises the vertical condition) */
function targetAt(sessionId: string, centerY: number, playerX: number, hitTick = -1): HitCandidate {
  return { sessionId, slot: 0, centerX: playerX + 200, centerY, hitTick };
}

const PLAYER_X = 400;

function swingAt(y: number, targets: readonly HitCandidate[], facing: 'left' | 'right' = 'right') {
  return pickHitTargets({ x: PLAYER_X, y, facing }, targets, WHIP_OFFSET, BODY);
}

describe('pickHitTargets — vertical hit band', () => {
  const CENTER_Y = 500;
  const band = hitBand(CENTER_Y);
  const one = [targetAt('s1', CENTER_Y, PLAYER_X)];

  it('the band matches the value derived from the manifest (v2: [cy−41.5, cy+78.5])', () => {
    expect(band).toEqual({ top: CENTER_Y - 41.5, bottom: CENTER_Y + 78.5 });
  });

  it('connects when standing right in front of the target', () => {
    expect(swingAt(CENTER_Y, one)).toEqual(['s1']);
  });

  it('the band boundaries are hits (touching edges = overlap)', () => {
    expect(swingAt(band.top, one)).toEqual(['s1']);
    expect(swingAt(band.bottom, one)).toEqual(['s1']);
  });

  it('outside the band is a miss', () => {
    expect(swingAt(band.top - 0.5, one)).toEqual([]);
    expect(swingAt(band.bottom + 0.5, one)).toEqual([]);
  });

  it('sweeping through the band in 1px steps hits every time, and stepping outside misses every time', () => {
    for (let y = Math.ceil(band.top); y <= Math.floor(band.bottom); y += 1) {
      expect(swingAt(y, one), `y=${y}`).toEqual(['s1']);
    }
    for (let y = Math.floor(band.top) - 40; y < band.top; y += 1) {
      expect(swingAt(y, one), `y=${y}`).toEqual([]);
    }
    for (let y = Math.ceil(band.bottom) + 1; y < band.bottom + 40; y += 1) {
      expect(swingAt(y, one), `y=${y}`).toEqual([]);
    }
  });
});

describe('pickHitTargets — horizontal reach', () => {
  const CENTER_Y = 500;
  /** Reach is nothing more than the width of the asset box: the interval you get by solving
   * cx − (px + dx0) ≥ … for px */
  const near = BODY.halfW; // 63

  /** Keeps the vertical position at a height that definitely connects (head-on) and only
   * moves horizontally */
  function at(centerX: number, sessionId = 's1'): HitCandidate {
    return { sessionId, slot: 0, centerX, centerY: CENTER_Y, hitTick: -1 };
  }

  it('misses when too close (the body is nearer than the whip box inner edge)', () => {
    expect(swingAt(CENTER_Y, [at(PLAYER_X + WHIP_OFFSET.x0 - near - 1)])).toEqual([]);
  });

  it('misses past the end of the reach', () => {
    expect(swingAt(CENTER_Y, [at(PLAYER_X + WHIP_OFFSET.x1 + near + 1)])).toEqual([]);
  });

  it('connects exactly on the horizontal boundaries', () => {
    expect(swingAt(CENTER_Y, [at(PLAYER_X + WHIP_OFFSET.x0 - near, 'near')])).toEqual(['near']);
    expect(swingAt(CENTER_Y, [at(PLAYER_X + WHIP_OFFSET.x1 + near, 'far')])).toEqual(['far']);
  });
});

describe('pickHitTargets — miss gap ("zero hits at heights between targets")', () => {
  /** The real slot pitch (owned by render/layout.ts: 48 label band + 240 sprite = 288) */
  const SLOT_PITCH = SLOT_STEP;
  const first = 300;
  const targets = [
    targetAt('a', first, PLAYER_X),
    { ...targetAt('b', first + SLOT_PITCH, PLAYER_X), slot: 1 },
  ];

  it('nobody gets hit at any height between the two targets', () => {
    const gapTop = hitBand(first).bottom;
    const gapBottom = hitBand(first + SLOT_PITCH).top;
    expect(gapBottom - gapTop).toBeGreaterThan(100); // the actual gap is 168px
    for (let y = Math.ceil(gapTop) + 1; y < gapBottom; y += 1) {
      expect(swingAt(y, targets), `y=${y}`).toEqual([]);
    }
  });

  it('a simultaneous double hit is geometrically impossible at the current pitch', () => {
    for (let y = first - 200; y < first + SLOT_PITCH + 200; y += 1) {
      expect(swingAt(y, targets).length, `y=${y}`).toBeLessThanOrEqual(1);
    }
  });
});

describe('pickHitTargets — multiple hits', () => {
  it('when the box straddles two bodies, both get hit (when the pitch is narrower than the band)', () => {
    // The band is 120px tall — with a pitch of 100 the two bands overlap
    const targets = [
      targetAt('a', 300, PLAYER_X),
      { ...targetAt('b', 400, PLAYER_X), slot: 1 },
    ];
    const overlapTop = hitBand(400).top; // 358.5
    const overlapBottom = hitBand(300).bottom; // 378.5
    expect(overlapBottom).toBeGreaterThan(overlapTop);

    const y = (overlapTop + overlapBottom) / 2;
    expect(swingAt(y, targets)).toEqual(['a', 'b']);
  });

  it('returns them in slot (input) order', () => {
    const targets = [
      { ...targetAt('b', 400, PLAYER_X), slot: 1 },
      targetAt('a', 300, PLAYER_X),
    ];
    expect(swingAt(370, targets)).toEqual(['b', 'a']);
  });
});

describe('pickHitTargets — exclusion rules', () => {
  const CENTER_Y = 500;

  it('targets in a hit reaction are excluded (hitTick 0 still counts as in a reaction)', () => {
    expect(swingAt(CENTER_Y, [targetAt('s1', CENTER_Y, PLAYER_X, 30)])).toEqual([]);
    expect(swingAt(CENTER_Y, [targetAt('s1', CENTER_Y, PLAYER_X, 0)])).toEqual([]);
    expect(swingAt(CENTER_Y, [targetAt('s1', CENTER_Y, PLAYER_X, -1)])).toEqual(['s1']);
  });

  it('excludes only the target in a reaction and resolves the rest normally', () => {
    const targets = [
      targetAt('reacting', 370, PLAYER_X, 5),
      { ...targetAt('fresh', 370, PLAYER_X), slot: 1 },
    ];
    expect(swingAt(370, targets)).toEqual(['fresh']);
  });

  it('facing left, nobody can be hit (the whip goes out away from the target column)', () => {
    expect(swingAt(CENTER_Y, [targetAt('s1', CENTER_Y, PLAYER_X)], 'left')).toEqual([]);
  });

  it('returns an empty array when there are no targets', () => {
    expect(swingAt(CENTER_Y, [])).toEqual([]);
  });
});
