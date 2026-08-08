/**
 * The **global declaration** of the `window.__claudewhip` debug handle exposed by dev builds.
 *
 * The type itself is owned by the client (packages/client/src/debug-handle.ts) — main.ts assembles
 * the handle with that type, so `pnpm typecheck` catches any change in its shape right here.
 * We used to hand-write a second copy of the same shape, and because typing is structural the
 * drift went unnoticed.
 *
 * It doesn't exist in the production bundle, so it's declared **optional** — if a run accidentally
 * targets the prod bundle, blowing up on an `undefined` access is the better outcome.
 */
import type { ClaudeWhipDebug } from '../../packages/client/src/debug-handle.js';

export type {
  ClaudeWhipDebug,
  ClaudeWhipDebugState,
  DebugLogEntry,
} from '../../packages/client/src/debug-handle.js';

declare global {
  interface Window {
    __claudewhip?: ClaudeWhipDebug;
  }
}
