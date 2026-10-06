import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runSttStage,
  runLlmStage,
  runTtsStage,
} from '../../src/gateway/pipeline/hybrid-stages';
import type {
  HybridStagesDeps,
  PipelineStageParams,
} from '../../src/gateway/pipeline/hybrid-stages';
import type { RaceCandidate } from '../../src/gateway/routing/provider-racer';

// ── Helpers ──────────────────────────────────────────────────────────────────

const FAKE_AUDIO = Buffer.from([0x52, 0x49, 0x46, 0x46]); // "RIFF"
const FAKE_AUDIO_B64 = FAKE_AUDIO.toString('base64');

function makeRaceProviders(
  result: unknown,
  provider = 'groq',
  latencyMs = 42,
) {
  return vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
    const first = candidates[0];
    await first.run(new AbortController().signal);
    return { result, provider, latencyMs };
  });
}

function makeProfile() {
  return { model: 'llama3', language: 'en' } as never;
}

function makeDeps(overrides: Partial<HybridStagesDeps> = {}): HybridStagesDeps {
  return {
    client: {
      transcribe: vi.fn().mockResolvedValue({ text: 'hello', language: 'en' }),
      chat: vi.fn().mockResolvedValue({ content: 'hola' }),
      synthesize: vi.fn().mockResolvedValue({ audio: FAKE_AUDIO, contentType: 'audio/wav', provider: 'groq' }),
    },
    modalTTS: {
      synthesize: vi.fn().mockResolvedValue({ audio: FAKE_AUDIO, contentType: 'audio/wav' }),
    },
    modalBabelcastUrl: vi.fn().mockReturnValue(null),
    currentGpuEndpoint: vi.fn().mockReturnValue(null),
    getCloudProviderName: vi.fn().mockReturnValue('groq'),
    raceProviders: makeRaceProviders(
      { text: 'hello', language: 'en', used_gpu: false, avg_logprob: -0.1 },
    ) as HybridStagesDeps['raceProviders'],
    adaptiveStageTimeout: vi.fn().mockReturnValue(5_000),
    fetchGpuSTT: vi.fn().mockResolvedValue({ text: 'gpu text', language: 'fr', used_gpu: true, avg_logprob: -0.05 }),
    fetchGpuLLM: vi.fn().mockResolvedValue({ translated_text: 'gpu translation', used_gpu: true }),
    fetchGpuTTS: vi.fn().mockResolvedValue({ audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: true }),
    getCachedTranslation: vi.fn().mockReturnValue(null),
    setCachedTranslation: vi.fn(),
    isStageCircuitClosed: vi.fn().mockReturnValue(true),
    broadcastWs: vi.fn(),
    isTtsWarm: vi.fn().mockReturnValue(false),
    markTtsWarm: vi.fn(),
    recordTtsTtfb: vi.fn(),
    recordPerStageLatency: vi.fn(),
    saveColdStartProfile: vi.fn(),
    deployMetadata: vi.fn().mockReturnValue({ gpuType: 'RTX4090', dockerImage: 'img:latest', provider: 'runpod' }),
    GPU_STT_TIMEOUT_MS: 5_000,
    GPU_LLM_TIMEOUT_MS: 3_000,
    GPU_TTS_TIMEOUT_MS: 5_000,
    ...overrides,
  };
}

function makeParams(overrides: Partial<PipelineStageParams> = {}): PipelineStageParams {
  return {
    source: 'fr', target: 'en',
    sourceName: 'French', targetName: 'English',
    speaker: 'Ryan',
    style: 'default',
    sttPrompt: '',
    isCloneRequest: false,
    systemPrompt: 'Translate from French to English.',
    audioBuffer: Buffer.from([0x00]),
    cloudProfile: makeProfile(),
    gpuEp: undefined,
    sttOnGpu: false,
    llmOnGpu: false,
    ttsOnGpu: false,
    requestId: 'req-001',
    ...overrides,
  };
}

// ── runSttStage ───────────────────────────────────────────────────────────────

