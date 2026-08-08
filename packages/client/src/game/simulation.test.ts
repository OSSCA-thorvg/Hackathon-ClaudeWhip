/**
 * Simulation tests — (state, input) → next state is entirely pure functions, so it can be run
 * as-is.
 *
 * What is covered: movement/clamping, the swing state machine (the active window derived from
 * the manifest), hit → reaction → consecutive-hit groggy, and streak reset. Not a single tick
 * constant is copied — every expectation is built by reading `assets/manifest.ts` (change the
 * assets and the tests move with them).
 */
import { describe, expect, it } from 'vitest';

import type { StageGeometry } from './protocol.js';
import { CHARACTER_ASSETS } from '../assets/manifest.js';
import {
  applyMove,
  applySwing,
  createSimState,
  EMPTY_GEOMETRY,
  FLINCH_HIT_STREAK,
  MOVE_PX_PER_TICK,
  PLAYER_EDGE_MARGIN_PX as EDGE_MARGIN,
  STREAK_RESET_GAP_TICKS,
  SWING_TICKS,
  tick,
  toGameState,
  withGeometry,
  type SimState,
} from './simulation.js';

const { player: PLAYER_ASSET, target: TARGET_ASSET } = CHARACTER_ASSETS;

/** Constants derived from the manifest (the same source production uses) */
const ACTIVE_BEGIN = PLAYER_ASSET.swingActive.begin; // 14
const ACTIVE_END = PLAYER_ASSET.swingActive.end; // 19
const HIT_TICKS = TARGET_ASSET.hitReactionTicks; // 30
const FLINCH_TICKS = TARGET_ASSET.flinchTicks; // 60
/* For the tuning values (consecutive-hit threshold, streak gap, movement speed, edge margin)
 * the imports above ARE the source — keeping a copy would let the tests keep passing with the
 * old values even after the simulation changes. */

const PLAYER_SPAWN = { x: 400, y: 400 };
/** A target placed directly in front of the player (within horizontal reach, dead center
 * vertically) — a swing always connects */
const TARGET_CENTER = { x: PLAYER_SPAWN.x + 200, y: PLAYER_SPAWN.y };

function geometry(overrides: Partial<StageGeometry> = {}): StageGeometry {
  return {
    stageWidth: 1000,
    worldHeight: 800,
    playerCenterX: PLAYER_SPAWN.x,
    playerCenterY: PLAYER_SPAWN.y,
    slots: [{ sessionId: 's1', slot: 0, centerX: TARGET_CENTER.x, centerY: TARGET_CENTER.y }],
    ...overrides,
  };
}

/** Advances n ticks, collecting the events along the way */
function run(state: SimState, ticks: number) {
  const hits: string[][] = [];
  const flinches: string[][] = [];
  let current = state;
  for (let i = 0; i < ticks; i += 1) {
    const result = tick(current);
    current = result.state;
    hits.push(result.hits);
    flinches.push(result.flinches);
  }
  return { state: current, hits, flinches, allHits: hits.flat(), allFlinches: flinches.flat() };
}

/** Plays one full swing to the end (including its single hit resolution) */
function fullSwing(state: SimState) {
  return run(applySwing(state), SWING_TICKS);
}

/**
 * A swing stopped on the resolution tick — for tests that want to observe the state at the
 * instant the reaction has just been applied.
 * (Running a full swing to the end leaves the hit reaction (30 ticks) already finished,
 *  because it is shorter than the swing remainder (SWING_TICKS−ACTIVE_BEGIN=32 ticks) — the
 *  "flurry interval" test below nails down exactly that fact.)
 */
function swingUntilHit(state: SimState) {
  return run(applySwing(state), ACTIVE_BEGIN);
}

