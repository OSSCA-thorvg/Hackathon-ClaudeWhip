/**
 * Bus transport contract — Bus touches postMessage only from behind this interface.
 * Component code has no reason to look at this file.
 */
import type { GameEvent } from '@claudewhip/shared';

/**
 * Transport envelope. The `cache` flag is a bus-internal concern rather than part of shared's
 * GameEvent contract, so it is carried only here — the point is to reproduce the broadcasting
 * side's `broadcast(..., { cache: true })` intent verbatim on the receiving bus (e.g. the far
 * side of the worker).
 */
export interface BusEnvelope {
  ev: GameEvent;
  cache: boolean;
}

export interface BusTransport {
  /** Send an event to the far side of this transport */
  send(env: BusEnvelope): void;
  /** Register the callback that receives events arriving from the far side (Bus calls this once in addTransport) */
  onReceive(cb: (env: BusEnvelope) => void): void;
  // Lifecycle (close/dispose) is not part of the contract yet — add it once Bus gains a dispose
  // and there is somewhere that actually tears the connection down (today the lifetime matches
  // the page/worker, so it is unnecessary).
}
