# session — the server boundary

The only directory that talks to the bridge server (`ws://localhost:${BRIDGE_PORT}` — the constant lives in `@claudewhip/shared`).
No other component knows about the server or the socket; they only subscribe to bus events.

- `ws-adapter.ts` — receives `WireMessage` (shared's server→client envelope) → `bus.broadcast(...)`. Reconnection (backoff), connect timeout, and status reporting (`server_connection_changed`) all live here.
- `connect-ui.ts` — the top connection bar (address field + connect/disconnect toggle + status dot). The markup lives in `index.html` and is bound here.

## Rules

- **Never auto-connect.** A page opened from static hosting (GitHub Pages) must not try to attach to somebody else's localhost. The connection is always started by the user.
- **Broadcast an empty snapshot when the connection drops.** One character = one live session, so a character that lingers while there is no server is a lie.
- **The UI does not poll the adapter's state.** It subscribes to `server_connection_changed` — because transitions the UI did not initiate, such as backoff retries, must show up just the same.
- **The wire is a trust boundary.** Check that the name is a `ServerEventName` and that the payload has the minimum shape, and silently drop anything off (a single noisy frame must never kill the socket).

## Pitfalls

- If the address is wrong (a missing scheme, etc.) the browser **interprets that string as a path relative to the page URL** and tries to attach to the dev server itself. That socket is neither refused nor closed — it sits in CONNECTING, so without `CONNECT_TIMEOUT_MS` the UI is trapped forever at "[connecting…]". (Measured empirically: `not a url` → `ws://localhost:5173/not%20a%20url`)
- When discarding a socket, **detach the handlers first.** If you do not, the `onclose` of the socket you discarded arrives later and rolls back the state of the new connection.
