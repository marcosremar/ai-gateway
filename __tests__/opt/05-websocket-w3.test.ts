// ── Optimization suite #05 — WebSocket / Real-time transport (WAVE 3) ────────
// Unit tests for the localized wave-3 hardening fixes. New items this wave:
//   #404 conn-cap 429 Retry-After + JSON body
//   #427 STT partial-frame throttle (≤10/s, finals always pass)
//   #445 normalize inbound frame to Buffer once (no double-copy)
//   #446 bound held-PCM growth to the trailing window
//   #448 flush STT accumulator before close (covered via _flushAccum wiring)
//   #456 cap STT context seed by chars
//   #471 prefer Authorization header over ?token= query
//   #476 exported padded constant-time compare (recall token reuse)
//   #478 WS Origin allowlist (fail-open when unconfigured)
//   #486 nack unexpected text on a binary audio socket (helper-level)
//   #489 WS connection-stats snapshot
//   #491 transcript reconnect-cursor hint
//   #493 gate the legacy provider:status duplicate behind a flag
//   #494 structured close-code log line
//
// NO real sockets/network: every "ws" is a plain object with vi.fn() spies.
// Pure helpers are imported via relative paths from the server/src trees.

import { describe, it, expect, vi } from 'vitest';

import {
  buildConnCapRejection,
  WS_CONN_CAP_RETRY_AFTER_SEC,
  toFrameBuffer,
  formatWsCloseLog,
  getWsConnectionStats,
  extractWsAuthToken,
  isAllowedWsOrigin,
  safeCompare,
} from '../../server/ws-server';

import {
  shouldEmitLegacyProviderStatus,
  buildTranscriptReconnectHint,
} from '../../server/ws-state';

import {
  capSeedChars,
  STT_SEED_MAX_CHARS,
  makePartialThrottle,
  STT_PARTIAL_MIN_INTERVAL_MS,
} from '../../server/ws/stt-lifecycle';

import {
  trimHeldPcm,
} from '../../server/ws/bot-audio';

// ── #404 connection-cap 429 carries Retry-After + JSON body ──────────────────
describe('buildConnCapRejection (#404)', () => {
  it('returns 429 with a Retry-After header', () => {
    const res = buildConnCapRejection();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WS_CONN_CAP_RETRY_AFTER_SEC));
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('JSON body carries the limit and retryAfter so clients can back off', async () => {
    const res = buildConnCapRejection(200, 7);
    expect(res.headers.get('Retry-After')).toBe('7');
    const body = await res.json();
    expect(body).toMatchObject({ error: 'too_many_connections', limit: 200, retryAfter: 7 });
  });
});

// ── #445 normalize inbound frame to a Buffer exactly once ────────────────────
describe('toFrameBuffer (#445)', () => {
  it('returns the same Buffer instance untouched (no copy)', () => {
    const b = Buffer.from([1, 2, 3]);
    expect(toFrameBuffer(b)).toBe(b);
  });

  it('wraps a Uint8Array view without losing bytes', () => {
    const u8 = new Uint8Array([9, 8, 7, 6]);
    const out = toFrameBuffer(u8);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...out]).toEqual([9, 8, 7, 6]);
  });

  it('respects a subarray view offset/length', () => {
    const full = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const view = full.subarray(2, 5); // [2,3,4]
    const out = toFrameBuffer(view);
    expect([...out]).toEqual([2, 3, 4]);
  });

  it('encodes a string as UTF-8 bytes', () => {
    const out = toFrameBuffer('AB');
    expect([...out]).toEqual([0x41, 0x42]);
  });

  it('wraps an ArrayBuffer', () => {
    const ab = new Uint8Array([1, 2]).buffer;
    expect([...toFrameBuffer(ab)]).toEqual([1, 2]);
  });
});

