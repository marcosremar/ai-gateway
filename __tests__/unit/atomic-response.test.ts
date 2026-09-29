/**
 * atomic-response unit tests
 *
 * Covers the three pure helpers that build the /v1/speech JSON response body:
 *   - computeNetworkMs  — GPU-only network overhead calculation
 *   - extractAtomicAudio — Buffer / Uint8Array normalisation
 *   - buildAtomicResponseBody — full response shape and timing field propagation
 */

import { describe, it, expect } from 'vitest';
import {
  computeNetworkMs,
  extractAtomicAudio,
  buildAtomicResponseBody,
  type AtomicPipelineResult,
} from '../../src/gateway/pipeline/atomic-response';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<AtomicPipelineResult> = {}): AtomicPipelineResult {
  return {
    stt: { text: 'Hello', latencyMs: 200, provider: 'gpu' },
    chat: { content: 'Bonjour', latencyMs: 300, provider: 'gpu' },
    tts: { audio: Buffer.from('AUDIO'), contentType: 'audio/wav', latencyMs: 400, provider: 'gpu' },
    totalLatencyMs: 1000,
    usedGpu: true,
    ...overrides,
  };
}

// ── computeNetworkMs ─────────────────────────────────────────────────────────

describe('computeNetworkMs', () => {
  it('returns undefined when usedGpu is false', () => {
    const result = makeResult({ usedGpu: false });
    expect(computeNetworkMs(result)).toBeUndefined();
  });

  it('returns the difference between total and sum of stage latencies', () => {
    // total=1000, stt=200+llm=300+tts=400 → server=900 → network=100
    const result = makeResult({ totalLatencyMs: 1000 });
    expect(computeNetworkMs(result)).toBe(100);
  });

  it('clamps to 0 when server total exceeds totalLatencyMs', () => {
    // Server reports more than total (clock skew / measurement noise)
    const result = makeResult({ totalLatencyMs: 500 }); // server=900 > total=500
    expect(computeNetworkMs(result)).toBe(0);
  });

  it('treats missing stt.latencyMs as 0', () => {
    const result = makeResult({
      stt: { text: 'x', provider: 'gpu' }, // no latencyMs
      chat: { content: 'y', latencyMs: 100, provider: 'gpu' },
      tts: { latencyMs: 100, contentType: 'audio/wav' },
      totalLatencyMs: 400,
    });
    // server = 0 + 100 + 100 = 200 → network = 200
    expect(computeNetworkMs(result)).toBe(200);
  });

  it('treats missing chat.latencyMs as 0', () => {
    const result = makeResult({
      stt: { text: 'x', latencyMs: 100, provider: 'gpu' },
      chat: { content: 'y' }, // no latencyMs
      tts: { latencyMs: 100, contentType: 'audio/wav' },
      totalLatencyMs: 400,
    });
    expect(computeNetworkMs(result)).toBe(200);
  });

  it('treats missing tts as 0 for ttsMs', () => {
    const result = makeResult({
      tts: undefined,
      stt: { text: 'x', latencyMs: 100, provider: 'gpu' },
      chat: { content: 'y', latencyMs: 200, provider: 'gpu' },
      totalLatencyMs: 500,
    });
    // server = 100 + 200 + 0 = 300 → network = 200
    expect(computeNetworkMs(result)).toBe(200);
  });

  it('returns 0 when all stage latencies exactly equal totalLatencyMs', () => {
    const result = makeResult({
      stt: { text: 'x', latencyMs: 333, provider: 'gpu' },
      chat: { content: 'y', latencyMs: 333, provider: 'gpu' },
      tts: { latencyMs: 334, contentType: 'audio/wav' },
      totalLatencyMs: 1000,
    });
    expect(computeNetworkMs(result)).toBe(0);
  });

  it('handles all-zero latencies (GPU path with no timing data)', () => {
    const result = makeResult({
      stt: { text: 'x', latencyMs: 0, provider: 'gpu' },
      chat: { content: 'y', latencyMs: 0, provider: 'gpu' },
      tts: { latencyMs: 0, contentType: 'audio/wav' },
      totalLatencyMs: 0,
    });
    expect(computeNetworkMs(result)).toBe(0);
  });
});

// ── extractAtomicAudio ───────────────────────────────────────────────────────

