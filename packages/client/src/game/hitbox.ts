/**
 * Hit detection — pure functions. No DOM, no worker APIs.
 *
 * Hit rules — "you only connect when the whip actually reaches":
 *
 *   1. Take the rectangle the whip's lash sweeps through during the crack (strike) window of
 *      the swing (= the manifest's `player.whipStrikeBox`, sprite-local) and move it into
 *      stage coordinates. That box is a value derived from the asset's forward kinematics,
 *      not a reach constant — there is no longer any radial reach like "within N px to the
 *      right of the body center".
 *   2. Only the target's body slab (`target.bodyBox`, 128×62) participates in hit detection.
 *      Arms, legs, and eyes are excluded.
 *   3. If the two AABBs overlap, it is a hit. **Every overlapping target gets hit** — if the
 *      box straddles two adjacent slots, hitting both is correct. The current slot pitch is
 *      288px (= 240 sprite + 48 label band, render/layout.ts) and the strike box is 47px
 *      tall, so a simultaneous double hit is geometrically impossible — it would come about
 *      naturally, with no change to hit detection, if the pitch ever narrowed below 109px.
 *   4. Targets already **in a hit reaction** are excluded — so that rapid hits do not cut the
 *      strike animation short. Targets in the groggy (flinch) state are **not** excluded:
 *      groggy is a hittable state, and a hit landing then restarts the animation from hit
 *      (game/simulation.ts).
 *      That is why the only reaction state `HitCandidate` carries is `hitTick`.
 *
 * ⚠️ Facing left, you cannot hit anyone. The whip always goes out to the right in sprite
 *    space and the renderer mirrors the whole sprite when facing 'left'
 *    (render/player-node.ts), so facing left sends the whip left too. But the target column
 *    is always on the right side of the screen (render/layout.ts) — meaning a left-facing
 *    swing visually touches nothing either. The mirroring math (mirrorX) is implemented
 *    below, but it is never called until targets can appear on the left. Once targets exist
 *    on both sides, just drop the `facing` guard.
 *
 * Coordinate system: everything is **world** px (origin at the world's top-left, y grows
 * downward). Camera scrolling is render-only and therefore has no effect on hit detection.
 */
import type { Direction } from '@claudewhip/shared';
import type { SlotGeometry } from './protocol.js';

/**
 * Axis-aligned rectangle (x0 <= x1, y0 <= y1). The single source of truth for the hit-geometry
 * type — `whipStrikeBox` in assets/manifest.ts is checked against this type too (only its
 * coordinate system is sprite-local).
 */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Slot geometry (the contract) + the reaction state hit detection needs.
 * The only thing here is `hitTick` — the groggy (flinch) state and the consecutive-hit counter
 * have no effect on hit detection, so they live only in the simulation's target type
 * (SimTarget in game/simulation.ts).
 */
export interface HitCandidate extends SlotGeometry {
  /** Hit-reaction ticks remaining. Below 0 means not in a reaction */
  hitTick: number;
}

export interface WhipOrigin {
  /** Player body center (world) */
  x: number;
  y: number;
  /** Horizontal mirroring — the direction the whip goes out */
  facing: Direction;
}

/** Half-extents of the target's body slab (relative to the body center). The manifest's
 * target.bodyBox */
export interface BodyHalfExtent {
  halfW: number;
  halfH: number;
}

/**
 * Move the whip strike box into stage coordinates. `strikeOffset` is the offset box relative
 * to the player's body center (= manifest whipStrikeBox - player bodyCenter).
 *
 * Facing right: just add it.
 * Facing left: flip it about the body-center x (x0/x1 swap places).
 */
function whipStrikeBoxAt(origin: WhipOrigin, strikeOffset: Box): Box {
  const mirror = origin.facing === 'left';
  return {
    x0: mirror ? origin.x - strikeOffset.x1 : origin.x + strikeOffset.x0,
    x1: mirror ? origin.x - strikeOffset.x0 : origin.x + strikeOffset.x1,
    y0: origin.y + strikeOffset.y0,
    y1: origin.y + strikeOffset.y1,
  };
}

/** The target's body slab in world coordinates */
function bodyBoxAt(target: SlotGeometry, body: BodyHalfExtent): Box {
  return {
    x0: target.centerX - body.halfW,
    x1: target.centerX + body.halfW,
    y0: target.centerY - body.halfH,
    y1: target.centerY + body.halfH,
  };
}

/** AABB overlap (touching edges counts as overlapping) */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

/**
 * Called once when the swing enters the crack window. Returns the sessionIds of every target
 * whose body overlaps the whip box (in slot order). Empty array if nothing overlaps.
 *
 * This is the one and only hit-detection path — we used to inflate the box and extract
 * "near misses" from the same function, but flinch was redefined from a graze to the
 * **result of consecutive hits**. The groggy state is produced by the
 * simulation's state transitions, not by this function.
 */
export function pickHitTargets(
  origin: WhipOrigin,
  targets: readonly HitCandidate[],
  strikeOffset: Box,
  body: BodyHalfExtent,
): string[] {
  // A left-facing swing visually never reaches the target column (see the header comment)
  if (origin.facing === 'left') return [];

  const whip = whipStrikeBoxAt(origin, strikeOffset);
  const hits: string[] = [];

  for (const t of targets) {
    if (t.hitTick >= 0) continue; // in a reaction
    if (boxesOverlap(whip, bodyBoxAt(t, body))) hits.push(t.sessionId);
  }

  return hits;
}

/** Closed interval [min, max] */
export interface Band {
  min: number;
  max: number;
}

/**
 * The AABB overlap condition above, solved **for the player's position** — where does the
 * player's body center have to be in order to hit this slot (world coordinates, facing
 * right)? Endpoints are inclusive (same as the overlap test).
 *
 *     x: [cx − halfW − offset.x1, cx + halfW − offset.x0]
 *     y: [cy − halfH − offset.y1, cy + halfH − offset.y0]
 *
 * Being the inverse of hit detection, it is not hit detection itself; but if everyone who
 * needs to know "where you have to stand to connect" (regression tests, E2E movement targets)
 * copies the same formula for themselves, it silently drifts when the assets change.
 */
export function hitBand(
  target: { centerX: number; centerY: number },
  strikeOffset: Box,
  body: BodyHalfExtent,
): { x: Band; y: Band } {
  return {
    x: {
      min: target.centerX - body.halfW - strikeOffset.x1,
      max: target.centerX + body.halfW - strikeOffset.x0,
    },
    y: {
      min: target.centerY - body.halfH - strikeOffset.y1,
      max: target.centerY + body.halfH - strikeOffset.y0,
    },
  };
}