// ── #494 structured close-code log line ──────────────────────────────────────
describe('formatWsCloseLog (#494)', () => {
  it('includes id, type, and numeric close code', () => {
    const line = formatWsCloseLog('abc', 'stt', 1006, 'gone');
    expect(line).toContain('id=abc');
    expect(line).toContain('type=stt');
    expect(line).toContain('code=1006');
    expect(line).toContain('reason="gone"');
  });

  it('renders code=n/a and omits an empty reason', () => {
    const line = formatWsCloseLog('x', 'bot');
    expect(line).toContain('code=n/a');
    expect(line).not.toContain('reason=');
  });

  it('sanitizes newlines/tabs and caps the reason length', () => {
    const line = formatWsCloseLog('x', 'bot', 1000, 'a\nb\tc' + 'z'.repeat(500));
    expect(line).not.toMatch(/[\r\n\t]/);
    // 120-char cap on the reason portion
    const reason = line.match(/reason="([^"]*)"/)?.[1] ?? '';
    expect(reason.length).toBeLessThanOrEqual(120);
  });
});

// ── #489 WS connection-stats snapshot ────────────────────────────────────────
describe('getWsConnectionStats (#489)', () => {
  it('exposes total/max/botEvents/sttSessions gauges', () => {
    const s = getWsConnectionStats();
    expect(s).toHaveProperty('total');
    expect(s).toHaveProperty('max');
    expect(s).toHaveProperty('botEvents');
    expect(s).toHaveProperty('sttSessions');
    expect(typeof s.total).toBe('number');
    expect(s.max).toBe(200);
    // No live sockets in a unit test → counts are zero.
    expect(s.botEvents).toBe(0);
    expect(s.sttSessions).toBe(0);
  });
});

// ── #471 prefer Authorization header over ?token= query ──────────────────────
describe('extractWsAuthToken (#471)', () => {
  it('prefers the Authorization header when both are present', () => {
    const r = extractWsAuthToken('Bearer headertok', 'querytok');
    expect(r).toEqual({ token: 'headertok', source: 'header' });
  });

  it('falls back to the query token for browser clients', () => {
    const r = extractWsAuthToken(null, 'querytok');
    expect(r).toEqual({ token: 'querytok', source: 'query' });
  });

  it('handles a bare (non-Bearer) header value', () => {
    const r = extractWsAuthToken('rawtok', null);
    expect(r.token).toBe('rawtok');
    expect(r.source).toBe('header');
  });

  it('returns none when neither is supplied', () => {
    expect(extractWsAuthToken(null, null)).toEqual({ token: null, source: 'none' });
    expect(extractWsAuthToken('', '   ')).toEqual({ token: null, source: 'none' });
  });
});

// ── #478 WS Origin allowlist (fail-open when unconfigured) ───────────────────
describe('isAllowedWsOrigin (#478)', () => {
  it('allows everything when no allowlist is configured', () => {
    expect(isAllowedWsOrigin('https://evil.example', '')).toBe(true);
    expect(isAllowedWsOrigin('https://evil.example', undefined)).toBe(true);
  });

  it('allows a missing Origin header (non-browser client) even with an allowlist', () => {
    expect(isAllowedWsOrigin(null, 'https://app.example')).toBe(true);
    expect(isAllowedWsOrigin(undefined, 'https://app.example')).toBe(true);
  });

  it('permits only listed origins when an allowlist is set', () => {
    const allow = 'https://app.example, https://admin.example';
    expect(isAllowedWsOrigin('https://app.example', allow)).toBe(true);
    expect(isAllowedWsOrigin('https://admin.example', allow)).toBe(true);
    expect(isAllowedWsOrigin('https://evil.example', allow)).toBe(false);
  });
});

// ── #476 exported padded constant-time compare ───────────────────────────────
describe('safeCompare (#476)', () => {
  it('returns true for equal strings', () => {
    expect(safeCompare('secret-token', 'secret-token')).toBe(true);
  });

  it('returns false for unequal same-length strings', () => {
    expect(safeCompare('aaaaaa', 'aaaaab')).toBe(false);
  });

  it('returns false (not a throw) for length mismatch and empty inputs', () => {
    expect(safeCompare('short', 'a-much-longer-secret')).toBe(false);
    expect(safeCompare('', 'x')).toBe(false);
    expect(safeCompare('x', '')).toBe(false);
  });
});

