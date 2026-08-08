/**
 * Logic worker entry point — 60Hz fixed-tick simulation.
 * Rendering is exclusively the main thread's job (thorvg constraint), so all we do
 * here is advance state.
 *
 * In:      player_move / whip_swing (bus, PortTransport)
 * Out:     game_state_updated (every tick) / target_hit (on hit resolution) ·
 *          target_flinch (on entering the groggy state)
 * Control: init/geometry arriving via worker.postMessage (protocol.ts)
 */
/// <reference lib="webworker" />
import { Bus, PortTransport } from '../core/bus/index.js';
import type { WorkerControlMessage } from './protocol.js';
import {
  EMPTY_GEOMETRY,
  TICK_MS,
  applyMove,
  applySwing,
  createSimState,
  tick,
  toGameState,
  withGeometry,
} from './simulation.js';

const bus = new Bus('logic-worker');
let state = createSimState(EMPTY_GEOMETRY);
let loop: ReturnType<typeof setInterval> | null = null;

self.onmessage = (e: MessageEvent<WorkerControlMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      bus.addTransport(new PortTransport(msg.port));
      // createSimState fully reflects the geometry (x clamping + target creation)
      state = createSimState(msg.geometry);
      bus.subscribe('player_move', (ev) => {
        state = applyMove(state, ev.payload.direction, ev.payload.pressed);
      });
      bus.subscribe('whip_swing', () => {
        state = applySwing(state);
      });
      startLoop();
      break;
    }
    case 'geometry': {
      state = withGeometry(state, msg.geometry);
      break;
    }
  }
};

function startLoop(): void {
  if (loop !== null) return;
  let last = performance.now();
  let accumulator = 0;
  // setInterval is not accurate, so we consume the accumulated time in fixed steps.
  // If the tab goes to the background and comes back the accumulator explodes, so we cap the
  // number of steps.
  loop = setInterval(() => {
    const now = performance.now();
    accumulator += now - last;
    last = now;
    let steps = 0;
    while (accumulator >= TICK_MS && steps < 5) {
      accumulator -= TICK_MS;
      steps += 1;
      step();
    }
    if (accumulator > TICK_MS * 5) accumulator = 0;
  }, TICK_MS);
}

function step(): void {
  const result = tick(state);
  state = result.state;
  for (const sessionId of result.hits) {
    bus.broadcast('target_hit', { sessionId });
  }
  // Groggy entry — it comes not on the hit but on the tick the hit reaction **ends**, so the
  // same target never receives both events on the same tick (advanceTarget in simulation.ts)
  for (const sessionId of result.flinches) {
    bus.broadcast('target_flinch', { sessionId });
  }
  // High frequency — the subscriber side coalesces it (CLAUDE.md convention 3)
  bus.broadcast('game_state_updated', toGameState(state));
}
