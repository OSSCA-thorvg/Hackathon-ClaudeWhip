/**
 * The stage = **a single canvas** covering the entire game area + a DOM text overlay on top of it.
 *
 * The canvas layer order is [backdrop → target layer → player]. The background decoration (stage
 * gradient / session columns) lives inside the canvas as well — there is no DOM `#backdrop`. All
 * that remains in the DOM is text.
 *
 * The characters (N targets + the player) go into this canvas's scene graph as Scene nodes.
 * Enter/exit = add/remove + dispose. Positions are computed by layout.ts and handed to the node as
 * a transform matrix.
 *
 * This is the render layer's only public entry point — main.ts uses just this class and the
 * render loop.
 *
 * **It boots with zero targets**: the session list only comes into existence after the
 * user connects to the bridge server, so the stage is built without waiting for a snapshot and
 * membership changes afterwards through `syncSessions`/`addTarget`/`removeTarget`. Because node
 * creation is async (Lottie fetch), membership changes are serialized through an internal queue —
 * even when a snapshot and a started event overlap, their order does not get flipped.
 *
 * ⚠️ thorvg Canvas takes a CSS selector only (it calls querySelector internally) → the canvas
 * element MUST have an id.
 */
import type { Direction, SessionInfo } from '@claudewhip/shared';
import type { Canvas, Scene, ThorVGNamespace } from '@thorvg/webcanvas';
import type { StageGeometry } from '../game/protocol.js';
import { Backdrop } from './backdrop.js';
import { Camera } from './camera.js';
import { SLOT_STEP, computeLayout, toStageGeometry, type StageLayout } from './layout.js';
import { PlayerNode } from './player-node.js';
import { TargetNode } from './target-node.js';

/**
 * Cull margin (px) — this much above and below the viewport is kept alive. At one slot pitch a
 * node is already attached to the scene just before it comes on screen, so no popping is visible
 * while scrolling.
 */
const CULL_MARGIN_PX = SLOT_STEP;

export interface StageInit {
  tvg: ThorVGNamespace;
  /** The canvas covering the entire game area. A unique id is required */
  canvasEl: HTMLCanvasElement;
  /** The DOM overlay where labels/HUD live (on top of the canvas) */
  overlayEl: HTMLElement;
}

/** Render stats for debugging/E2E (exposed by main.ts's dev handle) */
export interface StageStats {
  cameraY: number;
  worldHeight: number;
  viewportHeight: number;
  /** Number of targets attached to the scene = child count of the thorvg target layer */
  visibleTargets: number;
  culledTargets: string[];
  /** Number of nodes still fading out. In normal operation this returns to 0 within 200ms (leak watch) */
  exitingTargets: number;
  /** The marker the player is currently playing (idle/walk/swing) */
  playerMarker: string | null;
  /**
   * The **segment-relative** frame within that marker. Whether the walk loop is really trimmed
   * cannot be told from the marker name alone, so we report it too (it must never exceed the
   * manifest's walkLoopFrames).
   */
  playerFrame: number;
  /** The marker being played per session (idle/working/hit/flinch) */
  targetMarkers: Record<string, string | null>;
}

