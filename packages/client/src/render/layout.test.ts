/**
 * Layout tests — this is the single source of truth for position and the
 * source of the worker geometry.
 * The key point is that these are **world coordinates**: once more sessions
 * stack up than fit on screen, worldHeight exceeds the viewport — nothing is truncated.
 */
import { describe, expect, it } from 'vitest';

import { CHARACTER_ASSETS } from '../assets/manifest.js';
import {
  computeLayout,
  LABEL_BAND_PX,
  LABEL_BLOCK_HEIGHT_PX,
  LABEL_GAP_ABOVE_BODY,
  LABEL_INSET_PX,
  LABEL_WIDTH,
  SESSION_COLUMN_WIDTH,
  SLOT_STEP,
  toStageGeometry,
  WORLD_BOTTOM_PADDING,
} from './layout.js';

const TARGET = CHARACTER_ASSETS.target;
const VIEWPORT = { width: 1280, height: 800 };
const STAGE_WIDTH = VIEWPORT.width - SESSION_COLUMN_WIDTH; // 1040

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `session-${i}`);
}

describe('constants', () => {
  it('makes the session column width one side of the target sprite box', () => {
    expect(SESSION_COLUMN_WIDTH).toBe(TARGET.canvasSize);
    expect(SESSION_COLUMN_WIDTH).toBe(240);
  });

  it('makes the slot pitch 288 = label band 48 + sprite 240', () => {
    expect(SLOT_STEP).toBe(LABEL_BAND_PX + TARGET.canvasSize);
    expect(SLOT_STEP).toBe(288);
  });

  it('confines the label inside the column (by the left and right inset)', () => {
    expect(LABEL_WIDTH).toBe(SESSION_COLUMN_WIDTH - LABEL_INSET_PX * 2);
    expect(LABEL_WIDTH).toBeLessThan(SESSION_COLUMN_WIDTH);
  });
});

describe('computeLayout — no sessions', () => {
  const layout = computeLayout(VIEWPORT, []);

  it('leaves the slots empty and the world at exactly the viewport height', () => {
    expect(layout.slots).toEqual([]);
    expect(layout.worldHeight).toBe(VIEWPORT.height);
  });

  it('makes the stage as wide as the viewport minus the session column', () => {
    expect(layout.canvasWidth).toBe(VIEWPORT.width);
    expect(layout.viewportHeight).toBe(VIEWPORT.height);
    expect(layout.stageWidth).toBe(STAGE_WIDTH);
  });

  it('spawns at the horizontal center of the stage × the vertical center of the viewport', () => {
    expect(layout.playerSpawnCenterX).toBe(STAGE_WIDTH / 2);
    expect(layout.playerSpawnCenterY).toBe(VIEWPORT.height / 2);
  });
});

describe('computeLayout — slot placement', () => {
  const layout = computeLayout(VIEWPORT, ids(3));

  it('stacks slots from the top at SLOT_STEP intervals', () => {
    expect(layout.slots.map((s) => s.slot)).toEqual([0, 1, 2]);
    expect(layout.slots.map((s) => s.boxY)).toEqual([
      LABEL_BAND_PX,
      SLOT_STEP + LABEL_BAND_PX,
      SLOT_STEP * 2 + LABEL_BAND_PX,
    ]);
    const centers = layout.slots.map((s) => s.centerY);
    expect((centers[1] as number) - (centers[0] as number)).toBe(SLOT_STEP);
    expect((centers[2] as number) - (centers[1] as number)).toBe(SLOT_STEP);
  });

  it('stands them all on the same column horizontally (body center comes from the manifest bodyCenter)', () => {
    for (const slot of layout.slots) {
      expect(slot.boxX).toBe(STAGE_WIDTH);
      expect(slot.centerX).toBe(STAGE_WIDTH + TARGET.bodyCenter.x);
      expect(slot.labelX).toBe(STAGE_WIDTH + LABEL_INSET_PX);
      // The label block never leaves the column
      expect(slot.labelX + LABEL_WIDTH).toBeLessThanOrEqual(STAGE_WIDTH + SESSION_COLUMN_WIDTH);
    }
  });

  it('attaches the label above the top edge of the body slab', () => {
    const first = layout.slots[0];
    expect(first?.labelY).toBe(
      (first?.centerY as number) - TARGET.bodyBox.halfH - LABEL_GAP_ABOVE_BODY - LABEL_BLOCK_HEIGHT_PX,
    );
    expect(first?.labelY).toBeLessThan((first?.centerY as number) - TARGET.bodyBox.halfH);
  });

  it('uses the sessionId order as the slot order', () => {
    expect(layout.slots.map((s) => s.sessionId)).toEqual(['session-0', 'session-1', 'session-2']);
  });
});

