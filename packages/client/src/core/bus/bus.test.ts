/**
 * Event bus tests — do the bus rules actually hold:
 *  · a broadcast passes through a single transport (the LocalTransport loopback) on its way to subscribers
 *  · a handler exception does not kill the dispatch loop
 *  · coalescing: while the window is open only the last event is delivered (high-frequency events get 1 call per flush)
 *  · a `cache: true` broadcast is picked up immediately by a late joiner via fetchCached
 *
 * PortTransport needs a MessagePort (browser/worker), so it is out of unit scope — E2E covers it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GameEvent, SessionInfo } from '@claudewhip/shared';
import { Bus } from './bus.js';
import { LocalTransport } from './local-transport.js';
import type { BusEnvelope, BusTransport } from './transport.js';

function sessionInfo(sessionId: string): SessionInfo {
  return { sessionId, cwd: '/tmp', lastActivityAt: 0, status: 'idle' };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LocalTransport', () => {
  it('send comes straight back through the registered callback (synchronous loopback)', () => {
    const transport = new LocalTransport();
    const received: BusEnvelope[] = [];
    transport.onReceive((env) => received.push(env));

    const env: BusEnvelope = {
      ev: { name: 'whip_swing', payload: {}, meta: { ts: 1, source: 'test' } },
      cache: false,
    };
    transport.send(env);
    expect(received).toEqual([env]);
  });

  it('silently drops a send made before any callback is registered', () => {
    expect(() =>
      new LocalTransport().send({
        ev: { name: 'whip_swing', payload: {}, meta: { ts: 1, source: 'test' } },
        cache: false,
      }),
    ).not.toThrow();
  });
});

describe('broadcast → subscribe', () => {
  it('delivers payload and meta to the subscriber untouched', () => {
    const bus = new Bus('logic-worker');
    const seen: GameEvent<'target_hit'>[] = [];
    bus.subscribe('target_hit', (ev) => seen.push(ev));

    bus.broadcast('target_hit', { sessionId: 's1' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toEqual({ sessionId: 's1' });
    expect(seen[0]?.name).toBe('target_hit');
    expect(seen[0]?.meta.source).toBe('logic-worker'); // the constructor argument rides along
    expect(typeof seen[0]?.meta.ts).toBe('number');
  });

  it('broadcasts synchronously (handlers run before broadcast returns)', () => {
    const bus = new Bus('test');
    let called = false;
    bus.subscribe('whip_swing', () => {
      called = true;
    });
    bus.broadcast('whip_swing', {});
    expect(called).toBe(true);
  });

  it('delivers only to subscribers of the matching event name', () => {
    const bus = new Bus('test');
    const hits: unknown[] = [];
    const ended: unknown[] = [];
    bus.subscribe('target_hit', (ev) => hits.push(ev));
    bus.subscribe('session_ended', (ev) => ended.push(ev));

    bus.broadcast('target_hit', { sessionId: 's1' });
    expect(hits).toHaveLength(1);
    expect(ended).toHaveLength(0);

    bus.broadcast('session_ended', { sessionId: 's1' });
    expect(hits).toHaveLength(1);
    expect(ended).toHaveLength(1);
  });

  it('reaches every subscriber of the same event', () => {
    const bus = new Bus('test');
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('target_flinch', a);
    bus.subscribe('target_flinch', b);

    bus.broadcast('target_flinch', { sessionId: 's1' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('broadcasting with no subscribers is safe', () => {
    expect(() => new Bus('test').broadcast('whip_swing', {})).not.toThrow();
  });

  it('stops receiving events once unsubscribed', () => {
    const bus = new Bus('test');
    const handler = vi.fn();
    const off = bus.subscribe('whip_swing', handler);

    bus.broadcast('whip_swing', {});
    off();
    bus.broadcast('whip_swing', {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not break dispatch when a handler unsubscribes itself', () => {
    const bus = new Bus('test');
    const second = vi.fn();
    const off = bus.subscribe('whip_swing', () => off());
    bus.subscribe('whip_swing', second);

    expect(() => bus.broadcast('whip_swing', {})).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('handler exception isolation', () => {
  it('runs the remaining handlers even when one throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new Bus('test');
    const after = vi.fn();

    bus.subscribe('target_hit', () => {
      throw new Error('boom');
    });
    bus.subscribe('target_hit', after);

    expect(() => bus.broadcast('target_hit', { sessionId: 's1' })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('delivers the next broadcast normally after a handler has thrown', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new Bus('test');
    const handler = vi.fn(() => {
      throw new Error('boom');
    });
    bus.subscribe('whip_swing', handler);

    bus.broadcast('whip_swing', {});
    bus.broadcast('whip_swing', {});
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('coalescing', () => {
  it('delivers only the last event when the window closes', () => {
    vi.useFakeTimers();
    const bus = new Bus('logic-worker');
    const handler = vi.fn();
    bus.subscribe('game_state_updated', handler, { coalesce: { maxWaitMs: 16 } });

    for (let i = 0; i < 5; i += 1) {
      bus.broadcast('game_state_updated', {
        player: { x: i, y: 0, facing: 'right', swinging: false, moving: false },
        targets: [],
      });
    }
    expect(handler).not.toHaveBeenCalled(); // nothing goes out while the window is open

    vi.advanceTimersByTime(16);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]?.payload.player.x).toBe(4); // the last one
  });

  it('opens the next window for a broadcast made after the window has closed', () => {
    vi.useFakeTimers();
    const bus = new Bus('test');
    const handler = vi.fn();
    bus.subscribe('target_hit', handler, { coalesce: { maxWaitMs: 10 } });

    bus.broadcast('target_hit', { sessionId: 'a' });
    vi.advanceTimersByTime(10);
    bus.broadcast('target_hit', { sessionId: 'b' });
    vi.advanceTimersByTime(10);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map((c) => c[0].payload.sessionId)).toEqual(['a', 'b']);
  });

  it('lets coalescing and plain subscribers coexist', () => {
    vi.useFakeTimers();
    const bus = new Bus('test');
    const immediate = vi.fn();
    const batched = vi.fn();
    bus.subscribe('target_hit', immediate);
    bus.subscribe('target_hit', batched, { coalesce: { maxWaitMs: 16 } });

    bus.broadcast('target_hit', { sessionId: 'a' });
    bus.broadcast('target_hit', { sessionId: 'b' });
    expect(immediate).toHaveBeenCalledTimes(2);
    expect(batched).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);
    expect(batched).toHaveBeenCalledTimes(1);
  });

  it('cancels pending events when unsubscribing while a coalescing window is open', () => {
    vi.useFakeTimers();
    const bus = new Bus('test');
    const handler = vi.fn();
    const off = bus.subscribe('target_hit', handler, { coalesce: { maxWaitMs: 16 } });

    bus.broadcast('target_hit', { sessionId: 'a' });
    off();
    vi.advanceTimersByTime(100);
    expect(handler).not.toHaveBeenCalled();
  });

  it('still batches with maxWaitMs 0 (broadcasts in the same tick are merged)', () => {
    vi.useFakeTimers();
    const bus = new Bus('test');
    const handler = vi.fn();
    bus.subscribe('target_hit', handler, { coalesce: { maxWaitMs: 0 } });

    bus.broadcast('target_hit', { sessionId: 'a' });
    bus.broadcast('target_hit', { sessionId: 'b' });
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]?.payload.sessionId).toBe('b');
  });
});

describe('cache / late joiner', () => {
  it('keeps only what was broadcast with cache: true', () => {
    const bus = new Bus('session-adapter');
    expect(bus.fetchCached('session_snapshot')).toBeUndefined();

    bus.broadcast('session_snapshot', { sessions: [sessionInfo('s1')] }, { cache: true });
    expect(bus.fetchCached('session_snapshot')?.payload.sessions).toHaveLength(1);

    bus.broadcast('target_hit', { sessionId: 's1' });
    expect(bus.fetchCached('target_hit')).toBeUndefined();
  });

  it('lets a late subscriber miss the event but still get the state from the cache', () => {
    const bus = new Bus('session-adapter');
    bus.broadcast('session_snapshot', { sessions: [sessionInfo('s1')] }, { cache: true });

    const handler = vi.fn();
    bus.subscribe('session_snapshot', handler);
    expect(handler).not.toHaveBeenCalled(); // there is no replay

    const cached = bus.fetchCached('session_snapshot');
    expect(cached?.payload.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(cached?.meta.source).toBe('session-adapter');
  });

  it('keys the cache by event name — only the last one survives', () => {
    const bus = new Bus('test');
    bus.broadcast('session_snapshot', { sessions: [] }, { cache: true });
    bus.broadcast('session_snapshot', { sessions: [sessionInfo('s2')] }, { cache: true });
    expect(bus.fetchCached('session_snapshot')?.payload.sessions.map((s) => s.sessionId)).toEqual([
      's2',
    ]);
  });

  it('still delivers to subscribers normally even when the event is cached', () => {
    const bus = new Bus('test');
    const handler = vi.fn();
    bus.subscribe('session_snapshot', handler);
    bus.broadcast('session_snapshot', { sessions: [] }, { cache: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('extra transports', () => {
  /** Fake transport that stands in for the far side (a worker, etc.) */
  class FakeTransport implements BusTransport {
    readonly sent: BusEnvelope[] = [];
    #receive: ((env: BusEnvelope) => void) | null = null;
    send(env: BusEnvelope): void {
      this.sent.push(env);
    }
    onReceive(cb: (env: BusEnvelope) => void): void {
      this.#receive = cb;
    }
    /** Pretend an event arrived from the far side */
    deliver(env: BusEnvelope): void {
      this.#receive?.(env);
    }
  }

  it('sends a broadcast out to every attached transport (including the cache flag)', () => {
    const bus = new Bus('main');
    const remote = new FakeTransport();
    bus.addTransport(remote);

    bus.broadcast('session_snapshot', { sessions: [] }, { cache: true });

    expect(remote.sent).toHaveLength(1);
    expect(remote.sent[0]?.cache).toBe(true);
    expect(remote.sent[0]?.ev.name).toBe('session_snapshot');
  });

  it('applies an event coming from the far side to subscribers and the cache too', () => {
    const bus = new Bus('main');
    const remote = new FakeTransport();
    bus.addTransport(remote);

    const handler = vi.fn();
    bus.subscribe('session_snapshot', handler);
    remote.deliver({
      ev: {
        name: 'session_snapshot',
        payload: { sessions: [sessionInfo('remote')] },
        meta: { ts: 1, source: 'server' },
      },
      cache: true,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.fetchCached('session_snapshot')?.meta.source).toBe('server');
  });

  it('never echoes an event from the far side back to it (no echo)', () => {
    const bus = new Bus('main');
    const remote = new FakeTransport();
    bus.addTransport(remote);

    remote.deliver({
      ev: { name: 'whip_swing', payload: {}, meta: { ts: 1, source: 'input' } },
      cache: false,
    });
    expect(remote.sent).toEqual([]);
  });
});