describe('createSimState', () => {
  it('reflects the spawn position and slots from the geometry exactly', () => {
    const state = createSimState(geometry());
    expect(state.player).toMatchObject({
      x: PLAYER_SPAWN.x,
      y: PLAYER_SPAWN.y,
      facing: 'right',
      moving: false,
      swingTick: -1,
      hitResolved: false,
    });
    expect(state.targets).toHaveLength(1);
    expect(state.targets[0]).toMatchObject({
      sessionId: 's1',
      slot: 0,
      hitTick: -1,
      flinchTick: -1,
      hitStreak: 0,
      quietTicks: 0,
    });
    expect(state.input).toEqual({ left: false, right: false, up: false, down: false });
  });

  it('clamps the spawn position inside the world bounds', () => {
    const state = createSimState(geometry({ playerCenterX: -50, playerCenterY: 5000 }));
    expect(state.player.x).toBe(EDGE_MARGIN);
    expect(state.player.y).toBe(800 - EDGE_MARGIN);
  });

  it('does not clamp while the geometry has not been measured yet (EMPTY_GEOMETRY)', () => {
    const state = createSimState(EMPTY_GEOMETRY);
    expect(state.player).toMatchObject({ x: 0, y: 0 });
    expect(state.targets).toEqual([]);
  });
});

describe('movement', () => {
  it('stays put with moving=false when there is no input', () => {
    const { state } = run(createSimState(geometry()), 10);
    expect(state.player).toMatchObject({ x: PLAYER_SPAWN.x, y: PLAYER_SPAWN.y, moving: false });
  });

  it('moves right/down by MOVE_PX_PER_TICK per tick', () => {
    let state = applyMove(createSimState(geometry()), 'right', true);
    state = applyMove(state, 'down', true);
    const after = run(state, 10).state;
    expect(after.player.x).toBeCloseTo(PLAYER_SPAWN.x + 10 * MOVE_PX_PER_TICK);
    expect(after.player.y).toBeCloseTo(PLAYER_SPAWN.y + 10 * MOVE_PX_PER_TICK);
    expect(after.player.moving).toBe(true);
  });

  it('facing only responds to left/right input', () => {
    const left = run(applyMove(createSimState(geometry()), 'left', true), 1).state;
    expect(left.player.facing).toBe('left');

    const up = run(applyMove(createSimState(geometry()), 'up', true), 1).state;
    expect(up.player.facing).toBe('right'); // unchanged
  });

  it('opposite directions pressed at once cancel out (moving is false too)', () => {
    let state = applyMove(createSimState(geometry()), 'left', true);
    state = applyMove(state, 'right', true);
    const after = run(state, 10).state;
    expect(after.player).toMatchObject({ x: PLAYER_SPAWN.x, y: PLAYER_SPAWN.y, moving: false });
  });

  it('stops when the key is released', () => {
    let state = applyMove(createSimState(geometry()), 'right', true);
    state = run(state, 5).state;
    const stopped = run(applyMove(state, 'right', false), 5).state;
    expect(stopped.player.x).toBeCloseTo(PLAYER_SPAWN.x + 5 * MOVE_PX_PER_TICK);
    expect(stopped.player.moving).toBe(false);
  });

  it('stops at the world bounds but keeps moving=true (still walking while pressed against the wall)', () => {
    let state = applyMove(createSimState(geometry()), 'right', true);
    state = applyMove(state, 'down', true);
    const after = run(state, 1000).state;
    expect(after.player.x).toBe(1000 - EDGE_MARGIN);
    expect(after.player.y).toBe(800 - EDGE_MARGIN);
    expect(after.player.moving).toBe(true);
  });

  it('leaves the margin at the left/top bounds as well', () => {
    let state = applyMove(createSimState(geometry()), 'left', true);
    state = applyMove(state, 'up', true);
    const after = run(state, 1000).state;
    expect(after.player.x).toBe(EDGE_MARGIN);
    expect(after.player.y).toBe(EDGE_MARGIN);
  });

  it('collapses to the center when the world is narrower than the margin', () => {
    const narrow = createSimState(geometry({ stageWidth: 50, playerCenterX: 999 }));
    expect(narrow.player.x).toBe(25); // min(40, 50/2)=25 = max
  });
});