describe('computeLayout — worldHeight', () => {
  it('uses the viewport height as the lower bound when there are few sessions', () => {
    expect(computeLayout(VIEWPORT, ids(1)).worldHeight).toBe(VIEWPORT.height);
    expect(computeLayout(VIEWPORT, ids(2)).worldHeight).toBe(VIEWPORT.height);
  });

  it('grows taller than the viewport when there are many sessions (nothing is truncated)', () => {
    const many = computeLayout(VIEWPORT, ids(10));
    expect(many.worldHeight).toBe(10 * SLOT_STEP + WORLD_BOTTOM_PADDING);
    expect(many.worldHeight).toBeGreaterThan(VIEWPORT.height);
    // The bottom-most character's sprite box fits entirely inside the world
    const last = many.slots[9];
    expect((last?.boxY as number) + TARGET.canvasSize).toBeLessThanOrEqual(many.worldHeight);
  });

  it('keeps viewportHeight unchanged as the world grows, since it is screen space', () => {
    expect(computeLayout(VIEWPORT, ids(10)).viewportHeight).toBe(VIEWPORT.height);
  });
});

describe('computeLayout — extreme inputs', () => {
  it('cleans up negative and fractional viewports', () => {
    const layout = computeLayout({ width: -100, height: 0 }, []);
    expect(layout.canvasWidth).toBe(0);
    expect(layout.viewportHeight).toBe(0);
    expect(layout.stageWidth).toBe(0);
  });

  it('makes the stage width 0 on a screen narrower than the session column', () => {
    expect(computeLayout({ width: 100, height: 600 }, ids(1)).stageWidth).toBe(0);
  });

  it('rounds fractional viewports', () => {
    const layout = computeLayout({ width: 1280.6, height: 799.4 }, []);
    expect(layout.canvasWidth).toBe(1281);
    expect(layout.viewportHeight).toBe(799);
    expect(Number.isInteger(layout.playerSpawnCenterY)).toBe(true);
  });
});

describe('toStageGeometry', () => {
  it('carries over only what the worker contract needs', () => {
    const layout = computeLayout(VIEWPORT, ids(2));
    const geometry = toStageGeometry(layout);

    expect(geometry).toEqual({
      stageWidth: layout.stageWidth,
      worldHeight: layout.worldHeight,
      playerCenterX: layout.playerSpawnCenterX,
      playerCenterY: layout.playerSpawnCenterY,
      slots: [
        {
          sessionId: 'session-0',
          slot: 0,
          centerX: layout.slots[0]?.centerX,
          centerY: layout.slots[0]?.centerY,
        },
        {
          sessionId: 'session-1',
          slot: 1,
          centerX: layout.slots[1]?.centerX,
          centerY: layout.slots[1]?.centerY,
        },
      ],
    });
  });

  it('does not pass label coordinates (render-only) to the worker', () => {
    const geometry = toStageGeometry(computeLayout(VIEWPORT, ids(1)));
    expect(Object.keys(geometry.slots[0] ?? {}).sort()).toEqual([
      'centerX',
      'centerY',
      'sessionId',
      'slot',
    ]);
  });

  it('produces no slots when there are no sessions', () => {
    expect(toStageGeometry(computeLayout(VIEWPORT, [])).slots).toEqual([]);
  });
});
