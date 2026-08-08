/** An active Claude Code session on this machine, as detected by the server */
export interface SessionInfo {
  sessionId: string;
  /** The project directory the session is open in (recovered from ~/.claude/projects/<encoded-cwd>) */
  cwd: string;
  gitBranch?: string;
  /** The session's summary title (the SDK getSessionInfo summary) */
  summary?: string;
  /** Last modification time of the session .jsonl (epoch ms) */
  lastActivityAt: number;
  /** working: the file changed within the last N seconds / idle: the process is alive but quiet */
  status: 'working' | 'idle';
}

/**
 * Bridge server connection state (for display in the client UI).
 * - disconnected: no socket (the default right after boot / the user disconnected / an established
 *                 connection dropped)
 * - connecting:   attempting to connect (first attempt plus backoff retries)
 * - connected:    open. Session events flow only in this state
 * - error:        the connection failed or the address is invalid
 */
export type ServerConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type Direction = 'left' | 'right' | 'up' | 'down';

export interface PlayerState {
  x: number;
  /** y of the body center (**world** space, increasing downward) — may be off-viewport (the camera follows) */
  y: number;
  /** Used only for horizontal flipping (sprite facing) — 'up'/'down' never change facing */
  facing: Direction;
  /** Whether the whip swing animation is in progress */
  swinging: boolean;
  /** Whether a movement input is held — the renderer uses it to choose the walk/idle loop (swing takes priority) */
  moving: boolean;
}

/** One Claude character in the vertical column on the right (= one active session) */
export interface TargetState {
  sessionId: string;
  /** Vertical slot index (0 = topmost) */
  slot: number;
  /** Whether the hit reaction is playing */
  hitReacting: boolean;
}
