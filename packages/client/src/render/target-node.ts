/**
 * One session = one scene node. The target character stacked in the right-hand column.
 *
 * The state loop is decided by the **session status**: working → the working marker,
 * idle → idle. One-shot reactions are layered on top — `target_hit` → hit(30f), `target_flinch`
 * (groggy, entered after 3 consecutive hits) → flinch(60f). When either finishes it returns to
 * whatever status loop is current at that moment (it is safe for the status to change mid-
 * reaction). What arrives and when is decided by the simulation — the renderer merely plays the
 * two events separately and never chains reactions together (game/simulation.ts).
 *
 * Lifetime: when a session appears it **pops in** (scale 0→1 with overshoot), when it ends it
 * **fades out** and disappears. The animation is done purely with scene transform/opacity (no CSS
 * animation, no separate rAF) — progress comes in through tick(), and the stage checks `expired`
 * to know the exit has finished and detaches it from the canvas.
 *
 * Coordinates are held in **world** space and the camera offset is subtracted only when placing on
 * screen. The label does not apply the camera offset itself — the label layer container
 * is translated as a whole (stage.ts), so here we leave the world coordinates as they are.
 *
 * The label (a 2-line shell prompt block) is a DOM overlay rather than canvas — for text sharpness
 * and accessibility. Its width is fixed to the inside of the session column (layout.ts), and what
 * gets dropped on overflow is decided by prompt-label.ts.
 * String assembly is prompt-label.ts's job; colors/bold/cursor blinking are styles.css's.
 */
import type { SessionInfo } from '@claudewhip/shared';
import type { Scene, ThorVGNamespace } from '@thorvg/webcanvas';
import { CHARACTER_ASSETS } from '../assets/manifest.js';
import type { Camera } from './camera.js';
import { LABEL_GAP_PX, LABEL_WIDTH, type SlotPlacement } from './layout.js';
import { LottieNode } from './lottie-node.js';
import { PROMPT_TAIL, promptLabelParts } from './prompt-label.js';

/** The manifest is the single source of sprite size and body center (swapping the asset changes only this) */
const ASSET = CHARACTER_ASSETS.target;

/** Hit shake — 1.5 cycles of a damped sine layered onto the scene transform (this is not a CSS animation) */
const SHAKE_DURATION_MS = 280;
const SHAKE_AMPLITUDE_PX = 7;
const SHAKE_CYCLES = 1.5;

/** Enter (pop-in) / exit (fade-out) durations (ms) */
const ENTER_DURATION_MS = 260;
const EXIT_DURATION_MS = 200;
/** How much it shrinks while exiting */
const EXIT_SHRINK = 0.25;

/** Lifetime phase. gone = the exit animation is over and the stage may detach it */
type Phase = 'entering' | 'alive' | 'exiting' | 'gone';

interface LabelElements {
  root: HTMLElement;
  pathPrefix: Text;
  pathTail: HTMLElement;
  branch: HTMLElement;
}

/**
 * Label width (px) → how many characters fit on one line. The monospace width is **measured
 * empirically** — hardcoding it as a constant goes wrong the moment the font stack changes or the
 * system font differs. Measured once on the first label and cached.
 */
let monoCharWidthPx = 0;

function monoCharWidth(sample: HTMLElement): number {
  if (monoCharWidthPx > 0) return monoCharWidthPx;
  const FALLBACK = 6.6; // rough value for ui-monospace at 11px
  const ctx = document.createElement('canvas').getContext('2d');
  const font = getComputedStyle(sample).font;
  if (!ctx || font === '') return (monoCharWidthPx = FALLBACK);
  ctx.font = font;
  const width = ctx.measureText('0'.repeat(10)).width / 10;
  monoCharWidthPx = width > 0 ? width : FALLBACK;
  return monoCharWidthPx;
}

export interface TargetNodeInit {
  tvg: ThorVGNamespace;
  session: SessionInfo;
  /** The DOM layer the label attaches to (the container the camera offset is applied to, created by stage.ts) */
  overlay: HTMLElement;
  /** The owner of the world → screen transform (owned by stage.ts). The node only reads it */
  camera: Camera;
}

