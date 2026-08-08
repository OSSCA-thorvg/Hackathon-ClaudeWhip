# render — thorvg rendering (main thread only)

thorvg webcanvas does not support workers/OffscreenCanvas, so all code in this directory runs on the main thread.

**Structure: one canvas covering the entire game area + one Scene node per character.**
The old structure that created a canvas per session (`character-canvas.ts` / `player-canvas.ts` / `lottie-sprite.ts` / `geometry.ts`) is gone.

```
main.ts ──▶ Stage ──┬─▶ TVG.Canvas('#stage-canvas')   ← exactly one on the page
                    ├─▶ Backdrop(Scene)  background gradient + session column  ← always at the bottom
                    ├─▶ targetLayer(Scene) ─▶ TargetNode × N  (Scene + Lottie, 1 DOM label)
                    ├─▶ PlayerNode       (Scene + LottieAnimation)  ← always on top
                    └─▶ layout.ts        single source of truth for position (no DOM measurement)
render-loop.ts ──▶ Stage.renderFrame(dt)   ← one canvas.update().render() per frame
```

**All that is left in the DOM is text.** The background decoration is drawn inside the canvas by `backdrop.ts`,
and only the session labels, HUD, and connect bar remain in the overlay — because 11px monospace hinting, cursor blinking, and measuring character widths are overwhelmingly easier on the DOM side.

**It boots with zero targets.** The session list only exists after the user connects to the bridge server,
so membership changes later via `syncSessions` / `addTarget` / `removeTarget`. Entry is a pop-in (scale 0→1),
exit is a fade-out — both are scene transform/opacity, and `renderFrame(dt)` drives their progress.

- `thorvg.ts` — the `ThorVG.init({ renderer: 'gl', locateFile })` singleton. Falls back to 'sw' if 'gl' initialization fails. `Stage.renderer` (= `Canvas.renderer`) is the single source of truth for which renderer was actually obtained
- `stage.ts` — owns the single canvas. Node add/remove, resize (`canvas.resize` + layout recomputation), one rasterization per frame. **The only outward-facing entry point of the render layer**
- `layout.ts` — pure layout computation (viewport + session list → world height + slot/label coordinates). Converted to the worker contract (`StageGeometry` in `game/protocol.ts`) by `toStageGeometry()`. The coordinate system is **world** — vertically it may be taller than the viewport
- `camera.ts` — a single world→screen vertical offset. It follows with exponential decay only outside the dead zone (top/bottom 25%) and clamps to the world boundaries. **Render-only** — the simulation knows nothing about the camera
- `prompt-label.ts` — session label string assembly (pure). `SessionInfo` + the character budget for **line 1** → shrink in the order: fold the path in the middle (`~/…/dir`) → drop the branch → truncate the last directory (line 2 `❯ claude █` is always intact) / falls back to the session id when there is no cwd
- `backdrop.ts` — the background decoration Scene (viewport gradient + session column + 1px divider). The colors are a copy of `:root` in `styles.css` (thorvg cannot read CSS variables). Added to the canvas **first**
- `lottie-node.ts` — one Scene + LottieAnimation pair. The state-transition API is just two calls, `setLoop(marker)` (the base loop) + `playOnce(marker)` (one-shot effect, then back to whichever loop is current **at that moment**), and `place(centerX, centerY, flipX)` (the bodyCenter-pivot flip matrix) lives here
- `target-node.ts` — the session target. The session status picks the state loop (working/idle), and on top of it hit (a solid strike: shake + label inverse) and flinch (the groggy state after 3 consecutive hits within 1.5s — simulation-owned) are layered one-shot. The label (a **2-line block** shell prompt) is a DOM overlay — right above the character's body, attached right-aligned **inside** the session column (`LABEL_BAND_PX` in the slot pitch makes that vertical room)
- `player-node.ts` — the player. idle/walk loops + a one-shot swing + position and horizontal flip via the scene transform matrix
- `render-loop.ts` — the single rAF loop. For `game_state_updated` the handler keeps only the latest value (latest-wins) and applies it once in rAF

## Rules for this directory

- **Never add more canvases.** Adding a character = `targetLayer.add(scene)`, removing = `targetLayer.remove(scene)` + `dispose()`. The canvas size is the **viewport** (screen space), not the world height
- **`Stage` owns culling.** Targets outside the viewport + one slot are detached from `targetLayer` and skip `tick()` as well. Nodes that are exiting are never culled — if the tick stops, `expired` never arrives and they stay forever
- **Never detach and reattach a paint just to change draw order.** Targets go inside `targetLayer` and the player is added after it — that way the whip always passes over the session column no matter how many targets come and go
- **Exiting nodes hold no slot.** They drop out of the layout immediately (another character fills the spot right away), fade out at their last position, and once `expired` the stage releases them
- **`layout.ts` decides position, not CSS.** The session column width (`SESSION_COLUMN_WIDTH` = one side of the target sprite) is a value that the slot coordinates, the label width, and the background column all read together
- **Rasterize once, in `Stage.renderFrame`.** Nodes must never call `render()` themselves
- The character alignment/flip pivot is `bodyCenter` in `assets/manifest.ts` (player 104,255 ≠ target 120,120)

**The 'Pitfalls' section of CLAUDE.md** is the single source of truth for the list of thorvg pitfalls (CDN WASM, never use `play()`, bug #216, scene transform/pivot, etc.) — do not copy it here.
