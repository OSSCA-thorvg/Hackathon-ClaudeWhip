# ClaudeWhip

Hackathon project. Browser game: **as many Claude-looking characters as there are active Claude Code sessions on this machine line up vertically on the right side of the screen, and the player (also Claude-looking) can swing a whip to hit them.** Hits are visual effects only — no effect on the real sessions.

Original requirements: `REQUIREMENT.md` · Planning/decision history: `.wayfinder/map.md`

## Architecture (summary)

```
┌─ packages/server (Node) ─────────────┐      ┌─ packages/client (browser, Vite) ───────────────┐
│ session-monitor: 1s polling          │  WS  │ session/ws-adapter ─┐                           │
│  ps scan (claude --session-id)       │─────▶│                     ▼                           │
│  + ~/.claude/projects/*.jsonl mtime  │ :8787│            [EventBus (shared contract)]         │
│  + Agent SDK metadata enrichment     │      │              ▲              ▲          ▲        │
└──────────────────────────────────────┘      │   input/keyboard   game/logic.worker  render/*  │
                                              │   (main thread)    (Web Worker,       (main,    │
                                              │                     60Hz simulation)  thorvg)   │
                                              └─────────────────────────────────────────────────┘
```

Why this structure is fully documented in **`docs/adr/index.html`** (just open it in a browser). The essentials only:

| Decision | Rationale | ADR |
|---|---|---|
| Node bridge server + browser, 2-tier | The Agent SDK is Node-only (CLI subprocess model); it cannot run in a browser | 0001 |
| Typed event bus | Components share only the event contract from `@claudewhip/shared`; importing one another is forbidden | 0002 |
| Rendering = main thread, game logic = worker | thorvg webcanvas does not support OffscreenCanvas/workers (official issues #225/#287) | 0003 |
| Session detection = ps scan + jsonl mtime + SDK | Only process existence is a trustworthy signal of "active" (empirically demonstrated on this machine) | 0004 |
| Single canvas + Scene per entity + 'gl' | User intent (N characters inside 1 canvas). With a single canvas the WebGL context cap is irrelevant → 'gl' | 0006 (supersedes 0005) |
| World coordinates + deadzone camera + viewport culling | Even when there are more sessions than fit the screen, all of them must exist. The camera is render-only — hit detection does not know about the camera | 0008 |
| Server optional + manual connect | Static hosting (GH Pages) is the premise — no auto-connect, boot with 0 targets, membership is entirely events | 0007 |
| Unit = pure modules (node), E2E = fake bridge + `__claudewhip` handle | Depending on real sessions is nondeterministic — the fake bridge shares `wireFrame` with the real server, and expected values are derived from the manifest/exports (no copied numbers) | 0009 |

## Folder structure

```
packages/
  shared/   Event contract (EventMap) and types — shared by server/client. Add new events to the EventMap here
  server/   Bridge server. session-monitor (detection) → WebSocket push (:8787)
  client/   Vite app
    src/core/bus/   EventBus implementation (Local/Port transport, coalescing, fetchCached)
    src/session/    Server boundary — WS adapter + top connection bar UI. The only place that knows the protocol
    src/render/     thorvg rendering — main thread only, do not move it into a worker
    src/game/       Logic worker — keep the simulation as pure functions
    src/input/      Keyboard → event publishing
    src/assets/     manifest.ts — asset paths / marker mappings live only here
    public/assets/characters/   Lottie files (must be replaceable)
docs/adr/   ADR HTML collection (index.html is the list) — REQUIREMENT must-have
.wayfinder/ Planning map + decision tickets (all research evidence is here)
```

The README.md in each `src/*` directory has that component's implementation guide and caveats.

## Commands

```bash
pnpm install           # from the root (pnpm workspaces — do not use npm)
pnpm dev               # server (:8787) + client (:5173) at the same time
pnpm dev:client        # client only
pnpm typecheck         # typecheck every workspace (+ e2e tsconfig)
pnpm test              # Vitest unit tests (src/**/*.test.ts, all in the node environment — if you need the DOM, the target selection is wrong)
pnpm test:e2e          # Playwright E2E (e2e/*.spec.ts — auto-starts the vite dev server + injects the fake bridge WS, ticket 017)
```

pnpm caveat: if a new native dependency requires build scripts, it must be added to `allowBuilds` in `pnpm-workspace.yaml` (esbuild is already registered).

## Conventions & rules

1. **Whenever you make an architecture decision, you must leave an ADR**: copy `docs/adr/template.html` → write it → add it to the `index.html` list. When overturning an existing decision, change the existing ADR's status to Superseded and link to it from the new ADR.
2. **Communication between components is EventBus only**: the renderer must not import the worker, nor the adapter the renderer, directly. For a new event, add the type to `EventMap` in `shared/src/events.ts` first.
3. **Coalesce high-frequency events on the subscriber side**: `game_state_updated` is processed only once per frame.
4. **Do not hardcode asset paths in code**: modify only `client/src/assets/manifest.ts`.
5. Planning-level work (deciding the direction of a new feature, etc.) follows the ticket flow in `.wayfinder/map.md` — open tickets are the files with `status: open` under `.wayfinder/tickets/`.

## Pitfalls (already stepped on — do not repeat)

- **thorvg WASM loads from the unpkg CDN by default.** You must use the local bundle via `import wasmUrl from '@thorvg/webcanvas/dist/thorvg.wasm?url'` + `init({ locateFile })`. Otherwise it dies in an offline demo.
- **But that deep import does not go through as-is** (@thorvg/webcanvas 1.1.0 + vite 8): package.json `exports` only exposes `.` and `./thread`, so the dev server 500s (`"./dist/thorvg.wasm" is not exported under the conditions [...]`). Work around it with the `resolve.alias` regex in `packages/client/vite.config.ts` (`/^@thorvg\/webcanvas\/dist\/thorvg\.wasm/` → the real path back-derived via `require.resolve`). **`tsc` cannot catch this** — `?url` is matched by vite/client's ambient module declaration and passes without path validation, so typecheck passing ≠ loading successfully. Verify it in the browser.
- **`TVG.Canvas` only accepts a CSS selector** (it calls `document.querySelector` internally). A unique id on the canvas element is mandatory. Passing an OffscreenCanvas/HTMLCanvasElement is not possible.
- **Do not delete `optimizeDeps.exclude: ['@thorvg/webcanvas']` in `vite.config.ts`** — the Emscripten glue depends on `import.meta.url`.
- **Do not use `Animation.play()`** — seek with `frame()` in our own rAF loop.
- **`anim.frame(n)` throws if n equals the current frame** (measured during asset validation; the general form of thorvg.web#216). It blows up on the first `frame(0)` right after load and in a paused loop — a guard against re-setting the same value is mandatory.
- **`frame(n)` after `segment(name)` is a segment-relative frame** (absolute frame = marker.begin + n). Values exceeding the segment length are clamped to the end, but the `frame()` getter returns the raw value you set, so do not use it as evidence of the rendered frame. `segment(null)` returns to the full timeline.
- **`Animation.totalFrame()` exists only in the docs and not in the runtime (1.1.0)** — use `totalFrames` from `anim.info()`.
- **A marker's last keyframe is sometimes not the cycle's return pose but the next marker's starting pose** (measured on the v2 walk: the real walk cycle of the 40f marker is 20f, and from 34f it enters the windup motion). Looping the whole marker replays the transition motion every cycle — cut it and loop with `LottieNode.setLoop(marker, loopFrames)`, and find the length to cut by frame pixel diff (see manifest `walkLoopFrames`).
- **The player asset's body center is not the box center** — on v2 it is (104,255) and the sprite box is a 400 square (margin for the whip to extend to the right and upward). The target is (120,120) with a 240 box. For alignment, flip pivot, and hitboxes you must use `bodyCenter` from `assets/manifest.ts` — assuming both sprites share the same center will be off.
- **The renderer is decided globally once in `init()`** — currently `'gl'`, with an `'sw'` fallback on failure (`render/thorvg.ts`, ADR-0006).
- **`Paint.scale(f)` only accepts an isotropic scale (a single float)** — a `scaleX(-1)` flip is not possible. Horizontal flipping goes through building a `Matrix` and applying it with `transform()`. The flip pivot is not the box center but `bodyCenter.x` (otherwise the player is off by 32px) — the matrix formula is `placementMatrix()` in `render/lottie-node.ts`.
- **`transform(matrix)` is an absolute SET** — the TSDoc says "it is multiplied into the existing transform", but in reality it is `set_transform`. Calling it every frame does not accumulate (which is why it is safe).
- **`Paint.origin(x,y)` is effectively Picture-only** — do not use it for a Scene pivot; compute with a matrix instead.
- **`canvas.update()` is mandatory even on frames where only transform/frame changed** — only add/remove set the internal dirty flag; transform and frame changes do not. `Stage.renderFrame()` guarantees one `update().render()` per frame.
- **Scene teardown order**: `scene.remove(picture)` → `scene.dispose()` → `anim.dispose()` (the picture is owned by the Animation, so do not dispose it directly).
- **Do not use the thorvg `/thread` build** — unstable + requires COOP/COEP + packaging defects (ADR-0003).
- **All coordinates are world coordinates. The camera is render-only** (ADR-0008). `screen.y = world.y - camera.y`, and this transform happens only in `render/stage.ts`. Dragging the camera into the simulation or hitboxes creates the bug where "hit detection changes depending on the screen scroll position". `StageGeometry.worldHeight` is **not** the viewport height.
- **Culled nodes skip `tick()` → do not use tick-counted timers for exit.** Previously, if a session ended while culled, `expired` would never arrive and nodes piled up in `#exiting` forever (we actually hit this). Now `TargetNode.startExit()` stamps `performance.now()` and `expired` is judged by **wall-clock** elapsed time — off-screen nodes do not need to show a fade, so all we need to know is "when is it OK to reclaim it". (That is why the "put it back into the scene" guard in `#beginExit` is gone. Do not resurrect it.) The same pitfall applies as-is when you attach a new lifetime timer to a node.
- **With thorvg, putting a paint back with `add` after `Scene.remove(paint)` is safe** — because the JS binding's `add` explicitly calls `_tvg_paint_ref()` and `remove` only undoes that reference (the wrapper holds its own reference separately). However, **detaching and re-attaching for canvas-level draw order is still forbidden** — what culling touches is inside `targetLayer`, and the player is attached to the canvas so it is always on top.
- **Do not leave label truncation to CSS.** `text-overflow: ellipsis` cuts the **end**, but the part of a prompt label that must survive is the end (`❯ claude █`). Width → character-count budget → middle-folding the path (`~/…/name`) is handled in TS by `render/prompt-label.ts`. Do not hardcode the character width as a constant; measure it (`monoCharWidth` in `target-node.ts`).
- **Session labels must be laid underneath the top chrome** — when the camera scrolls down, labels pass through where the connection bar is. `.session-labels { z-index: 0 }` vs `.hud`/`.connect-bar` `{ z-index: 1 }`.
- **Session detection (v2) depends on Claude Code's internal implementation in three ways** — if it breaks, check the constants at the top of `server/src/session-monitor.ts` first: `CLAUDE_CLI_BASENAME` (only processes whose executable basename is exactly `claude` are candidates — do not match against the whole command-line string; that catches other people's processes that merely have 'claude' in their arguments), `INFRA_SUBCOMMANDS` (excluded if argv[1] is `bg-spare`/`bg-pty-host`/`daemon`, etc.), `SESSION_ID_FLAGS` (`--session-id`/`--resume`). **It is normal for a session to have no session ID on the command line** (interactive `claude --settings …`, the VS Code extension) — in that case map the cwd obtained via `lsof -d cwd` → the most recent unassigned `.jsonl` in the project directory, and if that is missing too, stand up a character with a synthetic `pid-<pid>` ID. The rationale and empirical evidence are in the Amendment of ADR-0004. (v1's `SESSION_PS_PATTERN` is gone.)
- **There really are sessions for which the server could not recover `cwd` (empty string)** — the label goes entirely blank, so `shortLabel` in `target-node.ts` falls back to the leading characters of the session id. Do not assume session fields are always filled in.
- **A wrong WS address is not an error but an infinite wait** — the browser interprets a scheme-less string as a relative path against the page URL and tries to connect to the dev server itself (`not a url` → `ws://localhost:5173/not%20a%20url`), and that socket stays in CONNECTING. Without `CONNECT_TIMEOUT_MS` in `ws-adapter.ts`, the UI gets stuck at "Connecting…".
- **Do not use `WireMessage` as an annotation inside a generic function** — it is a `{[N in ServerEventName]: GameEvent<N>}[...]` discriminated union, so for an open N it does not narrow to any branch (the server's `wire()` is annotated as `GameEvent<N>`). On the receiving side, thanks to this union, `switch (msg.name)` narrows the payload.
- **thorvg bakes DPR in at `Canvas` creation / `resize` time** — if the DPR alone changes without a resize event, such as moving the window to a monitor with a different DPR, the backing store stays at the stale scale, the screen stretches, and GL compositing artifacts appear. If you suspect this, compare `window.devicePixelRatio` × the CSS size against `canvas.width/height` (a single `resize` event resolves it).
- Do not import the Agent SDK in the client — either the bundle itself fails or it dies at runtime.

## Current status (2026-08-03)

> Tickets 013 (virtual scroll camera + culling) / 014 (terminal theme) / 015 (v2 marker wiring + moving the backdrop into the canvas) are reflected.
> The coordinate system is world space (ADR-0008), and session labels are shell prompt lines (`~/Documents/x main ❯ claude █`, a block cursor when working).

**It works end-to-end with real sessions** (ticket 011). Bring up the server and the actual Claude Code sessions on this machine appear as characters:

- `core/bus` (Local/Port transport + coalescing + fetchCached), `game/` (60Hz worker simulation), `render/` (a single thorvg 'gl' canvas + a Scene node per character + a single rAF — ADR-0006, details in render/README.md), `input/` (↑↓←→/Space) are implemented.
- **The server is optional** (ADR-0007). The mock adapter is gone. 0 targets at boot — the player still moves and swings in that state. Session characters pop in only once you enter the bridge address in the top bar and connect. When it disconnects (manually / server death) targets fade out, and when a backoff retry succeeds they come back.
- Session membership is entirely events. However, **the only path by which the client changes membership is `session_snapshot` reconciliation** — the server always re-sends a snapshot whenever a session comes or goes (the change signature includes session ids), so if you also subscribe to `session_started`/`session_ended`, Stage synchronization and worker geometry re-sends happen twice each. Both events remain as-is in the contract and in the server's publishing (a signal telling you what happened). There is no "session list at boot time" in main.ts.
- Development builds have a `window.__claudewhip` debug handle (`bus`/`stage`/`connection`/recent event `log`/`state()`) — so the console and E2E can verify state without looking at the canvas with their eyes. It is not in the production bundle.
- The worker cannot see the DOM, so stage/slot coordinates are fed in by main via the init/geometry control messages in `game/protocol.ts` (channel-separated from bus traffic).
- Hit rule (precise, ticket 012): **AABB overlap of the crack frame's whip box × the target's body box** — every overlapping target is hit (excluding ones mid-reaction). The whip box (`whipStrikeBox`) and body box (`bodyBox`) are measured values from the asset FK and live in `assets/manifest.ts`. ⚠️ The active tick window (`swingActive`) and whipStrikeBox are a pair derived from the same frame — change only one and hit detection and the visuals go out of sync. Details are in the comments of `game/hitbox.ts`.
- **The v2 assets' markers are wired** (ticket 015): targets loop `working`/`idle` according to the session status, and the player plays `walk` while moving (the loop is only the first 20f of the 40f marker, which is the actual cycle — manifest `walkLoopFrames`). One-shot visuals: a clean hit `hit` (shake + label inverse), and **`flinch` = consecutive-hit groggy** — 3 consecutive hits (with gaps within 1.5 seconds) play hit and then 1 second of groggy (`target_flinch` event, owned by the simulation: `FLINCH_HIT_STREAK`/`STREAK_RESET_GAP_TICKS`); getting hit during groggy starts again from hit. The only unwired one is `windup` (for when a charge mechanic appears).
- **The backdrop decoration is inside the canvas too** (ticket 015, ADR-0006 revision): the gradient, session columns, and separators are drawn by `render/backdrop.ts` as the bottom-most layer. The DOM `#backdrop` and `--column-width` are deleted — what remains in the DOM is only **text** (labels/HUD/connection bar).
- The source of truth for the measured asset values is `public/assets/characters/geometry.json`, and `assets/manifest.ts` is a copy of it (including tick constants — the simulation derives from the manifest). If the two diverge, `pnpm typecheck` fails first (`scripts/check-geometry.mjs`).

For the next work, see the open tickets in `.wayfinder/map.md`.
