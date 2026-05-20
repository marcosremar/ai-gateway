import { describe, it, expect, vi } from 'vitest';
import { raceProviders } from '../../src/gateway/routing/provider-racer';
import {
  runSttStage,
  runLlmStage,
  runTtsStage,
  type HybridStagesDeps,
  type PipelineStageParams,
} from '../../src/gateway/pipeline/hybrid-stages';

const modalCases = Array.from({ length: 10 }, (_, idx) => ({ idx, modalUrl: `https://modal-${idx}.example`, text: `modal text ${idx}` }));
const cloneCases = Array.from({ length: 10 }, (_, idx) => ({
  idx,
  referenceAudio: Buffer.from(`ref-audio-${idx}`).toString('base64'),
  refText: `reference text ${idx}`,
  translated: `clone output ${idx}`,
}));
const allFailureCases = ['timeout', 'abort', 'http-500', 'http-502', 'http-503', 'http-504', 'econnreset', 'econnrefused', 'json-malformed', 'sse-malformed'] as const;
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
    requestId: 'req-e2e-extra',
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

describe('E2E failure cascades extra — Modal tier fallback', () => {
  it.each(modalCases)('STT modal tier %# wins when primary GPU fails before cloud', async (c) => {
    const fetchGpuSTT = vi.fn(async (endpoint: string) => {
      if (endpoint === c.modalUrl) return { text: `modal transcript ${c.idx}`, language: 'fr', used_gpu: true, avg_logprob: 0 };
      throw new Error('gpu failed');
    });
    const transcribe = vi.fn(async () => { throw new Error('cloud should not win'); });
    const deps = makeDeps({
      client: { ...makeDeps().client, transcribe },
      modalBabelcastUrl: () => c.modalUrl,
      currentGpuEndpoint: () => 'https://gpu.example',
      fetchGpuSTT,
    });

    const result = await runSttStage(makeParams(), deps);

    expect(result.provider).toBe('modal-babelcast');
    expect(result.text).toBe(`modal transcript ${c.idx}`);
    expect(fetchGpuSTT).toHaveBeenCalledWith(c.modalUrl, Buffer.from('wav'), 'fr', '', '', false, expect.any(AbortSignal), 'req-e2e-extra');
  });

  it.each(modalCases)('LLM modal tier %# wins when GPU fails before cloud', async (c) => {
    const fetchGpuLLM = vi.fn(async (endpoint: string) => {
      if (endpoint === c.modalUrl) return { translated_text: `modal translation ${c.idx}`, used_gpu: true };
      throw new Error('gpu failed');
    });
    const chat = vi.fn(async () => { throw new Error('cloud should not win'); });
    const deps = makeDeps({
      client: { ...makeDeps().client, chat },
      modalBabelcastUrl: () => c.modalUrl,
      currentGpuEndpoint: () => 'https://gpu.example',
      fetchGpuLLM,
    });

    const result = await runLlmStage(makeParams(), {
      text: c.text,
      provider: 'groq',
      latencyMs: 12,
      serverMs: undefined,
      networkMs: undefined,
    }, deps);

    expect(result.provider).toBe('modal-babelcast');
    expect(result.translatedText).toBe(`modal translation ${c.idx}`);
    expect(fetchGpuLLM).toHaveBeenCalledWith(c.modalUrl, c.text, 'fr', 'en', '', '', expect.any(AbortSignal), 'req-e2e-extra');
  });

  it.each(modalCases)('TTS modal tier %# wins when primary GPU fails before cloud', async (c) => {
    const fetchGpuTTS = vi.fn(async (endpoint: string) => {
      if (endpoint === c.modalUrl) return { audio: Buffer.from(`modal-audio-${c.idx}`), contentType: 'audio/wav', used_gpu: true };
      throw new Error('gpu failed');
    });
    const synthesize = vi.fn(async () => { throw new Error('cloud should not win'); });
    const deps = makeDeps({
      client: { ...makeDeps().client, synthesize },
      modalBabelcastUrl: () => c.modalUrl,
      currentGpuEndpoint: () => 'https://gpu.example',
      fetchGpuTTS,
    });

    const result = await runTtsStage(makeParams(), c.text, deps);

    expect(result.provider).toBe('modal-babelcast');
    expect(result.audioB64).toBe(Buffer.from(`modal-audio-${c.idx}`).toString('base64'));
    expect(fetchGpuTTS).toHaveBeenCalledWith(c.modalUrl, c.text, 'English', 'Ryan', expect.any(AbortSignal), undefined, undefined, 'req-e2e-extra');
  });
});