describe('runSttStage', () => {
  it('cloud-only: builds single cloud candidate when no GPU or Modal', async () => {
    const deps = makeDeps({
      raceProviders: makeRaceProviders(
        { text: 'hello world', language: 'en', used_gpu: false, avg_logprob: -0.1 },
        'groq', 55,
      ) as HybridStagesDeps['raceProviders'],
    });
    const result = await runSttStage(makeParams(), deps);
    expect(result.text).toBe('hello world');
    expect(result.provider).toBe('groq');
    expect(result.latencyMs).toBe(55);
    const candidates = vi.mocked(deps.raceProviders).mock.calls[0][0];
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('groq');
  });

  it('adds GPU candidate first when sttOnGpu=true', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { text: 'gpu text', language: 'fr', used_gpu: true, avg_logprob: -0.05 }, provider: 'gpu', latencyMs: 120 };
      }) as HybridStagesDeps['raceProviders'],
    });
    const result = await runSttStage(makeParams({ sttOnGpu: true, gpuEp: 'http://gpu:8000' }), deps);
    expect(result.text).toBe('gpu text');
    expect(result.provider).toBe('gpu');
    expect(capturedCandidates).toHaveLength(2);
    expect(capturedCandidates[0].name).toBe('gpu');
    expect(capturedCandidates[1].name).toBe('groq');
  });

  it('adds modal-babelcast candidate when MODAL_URL is set and no GPU', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      modalBabelcastUrl: vi.fn().mockReturnValue('http://modal:8000'),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { text: 'modal text', language: 'en', used_gpu: false, avg_logprob: -0.1 }, provider: 'modal-babelcast', latencyMs: 80 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runSttStage(makeParams(), deps);
    expect(capturedCandidates).toHaveLength(2);
    expect(capturedCandidates[0].name).toBe('modal-babelcast');
    expect(capturedCandidates[1].name).toBe('groq');
  });

  it('skips modal-babelcast when GPU endpoint === MODAL_URL', async () => {
    const MODAL_URL = 'http://modal:8000';
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      modalBabelcastUrl: vi.fn().mockReturnValue(MODAL_URL),
      currentGpuEndpoint: vi.fn().mockReturnValue(MODAL_URL),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { text: 'gpu text', language: 'en', used_gpu: true, avg_logprob: -0.05 }, provider: 'gpu', latencyMs: 60 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runSttStage(makeParams({ sttOnGpu: true, gpuEp: MODAL_URL }), deps);
    // GPU + cloud but NOT modal-babelcast again
    const names = capturedCandidates.map(c => c.name);
    expect(names.filter(n => n === 'modal-babelcast')).toHaveLength(0);
  });

  it('extracts stt_timing network_ms and server_ms from result', async () => {
    const fakeResult = {
      text: 'timing text', language: 'en', used_gpu: false, avg_logprob: -0.1,
      _sttTiming: { total_ms: 200, server_ms: 150, network_ms: 50 },
    };
    const deps = makeDeps({
      raceProviders: makeRaceProviders(fakeResult, 'groq', 200) as HybridStagesDeps['raceProviders'],
    });
    const result = await runSttStage(makeParams(), deps);
    expect(result.serverMs).toBe(150);
    expect(result.networkMs).toBe(50);
    expect(result.latencyMs).toBe(200);
  });

  it('returns undefined serverMs/networkMs when timing is absent', async () => {
    const deps = makeDeps({
      raceProviders: makeRaceProviders(
        { text: 'plain', language: 'en', used_gpu: false, avg_logprob: -0.1 },
        'groq', 30,
      ) as HybridStagesDeps['raceProviders'],
    });
    const result = await runSttStage(makeParams(), deps);
    expect(result.serverMs).toBeUndefined();
    expect(result.networkMs).toBeUndefined();
  });

  it('calls adaptiveStageTimeout with stt stage', async () => {
    const deps = makeDeps({
      raceProviders: makeRaceProviders(
        { text: 'hi', language: 'en', used_gpu: false, avg_logprob: -0.1 },
      ) as HybridStagesDeps['raceProviders'],
    });
    await runSttStage(makeParams({ sttOnGpu: true, gpuEp: 'http://gpu:8000' }), deps);
    expect(vi.mocked(deps.adaptiveStageTimeout)).toHaveBeenCalledWith('stt', 5_000);
  });
});

// ── runLlmStage ──────────────────────────────────────────────────────────────

