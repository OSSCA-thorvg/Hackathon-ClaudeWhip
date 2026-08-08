/**
 * Vertical camera — a single offset that moves world coordinates into screen
 * coordinates.
 *
 *     screen.y = world.y - camera.y
 *
 * **This is a render-only concept.** The simulation (game/) knows nothing about the
 * camera and runs purely in world coordinates — that is the only way hit detection
 * stays unaffected by screen scrolling.
 *
 * The follow rule is a **dead zone**: while the player's *screen* y stays inside the
 * viewport's 25%–75% band, the camera is completely still (so the screen does not
 * shake while you move only sideways or drift up and down a little). Once the player
 * leaves the band, the camera follows with exponential decay so the player lands back
 * on that band edge.
 *
 * ⚠️ Only integer px is exposed (the `y` getter rounds). Canvas sprites and DOM labels
 * must use the same offset or they look misaligned against each other, and label text
 * also blurs at subpixel positions. The decay itself is computed on the internal
 * floating-point value, so rounding never stalls the follow.
 */

/**
 * Dead-zone band (as a ratio of viewport height). The camera only moves once the
 * player leaves it — these are tuning values, but since they *are* the follow rule
 * itself they are exported (the tests derive their expectations from them).
 */
export const DEAD_ZONE_TOP_RATIO = 0.25;
export const DEAD_ZONE_BOTTOM_RATIO = 0.75;

/**
 * Exponential-decay time constant (ms). Every frame the camera closes
 * `1 - exp(-dt/τ)` of the remaining distance to the target — this is
 * framerate-independent (60fps or 144fps converge at the same rate).
 * At 90ms and a movement speed of 300px/s the player pushes ~27px past the band
 * before the camera catches up — the scroll is visible without feeling dragged.
 */
const FOLLOW_TAU_MS = 90;

/** Snap to the target once this little is left (cuts off the infinitely converging tail) */
const SNAP_EPSILON_PX = 0.5;

export class Camera {
  /** Floating-point internal value — it only ever leaves this class rounded */
  #exact = 0;
  #rounded = 0;

  /** Current camera offset (px, integer). Just subtract it for the world → screen transform */
  get y(): number {
    return this.#rounded;
  }

  /**
   * World y → screen y. The only place the `screen.y = world.y - camera.y` transform
   * lives — subtracting it by hand all over the render code means one wrong sign
   * silently drifts out of alignment.
   */
  toScreenY(worldY: number): number {
    return worldY - this.#rounded;
  }

  /**
   * The **world** y range currently covering the screen (+ margin). This is the input
   * to culling. Widening it by `margin` above and below means nodes are already ready
   * before they come on screen.
   */
  visibleRange(viewportHeight: number, margin: number): { top: number; bottom: number } {
    return {
      top: this.#rounded - margin,
      bottom: this.#rounded + viewportHeight + margin,
    };
  }

  /**
   * Advance one frame. If the world is shorter than the viewport the scroll range is 0,
   * so the camera always sits at 0.
   * @returns whether the exposed (integer) value changed — you only need to reposition
   *          nodes/labels on the frames where it did
   */
  update(
    playerWorldY: number,
    viewportHeight: number,
    worldHeight: number,
    dtMs: number,
  ): boolean {
    const maxY = Math.max(0, worldHeight - viewportHeight);
    const screenY = playerWorldY - this.#exact;
    const top = viewportHeight * DEAD_ZONE_TOP_RATIO;
    const bottom = viewportHeight * DEAD_ZONE_BOTTOM_RATIO;

    // Inside the dead zone the target is the current value (camera stands still)
    let desired = this.#exact;
    if (screenY < top) desired = playerWorldY - top;
    else if (screenY > bottom) desired = playerWorldY - bottom;
    desired = clamp(desired, 0, maxY);

    const k = 1 - Math.exp(-Math.max(dtMs, 0) / FOLLOW_TAU_MS);
    let next = this.#exact + (desired - this.#exact) * k;
    if (Math.abs(desired - next) < SNAP_EPSILON_PX) next = desired;
    // If the world shrinks (resize / fewer sessions) the camera can be left out of range
    // regardless of the dead zone — pull it back immediately
    next = clamp(next, 0, maxY);

    this.#exact = next;
    const rounded = Math.round(next);
    if (rounded === this.#rounded) return false;
    this.#rounded = rounded;
    return true;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
