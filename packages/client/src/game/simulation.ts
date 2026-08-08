/**
 * Game simulation — pure-function state transition (state, input) → next state.
 * Touches neither the DOM nor any worker API. The actual driving happens in the fixed-tick
 * loop in logic.worker.ts.
 *
 * Coordinate system: everything is **world** px (origin at the world's top-left, y grows
 * downward). The world can be taller than the viewport (when more sessions pile up than fit
 * on screen) and the simulation knows nothing about that difference — the camera that picks
 * the visible slice lives only on the render side (render/camera.ts).
 * The worker cannot see the DOM, so the main thread feeds it the geometry via the
 * init/geometry control messages.
 */
import type { Direction, PlayerState, TargetState } from '@claudewhip/shared';
import { CHARACTER_ASSETS } from '../assets/manifest.js';
import { pickHitTargets, type Box, type HitCandidate } from './hitbox.js';
import type { StageGeometry } from './protocol.js';

/** Fixed tick frequency */
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;

/** Movement speed (px/s) → distance moved per tick */
const MOVE_SPEED_PX_PER_SEC = 300;
export const MOVE_PX_PER_TICK = MOVE_SPEED_PX_PER_SEC / TICK_HZ;

/* The three constants below are all **asset marker lengths** — the numbers live in
 * assets/manifest.ts (which is itself a copy of geometry.json) and here we only read them.
 * They used to be hand-copied numbers, and whenever an asset marker changed, hit detection
 * and the animation silently drifted apart. */

/** Length of one swing (ticks) = length of the 'swing' marker (46f@60fps ≈ 0.77s) */
export const SWING_TICKS = CHARACTER_ASSETS.player.swingTicks;
/**
 * The crack (strike) window — the 'swing'-segment-relative window in which the lash is at
 * maximum reach. The manifest's `player.whipStrikeBox` was derived from **exactly this
 * window**, so the two move together.
 * Hit detection happens exactly once, on the tick the window is entered (see the hitResolved
 * guard below).
 */
const SWING_ACTIVE_BEGIN_TICK = CHARACTER_ASSETS.player.swingActive.begin;
const SWING_ACTIVE_END_TICK = CHARACTER_ASSETS.player.swingActive.end;

/**
 * Re-hit lockout length (ticks) = length of the 'hit' marker (30f = 0.5s).
 * Only targets inside this window are excluded from hit detection (so that rapid hits do not
 * cut the strike animation short).
 */
const HIT_REACTION_TICKS = CHARACTER_ASSETS.target.hitReactionTicks;

/**
 * Groggy (flinch) length (ticks) = length of the 'flinch' marker (60f = 1s). The marker
 * length IS the state length, so the moment the simulation decides it is over is the same
 * moment the animation ends.
 */
const FLINCH_TICKS = CHARACTER_ASSETS.target.flinchTicks;

/**
 * Groggy entry threshold — how many **consecutive hits** it takes to stagger.
 * 3 is the minimum that separates "got hit twice by accident" from "is being beaten
 * continuously": one swing is 46 ticks (≈0.77s), so even at the fastest possible pace three
 * hits in a row take more than 1.5 seconds of pounding.
 */
export const FLINCH_HIT_STREAK = 3;

/**
 * The gap (ticks) that breaks a streak = 1.5 seconds. If nothing happens for this long after
 * a hit reaction ends, the consecutive-hit counter is reset to 0 — otherwise a target that
 * got hit three times sporadically over several minutes would suddenly go groggy, making the
 * word "consecutive" meaningless.
 * It is comfortably longer than a single swing (46 ticks), so normal rapid hitting never
 * trips it.
 */
export const STREAK_RESET_GAP_TICKS = 90;

