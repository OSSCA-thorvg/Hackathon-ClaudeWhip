/**
 * One scene-graph node = one Scene + one LottieAnimation.
 * A render-internal implementation shared by target-node / player-node (do not use it from outside).
 *
 * **It does not own a canvas** — there is only one canvas for the whole stage (stage.ts), and this
 * node merely owns one Scene that gets added to it. The rasterization moment is decided by the rAF
 * loop, not by the node (one canvas.update().render() per frame).
 *
 * There are only two state-transition APIs:
 *  - `setLoop(marker)` — the base state loop (target idle/working, player idle/walk)
 *  - `playOnce(marker)` — a one-shot reaction (swing, hit) after which it returns to **the current**
 *    loop marker
 * The node holds the loop marker itself, so even if the state changes during a reaction the return
 * point keeps itself up to date.
 * Calling `playOnce` again inside a `playOnce`'s onFinished **chains the reactions** — in that case
 * the last reaction is responsible for returning to the loop. (The target's hit/flinch does NOT
 * work this way: they are played separately from two events the simulation sends —
 * render/target-node.ts)
 *
 * thorvg pitfall countermeasures (CLAUDE.md is the single source):
 *  - `Animation.play()` is banned → the outer rAF loop supplies dt and all we do here is seek with frame()
 *  - `frame(n)` throws if n equals the current frame → guard on the last value set + defensive try/catch
 *  - after `segment(name)`, frame(n) is a segment-relative frame → compute the length directly from marker(begin,end)
 *  - `totalFrame()` does not exist at runtime → use info().totalFrames / info().fps
 */
import type {
  LottieAnimation,
  LottieMarker,
  Matrix,
  Picture,
  Scene,
  ThorVGNamespace,
} from '@thorvg/webcanvas';

interface Point {
  x: number;
  y: number;
}

/** Lower bound for the placement matrix's scale — 0 is a singular matrix */
const MIN_SCALE = 0.02;

export interface LottieNodeInit {
  tvg: ThorVGNamespace;
  lottieUrl: string;
  /** One side of the sprite box (px) — the manifest's canvasSize */
  size: number;
  /** The body center within the sprite box — the manifest's bodyCenter. The alignment/flip reference for place() */
  bodyCenter: Point;
}

type MarkerRange = Pick<LottieMarker, 'begin' | 'end'>;

/**
 * Per-URL memoization of the Lottie JSON — N targets share the same file, so fetching per node
 * would download the same file N times. Failures are not left in the cache.
 */
const lottieJsonCache = new Map<string, Promise<string>>();

function loadLottieJson(url: string): Promise<string> {
  const cached = lottieJsonCache.get(url);
  if (cached) return cached;
  const pending = fetch(url).then((res) => {
    if (!res.ok) throw new Error(`lottie load failed: ${url} (${res.status})`);
    return res.text();
  });
  lottieJsonCache.set(url, pending);
  pending.catch(() => lottieJsonCache.delete(url));
  return pending;
}

/**
 * Updates `out` in place so that the bodyCenter in sprite-local coordinates (0..size) lands on the
 * stage coordinates (centerX, centerY). The only components that change with placement are
 * e11/e22 (flip, scale) and e13/e23 (translation); the rest are identity, so one matrix is reused
 * per node (see #matrix below).
 *
 * ⚠️ The horizontal flip pivot: thorvg's `Paint.scale(f)` only does isotropic scale so it cannot
 * express scaleX(-1), and `origin()` is Picture-only. That is why we build the matrix by hand. The
 * flip axis must be **the vertical line through bodyCenter**, not the center of the sprite box, for
 * the body to stay in place (the player's bodyCenter.x = 104 ≠ 120, so flipping about the box
 * center is off by 32px).
 *   world.x = -local.x + (centerX + bodyCenter.x)
 *
 * The enter/exit pop (scale) is folded in here for the same reason — calling `Paint.scale()`
 * separately composes the transforms and breaks the bodyCenter pivot. The scale pivot is
 * bodyCenter too:
 *   world = s * (local - bodyCenter) + center
 */
function writePlacement(
  out: Matrix,
  centerX: number,
  centerY: number,
  bodyCenter: Point,
  flipX: boolean,
  scale: number,
): void {
  out.e11 = flipX ? -scale : scale;
  out.e22 = scale;
  out.e13 = flipX ? centerX + scale * bodyCenter.x : centerX - scale * bodyCenter.x;
  out.e23 = centerY - scale * bodyCenter.y;
}

