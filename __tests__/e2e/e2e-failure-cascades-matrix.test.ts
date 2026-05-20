import { describe, it, expect, vi } from 'vitest';
import { raceProviders } from '../../src/gateway/routing/provider-racer';
import {
  runSttStage,
  runLlmStage,
  runTtsStage,
  type HybridStagesDeps,
  type PipelineStageParams,
} from '../../src/gateway/pipeline/hybrid-stages';
import { encodePipelineResponse } from '../../src/gateway/pipeline/pipeline-response';

const failureKinds = [
  'timeout',
  'abort',
  'http-500',
  'http-502',
  'http-503',
  'http-504',
  'econnreset',
  'econnrefused',
  'fetch-failed',
  'json-malformed',
  'sse-malformed',
  'empty-payload',
  'schema-missing-text',
  'schema-missing-content',
  'schema-missing-audio',
  'provider-rate-limit',
  'provider-credit-blocked',
  'circuit-open',
  'pod-draining',
  'pod-cold',
] as const;

const responseCases = Array.from({ length: 20 }, (_, idx) => ({
  idx,
  sttProvider: idx % 4 === 0 ? 'gpu' : 'groq',
  llmProvider: idx % 5 === 0 ? 'cache' : idx % 3 === 0 ? 'gpu' : 'groq',
  transcription: `bonjour ${idx}`,
  translation: `hello ${idx}`,
  sttMs: 10 + idx,
  llmMs: idx % 5 === 0 ? 0 : 20 + idx,
  totalMs: 30 + idx * 2,
}));

const cacheCases = Array.from({ length: 10 }, (_, idx) => ({ idx, text: `cached source ${idx}`, translated: `cached target ${idx}` }));
const blankTtsCases = Array.from({ length: 10 }, (_, idx) => ({ idx, blank: idx % 2 === 0 ? '' : '   ' }));
const modalCases = Array.from({ length: 10 }, (_, idx) => ({ idx, modalUrl: `https://modal-${idx}.example`, text: `modal text ${idx}` }));
const cloneCases = Array.from({ length: 10 }, (_, idx) => ({
  idx,
  referenceAudio: Buffer.from(`ref-audio-${idx}`).toString('base64'),
  refText: `reference text ${idx}`,
  translated: `clone output ${idx}`,
}));
const allFailureCases = failureKinds.slice(0, 10);
const warmthCases = Array.from({ length: 10 }, (_, idx) => ({ idx, warm: idx % 2 === 0 }));

function makeError(kind: string): Error {
  if (kind === 'abort' || kind === 'timeout') return new DOMException('Aborted', 'AbortError') as unknown as Error;
  if (kind === 'json-malformed') return new SyntaxError('Unexpected token < in JSON');
  if (kind === 'sse-malformed') return new Error('Malformed SSE frame: missing data payload');
  return new Error(kind);
}