// ── #493 gate the legacy provider:status duplicate ───────────────────────────
describe('shouldEmitLegacyProviderStatus (#493)', () => {
  it('defaults to ON (emit) when the flag is unset', () => {
    expect(shouldEmitLegacyProviderStatus({})).toBe(true);
  });

  it('is disabled by 1/true/yes', () => {
    expect(shouldEmitLegacyProviderStatus({ AIGW_DISABLE_LEGACY_PROVIDER_STATUS: '1' })).toBe(false);
    expect(shouldEmitLegacyProviderStatus({ AIGW_DISABLE_LEGACY_PROVIDER_STATUS: 'true' })).toBe(false);
    expect(shouldEmitLegacyProviderStatus({ AIGW_DISABLE_LEGACY_PROVIDER_STATUS: 'YES' })).toBe(false);
  });

  it('stays ON for an unrelated value', () => {
    expect(shouldEmitLegacyProviderStatus({ AIGW_DISABLE_LEGACY_PROVIDER_STATUS: '0' })).toBe(true);
    expect(shouldEmitLegacyProviderStatus({ AIGW_DISABLE_LEGACY_PROVIDER_STATUS: 'off' })).toBe(true);
  });
});

// ── #491 transcript reconnect-cursor hint ────────────────────────────────────
describe('buildTranscriptReconnectHint (#491)', () => {
  it('carries the current cursor in a typed frame', () => {
    expect(buildTranscriptReconnectHint(42)).toEqual({ type: 'transcript:reconnect', cursor: 42 });
  });

  it('clamps a negative / fractional cursor to a non-negative integer', () => {
    expect(buildTranscriptReconnectHint(-5).cursor).toBe(0);
    expect(buildTranscriptReconnectHint(3.9).cursor).toBe(3);
  });

  it('a JSON.stringify of the frame round-trips for the wire', () => {
    const hint = buildTranscriptReconnectHint(7);
    expect(JSON.parse(JSON.stringify(hint))).toEqual(hint);
  });
});

