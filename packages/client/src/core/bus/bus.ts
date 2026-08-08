/**
 * EventBus implementation (the contract lives in shared). Rules:
 *  - a handler exception must never kill the dispatch loop (isolated by try/catch)
 *  - high-frequency events coalesce on the "subscriber side" — collect for maxWaitMs, deliver only the last one
 *  - a `cache: true` broadcast keeps the last event keyed by event name → fetchCached
 */
import {
  makeGameEvent,
  type EventBus,
  type EventMap,
  type EventName,
  type GameEvent,
  type SubscribeOptions,
} from '@claudewhip/shared';
import { LocalTransport } from './local-transport.js';
import type { BusEnvelope, BusTransport } from './transport.js';

/** Internal subscription record with the generics erased */
interface Subscription {
  handler: (ev: GameEvent) => void;
  coalesceMs: number | null;
  pending: GameEvent | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Bus implements EventBus {
  readonly #source: string;
  readonly #subs = new Map<EventName, Set<Subscription>>();
  readonly #cache = new Map<EventName, GameEvent>();
  readonly #transports: BusTransport[] = [];

  /** @param source identifier of the broadcasting component (rides along in EventMeta.source) */
  constructor(source: string) {
    this.#source = source;
    // local (same-thread) delivery is treated as just another transport
    this.addTransport(new LocalTransport());
  }

  /** Attach an extra transport, e.g. a worker connection. Events flow both ways from the moment it is attached */
  addTransport(transport: BusTransport): void {
    transport.onReceive((env) => this.#accept(env));
    this.#transports.push(transport);
  }

  broadcast<N extends EventName>(
    name: N,
    payload: EventMap[N],
    opts?: { cache?: boolean },
  ): void {
    const env: BusEnvelope = {
      ev: makeGameEvent(name, payload, this.#source) as GameEvent,
      cache: opts?.cache === true,
    };
    // LocalTransport comes first, so local handlers run first and only then does it go out to remotes
    for (const transport of this.#transports) {
      transport.send(env);
    }
  }

  subscribe<N extends EventName>(
    name: N,
    handler: (ev: GameEvent<N>) => void,
    opts?: SubscribeOptions,
  ): () => void {
    const sub: Subscription = {
      handler: handler as (ev: GameEvent) => void,
      coalesceMs: opts?.coalesce ? Math.max(0, opts.coalesce.maxWaitMs) : null,
      pending: null,
      timer: null,
    };
    let set = this.#subs.get(name);
    if (!set) {
      set = new Set<Subscription>();
      this.#subs.set(name, set);
    }
    set.add(sub);

    return () => {
      if (sub.timer !== null) {
        clearTimeout(sub.timer);
        sub.timer = null;
      }
      sub.pending = null;
      this.#subs.get(name)?.delete(sub);
    };
  }

  fetchCached<N extends EventName>(name: N): GameEvent<N> | undefined {
    return this.#cache.get(name) as GameEvent<N> | undefined;
  }

  /** Handle an event that arrived from a transport (including the local loopback) */
  #accept(env: BusEnvelope): void {
    if (env.cache) this.#cache.set(env.ev.name, env.ev);
    const set = this.#subs.get(env.ev.name);
    if (!set) return;
    // Safe even if a handler unsubscribes — JS Set iteration allows deletion mid-iteration
    // (a deleted element is skipped if it has not been visited yet), and only later additions
    // join the same iteration. We iterate directly without a snapshot to avoid copying an
    // array on every event (high frequency, 60Hz).
    for (const sub of set) {
      this.#deliver(sub, env.ev);
    }
  }

  #deliver(sub: Subscription, ev: GameEvent): void {
    if (sub.coalesceMs === null) {
      this.#safeCall(sub, ev);
      return;
    }
    // Coalescing: while the window is open, keep only the last event and drop the rest
    sub.pending = ev;
    if (sub.timer !== null) return;
    sub.timer = setTimeout(() => {
      sub.timer = null;
      const latest = sub.pending;
      sub.pending = null;
      if (latest) this.#safeCall(sub, latest);
    }, sub.coalesceMs);
  }

  #safeCall(sub: Subscription, ev: GameEvent): void {
    try {
      sub.handler(ev);
    } catch (err) {
      // Isolate so that one subscriber's exception does not spread to the remaining subscribers
      console.warn(`[bus] handler for "${ev.name}" threw`, err);
    }
  }
}
