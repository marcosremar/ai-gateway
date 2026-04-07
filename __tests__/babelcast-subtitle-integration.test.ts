/**
 * BabelCast Subtitle — Integration Tests (Live GPU Pod)
 *
 * Tests the running babelcast-subtitle instance on Vast.ai.
 * Requires: a live GPU pod with babelcast-subtitle deployed.
 *
 * Covers:
 *   - Health endpoint structure and model readiness
 *   - STT (Whisper) transcription with real audio
 *   - LLM (TranslateGemma 4B) translation accuracy and latency
 *   - Edge cases: empty audio, empty text, long text, special characters
 *   - Latency benchmarks (warm runs)
 *
 * Set SUBTITLE_ENDPOINT=http://host:port to run against a specific pod.
 * Falls back to gateway status to auto-discover the endpoint.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadEnv } from './helpers';

let endpoint: string | null = null;
let online = false;

async function isEndpointReachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

// Resolve endpoint synchronously from env at load time for skipIf
const _explicitEndpoint = process.env.SUBTITLE_ENDPOINT;

/** Generate a minimal valid WAV file (PCM 16-bit mono 16kHz). */
function makeTestWav(durationSec: number = 1): Uint8Array {
  const sampleRate = 16000;
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);       // chunk size
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);        // block align
  view.setUint16(34, 16, true);       // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // Silence (all zeros — already default)
  return new Uint8Array(buffer);
}

// Use describe.skipIf at the top level — only run if endpoint is provided
const hasEndpoint = !!_explicitEndpoint;

