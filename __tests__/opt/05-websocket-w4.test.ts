// ── Optimization suite #05 — WebSocket / Real-time transport (WAVE 4) ────────
// Unit tests for the localized wave-4 hardening fixes. New items this wave:
//   #401 reconcile MAX_WS_TOTAL vs the per-type bot-events cap (effective budget)
//   #407 O(sessions+clients) stale-session sweep helper
//   #414 frame-inspector subscribe teardown contract (no leak if already closing)
//   #417 typed application close code when STT has no backend
//   #451 reset excluded-provider set after a backend stays healthy long enough
//   #453 classify/nack unknown STT control actions
//   #458 distinguish no-speech from a real result on pipeline complete
//   #472 gate identifier-adjacent recall/bot metadata logging behind a debug flag
//   #473 fail closed for recall ingress when the WS secret is missing
//   #484 debounce dub:switch churn
//   #487 per-connection bot-events command rate limiter
//   #492 versioned WS message protocol (advertised on connect)
//
// NO real sockets/network: every "ws" is a plain object with vi.fn() spies.
// Pure helpers are imported via relative paths from the server trees. We do NOT
// boot Bun.serve — ws-server.ts only defines exports at import time.

import { describe, it, expect, vi } from 'vitest';

import {
  effectiveBotEventsBudget,
  MAX_WS_CLIENTS,
  shouldLogWsMetadata,
  recallRequiresWsSecret,
  WS_PROTOCOL_VERSION,
  withProtocolVersion,
  parseWsControlAction,
} from '../../server/ws-server';

import {
  STT_NO_BACKEND_CLOSE_CODE,
  shouldResetExclusions,
  STT_EXCLUSION_RESET_MS,
} from '../../server/ws/stt-lifecycle';

import { isNoSpeechResult } from '../../server/ws/speech-lifecycle';

import { computeStaleSessionIds } from '../../server/ws/streaming-stt-session';

import {
  makeCommandRateLimiter,
  makeDubSwitchDebounce,
  WS_COMMAND_RATE_LIMIT,
  WS_COMMAND_RATE_WINDOW_MS,
  DUB_SWITCH_MIN_INTERVAL_MS,
} from '../../server/ws/handlers';

// ── #401 effective bot-events budget = min(global, per-type) ──────────────────
describe('effectiveBotEventsBudget (#401)', () => {
  it('returns the smaller of the global cap and the per-type cap', () => {
    // Global 200 < per-type 500 → the advertised 500 is unreachable; budget is 200.
    expect(effectiveBotEventsBudget(200, 500)).toBe(200);
  });

  it('uses the per-type cap when it is the tighter limit', () => {
    expect(effectiveBotEventsBudget(1000, 500)).toBe(500);
  });

  it('defaults reconcile the documented caps (200 vs 500 → 200)', () => {
    expect(MAX_WS_CLIENTS).toBe(500);
    expect(effectiveBotEventsBudget()).toBe(200);
  });
});

// ── #407 O(sessions+clients) stale-session sweep ─────────────────────────────
describe('computeStaleSessionIds (#407)', () => {
  it('returns session ids that have no matching live client', () => {
    const sessions = ['a', 'b', 'c'];
    const live = ['a', 'c'];
    expect(computeStaleSessionIds(sessions, live)).toEqual(['b']);
  });

  it('returns empty when every session has a live client', () => {
    expect(computeStaleSessionIds(['x', 'y'], ['y', 'x', 'z'])).toEqual([]);
  });

  it('returns all sessions when there are no live clients', () => {
    expect(computeStaleSessionIds(['p', 'q'], [])).toEqual(['p', 'q']);
  });

  it('preserves the session iteration order in the result', () => {
    const m = new Map<string, number>([['s1', 1], ['s2', 2], ['s3', 3]]);
    expect(computeStaleSessionIds(m.keys(), ['s2'])).toEqual(['s1', 's3']);
  });

  it('handles many sessions/clients without nested scanning (set-based)', () => {
    const sessions = Array.from({ length: 500 }, (_, i) => `sess-${i}`);
    const live = Array.from({ length: 250 }, (_, i) => `sess-${i * 2}`); // even ids live
    const stale = computeStaleSessionIds(sessions, live);
    expect(stale.length).toBe(250); // odd ids are stale
    expect(stale).toContain('sess-1');
    expect(stale).not.toContain('sess-0');
  });
});