describe('runLlmStage', () => {
  const sttResult = { text: 'bonjour monde', provider: 'groq', latencyMs: 50, serverMs: undefined, networkMs: undefined };

  it('returns cached translation immediately without racing', async () => {
    const deps = makeDeps({
      getCachedTranslation: vi.fn().mockReturnValue('hello world'),
    });
    const result = await runLlmStage(makeParams(), sttResult, deps);
    expect(result.translatedText).toBe('hello world');
    expect(result.provider).toBe('cache');
    expect(result.latencyMs).toBe(0);
    expect(vi.mocked(deps.raceProviders)).not.toHaveBeenCalled();
  });

  it('broadcasts subtitle:early on non-empty cache hit', async () => {
    const deps = makeDeps({
      getCachedTranslation: vi.fn().mockReturnValue('hello world'),
    });
    await runLlmStage(makeParams(), sttResult, deps);
    expect(vi.mocked(deps.broadcastWs)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subtitle:early', translation: 'hello world' }),
    );
  });

  it('does NOT broadcast on empty/whitespace cache hit', async () => {
    const deps = makeDeps({
      getCachedTranslation: vi.fn().mockReturnValue('   '),
    });
    await runLlmStage(makeParams(), sttResult, deps);
    expect(vi.mocked(deps.broadcastWs)).not.toHaveBeenCalled();
  });

  it('cloud-only: builds single cloud candidate on cache miss', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { translated_text: 'hola', used_gpu: false }, provider: 'groq', latencyMs: 60 };
      }) as HybridStagesDeps['raceProviders'],
    });
    const result = await runLlmStage(makeParams(), sttResult, deps);
    expect(result.translatedText).toBe('hola');
    expect(capturedCandidates).toHaveLength(1);
    expect(capturedCandidates[0].name).toBe('groq');
  });

  it('adds GPU candidate first when llmOnGpu=true', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { translated_text: 'gpu translate', used_gpu: true }, provider: 'gpu', latencyMs: 80 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runLlmStage(makeParams({ llmOnGpu: true, gpuEp: 'http://gpu:8000' }), sttResult, deps);
    expect(capturedCandidates[0].name).toBe('gpu');
    expect(capturedCandidates).toHaveLength(2);
  });

  it('adds modal-babelcast candidate when MODAL_URL set and no GPU', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      modalBabelcastUrl: vi.fn().mockReturnValue('http://modal:8000'),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { translated_text: 'modal translate', used_gpu: false }, provider: 'modal-babelcast', latencyMs: 90 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runLlmStage(makeParams(), sttResult, deps);
    expect(capturedCandidates[0].name).toBe('modal-babelcast');
    expect(capturedCandidates).toHaveLength(2);
  });

  it('saves translation to cache after successful race', async () => {
    const deps = makeDeps({
      raceProviders: makeRaceProviders(
        { translated_text: 'hola', used_gpu: false }, 'groq', 60,
      ) as HybridStagesDeps['raceProviders'],
    });
    await runLlmStage(makeParams({ source: 'fr', target: 'en', style: 'casual' }), sttResult, deps);
    expect(vi.mocked(deps.setCachedTranslation)).toHaveBeenCalledWith(
      sttResult.text, 'fr', 'en', 'hola', 'casual',
    );
  });

  it('does NOT save to cache when translation is empty', async () => {
    const deps = makeDeps({
      raceProviders: makeRaceProviders(
        { translated_text: '', used_gpu: false }, 'groq', 60,
      ) as HybridStagesDeps['raceProviders'],
    });
    await runLlmStage(makeParams(), sttResult, deps);
    expect(vi.mocked(deps.setCachedTranslation)).not.toHaveBeenCalled();
  });

  it('broadcasts subtitle:early after successful translation', async () => {
    const deps = makeDeps({
      raceProviders: makeRaceProviders(
        { translated_text: 'hello', used_gpu: false }, 'groq', 60,
      ) as HybridStagesDeps['raceProviders'],
    });
    await runLlmStage(makeParams({ source: 'fr', target: 'en' }), sttResult, deps);
    expect(vi.mocked(deps.broadcastWs)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subtitle:early', translation: 'hello', source: 'fr', target: 'en' }),
    );
  });

  it('does NOT broadcast on empty/whitespace translation', async () => {
    const deps = makeDeps({
      raceProviders: makeRaceProviders(
        { translated_text: '   ', used_gpu: false }, 'groq', 60,
      ) as HybridStagesDeps['raceProviders'],
    });
    await runLlmStage(makeParams(), sttResult, deps);
    expect(vi.mocked(deps.broadcastWs)).not.toHaveBeenCalled();
  });

  it('skips modal-babelcast when GPU endpoint === MODAL_URL', async () => {
    const MODAL_URL = 'http://modal:8000';
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      modalBabelcastUrl: vi.fn().mockReturnValue(MODAL_URL),
      currentGpuEndpoint: vi.fn().mockReturnValue(MODAL_URL),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { translated_text: 'ok', used_gpu: true }, provider: 'gpu', latencyMs: 50 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runLlmStage(makeParams({ llmOnGpu: true, gpuEp: MODAL_URL }), sttResult, deps);
    const names = capturedCandidates.map(c => c.name);
    expect(names.filter(n => n === 'modal-babelcast')).toHaveLength(0);
  });

  it('passes style to getCachedTranslation', async () => {
    const deps = makeDeps({
      getCachedTranslation: vi.fn().mockReturnValue('cached'),
    });
    await runLlmStage(makeParams({ source: 'fr', target: 'en', style: 'academic' }), sttResult, deps);
    expect(vi.mocked(deps.getCachedTranslation)).toHaveBeenCalledWith(
      sttResult.text, 'fr', 'en', 'academic',
    );
  });
});