describe('E2E failure cascades extra — clone TTS fallback', () => {
  it.each(cloneCases)('clone request %# falls back from GPU clone to Modal clone', async (c) => {
    const fetchGpuTTS = vi.fn(async () => { throw new Error('gpu clone failed'); });
    const modalSynthesize = vi.fn(async () => ({ audio: Buffer.from(`modal-clone-${c.idx}`), contentType: 'audio/wav' }));
    const cloudSynthesize = vi.fn(async () => { throw new Error('preset fallback should not win'); });
    const deps = makeDeps({
      client: { ...makeDeps().client, synthesize: cloudSynthesize },
      modalTTS: { synthesize: modalSynthesize },
      fetchGpuTTS,
    });

    const result = await runTtsStage(makeParams({
      isCloneRequest: true,
      cloneGpuEndpoint: 'https://clone-gpu.example',
      referenceAudio: c.referenceAudio,
      refText: c.refText,
    }), c.translated, deps);

    expect(result.provider).toBe('modal');
    expect(result.audioB64).toBe(Buffer.from(`modal-clone-${c.idx}`).toString('base64'));
    expect(modalSynthesize).toHaveBeenCalledWith({
      input: c.translated,
      model: 'qwen3-tts',
      voice: 'Ryan',
      referenceAudio: c.referenceAudio,
      refText: c.refText,
    });
    expect(cloudSynthesize).not.toHaveBeenCalled();
  });

  it.each(cloneCases)('clone request %# falls back to preset voice when GPU and Modal fail', async (c) => {
    const fetchGpuTTS = vi.fn(async () => { throw new Error('gpu clone failed'); });
    const modalSynthesize = vi.fn(async () => { throw new Error('modal clone failed'); });
    const cloudSynthesize = vi.fn(async () => ({ audio: Buffer.from(`preset-${c.idx}`), contentType: 'audio/wav', provider: 'groq' }));
    const deps = makeDeps({
      client: { ...makeDeps().client, synthesize: cloudSynthesize },
      modalTTS: { synthesize: modalSynthesize },
      fetchGpuTTS,
    });

    const result = await runTtsStage(makeParams({
      isCloneRequest: true,
      cloneGpuEndpoint: 'https://clone-gpu.example',
      referenceAudio: c.referenceAudio,
      refText: c.refText,
      cloudProfile: { referenceAudio: c.referenceAudio, refText: c.refText },
    }), c.translated, deps);

    expect(result.provider).toBe('groq/preset-fallback');
    expect(result.audioB64).toBe(Buffer.from(`preset-${c.idx}`).toString('base64'));
    expect(cloudSynthesize).toHaveBeenCalledWith(c.translated, expect.objectContaining({
      referenceAudio: undefined,
      refText: undefined,
      tts: undefined,
    }));
  });
});

describe('E2E failure cascades extra — all-provider failures', () => {
  it.each(allFailureCases)('STT all providers fail with final real error %#', async (kind) => {
    const deps = makeDeps({
      fetchGpuSTT: vi.fn(async () => { throw makeError(kind); }),
      client: { ...makeDeps().client, transcribe: vi.fn(async () => { throw new Error(`cloud-${kind}`); }) },
    });

    await expect(runSttStage(makeParams(), deps)).rejects.toThrow(`cloud-${kind}`);
  });

  it.each(allFailureCases)('LLM all providers fail with final real error %#', async (kind) => {
    const deps = makeDeps({
      fetchGpuLLM: vi.fn(async () => { throw makeError(kind); }),
      client: { ...makeDeps().client, chat: vi.fn(async () => { throw new Error(`cloud-${kind}`); }) },
    });

    await expect(runLlmStage(makeParams(), {
      text: `bonjour ${kind}`,
      provider: 'groq',
      latencyMs: 1,
      serverMs: undefined,
      networkMs: undefined,
    }, deps)).rejects.toThrow(`cloud-${kind}`);
  });
});

describe('E2E failure cascades extra — GPU warmth tracking', () => {
  it.each(warmthCases)('GPU TTS success %# records cold/warm warmth correctly', async (c) => {
    const recordPerStageLatency = vi.fn();
    const markTtsWarm = vi.fn();
    const recordTtsTtfb = vi.fn();
    const saveColdStartProfile = vi.fn();
    const fetchGpuTTS = vi.fn(async () => ({ audio: Buffer.from(`gpu-${c.idx}`), contentType: 'audio/wav', used_gpu: true }));
    const deps = makeDeps({
      isTtsWarm: () => c.warm,
      recordPerStageLatency,
      markTtsWarm,
      recordTtsTtfb,
      saveColdStartProfile,
      fetchGpuTTS,
      raceProviders: async (candidates) => ({
        result: await candidates[0].run(new AbortController().signal),
        provider: candidates[0].name,
        latencyMs: 37,
        otherCancelled: true,
      }),
    });

    const result = await runTtsStage(makeParams(), `hello ${c.idx}`, deps);

    expect(result.provider).toBe('gpu');
    expect(recordPerStageLatency).toHaveBeenCalledWith('tts', expect.any(Number));
    if (c.warm) {
      expect(recordTtsTtfb).toHaveBeenCalledWith(expect.any(Number));
      expect(markTtsWarm).not.toHaveBeenCalled();
      expect(saveColdStartProfile).not.toHaveBeenCalled();
    } else {
      expect(markTtsWarm).toHaveBeenCalledWith(expect.any(Number));
      expect(saveColdStartProfile).toHaveBeenCalledWith(expect.objectContaining({ coldTtfbMs: expect.any(Number), warmTtfbAvgMs: 240 }));
      expect(recordTtsTtfb).not.toHaveBeenCalled();
    }
  });
});