export class LottieNode {
  readonly #scene: Scene;
  readonly #picture: Picture;
  readonly #anim: LottieAnimation;
  readonly #markers = new Map<string, MarkerRange>();
  readonly #fps: number;
  readonly #bodyCenter: Point;
  /**
   * Scratch placement matrix — we do not allocate a new object on every placement.
   * `Paint.transform()` copies the values into the WASM heap (Float32Array) and does not hold onto
   * the JS object, so overwriting this object after the call does not affect the transform already
   * applied to the scene.
   */
  readonly #matrix: Matrix = {
    e11: 1,
    e12: 0,
    e13: 0,
    e21: 0,
    e22: 1,
    e23: 0,
    e31: 0,
    e32: 0,
    e33: 1,
  };

  /** The last opacity set (0..255) — skip the WASM call when re-setting the same value */
  #alpha = 255;
  #segment: string | null = null;
  /**
   * The length (in frames) of the currently playing stretch. Usually the marker length, but shorter
   * when a **loop trim** is applied (see loopFrames in setLoop below) — both the rewind point and
   * the seek clamp look at this value.
   */
  #segmentFrames = 0;
  #loop = true;
  /** Elapsed frames within the segment (fractional) */
  #elapsed = 0;
  /** The last value passed to frame() — re-setting the same value throws (thorvg.web#216) */
  #lastFrame = -1;
  /**
   * The base (loop) marker — a one-shot reaction returns here when it finishes. If it changes
   * mid-reaction we just store the value and apply it at the return point (the case where the
   * target's working↔idle or the player's walk↔idle changes during a swing/hit).
   */
  #loopMarker: string | null = null;
  /** The trim length applied to the loop marker (null if none). The return must go back to the same length */
  #loopFrames: number | undefined;
  /** A playOnce is in progress — once a reaction starts it runs to the end (re-requests are ignored) */
  #busy = false;
  #onFinished: (() => void) | null = null;
  #disposed = false;

  private constructor(
    scene: Scene,
    picture: Picture,
    anim: LottieAnimation,
    fps: number,
    bodyCenter: Point,
  ) {
    this.#scene = scene;
    this.#picture = picture;
    this.#anim = anim;
    this.#fps = fps;
    this.#bodyCenter = bodyCenter;
  }

  static async create(init: LottieNodeInit): Promise<LottieNode> {
    const json = await loadLottieJson(init.lottieUrl);

    const anim = new init.tvg.LottieAnimation();
    anim.load(json);
    const picture = anim.picture;
    if (!picture) throw new Error(`lottie picture missing: ${init.lottieUrl}`);
    picture.size(init.size, init.size);

    // Position and flip are given exclusively through the Scene's matrix — we never touch the
    // picture's own transform (using both breaks the bodyCenter pivot math because of the
    // composition order).
    const scene = new init.tvg.Scene();
    scene.add(picture);

    const info = anim.info();
    const node = new LottieNode(
      scene,
      picture,
      anim,
      info?.fps && info.fps > 0 ? info.fps : 60,
      init.bodyCenter,
    );

    for (let i = 0; i < anim.markersCnt(); i += 1) {
      const marker = anim.marker(i);
      if (marker) node.#markers.set(marker.name, { begin: marker.begin, end: marker.end });
    }
    return node;
  }

  /** The paint to attach to the canvas (or to a parent scene) */
  get paint(): Scene {
    return this.#scene;
  }

  /**
   * Places the body center at the stage coordinates (centerX, centerY). With flipX, it mirrors
   * horizontally about the vertical line through bodyCenter. The placement is set from scratch
   * every time (transform() is a set, not an accumulation).
   * @param scale isotropic scale for the enter/exit pop (pivot = bodyCenter). Defaults to 1.
   */
  place(centerX: number, centerY: number, flipX: boolean, scale = 1): void {
    if (this.#disposed) return;
    // An exact 0 is a singular matrix and the renderer dislikes it — this stretch is at alpha 0 anyway, so we put a floor on it
    const safeScale = Math.max(scale, MIN_SCALE);
    writePlacement(this.#matrix, centerX, centerY, this.#bodyCenter, flipX, safeScale);
    this.#scene.transform(this.#matrix);
  }

  /** Whole-scene opacity (0..1). For the enter/exit fade */
  setAlpha(alpha: number): void {
    if (this.#disposed) return;
    const value = Math.round(Math.min(Math.max(alpha, 0), 1) * 255);
    if (value === this.#alpha) return;
    this.#alpha = value;
    this.#scene.opacity(value);
  }

  /**
   * The name of the segment currently playing (loop or one-shot alike). The inside of the canvas
   * cannot be inspected through the DOM, so this is the only window through which verification
   * (console/E2E) can confirm "what is playing" — Stage.stats() collects this value and exports it
   * through the dev handle.
   */
  get segment(): string | null {
    return this.#segment;
  }

  /**
   * The **segment-relative** frame currently playing within the segment (the last value seeked to).
   * The marker name alone cannot tell you whether the loop trim really took effect, so we export it
   * as well — verifying the walk trim means checking "does this value never exceed walkLoopFrames"
   * (Stage.stats()).
   */
  get frame(): number {
    return this.#lastFrame;
  }

  /**
   * The marker of the **one-shot reaction** currently playing. null while looping or once the
   * reaction has finished.
   * This is what the caller uses to judge "what am I about to overwrite" (e.g. a new hit is layered
   * on top of groggy (flinch), but hit is not layered on top of hit — render/target-node.ts).
   */
  get oneShot(): string | null {
    return this.#busy ? this.#segment : null;
  }

  /**
   * Sets the base state loop (target idle/working, player idle/walk).
   * The same marker is a no-op, and **while a one-shot reaction is playing it only reserves the
   * value** — when the reaction finishes it returns to this marker then. It is safe to feed the
   * state in every tick.
   *
   * @param loopFrames Loop only **this much from the front** of the marker (the whole marker if
   *   omitted). This exists for assets whose markers have transition frames into the next state
   *   tacked onto the end: the last 10f of the player's walk(40f) is the stretch that transitions
   *   into windup's raised-arm pose, so looping it as-is makes the player raise and lower their arm
   *   the whole time they walk.
   *   Instead of re-cutting the asset, we trim it at playback — the value's source is the manifest.
   */
  setLoop(marker: string, loopFrames?: number): void {
    if (this.#disposed) return;
    if (!this.#markers.has(marker)) return;
    this.#loopMarker = marker;
    this.#loopFrames = loopFrames;
    // Never cut off a reaction — playOnce's return path reads this value
    if (this.#busy) return;
    this.#play(marker, { loop: true, frames: this.#loopFrames });
  }

  /**
   * Play once, then return to the loop marker. A re-request while playing is ignored — once a
   * reaction starts it runs to the end.
   * @param opts.force **Overwrite** a reaction already playing (for higher-priority reactions).
   *   The overwritten one's onFinished is not called.
   * @returns whether the request was **accepted**. false means nothing happened (already playing,
   *   or the marker is not in the asset). If the caller does not use this value to gate the side
   *   effects that go with the reaction (label highlight, shake, etc.), you get the mismatch where
   *   nothing played but the effects fired anyway (render/target-node.ts).
   */
  playOnce(marker: string, opts: { force?: boolean; onFinished?: () => void } = {}): boolean {
    if (this.#disposed) return false;
    // No marker means no playback and no return — locking with busy would never unlock
    if (!this.#markers.has(marker)) return false;
    if (this.#busy && opts.force !== true) return false;
    this.#busy = true;
    this.#play(marker, {
      loop: false,
      restart: true,
      onFinished: () => {
        this.#busy = false;
        opts.onFinished?.();
        // If the callback started the next reaction right away, returning to the loop here would
        // overwrite that reaction on its very first frame — leave the return to the last chained reaction
        if (this.#busy) return;
        // The return target is the loop marker reserved **right now** — the state may have changed mid-reaction
        if (this.#loopMarker !== null) {
          this.#play(this.#loopMarker, { loop: true, restart: true, frames: this.#loopFrames });
        }
      },
    });
    return true;
  }

  /**
   * Segment switch. Requesting the same segment again is ignored (from the start if restart=true).
   * Not used from outside — the only state transitions are setLoop and playOnce.
   * @param opts.frames Playback length to use instead of the marker length (loop trim, see setLoop).
   *   It cannot be longer than the marker — thorvg merely clamps a frame() beyond the segment to
   *   the end, so giving a longer value only creates time spent sitting on the clamped last frame.
   * @param onFinished Called once when the last frame is reached, when loop=false
   */
  #play(
    marker: string,
    opts: { loop: boolean; frames?: number; restart?: boolean; onFinished?: () => void },
  ): void {
    if (this.#disposed) return;
    const range = this.#markers.get(marker);
    if (!range) return;
    if (this.#segment === marker && opts.restart !== true) return;

    this.#anim.segment(marker);
    this.#segment = marker;
    // Frames are segment-relative, so we derive the length directly from the marker range
    const markerFrames = range.end - range.begin;
    this.#segmentFrames = Math.max(1, Math.min(markerFrames, opts.frames ?? markerFrames));
    this.#loop = opts.loop;
    this.#onFinished = opts.onFinished ?? null;
    this.#elapsed = 0;
    this.#lastFrame = -1;
    this.#seek(0);
  }

  /** When the rAF loop supplies dt (ms), advance the animation clock */
  advance(dtMs: number): void {
    if (this.#disposed || this.#segment === null) return;
    this.#elapsed += (dtMs / 1000) * this.#fps;

    if (this.#elapsed >= this.#segmentFrames) {
      if (this.#loop) {
        this.#elapsed %= this.#segmentFrames;
      } else {
        this.#elapsed = this.#segmentFrames;
        this.#seek(this.#elapsed);
        const done = this.#onFinished;
        this.#onFinished = null;
        done?.();
        return;
      }
    }
    this.#seek(this.#elapsed);
  }

  /**
   * Detach from the scene and explicitly release the WASM memory.
   * Mind the order: the picture is owned by the animation, so unref (remove) it from the scene
   * first, then dispose in scene → animation order.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#scene.remove(this.#picture);
    this.#scene.dispose();
    this.#anim.dispose();
  }

  #seek(frame: number): void {
    // Segment-relative frame. The last frame is treated exclusively to avoid an end-of-range jump
    const target = Math.min(Math.max(frame, 0), this.#segmentFrames);
    if (target === this.#lastFrame) return; // re-setting the same value = throw
    this.#lastFrame = target;
    try {
      this.#anim.frame(target);
    } catch {
      // The thorvg.web#216 family — it throws when the value equals the internal current frame. Safe to ignore; the picture is identical.
    }
  }
}
