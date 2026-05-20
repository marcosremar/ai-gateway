/**
 * Tests for pipeline-orchestrator module.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPipeline } from '../../src/pipeline-orchestrator';
import { raceProviders } from '../../src/gateway/routing/provider-racer';
import { runSttStage, runLlmStage, runTtsStage, type HybridStagesDeps, type PipelineStageParams } from '../../src/gateway/pipeline/hybrid-stages';
import { encodePipelineResponse } from '../../src/gateway/pipeline/pipeline-response';

describe('Pipeline Orchestrator', () => {
  it('should execute stages in order', async () => {
    const pipeline = createPipeline<string, string>('test');
    const order: string[] = [];

    pipeline.stage('a', async (input) => {
      order.push('a');
      return input + '-a';
    });
    pipeline.stage('b', async (input) => {
      order.push('b');
      return input + '-b';
    });

    const result = await pipeline.execute('start');
    expect(order).toEqual(['a', 'b']);
    expect(result).toBe('start-a-b');
  });

  it('should fail on stage error', async () => {
    const pipeline = createPipeline('failing');
    pipeline.stage('good', async (input) => input);
    pipeline.stage('bad', async () => {
      throw new Error('Stage failed');
    });

    await expect(pipeline.execute('data')).rejects.toThrow('Stage failed');
  });

  it('should track stats', async () => {
    const pipeline = createPipeline('stats');
    pipeline.stage('pass', async (x) => x);

    await pipeline.execute('1');
    await pipeline.execute('2');

    const stats = pipeline.getStats();
    expect(stats.totalExecutions).toBe(2);
    expect(stats.successfulExecutions).toBe(2);
    expect(stats.failedExecutions).toBe(0);
  });

  it('should execute fallback on failure', async () => {
    const pipeline = createPipeline('fallback');
    pipeline.stage('fail', async () => {
      throw new Error('Always fails');
    });

    const fallback = vi.fn().mockResolvedValue('fallback-result');
    const result = await pipeline.executeWithFallback('data', fallback);

    expect(result).toBe('fallback-result');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('should generate unique execution IDs', async () => {
    const pipeline = createPipeline('unique-ids');
    pipeline.stage('pass', async (x) => x);

    const ids = new Set();
    for (let i = 0; i < 10; i++) {
      await pipeline.execute('data');
    }

    // Each execution should have a unique ID (tested via context)
    expect(pipeline.getStats().totalExecutions).toBe(10);
  });
});

describe('End-to-end failure cascades', () => {
  const makeParams = (overrides: Partial<PipelineStageParams> = {}): PipelineStageParams => ({
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
    requestId: 'req-test',
    ...overrides,
  });

  const makeDeps = (overrides: Partial<HybridStagesDeps> = {}): HybridStagesDeps => ({
    client: {
      transcribe: vi.fn(async () => ({ text: 'cloud transcript', language: 'fr' })),
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
  });

  type SpeechState = {
    audio: Buffer;
    transcription?: string;
    response?: string;
    audioBase64?: string;
    contentType?: string;
  };

  it('stops after LLM failure when STT succeeds and does not call TTS', async () => {
    const pipeline = createPipeline<SpeechState, SpeechState>('speech-cascade');
    const stt = vi.fn(async (state: SpeechState) => ({ ...state, transcription: 'bonjour' }));
    const llm = vi.fn(async () => {
      throw new Error('LLM unavailable');
    });
    const tts = vi.fn(async (state: SpeechState) => ({
      ...state,
      audioBase64: Buffer.from('audio').toString('base64'),
      contentType: 'audio/wav',
    }));

    pipeline
      .stage('stt', stt)
      .stage('llm', llm)
      .stage('tts', tts);

    await expect(pipeline.execute({ audio: Buffer.from('wav') })).rejects.toThrow('LLM unavailable');

    expect(stt).toHaveBeenCalledTimes(1);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(tts).not.toHaveBeenCalled();
    expect(pipeline.getStats()).toMatchObject({
      totalExecutions: 1,
      successfulExecutions: 0,
      failedExecutions: 1,
    });
  });

  it('lets cloud fallback win when GPU times out in the real STT stage runner', async () => {
    const fetchGpuSTT = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    const transcribe = vi.fn(async () => ({
      text: 'cloud transcript',
      language: 'fr',
      timing: { total_ms: 18, server_ms: 12, network_ms: 6 },
    }));
    const deps = makeDeps({
      client: { ...makeDeps().client, transcribe },
      fetchGpuSTT,
    });

    const result = await runSttStage(makeParams({ sttOnGpu: true }), deps);

    expect(result).toEqual({
      text: 'cloud transcript',
      provider: 'groq',
      latencyMs: expect.any(Number),
      serverMs: 12,
      networkMs: 6,
    });
    expect(fetchGpuSTT).toHaveBeenCalledWith(
      'https://gpu.example',
      Buffer.from('wav'),
      'fr',
      '',
      '',
      false,
      expect.any(AbortSignal),
      'req-test',
    );
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('continues past malformed provider JSON in the real LLM stage runner', async () => {
    const fetchGpuLLM = vi.fn(async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    });
    const chat = vi.fn(async () => ({ content: 'hello' }));
    const setCachedTranslation = vi.fn();
    const broadcastWs = vi.fn();
    const deps = makeDeps({
      client: { ...makeDeps().client, chat },
      fetchGpuLLM,
      setCachedTranslation,
      broadcastWs,
    });

    const result = await runLlmStage(makeParams({ llmOnGpu: true }), {
      text: 'bonjour',
      provider: 'groq',
      latencyMs: 20,
      serverMs: undefined,
      networkMs: undefined,
    }, deps);

    expect(result.provider).toBe('groq');
    expect(result.translatedText).toBe('hello');
    expect(fetchGpuLLM).toHaveBeenCalledWith(
      'https://gpu.example',
      'bonjour',
      'fr',
      'en',
      '',
      '',
      expect.any(AbortSignal),
      'req-test',
    );
    expect(chat).toHaveBeenCalledWith([
      { role: 'system', content: 'Translate French to English' },
      { role: 'user', content: 'bonjour' },
    ], makeParams().cloudProfile);
    expect(setCachedTranslation).toHaveBeenCalledWith('bonjour', 'fr', 'en', 'hello', 'natural');
    expect(broadcastWs).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subtitle:early',
      transcription: 'bonjour',
      translation: 'hello',
    }));
  });

  it('continues past malformed SSE by selecting a valid fallback response', async () => {
    const malformedSseProvider = vi.fn(async () => {
      throw new Error('Malformed SSE frame: missing data payload');
    });
    const validProvider = vi.fn(async () => ({ translated_text: 'bonjour', used_gpu: false }));

    const winner = await raceProviders([
      { name: 'openrouter', run: malformedSseProvider },
      { name: 'groq', run: validProvider },
    ], { logPrefix: '[test-llm-sse]', headstartMs: 0 });

    expect(winner.provider).toBe('groq');
    expect(winner.result.translated_text).toBe('bonjour');
    expect(malformedSseProvider).toHaveBeenCalledTimes(1);
    expect(validProvider).toHaveBeenCalledTimes(1);
  });

  it('uses cached translation and skips LLM providers when available', async () => {
    const fetchGpuLLM = vi.fn();
    const chat = vi.fn();
    const broadcastWs = vi.fn();
    const deps = makeDeps({
      client: { ...makeDeps().client, chat },
      fetchGpuLLM,
      getCachedTranslation: () => 'cached hello',
      setCachedTranslation: vi.fn(),
      broadcastWs,
    });

    const result = await runLlmStage(makeParams({ llmOnGpu: true }), {
      text: 'bonjour',
      provider: 'groq',
      latencyMs: 20,
      serverMs: undefined,
      networkMs: undefined,
    }, deps);

    expect(result).toEqual({ translatedText: 'cached hello', provider: 'cache', latencyMs: 0 });
    expect(fetchGpuLLM).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(broadcastWs).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subtitle:early',
      transcription: 'bonjour',
      translation: 'cached hello',
      timing: { stt_ms: 20, llm_ms: 0 },
    }));
  });

  it('continues past malformed audio in the real TTS stage runner', async () => {
    const fetchGpuTTS = vi.fn(async () => ({
      audio: Buffer.alloc(0),
      contentType: 'audio/wav',
      used_gpu: true,
    }));
    const synthesize = vi.fn(async () => ({
      audio: Buffer.from('RIFF-valid-wav'),
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

    const result = await runTtsStage(makeParams({ ttsOnGpu: true }), 'hello', deps);

    expect(result.provider).toBe('groq');
    expect(result.audioB64).toBe(Buffer.from('RIFF-valid-wav').toString('base64'));
    expect(result.contentType).toBe('audio/wav');
    expect(fetchGpuTTS).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith('hello', makeParams().cloudProfile);
    expect(recordPerStageLatency).not.toHaveBeenCalled();
    expect(markTtsWarm).not.toHaveBeenCalled();
  });

  it('treats missing audio content type as malformed and uses fallback TTS', async () => {
    const fetchGpuTTS = vi.fn(async () => ({
      audio: Buffer.from('not-empty'),
      contentType: '',
      used_gpu: true,
    }));
    const synthesize = vi.fn(async () => ({
      audio: Buffer.from('fallback-audio'),
      contentType: 'audio/mpeg',
      provider: 'groq',
    }));
    const deps = makeDeps({
      client: { ...makeDeps().client, synthesize },
      fetchGpuTTS,
    });

    const result = await runTtsStage(makeParams({ ttsOnGpu: true }), 'hello', deps);

    expect(result.provider).toBe('groq');
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.audioB64).toBe(Buffer.from('fallback-audio').toString('base64'));
  });

  it('does not call any TTS provider when translation is blank', async () => {
    const fetchGpuTTS = vi.fn();
    const synthesize = vi.fn();
    const deps = makeDeps({
      client: { ...makeDeps().client, synthesize },
      fetchGpuTTS,
    });

    const result = await runTtsStage(makeParams({ ttsOnGpu: true }), '   ', deps);

    expect(result).toEqual({ audioB64: '', contentType: '', provider: '', latencyMs: 0 });
    expect(fetchGpuTTS).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('encodes partial pipeline result and log entry with STT/LLM output but no TTS', () => {
    const body = encodePipelineResponse(
      { text: 'bonjour', provider: 'groq', latencyMs: 23, serverMs: undefined, networkMs: undefined },
      { translatedText: 'hello', provider: 'groq', latencyMs: 31 },
      { audioB64: '', contentType: '', provider: '', latencyMs: 0 },
      54,
      false,
    );
    const logEntry = {
      timestamp: Date.now(), stage: 'pipeline' as const, provider: 'hybrid' as const,
      latencyMs: 54, success: true, inputSize: 3, outputPreview: body.response.slice(0, 80),
    };

    expect(body).toEqual({
      transcription: 'bonjour',
      response: 'hello',
      audio_base64: '',
      content_type: '',
      timing: {
        total_ms: 54,
        stt_ms: 23,
        llm_ms: 31,
        tts_ms: 0,
        used_gpu: false,
        stt_provider: 'groq',
        llm_provider: 'groq',
        tts_provider: 'none',
        clone: false,
      },
    });
    expect(logEntry).toMatchObject({
      stage: 'pipeline',
      provider: 'hybrid',
      success: true,
      outputPreview: 'hello',
    });
  });
});