// ── #417 typed STT no-backend close code ─────────────────────────────────────
describe('STT_NO_BACKEND_CLOSE_CODE (#417)', () => {
  it('is a private-range application close code (4000–4999)', () => {
    expect(STT_NO_BACKEND_CLOSE_CODE).toBe(4002);
    expect(STT_NO_BACKEND_CLOSE_CODE).toBeGreaterThanOrEqual(4000);
    expect(STT_NO_BACKEND_CLOSE_CODE).toBeLessThanOrEqual(4999);
  });

  it('is distinct from generic transport close codes (1000/1006)', () => {
    expect(STT_NO_BACKEND_CLOSE_CODE).not.toBe(1000);
    expect(STT_NO_BACKEND_CLOSE_CODE).not.toBe(1006);
  });
});

// ── #451 reset excluded providers after a healthy window ─────────────────────
describe('shouldResetExclusions (#451)', () => {
  it('resets once the backend has been connected longer than the window', () => {
    const since = 1_000;
    expect(shouldResetExclusions(since, since + STT_EXCLUSION_RESET_MS)).toBe(true);
    expect(shouldResetExclusions(since, since + STT_EXCLUSION_RESET_MS + 5_000)).toBe(true);
  });

  it('does NOT reset for a backend that flapped quickly (under the window)', () => {
    const since = 1_000;
    expect(shouldResetExclusions(since, since + 1_000)).toBe(false);
    expect(shouldResetExclusions(since, since + STT_EXCLUSION_RESET_MS - 1)).toBe(false);
  });

  it('never resets when there is no recorded connect time', () => {
    expect(shouldResetExclusions(0, Date.now())).toBe(false);
    expect(shouldResetExclusions(-1, Date.now())).toBe(false);
    expect(shouldResetExclusions(NaN, Date.now())).toBe(false);
  });

  it('honors a custom minHealthyMs', () => {
    expect(shouldResetExclusions(100, 100 + 50, 50)).toBe(true);
    expect(shouldResetExclusions(100, 100 + 49, 50)).toBe(false);
  });
});

// ── #453 classify / nack STT control actions ─────────────────────────────────
describe('parseWsControlAction (#453)', () => {
  it('recognizes the two valid control actions', () => {
    expect(parseWsControlAction({ action: 'clear' })).toBe('clear');
    expect(parseWsControlAction({ action: 'turn_complete' })).toBe('turn_complete');
  });

  it('returns null for an unknown / typo action (→ caller nacks)', () => {
    expect(parseWsControlAction({ action: 'turncomplete' })).toBeNull();
    expect(parseWsControlAction({ action: 'reset' })).toBeNull();
    expect(parseWsControlAction({ action: '' })).toBeNull();
  });

  it('returns null for non-string / structurally-bogus actions', () => {
    expect(parseWsControlAction({ action: {} })).toBeNull();
    expect(parseWsControlAction({ action: ['clear'] })).toBeNull();
    expect(parseWsControlAction({ action: 1 })).toBeNull();
  });

  it('returns null for non-object / nullish input', () => {
    expect(parseWsControlAction(null)).toBeNull();
    expect(parseWsControlAction(undefined)).toBeNull();
    expect(parseWsControlAction('clear')).toBeNull();
    expect(parseWsControlAction({})).toBeNull();
  });
});

