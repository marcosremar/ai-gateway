/**
 * Unit tests for small Modal provider implementations:
 *   - ModalVoxtralSTTProvider (src/providers/modal-voxtral)
 *   - ModalKokoroTTSProvider (src/providers/modal-kokoro)
 *   - ModalSeamlessSTTProvider + ModalSeamlessLLMProvider (src/providers/modal-seamless)
 *   - Qwen3ASRPipelineSTTProvider (src/providers/modal-qwen3asr-pipeline)
 *
 * All network calls are mocked via vi.stubGlobal('fetch', ...).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { ModalVoxtralSTTProvider, VOXTRAL_MODELS } from '../../src/providers/modal-voxtral';
import { ModalKokoroTTSProvider, MODAL_KOKORO_MODELS } from '../../src/providers/modal-kokoro';
import {
  ModalSeamlessSTTProvider,
  ModalSeamlessLLMProvider,
  SEAMLESS_MODELS,
} from '../../src/providers/modal-seamless';
import {
  Qwen3ASRPipelineSTTProvider,
  Qwen3ASRPipelineLLMProvider,
  QWEN3ASR_PIPELINE_MODELS,
} from '../../src/providers/modal-qwen3asr-pipeline';
import { ModalMossTTSProvider, MODAL_MOSS_TTS_MODELS } from '../../src/providers/modal-moss';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, textBody?: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => textBody ?? JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(8),
  })));
}

const AUDIO = Buffer.from([0, 1, 2, 3]);

afterEach(() => vi.unstubAllGlobals());

// ── ModalVoxtralSTTProvider ──────────────────────────────────────────────────

describe('ModalVoxtralSTTProvider', () => {
  it('providerId is modal-voxtral', () => {
    expect(new ModalVoxtralSTTProvider().providerId).toBe('modal-voxtral');
  });

  it('isConfigured returns true', () => {
    expect(new ModalVoxtralSTTProvider().isConfigured()).toBe(true);
  });

  it('getModels returns VOXTRAL_MODELS', () => {
    expect(new ModalVoxtralSTTProvider().getModels()).toEqual(VOXTRAL_MODELS);
  });

  it('transcribes audio successfully', async () => {
    mockFetch(200, { text: 'bonjour', language: 'fr', duration: 1.5 });
    const provider = new ModalVoxtralSTTProvider('http://test');
    const result = await provider.transcribe({ audio: AUDIO, model: 'voxtral-mini-3b', language: 'fr' });
    expect(result.text).toBe('bonjour');
    expect(result.language).toBe('fr');
    expect(result.duration).toBe(1.5);
  });

  it('throws on non-ok response', async () => {
    mockFetch(500, null, 'server error');
    const provider = new ModalVoxtralSTTProvider('http://test');
    await expect(provider.transcribe({ audio: AUDIO, model: 'voxtral-mini-3b' })).rejects.toThrow('Voxtral STT error (500)');
  });

  it('uses MODAL_VOXTRAL_URL env var when no endpoint passed', async () => {
    process.env.MODAL_VOXTRAL_URL = 'http://env-voxtral';
    const fetchMock = vi.fn(async () => ({
      ok: true, json: async () => ({ text: 'ok', language: 'fr', duration: 1 }),
      text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ModalVoxtralSTTProvider();
    await provider.transcribe({ audio: AUDIO, model: 'voxtral-mini-3b' });
    expect(fetchMock.mock.calls[0][0]).toContain('env-voxtral');
    delete process.env.MODAL_VOXTRAL_URL;
  });

  it('accepts Buffer audio', async () => {
    mockFetch(200, { text: 'hello', language: 'en', duration: 0.5 });
    const provider = new ModalVoxtralSTTProvider('http://test');
    await expect(provider.transcribe({ audio: AUDIO, model: 'voxtral-mini-3b' })).resolves.toBeDefined();
  });

  it('accepts Blob audio', async () => {
    mockFetch(200, { text: 'hello', language: 'en', duration: 0.5 });
    const provider = new ModalVoxtralSTTProvider('http://test');
    const blob = new Blob([AUDIO], { type: 'audio/wav' });
    await expect(provider.transcribe({ audio: blob as any, model: 'voxtral-mini-3b' })).resolves.toBeDefined();
  });
});

// ── ModalKokoroTTSProvider ───────────────────────────────────────────────────

describe('ModalKokoroTTSProvider', () => {
  it('providerId is modal', () => {
    expect(new ModalKokoroTTSProvider().providerId).toBe('modal');
  });

  it('isConfigured returns true', () => {
    expect(new ModalKokoroTTSProvider().isConfigured()).toBe(true);
  });

  it('getModels returns MODAL_KOKORO_MODELS', () => {
    expect(new ModalKokoroTTSProvider().getModels()).toEqual(MODAL_KOKORO_MODELS);
  });

  it('getVoices returns non-empty list', () => {
    const voices = new ModalKokoroTTSProvider().getVoices();
    expect(voices.length).toBeGreaterThan(0);
  });

  it('synthesize returns audio buffer', async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
      arrayBuffer: async () => audioData.buffer,
    })));
    const provider = new ModalKokoroTTSProvider('http://test');
    const result = await provider.synthesize({ input: 'hello world', model: 'kokoro-82m' });
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.contentType).toBe('audio/wav');
  });

  it('throws on non-ok synthesis response', async () => {
    mockFetch(503, null, 'service unavailable');
    const provider = new ModalKokoroTTSProvider('http://test');
    await expect(provider.synthesize({ input: 'test', model: 'kokoro-82m' })).rejects.toThrow('Kokoro TTS error (503)');
  });

  it('uses af_heart voice when unknown voice requested', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(4),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ModalKokoroTTSProvider('http://test');
    await provider.synthesize({ input: 'test', model: 'kokoro-82m', voice: 'nonexistent-voice' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.voice).toBe('af_heart');
  });

  it('uses provided voice when it exists in catalog', async () => {
    const voices = new ModalKokoroTTSProvider().getVoices();
    const validVoice = voices[0].id;
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(4),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ModalKokoroTTSProvider('http://test');
    await provider.synthesize({ input: 'test', model: 'kokoro-82m', voice: validVoice });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.voice).toBe(validVoice);
  });

  it('synthesizeStream returns ReadableStream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(4),
    })));
    const provider = new ModalKokoroTTSProvider('http://test');
    const stream = await provider.synthesizeStream({ input: 'test', model: 'kokoro-82m' });
    expect(stream).toBeInstanceOf(ReadableStream);
    // Read from stream
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(value).toBeInstanceOf(Uint8Array);
  });

  it('uses MODAL_KOKORO_URL env var', async () => {
    process.env.MODAL_KOKORO_URL = 'http://env-kokoro';
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(4),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ModalKokoroTTSProvider();
    await provider.synthesize({ input: 'test', model: 'kokoro-82m' });
    expect(fetchMock.mock.calls[0][0]).toContain('env-kokoro');
    delete process.env.MODAL_KOKORO_URL;
  });
});

// ── ModalSeamlessSTTProvider ────────────────────────────────────────────────

describe('ModalSeamlessSTTProvider', () => {
  it('providerId is modal-seamless', () => {
    expect(new ModalSeamlessSTTProvider().providerId).toBe('modal-seamless');
  });

  it('isConfigured returns true', () => {
    expect(new ModalSeamlessSTTProvider().isConfigured()).toBe(true);
  });

  it('getModels returns stt models only', () => {
    const models = new ModalSeamlessSTTProvider().getModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every(m => m.capability === 'stt')).toBe(true);
  });

  it('transcribes audio (ASR mode)', async () => {
    mockFetch(200, { text: 'bonjour', language: 'fr', duration_ms: 1200 });
    const provider = new ModalSeamlessSTTProvider('http://test');
    const result = await provider.transcribe({ audio: AUDIO, model: 'seamless-m4t-v2-large', language: 'fr' });
    expect(result.text).toBe('bonjour');
    expect(result.language).toBe('fr');
    expect(result.duration).toBe(1.2);
  });

  it('translates speech (S2TT mode when targetLang differs)', async () => {
    mockFetch(200, { text: 'hello world', language: 'en', duration_ms: 800 });
    const provider = new ModalSeamlessSTTProvider('http://test', 'en'); // targetLang = 'en'
    const result = await provider.transcribe({ audio: AUDIO, model: 'seamless-m4t-v2-large', language: 'fr' });
    expect(result.text).toBe('hello world');
  });

  it('throws on non-ok response', async () => {
    mockFetch(422, null, 'unsupported language');
    const provider = new ModalSeamlessSTTProvider('http://test');
    await expect(provider.transcribe({ audio: AUDIO, model: 'seamless-m4t-v2-large' })).rejects.toThrow('SeamlessM4T ASR error (422)');
  });
});

// ── ModalSeamlessLLMProvider ─────────────────────────────────────────────────

describe('ModalSeamlessLLMProvider', () => {
  it('isConfigured returns true', () => {
    expect(new ModalSeamlessLLMProvider().isConfigured()).toBe(true);
  });

  it('translates text', async () => {
    mockFetch(200, { text: 'bonjour', duration_ms: 100 });
    const provider = new ModalSeamlessLLMProvider('http://test');
    const result = await provider.chat({
      messages: [
        { role: 'system', content: 'Translate from en to fr' },
        { role: 'user', content: 'hello' },
      ],
      model: 'seamless-m4t-v2-large-translate',
    });
    expect(result.content).toBe('bonjour');
    expect(result.model).toBe('seamless-m4t-v2-large');
  });

  it('returns empty content when no user message', async () => {
    const provider = new ModalSeamlessLLMProvider('http://test');
    const result = await provider.chat({
      messages: [{ role: 'system', content: 'Translate from en to fr' }],
      model: 'seamless-m4t-v2-large-translate',
    });
    expect(result.content).toBe('');
  });

  it('throws on non-ok response', async () => {
    mockFetch(500, null, 'error');
    const provider = new ModalSeamlessLLMProvider('http://test');
    await expect(provider.chat({
      messages: [
        { role: 'system', content: 'Translate from en to fr' },
        { role: 'user', content: 'hello' },
      ],
      model: 'seamless',
    })).rejects.toThrow('SeamlessM4T T2TT error (500)');
  });

  it('parses source/target language from system prompt', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ text: 'tr', duration_ms: 50 }),
      text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ModalSeamlessLLMProvider('http://test');
    await provider.chat({
      messages: [
        { role: 'system', content: 'Translate from fr to en' },
        { role: 'user', content: 'bonjour' },
      ],
      model: 'seamless',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.source_lang).toBe('fr');
    expect(body.target_lang).toBe('en');
  });
});

// ── Qwen3ASRPipelineSTTProvider ──────────────────────────────────────────────

describe('Qwen3ASRPipelineSTTProvider', () => {
  it('providerId is modal-qwen3asr-pipeline', () => {
    expect(new Qwen3ASRPipelineSTTProvider().providerId).toBe('modal-qwen3asr-pipeline');
  });

  it('isConfigured returns true', () => {
    expect(new Qwen3ASRPipelineSTTProvider().isConfigured()).toBe(true);
  });

  it('getModels returns stt models', () => {
    const models = new Qwen3ASRPipelineSTTProvider().getModels();
    expect(models.every(m => m.capability === 'stt')).toBe(true);
  });

  it('transcribes audio', async () => {
    mockFetch(200, { text: 'hello world', language: 'en', duration: 1.0 });
    const provider = new Qwen3ASRPipelineSTTProvider('http://test');
    const result = await provider.transcribe({ audio: AUDIO, model: 'qwen3-asr-1.7b', language: 'en' });
    expect(result.text).toBe('hello world');
  });

  it('throws on non-ok response', async () => {
    mockFetch(503, null, 'unavailable');
    const provider = new Qwen3ASRPipelineSTTProvider('http://test');
    await expect(provider.transcribe({ audio: AUDIO, model: 'qwen3-asr-1.7b' })).rejects.toThrow();
  });

  it('uses MODAL_QWEN3ASR_PIPELINE_URL env var', async () => {
    process.env.MODAL_QWEN3ASR_PIPELINE_URL = 'http://env-qwen';
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ text: 'ok', language: 'fr', duration: 1 }),
      text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new Qwen3ASRPipelineSTTProvider();
    await provider.transcribe({ audio: AUDIO, model: 'qwen3-asr-1.7b' });
    expect(fetchMock.mock.calls[0][0]).toContain('env-qwen');
    delete process.env.MODAL_QWEN3ASR_PIPELINE_URL;
  });
});

// ── Qwen3ASRPipelineLLMProvider ──────────────────────────────────────────────

describe('Qwen3ASRPipelineLLMProvider', () => {
  it('isConfigured returns true', () => {
    expect(new Qwen3ASRPipelineLLMProvider().isConfigured()).toBe(true);
  });

  it('translates text', async () => {
    mockFetch(200, { text: 'translated', duration_ms: 200 });
    const provider = new Qwen3ASRPipelineLLMProvider('http://test');
    const result = await provider.chat({
      messages: [
        { role: 'system', content: 'Translate from fr to en' },
        { role: 'user', content: 'bonjour' },
      ],
      model: 'translategemma-12b',
    });
    expect(result.content).toBe('translated');
    expect(result.model).toBe('translategemma-12b');
  });

  it('returns empty when no user message', async () => {
    const provider = new Qwen3ASRPipelineLLMProvider('http://test');
    const result = await provider.chat({
      messages: [{ role: 'system', content: 'Translate from fr to en' }],
      model: 'translategemma-12b',
    });
    expect(result.content).toBe('');
  });

  it('throws on non-ok response', async () => {
    mockFetch(500, null, 'error');
    const provider = new Qwen3ASRPipelineLLMProvider('http://test');
    await expect(provider.chat({
      messages: [
        { role: 'system', content: 'Translate from fr to en' },
        { role: 'user', content: 'bonjour' },
      ],
      model: 'translategemma-12b',
    })).rejects.toThrow('TranslateGemma Pipeline error (500)');
  });
});

// ── ModalMossTTSProvider ─────────────────────────────────────────────────────

describe('ModalMossTTSProvider', () => {
  it('providerId is modal-moss', () => {
    expect(new ModalMossTTSProvider().providerId).toBe('modal-moss');
  });

  it('isConfigured returns true', () => {
    expect(new ModalMossTTSProvider().isConfigured()).toBe(true);
  });

  it('getModels returns MODAL_MOSS_TTS_MODELS', () => {
    expect(new ModalMossTTSProvider().getModels()).toEqual(MODAL_MOSS_TTS_MODELS);
  });

  it('getVoices returns voice per language', () => {
    const voices = new ModalMossTTSProvider().getVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices.some(v => v.id === 'moss-en')).toBe(true);
    expect(voices.some(v => v.id === 'moss-fr')).toBe(true);
  });

  it('synthesize returns decoded base64 audio', async () => {
    const audioBase64 = Buffer.from([1, 2, 3]).toString('base64');
    mockFetch(200, { audio: audioBase64, sample_rate: 24000, duration_seconds: 0.5 });
    const provider = new ModalMossTTSProvider('http://test');
    const result = await provider.synthesize({ input: 'hello', model: 'moss-tts' });
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.contentType).toBe('audio/wav');
  });

  it('throws on non-ok response', async () => {
    mockFetch(500, null, 'error');
    const provider = new ModalMossTTSProvider('http://test');
    await expect(provider.synthesize({ input: 'test', model: 'moss-tts' })).rejects.toThrow('MOSS-TTS error (500)');
  });

  it('synthesizeStream returns ReadableStream', async () => {
    const audioBase64 = Buffer.from([1, 2, 3]).toString('base64');
    mockFetch(200, { audio: audioBase64, sample_rate: 24000, duration_seconds: 0.1 });
    const provider = new ModalMossTTSProvider('http://test');
    const stream = await provider.synthesizeStream({ input: 'test', model: 'moss-tts' });
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it('uses MOSS_TTS_URL env var', async () => {
    process.env.MOSS_TTS_URL = 'http://env-moss';
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ audio: '', sample_rate: 24000, duration_seconds: 0 }),
      text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ModalMossTTSProvider();
    await provider.synthesize({ input: 'test', model: 'moss-tts' });
    expect(fetchMock.mock.calls[0][0]).toContain('env-moss');
    delete process.env.MOSS_TTS_URL;
  });
});