describe('withGeometry', () => {
  it('updates the target slot coordinates while preserving reaction progress', () => {
    const hit = swingUntilHit(createSimState(geometry()));
    const reacting = hit.state.targets[0];
    expect(reacting?.hitTick).toBeGreaterThanOrEqual(0);

    const moved = withGeometry(
      hit.state,
      geometry({ slots: [{ sessionId: 's1', slot: 0, centerX: 999, centerY: 111 }] }),
    );
    expect(moved.targets[0]).toMatchObject({
      centerX: 999,
      centerY: 111,
      hitTick: reacting?.hitTick,
      hitStreak: reacting?.hitStreak,
    });
  });

  it('a newly arrived session starts in the normal state', () => {
    const state = createSimState(geometry());
    const next = withGeometry(
      state,
      geometry({
        slots: [
          { sessionId: 's1', slot: 0, centerX: 1, centerY: 1 },
          { sessionId: 's2', slot: 1, centerX: 2, centerY: 2 },
        ],
      }),
    );
    expect(next.targets.map((t) => t.sessionId)).toEqual(['s1', 's2']);
    expect(next.targets[1]).toMatchObject({ hitTick: -1, flinchTick: -1, hitStreak: 0 });
  });

  it('a session that disappeared is dropped', () => {
    const next = withGeometry(createSimState(geometry()), geometry({ slots: [] }));
    expect(next.targets).toEqual([]);
  });

  it('pulls the current position into the new range when the world shrinks (without resetting to the spawn)', () => {
    const state = run(applyMove(createSimState(geometry()), 'down', true), 60).state;
    expect(state.player.y).toBeGreaterThan(500);

    const shrunk = withGeometry(state, geometry({ worldHeight: 300 }));
    expect(shrunk.player.y).toBe(300 - EDGE_MARGIN);
    expect(shrunk.player.y).not.toBe(PLAYER_SPAWN.y);
  });
});

describe('swing state machine', () => {
  it('applySwing starts a swing, and further input during a swing is ignored', () => {
    const state = applySwing(createSimState(geometry()));
    expect(state.player.swingTick).toBe(0);
    // Returns the very same state object (no change)
    expect(applySwing(state)).toBe(state);
  });

  it('swinging=true for SWING_TICKS, false once it ends', () => {
    let state = applySwing(createSimState(geometry()));
    for (let i = 1; i < SWING_TICKS; i += 1) {
      state = tick(state).state;
      expect(toGameState(state).player.swinging, `tick ${i}`).toBe(true);
    }
    state = tick(state).state; // the SWING_TICKS-th one
    expect(toGameState(state).player.swinging).toBe(false);
    expect(state.player.swingTick).toBe(-1);
  });

  it('hit resolution happens exactly once, on the tick the active window is entered', () => {
    const { hits } = fullSwing(createSimState(geometry()));
    // hits[i] is the result of the (i+1)-th tick
    const hitTicks = hits.map((h, i) => (h.length > 0 ? i + 1 : 0)).filter((t) => t > 0);
    expect(hitTicks).toEqual([ACTIVE_BEGIN]);
    expect(ACTIVE_BEGIN).toBeLessThan(ACTIVE_END);
  });

  it('nobody gets hit before the active window', () => {
    const { allHits } = run(applySwing(createSimState(geometry())), ACTIVE_BEGIN - 1);
    expect(allHits).toEqual([]);
  });

  it('without a swing there is no hit resolution at all', () => {
    const { allHits } = run(createSimState(geometry()), SWING_TICKS * 2);
    expect(allHits).toEqual([]);
  });

  it('once a swing ends, the next swing resolves again', () => {
    const first = fullSwing(createSimState(geometry()));
    expect(first.allHits).toEqual(['s1']);
    // Wait for the reaction to finish, then swing again
    const rested = run(first.state, HIT_TICKS + 1).state;
    expect(fullSwing(rested).allHits).toEqual(['s1']);
  });

  it('a target out of reach (vertically) does not get hit', () => {
    const far = createSimState(
      geometry({ slots: [{ sessionId: 's1', slot: 0, centerX: TARGET_CENTER.x, centerY: 900 }] }),
    );
    expect(fullSwing(far).allHits).toEqual([]);
  });

  it('swinging while facing left connects with nothing', () => {
    const facingLeft = run(applyMove(createSimState(geometry()), 'left', true), 1).state;
    expect(fullSwing(facingLeft).allHits).toEqual([]);
  });

  it('the resolution origin follows movement (walk out of reach and you miss)', () => {
    let state = applyMove(createSimState(geometry()), 'left', true);
    state = run(state, 60).state; // 300px to the left — out of reach
    state = applyMove(state, 'left', false);
    state = applyMove(state, 'right', true);
    state = run(state, 1).state; // restore facing
    expect(fullSwing(state).allHits).toEqual([]);
  });
});

