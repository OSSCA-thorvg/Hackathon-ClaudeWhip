/**
 * Bridge server WebSocket adapter — **the only file that knows the server protocol**.
 * It rebroadcasts each received `WireMessage` onto the bus as-is, and reports the socket
 * lifecycle via `server_connection_changed`.
 *
 * **The user starts the connection** — never connect automatically at boot. When the page is
 * opened from static hosting such as GitHub Pages it must not spray console errors trying to
 * attach to a localhost that does not even exist, and in the first place only the user knows
 * "the bridge address of my machine" (session/connect-ui.ts takes that input).
 *
 * When the connection drops, the targets go away too: on close/disconnect we broadcast an
 * **empty snapshot**. A character left on screen while there is no server is stale data that
 * betrays this game's one and only meaning — "a session alive on this machine right now" —
 * and leaving it there is the worse option.
 */
import {
  SERVER_EVENT_NAMES,
  type EventBus,
  type EventMap,
  type ServerConnectionState,
  type ServerEventName,
  type SessionInfo,
  type WireMessage,
} from '@claudewhip/shared';

/** Reconnect backoff — it only runs until the user disconnects */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const RECONNECT_FACTOR = 1.8;

/**
 * If we do not see `open` within this time, treat it as a failure.
 * ⚠️ This is necessary: if the address is wrong (a missing scheme like `localhost:8787`, or a typo)
 * the browser **interprets that string as a path relative to the page URL** and tries to attach to
 * the dev server itself. That socket is neither refused nor closed — it sits in CONNECTING, so
 * without a timeout the UI is trapped forever at "[connecting…]".
 */
const CONNECT_TIMEOUT_MS = 5_000;

/** Event names allowed on the wire — the single source for this list is shared's contract */
const ALLOWED_EVENT_NAMES = new Set<string>(SERVER_EVENT_NAMES);

export interface ServerConnection {
  /** Current state (same value as the bus event — a convenience getter for places that need to poll) */
  readonly state: ServerConnectionState;
  /** Connect to the given address. If already connected/connecting, the existing socket is discarded and a new one attaches */
  connect(url: string): void;
  /** The user disconnects — the reconnect timer is cancelled along with it */
  disconnect(): void;
}

export function createServerConnection(bus: EventBus): ServerConnection {
  return new WsSessionAdapter(bus);
}

class WsSessionAdapter implements ServerConnection {
  readonly #bus: EventBus;
  #socket: WebSocket | null = null;
  #url: string | null = null;
  #state: ServerConnectionState = 'disconnected';
  #retryMs = RECONNECT_BASE_MS;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Does the user want a connection — if false, never retry no matter why the socket dropped */
  #wanted = false;

  constructor(bus: EventBus) {
    this.#bus = bus;
  }

  get state(): ServerConnectionState {
    return this.#state;
  }

  connect(url: string): void {
    this.#wanted = true;
    this.#url = url;
    this.#retryMs = RECONNECT_BASE_MS;
    this.#clearTimer();
    this.#dropSocket();
    this.#open();
  }

  disconnect(): void {
    this.#wanted = false;
    this.#clearTimer();
    this.#dropSocket();
    this.#publishEmptySnapshot();
    this.#setState('disconnected');
  }

  #open(): void {
    const url = this.#url;
    if (url === null) return;

    this.#setState('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      // the address itself is invalid (SyntaxError) — retrying would give the same result forever
      this.#wanted = false;
      this.#setState('error', String(err));
      return;
    }
    this.#socket = socket;

    // The browser gives no reason with the error event (deliberate, per spec) — we use "has it ever
    // opened?" to tell a failed connection attempt (error) apart from a dropped connection (disconnected)
    let opened = false;

    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null;
      if (this.#socket !== socket || opened) return;
      // we close with the handlers already detached, so no onclose arrives — do the state transition here ourselves
      this.#dropSocket();
      this.#setState('error', `connect timeout after ${CONNECT_TIMEOUT_MS}ms`);
      this.#scheduleRetry();
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = (): void => {
      if (this.#socket !== socket) return;
      opened = true;
      this.#clearConnectTimer();
      this.#retryMs = RECONNECT_BASE_MS;
      this.#setState('connected');
    };

    socket.onmessage = (ev: MessageEvent<unknown>): void => {
      if (this.#socket !== socket) return;
      const message = parseWire(ev.data);
      if (message === null) return; // silently drop unknown frames
      this.#republish(message);
    };

    // The state transition always happens exactly once, in onclose (a close is guaranteed to follow
    // an error, so no onerror handler is needed at all — separate from what the browser logs to the console)
    socket.onclose = (): void => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#clearConnectTimer();
      this.#publishEmptySnapshot();
      this.#setState(opened ? 'disconnected' : 'error');
      this.#scheduleRetry();
    };
  }

  #scheduleRetry(): void {
    if (!this.#wanted || this.#retryTimer !== null) return;
    const delay = this.#retryMs;
    this.#retryMs = Math.min(Math.round(this.#retryMs * RECONNECT_FACTOR), RECONNECT_MAX_MS);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (!this.#wanted) return;
      this.#open();
    }, delay);
  }

  #republish(message: WireMessage): void {
    switch (message.name) {
      case 'session_snapshot':
        // cache: true — a subscriber that attaches late still gets the current session list via fetchCached
        this.#bus.broadcast('session_snapshot', message.payload, { cache: true });
        break;
      case 'session_started':
        this.#bus.broadcast('session_started', message.payload);
        break;
      case 'session_ended':
        this.#bus.broadcast('session_ended', message.payload);
        break;
    }
  }

  #publishEmptySnapshot(): void {
    this.#bus.broadcast('session_snapshot', { sessions: [] }, { cache: true });
  }

  #setState(state: ServerConnectionState, detail?: string): void {
    this.#state = state;
    const payload: EventMap['server_connection_changed'] = { state };
    if (this.#url !== null) payload.url = this.#url;
    if (detail !== undefined) payload.detail = detail;
    this.#bus.broadcast('server_connection_changed', payload, { cache: true });
  }

  /** Detach the handlers, then close — otherwise the close of a socket we discarded rolls the state back */
  #dropSocket(): void {
    this.#clearConnectTimer();
    const socket = this.#socket;
    if (socket === null) return;
    this.#socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    // close() is legal even in the CONNECTING state (it cancels the connection attempt)
    socket.close();
  }

  #clearTimer(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer === null) return;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }
}

/**
 * One frame → WireMessage. This is a trust boundary: it only checks that the name is a
 * ServerEventName and that the payload has the minimum shape. Anything off returns null
 * (it does not throw — a single noisy frame must never kill the socket).
 */
function parseWire(data: unknown): WireMessage | null {
  if (typeof data !== 'string') return null;

  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const { name, payload } = raw as { name?: unknown; payload?: unknown };
  if (typeof name !== 'string' || !ALLOWED_EVENT_NAMES.has(name)) return null;
  if (typeof payload !== 'object' || payload === null) return null;

  const body = payload as Record<string, unknown>;
  switch (name as ServerEventName) {
    case 'session_snapshot':
      if (!Array.isArray(body['sessions'])) return null;
      break;
    case 'session_started':
      if (!isSessionInfo(body['session'])) return null;
      break;
    case 'session_ended':
      if (typeof body['sessionId'] !== 'string') return null;
      break;
  }
  return raw as WireMessage;
}

function isSessionInfo(value: unknown): value is SessionInfo {
  return typeof value === 'object' && value !== null && typeof (value as SessionInfo).sessionId === 'string';
}