export class TargetNode {
  readonly sessionId: string;
  readonly #node: LottieNode;
  readonly #label: LabelElements;
  readonly #camera: Camera;

  /** The last session value received — when status/path changes, the label is reassembled from this same value */
  #session: SessionInfo;
  /** Has the first place() consumed the label width once and filled the content in (the width is a constant, so it never changes afterwards) */
  #labelPlaced = false;
  #centerX = 0;
  #centerY = 0;
  /** Top y of the sprite box (world) — used for the culling test */
  #boxY = 0;
  /** The last camera value applied. Used only to decide "does this need redrawing?", not for the transform math */
  #cameraY = 0;
  /** Detached from the scene because it is outside the viewport (managed by the stage) */
  #culled = false;
  /** Shake elapsed time (ms). Below 0 means it is not shaking */
  #shakeMs = -1;
  #phase: Phase = 'entering';
  /** Elapsed time in the current phase (ms) */
  #phaseMs = 0;
  /**
   * Exit start time (performance.now()). The exit alone is measured by the **wall clock** —
   * relying on tick() means a node that exits while culled never finishes (see the startExit
   * comment below).
   */
  #exitStartedAt = 0;
  #scale = 0;

  private constructor(
    session: SessionInfo,
    node: LottieNode,
    label: LabelElements,
    camera: Camera,
  ) {
    this.sessionId = session.sessionId;
    this.#session = session;
    this.#node = node;
    this.#label = label;
    this.#camera = camera;
  }

  static async create(init: TargetNodeInit): Promise<TargetNode> {
    const { session, overlay } = init;

    // The label's real width/position comes from the place() that follows shortly (layout.ts is the single source)
    const label = createLabel(session);
    overlay.appendChild(label.root);

    const node = await LottieNode.create({
      tvg: init.tvg,
      lottieUrl: ASSET.lottie,
      size: ASSET.canvasSize,
      bodyCenter: ASSET.bodyCenter,
    });
    node.setLoop(statusMarker(session.status));

    const target = new TargetNode(session, node, label, init.camera);
    // Start at the pop-in's starting point (transparent, scale 0) from the very first frame — this
    // is before place(), so the coordinates are still (0,0) and the label is still empty, but the
    // alpha is 0 so nothing is visible. The stage seats it into its slot with place() right away,
    // which supplies the real width (= character budget), and that is when the label content is first written
    target.#applyPhase();
    return target;
  }

  /** The paint to add to the canvas */
  get paint(): Scene {
    return this.#node.paint;
  }

  /** The marker being played — for verification (the canvas cannot be inspected through the DOM, see Stage.stats()) */
  get marker(): string | null {
    return this.#node.segment;
  }

  /** The sprite box's vertical world range — the input to the stage's culling test */
  get worldTop(): number {
    return this.#boxY;
  }

  get worldBottom(): number {
    return this.#boxY + ASSET.canvasSize;
  }

  /** Is it currently culled (the stage detached it from the scene and its clock is stopped too) */
  get culled(): boolean {
    return this.#culled;
  }

  /** Apply the layout result to the scene transform + label position (boot/resize/session change) */
  place(placement: SlotPlacement): void {
    this.#centerX = placement.centerX;
    this.#centerY = placement.centerY;
    this.#boxY = placement.boxY;
    // layout.ts is the source of the label geometry (position/width) — CSS only knows typography.
    // The label layer container already carries the camera offset, so here we use raw world y.
    this.#label.root.style.transform = `translate(${placement.labelX}px, ${placement.labelY}px)`;
    // The width is a constant derived from the column (LABEL_WIDTH), so not even a resize changes
    // it — we use it once on the first placement, and that is when the label content is first
    // filled in as well (at create time it is empty and its alpha is 0)
    if (!this.#labelPlaced) {
      this.#labelPlaced = true;
      this.#label.root.style.width = `${LABEL_WIDTH}px`;
      this.#writeLabel();
    }
    this.#applyTransform();
  }

