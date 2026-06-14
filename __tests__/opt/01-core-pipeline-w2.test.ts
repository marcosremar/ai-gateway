/**
 * Wave-2 unit tests for core-AI-pipeline optimizations
 * (docs/optimizations/01-core-ai-pipeline.md).
 *
 * Scope mirrors the wave-1 file (01-core-pipeline.test.ts): pure, importable
 * logic only — no real network / provider / GPU / FS. `franc` and the global
 * `WebSocket` are mocked. The server modules (ai-handlers / pipeline-runner)
 * ARE importable in this harness (verified) but instantiate no timers at load,
 * so we exercise their newly-extracted PURE helpers directly.
 *
 * Each describe block maps to an optimization ID from the doc.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── franc mock — lets us count passes for the #25 memoization test ───────────
// franc returns ISO-639-3 codes. We return a code derived from the call args so
// detection still resolves, while counting how many times franc is invoked.
const francCalls: Array<{ text: string; opts?: any }> = [];
vi.mock('franc', () => ({
  franc: (text: string, opts?: any) => {
    francCalls.push({ text, opts });
    // If restricted (`only` given), honour the allow-list deterministically:
    // pick 'eng' so detection lands on English for our english-looking inputs.
    if (opts?.only) return opts.only.includes('eng') ? 'eng' : opts.only[0];
    return 'eng';
  },
}));

import { detectLanguage, _clearUnrestrictedCache } from '../../src/language-detect';
import { IS_EXPERIMENTAL_STREAMING_OVERLAP } from '../../src/pipeline/streaming-overlap';

// ── #25 — franc unrestricted pass is memoized per text ───────────────────────

describe('language-detect #25 — unrestricted franc result is cached by text', () => {
  beforeEach(() => {
    francCalls.length = 0;
    _clearUnrestrictedCache();
  });

  it('runs the unrestricted pass only once for repeated identical text', () => {
    const text = 'the quarterly budget review meeting is scheduled for noon';
    detectLanguage(text, 'fr', 'en');
    detectLanguage(text, 'fr', 'en'); // dub-fanout re-detects the SAME text per target

    // Each detectLanguage runs ONE restricted franc (only:[...]) every time —
    // it depends on src/tgt. The unrestricted pass (no `only`) must be cached:
    // exactly one unrestricted call across both detections.
    const restricted = francCalls.filter(c => c.opts?.only).length;
    const unrestricted = francCalls.filter(c => !c.opts?.only).length;
    expect(restricted).toBe(2);
    expect(unrestricted).toBe(1); // memoized — was 2 before #25
  });

  it('still recomputes the unrestricted pass for a different text', () => {
    detectLanguage('the first distinct english sentence here', 'fr', 'en');
    detectLanguage('a completely different english sentence now', 'fr', 'en');
    const unrestricted = francCalls.filter(c => !c.opts?.only).length;
    expect(unrestricted).toBe(2);
  });

  it('clearing the cache forces recomputation', () => {
    const text = 'an english sentence used to prime the memo cache here';
    detectLanguage(text, 'fr', 'en');
    _clearUnrestrictedCache();
    detectLanguage(text, 'fr', 'en');
    const unrestricted = francCalls.filter(c => !c.opts?.only).length;
    expect(unrestricted).toBe(2);
  });

  it('still returns a sane detection result', () => {
    const r = detectLanguage('this is plainly an english sentence to detect', 'fr', 'en');
    expect(r.language).toBe('en');
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });
});

// ── #53 — experimental streaming-overlap module is clearly marked ────────────

describe('streaming-overlap #53 — experimental module flag', () => {
  it('exports IS_EXPERIMENTAL_STREAMING_OVERLAP=true to disambiguate from the live path', () => {
    expect(IS_EXPERIMENTAL_STREAMING_OVERLAP).toBe(true);
  });
});

// ── #79 — streaming-stt buffers audio while connecting ───────────────────────
// Provide a controllable fake WebSocket so we can hold the socket in the
// CONNECTING state, push audio, then open it and assert the buffered frames
// flush in order.

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((evt: any) => void) | null = null;
  onclose: ((evt: any) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: ArrayBuffer[] = [];
  closed = false;
  constructor(public url: string, public opts?: any) {}
  send(data: ArrayBuffer) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = FakeWebSocket.CLOSED; }
  /** Simulate the upstream accepting the connection. */
  _open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
}

