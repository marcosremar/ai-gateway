/**
 * Tests for benchmarking/bench.ts
 * - makeTestWav()
 * - runHealthCheck()
 * - runSSEBench()
 */

import { describe, it, expect, vi } from 'vitest';
import { makeTestWav, runHealthCheck, runSSEBench } from '../src/benchmarking/bench';

describe('makeTestWav', () => {
  it('generates a valid WAV buffer', () => {
    const wav = makeTestWav();
    expect(wav).toBeInstanceOf(Buffer);
    expect(wav.length).toBeGreaterThan(44); // header (44 bytes) + audio data
  });

  it('starts with RIFF header', () => {
    const wav = makeTestWav();
    expect(wav.slice(0, 4).toString()).toBe('RIFF');
    expect(wav.slice(8, 12).toString()).toBe('WAVE');
  });

  it('has correct PCM format marker', () => {
    const wav = makeTestWav();
    expect(wav.readUInt16LE(20)).toBe(1); // PCM format
    expect(wav.readUInt16LE(22)).toBe(1); // mono
  });

  it('generates 1 second at 16kHz by default', () => {
    const wav = makeTestWav(1, 16000);
    const numSamples = 16000;
    const expectedSize = 44 + numSamples * 2; // header + PCM samples (16-bit)
    expect(wav.length).toBe(expectedSize);
  });

  it('respects durationSecs parameter', () => {
    const wav05 = makeTestWav(0.5, 16000);
    const wav2 = makeTestWav(2, 16000);
    expect(wav2.length).toBeGreaterThan(wav05.length);
  });

  it('respects sampleRate parameter', () => {
    const wav8k = makeTestWav(1, 8000);
    const wav16k = makeTestWav(1, 16000);
    // 16kHz has 2x more samples = 2x larger data section
    expect(wav16k.length).toBeGreaterThan(wav8k.length);
  });

  it('has correct sample rate in header', () => {
    const sampleRate = 22050;
    const wav = makeTestWav(1, sampleRate);
    expect(wav.readUInt32LE(24)).toBe(sampleRate);
  });

  it('generates non-silent audio (440Hz sine wave)', () => {
    const wav = makeTestWav(0.1, 16000);
    // Check that samples are not all zero
    let hasNonZero = false;
    for (let i = 44; i < wav.length - 1; i += 2) {
      if (wav.readInt16LE(i) !== 0) { hasNonZero = true; break; }
    }
    expect(hasNonZero).toBe(true);
  });
});

describe('runHealthCheck', () => {
  it('returns ok=true on 200 response', async () => {
    const mockFetch = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'healthy' }),
    }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await runHealthCheck('http://test-endpoint:8000');
      expect(result.ok).toBe(true);
      expect(result.latency_ms).toBeGreaterThanOrEqual(0);
      expect(result.data).toEqual({ status: 'healthy' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns ok=false on non-200 response', async () => {
    const mockFetch = vi.fn(async (_url: string) => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await runHealthCheck('http://test-endpoint:8000');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('503');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns ok=false on network error', async () => {
    const mockFetch = vi.fn(async () => { throw new Error('Connection refused'); });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await runHealthCheck('http://unreachable:8000');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Connection refused');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes latency in result', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await runHealthCheck('http://test:8000');
      expect(typeof result.latency_ms).toBe('number');
      expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('calls correct health endpoint', async () => {
    let calledUrl = '';
    const mockFetch = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await runHealthCheck('http://gpu-backend:8000');
      expect(calledUrl).toBe('http://gpu-backend:8000/health');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('runSSEBench', () => {
  function makeSSEResponse(events: Array<{ event: string; data: unknown }>) {
    const lines = events
      .map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
      .join('');
    const encoder = new TextEncoder();
    const encoded = encoder.encode(lines);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });

    return {
      ok: true,
      status: 200,
      body: stream,
    };
  }

  it('returns ok=false on HTTP error', async () => {
    const mockFetch = vi.fn(async () => ({ ok: false, status: 500, body: null }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await runSSEBench('http://test:8000');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('500');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns ok=false on network error', async () => {
    const mockFetch = vi.fn(async () => { throw new Error('Network failed'); });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await runSSEBench('http://test:8000');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network failed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses transcript event', async () => {
    const mockFetch = vi.fn(async () => makeSSEResponse([
      { event: 'transcript', data: { transcript: 'Hello world', stt_ms: 150 } },
      { event: 'response', data: { response: 'Hi there', llm_ms: 200 } },
      { event: 'audio', data: { audio: 'base64data' } },
    ]));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await runSSEBench('http://test:8000');
      expect(result.ok).toBe(true);
      expect(result.transcript).toBe('Hello world');
      expect(result.stt_ms).toBe(150);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('captures ttfa_ms from first audio event', async () => {
    const mockFetch = vi.fn(async () => makeSSEResponse([
      { event: 'transcript', data: { transcript: 'Test' } },
      { event: 'audio', data: { audio: 'data1' } },
      { event: 'audio', data: { audio: 'data2' } },
    ]));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await runSSEBench('http://test:8000');
      expect(result.ttfa_ms).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('extracts timing from complete event', async () => {
    const mockFetch = vi.fn(async () => makeSSEResponse([
      { event: 'complete', data: { timing: { stt_ms: 100, llm_ms: 200, tts_ms: 300 } } },
    ]));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await runSSEBench('http://test:8000');
      expect(result.tts_ms).toBe(300);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses provided testWav', async () => {
    let requestBody = '';
    const mockFetch = vi.fn(async (_url: string, opts: RequestInit) => {
      requestBody = opts.body as string;
      return makeSSEResponse([]);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const customWav = Buffer.from('custom-wav-data');
      await runSSEBench('http://test:8000', customWav);
      const parsed = JSON.parse(requestBody);
      expect(parsed.audio_base64).toBe(customWav.toString('base64'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('generates default testWav when not provided', async () => {
    let requestBody = '';
    const mockFetch = vi.fn(async (_url: string, opts: RequestInit) => {
      requestBody = opts.body as string;
      return makeSSEResponse([]);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await runSSEBench('http://test:8000');
      const parsed = JSON.parse(requestBody);
      expect(parsed.audio_base64).toBeDefined();
      expect(parsed.audio_base64.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
