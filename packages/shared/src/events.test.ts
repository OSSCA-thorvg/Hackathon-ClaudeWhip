/**
 * Event contract tests — thin, but since this is the assembler shared by both ends (the server's
 * wire and the client's Bus), it guards just two things: that meta is always filled in, and that
 * the server whitelist never leaks a client-only event.
 */
import { describe, expect, it } from 'vitest';

import { makeGameEvent, SERVER_EVENT_NAMES, type EventName } from './events.js';

describe('makeGameEvent', () => {
  it('carries the name and payload as-is and fills in meta', () => {
    const before = Date.now();
    const ev = makeGameEvent('session_ended', { sessionId: 'abc' }, 'session-adapter');
    const after = Date.now();

    expect(ev.name).toBe('session_ended');
    expect(ev.payload).toEqual({ sessionId: 'abc' });
    expect(ev.meta.source).toBe('session-adapter');
    expect(ev.meta.ts).toBeGreaterThanOrEqual(before);
    expect(ev.meta.ts).toBeLessThanOrEqual(after);
  });

  it('does not copy the payload object (it stays exactly as structured before postMessage)', () => {
    const payload = { sessions: [] };
    expect(makeGameEvent('session_snapshot', payload, 'server').payload).toBe(payload);
  });

  it('builds a new envelope on every call (meta must never be shared)', () => {
    const a = makeGameEvent('whip_swing', {}, 'input');
    const b = makeGameEvent('whip_swing', {}, 'input');
    expect(a).not.toBe(b);
    expect(a.meta).not.toBe(b.meta);
  });
});

describe('SERVER_EVENT_NAMES', () => {
  it('contains only the three events the server actually sends', () => {
    expect([...SERVER_EVENT_NAMES]).toEqual([
      'session_snapshot',
      'session_started',
      'session_ended',
    ]);
  });

  it('has no duplicates (the receiving side builds its runtime whitelist Set from this array)', () => {
    expect(new Set(SERVER_EVENT_NAMES).size).toBe(SERVER_EVENT_NAMES.length);
  });

  it('does not contain any client-only event', () => {
    // Things the server cannot send — ws-adapter filters incoming frames with this list
    const clientOnly: EventName[] = [
      'server_connection_changed',
      'player_move',
      'whip_swing',
      'game_state_updated',
      'target_hit',
      'target_flinch',
    ];
    for (const name of clientOnly) {
      expect(SERVER_EVENT_NAMES).not.toContain(name);
    }
  });
});
