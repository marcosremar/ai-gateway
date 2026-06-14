// ── Optimization suite #05 — WebSocket / Real-time transport (WAVE 5) ────────
// Unit tests for the localized wave-5 hardening fixes. New items this wave (all
// inside the OWNED file set — server/ws/*, server/ws-server.ts, server/ws-state.ts):
//   #459 safeWsSend — guarded speech-ws send (readyState gate + swallow throw)
//   #490 broadcast-dropped counter surfaced in getWsConnectionStats + getWsBroadcastDropped
//   #491 transcript:reconnect hint builder, now wired onto the connect snapshot
//
// NO real sockets / network: every "ws" is a plain object with vi.fn() spies,
// and we never boot Bun.serve — the server modules only define exports at import
// time. Pure helpers are imported via relative paths from the server trees.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { safeWsSend } from '../../server/ws/speech-lifecycle';

import { getWsConnectionStats } from '../../server/ws-server';

import {
  buildTranscriptReconnectHint,
  resetWsBroadcastDropped,
  getWsBroadcastDropped,
  broadcastDubAudio,
  subscribeDub,
  unsubscribeDub,
  type BabelCastWS,
} from '../../server/ws-state';

// ── #459 safeWsSend ───────────────────────────────────────────────────────────
describe('safeWsSend (#459)', () => {
  it('sends and returns true when the socket is OPEN (readyState === 1)', () => {
    const send = vi.fn();
    const ws = { readyState: 1, send };
    expect(safeWsSend(ws, 'hello')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('hello');
  });

  it('does NOT send and returns false when the socket is not OPEN', () => {
    const send = vi.fn();
    // 2 === CLOSING, 3 === CLOSED in the WS readyState enum.
    expect(safeWsSend({ readyState: 2, send }, 'x')).toBe(false);
    expect(safeWsSend({ readyState: 3, send }, 'x')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows a throw from send (socket closed between check and send) and returns false', () => {
    // The exact race the guard exists for: readyState says OPEN but the send
    // throws because the socket closed underneath us. Must not reject the
    // pipeline promise.
    const send = vi.fn(() => { throw new Error('WebSocket is closed'); });
    const ws = { readyState: 1, send };
    expect(() => safeWsSend(ws, 'late frame')).not.toThrow();
    expect(safeWsSend(ws, 'late frame')).toBe(false);
  });

  it('accepts Buffer payloads (audio chunks) too', () => {
    const send = vi.fn();
    const ws = { readyState: 1, send };
    const chunk = Buffer.from([1, 2, 3]);
    expect(safeWsSend(ws, chunk)).toBe(true);
    expect(send).toHaveBeenCalledWith(chunk);
  });
});

// ── #491 transcript reconnect hint ────────────────────────────────────────────
describe('buildTranscriptReconnectHint (#491)', () => {
  it('builds a typed reconnect frame carrying the cursor', () => {
    expect(buildTranscriptReconnectHint(7)).toEqual({ type: 'transcript:reconnect', cursor: 7 });
  });

  it('floors fractional cursors and clamps negatives to 0', () => {
    expect(buildTranscriptReconnectHint(3.9).cursor).toBe(3);
    expect(buildTranscriptReconnectHint(-5).cursor).toBe(0);
  });

  it('defaults a non-finite cursor to 0 (never emits NaN to clients)', () => {
    expect(buildTranscriptReconnectHint(NaN).cursor).toBe(0);
  });

  it('produces a JSON-serializable frame (it is sent on connect via ws.send)', () => {
    const frame = buildTranscriptReconnectHint(2);
    const round = JSON.parse(JSON.stringify(frame));
    expect(round).toEqual({ type: 'transcript:reconnect', cursor: 2 });
  });
});

// ── #490 broadcast-dropped counter surfaced in connection stats ──────────────
describe('getWsConnectionStats broadcastDropped (#490)', () => {
  beforeEach(() => { resetWsBroadcastDropped(); });

  it('exposes a broadcastDropped gauge alongside the existing counters', () => {
    const stats = getWsConnectionStats();
    expect(stats).toHaveProperty('broadcastDropped');
    expect(typeof stats.broadcastDropped).toBe('number');
    // The pre-existing #489 gauges are still present (no regression).
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('max');
    expect(stats).toHaveProperty('botEvents');
    expect(stats).toHaveProperty('sttSessions');
  });

  it('starts at 0 after a reset and equals the live ws-state counter', () => {
    expect(getWsBroadcastDropped()).toBe(0);
    expect(getWsConnectionStats().broadcastDropped).toBe(0);
  });

  it('reflects a broadcast dropped because the subscriber was over its buffer ceiling', () => {
    expect(getWsConnectionStats().broadcastDropped).toBe(0);

    // A dub subscriber whose send buffer is way over the 1 MB ceiling:
    // broadcastDubAudio must SKIP it (no send) AND bump the dropped counter,
    // which is exactly what the #490 gauge surfaces to operators.
    const clientId = 'w5-bp-client';
    const send = vi.fn();
    const ws = {
      data: { id: clientId },
      send,
      getBufferedAmount: () => 50 * 1024 * 1024, // 50 MB >> 1 MB ceiling → backpressured
    } as unknown as BabelCastWS;

    subscribeDub(clientId, ws, 'en');
    try {
      broadcastDubAudio('en', { type: 'dub', text: 'hi' });
      expect(send).not.toHaveBeenCalled();                 // saturated client skipped
      expect(getWsBroadcastDropped()).toBeGreaterThanOrEqual(1);
      // The gauge mirrors the live counter exactly.
      expect(getWsConnectionStats().broadcastDropped).toBe(getWsBroadcastDropped());
    } finally {
      unsubscribeDub(clientId);
    }
  });

  it('does NOT count a healthy subscriber as dropped (sends normally)', () => {
    const clientId = 'w5-ok-client';
    const send = vi.fn();
    const ws = {
      data: { id: clientId },
      send,
      getBufferedAmount: () => 0, // well under the ceiling
    } as unknown as BabelCastWS;

    subscribeDub(clientId, ws, 'pt');
    try {
      broadcastDubAudio('pt', { type: 'dub', text: 'ola' });
      expect(send).toHaveBeenCalledTimes(1);
      expect(getWsBroadcastDropped()).toBe(0);
      expect(getWsConnectionStats().broadcastDropped).toBe(0);
    } finally {
      unsubscribeDub(clientId);
    }
  });
});