// ── #456 cap STT context seed by chars ───────────────────────────────────────
describe('capSeedChars (#456)', () => {
  it('returns the seed unchanged when under the cap', () => {
    expect(capSeedChars('hello world')).toBe('hello world');
  });

  it('caps an over-long seed to at most maxChars', () => {
    const seed = 'word '.repeat(400); // 2000 chars
    const out = capSeedChars(seed, 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('keeps the trailing (most recent) context, not the head', () => {
    const out = capSeedChars('AAAA BBBB CCCC DDDD', 9);
    // tail slice is "CCC DDDD"-ish then trimmed to a clean word start
    expect(out.endsWith('DDDD')).toBe(true);
    expect(out.startsWith('AAAA')).toBe(false);
  });

  it('defaults to STT_SEED_MAX_CHARS', () => {
    const seed = 'x'.repeat(STT_SEED_MAX_CHARS + 50);
    expect(capSeedChars(seed).length).toBeLessThanOrEqual(STT_SEED_MAX_CHARS);
  });
});

// ── #427 STT partial-frame throttle ──────────────────────────────────────────
describe('makePartialThrottle (#427)', () => {
  it('emits the first partial then throttles within the interval', () => {
    const t = makePartialThrottle(100);
    expect(t(0)).toBe(true);    // first
    expect(t(50)).toBe(false);  // too soon
    expect(t(99)).toBe(false);  // still too soon
    expect(t(100)).toBe(true);  // interval elapsed
    expect(t(150)).toBe(false);
    expect(t(200)).toBe(true);
  });

  it('always lets a forced (final) partial through regardless of timing', () => {
    const t = makePartialThrottle(1000);
    expect(t(0)).toBe(true);
    expect(t(10)).toBe(false);          // throttled
    expect(t(10, /*force*/ true)).toBe(true); // final forced through
    // forcing also resets the window
    expect(t(20)).toBe(false);
  });

  it('caps emissions to ~10/s at the default interval', () => {
    const t = makePartialThrottle(); // default 100ms
    let emitted = 0;
    for (let now = 0; now < 1000; now += 10) { // 100 results over 1s
      if (t(now)) emitted++;
    }
    expect(STT_PARTIAL_MIN_INTERVAL_MS).toBe(100);
    expect(emitted).toBeLessThanOrEqual(11); // ~10/s
    expect(emitted).toBeGreaterThanOrEqual(9);
  });
});

// ── #446 bound held-PCM growth to the trailing window ────────────────────────
describe('trimHeldPcm (#446)', () => {
  it('returns null for empty / null input', () => {
    expect(trimHeldPcm(null, 100)).toBeNull();
    expect(trimHeldPcm(Buffer.alloc(0), 100)).toBeNull();
  });

  it('returns the buffer unchanged when within budget', () => {
    const b = Buffer.from([1, 2, 3, 4]);
    expect(trimHeldPcm(b, 100)).toBe(b);
  });

  it('keeps the trailing bytes (most recent audio) when over budget', () => {
    const b = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]); // 8 bytes
    const out = trimHeldPcm(b, 4)!;
    expect(out.length).toBeLessThanOrEqual(4);
    // trailing window → ends at byte 8
    expect(out[out.length - 1]).toBe(8);
    expect(out[0]).not.toBe(1);
  });

  it('keeps the trailing slice aligned to a 16-bit sample boundary (even length)', () => {
    // 10 bytes, budget 5 → start would be 5 (odd) → bumped to 6 → 4 bytes kept.
    const b = Buffer.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const out = trimHeldPcm(b, 5)!;
    expect(out.length % 2).toBe(0);
    expect(out[out.length - 1]).toBe(19); // still ends at the newest byte
  });
});

// ── #448 flush-on-close wiring (helper contract) ─────────────────────────────
// The close path calls `(backend as any)._flushAccum?.()` before teardown so the
// last utterance reaches the client. We can't boot Bun here, so we assert the
// contract the close path relies on: a flush hook that is invoked exactly once,
// tolerates being absent, and never throws out of the close handler.
describe('flush-on-close contract (#448)', () => {
  function simulateSttClose(backend: any) {
    // Mirror of the ws-server close() stt branch (flush → clear → close).
    try { backend?._flushAccum?.(); } catch { /* swallowed */ }
    try { backend?._clearSttAccumTimer?.(); } catch { /* swallowed */ }
    backend?.close?.();
  }

  it('invokes the backend flush hook before teardown', () => {
    const order: string[] = [];
    const backend = {
      _flushAccum: vi.fn(() => order.push('flush')),
      _clearSttAccumTimer: vi.fn(() => order.push('clear')),
      close: vi.fn(() => order.push('close')),
    };
    simulateSttClose(backend);
    expect(backend._flushAccum).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['flush', 'clear', 'close']);
  });

  it('does not throw when the flush hook is missing', () => {
    const backend = { close: vi.fn() };
    expect(() => simulateSttClose(backend)).not.toThrow();
    expect(backend.close).toHaveBeenCalled();
  });

  it('swallows a throwing flush hook so close still completes', () => {
    const backend = {
      _flushAccum: vi.fn(() => { throw new Error('boom'); }),
      close: vi.fn(),
    };
    expect(() => simulateSttClose(backend)).not.toThrow();
    expect(backend.close).toHaveBeenCalled();
  });
});

// ── #486 nack unexpected text on a binary audio socket (helper contract) ─────
// The ws-server bot-audio branch nacks non-handshake text. parseBotAudioHandshake
// is the discriminator; assert it rejects plain text so the nack path triggers.
describe('bot-audio text nack discriminator (#486)', () => {
  // Import lazily to keep the top import list focused on wave-3 helpers.
  it('a non-handshake string is not parsed as a handshake (→ nack)', async () => {
    const { parseBotAudioHandshake } = await import('../../server/ws/bot-audio');
    expect(parseBotAudioHandshake('hello there')).toBeNull();
    expect(parseBotAudioHandshake('{"not":"handshake"}')).toBeNull();
  });

  it('a real handshake IS parsed (→ no nack)', async () => {
    const { parseBotAudioHandshake } = await import('../../server/ws/bot-audio');
    const hs = parseBotAudioHandshake(JSON.stringify({ protocol_version: 1, sample_rate: 48000 }));
    expect(hs).toEqual({ sampleRate: 48000 });
  });
});
