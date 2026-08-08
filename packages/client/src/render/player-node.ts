/**
 * Player character scene node. It runs the idle/walk loop depending on whether
 * it is moving, and on a swing it plays the swing segment once and then returns to
 * whichever loop is current **at that moment**.
 *
 * Position and horizontal flip are applied through the **scene node's transform matrix**,
 * not a CSS transform — because the character lives inside the canvas. The simulation owns
 * both x and y, and stage-local coordinates map 1:1 onto canvas pixel coordinates
 * (layout.ts), so the received values go straight in.
 *
 * ⚠️ The flip axis is not the middle of the sprite box but the vertical line through
 * bodyCenter — place() in lottie-node.ts is the single source of truth for the pivot math.
 */
import type { Direction } from '@claudewhip/shared';
import type { Scene, ThorVGNamespace } from '@thorvg/webcanvas';
import { CHARACTER_ASSETS } from '../assets/manifest.js';
import { LottieNode } from './lottie-node.js';

/** The manifest is the single source of truth for sprite size and body center (swapping the asset changes only that file) */
const ASSET = CHARACTER_ASSETS.player;

export class PlayerNode {
  readonly #node: LottieNode;
  #x = Number.NaN;
  #y = Number.NaN;
  #facing: Direction | null = null;
  /** The last moving flag we applied — loop switches happen only on edges (this arrives at 60Hz) */
  #moving = false;

  private constructor(node: LottieNode) {
    this.#node = node;
  }

  static async create(tvg: ThorVGNamespace): Promise<PlayerNode> {
    const node = await LottieNode.create({
      tvg,
      lottieUrl: ASSET.lottie,
      size: ASSET.canvasSize,
      bodyCenter: ASSET.bodyCenter,
    });
    node.setLoop(ASSET.markers.idle);
    return new PlayerNode(node);
  }

  /** The paint to add to the canvas. It must be added after the targets so the whip passes over the session column */
  get paint(): Scene {
    return this.#node.paint;
  }

  /** The marker currently playing — for verification (the canvas cannot be inspected through the DOM, see Stage.stats()) */
  get marker(): string | null {
    return this.#node.segment;
  }

  /** The segment-relative frame currently playing — the window for checking whether the walk loop trim took effect */
  get frame(): number {
    return this.#node.frame;
  }

  /** (x, y) = stage-local coordinates of the body center. facing is used only for the horizontal flip */
  setPosition(x: number, y: number, facing: Direction): void {
    if (x === this.#x && y === this.#y && facing === this.#facing) return;
    this.#x = x;
    this.#y = y;
    this.#facing = facing;
    // up/down do not change facing, so the flip applies only when it is 'left'
    this.#node.place(x, y, facing === 'left');
  }

  /**
   * walk loop while moving, idle loop otherwise. This arrives at 60Hz, so we
   * switch **only on edges** — calling setLoop every tick would be ignored by the node
   * (same marker), but the intent gets muddied.
   * If a swing is in progress the node merely reserves the value and applies it once the
   * swing finishes (walk < swing).
   *
   * walk cycles only the leading `walkLoopFrames` rather than the whole marker — the tail
   * of the marker is the transition into windup's raised-arm pose, so cycling it as-is
   * makes the character raise and lower its arm while walking (it reads as a "holding
   * something" animation). The trim length comes from the manifest.
   */
  setMoving(moving: boolean): void {
    if (moving === this.#moving) return;
    this.#moving = moving;
    if (moving) this.#node.setLoop(ASSET.markers.walk, ASSET.walkLoopFrames);
    else this.#node.setLoop(ASSET.markers.idle);
  }

  /** Play the swing once, then return to the current loop (idle/walk). Ignoring re-requests
   *  during playback is handled by the node (the state machine also lives in the worker;
   *  this is a second line of defense) */
  swing(): void {
    this.#node.playOnce(ASSET.markers.swing);
  }

  /** Advances only the animation clock — the stage rasterizes once per frame */
  tick(dtMs: number): void {
    this.#node.advance(dtMs);
  }

  dispose(): void {
    this.#node.dispose();
  }
}