export class Stage {
  readonly #tvg: ThorVGNamespace;
  /** Label-only layer — apply the camera offset here once and all N labels move together */
  readonly #labelLayer: HTMLElement;
  readonly #canvas: Canvas;
  /** Background decoration (gradient + session columns). Added to the canvas first so it always sits at the bottom */
  readonly #backdrop: Backdrop;
  /**
   * Target-only layer. Adding [target layer, player] to the canvas in that order means the whip
   * always passes **over** the session columns no matter how many targets come and go — keeping
   * that order by detaching and re-attaching the player paint would be a dangerous bet on
   * refcounts.
   */
  readonly #targetLayer: Scene;
  /** Live targets (insertion order = slot order). Nodes on their way out are already gone from here */
  readonly #targets = new Map<string, TargetNode>();
  /** Nodes fading out — they have given their slot back but are still drawn */
  #exiting: TargetNode[] = [];
  /** The render list walked every frame (= live ones + exiting ones). Rebuilt only when membership changes */
  #renderList: TargetNode[] = [];
  readonly #player: PlayerNode;
  #layout: StageLayout;
  /**
   * The backing-store conditions last applied to the canvas. #syncToViewport runs on every
   * membership change, and if the size is unchanged a resize would only reallocate the backing
   * store and throw its contents away, so we skip it.
   * DPR is watched along with it — thorvg bakes DPR in at resize time, so moving the window to a
   * monitor with a different scale factor, changing DPR without changing size, is the one case
   * where "same size" still has to be re-applied.
   */
  #canvasWidth = -1;
  #canvasHeight = -1;
  #canvasDpr = 0;
  /** World → screen vertical offset. Render-only; the simulation does not know this value */
  readonly #camera = new Camera();
  /** The player's **world** coordinates as given by the simulation. Screen placement subtracts the camera every frame */
  #playerWorld: { x: number; y: number; facing: Direction };
  /** Serialization queue for async membership changes */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    tvg: ThorVGNamespace,
    labelLayer: HTMLElement,
    canvas: Canvas,
    backdrop: Backdrop,
    targetLayer: Scene,
    player: PlayerNode,
    layout: StageLayout,
  ) {
    this.#tvg = tvg;
    this.#labelLayer = labelLayer;
    this.#canvas = canvas;
    this.#backdrop = backdrop;
    this.#targetLayer = targetLayer;
    this.#player = player;
    this.#layout = layout;
    // The layout is the single source of the spawn coordinates — the simulation receives the same values as geometry
    this.#playerWorld = {
      x: layout.playerSpawnCenterX,
      y: layout.playerSpawnCenterY,
      facing: 'right',
    };
  }

  static async create(init: StageInit): Promise<Stage> {
    const { tvg, canvasEl, overlayEl } = init;
    if (!canvasEl.id) throw new Error('stage canvas needs a unique id (thorvg takes a selector)');

    const layout = computeLayout(viewportSize(), []);
    // The canvas is **screen space** — however long the world gets, it stays the size of the viewport
    const canvas = new tvg.Canvas(`#${canvasEl.id}`, {
      width: layout.canvasWidth,
      height: layout.viewportHeight,
    });

    const player = await PlayerNode.create(tvg);
    // add order = draw order. backdrop → target layer → player.
    // Even as culling attaches and detaches targets from the layer, this order lives at the canvas level so it never wobbles
    const backdrop = new Backdrop(tvg);
    canvas.add(backdrop.paint);
    const targetLayer = new tvg.Scene();
    canvas.add(targetLayer);
    canvas.add(player.paint);

    // Labels are gathered into a dedicated layer inside the overlay — camera movement is a single transform on this container
    const labelLayer = document.createElement('div');
    labelLayer.className = 'session-labels';
    overlayEl.appendChild(labelLayer);

    const stage = new Stage(tvg, labelLayer, canvas, backdrop, targetLayer, player, layout);
    stage.#syncToViewport();
    // Give the spawn position up front so the player is not visible at the top-left for the one frame before the first game_state_updated arrives
    stage.#placePlayer();
    return stage;
  }

  get targets(): ReadonlyMap<string, TargetNode> {
    return this.#targets;
  }

  /** The renderer that actually initialized ('gl' | 'sw') — for verification/debugging */
  get renderer(): string {
    return this.#canvas.renderer;
  }

  /** Geometry to send to the worker (contract: game/protocol.ts). This is the layout computation result, not a DOM measurement */
  geometry(): StageGeometry {
    return toStageGeometry(this.#layout);
  }

  /** Snapshot of camera/culling state — the canvas cannot be inspected through the DOM, so verification uses these values */
  stats(): StageStats {
    const culled: string[] = [];
    const targetMarkers: Record<string, string | null> = {};
    for (const [sessionId, node] of this.#targets) {
      if (node.culled) culled.push(sessionId);
      targetMarkers[sessionId] = node.marker;
    }
    // Nodes on their way out can end up culled too — those nodes are not attached to the layer
    const exitingInScene = this.#exiting.reduce((n, node) => (node.culled ? n : n + 1), 0);
    return {
      cameraY: this.#camera.y,
      worldHeight: this.#layout.worldHeight,
      viewportHeight: this.#layout.viewportHeight,
      visibleTargets: this.#targets.size - culled.length + exitingInScene,
      culledTargets: culled,
      exitingTargets: this.#exiting.length,
      playerMarker: this.#player.marker,
      playerFrame: this.#player.frame,
      targetMarkers,
    };
  }

  /**
   * Player state as given by the simulation (world coordinates). The actual placement happens in
   * renderFrame — while the camera keeps moving, the screen coordinates change even when no new
   * state arrives.
   */
  setPlayerState(x: number, y: number, facing: Direction, moving: boolean): void {
    // These arrive at 60Hz — update in place instead of allocating a new object every time
    this.#playerWorld.x = x;
    this.#playerWorld.y = y;
    this.#playerWorld.facing = facing;
    // Unlike position, the moving flag is **animation state** and has nothing to do with the
    // camera — there is no reason to wait for a frame, so pass it straight through (the node
    // transitions only on edges)
    this.#player.setMoving(moving);
  }

  /** Play one swing (the render loop calls this on the rising edge of swinging) */
  swingPlayer(): void {
    this.#player.swing();
  }

  /**
   * Reconcile the current target set against a whole snapshot: add what is missing (pop-in),
   * remove what disappeared (fade), leave the rest alone — **the existing order is preserved** and
   * only new sessions are appended so the slots do not shuffle (following the server snapshot
   * order verbatim would move characters wholesale whenever the list gets reordered).
   * @returns whether membership actually changed (the caller decides whether to re-send the worker geometry)
   */
  syncSessions(sessions: readonly SessionInfo[]): Promise<boolean> {
    return this.#enqueue(async () => {
      const wanted = new Map(sessions.map((s) => [s.sessionId, s]));
      let changed = false;

      for (const sessionId of [...this.#targets.keys()]) {
        if (wanted.has(sessionId)) continue;
        this.#beginExit(sessionId);
        changed = true;
      }
      for (const [sessionId, session] of wanted) {
        const existing = this.#targets.get(sessionId);
        if (existing) {
          // Membership is unchanged but the metadata can change (working↔idle, branch switch).
          // The server re-sends a snapshot whenever the state changes, so the label is refreshed here
          existing.updateSession(session);
          continue;
        }
        await this.#spawn(session);
        changed = true;
      }

      if (changed) this.#syncToViewport();
      return changed;
    });
  }

  /** One session enters (session_started). Does nothing if it already exists */
  addTarget(session: SessionInfo): Promise<boolean> {
    return this.#enqueue(async () => {
      if (this.#targets.has(session.sessionId)) return false;
      await this.#spawn(session);
      this.#syncToViewport();
      return true;
    });
  }

  /** One session leaves (session_ended). The node is actually released on the frame the fade ends */
  removeTarget(sessionId: string): Promise<boolean> {
    return this.#enqueue(async () => {
      if (!this.#beginExit(sessionId)) return false;
      this.#syncToViewport();
      return true;
    });
  }

  /** When the viewport changes, redo the canvas size + layout. Re-sending the geometry is the caller's job */
  resize(): void {
    this.#syncToViewport();
  }

  /**
   * One frame: advance every node's animation clock, then draw the canvas **exactly once**.
   * There is no per-canvas dirty flag — idle runs constantly anyway, so the whole thing is
   * refreshed every frame.
   */
  renderFrame(dtMs: number): void {
    // 1) Camera — it moves only while outside the dead zone. Re-place only on frames where it changed
    if (
      this.#camera.update(
        this.#playerWorld.y,
        this.#layout.viewportHeight,
        this.#layout.worldHeight,
        dtMs,
      )
    ) {
      this.#applyCamera();
    }
    // 2) Culled targets do not even get their clock advanced — frame seeking / marker lookup is
    //    skipped entirely. It does not matter if a node on its way out is culled: the reap time
    //    is decided by the wall clock (TargetNode.startExit) and there is no reason to show a
    //    fade off-screen
    for (const node of this.#renderList) {
      if (!node.culled) node.tick(dtMs);
    }
    this.#player.tick(dtMs);
    this.#placePlayer();
    if (this.#exiting.length > 0) this.#reapExited();
    this.#canvas.update().render();
  }

  dispose(): void {
    for (const node of this.#renderList) {
      // Culled nodes are already detached from the layer (do not call remove twice)
      if (!node.culled) this.#targetLayer.remove(node.paint);
      node.dispose();
    }
    this.#labelLayer.remove();
    this.#targets.clear();
    this.#exiting = [];
    this.#renderList = [];
    this.#canvas.remove(this.#backdrop.paint);
    this.#backdrop.dispose();
    this.#canvas.remove(this.#targetLayer);
    this.#targetLayer.dispose();
    this.#canvas.remove(this.#player.paint);
    this.#player.dispose();
    this.#canvas.destroy();
  }

  /** Serialize membership changes (including async node creation) in arrival order */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    // The queue has to keep flowing even if one task fails
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #spawn(session: SessionInfo): Promise<void> {
    const node = await TargetNode.create({
      tvg: this.#tvg,
      session,
      overlay: this.#labelLayer,
      camera: this.#camera,
    });
    node.setCameraY(this.#camera.y);
    this.#targets.set(session.sessionId, node);
    this.#targetLayer.add(node.paint);
  }

  /**
   * Free the slot immediately and start the fade-out. @returns whether it was a live target
   *
   * Culled (= off-screen) nodes are retired as they are — there is no reason to put them back
   * into the scene for a fade nobody sees, and reaping is decided by the wall clock, not by tick
   * (TargetNode.startExit).
   */
  #beginExit(sessionId: string): boolean {
    const node = this.#targets.get(sessionId);
    if (!node) return false;
    this.#targets.delete(sessionId);
    node.startExit();
    this.#exiting.push(node);
    return true;
  }

  /** Release nodes whose fade has finished from the canvas/memory (inside renderFrame, right before drawing) */
  #reapExited(): void {
    let reaped = false;
    for (const node of this.#exiting) {
      if (!node.expired) continue;
      if (!node.culled) this.#targetLayer.remove(node.paint);
      node.dispose();
      reaped = true;
    }
    if (!reaped) return;
    this.#exiting = this.#exiting.filter((node) => !node.expired);
    this.#rebuildRenderList();
  }

  /**
   * The common path for boot / resize / membership change: recompute layout → canvas size → node
   * placement. Slot order is the insertion order of #targets (Map preserves insertion order).
   * Nodes on their way out hold no slot, so they stay at their last position and vanish there.
   */
  #syncToViewport(): void {
    this.#layout = computeLayout(viewportSize(), [...this.#targets.keys()]);
    this.#resizeCanvasIfNeeded();
    // The backdrop follows the viewport too (Backdrop skips it on its own if the dimensions are unchanged)
    this.#backdrop.resize(
      this.#layout.canvasWidth,
      this.#layout.viewportHeight,
      this.#layout.stageWidth,
    );
    this.#rebuildRenderList();
    for (const placement of this.#layout.slots) {
      this.#targets.get(placement.sessionId)?.place(placement);
    }
    // The slot y values changed, so what is inside/outside the viewport changed too. The camera value itself is re-clamped next frame
    this.#applyCamera();
  }

  /** Re-establish the canvas backing store only when the size (or DPR) actually changed */
  #resizeCanvasIfNeeded(): void {
    const width = this.#layout.canvasWidth;
    const height = this.#layout.viewportHeight;
    const dpr = window.devicePixelRatio;
    if (width === this.#canvasWidth && height === this.#canvasHeight && dpr === this.#canvasDpr) {
      return;
    }
    this.#canvasWidth = width;
    this.#canvasHeight = height;
    this.#canvasDpr = dpr;
    this.#canvas.resize(width, height);
  }

  /** Apply the camera offset to sprites, labels and culling all at once */
  #applyCamera(): void {
    const cameraY = this.#camera.y;
    // Labels move as a single container (per-node style would shake the layout N labels' worth).
    // The label coordinates inside the container are raw world y, so we move the container to the screen position of the world origin
    this.#labelLayer.style.transform = `translate3d(0, ${this.#camera.toScreenY(0)}px, 0)`;
    this.#updateCulling();
    for (const node of this.#renderList) node.setCameraY(cameraY);
  }

  /**
   * Detach targets outside the viewport (+ margin) from the scene — this does not merely skip
   * drawing, it stops thorvg from traversing them at all. They are added back when they come back in.
   *
   * ⚠️ The z-order among targets gets shuffled by the re-add, but slots never overlap vertically
   * so it is invisible. The player always being on top is safe too — the player is added to the
   * **canvas** right after the target layer, and what we touch here is **inside** the layer.
   * Nodes on their way out are not handled here (they are already gone from #targets) — even if
   * they exit while culled, the wall clock guarantees they get reaped.
   */
  #updateCulling(): void {
    const { top, bottom } = this.#camera.visibleRange(this.#layout.viewportHeight, CULL_MARGIN_PX);
    for (const node of this.#targets.values()) {
      const visible = node.worldBottom > top && node.worldTop < bottom;
      if (visible !== node.culled) continue; // already in the desired state
      if (visible) this.#targetLayer.add(node.paint);
      else this.#targetLayer.remove(node.paint);
      node.setCulled(!visible);
    }
  }

  #rebuildRenderList(): void {
    this.#renderList = [...this.#targets.values(), ...this.#exiting];
  }

  /** World coordinates → screen coordinates. Recomputed every frame while the camera is moving */
  #placePlayer(): void {
    const { x, y, facing } = this.#playerWorld;
    this.#player.setPosition(x, this.#camera.toScreenY(y), facing);
  }
}

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}
