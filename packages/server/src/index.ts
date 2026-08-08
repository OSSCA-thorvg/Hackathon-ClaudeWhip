/**
 * ClaudeWhip bridge server entry point.
 * Its job: detect active Claude Code sessions (session-monitor) → push them to the browser over
 * WebSocket. This server exists because the Agent SDK is Node-only.
 *
 * Protocol: one shared WireMessage (GameEvent envelope) = one JSON text frame.
 * One session_snapshot immediately on connect → then started/ended/changed snapshots are pushed.
 */
import { WebSocketServer } from 'ws';

import { BRIDGE_PORT, wireFrame, type EventMap, type ServerEventName } from '@claudewhip/shared';

import { SessionMonitor } from './session-monitor.js';

const SOURCE = 'bridge-server';
/** localhost only — this machine's session info is never exposed to the network */
const HOST = '127.0.0.1';

/** One frame = shared's `wireFrame` bound to this server's source (framing is owned by shared) */
function wire<N extends ServerEventName>(name: N, payload: EventMap[N]): string {
  return wireFrame(name, payload, SOURCE);
}

const wss = new WebSocketServer({ host: HOST, port: BRIDGE_PORT });

// The connection list is just wss.clients as maintained by ws (no separate bookkeeping)
function broadcast(frame: string): void {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(frame);
  }
}

const monitor = new SessionMonitor({
  snapshot: (payload) => {
    console.log(
      `[claudewhip-server] sessions: ${payload.sessions.length}` +
        payload.sessions.map((s) => ` · ${s.sessionId.slice(0, 8)}(${s.status})`).join(''),
    );
    broadcast(wire('session_snapshot', payload));
  },
  started: (payload) => {
    console.log(`[claudewhip-server] + started ${payload.session.sessionId} ${payload.session.cwd}`);
    broadcast(wire('session_started', payload));
  },
  ended: (payload) => {
    console.log(`[claudewhip-server] - ended   ${payload.sessionId}`);
    broadcast(wire('session_ended', payload));
  },
});

wss.on('connection', (socket) => {
  // Late joiners get the current state immediately too (same role as the client EventBus's cached snapshot)
  socket.send(wire('session_snapshot', monitor.getSnapshot()));
  console.log(`[claudewhip-server] client connected (${wss.clients.size})`);

  socket.on('close', () => {
    console.log(`[claudewhip-server] client disconnected (${wss.clients.size})`);
  });
  socket.on('error', (err) => {
    console.error('[claudewhip-server] socket error:', err);
  });
});

wss.on('listening', () => {
  console.log(`[claudewhip-server] listening on ws://${HOST}:${BRIDGE_PORT}`);
  monitor.start();
});

wss.on('error', (err) => {
  console.error('[claudewhip-server] server error:', err);
  process.exit(1);
});

function shutdown(): void {
  monitor.stop();
  for (const client of wss.clients) client.close();
  wss.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