/**
 * The whip strike box expressed as an offset from the player's body center — just subtract
 * bodyCenter from the sprite-local box. The reach constant (formerly WHIP_REACH_PX) is gone:
 * reach is nothing more than the width of this asset-derived box (v2: dx 96..255, dy -47..10).
 *
 * This is the single source of truth for hit geometry — anyone who needs to invert it
 * ("where do I have to stand to connect?", i.e. `hitBand` in tests and E2E) must use this
 * value directly instead of making their own copy.
 */
export const WHIP_STRIKE_OFFSET: Box = {
  x0: CHARACTER_ASSETS.player.whipStrikeBox.x0 - CHARACTER_ASSETS.player.bodyCenter.x,
  x1: CHARACTER_ASSETS.player.whipStrikeBox.x1 - CHARACTER_ASSETS.player.bodyCenter.x,
  y0: CHARACTER_ASSETS.player.whipStrikeBox.y0 - CHARACTER_ASSETS.player.bodyCenter.y,
  y1: CHARACTER_ASSETS.player.whipStrikeBox.y1 - CHARACTER_ASSETS.player.bodyCenter.y,
};

/** Half-extents of the target's body slab (relative to the body center) */
const TARGET_BODY = CHARACTER_ASSETS.target.bodyBox;

/** Margin on all four sides that keeps the sprite from being clipped by the world edge
 * (measured from the body center) */
export const PLAYER_EDGE_MARGIN_PX = 40;

interface SimPlayer {
  x: number;
  /** Body-center y (world). Changes every tick with vertical movement */
  y: number;
  /** Used for horizontal mirroring — 'up'/'down' input does NOT change this value */
  facing: Direction;
  /** Did it actually move this tick (for switching to the walk loop)?
   * True if either axis moved */
  moving: boolean;
  /** -1 = not swinging, otherwise 0..SWING_TICKS-1 */
  swingTick: number;
  /** Whether hit detection already ran during this swing (one swing = one resolution) */
  hitResolved: boolean;
}

/**
 * Hit-detection state (HitCandidate.hitTick) + the **groggy state machine**.
 *
 * The state is one of three: in a hit reaction (hitTick >= 0) → groggy (flinchTick >= 0) →
 * normal. The two counters are never live at the same time — a new hit cuts the groggy state
 * off immediately.
 */
interface SimTarget extends HitCandidate {
  /** Groggy ticks remaining. Below 0 means not groggy */
  flinchTick: number;
  /** Consecutive hit count. Returns to 0 when the groggy state ends or the gap gets long */
  hitStreak: number;
  /** Ticks that have passed quietly since the hit/groggy state ended — compared against
   * STREAK_RESET_GAP_TICKS */
  quietTicks: number;
}

/** Initial reaction state for a new target (or one that may lose its reaction state) */
const IDLE_REACTION = { hitTick: -1, flinchTick: -1, hitStreak: 0, quietTicks: 0 } as const;

export interface SimState {
  geometry: StageGeometry;
  player: SimPlayer;
  targets: SimTarget[];
  input: { left: boolean; right: boolean; up: boolean; down: boolean };
}

export const EMPTY_GEOMETRY: StageGeometry = {
  stageWidth: 0,
  worldHeight: 0,
  playerCenterX: 0,
  playerCenterY: 0,
  slots: [],
};

/** Initial state that fully reflects the geometry (x/y clamping and per-slot target creation
 * are all finished here) */
export function createSimState(geometry: StageGeometry): SimState {
  return {
    geometry,
    player: {
      // The spawn position comes from the geometry (layout.ts is the single source of truth,
      // the same value the renderer uses for the first placement).
      // The clamp stays here — even in the extreme where the stage is narrower than the
      // margin, the simulation owns the position.
      x: clampToStage(geometry.playerCenterX, geometry.stageWidth),
      // From here on the simulation owns it — there is no floor.
      y: clampToStage(geometry.playerCenterY, geometry.worldHeight),
      facing: 'right',
      moving: false,
      swingTick: -1,
      hitResolved: false,
    },
    targets: geometry.slots.map((slot) => ({ ...slot, ...IDLE_REACTION })),
    input: { left: false, right: false, up: false, down: false },
  };
}

