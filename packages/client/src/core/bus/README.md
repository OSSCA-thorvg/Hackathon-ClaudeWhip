# core/bus — event bus implementation

This is where the implementation of `@claudewhip/shared`'s `EventBus` interface lives.

- `local-transport.ts` — same-thread `Map<name, Set<handler>>`
- `port-transport.ts` — a dedicated `MessagePort` per worker (logic worker ↔ main)
- `bus.ts` — transport composition + coalescing + cache (fetchCached) + handler try/catch isolation

Rules:
- a handler exception must never kill the dispatch loop (isolated by try/catch)
- high-frequency events (`game_state_updated`) are processed only once per frame — the render loop just overwrites the latest value in the handler and applies it in rAF (latest-wins). The bus's `coalesce` option (timer batching) is for subscribers whose handlers are heavy and that have no rAF loop
- `session_snapshot` is broadcast with `cache: true` — the cache is keyed by event name. A component created late gets the state immediately via `fetchCached('session_snapshot')`
