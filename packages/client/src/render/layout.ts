/**
 * Stage layout computation — pure functions. It never measures the DOM.
 *
 * We used to let CSS flex do the placement and read it back with getBoundingClientRect,
 * but once there was a single canvas the character positions became values CSS knows
 * nothing about. So this is the single source of truth for position:
 *   - the output of this file translates the scene nodes, and
 *   - the same output is converted to a StageGeometry and sent to the worker
 *     (the contract is exactly the one in game/protocol.ts)
 *
 * The coordinate system is **world** px (origin at the world's top-left, y increases
 * downwards). Horizontally it matches the viewport, but vertically it does not — once
 * more sessions stack up than fit on screen, the world grows taller than the viewport
 * and the camera picks which slice is visible (render/camera.ts). That is:
 *
 *     screen.y = world.y - camera.y        (screen.x = world.x, there is no horizontal scroll)
 *
 * Neither this file nor the simulation knows about the camera — the camera is a purely
 * render-side concern.
 *
 * ⚠️ The body center is not the middle of the sprite box but the bodyCenter from
 * assets/manifest.ts — the player (104,255) and the target (120,120) differ, so each
 * uses its own value.
 */
import { CHARACTER_ASSETS } from '../assets/manifest.js';
import type { StageGeometry } from '../game/protocol.js';

/**
 * Width (px) of the session column on the right = one side of the target sprite box.
 * Not "should match" but **is** the same value — we used to write 240 here separately
 * and hope it stayed in sync with the manifest.
 * The column background/divider (render/backdrop.ts) and the label width (LABEL_WIDTH
 * below) are derived from this value too.
 */
export const SESSION_COLUMN_WIDTH = CHARACTER_ASSETS.target.canvasSize;

/**
 * World padding (px) left below the last slot box. It only keeps the bottom-most
 * character from sitting flush against the end of the world and looking "cut off";
 * it has nothing to do with hit detection.
 */
export const WORLD_BOTTOM_PADDING = 80;

/* ── Label geometry ───────────────────────────────────────────
 * Labels are **confined inside the session column.** We used to lay the prompt out on a
 * single line and spill it to the left (onto the stage) when it did not fit, but then a
 * long path cut across the stage and other characters and looked like "the name escaped"
 * (the same feedback twice). Now the width is pinned inside the column and the
 * information is preserved by splitting it across **two lines** instead:
 *
 *     ~/…/Hackathon-ClaudeWhip main   ← line 1: path + branch (over budget: fold, then drop the branch)
 *                     ❯ claude █      ← line 2: always fully visible
 *
 * The line-splitting rules and the character budget live in prompt-label.ts; this file
 * only decides **width, height and position**. */

/**
 * How far (px) the label is inset from the left and right edges of the column. It is the
 * same on both sides, so the label width is `column width - 2×inset` and it never crosses
 * the column boundary in either direction.
 */
export const LABEL_INSET_PX = 14;
/**
 * Width (px) of the label block — it sits entirely inside the column, so no matter how
 * wide or narrow the screen gets the label cannot intrude on the stage (its left and
 * right edges are the column edges). It is the same for every slot, so it is not carried
 * on the slot placement (SlotPlacement) — whoever computes the per-line character budget
 * (render/target-node.ts) reads this constant directly.
 */
export const LABEL_WIDTH = SESSION_COLUMN_WIDTH - LABEL_INSET_PX * 2;
/* The single source of truth for label typography is here too (main.ts injects the CSS
 * variables): at boot main.ts injects them as CSS variables (--label-font-size /
 * --label-line-height / --label-gap) and styles.css only uses those var()s. Previously
 * CSS's 11px/1.4 and the 16px in the labelY computation below only referenced each other
 * in comments, so fixing one side detached the label from the character. */

/** Label font size (px) */
export const LABEL_FONT_SIZE_PX = 11;
/** Label line height (px) — the value the labelY computation uses, and the CSS line-height */
export const LABEL_LINE_HEIGHT_PX = 16;
/** flex gap (px) between label pieces — target-node.ts uses it too, since it must be subtracted from the character budget */
export const LABEL_GAP_PX = 6;
/** Number of label lines (line 1 path+branch, line 2 `❯ claude █`) — must match the composition in prompt-label.ts */
const LABEL_LINES = 2;
/** Total height (px) of the label block — used by the labelY computation (render code never needs it for placement) */
export const LABEL_BLOCK_HEIGHT_PX = LABEL_LINES * LABEL_LINE_HEIGHT_PX;
/** Gap between the top edge of the body slab and the bottom edge of the label — what makes the label look "attached" to the character */
export const LABEL_GAP_ABOVE_BODY = 12;
/**
 * Vertical band (px) each slot yields to its label — a value **added on top of** the slot
 * pitch. When the pitch equalled the sprite box (240) the label was wedged between the
 * characters above and below and you could not tell whose it was. It must be larger than
 * the label block (32) + the gap to the body (12).
 */