describe('streaming-stt #79 — pre-connect audio buffer', () => {
  let prevWs: any;
  let created: FakeWebSocket[];
  beforeEach(() => {
    created = [];
    prevWs = (globalThis as any).WebSocket;
    const ctor: any = function (url: string, opts?: any) {
      const ws = new FakeWebSocket(url, opts);
      created.push(ws);
      return ws;
    };
    ctor.CONNECTING = FakeWebSocket.CONNECTING;
    ctor.OPEN = FakeWebSocket.OPEN;
    ctor.CLOSING = FakeWebSocket.CLOSING;
    ctor.CLOSED = FakeWebSocket.CLOSED;
    (globalThis as any).WebSocket = ctor;
  });
  afterEach(() => { (globalThis as any).WebSocket = prevWs; });

  async function makeBackend() {
    const { StreamingSTTBackend } = await import('../../src/streaming-stt');
    return new StreamingSTTBackend('wss://example.test/ws', {}, 'gpu');
  }

  it('buffers frames sent while connecting and flushes them in order on open', async () => {
    const be = await makeBackend();
    be.connect();
    expect(be.isConnecting).toBe(true);
    expect(be.isOpen).toBe(false);

    // Audio arrives BEFORE the socket opens — previously these were dropped.
    const a = new Uint8Array([1, 2, 3]).buffer;
    const b = new Uint8Array([4, 5, 6, 7]).buffer;
    be.sendAudio(a);
    be.sendAudio(b);
    expect(be.pendingPreConnectBytes).toBe(3 + 4);
    expect(created[0].sent.length).toBe(0); // nothing sent yet

    created[0]._open(); // upstream connects → flush
    expect(be.isOpen).toBe(true);
    expect(be.pendingPreConnectBytes).toBe(0);
    // Both buffered frames were flushed, in order.
    expect(created[0].sent.map(s => new Uint8Array(s)[0])).toEqual([1, 4]);
  });

  it('sends directly once open (no buffering)', async () => {
    const be = await makeBackend();
    be.connect();
    created[0]._open();
    be.sendAudio(new Uint8Array([9]).buffer);
    expect(be.pendingPreConnectBytes).toBe(0);
    expect(created[0].sent.length).toBe(1);
  });

  it('caps the pre-connect buffer by maxBufferBytes, dropping oldest frames', async () => {
    const { StreamingSTTBackend } = await import('../../src/streaming-stt');
    // 6-byte cap: pushing three 4-byte frames keeps total <= cap by evicting
    // the oldest, but always retains at least the newest frame.
    const be = new StreamingSTTBackend('wss://example.test/ws', {}, 'gpu', { maxBufferBytes: 6 });
    be.connect();
    be.sendAudio(new Uint8Array([1, 1, 1, 1]).buffer);
    be.sendAudio(new Uint8Array([2, 2, 2, 2]).buffer);
    be.sendAudio(new Uint8Array([3, 3, 3, 3]).buffer);
    // Single oversized frames (> cap) are rejected outright by _normalizePcm.
    expect(be.pendingPreConnectBytes).toBeLessThanOrEqual(6);
    expect(be.pendingPreConnectBytes).toBeGreaterThan(0);
  });

  it('drops buffered audio if the socket closes before opening', async () => {
    const be = await makeBackend();
    be.connect();
    be.sendAudio(new Uint8Array([1, 2, 3]).buffer);
    expect(be.pendingPreConnectBytes).toBe(3);
    be.close(); // teardown before open
    expect(be.pendingPreConnectBytes).toBe(0);
  });

  it('does not buffer when fully closed (never connected)', async () => {
    const be = await makeBackend();
    // No connect() call → not connecting, not open.
    be.sendAudio(new Uint8Array([1, 2, 3]).buffer);
    expect(be.pendingPreConnectBytes).toBe(0);
  });
});