describe('extractAtomicAudio', () => {
  it('returns undefined when tts is absent', () => {
    expect(extractAtomicAudio(makeResult({ tts: undefined }))).toBeUndefined();
  });

  it('returns undefined when tts.audio is absent', () => {
    const result = makeResult({ tts: { contentType: 'audio/wav' } });
    expect(extractAtomicAudio(result)).toBeUndefined();
  });

  it('returns the Buffer as-is when already a Buffer', () => {
    const buf = Buffer.from([1, 2, 3]);
    const result = makeResult({ tts: { audio: buf, contentType: 'audio/wav' } });
    const out = extractAtomicAudio(result);
    expect(out).toBe(buf); // same reference
    expect(Buffer.isBuffer(out)).toBe(true);
  });

  it('converts Uint8Array to Buffer', () => {
    const arr = new Uint8Array([10, 20, 30]);
    const result = makeResult({ tts: { audio: arr, contentType: 'audio/wav' } });
    const out = extractAtomicAudio(result);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out).toEqual(Buffer.from(arr));
  });

  it('returns a non-empty Buffer for non-empty audio', () => {
    const buf = Buffer.from('wav-data');
    const result = makeResult({ tts: { audio: buf, contentType: 'audio/wav' } });
    expect(extractAtomicAudio(result)?.length).toBeGreaterThan(0);
  });

  it('returns an empty Buffer for an empty Uint8Array', () => {
    const arr = new Uint8Array(0);
    const result = makeResult({ tts: { audio: arr, contentType: 'audio/wav' } });
    const out = extractAtomicAudio(result);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out?.length).toBe(0);
  });
});

// ── buildAtomicResponseBody ──────────────────────────────────────────────────

