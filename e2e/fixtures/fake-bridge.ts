/**
 * The fake bridge WS server — the "server role" that the tests start themselves.
 *
 * The real server (packages/server) detects this machine's **actual** Claude Code sessions, so
 * both the session count and their status differ from run to run. E2E has to be deterministic, so
 * this only imitates the protocol:
 *
 *   - One frame = one `WireMessage` (shared's GameEvent envelope) as JSON text
 *   - **One `session_snapshot` immediately on connect** (same as the connection handler in
 *     server/src/index.ts)
 *   - On every later change, push started → ended → snapshot in that order
 *     (exactly the order in which session-monitor's `diff()` invokes its callbacks. The only path
 *      by which the client changes membership is the snapshot comparison, but started/ended are
 *      frames that really do flow, so sending them too is what makes the "only the snapshot is
 *      applied" rule genuinely verified.)
 *
 * Framing uses shared's `wireFrame` as-is (the same function the real server uses) — if the tests
 * hand-wrote JSON, they'd become a fake safety net that keeps passing after the contract changes.
 */
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  wireFrame,
  type EventMap,
  type ServerEventName,
  type SessionInfo,
} from '../../packages/shared/src/index.js';

/** localhost only, like the real server */
const HOST = '127.0.0.1';
const SOURCE = 'fake-bridge';

function wire<N extends ServerEventName>(name: N, payload: EventMap[N]): string {
  return wireFrame(name, payload, SOURCE);
}

export interface FakeBridge {
  /** The address the client types into the connection bar */
  readonly url: string;
  /** The port actually bound (pass 0 and the OS picks one — so parallel workers don't collide) */
  readonly port: number;
  /** How many clients are attached right now */
  clientCount(): number;
  /** Replace the session list → push started/ended/snapshot */
  setSessions(sessions: readonly SessionInfo[]): void;
  /** Wait until a client attaches */
  waitForClient(timeoutMs?: number): Promise<void>;
  /** Terminates the sockets too and releases the port (so it can be restarted on the same port) */
  close(): Promise<void>;
}

export interface FakeBridgeInit {
  /** Set when reviving on the same port (the drop/recovery scenario). Omitted = an arbitrary port */
  port?: number;
  /** The initial snapshot to send immediately on connect */
  sessions?: readonly SessionInfo[];
}

export async function startFakeBridge(init: FakeBridgeInit = {}): Promise<FakeBridge> {
  const wss = new WebSocketServer({ host: HOST, port: init.port ?? 0 });
  await once(wss, 'listening');

  const address = wss.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake bridge: could not determine the bound port');
  }
  const port = address.port;

  let sessions: SessionInfo[] = [...(init.sessions ?? [])];

  const send = (socket: WebSocket, frame: string): void => {
    if (socket.readyState === socket.OPEN) socket.send(frame);
  };
  const broadcast = (frame: string): void => {
    for (const client of wss.clients) send(client, frame);
  };

  wss.on('connection', (socket) => {
    // Late joiners get the current state immediately (the same rule as the real server)
    send(socket, wire('session_snapshot', { sessions }));
    socket.on('error', () => undefined);
  });
  wss.on('error', () => undefined);

  return {
    url: `ws://${HOST}:${port}`,
    port,
    clientCount: () => wss.clients.size,

    setSessions(next) {
      const previous = sessions;
      sessions = [...next];
      const prevIds = new Set(previous.map((s) => s.sessionId));
      const nextIds = new Set(sessions.map((s) => s.sessionId));
      for (const session of sessions) {
        if (!prevIds.has(session.sessionId)) broadcast(wire('session_started', { session }));
      }
      for (const session of previous) {
        if (!nextIds.has(session.sessionId)) {
          broadcast(wire('session_ended', { sessionId: session.sessionId }));
        }
      }
      broadcast(wire('session_snapshot', { sessions }));
    },

    async waitForClient(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (wss.clients.size === 0) {
        if (Date.now() > deadline) throw new Error('fake bridge: no client connected in time');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },

    async close() {
      // close() shuts down only the listener — leaving attached sockets alive means the port
      // isn't released right away, which breaks the same-port revival scenario with EADDRINUSE
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * A SessionInfo for tests — exactly the shape the server produces. The cwd is used for label
 * verification (the shell prompt format), so keep it a short path under the home directory
 * (`/Users/x/...` → `~/...`, prompt-label.ts).
 */
export function makeSession(init: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
  return {
    cwd: `/Users/tester/Documents/${init.sessionId}`,
    lastActivityAt: Date.now(),
    status: 'idle',
    ...init,
  };
}