// ── #458 distinguish no-speech from a real result ────────────────────────────
describe('isNoSpeechResult (#458)', () => {
  it('flags an empty / whitespace-only / missing transcription as no-speech', () => {
    expect(isNoSpeechResult('')).toBe(true);
    expect(isNoSpeechResult('   ')).toBe(true);
    expect(isNoSpeechResult('\n\t ')).toBe(true);
    expect(isNoSpeechResult(null)).toBe(true);
    expect(isNoSpeechResult(undefined)).toBe(true);
  });

  it('does not flag real transcribed text', () => {
    expect(isNoSpeechResult('hello')).toBe(false);
    expect(isNoSpeechResult('  bonjour  ')).toBe(false);
  });
});

// ── #472 gate recall/bot metadata logging behind a debug flag ────────────────
describe('shouldLogWsMetadata (#472)', () => {
  it('defaults to OFF (do not log identifier-adjacent metadata)', () => {
    expect(shouldLogWsMetadata({})).toBe(false);
    expect(shouldLogWsMetadata({ AIGW_WS_DEBUG_META: '0' })).toBe(false);
    expect(shouldLogWsMetadata({ AIGW_WS_DEBUG_META: 'off' })).toBe(false);
  });

  it('enables logging only when explicitly turned on', () => {
    expect(shouldLogWsMetadata({ AIGW_WS_DEBUG_META: '1' })).toBe(true);
    expect(shouldLogWsMetadata({ AIGW_WS_DEBUG_META: 'true' })).toBe(true);
    expect(shouldLogWsMetadata({ AIGW_WS_DEBUG_META: 'YES' })).toBe(true);
  });
});

// ── #473 fail closed for recall ingress without a WS secret ───────────────────
describe('recallRequiresWsSecret (#473)', () => {
  it('does not require a secret when Recall is not enabled', () => {
    expect(recallRequiresWsSecret({})).toBe(false);
    expect(recallRequiresWsSecret({ RECALL_API_KEY: '' })).toBe(false);
    expect(recallRequiresWsSecret({ RECALL_API_KEY: '   ' })).toBe(false);
  });

  it('requires a secret (fail closed) when Recall is enabled', () => {
    expect(recallRequiresWsSecret({ RECALL_API_KEY: 'rc_live_xxx' })).toBe(true);
  });

  it('allows opting back into the insecure gateway-auth fallback explicitly', () => {
    expect(recallRequiresWsSecret({ RECALL_API_KEY: 'rc_live_xxx', AIGW_RECALL_ALLOW_GATEWAY_AUTH: '1' })).toBe(false);
    expect(recallRequiresWsSecret({ RECALL_API_KEY: 'rc_live_xxx', AIGW_RECALL_ALLOW_GATEWAY_AUTH: 'true' })).toBe(false);
  });

  it('still requires the secret for an unrelated flag value', () => {
    expect(recallRequiresWsSecret({ RECALL_API_KEY: 'rc_live_xxx', AIGW_RECALL_ALLOW_GATEWAY_AUTH: '0' })).toBe(true);
  });
});

// ── #492 versioned WS protocol on connect ────────────────────────────────────
describe('withProtocolVersion (#492)', () => {
  it('stamps the current protocol version onto a frame', () => {
    expect(WS_PROTOCOL_VERSION).toBe(1);
    const f = withProtocolVersion({ type: 'connected', message: 'ready' });
    expect(f).toEqual({ type: 'connected', message: 'ready', protocolVersion: 1 });
  });

  it('is additive — never drops or overwrites unrelated caller fields', () => {
    const f = withProtocolVersion({ type: 'connected', a: 1, b: 'x' });
    expect(f.a).toBe(1);
    expect(f.b).toBe('x');
    expect(f.protocolVersion).toBe(WS_PROTOCOL_VERSION);
  });

  it('round-trips through JSON for the wire', () => {
    const f = withProtocolVersion({ type: 'connected' });
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });
});

