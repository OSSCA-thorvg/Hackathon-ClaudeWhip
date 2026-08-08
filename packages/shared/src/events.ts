/**
 * The event contract module — components (the server adapter, the renderer, the logic worker)
 * never import each other; they share only this module.
 */
import type {
  Direction,
  PlayerState,
  ServerConnectionState,
  SessionInfo,
  TargetState,
} from './types.js';

/** Event name → payload type registry. Payloads must be structured-cloneable (a postMessage constraint). */
export interface EventMap {
  /** The full session snapshot sent by the server. Published with cache: true — late joiners grab it immediately via fetchCached */
  session_snapshot: { sessions: SessionInfo[] };
  session_started: { session: SessionInfo };
  session_ended: { sessionId: string };
  /**
   * A **client-only** event (the server never sends it — it's not in ServerEventName).
   * session/ws-adapter announces the socket lifecycle through this event, and the connection UI
   * subscribes to it. It lives in the bus contract so no direct adapter→UI reference is created.
   */
  server_connection_changed: { state: ServerConnectionState; url?: string; detail?: string };
  /** Key input → logic worker */
  player_move: { direction: Direction; pressed: boolean };
  whip_swing: Record<string, never>;
  /** Logic worker → renderer. High frequency, so subscribers must coalesce (once per frame) */
  game_state_updated: { player: PlayerState; targets: TargetState[] };
  /** The result of hit detection — triggers the hit reaction (the hit marker) */
  target_hit: { sessionId: string };
  /**
   * **Entering groggy.** This is not a miss — the
   * simulation publishes it the moment the hit reaction ends on a target whose consecutive-hit
   * streak reached the threshold (game/simulation.ts). So it isn't a detection result but a
   * **state transition driven by accumulated hits**, and it pairs with target_hit.
   *
   * Like target_hit it flows **logic worker → main**, and the server never sends it
   * (it's not in SERVER_EVENT_NAMES). A target can still be hit while groggy, so target_hit may
   * arrive again, and the animation then restarts from hit (render/target-node.ts).
   */
  target_flinch: { sessionId: string };
}

export type EventName = keyof EventMap & string;

/**
 * The subset of events that flow server → client over the WebSocket. Both ends share this envelope.
 * It's kept as a **value** because the receiving side (the client's session/ws-adapter) builds its
 * runtime whitelist Set from it. As a type alone, the same list would end up duplicated in the
 * validation code.
 */
export const SERVER_EVENT_NAMES = [
  'session_snapshot',
  'session_started',
  'session_ended',
] as const satisfies readonly EventName[];

export type ServerEventName = (typeof SERVER_EVENT_NAMES)[number];
/**
 * One wire frame.
 * ⚠️ Writing it as `GameEvent<ServerEventName>` makes name and payload independent unions
 * (non-distributive), so `switch (msg.name)` won't narrow the payload — we distribute it into a
 * discriminated union so the receiving side (ws-adapter) can republish without casting.
 */
export type WireMessage = { [N in ServerEventName]: GameEvent<N> }[ServerEventName];

/**
 * One wire frame, as a string. This is the only place framing (= envelope assembly + JSON
 * serialization) lives — the real server (packages/server) and the E2E fake bridge call the same
 * function, which structurally guarantees that the frames the tests imitate are byte-for-byte
 * identical to the real ones.
 *
 * ⚠️ Why the return type is string: for an open generic N you cannot annotate `WireMessage` (the
 * discriminated union over ServerEventName) — the compiler can't narrow the correlation between
 * N and payload to a single branch. Since N is constrained to ServerEventName, the serialized
 * value is always one branch of WireMessage, and the receiving side (the client's
 * session/ws-adapter) parses it as that union.
 */
export function wireFrame<N extends ServerEventName>(
  name: N,
  payload: EventMap[N],
  source: string,
): string {
  return JSON.stringify(makeGameEvent(name, payload, source));
}

export interface EventMeta {
  ts: number;
  /** Identifier of the publishing component (e.g. 'session-adapter', 'logic-worker') */
  source: string;
}

export interface GameEvent<N extends EventName = EventName> {
  name: N;
  payload: EventMap[N];
  meta: EventMeta;
}

/**
 * Builds one event envelope — the single assembler shared by every publish site (the server's
 * wire, the client's Bus.broadcast). `meta.ts` is stamped only here.
 */
export function makeGameEvent<N extends EventName>(
  name: N,
  payload: EventMap[N],
  source: string,
): GameEvent<N> {
  return { name, payload, meta: { ts: Date.now(), source } };
}

export interface SubscribeOptions {
  /**
   * Batching for high-frequency events — collects for maxWaitMs and delivers only the last event
   */
  coalesce?: { maxWaitMs: number };
}

/**
 * The event bus interface. The implementation lives in client/src/core/bus/.
 * The transport (Local/MessagePort) hides behind this interface —
 * component code never touches postMessage directly.
 */
export interface EventBus {
  /** With cache: true, the last event is retained keyed by event name */
  broadcast<N extends EventName>(
    name: N,
    payload: EventMap[N],
    opts?: { cache?: boolean },
  ): void;
  subscribe<N extends EventName>(
    name: N,
    handler: (ev: GameEvent<N>) => void,
    opts?: SubscribeOptions,
  ): () => void;
  /** Lets a late-joining subscriber get the last state immediately */
  fetchCached<N extends EventName>(name: N): GameEvent<N> | undefined;
}