// ── server/ai-handlers.ts — extracted pure helpers ──────────────────────────
// These modules are heavy but import without starting timers; we exercise only
// the newly-extracted pure helpers.

describe('ai-handlers #68/#100 — folded adaptive-timeout math', () => {
  it('prefers stage avg×3 when enough samples, clamped to [500, base]', async () => {
    const { computeAdaptiveTimeout } = await import('../../server/ai-handlers');
    // avg 300ms, 3 samples → 900ms (within range)
    expect(computeAdaptiveTimeout(5000, 300, 3, 1000, 2000)).toBe(900);
    // avg 50ms → 150 but floored to 500
    expect(computeAdaptiveTimeout(5000, 50, 3, null, null)).toBe(500);
    // avg 4000ms → 12000 but capped to base 5000
    expect(computeAdaptiveTimeout(5000, 4000, 5, null, null)).toBe(5000);
  });

  it('falls back to PER-STAGE P95×2 before the global P95 (#68 cross-stage fix)', async () => {
    const { computeAdaptiveTimeout } = await import('../../server/ai-handlers');
    // <3 stage samples → ignore avg; use stage P95 (×2) NOT global P95.
    // stageP95=600 → 1200, even though global P95=4000 would give 8000→capped.
    expect(computeAdaptiveTimeout(5000, 999, 1, 600, 4000)).toBe(1200);
  });

  it('falls back to global P95×2 only when no per-stage P95 exists', async () => {
    const { computeAdaptiveTimeout } = await import('../../server/ai-handlers');
    expect(computeAdaptiveTimeout(5000, null, 0, null, 1000)).toBe(2000);
  });

  it('returns the fixed base when there is no data at all', async () => {
    const { computeAdaptiveTimeout } = await import('../../server/ai-handlers');
    expect(computeAdaptiveTimeout(5000, null, 0, null, null)).toBe(5000);
  });
});

describe('ai-handlers #70 — shadow timeouts are capped tighter than production', () => {
  it('shrinks to ~60% of base with a 2s floor and a base ceiling', async () => {
    const { shadowTimeoutMs } = await import('../../server/ai-handlers');
    expect(shadowTimeoutMs(10_000)).toBe(6_000);   // 60%
    expect(shadowTimeoutMs(2_500)).toBe(2_000);    // floored at 2s (60% would be 1500)
    expect(shadowTimeoutMs(1_000)).toBe(1_000);    // base < floor → clamped to base (never exceeds production)
  });

  it('never exceeds the production base (floor cannot push it above base)', async () => {
    const { shadowTimeoutMs } = await import('../../server/ai-handlers');
    // base below the floor → returns base (cannot bill MORE than production)
    expect(shadowTimeoutMs(1_500)).toBe(1_500);
  });

  it('is always <= the production timeout for realistic defaults', async () => {
    const { shadowTimeoutMs } = await import('../../server/ai-handlers');
    for (const base of [8_000, 12_000, 30_000]) {
      expect(shadowTimeoutMs(base)).toBeLessThanOrEqual(base);
    }
  });
});

describe('ai-handlers #72 — single-pass cloud provider resolver', () => {
  it('returns a profile and name that agree (one scan)', async () => {
    const { resolveCloudProvider, getCloudProfile, getCloudProviderName } = await import('../../server/ai-handlers');
    const r = resolveCloudProvider();
    expect(r).toHaveProperty('profile');
    expect(r).toHaveProperty('name');
    expect(['groq', 'ollama']).toContain(r.name);
    // Back-compat wrappers delegate to the same resolver.
    expect(getCloudProviderName()).toBe(r.name);
    expect(getCloudProfile()).toBe(r.profile);
  });
});