describe('buildAtomicResponseBody', () => {
  it('maps stt.text to transcription', () => {
    const result = makeResult({ stt: { text: 'Allo monde', latencyMs: 100, provider: 'gpu' } });
    expect(buildAtomicResponseBody(result, '', false).transcription).toBe('Allo monde');
  });

  it('maps chat.content to response', () => {
    const result = makeResult({ chat: { content: 'Hello world', latencyMs: 100, provider: 'gpu' } });
    expect(buildAtomicResponseBody(result, '', false).response).toBe('Hello world');
  });

  it('passes audioB64 through to audio_base64', () => {
    const b64 = Buffer.from('audio').toString('base64');
    expect(buildAtomicResponseBody(makeResult(), b64, false).audio_base64).toBe(b64);
  });

  it('maps tts.contentType to content_type', () => {
    const result = makeResult({ tts: { audio: Buffer.from('x'), contentType: 'audio/mp3', latencyMs: 100, provider: 'gpu' } });
    expect(buildAtomicResponseBody(result, '', false).content_type).toBe('audio/mp3');
  });

  it('defaults content_type to empty string when tts is absent', () => {
    const result = makeResult({ tts: undefined });
    expect(buildAtomicResponseBody(result, '', false).content_type).toBe('');
  });

  it('propagates totalLatencyMs as timing.total_ms', () => {
    const result = makeResult({ totalLatencyMs: 1234 });
    expect(buildAtomicResponseBody(result, '', false).timing.total_ms).toBe(1234);
  });

  it('propagates stage latencies into timing', () => {
    const result = makeResult({
      stt: { text: 'x', latencyMs: 111, provider: 'gpu' },
      chat: { content: 'y', latencyMs: 222, provider: 'gpu' },
      tts: { latencyMs: 333, contentType: 'audio/wav' },
      totalLatencyMs: 700,
    });
    const body = buildAtomicResponseBody(result, '', false);
    expect(body.timing.stt_ms).toBe(111);
    expect(body.timing.llm_ms).toBe(222);
    expect(body.timing.tts_ms).toBe(333);
  });

  it('propagates usedGpu into timing.used_gpu', () => {
    expect(buildAtomicResponseBody(makeResult({ usedGpu: true }), '', false).timing.used_gpu).toBe(true);
    expect(buildAtomicResponseBody(makeResult({ usedGpu: false }), '', false).timing.used_gpu).toBe(false);
  });

  it('propagates provider fields into timing', () => {
    const result = makeResult({
      stt: { text: 'x', provider: 'groq', latencyMs: 100 },
      chat: { content: 'y', provider: 'fireworks', latencyMs: 100 },
      tts: { provider: 'openai', contentType: 'audio/wav', latencyMs: 100 },
    });
    const body = buildAtomicResponseBody(result, '', false);
    expect(body.timing.stt_provider).toBe('groq');
    expect(body.timing.llm_provider).toBe('fireworks');
    expect(body.timing.tts_provider).toBe('openai');
  });

  it('defaults provider fields to "cloud" when absent', () => {
    const result = makeResult({
      stt: { text: 'x' },
      chat: { content: 'y' },
      tts: { contentType: 'audio/wav' },
      usedGpu: false,
    });
    const body = buildAtomicResponseBody(result, '', false);
    expect(body.timing.stt_provider).toBe('cloud');
    expect(body.timing.llm_provider).toBe('cloud');
    expect(body.timing.tts_provider).toBe('cloud');
  });

  it('sets timing.clone from the isCloneRequest flag', () => {
    expect(buildAtomicResponseBody(makeResult(), '', true).timing.clone).toBe(true);
    expect(buildAtomicResponseBody(makeResult(), '', false).timing.clone).toBe(false);
  });

  // ── GPU network overhead fields ──────────────────────────────────────────

  it('includes network_ms and server_total_ms in timing when GPU was used', () => {
    // stt=200 llm=300 tts=400 → server=900 → network=100 (total=1000)
    const result = makeResult({ totalLatencyMs: 1000 });
    const body = buildAtomicResponseBody(result, '', false);
    expect(body.timing.network_ms).toBe(100);
    expect(body.timing.server_total_ms).toBe(900);
  });

  it('omits network_ms and server_total_ms when GPU was NOT used', () => {
    const result = makeResult({ usedGpu: false });
    const body = buildAtomicResponseBody(result, '', false);
    expect(body.timing.network_ms).toBeUndefined();
    expect(body.timing.server_total_ms).toBeUndefined();
  });

  it('clamps network_ms to 0 when server total exceeds total latency', () => {
    // server=900, total=400 → network would be negative → clamped to 0
    const result = makeResult({ totalLatencyMs: 400 });
    const body = buildAtomicResponseBody(result, '', false);
    expect(body.timing.network_ms).toBe(0);
    expect(body.timing.server_total_ms).toBe(900);
  });

  it('handles zero-latency GPU result (no timing data available)', () => {
    const result = makeResult({
      stt: { text: 'x', latencyMs: 0, provider: 'gpu' },
      chat: { content: 'y', latencyMs: 0, provider: 'gpu' },
      tts: { latencyMs: 0, contentType: 'audio/wav', provider: 'gpu' },
      totalLatencyMs: 0,
      usedGpu: true,
    });
    const body = buildAtomicResponseBody(result, '', false);
    expect(body.timing.network_ms).toBe(0);
    expect(body.timing.server_total_ms).toBe(0);
  });

  it('handles missing tts in timing fields', () => {
    const result = makeResult({
      tts: undefined,
      stt: { text: 'x', latencyMs: 100, provider: 'groq' },
      chat: { content: 'y', latencyMs: 200, provider: 'groq' },
      totalLatencyMs: 300,
      usedGpu: false,
    });
    const body = buildAtomicResponseBody(result, '', false);
    expect(body.timing.tts_ms).toBe(0);
    expect(body.timing.tts_provider).toBe('cloud');
    expect(body.content_type).toBe('');
  });

  it('returns a complete AtomicResponseBody shape', () => {
    const result = makeResult();
    const body = buildAtomicResponseBody(result, 'b64audio', false);
    expect(body).toHaveProperty('transcription');
    expect(body).toHaveProperty('response');
    expect(body).toHaveProperty('audio_base64');
    expect(body).toHaveProperty('content_type');
    expect(body).toHaveProperty('timing');
    expect(body.timing).toHaveProperty('total_ms');
    expect(body.timing).toHaveProperty('stt_ms');
    expect(body.timing).toHaveProperty('llm_ms');
    expect(body.timing).toHaveProperty('tts_ms');
    expect(body.timing).toHaveProperty('used_gpu');
    expect(body.timing).toHaveProperty('stt_provider');
    expect(body.timing).toHaveProperty('llm_provider');
    expect(body.timing).toHaveProperty('tts_provider');
    expect(body.timing).toHaveProperty('clone');
  });
});