  /** Called only on frames where the camera moved. A culled node applies it when it becomes visible again */
  setCameraY(cameraY: number): void {
    if (cameraY === this.#cameraY) return;
    this.#cameraY = cameraY;
    if (!this.#culled) this.#applyTransform();
  }

  /**
   * Whether it is outside the viewport. Detaching from and attaching to the scene is the stage's
   * job; here we hide the label and, when it becomes visible again, restore the transform with the
   * latest camera value.
   * While culled, tick() is not called, so the idle loop phase and the enter progress simply stay
   * frozen and then resume (it is fine if the state resets on re-entry).
   */
  setCulled(culled: boolean): void {
    if (culled === this.#culled) return;
    this.#culled = culled;
    this.#label.root.classList.toggle('is-culled', culled);
    if (!culled) this.#applyTransform();
  }

  /**
   * Session metadata update (working/idle status transition, etc.) — this is not a membership change.
   * The server sends a snapshot whenever something changes, but if the values actually visible in
   * the label are unchanged we do nothing — there is no reason to burn a width measurement + path
   * folding + DOM write once per session for nothing.
   */
  updateSession(session: SessionInfo): void {
    const prev = this.#session;
    // What we compare is **only the values actually visible in the label/animation**. summary does
    // not go into the shell prompt format (path + branch + `❯ claude █`), so we do not count it
    // here — the summary is a value the server refreshes frequently during a session, so including
    // it would be the one and only cause of a width measurement + path folding + DOM write running
    // once per session when nothing has actually changed.
    const statusChanged = prev.status !== session.status;
    const labelChanged =
      statusChanged || prev.cwd !== session.cwd || prev.gitBranch !== session.gitBranch;
    this.#session = session;
    // working↔idle swaps the loop marker. If a hit/flinch is playing, the node reserves it and uses
    // it as the return point the moment the reaction ends — it never cuts off a reaction in progress
    if (statusChanged) this.#node.setLoop(statusMarker(session.status));
    if (labelChanged) this.#writeLabel();
  }

  /**
   * Reassemble the label using the character budget derived from the label width.
   *
   * **This is the only place that subtracts the gap between the pieces.** Line 1 has just two
   * pieces (path and branch) so there is exactly one boundary, and line 2 (`❯ claude █`) is fixed
   * length so it does not enter the budget. prompt-label.ts only counts characters and knows
   * nothing about the gap — subtracting on both sides would shave off one cell twice.
   */
  #writeLabel(): void {
    const charWidth = monoCharWidth(this.#label.root);
    const usable = Math.max(0, LABEL_WIDTH - LABEL_GAP_PX);
    const maxChars = Math.max(1, Math.floor(usable / charWidth));
    writeLabel(this.#label, this.#session, maxChars);
  }

  /**
   * Hit reaction — play hit(30f) once, then return to the status loop current at that moment
   * (`target_hit`).
   *
   * **Re-trigger rule**: a re-request while hit is playing is ignored (so that mashing does not cut
   * off the impact frames). If groggy (flinch) is playing, it is **overwritten** — groggy is a
   * state in which the target can still be hit, so the simulation does not exclude it from
   * detection (hitbox.ts), and a hit that lands then restarts the reaction from hit.
   *
   * The shake (scene transform) and the label inverse (CSS) apply **only while hit is playing** —
   * during groggy the label returns to its normal style. Groggy is accumulated fatigue, not the
   * moment of impact, and a label inverted for the full 1.5 seconds would blur the "I just got
   * hit" signal.
   */
  playHit(): void {
    // A target on its way out is already excluded from hit detection — ignore late-arriving hits
    if (this.#phase === 'exiting' || this.#phase === 'gone') return;
    const accepted = this.#node.playOnce(ASSET.markers.hit, {
      // Layer on top of groggy = restart from the beginning. Do not layer on top of hit
      force: this.#node.oneShot === ASSET.markers.flinch,
      onFinished: () => this.#label.root.classList.remove('is-hit'),
    });
    // Side effects only **after it has been accepted** — applying just the shake/label to a rejected request desyncs them from the animation
    if (!accepted) return;
    this.#label.root.classList.add('is-hit');
    this.#shakeMs = 0;
  }

  /**
   * Groggy reaction — play flinch(60f) once, then return to the status loop (`target_flinch`).
   * It only arrives when consecutive hits reach the threshold and **the simulation declares the
   * state transition** (simulation.ts).
   *
   * ⚠️ Why `force: true`: this event comes out on the **exact tick** the hit reaction ends, but the
   * simulation clock (60Hz worker) and the render clock (rAF) can be a few frames apart, so the
   * last frames of hit may still be playing. Dropping the whole groggy over those few frames would
   * mean "I landed 3 in a row and nothing happened" — since it is a reaction meant to be chained on
   * anyway, overwriting is the right call.
   * Overwriting means hit's onFinished is never called, so the label inverse is cleared here directly.
   */
  playFlinch(): void {
    if (this.#phase === 'exiting' || this.#phase === 'gone') return;
    if (!this.#node.playOnce(ASSET.markers.flinch, { force: true })) return;
    this.#label.root.classList.remove('is-hit');
  }

  /**
   * The session ended — start the fade-out. Once `expired` turns true afterwards, the stage
   * detaches it.
   *
   * Exit progress is measured by the **wall clock**, not tick(). A culled node (= off-screen, so
   * detached from the scene) does not receive tick(), and if the session ends in that state a
   * tick-based timer never advances, so the node piled up in the stage's #exiting forever (a leak
   * we already hit). An off-screen node has no need to show a fade in the first place, so all it
   * needs to know from time is "when is it OK to disappear".
   */
  startExit(): void {
    if (this.#phase === 'exiting' || this.#phase === 'gone') return;
    this.#phase = 'exiting';
    this.#phaseMs = 0;
    this.#exitStartedAt = performance.now();
    this.#label.root.classList.remove('is-hit');
  }

  /**
   * Has the exit animation finished (the point at which the stage should canvas.remove + dispose).
   * Independent of whether ticks ran — even a node that exited while culled is guaranteed to be
   * reaped after EXIT_DURATION_MS.
   */
  get expired(): boolean {
    if (this.#phase !== 'exiting' && this.#phase !== 'gone') return false;
    return this.#exitElapsedMs() >= EXIT_DURATION_MS;
  }

  #exitElapsedMs(): number {
    return performance.now() - this.#exitStartedAt;
  }

  /** Advances the animation clock only — rasterization is done by the stage once per frame */
  tick(dtMs: number): void {
    this.#node.advance(dtMs);

    if (this.#shakeMs >= 0) {
      this.#shakeMs += dtMs;
      if (this.#shakeMs >= SHAKE_DURATION_MS) this.#shakeMs = -1;
    }

    // alive is a resting state — unless it is shaking, there is no reason to rewrite the matrix every frame
    if (this.#phase === 'alive') {
      if (this.#shakeMs >= 0) this.#applyTransform();
      return;
    }
    if (this.#phase === 'gone') return;

    this.#phaseMs += dtMs;
    this.#applyPhase();
  }

  dispose(): void {
    this.#node.dispose();
    this.#label.root.remove();
  }

  /** Advance the lifetime phase → apply scale/opacity (called only during the enter/exit stretches) */
  #applyPhase(): void {
    let alpha: number;
    if (this.#phase === 'exiting') {
      // The exit curve is wall-clock based too — it has to watch the same clock as `expired` so
      // that the moment the fade ends and the moment it is reaped do not diverge (a visible node
      // gets tick() here every frame)
      const t = Math.min(this.#exitElapsedMs() / EXIT_DURATION_MS, 1);
      this.#scale = 1 - EXIT_SHRINK * t;
      alpha = 1 - t;
      if (t >= 1) this.#phase = 'gone';
    } else {
      const t = Math.min(this.#phaseMs / ENTER_DURATION_MS, 1);
      this.#scale = easeOutBack(t);
      alpha = t;
      if (t >= 1) {
        this.#phase = 'alive';
        this.#scale = 1;
        alpha = 1;
      }
    }
    this.#node.setAlpha(alpha);
    // The label gets the same value — the text is DOM, but its fade curve must be one with the sprite's
    this.#label.root.style.opacity = alpha === 1 ? '' : String(alpha);
    this.#applyTransform();
  }

  #applyTransform(): void {
    // The shake only shakes "where it is drawn" — it does not touch the hitbox geometry (layout.ts)
    const offsetX = this.#shakeMs >= 0 ? shakeOffset(this.#shakeMs) : 0;
    // World → screen: only the vertical axis goes through the camera transform (there is no horizontal scrolling)
    this.#node.place(
      this.#centerX + offsetX,
      this.#camera.toScreenY(this.#centerY),
      false,
      this.#scale,
    );
  }
}

/**
 * Session status → state loop marker. A session the server judged to have "recent file
 * changes" should visibly be working — this is the character-side counterpart of the same signal as
 * the label's blinking cursor (styles.css).
 */
function statusMarker(status: SessionInfo['status']): string {
  return status === 'working' ? ASSET.markers.working : ASSET.markers.idle;
}

/** A pop that overshoots slightly and comes back (t: 0→1, s(0)=0, s(1)=1) */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/** Damped sine — from the starting amplitude down to 0 */
function shakeOffset(elapsedMs: number): number {
  const t = Math.min(elapsedMs / SHAKE_DURATION_MS, 1);
  return Math.sin(t * SHAKE_CYCLES * 2 * Math.PI) * SHAKE_AMPLITUDE_PX * (1 - t);
}

/**
 * The shell prompt label — a **2-line block**:
 *
 *     ~/…/sample-workspace feat/refactor
 *                          ❯ claude █
 *
 * Laid out on one line it would run outside the column (240px), so we split what may be shortened
 * (path, branch) from what must stay intact (`❯ claude █`) onto separate lines (see the label
 * geometry comments in layout.ts).
 *
 * Splitting it into a span per piece means an update only has to swap the piece (we do not redraw
 * with innerHTML every time — innerHTML is banned here in the first place, since this is where
 * server strings come in).
 * The cursor (█) is always present in the markup; whether it shows is decided by data-status
 * (styles.css).
 */
function createLabel(session: SessionInfo): LabelElements {
  const root = document.createElement('div');
  root.className = 'session-label';
  root.dataset['sessionId'] = session.sessionId;

  const pathLine = document.createElement('div');
  pathLine.className = 'session-label__line';

  const path = document.createElement('span');
  path.className = 'session-label__path';
  const pathPrefix = document.createTextNode('');
  const pathTail = document.createElement('span');
  pathTail.className = 'session-label__dir';
  path.append(pathPrefix, pathTail);

  const branch = document.createElement('span');
  branch.className = 'session-label__branch';
  pathLine.append(path, branch);

  // prompt-label.ts owns the string for the fixed token (`❯ claude █`) — the budget calculation and
  // the markup here have to look at the same value
  const promptLine = document.createElement('div');
  promptLine.className = 'session-label__line';

  const prompt = document.createElement('span');
  prompt.className = 'session-label__prompt';
  prompt.textContent = PROMPT_TAIL.prompt;

  const command = document.createElement('span');
  command.className = 'session-label__cmd';
  command.textContent = PROMPT_TAIL.command;

  const cursor = document.createElement('span');
  cursor.className = 'session-label__cursor';
  cursor.setAttribute('aria-hidden', 'true');
  cursor.textContent = PROMPT_TAIL.cursor;

  promptLine.append(prompt, command, cursor);
  root.append(pathLine, promptLine);

  // Hand it back with the content left empty — the real character budget only exists the moment
  // place() supplies the width, and until then the node has alpha 0 and is not on screen. Writing
  // it once with a provisional budget and then immediately rewriting it would only make the label
  // look off by one frame whenever the width differs.
  return { root, pathPrefix, pathTail, branch };
}

/** Session values → label pieces. Every string goes in through textContent only (innerHTML is banned) */
function writeLabel(label: LabelElements, session: SessionInfo, maxChars: number): void {
  const parts = promptLabelParts(session, maxChars);
  label.pathPrefix.data = parts.pathPrefix;
  label.pathTail.textContent = parts.pathTail;
  label.branch.textContent = parts.branch ?? '';
  // If there is no branch, collapse the span itself — otherwise the flex gap leaves an empty cell
  label.branch.hidden = parts.branch === null;
  // The cursor blinks only while working (styles.css reads this value)
  label.root.dataset['status'] = session.status;
}