describe('ai-handlers #84 — avatar circuit breaker', () => {
  it('attempts while closed, opens after N failures, then probes after cooldown', async () => {
    const { avatarBreakerShouldAttempt } = await import('../../server/ai-handlers');
    const closed = { failures: 0, openedAt: null as number | null };
    expect(avatarBreakerShouldAttempt(closed, 1000)).toBe(true);

    const open = { failures: 3, openedAt: 1000 };
    // Within cooldown → skip (don't pay the 3s timeout for a dead avatar).
    expect(avatarBreakerShouldAttempt(open, 1000 + 5_000, 30_000)).toBe(false);
    // After cooldown → half-open probe allowed.
    expect(avatarBreakerShouldAttempt(open, 1000 + 30_000, 30_000)).toBe(true);
  });

  it('forwardToAvatar is a no-op fast-return when no bot endpoint (smoke)', async () => {
    const mod: any = await import('../../server/ai-handlers');
    // Should not throw; with no botState.endpoint it returns immediately.
    expect(() => mod.forwardToAvatar('AAAA')).not.toThrow();
    mod._resetAvatarBreaker?.();
  });
});

// ── server/pipeline-runner.ts — extracted pure helpers ──────────────────────

describe('pipeline-runner #66 — static chain-index resolver', () => {
  it('detects gpu-before-cloud ordering', async () => {
    const { computeChainIndices } = await import('../../server/pipeline-runner');
    const r = computeChainIndices(['runpod', 'groq', 'ollama'], new Set(['runpod', 'vast']));
    expect(r.gpuIdx).toBe(0);
    expect(r.firstCloudIdx).toBe(1);
    expect(r.gpuBeforeCloud).toBe(true);
  });
  it('detects cloud-first ordering', async () => {
    const { computeChainIndices } = await import('../../server/pipeline-runner');
    const r = computeChainIndices(['groq', 'runpod'], new Set(['runpod']));
    expect(r.gpuBeforeCloud).toBe(false);
  });
  it('handles a chain with no GPU provider', async () => {
    const { computeChainIndices } = await import('../../server/pipeline-runner');
    const r = computeChainIndices(['groq', 'ollama'], new Set(['runpod']));
    expect(r.gpuIdx).toBe(-1);
    expect(r.gpuBeforeCloud).toBe(false);
  });
});