export const LABEL_BAND_PX = 48;

/**
 * Vertical pitch (px) of session slots = [label band] + [target sprite box]. The culling
 * margin uses this value as well. It only pushes slot centers further apart, so hit
 * detection is unaffected (game/hitbox.ts).
 */
export const SLOT_STEP = LABEL_BAND_PX + CHARACTER_ASSETS.target.canvasSize;

export interface SlotPlacement {
  sessionId: string;
  slot: number;
  /** Top-left of the sprite box (world) */
  boxX: number;
  boxY: number;
  /** Body center (world) — the hitbox reference point */
  centerX: number;
  centerY: number;
  /** Top-left of the label block (2-line shell prompt) (world) — right above the character's body, inside the column. Width is fixed at LABEL_WIDTH */
  labelX: number;
  labelY: number;
}

export interface StageLayout {
  /** Canvas width = the whole viewport (stage + session column) */
  canvasWidth: number;
  /** Canvas height = viewport height. This is **screen space** — however tall the world gets, the canvas is only as tall as the screen */
  viewportHeight: number;
  /** The area the player roams = the viewport minus the session column */
  stageWidth: number;
  /**
   * World height = max(viewport, session count × slot pitch + padding).
   * It is both the player's vertical clamp range and the camera's scroll limit. There is
   * no notion of a floor (fixed ground).
   */
  worldHeight: number;
  /** Player body center at spawn (world). The render's first placement and the simulation's initial state use the same value */
  playerSpawnCenterX: number;
  playerSpawnCenterY: number;
  slots: SlotPlacement[];
}

/**
 * Viewport size + session order → layout.
 * Slots keep stacking down the right-hand column from the top at SLOT_STEP intervals —
 * going past the viewport does not truncate them, it just makes the world that much
 * taller. Off-screen slots become visible when the camera scrolls down.
 */
export function computeLayout(
  viewport: { width: number; height: number },
  sessionIds: readonly string[],
): StageLayout {
  const canvasWidth = Math.max(0, Math.round(viewport.width));
  const viewportHeight = Math.max(0, Math.round(viewport.height));
  const stageWidth = Math.max(0, canvasWidth - SESSION_COLUMN_WIDTH);
  const worldHeight = Math.max(
    viewportHeight,
    sessionIds.length * SLOT_STEP + (sessionIds.length > 0 ? WORLD_BOTTOM_PADDING : 0),
  );

  const target = CHARACTER_ASSETS.target;
  const slots = sessionIds.map((sessionId, slot) => {
    const boxX = stageWidth;
    // Slot = [label band][sprite box] — the box starts below the band
    const boxY = slot * SLOT_STEP + LABEL_BAND_PX;
    const centerY = boxY + target.bodyCenter.y;
    return {
      sessionId,
      slot,
      boxX,
      boxY,
      centerX: boxX + target.bodyCenter.x,
      centerY,
      labelX: boxX + LABEL_INSET_PX,
      // Right above the top edge of the body slab — the top of the slot box (its old
      // position) was more than 100px away from the character and you could not tell
      // which character the label belonged to. Lift it by the block height to align its
      // bottom edge.
      labelY: centerY - target.bodyBox.halfH - LABEL_GAP_ABOVE_BODY - LABEL_BLOCK_HEIGHT_PX,
    };
  });

  return {
    canvasWidth,
    viewportHeight,
    stageWidth,
    worldHeight,
    // Spawn = horizontal center of the stage × vertical center of the viewport. The
    // camera starts at 0, so the player stands dead center on screen (= in the middle of
    // the dead zone). The old "feet planted on the floor" went away together with the floor.
    // (Only the vertical value is rounded — horizontally the simulation takes over and
    // moves in fractional values anyway)
    playerSpawnCenterX: stageWidth / 2,
    playerSpawnCenterY: Math.round(viewportHeight / 2),
    slots,
  };
}

/** Layout → worker contract (StageGeometry). The simulation runs entirely in world coordinates */
export function toStageGeometry(layout: StageLayout): StageGeometry {
  return {
    stageWidth: layout.stageWidth,
    worldHeight: layout.worldHeight,
    playerCenterX: layout.playerSpawnCenterX,
    playerCenterY: layout.playerSpawnCenterY,
    slots: layout.slots.map((slot) => ({
      sessionId: slot.sessionId,
      slot: slot.slot,
      centerX: slot.centerX,
      centerY: slot.centerY,
    })),
  };
}