/**
 * Geometry update (boot / resize / session churn). The reaction and groggy progress of
 * surviving targets is preserved (this is re-sent every time a single session comes or goes,
 * so resetting here would silently break a streak mid-flurry).
 */
export function withGeometry(state: SimState, geometry: StageGeometry): SimState {
  const prev = new Map(state.targets.map((t) => [t.sessionId, t]));
  return {
    ...state,
    geometry,
    player: {
      ...state.player,
      x: clampToStage(state.player.x, geometry.stageWidth),
      // If the world shrinks (resize / fewer sessions), the current y is pulled into the new
      // range too (it is NOT reset back to the spawn y)
      y: clampToStage(state.player.y, geometry.worldHeight),
    },
    targets: geometry.slots.map((slot) => {
      const before = prev.get(slot.sessionId);
      // Overlaying the new slot geometry on top of `before` (which includes the reaction
      // state) leaves only the reaction state surviving
      return before ? { ...before, ...slot } : { ...slot, ...IDLE_REACTION };
    }),
  };
}

export function applyMove(state: SimState, direction: Direction, pressed: boolean): SimState {
  const input = { ...state.input };
  input[direction] = pressed;
  return { ...state, input };
}

/** While a swing is in progress, further input is ignored (player state machine: one swing
 * always plays to the end) */
export function applySwing(state: SimState): SimState {
  if (state.player.swingTick >= 0) return state;
  return { ...state, player: { ...state.player, swingTick: 0, hitResolved: false } };
}

export interface TickResult {
  state: SimState;
  /** Targets hit on this tick (the renderer triggers the hit animation). Empty array if none */
  hits: string[];
  /** Targets that **entered the groggy state** on this tick (consecutive-hit threshold
   * reached). Empty array if none */
  flinches: string[];
}

export function tick(state: SimState): TickResult {
  const player = { ...state.player };
  const geometry = state.geometry;

  // 1) Movement (opposite directions pressed at once cancel out). Diagonals keep the full
  //    per-axis speed — we do NOT normalize (prototype: simplicity first, a diagonal being
  //    √2 times faster is acceptable)
  const dirX = (state.input.right ? 1 : 0) - (state.input.left ? 1 : 0);
  const dirY = (state.input.down ? 1 : 0) - (state.input.up ? 1 : 0);
  if (dirX !== 0) {
    player.x = clampToStage(player.x + dirX * MOVE_PX_PER_TICK, geometry.stageWidth);
    // facing only responds to left/right input (up/down has nothing to do with sprite mirroring)
    player.facing = dirX > 0 ? 'right' : 'left';
  }
  if (dirY !== 0) {
    player.y = clampToStage(player.y + dirY * MOVE_PX_PER_TICK, geometry.worldHeight);
  }
  // Even if the clamp pins it in place, it still counts as "walking" — input IS intent, and
  // falling back to idle while pressed against a wall makes the animation pop while the key
  // is still held down
  player.moving = dirX !== 0 || dirY !== 0;

  // 2) Advance the swing
  if (player.swingTick >= 0) {
    player.swingTick += 1;
    if (player.swingTick >= SWING_TICKS) {
      player.swingTick = -1;
      player.hitResolved = false;
    }
  }

  // 3) One hit resolution on entering the crack window — whip box × body box overlap (every
  //    overlapping target). One swing = one resolution, so we first decide "is this tick the
  //    one?", then build the result right there without an accumulator (ticks with no
  //    resolution get an empty array).
  const active =
    player.swingTick >= SWING_ACTIVE_BEGIN_TICK && player.swingTick <= SWING_ACTIVE_END_TICK;
  const resolving = active && !player.hitResolved;
  if (resolving) player.hitResolved = true;
  // The origin is the player's current position, not a fixed value from the geometry —
  // movement is reflected in hit detection directly
  const hits = resolving
    ? pickHitTargets(
        { x: player.x, y: player.y, facing: player.facing },
        state.targets,
        WHIP_STRIKE_OFFSET,
        TARGET_BODY,
      )
    : [];

  // 4) One pass over the target state machine: apply this tick's hits + count down + enter or
  //    leave the groggy state
  const hitSet = hits.length > 0 ? new Set(hits) : null;
  const targets = state.targets.map((t) => advanceTarget(t, hitSet?.has(t.sessionId) === true));
  // Only **entering** the groggy state is an event: on the entry tick there has been no
  // decrement yet, so the value is exactly FLINCH_TICKS — comparing against the previous
  // value lets us pick it out from outside the state machine with no side effects
  const flinches = targets
    .filter((t, i) => t.flinchTick === FLINCH_TICKS && state.targets[i]?.flinchTick !== FLINCH_TICKS)
    .map((t) => t.sessionId);

  return { state: { ...state, player, targets }, hits, flinches };
}

