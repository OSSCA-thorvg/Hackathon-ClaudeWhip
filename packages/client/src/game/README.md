# game — game logic (Web Worker)

The logic worker responsible for player movement, the whip swing state machine, and hit detection. It cannot render (thorvg constraint), but the entire simulation lives here — the main thread only draws.

- `logic.worker.ts` — worker entry point. Connects the bus via PortTransport, runs the fixed-tick (e.g. 60Hz) simulation
- `simulation.ts` — pure-function state transitions: (state, input events) → next state. Consumes `player_move`/`whip_swing`, publishes `game_state_updated`/`target_hit`
- `hitbox.ts` — overlap detection against the right-hand column slots during the whip swing's frame window

A landed hit is a visual effect only — no effect on the real sessions.
