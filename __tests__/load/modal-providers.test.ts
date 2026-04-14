import { describe, it, expect, beforeAll } from 'vitest';
import { makeTestWav } from '../../src/benchmarking/bench';

import {
  ModalKokoroTTSProvider,
  MODAL_KOKORO_MODELS,
} from '../../src/providers/modal-kokoro/index';

import { ModalMossTTSProvider, MODAL_MOSS_TTS_MODELS } from '../../src/providers/modal-moss/index';

import { ModalVoxtralSTTProvider, VOXTRAL_MODELS } from '../../src/providers/modal-voxtral/index';

import {
  ModalSeamlessSTTProvider,
  ModalSeamlessLLMProvider,
  SEAMLESS_MODELS,
} from '../../src/providers/modal-seamless/index';

import {
  Qwen3ASRPipelineSTTProvider,
  Qwen3ASRPipelineLLMProvider,
  QWEN3ASR_PIPELINE_MODELS,
} from '../../src/providers/modal-qwen3asr-pipeline/index';

// ── Helpers ──────────────────────────────────────────────────────────────

async function isEndpointReachable(url: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status !== 404;
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 1. Kokoro TTS
// ═════════════════════════════════════════════════════════════════════════

describe('Modal Kokoro TTS', () => {
  const provider = new ModalKokoroTTSProvider();
  let online = false;
  const endpoint = 'https://marcosremar--babelcast-kokoro-kokorotts-serve.modal.run';

  beforeAll(async () => {
    online = await isEndpointReachable(endpoint);
    if (!online) console.log('[Kokoro] Endpoint offline — skipping integration tests');
  });

  it('exports MODAL_KOKORO_MODELS with correct structure', () => {
    expect(MODAL_KOKORO_MODELS.length).toBeGreaterThanOrEqual(1);
    const model = MODAL_KOKORO_MODELS[0];
    expect(model.id).toBe('kokoro-82m');
    expect(model.capability).toBe('tts');
    expect(model.isDefault).toBe(true);
  });

  it('isConfigured() returns true (public endpoint)', () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it('providerId is modal', () => {
    expect(provider.providerId).toBe('modal');
  });

  it('getVoices() returns non-empty voice list', () => {
    const voices = provider.getVoices();
    expect(voices.length).toBeGreaterThan(0);
  });

  it('synthesizes short text (integration)', async () => {
    if (!online) return;

    const result = await provider.synthesize({
      input: 'Hello, this is a test.',
      voice: 'af_heart',
    });

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(1000);
    expect(result.contentType).toBe('audio/wav');
    expect(result.audio.toString('ascii', 0, 4)).toBe('RIFF');
    console.log(`[Kokoro] Audio: ${(result.audio.length / 1024).toFixed(1)} KB`);
  }, 30_000);

  it('synthesizeStream returns ReadableStream', async () => {
    if (!online) return;

    const stream = await provider.synthesizeStream({
      input: 'Stream test.',
      voice: 'af_heart',
    });

    expect(stream).toBeInstanceOf(ReadableStream);

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalBytes).toBeGreaterThan(1000);
  }, 30_000);

  it('defaults to af_heart for unknown voice', async () => {
    if (!online) return;

    const result = await provider.synthesize({
      input: 'Default voice test.',
      voice: 'nonexistent_voice',
    });

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(500);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════
// 2. MOSS TTS
// ═════════════════════════════════════════════════════════════════════════

describe('Modal MOSS TTS', () => {
  const provider = new ModalMossTTSProvider();
  let online = false;
  const endpoint = 'https://marcosremar--babelcast-moss-tts-serve.modal.run';

  beforeAll(async () => {
    online = await isEndpointReachable(endpoint);
    if (!online) console.log('[MOSS] Endpoint offline — skipping integration tests');
  });

  it('exports MODAL_MOSS_TTS_MODELS with correct structure', () => {
    expect(MODAL_MOSS_TTS_MODELS.length).toBeGreaterThanOrEqual(1);
    const model = MODAL_MOSS_TTS_MODELS[0];
    expect(model.id).toBe('moss-tts');
    expect(model.capability).toBe('tts');
    expect(model.isDefault).toBe(true);
  });

  it('isConfigured() returns true (public endpoint)', () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it('providerId is modal-moss', () => {
    expect(provider.providerId).toBe('modal-moss');
  });

  it('getVoices() returns language-prefixed voice IDs', () => {
    const voices = provider.getVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0].id).toMatch(/^moss-[a-z]{2}$/);
  });

  it('synthesizes Portuguese text (integration)', async () => {
    if (!online) return;

    const result = await provider.synthesize({
      input: 'Ola, como vai voce?',
      voice: 'moss-pt',
    });

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(1000);
    expect(result.contentType).toBe('audio/wav');
    console.log(`[MOSS] PT audio: ${(result.audio.length / 1024).toFixed(1)} KB`);
  }, 30_000);

  it('synthesizeStream returns ReadableStream', async () => {
    if (!online) return;

    const stream = await provider.synthesizeStream({
      input: 'Stream test.',
      voice: 'moss-en',
    });

    expect(stream).toBeInstanceOf(ReadableStream);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks.reduce((s, c) => s + c.length, 0)).toBeGreaterThan(500);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Voxtral STT
// ═════════════════════════════════════════════════════════════════════════

describe('Modal Voxtral STT', () => {
  const provider = new ModalVoxtralSTTProvider();
  let online = false;
  const endpoint = 'https://marcosremar--babelcast-voxtral-voxtral-serve.modal.run';

  beforeAll(async () => {
    online = await isEndpointReachable(endpoint);
    if (!online) console.log('[Voxtral] Endpoint offline — skipping integration tests');
  });

  it('exports VOXTRAL_MODELS with correct structure', () => {
    expect(VOXTRAL_MODELS.length).toBeGreaterThanOrEqual(1);
    const model = VOXTRAL_MODELS[0];
    expect(model.id).toBe('voxtral-mini-3b');
    expect(model.capability).toBe('stt');
    expect(model.isDefault).toBe(true);
  });

  it('isConfigured() returns true (public endpoint)', () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it('providerId is modal-voxtral', () => {
    expect(provider.providerId).toBe('modal-voxtral');
  });

  it('transcribes audio buffer (integration)', async () => {
    if (!online) return;

    const audio = makeTestWav(0.5);
    const result = await provider.transcribe({ audio, language: 'en' });

    expect(typeof result.text).toBe('string');
    console.log(`[Voxtral] Transcription: "${result.text}"`);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════
// 4. SeamlessM4T
// ═════════════════════════════════════════════════════════════════════════

describe('Modal SeamlessM4T', () => {
  const sttProvider = new ModalSeamlessSTTProvider();
  const llmProvider = new ModalSeamlessLLMProvider();
  let online = false;
  const endpoint = 'https://marcosremar--babelcast-seamless-seamlessm4t-serve.modal.run';

  beforeAll(async () => {
    online = await isEndpointReachable(endpoint);
    if (!online) console.log('[Seamless] Endpoint offline — skipping integration tests');
  });

  it('exports SEAMLESS_MODELS with correct structure', () => {
    expect(SEAMLESS_MODELS.length).toBeGreaterThanOrEqual(2);
    const sttModel = SEAMLESS_MODELS.find((m) => m.capability === 'stt');
    const llmModel = SEAMLESS_MODELS.find((m) => m.capability === 'llm');
    expect(sttModel).toBeTruthy();
    expect(sttModel!.id).toBe('seamless-m4t-v2-large');
    expect(llmModel).toBeTruthy();
    expect(llmModel!.id).toBe('seamless-m4t-v2-large-translate');
  });

  it('STT isConfigured() returns true', () => {
    expect(sttProvider.isConfigured()).toBe(true);
  });

  it('LLM isConfigured() returns true', () => {
    expect(llmProvider.isConfigured()).toBe(true);
  });

  it('STT providerId is modal-seamless', () => {
    expect(sttProvider.providerId).toBe('modal-seamless');
  });

  it('transcribes audio (ASR mode) (integration)', async () => {
    if (!online) return;

    const audio = makeTestWav(0.5);
    const result = await sttProvider.transcribe({ audio, language: 'en' });

    expect(typeof result.text).toBe('string');
    console.log(`[Seamless] ASR: "${result.text}"`);
  }, 30_000);

  it('translates text (T2TT mode) (integration)', async () => {
    if (!online) return;

    const result = await llmProvider.chat({
      messages: [
        { role: 'system', content: 'Translate from English to French' },
        { role: 'user', content: 'Hello, how are you?' },
      ],
      model: 'seamless-m4t-v2-large-translate',
    });

    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.model).toBe('seamless-m4t-v2-large');
    console.log(`[Seamless] T2TT: "${result.content}"`);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Qwen3-ASR Pipeline
// ═════════════════════════════════════════════════════════════════════════

describe('Modal Qwen3-ASR Pipeline', () => {
  const sttProvider = new Qwen3ASRPipelineSTTProvider();
  const llmProvider = new Qwen3ASRPipelineLLMProvider();
  let online = false;
  const endpoint = 'https://marcosremar--babelcast-qwen3asr-pipe-qwen3asrpipeline-serve.modal.run';

  beforeAll(async () => {
    online = await isEndpointReachable(endpoint);
    if (!online) console.log('[Qwen3-ASR Pipe] Endpoint offline — skipping integration tests');
  });

  it('exports QWEN3ASR_PIPELINE_MODELS with correct structure', () => {
    expect(QWEN3ASR_PIPELINE_MODELS.length).toBeGreaterThanOrEqual(2);
    const sttModel = QWEN3ASR_PIPELINE_MODELS.find((m) => m.capability === 'stt');
    const llmModel = QWEN3ASR_PIPELINE_MODELS.find((m) => m.capability === 'llm');
    expect(sttModel).toBeTruthy();
    expect(sttModel!.id).toBe('qwen3-asr-1.7b');
    expect(sttModel!.isDefault).toBe(true);
    expect(llmModel).toBeTruthy();
    expect(llmModel!.id).toBe('translategemma-12b');
  });

  it('STT isConfigured() returns true', () => {
    expect(sttProvider.isConfigured()).toBe(true);
  });

  it('LLM isConfigured() returns true', () => {
    expect(llmProvider.isConfigured()).toBe(true);
  });

  it('STT providerId is modal-qwen3asr-pipeline', () => {
    expect(sttProvider.providerId).toBe('modal-qwen3asr-pipeline');
  });

  it('transcribes audio (integration)', async () => {
    if (!online) return;

    const audio = makeTestWav(0.5);
    const result = await sttProvider.transcribe({ audio, language: 'fr' });

    expect(typeof result.text).toBe('string');
    console.log(`[Qwen3-ASR Pipe] Transcription: "${result.text}"`);
  }, 30_000);

  it('translates text (integration)', async () => {
    if (!online) return;

    const result = await llmProvider.chat({
      messages: [
        { role: 'system', content: 'Translate from French to English' },
        { role: 'user', content: 'Bonjour, comment allez-vous?' },
      ],
      model: 'translategemma-12b',
    });

    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.model).toBe('translategemma-12b');
    console.log(`[Qwen3-ASR Pipe] T2TT: "${result.content}"`);
  }, 30_000);
});