function makeParams(overrides: Partial<PipelineStageParams> = {}): PipelineStageParams {
  return {
    source: 'fr',
    target: 'en',
    sourceName: 'French',
    targetName: 'English',
    speaker: 'Ryan',
    style: 'natural',
    sttPrompt: '',
    isCloneRequest: false,
    systemPrompt: 'Translate French to English',
    audioBuffer: Buffer.from('wav'),
    cloudProfile: {},
    gpuEp: 'https://gpu.example',
    sttOnGpu: true,
    llmOnGpu: true,
    ttsOnGpu: true,
    requestId: 'req-e2e-matrix',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<HybridStagesDeps> = {}): HybridStagesDeps {
  return {
    client: {
      transcribe: vi.fn(async () => ({ text: 'cloud transcript', language: 'fr', timing: { total_ms: 18, server_ms: 12, network_ms: 6 } })),
      chat: vi.fn(async () => ({ content: 'cloud translation' })),
      synthesize: vi.fn(async () => ({ audio: Buffer.from('cloud-audio'), contentType: 'audio/wav', provider: 'groq' })),
    },
    modalTTS: {
      synthesize: vi.fn(async () => ({ audio: Buffer.from('modal-audio'), contentType: 'audio/wav' })),
    },
    modalBabelcastUrl: () => null,
    currentGpuEndpoint: () => 'https://gpu.example',
    getCloudProviderName: () => 'groq',
    raceProviders,
    adaptiveStageTimeout: () => 25,
    fetchGpuSTT: vi.fn(async () => ({ text: 'gpu transcript', language: 'fr', used_gpu: true, avg_logprob: 0 })),
    fetchGpuLLM: vi.fn(async () => ({ translated_text: 'gpu translation', used_gpu: true })),
    fetchGpuTTS: vi.fn(async () => ({ audio: Buffer.from('gpu-audio'), contentType: 'audio/wav', used_gpu: true })),
    getCachedTranslation: () => null,
    setCachedTranslation: vi.fn(),
    isStageCircuitClosed: () => true,
    broadcastWs: vi.fn(),
    isTtsWarm: () => false,
    markTtsWarm: vi.fn(),
    recordTtsTtfb: vi.fn(),
    recordPerStageLatency: vi.fn(),
    saveColdStartProfile: vi.fn(),
    deployMetadata: () => ({ gpuType: 'NVIDIA GeForce RTX 4090', dockerImage: 'image', provider: 'runpod' }),
    GPU_STT_TIMEOUT_MS: 25,
    GPU_LLM_TIMEOUT_MS: 25,
    GPU_TTS_TIMEOUT_MS: 25,
    ...overrides,
  };
}

describe('E2E failure cascades matrix — STT stage', () => {
  it.each(failureKinds)('STT GPU %s cascades to cloud winner', async (kind) => {
    const fetchGpuSTT = vi.fn(async () => { throw makeError(kind); });
    const transcribe = vi.fn(async () => ({
      text: `cloud transcript after ${kind}`,
      language: 'fr',
      timing: { total_ms: 18, server_ms: 12, network_ms: 6 },
    }));
    const deps = makeDeps({ client: { ...makeDeps().client, transcribe }, fetchGpuSTT });

    const result = await runSttStage(makeParams(), deps);

    expect(result.provider).toBe('groq');
    expect(result.text).toBe(`cloud transcript after ${kind}`);
    expect(result.serverMs).toBe(12);
    expect(result.networkMs).toBe(6);
    expect(fetchGpuSTT).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});

describe('E2E failure cascades matrix — LLM stage', () => {
  it.each(failureKinds)('LLM GPU %s cascades to cloud winner', async (kind) => {
    const fetchGpuLLM = vi.fn(async () => { throw makeError(kind); });
    const chat = vi.fn(async () => ({ content: `cloud translation after ${kind}` }));
    const setCachedTranslation = vi.fn();
    const broadcastWs = vi.fn();
    const deps = makeDeps({
      client: { ...makeDeps().client, chat },
      fetchGpuLLM,
      setCachedTranslation,
      broadcastWs,
    });

    const result = await runLlmStage(makeParams(), {
      text: `bonjour ${kind}`,
      provider: 'groq',
      latencyMs: 17,
      serverMs: undefined,
      networkMs: undefined,
    }, deps);

    expect(result.provider).toBe('groq');
    expect(result.translatedText).toBe(`cloud translation after ${kind}`);
    expect(fetchGpuLLM).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(setCachedTranslation).toHaveBeenCalledWith(`bonjour ${kind}`, 'fr', 'en', `cloud translation after ${kind}`, 'natural');
    expect(broadcastWs).toHaveBeenCalledWith(expect.objectContaining({ type: 'subtitle:early' }));
  });
});

describe('E2E failure cascades matrix — TTS stage', () => {
  it.each(failureKinds)('TTS GPU malformed %s cascades to valid cloud audio', async (kind) => {
    const fetchGpuTTS = vi.fn(async () => {
      if (kind === 'schema-missing-audio' || kind === 'empty-payload') {
        return { audio: Buffer.alloc(0), contentType: 'audio/wav', used_gpu: true };
      }
      if (kind === 'schema-missing-content') {
        return { audio: Buffer.from('not-empty'), contentType: '', used_gpu: true };
      }
      throw makeError(kind);
    });
    const synthesize = vi.fn(async () => ({
      audio: Buffer.from(`cloud-audio-after-${kind}`),
      contentType: 'audio/wav',
      provider: 'groq',
    }));
    const recordPerStageLatency = vi.fn();
    const markTtsWarm = vi.fn();
    const deps = makeDeps({
      client: { ...makeDeps().client, synthesize },
      fetchGpuTTS,
      recordPerStageLatency,
      markTtsWarm,
    });

    const result = await runTtsStage(makeParams(), `hello ${kind}`, deps);

    expect(result.provider).toBe('groq');
    expect(result.contentType).toBe('audio/wav');
    expect(result.audioB64).toBe(Buffer.from(`cloud-audio-after-${kind}`).toString('base64'));
    expect(fetchGpuTTS).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(recordPerStageLatency).not.toHaveBeenCalled();
    expect(markTtsWarm).not.toHaveBeenCalled();
  });
});

describe('E2E failure cascades matrix — partial response/log output', () => {
  it.each(responseCases)('partial pipeline response %# preserves STT+LLM and no TTS', (c) => {
    const body = encodePipelineResponse(
      { text: c.transcription, provider: c.sttProvider, latencyMs: c.sttMs, serverMs: undefined, networkMs: undefined },
      { translatedText: c.translation, provider: c.llmProvider, latencyMs: c.llmMs },
      { audioB64: '', contentType: '', provider: '', latencyMs: 0 },
      c.totalMs,
      false,
    );
    const logEntry = {
      timestamp: Date.now(),
      stage: 'pipeline' as const,
      provider: 'hybrid' as const,
      latencyMs: c.totalMs,
      success: true,
      inputSize: 3 + c.idx,
      outputPreview: body.response.slice(0, 80),
    };

    expect(body.transcription).toBe(c.transcription);
    expect(body.response).toBe(c.translation);
    expect(body.audio_base64).toBe('');
    expect(body.content_type).toBe('');
    expect(body.timing).toMatchObject({
      total_ms: c.totalMs,
      stt_ms: c.sttMs,
      llm_ms: c.llmMs,
      tts_ms: 0,
      stt_provider: c.sttProvider,
      llm_provider: c.llmProvider,
      tts_provider: 'none',
    });
    expect(logEntry).toMatchObject({
      stage: 'pipeline',
      provider: 'hybrid',
      success: true,
      outputPreview: c.translation,
    });
  });
});

describe('E2E failure cascades matrix — no-op downstream stages', () => {
  it.each(cacheCases)('cache hit %# skips LLM providers and emits early subtitle', async (c) => {
    const fetchGpuLLM = vi.fn();
    const chat = vi.fn();
    const broadcastWs = vi.fn();
    const deps = makeDeps({
      client: { ...makeDeps().client, chat },
      fetchGpuLLM,
      getCachedTranslation: () => c.translated,
      broadcastWs,
    });

    const result = await runLlmStage(makeParams(), {
      text: c.text,
      provider: 'groq',
      latencyMs: 11,
      serverMs: undefined,
      networkMs: undefined,
    }, deps);

    expect(result).toEqual({ translatedText: c.translated, provider: 'cache', latencyMs: 0 });
    expect(fetchGpuLLM).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(broadcastWs).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subtitle:early',
      transcription: c.text,
      translation: c.translated,
    }));
  });

  it.each(blankTtsCases)('blank translation %# skips every TTS provider', async (c) => {
    const fetchGpuTTS = vi.fn();
    const synthesize = vi.fn();
    const deps = makeDeps({
      client: { ...makeDeps().client, synthesize },
      fetchGpuTTS,
    });

    const result = await runTtsStage(makeParams(), c.blank, deps);

    expect(result).toEqual({ audioB64: '', contentType: '', provider: '', latencyMs: 0 });
    expect(fetchGpuTTS).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });
});