describe('pipeline-runner #65 — modal-babelcast STT leg is bounded near the cloud leg', () => {
  it('is tighter than the old 15s and only modestly above the 8s cloud leg', async () => {
    const { MODAL_BABELCAST_STT_TIMEOUT_MS, CLOUD_STT_TIMEOUT_MS } = await import('../../server/pipeline-runner');
    expect(MODAL_BABELCAST_STT_TIMEOUT_MS).toBeLessThan(15_000);            // was 15s
    expect(MODAL_BABELCAST_STT_TIMEOUT_MS).toBeGreaterThanOrEqual(CLOUD_STT_TIMEOUT_MS); // still some cold-start margin
    expect(MODAL_BABELCAST_STT_TIMEOUT_MS - CLOUD_STT_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  });
});

describe('pipeline-runner #18 — cloud STT avg_logprob uses NaN, not a misleading 0', () => {
  it('maps a missing/undefined logprob to NaN (the filter sentinel)', async () => {
    const { cloudSttAvgLogprob } = await import('../../server/pipeline-runner');
    expect(Number.isNaN(cloudSttAvgLogprob(undefined))).toBe(true);
    expect(Number.isNaN(cloudSttAvgLogprob(null))).toBe(true);
    expect(Number.isNaN(cloudSttAvgLogprob(NaN))).toBe(true);
  });
  it('passes through a real measured logprob', async () => {
    const { cloudSttAvgLogprob } = await import('../../server/pipeline-runner');
    expect(cloudSttAvgLogprob(-0.42)).toBe(-0.42);
    expect(cloudSttAvgLogprob(0)).toBe(0); // a *real* measured 0 is preserved
  });
});

describe('pipeline-runner #74 — clone TTS never appends a cloud leg', () => {
  it('clone path is gpu+modal only (cloud cannot voice-clone)', async () => {
    const { ttsCandidateKindsForClone } = await import('../../server/pipeline-runner');
    expect(ttsCandidateKindsForClone(true)).toEqual({ gpu: true, modal: true, cloud: false });
  });
  it('non-clone path includes a cloud leg', async () => {
    const { ttsCandidateKindsForClone } = await import('../../server/pipeline-runner');
    expect(ttsCandidateKindsForClone(false).cloud).toBe(true);
  });
});

describe('pipeline-runner #61 — failed dub fanout surfaces a dub:error event', () => {
  it('builds a typed dub:error payload from an Error', async () => {
    const { buildDubErrorEvent } = await import('../../server/pipeline-runner');
    const ev = buildDubErrorEvent('fr', new Error('all targets failed'));
    expect(ev.type).toBe('dub:error');
    expect(ev.source).toBe('fr');
    expect(ev.message).toBe('all targets failed');
    expect(typeof ev.at).toBe('number');
  });
  it('coerces a non-Error rejection to a string message', async () => {
    const { buildDubErrorEvent } = await import('../../server/pipeline-runner');
    expect(buildDubErrorEvent('es', 'boom').message).toBe('boom');
  });
});

// ── server/ai-handlers-stream.ts — Buffer-native multipart parser ────────────

describe('ai-handlers-stream #82/#83 — parseMultipart on raw Buffer', () => {
  function buildMultipart(boundary: string, parts: Array<{ name: string; value: Buffer; filename?: string }>): Buffer {
    const chunks: Buffer[] = [];
    for (const p of parts) {
      const disp = p.filename
        ? `form-data; name="${p.name}"; filename="${p.filename}"`
        : `form-data; name="${p.name}"`;
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}\r\n\r\n`));
      chunks.push(p.value);
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(chunks);
  }

  it('extracts the binary audio part and text fields', async () => {
    const { parseMultipart } = await import('../../server/ai-handlers-stream');
    const audioBytes = Buffer.from([0x00, 0xff, 0x10, 0x0d, 0x0a, 0x42]); // includes CRLF-looking bytes
    const body = buildMultipart('X123', [
      { name: 'source', value: Buffer.from('fr') },
      { name: 'audio', value: audioBytes, filename: 'clip.wav' },
      { name: 'target', value: Buffer.from('en') },
    ]);
    const { audio, fields } = parseMultipart(body, 'X123');
    expect(fields.source).toBe('fr');
    expect(fields.target).toBe('en');
    expect(Buffer.compare(audio, audioBytes)).toBe(0); // exact bytes, not corrupted by latin1 roundtrip
  });

  it('treats a part with filename= as the audio even if not named "audio"', async () => {
    const { parseMultipart } = await import('../../server/ai-handlers-stream');
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const body = buildMultipart('B', [{ name: 'file', value: bytes, filename: 'a.bin' }]);
    const { audio } = parseMultipart(body, 'B');
    expect(Buffer.compare(audio, bytes)).toBe(0);
  });

  it('returns empty audio when there is no file part', async () => {
    const { parseMultipart } = await import('../../server/ai-handlers-stream');
    const body = buildMultipart('B', [{ name: 'style', value: Buffer.from('formal') }]);
    const { audio, fields } = parseMultipart(body, 'B');
    expect(audio.length).toBe(0);
    expect(fields.style).toBe('formal');
  });

  it('preserves binary bytes that would corrupt under latin1 string round-trip', async () => {
    const { parseMultipart } = await import('../../server/ai-handlers-stream');
    // High bytes + a NUL — a latin1 string split + re-encode can mangle these.
    const tricky = Buffer.from([0x80, 0x00, 0xc3, 0xa9, 0xfe, 0xff]);
    const body = buildMultipart('Z', [{ name: 'audio', value: tricky, filename: 'x' }]);
    const { audio } = parseMultipart(body, 'Z');
    expect(Buffer.compare(audio, tricky)).toBe(0);
  });
});
