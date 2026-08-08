/**
 * Character asset manifest — file paths are managed only here instead of being scattered through
 * the code. Swapping assets means changing only this file (+ the files under
 * public/assets/characters/) — assets must stay replaceable.
 *
 * v2 assets: the geometry and marker measurements originate
 * in `public/assets/characters/geometry.json` — the values below are a copy of it, and when the
 * assets are remade, geometry.json and this file must be updated together.
 *
 * Lottie marker convention: markers within a single file are switched via
 * LottieAnimation.segment(marker). Markers the game currently consumes: target
 * idle/working/hit/flinch, player idle/walk/swing. Only windup (player) is still unwired — the
 * mapping lives here even before it is wired so the render side never hardcodes marker names.
 * crack is not played as a marker; it is used solely as the basis for `swingActive` below.
 *
 * ⚠️ The **tick constants derived from marker lengths live here too** (`swingTicks`/
 * `swingActive`/`hitReactionTicks`/`flinchTicks`). They used to be hand-copied as numbers into
 * `game/simulation.ts`, and changing an asset silently desynced the two places. Now the
 * simulation reads these values, and the only mirroring left is the geometry.json ↔ this-file
 * pair (checked by `scripts/check-geometry.mjs`).
 *
 * ⚠️ `bodyBox` / `whipStrikeBox` below are the only geometry source for hit detection
 * (`game/hitbox.ts`). If you replace the assets you MUST re-measure them as well — there are no
 * reach constants left anywhere in the code.
 */

// The single source of truth for the box types is the detection side (game/hitbox.ts) — the
// values here feed straight into that detection, so declaring a second structurally identical
// type would let the two silently diverge. This is a type-only import, so it creates no runtime
// dependency (only the coordinate space differs: these are sprite-local).
import type { BodyHalfExtent, Box } from '../game/hitbox.js';

export const CHARACTER_ASSETS = {
  target: {
    lottie: '/assets/characters/claude-target-v2.json',
    /**
     * idle/working are state loops (session status); hit (30f) / flinch (60f) are one-shot
     * reactions. hit = the moment of being struck, flinch = **the groggy state entered after 3
     * consecutive hits** — it is NOT a near-miss. Which one plays when is decided by
     * game/simulation.ts.
     */
    markers: { idle: 'idle', working: 'working', hit: 'hit', flinch: 'flinch' },
    /**
     * Hit-reaction length (ticks = frames) — exactly the length of the 'hit' marker. The
     * simulation excludes the target from hit detection for this long (so rapid-fire swings do
     * not cut the reaction short, game/simulation.ts).
     */
    hitReactionTicks: 30,
    /**
     * Groggy length (ticks = frames) — exactly the length of the 'flinch' marker. The
     * simulation's groggy-state duration IS the animation duration, so the state and the marker
     * end at the same instant. A target can still be hit while groggy — the only window excluded
     * from detection is the hit window above.
     */
    flinchTicks: 60,
    /** Render canvas side length (px). Also the coordinate space the bodyCenter below lives in */
    canvasSize: 240,
    /** Body-center coordinate within the canvas (canvasSize square) — the hitbox/alignment origin */
    bodyCenter: { x: 120, y: 120 },
    /**
     * The body slab that counts as hittable — half-width/half-height (px) relative to bodyCenter.
     * Measured on v2 (geometry.json): a 126×63 slab. Arms, legs and eyes are excluded — if a whip
     * grazing the tip of an arm counted as a hit, the original "it connects when it clearly
     * didn't reach" complaint would come right back.
     */
    bodyBox: { halfW: 63, halfH: 31.5 } satisfies BodyHalfExtent,
  },
  player: {
    lottie: '/assets/characters/claude-player-v2.json',
    /**
     * idle/walk are state loops (whether the player is moving); swing is one-shot.
     * windup is still unwired (it lands if a charge mechanic appears); crack is not for playback
     * at all — it is the source of the swingActive window below.
     */
    markers: { idle: 'idle', walk: 'walk', windup: 'windup', swing: 'swing', crack: 'crack' },
    /**
     * The length of the walk loop that is **actually cycled** (frames, from the start of the
     * marker).
     *
     * The marker is 40f, but its tail is not walking — it is the transition into the
     * arm-raised pose of windup (absolute 100..130). The last keyframe (absolute 100) is not the
     * walk cycle's return pose but windup's starting pose (whip arm -6° → -105°). Looping the
     * marker as-is makes the player raise and lower the arm the whole time they walk, which
     * reads as a "carrying something" animation.
     *
     * 20 = absolute 60..80. Chosen by rendering frames one at a time and measuring them in
     * pixels:
     *  · Frame 20 is **pixel-identical** to frame 0 (mean abs diff 0.00) — there is no rewind
     *    seam at all. The cycle's real period is 20f, not 40f.
     *  · The arm raise starts at frames 34~35 (per-frame delta jumps ~2 → 9.7 → 13.4 → 19.9).
     *  · So 30 (absolute 90) avoids the arm raise but pops at the seam — frame 30's difference
     *    from frame 0 is the cycle maximum (10.3), so rewinding crams 10 frames' worth of motion
     *    into a single frame.
     *
     * ⚠️ Never set this larger than the marker length — render/lottie-node.ts clamps anything
     * beyond it.
     */
    walkLoopFrames: 20,
    /** Length of one swing (ticks = frames) — exactly the 'swing' marker length (46f@60fps ≈ 0.77s) */
    swingTicks: 46,
    /**
     * The active window — a frame range **relative** to the 'swing' segment. It is the 'crack'
     * marker (absolute 144..150) minus the swing start (130), and the whipStrikeBox below was
     * derived from exactly this range. The two must always move together.
     */
    swingActive: { begin: 14, end: 19 },
    /**
     * Render canvas side length (px). Larger than the target's (240) because at the moment of the
     * crack the whip lash extends ~255px to the right of the body center (see whipStrikeBox
     * below, tip at (359,256)).
     */
    canvasSize: 400,
    /**
     * Deliberately offset to the left to reserve the right/top margin the whip occupies (the body
     * is NOT at the center of the box). This value is the single source of truth for alignment,
     * the horizontal-flip pivot, the hitbox and spawning.
     */
    bodyCenter: { x: 104, y: 255 },
    /**
     * Whip strike box — in sprite-local coordinates (the canvasSize 400 box).
     * Measured on the v2 asset (geometry.json): the union AABB the lash occupies over the 'crack'
     * marker range (= 14..20 relative to the 'swing' segment; the active window in simulation.ts
     * is 14..19). As offsets from bodyCenter (104,255): dx [96, 255], dy [-47, 10].
     */
    whipStrikeBox: { x0: 200, y0: 208, x1: 359, y1: 265 } satisfies Box,
  },
} as const;