/**
 * Advance a single target by one tick (pure). The state only ever flows hit → (groggy) →
 * normal.
 *
 * - **Got hit**: restart the hit reaction from the beginning and bump the streak by 1. If it
 *   was groggy, that is cut off on the spot (groggy is a hittable state — hit-detection
 *   exclusion looks only at hitTick, see hitbox.ts).
 * - **Hit ends**: if the streak has reached the threshold, move on to groggy. Otherwise back
 *   to normal.
 * - **Groggy ends**: reset the streak to 0 — one stagger settles the account for the flurry.
 * - **Normal**: only count the quiet gap while a streak is alive (with a streak of 0 there is
 *   nothing to count, so we do not even allocate a new object — this avoids cloning N targets
 *   every tick during normal play when nobody is being hit).
 */
function advanceTarget(t: SimTarget, hit: boolean): SimTarget {
  if (hit) {
    return {
      ...t,
      hitTick: HIT_REACTION_TICKS,
      flinchTick: -1,
      hitStreak: t.hitStreak + 1,
      quietTicks: 0,
    };
  }
  if (t.hitTick >= 0) {
    const hitTick = t.hitTick - 1;
    const groggy = hitTick < 0 && t.hitStreak >= FLINCH_HIT_STREAK;
    return { ...t, hitTick, flinchTick: groggy ? FLINCH_TICKS : t.flinchTick };
  }
  if (t.flinchTick >= 0) {
    const flinchTick = t.flinchTick - 1;
    return flinchTick < 0 ? { ...t, flinchTick, hitStreak: 0 } : { ...t, flinchTick };
  }
  if (t.hitStreak === 0) return t;
  const quietTicks = t.quietTicks + 1;
  return quietTicks > STREAK_RESET_GAP_TICKS
    ? { ...t, quietTicks, hitStreak: 0 }
    : { ...t, quietTicks };
}

/** Internal simulation state → the public state that goes out over the bus (shared contract) */
export function toGameState(state: SimState): { player: PlayerState; targets: TargetState[] } {
  return {
    player: {
      x: state.player.x,
      y: state.player.y,
      facing: state.player.facing,
      swinging: state.player.swingTick >= 0,
      moving: state.player.moving,
    },
    targets: state.targets.map((t) => ({
      sessionId: t.sessionId,
      slot: t.slot,
      hitReacting: t.hitTick >= 0,
    })),
  };
}

/** Confines the body center to [margin, extent-margin] (an extent of 0 means it has not been
 * measured yet — leave it alone) */
function clampToStage(value: number, extent: number): number {
  if (extent <= 0) return value;
  const min = Math.min(PLAYER_EDGE_MARGIN_PX, extent / 2);
  const max = Math.max(extent - PLAYER_EDGE_MARGIN_PX, min);
  return Math.min(max, Math.max(min, value));
}