// ── runTtsStage ───────────────────────────────────────────────────────────────

describe('runTtsStage', () => {
  it('returns empty result immediately when translatedText is blank', async () => {
    const deps = makeDeps();
    const result = await runTtsStage(makeParams(), '   ', deps);
    expect(result.audioB64).toBe('');
    expect(result.contentType).toBe('');
    expect(result.provider).toBe('');
    expect(vi.mocked(deps.raceProviders)).not.toHaveBeenCalled();
  });

  it('cloud-only: single cloud candidate when no GPU/Modal', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: false }, provider: 'groq', latencyMs: 70 };
      }) as HybridStagesDeps['raceProviders'],
    });
    const result = await runTtsStage(makeParams(), 'hello world', deps);
    expect(result.audioB64).toBe(FAKE_AUDIO_B64);
    expect(capturedCandidates).toHaveLength(1);
    expect(capturedCandidates[0].name).toBe('groq');
    expect(result.provider).toBe('groq');
  });

  it('adds GPU candidate when ttsOnGpu=true and circuit is closed', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      isStageCircuitClosed: vi.fn().mockReturnValue(true),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: true }, provider: 'gpu', latencyMs: 100 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(makeParams({ ttsOnGpu: true, gpuEp: 'http://gpu:8000' }), 'hello', deps);
    expect(capturedCandidates[0].name).toBe('gpu');
    expect(capturedCandidates).toHaveLength(2); // gpu + cloud
  });

  it('clone request: skips GPU when TTS circuit is open', async () => {
    // Circuit open means gpuTtsUsable=false, which blocks the clone GPU path
    // (ttsOnGpu is false here — this is a clone-only GPU request)
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      isStageCircuitClosed: vi.fn().mockReturnValue(false),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: false }, provider: 'modal', latencyMs: 300 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(makeParams({ isCloneRequest: true, gpuEp: 'http://gpu:8000' }), 'clone text', deps);
    const names = capturedCandidates.map(c => c.name);
    expect(names).not.toContain('gpu');
    expect(names).toContain('modal');
  });

  it('clone request: adds GPU (when circuit closed) + Modal candidates', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      isStageCircuitClosed: vi.fn().mockReturnValue(true),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: true }, provider: 'gpu', latencyMs: 200 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(
      makeParams({ isCloneRequest: true, ttsOnGpu: true, gpuEp: 'http://gpu:8000', referenceAudio: 'base64audio', refText: 'ref' }),
      'hello clone',
      deps,
    );
    const names = capturedCandidates.map(c => c.name);
    expect(names).toContain('gpu');
    expect(names).toContain('modal');
  });

  it('clone request: Modal-only candidates when GPU circuit is open', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      isStageCircuitClosed: vi.fn().mockReturnValue(false),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: false }, provider: 'modal', latencyMs: 300 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(
      makeParams({ isCloneRequest: true, gpuEp: 'http://gpu:8000' }),
      'clone text',
      deps,
    );
    const names = capturedCandidates.map(c => c.name);
    expect(names).not.toContain('gpu');
    expect(names).toContain('modal');
  });

  it('adds modal-babelcast for non-clone when MODAL_URL set and not already GPU', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      modalBabelcastUrl: vi.fn().mockReturnValue('http://modal:8000'),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: false }, provider: 'modal-babelcast', latencyMs: 90 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(makeParams(), 'hello world', deps);
    const names = capturedCandidates.map(c => c.name);
    expect(names).toContain('modal-babelcast');
    expect(names).toContain('groq');
  });

  it('skips modal-babelcast for non-clone when GPU endpoint === MODAL_URL', async () => {
    const MODAL_URL = 'http://modal:8000';
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      modalBabelcastUrl: vi.fn().mockReturnValue(MODAL_URL),
      currentGpuEndpoint: vi.fn().mockReturnValue(MODAL_URL),
      isStageCircuitClosed: vi.fn().mockReturnValue(true),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: true }, provider: 'gpu', latencyMs: 80 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(makeParams({ ttsOnGpu: true, gpuEp: MODAL_URL }), 'hello', deps);
    const names = capturedCandidates.map(c => c.name);
    expect(names.filter(n => n === 'modal-babelcast')).toHaveLength(0);
  });

  it('returns base64-encoded audio and correct contentType', async () => {
    const deps = makeDeps({
      raceProviders: makeRaceProviders(
        { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: false }, 'groq', 70,
      ) as HybridStagesDeps['raceProviders'],
    });
    const result = await runTtsStage(makeParams(), 'hello', deps);
    expect(result.audioB64).toBe(FAKE_AUDIO_B64);
    expect(result.contentType).toBe('audio/wav');
    expect(result.audioRaw).toEqual(FAKE_AUDIO);
  });

  it('handles Uint8Array audio by converting to Buffer', async () => {
    const uint8Audio = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const deps = makeDeps({
      raceProviders: makeRaceProviders(
        { audio: uint8Audio, contentType: 'audio/wav', used_gpu: false }, 'groq', 70,
      ) as HybridStagesDeps['raceProviders'],
    });
    const result = await runTtsStage(makeParams(), 'hello', deps);
    expect(result.audioB64).toBe(FAKE_AUDIO_B64);
  });

  it('assertValidAudio: cloud candidate throws on empty audio, leaving empty result', async () => {
    // Make client.synthesize return empty audio so assertValidAudio throws inside the candidate run
    const deps = makeDeps({
      client: {
        transcribe: vi.fn(),
        chat: vi.fn(),
        synthesize: vi.fn().mockResolvedValue({ audio: Buffer.alloc(0), contentType: 'audio/wav', provider: 'groq' }),
      },
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        // Actually run the candidate so assertValidAudio is exercised
        const signal = new AbortController().signal;
        const result = await candidates[0].run(signal);
        return { result, provider: 'groq', latencyMs: 70 };
      }) as HybridStagesDeps['raceProviders'],
    });
    // For non-clone, failure is caught silently → empty audioB64
    const result = await runTtsStage(makeParams(), 'test', deps);
    expect(result.audioB64).toBe('');
  });

  it('assertValidAudio: cloud candidate throws on missing contentType, leaving empty result', async () => {
    const deps = makeDeps({
      client: {
        transcribe: vi.fn(),
        chat: vi.fn(),
        synthesize: vi.fn().mockResolvedValue({ audio: FAKE_AUDIO, contentType: '', provider: 'groq' }),
      },
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        const signal = new AbortController().signal;
        const result = await candidates[0].run(signal);
        return { result, provider: 'groq', latencyMs: 70 };
      }) as HybridStagesDeps['raceProviders'],
    });
    const result = await runTtsStage(makeParams(), 'test', deps);
    expect(result.audioB64).toBe('');
  });

  it('clone fallback: calls client.synthesize when all clone candidates fail', async () => {
    const deps = makeDeps({
      isStageCircuitClosed: vi.fn().mockReturnValue(false),
      raceProviders: vi.fn().mockRejectedValue(new Error('all failed')) as HybridStagesDeps['raceProviders'],
    });
    const result = await runTtsStage(
      makeParams({ isCloneRequest: true }),
      'clone fallback text',
      deps,
    );
    expect(vi.mocked(deps.client.synthesize)).toHaveBeenCalled();
    expect(result.audioB64).toBe(FAKE_AUDIO_B64);
    expect(result.provider).toContain('preset-fallback');
  });

  it('GPU TTS warmth: calls markTtsWarm and saveColdStartProfile on first GPU success', async () => {
    const deps = makeDeps({
      isTtsWarm: vi.fn().mockReturnValue(false),
      isStageCircuitClosed: vi.fn().mockReturnValue(true),
      raceProviders: makeRaceProviders(
        { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: true }, 'gpu', 350,
      ) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(makeParams({ ttsOnGpu: true, gpuEp: 'http://gpu:8000' }), 'hello gpu', deps);
    expect(vi.mocked(deps.markTtsWarm)).toHaveBeenCalledWith(350);
    expect(vi.mocked(deps.saveColdStartProfile)).toHaveBeenCalledWith(
      expect.objectContaining({ coldTtfbMs: 350 }),
    );
    expect(vi.mocked(deps.recordTtsTtfb)).not.toHaveBeenCalled();
  });

  it('GPU TTS warmth: calls recordTtsTtfb when already warm', async () => {
    const deps = makeDeps({
      isTtsWarm: vi.fn().mockReturnValue(true),
      isStageCircuitClosed: vi.fn().mockReturnValue(true),
      raceProviders: makeRaceProviders(
        { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: true }, 'gpu', 180,
      ) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(makeParams({ ttsOnGpu: true, gpuEp: 'http://gpu:8000' }), 'hello warm gpu', deps);
    expect(vi.mocked(deps.recordTtsTtfb)).toHaveBeenCalledWith(180);
    expect(vi.mocked(deps.markTtsWarm)).not.toHaveBeenCalled();
  });

  it('no warmth tracking when cloud provider wins TTS', async () => {
    const deps = makeDeps({
      raceProviders: makeRaceProviders(
        { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: false }, 'groq', 70,
      ) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(makeParams(), 'hello cloud', deps);
    expect(vi.mocked(deps.markTtsWarm)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.recordTtsTtfb)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.recordPerStageLatency)).not.toHaveBeenCalled();
  });

  it('records per-stage latency when GPU wins', async () => {
    const deps = makeDeps({
      isTtsWarm: vi.fn().mockReturnValue(true),
      isStageCircuitClosed: vi.fn().mockReturnValue(true),
      raceProviders: makeRaceProviders(
        { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: true }, 'gpu', 250,
      ) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(makeParams({ ttsOnGpu: true, gpuEp: 'http://gpu:8000' }), 'hello', deps);
    expect(vi.mocked(deps.recordPerStageLatency)).toHaveBeenCalledWith('tts', 250);
  });

  it('deployMetadata is called when GPU TTS warmth is tracked', async () => {
    const deps = makeDeps({
      isTtsWarm: vi.fn().mockReturnValue(false),
      isStageCircuitClosed: vi.fn().mockReturnValue(true),
      raceProviders: makeRaceProviders(
        { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: true }, 'gpu', 300,
      ) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(makeParams({ ttsOnGpu: true, gpuEp: 'http://gpu:8000' }), 'test', deps);
    expect(vi.mocked(deps.deployMetadata)).toHaveBeenCalled();
    expect(vi.mocked(deps.saveColdStartProfile)).toHaveBeenCalledWith(
      expect.objectContaining({
        gpuType: 'RTX4090',
        dockerImage: 'img:latest',
        provider: 'runpod',
      }),
    );
  });

  it('uses cloneGpuEndpoint when gpuEp is not set but cloneGpuEndpoint is', async () => {
    const capturedCandidates: RaceCandidate<unknown>[] = [];
    const deps = makeDeps({
      isStageCircuitClosed: vi.fn().mockReturnValue(true),
      raceProviders: vi.fn().mockImplementation(async (candidates: RaceCandidate<unknown>[]) => {
        capturedCandidates.push(...candidates);
        return { result: { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: true }, provider: 'gpu', latencyMs: 200 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(
      makeParams({ isCloneRequest: true, gpuEp: undefined, cloneGpuEndpoint: 'http://clone-gpu:8000' }),
      'clone text',
      deps,
    );
    const names = capturedCandidates.map(c => c.name);
    expect(names).toContain('gpu');
  });

  it('uses tts-specific timeout for clone requests (60s)', async () => {
    const capturedOpts: unknown[] = [];
    const deps = makeDeps({
      isStageCircuitClosed: vi.fn().mockReturnValue(false),
      raceProviders: vi.fn().mockImplementation(async (_candidates, opts) => {
        capturedOpts.push(opts);
        return { result: { audio: FAKE_AUDIO, contentType: 'audio/wav', used_gpu: false }, provider: 'modal', latencyMs: 1000 };
      }) as HybridStagesDeps['raceProviders'],
    });
    await runTtsStage(makeParams({ isCloneRequest: true }), 'clone text', deps);
    // adaptiveStageTimeout should NOT be called for clone (uses 60_000 directly)
    // Verify we can run and get a result; adaptiveStageTimeout is only for non-clone
    expect(vi.mocked(deps.adaptiveStageTimeout)).not.toHaveBeenCalled();
  });
});
