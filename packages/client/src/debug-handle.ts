/**
 * Type-only module that defines just the **shape** of the `window.__claudewhip` debug handle
 * (the assembly lives in main.ts).
 *
 * The canvas cannot be introspected through the DOM and the simulation lives inside the worker,
 * so the observation window for the console and E2E is this handle, not pixels.
 * It is not exposed in the production bundle (guarded by `import.meta.env.DEV` in main.ts).
 *
 * ⚠️ Why the type lives in this file and not in main.ts: E2E (e2e/fixtures/debug-handle.d.ts)
 * has to import the same type so that `pnpm typecheck` catches drift when the handle's
 * composition changes — but main.ts imports `./styles.css`, which the e2e tsconfig cannot open
 * because it has no vite ambient types. This file is pure types, so either side can open it.
 */
import type {
  EventBus,
  PlayerState,
  ServerConnectionState,
  TargetState,
} from '@claudewhip/shared';
import type { StageGeometry } from './game/protocol.js';
import type { StageStats } from './render/stage.js';

/** One recent event collected by the handle (payload differs per event, so it stays unnarrowed) */
export interface DebugLogEntry {
  name: string;
  payload: unknown;
  ts: number;
}

export interface ClaudeWhipDebugState {
  /** null until the first game_state_updated arrives */
  player: PlayerState | null;
  targets: TargetState[];
  /** The sessions the stage (render side) holds = the characters that actually exist on screen */
  sessionIds: string[];
  render: StageStats;
}

export interface ClaudeWhipDebug {
  /**
   * The main-thread bus itself. Used where 60Hz state is needed without coalescing (precise
   * movement control) — `state()` is a copy coalesced at 50ms, so it reacts a beat late
   * (e2e/fixtures/app.ts).
   */
  bus: EventBus;
  log: DebugLogEntry[];
  connection: { readonly state: ServerConnectionState };
  stage: { geometry(): StageGeometry };
  state(): ClaudeWhipDebugState;
}