describe('hit reaction', () => {
  it('a hit turns hitReacting on, and it turns off HIT_TICKS later', () => {
    const swung = swingUntilHit(createSimState(geometry()));
    expect(swung.state.targets[0]?.hitTick).toBe(HIT_TICKS);
    expect(toGameState(swung.state).targets[0]?.hitReacting).toBe(true);

    // It decrements by 1 every tick; down to 0 it is still reacting, and on the next tick it
    // becomes -1 and ends
    const last = run(swung.state, HIT_TICKS).state;
    expect(last.targets[0]?.hitTick).toBe(0);
    expect(toGameState(last).targets[0]?.hitReacting).toBe(true);

    const done = run(last, 1).state;
    expect(done.targets[0]?.hitTick).toBeLessThan(0);
    expect(toGameState(done).targets[0]?.hitReacting).toBe(false);
  });

  it('a target in a reaction is excluded from hit resolution', () => {
    // The flurry interval (SWING_TICKS) is longer than the reaction (HIT_TICKS), so this state
    // is unreachable through actual play — hence we construct the reacting state directly and
    // check only the resolution.
    const base = createSimState(geometry());
    const reacting: SimState = {
      ...base,
      targets: base.targets.map((t) => ({ ...t, hitTick: HIT_TICKS })),
    };
    expect(fullSwing(reacting).allHits).toEqual([]);
  });

  it('the flurry interval is longer than the reaction — back-to-back swings connect every time', () => {
    expect(SWING_TICKS - ACTIVE_BEGIN).toBeGreaterThan(HIT_TICKS);

    const first = fullSwing(createSimState(geometry()));
    expect(first.state.targets[0]?.hitTick).toBeLessThan(0); // by the time the swing ends, the reaction has ended too
    expect(fullSwing(first.state).allHits).toEqual(['s1']);
  });
});