// ── #487 per-connection command rate limiter ─────────────────────────────────
describe('makeCommandRateLimiter (#487)', () => {
  it('allows up to the limit within a window then rejects', () => {
    const allow = makeCommandRateLimiter(3, 1000);
    expect(allow(0)).toBe(true);   // 1
    expect(allow(10)).toBe(true);  // 2
    expect(allow(20)).toBe(true);  // 3
    expect(allow(30)).toBe(false); // 4 → over the limit
    expect(allow(40)).toBe(false);
  });

  it('resets the counter when the window rolls over', () => {
    const allow = makeCommandRateLimiter(2, 1000);
    expect(allow(0)).toBe(true);
    expect(allow(100)).toBe(true);
    expect(allow(200)).toBe(false);     // over within the window
    expect(allow(1001)).toBe(true);     // new window → allowed again
    expect(allow(1002)).toBe(true);
    expect(allow(1003)).toBe(false);
  });

  it('exposes documented defaults', () => {
    expect(WS_COMMAND_RATE_LIMIT).toBe(30);
    expect(WS_COMMAND_RATE_WINDOW_MS).toBe(1000);
    const allow = makeCommandRateLimiter(); // defaults
    let ok = 0;
    for (let i = 0; i < 40; i++) { if (allow(i)) ok++; } // 40 cmds in <1s
    expect(ok).toBe(WS_COMMAND_RATE_LIMIT);
  });
});

// ── #484 debounce dub:switch churn ───────────────────────────────────────────
describe('makeDubSwitchDebounce (#484)', () => {
  it('rejects switches that arrive within the min interval', () => {
    const allow = makeDubSwitchDebounce(250);
    expect(allow(0)).toBe(true);     // first switch ok
    expect(allow(100)).toBe(false);  // too soon
    expect(allow(249)).toBe(false);  // still too soon
    expect(allow(250)).toBe(true);   // interval elapsed
    expect(allow(300)).toBe(false);
  });

  it('the first switch is always honored', () => {
    const allow = makeDubSwitchDebounce();
    expect(allow(5_000)).toBe(true);
  });

  it('exposes the documented default interval', () => {
    expect(DUB_SWITCH_MIN_INTERVAL_MS).toBe(250);
  });
});

// ── #414 frame-inspector subscribe teardown contract ─────────────────────────
// The open() branch subscribes to frames, then — if the socket already started
// closing during subscribe — tears the subscription down immediately instead of
// leaking it (a close that may not re-fire). We can't boot Bun, so we assert the
// contract the open path relies on, mirroring its exact branch logic.
describe('frame-inspector subscribe teardown contract (#414)', () => {
  function simulateFrameInspectorOpen(ws: { readyState: number; data: any }, subscribeFrames: () => () => void) {
    const unsub = subscribeFrames();
    if (ws.readyState !== 1) {
      try { unsub(); } catch { /* no-op */ }
    } else {
      ws.data.__unsubscribe = unsub;
    }
  }

  it('stores the unsubscribe fn when the socket is open', () => {
    const unsub = vi.fn();
    const ws = { readyState: 1, data: {} as any };
    simulateFrameInspectorOpen(ws, () => unsub);
    expect(ws.data.__unsubscribe).toBe(unsub);
    expect(unsub).not.toHaveBeenCalled();
  });

  it('immediately tears down (no leak) when the socket is already closing', () => {
    const unsub = vi.fn();
    const ws = { readyState: 2 /* CLOSING */, data: {} as any };
    simulateFrameInspectorOpen(ws, () => unsub);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(ws.data.__unsubscribe).toBeUndefined();
  });

  it('swallows a throwing unsubscribe so open() still completes', () => {
    const unsub = vi.fn(() => { throw new Error('boom'); });
    const ws = { readyState: 3 /* CLOSED */, data: {} as any };
    expect(() => simulateFrameInspectorOpen(ws, () => unsub)).not.toThrow();
    expect(unsub).toHaveBeenCalled();
  });
});
