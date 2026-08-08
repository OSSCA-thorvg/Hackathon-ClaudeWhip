/**
 * Background decoration — the stage gradient + the session column on the right
 * (background + divider). It lives **inside the canvas**.
 *
 * It used to be a DOM layer beneath the canvas (`#backdrop`). In a structure where the
 * canvas covers the entire viewport, leaving only the background in the DOM keeps the
 * premise "the whole game area is one canvas" only half true — layout.ts knows the column
 * width and CSS draws it from a variable, so the same number is split across two systems,
 * and since the canvas and the DOM resize independently they can be a frame out of sync.
 * Now the background is the **bottom-most layer** of the scene graph and the column width
 * comes from layout.ts alone.
 * (Text — labels/HUD/connect bar — stays in the DOM.)
 *
 * ⚠️ Colors: thorvg cannot read CSS variables, so the constants below are values we carry
 * by hand. Not all five of them are duplicates, though —
 *   · STAGE_MID / COLUMN_BG / DIVIDER **each hold the same values** as --bg / --bg-column /
 *     --line in `:root` of `src/styles.css`. Changing the theme means fixing both places
 *     (the same warning is attached on the styles.css side).
 *   · STAGE_TOP / STAGE_BOTTOM are the two ends of the gradient and **exist only on the
 *     canvas** — there are no corresponding CSS variables. They are --bg brightened and
 *     darkened one step, so if the palette changes just rebuild them here from --bg.
 */
import type { LinearGradient, Scene, Shape, ThorVGNamespace } from '@thorvg/webcanvas';
import { SESSION_COLUMN_WIDTH } from './layout.js';

/** RGB triple (alpha is always 255 — there is nothing for the background to show through to) */
type Rgb = readonly [number, number, number];

/* Copies of styles.css :root. The comment on the left is the corresponding CSS variable/value */
/** #1f211f — top of the gradient (--bg brightened one step) */
const STAGE_TOP: Rgb = [0x1f, 0x21, 0x1f];
/** #1a1b1a — --bg / --bg-stage */
const STAGE_MID: Rgb = [0x1a, 0x1b, 0x1a];
/** #151615 — bottom of the gradient (--bg darkened one step) */
const STAGE_BOTTOM: Rgb = [0x15, 0x16, 0x15];
/** #171817 — --bg-column */
const COLUMN_BG: Rgb = [0x17, 0x18, 0x17];
/** #2c2e2c — --line */
const DIVIDER: Rgb = [0x2c, 0x2e, 0x2c];

/**
 * Where the gradient's middle color sits — the 55% from the CSS
 * `radial-gradient(... 55% ...)`. The original is an elliptical vignette centered 32% down
 * from the top, but thorvg's RadialGradient only does true circles, so the ellipse cannot
 * be carried over as-is. What actually reads on screen is only the vertical light-to-dark
 * shading ("bright at the top, dark at the bottom"), so we approximate it with a
 * **vertical linear** gradient.
 */
const STAGE_MID_STOP = 0.55;

/** Thickness (px) of the divider on the left edge of the session column — `border-left: 1px` in styles.css */
const DIVIDER_WIDTH = 1;

export class Backdrop {
  readonly #tvg: ThorVGNamespace;
  readonly #scene: Scene;
  readonly #stage: Shape;
  readonly #column: Shape;
  readonly #divider: Shape;
  /** The current gradient — when the size changes we build a new one and dispose the previous */
  #gradient: LinearGradient | null = null;
  /** The dimensions we last drew. #syncToViewport runs on every membership change, so we skip when they are unchanged */
  #width = -1;
  #height = -1;
  #stageWidth = -1;

  /**
   * Unlike the nodes there is no async loading here (only shapes) — hence a plain
   * constructor rather than a static factory. The real dimensions arrive via resize().
   */
  constructor(tvg: ThorVGNamespace) {
    this.#tvg = tvg;
    this.#scene = new tvg.Scene();
    this.#stage = new tvg.Shape();
    this.#column = new tvg.Shape();
    this.#divider = new tvg.Shape();
    // add order = draw order: stage background → column background → divider
    this.#scene.add(this.#stage);
    this.#scene.add(this.#column);
    this.#scene.add(this.#divider);
  }

  /** The paint to add to the canvas **first** — it is the background, so always the bottom-most layer */
  get paint(): Scene {
    return this.#scene;
  }

  /**
   * Redraw to fit the viewport / column position. The coordinates are canvas (= screen)
   * space, so they are independent of the camera — however tall the world gets, the
   * session column is decoration that fills the screen height.
   */
  resize(width: number, height: number, stageWidth: number): void {
    if (width === this.#width && height === this.#height && stageWidth === this.#stageWidth) return;
    this.#width = width;
    this.#height = height;
    this.#stageWidth = stageWidth;

    // The vertical linear gradient is bound to the height, so rebuild it when the size changes
    const next = new this.#tvg.LinearGradient(0, 0, 0, height);
    next.setStops(
      [0, [...STAGE_TOP, 255]],
      [STAGE_MID_STOP, [...STAGE_MID, 255]],
      [1, [...STAGE_BOTTOM, 255]],
    );
    this.#stage.reset().appendRect(0, 0, width, height).fill(next);
    // The previous gradient is no longer referenced (this is after fill copied the stops into the shape)
    this.#gradient?.dispose();
    this.#gradient = next;

    this.#column
      .reset()
      .appendRect(stageWidth, 0, SESSION_COLUMN_WIDTH, height)
      .fill(...COLUMN_BG, 255);
    // The divider is a 1px rectangle, not a stroke — a stroke is drawn straddling the
    // path center half on each side, which produces half-pixel blur (we want a crisp 1px
    // just like a CSS border-left)
    this.#divider
      .reset()
      .appendRect(stageWidth, 0, DIVIDER_WIDTH, height)
      .fill(...DIVIDER, 255);
  }

  dispose(): void {
    this.#scene.remove(this.#stage);
    this.#scene.remove(this.#column);
    this.#scene.remove(this.#divider);
    this.#stage.dispose();
    this.#column.dispose();
    this.#divider.dispose();
    this.#gradient?.dispose();
    this.#gradient = null;
    this.#scene.dispose();
  }
}