describe('consecutive-hit groggy', () => {
  /** Swings n times back to back (no gap between swings — the shortest interval that never
   * breaks the streak) */
  function swingRepeatedly(times: number) {
    let state = createSimState(geometry());
    const hits: string[] = [];
    const flinches: string[][] = [];
    for (let i = 0; i < times; i += 1) {
      const result = fullSwing(state);
      state = result.state;
      hits.push(...result.allHits);
      flinches.push(result.allFlinches);
    }
    return { state, hits, flinches };
  }

  it('does not go groggy at up to two consecutive hits', () => {
    const { hits, flinches, state } = swingRepeatedly(FLINCH_HIT_STREAK - 1);
    expect(hits).toEqual(['s1', 's1']);
    expect(flinches.flat()).toEqual([]);
    expect(state.targets[0]?.hitStreak).toBe(FLINCH_HIT_STREAK - 1);
    expect(state.targets[0]?.flinchTick).toBeLessThan(0);
  });

  it('three consecutive hits go groggy (target_flinch fires once, on the entry tick)', () => {
    const { hits, flinches, state } = swingRepeatedly(FLINCH_HIT_STREAK);
    expect(hits).toHaveLength(FLINCH_HIT_STREAK);
    // Groggy is entered on the tick the hit reaction ends during the last swing
    expect(flinches[FLINCH_HIT_STREAK - 1]).toEqual(['s1']);
    expect(flinches.flat()).toEqual(['s1']); // exactly once
    expect(state.targets[0]?.flinchTick).toBeGreaterThanOrEqual(0);
  });

  it('three hits in a row take at least 1.5 seconds (one swing is SWING_TICKS, so it cannot happen by accident)', () => {
    expect((SWING_TICKS * FLINCH_HIT_STREAK) / 60).toBeGreaterThanOrEqual(1.5);
  });

  it('groggy wears off after FLINCH_TICKS and resets the streak to 0', () => {
    const { state } = swingRepeatedly(FLINCH_HIT_STREAK);
    // Entry happens 1 tick before the last swing ends, so 1 tick has already elapsed
    const flinchTick = state.targets[0]?.flinchTick ?? -1;
    expect(flinchTick).toBe(FLINCH_TICKS - 1);

    const stillGroggy = run(state, flinchTick).state;
    expect(stillGroggy.targets[0]?.flinchTick).toBe(0);

    const recovered = run(stillGroggy, 1).state;
    expect(recovered.targets[0]?.flinchTick).toBeLessThan(0);
    expect(recovered.targets[0]?.hitStreak).toBe(0);
  });

  it('a hit landing during groggy restarts from hit (groggy is not an exclusion from hit resolution)', () => {
    const { state } = swingRepeatedly(FLINCH_HIT_STREAK);
    expect(state.targets[0]?.flinchTick).toBeGreaterThanOrEqual(0);

    const again = swingUntilHit(state);
    expect(again.allHits).toEqual(['s1']);
    const target = again.state.targets[0];
    expect(target?.flinchTick).toBeLessThan(0); // groggy is cut off on the spot
    expect(target?.hitTick).toBe(HIT_TICKS); // starts over from hit
    expect(target?.hitStreak).toBe(FLINCH_HIT_STREAK + 1);
    expect(toGameState(again.state).targets[0]?.hitReacting).toBe(true);
  });

  it('the streak breaks once the gap exceeds STREAK_RESET_GAP_TICKS', () => {
    const first = fullSwing(createSimState(geometry()));
    // By the time the swing ends, the reaction has already finished and the quiet gap has
    // started being counted
    const quiet = first.state.targets[0]?.quietTicks ?? 0;
    expect(first.state.targets[0]?.hitStreak).toBe(1);

    const held = run(first.state, STREAK_RESET_GAP_TICKS - quiet).state;
    expect(held.targets[0]?.quietTicks).toBe(STREAK_RESET_GAP_TICKS);
    expect(held.targets[0]?.hitStreak).toBe(1); // held right up to the boundary

    const dropped = run(held, 1).state;
    expect(dropped.targets[0]?.hitStreak).toBe(0);

    // Which is why two consecutive hits after that do not go groggy
    const second = fullSwing(dropped);
    const third = fullSwing(second.state);
    expect([...second.allFlinches, ...third.allFlinches]).toEqual([]);
  });

  it('does not allocate a new target object during normal play (streak 0)', () => {
    const state = createSimState(geometry());
    const before = state.targets[0];
    expect(run(state, 200).state.targets[0]).toBe(before);
  });
});

describe('toGameState', () => {
  it('emits only the shape of the public contract', () => {
    const state = createSimState(geometry());
    expect(toGameState(state)).toEqual({
      player: { x: PLAYER_SPAWN.x, y: PLAYER_SPAWN.y, facing: 'right', swinging: false, moving: false },
      targets: [{ sessionId: 's1', slot: 0, hitReacting: false }],
    });
  });

  it('groggy does not go out over the contract (the target_flinch event announces it)', () => {
    let state = createSimState(geometry());
    for (let i = 0; i < FLINCH_HIT_STREAK; i += 1) state = fullSwing(state).state;
    expect(state.targets[0]?.flinchTick).toBeGreaterThanOrEqual(0);
    expect(Object.keys(toGameState(state).targets[0] ?? {})).toEqual([
      'sessionId',
      'slot',
      'hitReacting',
    ]);
  });
});