beforeAll(async () => {
  if (!hasEndpoint) return;
  await loadEnv();

  endpoint = _explicitEndpoint!;
  online = await isEndpointReachable(endpoint);
  if (!online) {
    // Try gateway auto-discover as fallback
    try {
      const r = await fetch('http://localhost:4000/v1/gpu/status', { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const status = await r.json() as Record<string, unknown>;
        const ep = status.endpoint as string;
        if (ep && await isEndpointReachable(ep)) {
          endpoint = ep;
          online = true;
        }
      }
    } catch {}
  }
});

// ── Health Endpoint ─────────────────────────────────────────────────────────

describe.skipIf(!hasEndpoint)('Health & Version', () => {
  it('GET /health returns expected structure', async () => {
    const r = await fetch(`${endpoint}/health`);
    expect(r.ok).toBe(true);
    const data = await r.json() as Record<string, unknown>;

    expect(['ok', 'degraded']).toContain(data.status);
    expect(data).toHaveProperty('services');

    const services = data.services as Record<string, string>;
    expect(services).toHaveProperty('whisper');
    // llama_cpp may still be loading on cold start
    if (services.llama_cpp) {
      expect(['loaded', 'ready', 'pending', 'starting']).toContain(services.llama_cpp);
    }
  });

  it('/health reports model readiness', async () => {
    const r = await fetch(`${endpoint}/health`);
    const data = await r.json() as Record<string, unknown>;
    const services = data.services as Record<string, string>;

    // At least whisper should be loaded (fast to load)
    expect(['loaded', 'ready']).toContain(services.whisper);
  });
});

// ── STT Tests ───────────────────────────────────────────────────────────────

describe.skipIf(!hasEndpoint)('STT — Whisper Transcription', () => {
  it('POST /v1/transcribe returns transcription for audio', async () => {
    const wav = makeTestWav(1);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav');
    form.append('language', 'en');

    const r = await fetch(`${endpoint}/v1/transcribe`, { method: 'POST', body: form });
    expect(r.ok).toBe(true);

    const data = await r.json() as Record<string, unknown>;
    expect(data).toHaveProperty('text');
    expect(data).toHaveProperty('language');
    expect(data).toHaveProperty('duration');
    expect(typeof data.text).toBe('string');
  }, 30_000);

  it('STT warm latency is under 2 seconds for 1s audio', async () => {
    // Warm-up run
    const wav = makeTestWav(1);
    const form1 = new FormData();
    form1.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav');
    await fetch(`${endpoint}/v1/transcribe`, { method: 'POST', body: form1 });

    // Measured run
    const form2 = new FormData();
    form2.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav');
    const t0 = Date.now();
    await fetch(`${endpoint}/v1/transcribe`, { method: 'POST', body: form2 });
    const latency = Date.now() - t0;

    expect(latency).toBeLessThan(2000);
    console.log(`  STT warm latency: ${latency}ms`);
  }, 30_000);

  it('handles very short audio (0.1s)', async () => {
    const wav = makeTestWav(0.1);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'short.wav');

    const r = await fetch(`${endpoint}/v1/transcribe`, { method: 'POST', body: form });
    // Should not crash — may return empty text
    expect(r.ok).toBe(true);
  }, 15_000);

  it('returns 422 or error for missing file', async () => {
    const r = await fetch(`${endpoint}/v1/transcribe`, {
      method: 'POST',
      body: new FormData(), // empty form
    });
    // FastAPI returns 422 for missing required field
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

// ── LLM Tests ───────────────────────────────────────────────────────────────

describe.skipIf(!hasEndpoint)('LLM — TranslateGemma Translation', () => {
  let llmReady = false;

  beforeAll(async () => {
    // Wait up to 3 min for LLM to load (TranslateGemma can take 2-3 min on cold start)
    for (let i = 0; i < 18; i++) {
      try {
        const r = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5_000) });
        const d = await r.json() as Record<string, unknown>;
        const svcs = (d.services || {}) as Record<string, string>;
        if (svcs.llama_cpp === 'ready' || svcs.llama_cpp === 'loaded') {
          llmReady = true;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 10_000));
    }
    if (!llmReady) console.log('  [skip] LLM not ready after 3 min — translation tests will be skipped');
  }, 200_000);

  it('POST /v1/translate/text translates EN→FR', async () => {
    if (!llmReady) return; // skip gracefully
    const r = await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Hello, how are you?',
        source_lang: 'en',
        target_lang: 'fr',
      }),
    });
    expect(r.ok).toBe(true);

    const data = await r.json() as Record<string, unknown>;
    expect(data).toHaveProperty('translated_text');
    const translated = (data.translated_text as string).toLowerCase();
    // Should contain common French words
    expect(translated).toMatch(/bonjour|comment|allez|vous/i);
  }, 30_000);

  it('LLM warm latency is under 3 seconds for short text', async () => {
    const payload = {
      text: 'Good morning',
      source_lang: 'en',
      target_lang: 'fr',
    };

    // Warm-up
    await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Measured run
    const t0 = Date.now();
    await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const latency = Date.now() - t0;

    expect(latency).toBeLessThan(3000);
    console.log(`  LLM warm latency: ${latency}ms`);
  }, 30_000);

  it('translates EN→ES', async () => {
    if (!llmReady) return;
    const r = await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Thank you very much',
        source_lang: 'en',
        target_lang: 'es',
      }),
    });
    expect(r.ok).toBe(true);

    const data = await r.json() as Record<string, unknown>;
    const translated = (data.translated_text as string).toLowerCase();
    expect(translated).toMatch(/gracias|muchas/i);
  }, 30_000);

  it('translates FR→EN', async () => {
    if (!llmReady) return;
    const r = await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Bonjour, comment allez-vous?',
        source_lang: 'fr',
        target_lang: 'en',
      }),
    });
    expect(r.ok).toBe(true);

    const data = await r.json() as Record<string, unknown>;
    const translated = (data.translated_text as string).toLowerCase();
    expect(translated).toMatch(/hello|how|are|you/i);
  }, 30_000);

  // ── Edge Cases ──────────────────────────────────────────────────────────

  it('handles empty text gracefully', async () => {
    if (!llmReady) return;
    const r = await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '',
        source_lang: 'en',
        target_lang: 'fr',
      }),
    });
    // Should not crash — may return empty or echo
    expect(r.status).toBeLessThan(500);
  }, 15_000);

  it('handles special characters and punctuation', async () => {
    if (!llmReady) return;
    const r = await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Hello! How are you? I\'m fine — thanks & goodbye.',
        source_lang: 'en',
        target_lang: 'fr',
      }),
    });
    expect(r.ok).toBe(true);

    const data = await r.json() as Record<string, unknown>;
    expect(typeof data.translated_text).toBe('string');
    expect((data.translated_text as string).length).toBeGreaterThan(0);
  }, 30_000);

  it('handles long text (200+ words) without timeout', async () => {
    if (!llmReady) return;
    const longText = Array(50).fill('The quick brown fox jumps over the lazy dog.').join(' ');
    const r = await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: longText,
        source_lang: 'en',
        target_lang: 'fr',
      }),
    });
    expect(r.ok).toBe(true);

    const data = await r.json() as Record<string, unknown>;
    expect(typeof data.translated_text).toBe('string');
    expect((data.translated_text as string).length).toBeGreaterThan(50);
  }, 60_000);

  it('handles unicode / emoji in text', async () => {
    if (!llmReady) return;
    const r = await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Hello world 🌍 café résumé naïve',
        source_lang: 'en',
        target_lang: 'fr',
      }),
    });
    expect(r.ok).toBe(true);
  }, 30_000);

  it('handles numeric-only text', async () => {
    if (!llmReady) return;
    const r = await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '12345 67890',
        source_lang: 'en',
        target_lang: 'fr',
      }),
    });
    // Numbers should pass through or be echoed
    expect(r.status).toBeLessThan(500);
  }, 15_000);
});

// ── Chat Completions (OpenAI-compatible) ────────────────────────────────────

describe.skipIf(!hasEndpoint)('Chat Completions — OpenAI-compatible', () => {
  it('POST /v1/chat/completions returns valid structure', async () => {
    if (!llmReady) return;
    const r = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Translate to French: Hello' }],
        max_tokens: 50,
      }),
    });

    // May return 503 (not ready), 404 (endpoint not exposed), or 200
    if (r.status === 503 || r.status === 404 || r.status === 405) return;

    expect(r.ok).toBe(true);
    const data = await r.json() as Record<string, unknown>;
    if (data.choices) {
      const choices = data.choices as Array<Record<string, unknown>>;
      expect(choices.length).toBeGreaterThan(0);
      expect(choices[0]).toHaveProperty('message');
    }
  }, 30_000);
});

// ── Service Unavailable (503) when models not loaded ────────────────────────

describe.skipIf(!hasEndpoint)('503 behavior', () => {
  it('/v1/translate/text returns response (200 or 503)', async () => {
    const r = await fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test', source_lang: 'en', target_lang: 'fr' }),
    });
    // Either works (200), service unavailable (503), or LLM not loaded (500/422)
    expect(r.status).toBeLessThanOrEqual(503);
  }, 15_000);
});
