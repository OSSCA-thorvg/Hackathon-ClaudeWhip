/**
 * The single rAF loop — the one stage canvas is drawn here (never create a loop per node).
 *
 * game_state_updated arrives from the worker at 60Hz, which can be more often than frames.
 * Coalescing is already achieved by "keep only the latest value (overwrite latest) + apply
 * it once in the rAF callback" (CLAUDE.md convention 3), so we do not use the bus's
 * timer-based coalescing — that would only add latency.
 */
import type { EventBus, GameEvent } from '@claudewhip/shared';
import type { Stage } from './stage.js';

/** Cap dt, because when it explodes (returning to the tab, etc.) the animation jumps */
const MAX_DT_MS = 100;

export interface RenderLoopInit {
  bus: EventBus;
  stage: Stage;
}

export function startRenderLoop(init: RenderLoopInit): () => void {
  const { bus, stage } = init;

  let latest: GameEvent<'game_state_updated'>['payload'] | null = null;
  let prevSwinging = false;
  let running = true;
  let last = performance.now();
  let rafId = 0;

  // Even if several arrive within one frame, only the last survives (consumed by the rAF callback below)
  const unsubState = bus.subscribe('game_state_updated', (ev) => {
    latest = ev.payload;
  });

  // Hit/groggy effects are triggered by events, not by polling state (one occurrence =
  // one playback). The simulation decides the order and spacing of the two events
  // (3 consecutive hits → groggy); here we just pass them through to the node — only the
  // overwrite rules are the node's judgement (target-node.ts)
  const unsubHit = bus.subscribe('target_hit', (ev) => {
    stage.targets.get(ev.payload.sessionId)?.playHit();
  });
  const unsubFlinch = bus.subscribe('target_flinch', (ev) => {
    stage.targets.get(ev.payload.sessionId)?.playFlinch();
  });

  const frame = (now: number): void => {
    if (!running) return;
    const dt = Math.min(now - last, MAX_DT_MS);
    last = now;

    if (latest) {
      // Pass world coordinates straight through — subtracting the camera to place things
      // on screen is the stage's job
      stage.setPlayerState(
        latest.player.x,
        latest.player.y,
        latest.player.facing,
        latest.player.moving,
      );
      // Start the swing segment only on the false→true rising edge of swinging
      if (latest.player.swinging && !prevSwinging) stage.swingPlayer();
      prevSwinging = latest.player.swinging;
      // Consumed. If no new state arrives there is no reason to apply it again
      // (prevSwinging, which the edge detection needs, lives outside this block)
      latest = null;
    }

    stage.renderFrame(dt);

    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);

  return () => {
    running = false;
    cancelAnimationFrame(rafId);
    unsubState();
    unsubHit();
    unsubFlinch();
  };
}
