/**
 * Pipeline Runner Unit Tests (#246-#260)
 *
 * Tests for server/pipeline-runner.ts runStreamingPipeline covering:
 * - Full pipeline STT -> LLM -> TTS
 * - Mixed GPU/cloud routing
 * - Callbacks (onStageStart, onStageDone, onAudioChunk, onComplete, onError)
 * - Null baseProfile guard
 * - Empty TTS audio handling
 * - Speculative cache integration
 * - Stage circuit breakers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ────────────────────────────────────────────────────────────

// Use vi.hoisted to declare mock objects that are referenced in vi.mock factories
const {
  mockDeployState,
  mockClient,
  mockGroqProfile,
  defaultRaceImpl,
} = vi.hoisted(() => ({
  mockDeployState: {
    status: 'idle' as string, podId: '', endpoint: '', gpuType: '', dockerImage: '',
    message: '', step: '', stepDetail: '', startedAt: 0, retryCount: 0,
    provider: '' as string, alert: '', sshHost: '', sshPort: 0, lastLogs: '',
    deployDurationMs: 0, costPerHr: 0, providerMeta: {} as Record<string, unknown>, transitions: [] as unknown[],
  },
  mockClient: {
    transcribe: null as any, // will be set post-import
    chat: null as any,
    synthesize: null as any,
  },
  mockGroqProfile: {
    stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'groq', model: 'orpheus' }],
  },
  defaultRaceImpl: async (candidates: { name: string; run: (s: AbortSignal) => Promise<unknown> }[]) => {
    const signal = new AbortController().signal;
    const result = await candidates[0].run(signal);
    return { result, provider: candidates[0].name };
  },
}));

// State — mock all exported functions + vars
vi.mock('../server/state', () => ({
  botState: { status: 'idle', podId: '', endpoint: '' },
  deployState: mockDeployState,
  isGpuAvailable: vi.fn(() => false),
  touchRequest: vi.fn(),
  touchModelRequest: vi.fn(),
  isTtsWarm: vi.fn(() => false),
  recordTtsTtfb: vi.fn(),
  markTtsWarm: vi.fn(),
  ttsWarmth: { state: 'cold' },
  saveColdStartProfile: vi.fn(),
  isStageWarm: vi.fn(() => false),
  gpuReadyForProduction: vi.fn(() => false),
  gpuReadinessState: vi.fn(() => ({})),
  recordPerStageLatency: vi.fn(),
}));

vi.mock('../server/providers', () => ({
  client: mockClient,
  groqDefaults: mockGroqProfile,
  ollamaDefaults: null,
  translationDefaults: null,
  groqAvailable: true,
  groqLLM: { chatStream: vi.fn() },
  groqLlmModel: 'llama-3.3-70b-versatile',
  groqTtsModel: 'orpheus',
  groqTtsVoice: 'Ryan',
  shouldPreferGpuTts: vi.fn(() => false),
  recordStageSuccess: vi.fn(),
  recordStageFailure: vi.fn(),
  isStageCircuitClosed: vi.fn(() => true),
  providers: {},
  modalTTS: { synthesize: vi.fn() },
}));

vi.mock('../server/config', () => ({
  PROVIDER_CHAIN: ['groq'],
  GPU_PROVIDERS: new Set(['gpu']),
  MODAL_BABELCAST_URL: undefined,
}));

// Race providers — always returns first candidate result
vi.mock('../server/race-providers', () => ({
  raceProviders: vi.fn(defaultRaceImpl),
}));

// EWMA tracker
vi.mock('../server/ewma-tracker', () => ({
  EWMATracker: class {
    record() {}
    getLatency() { return null; }
    pickBest() { return null; }
    setDecayFactor() {}
    ranking() { return []; }
  },
}));

// Labs settings
vi.mock('../server/labs-settings', () => ({
  getLabsFlags: vi.fn(() => ({
    peakEwma: false,
    speculativeTranslation: false,
    streamingOverlap: false,
    ewmaDecayFactor: 0.3,
    speculationMinConfidence: 0.7,
    overlapMinTokens: 3,
    updatedAt: 0,
  })),
}));

// Streaming overlap
vi.mock('../server/streaming-overlap', () => ({
  StreamingOverlap: class {
    setMinTokens() {}
    processWithOverlap() { return Promise.resolve(''); }
  },
}));

// Speculative cache
vi.mock('../server/speculative-cache', () => ({
  speculativeCache: {
    resolve: vi.fn().mockResolvedValue(null),
    stats: vi.fn(() => ({})),
  },
}));

// WS state
vi.mock('../server/ws-state', () => ({
  broadcastWs: vi.fn(),
  broadcastDubAudio: vi.fn(),
}));

// Dub fanout
vi.mock('../server/dub-fanout', () => ({
  getActiveTargets: vi.fn(() => []),
  runMultiLangFanout: vi.fn(() => Promise.resolve()),
}));

// Metrics
vi.mock('../server/metrics', () => ({
  logRequest: vi.fn(),
}));

// Config persistence
vi.mock('../server/config-persistence', () => ({
  loadProviderConfig: vi.fn(() => ({ activeAppId: 'test' })),
  stampAppRequest: vi.fn(),
}));

// Ensemble STT
vi.mock('../src/ensemble-stt', () => ({
  runEnsembleSTT: vi.fn(),
}));

// Groq STT provider
vi.mock('../src/providers/groq', () => ({
  groqSTT: {},
}));

// HTTP utils
vi.mock('../server/http-utils', () => ({
  langNames: { fr: 'French', en: 'English' },
}));

// AI handlers
vi.mock('../server/ai-handlers', () => ({
  fetchGpuSTT: vi.fn(),
  fetchGpuLLM: vi.fn(),
  fetchGpuTTS: vi.fn(),
  getCachedTranslation: vi.fn(() => null),
  setCachedTranslation: vi.fn(),
  buildSystemPrompt: vi.fn((_src: string, _tgt: string, _style: string) => 'You are a translator.'),
  getCloudProviderName: vi.fn(() => 'groq'),
  getCloudProfile: vi.fn(() => mockGroqProfile),
  resolveVoiceForProfile: vi.fn(() => undefined),
  forwardToAvatar: vi.fn(),
  adaptiveStageTimeout: vi.fn((_stage: string, def: number) => def),
  GPU_STT_TIMEOUT_MS: 5000,
  GPU_LLM_TIMEOUT_MS: 5000,
  GPU_TTS_TIMEOUT_MS: 8000,
  GPU_PIPELINE_TIMEOUT_MS: 30000,
  getVoiceReference: vi.fn(() => null),
  touchModalKeepalive: vi.fn(),
}));

// Probe functions
vi.mock('../src', () => ({
  probeCloudProvider: vi.fn(() => Promise.resolve()),
  probeGpuHealth: vi.fn(() => Promise.resolve()),
}));

// Import after all mocks
import { runStreamingPipeline } from '../server/pipeline-runner';
import type { PipelineCallbacks, PipelineOpts } from '../server/pipeline-runner';
import { speculativeCache } from '../server/speculative-cache';
import { getLabsFlags } from '../server/labs-settings';
import { raceProviders } from '../server/race-providers';

// Initialize mockClient functions (after vi is fully initialized)
mockClient.transcribe = vi.fn().mockResolvedValue({ text: 'bonjour', language: 'fr' });
mockClient.chat = vi.fn().mockResolvedValue({ content: 'hello' });
mockClient.synthesize = vi.fn().mockResolvedValue({
  audio: Buffer.from('fake-audio-data'),
  contentType: 'audio/wav',
  provider: 'groq',
});

/** Reset all mocks to working defaults — call in every beforeEach */
function resetPipelineMocks() {
  vi.clearAllMocks();
  mockDeployState.status = 'idle';
  mockDeployState.endpoint = '';
  mockClient.transcribe.mockResolvedValue({ text: 'bonjour', language: 'fr' });
  mockClient.chat.mockResolvedValue({ content: 'hello' });
  mockClient.synthesize.mockResolvedValue({
    audio: Buffer.from('fake-audio-data'),
    contentType: 'audio/wav',
    provider: 'groq',
  });
  vi.mocked(raceProviders).mockImplementation(defaultRaceImpl as any);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCallbacks(): PipelineCallbacks & {
  stages: string[];
  done: string[];
  errors: string[];
  result: unknown;
  audioChunks: Buffer[];
} {
  const cb = {
    stages: [] as string[],
    done: [] as string[],
    errors: [] as string[],
    result: null as unknown,
    audioChunks: [] as Buffer[],
    onStageStart: vi.fn((stage: string) => { cb.stages.push(stage); }),
    onStageDone: vi.fn((stage: string) => { cb.done.push(stage); }),
    onAudioChunk: vi.fn((chunk: Buffer) => { cb.audioChunks.push(chunk); }),
    onComplete: vi.fn((result: unknown) => { cb.result = result; }),
    onError: vi.fn((stage: string) => { cb.errors.push(stage); }),
  };
  return cb;
}

function makeOpts(overrides: Partial<PipelineOpts> = {}): PipelineOpts {
  return {
    source: 'fr',
    target: 'en',
    speaker: 'Ryan',
    style: 'default',
    ...overrides,
  };
}

const fakeAudio = Buffer.alloc(32000, 0); // 1 second of silence at 16kHz 16-bit

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Pipeline runner — full pipeline flow', () => {
  beforeEach(() => {
    resetPipelineMocks();
  });

  // #246
  it('runs STT -> LLM -> TTS sequence with callbacks', async () => {
    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    // All stages should have been started
    expect(cb.stages).toContain('stt');
    expect(cb.stages).toContain('llm');
    expect(cb.stages).toContain('tts');

    // All stages should be done
    expect(cb.done).toContain('stt');
    expect(cb.done).toContain('llm');
    expect(cb.done).toContain('tts');

    // Should complete
    expect(cb.onComplete).toHaveBeenCalledTimes(1);
    expect(cb.errors).toHaveLength(0);
  });

  // #247
  it('onComplete result has full timing info', async () => {
    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    const result = cb.result as Record<string, unknown>;
    expect(result).toBeTruthy();

    const timing = result.timing as Record<string, unknown>;
    expect(timing).toBeTruthy();
    expect(typeof timing.total_ms).toBe('number');
    expect(typeof timing.stt_ms).toBe('number');
    expect(typeof timing.llm_ms).toBe('number');
    expect(typeof timing.tts_ms).toBe('number');
    expect(typeof timing.stt_provider).toBe('string');
    expect(typeof timing.llm_provider).toBe('string');
    expect(typeof timing.tts_provider).toBe('string');
    expect(typeof timing.used_gpu).toBe('boolean');
  });

  // #248
  it('sends audio chunk callback', async () => {
    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    // TTS should produce at least one audio chunk
    expect(cb.onAudioChunk).toHaveBeenCalled();
    expect(cb.audioChunks.length).toBeGreaterThan(0);
  });

  // #249
  it('reports cloud provider (groq) when GPU is not available', async () => {
    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    const result = cb.result as Record<string, unknown>;
    const timing = result.timing as Record<string, unknown>;
    expect(timing.used_gpu).toBe(false);
    // STT provider should be 'groq' (cloud)
    expect(timing.stt_provider).toBe('groq');
  });
});

describe('Pipeline runner — null baseProfile guard', () => {
  // #250
  it('calls onError when no LLM provider is configured', async () => {
    // Temporarily override providers mock to return null profiles
    const providersModule = await import('../server/providers');
    const origGroqDefaults = (providersModule as any).groqDefaults;
    (providersModule as any).groqDefaults = null;
    (providersModule as any).ollamaDefaults = null;
    (providersModule as any).translationDefaults = null;

    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    expect(cb.onError).toHaveBeenCalled();
    expect(cb.errors).toContain('pipeline');

    // Restore
    (providersModule as any).groqDefaults = origGroqDefaults;
  });
});

describe('Pipeline runner — empty STT handling', () => {
  beforeEach(() => {
    resetPipelineMocks();
  });

  // #251
  it('returns early with empty result when STT produces no text', async () => {
    mockClient.transcribe.mockResolvedValueOnce({ text: '', language: 'fr' });

    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    expect(cb.onComplete).toHaveBeenCalledTimes(1);
    const result = cb.result as Record<string, unknown>;
    expect(result.transcription).toBe('');
    expect(result.translation).toBe('');
    expect(result.audioBase64).toBe('');
    // LLM and TTS should not have been called
    expect(mockClient.chat).not.toHaveBeenCalled();
    expect(mockClient.synthesize).not.toHaveBeenCalled();
  });

  // #252
  it('returns early with whitespace-only STT text', async () => {
    mockClient.transcribe.mockResolvedValueOnce({ text: '   ', language: 'fr' });

    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    expect(cb.onComplete).toHaveBeenCalledTimes(1);
    const result = cb.result as Record<string, unknown>;
    // Source code returns hardcoded '' for transcription when sttText.trim() is empty
    expect(result.transcription).toBe('');
    expect(result.translation).toBe('');
  });
});

describe('Pipeline runner — empty TTS audio handling', () => {
  // #253
  it('handles TTS producing empty audio gracefully', async () => {
    mockClient.synthesize.mockResolvedValueOnce({
      audio: Buffer.alloc(0),
      contentType: '',
      provider: 'groq',
    });

    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    expect(cb.onComplete).toHaveBeenCalledTimes(1);
    const result = cb.result as Record<string, unknown>;
    // Pipeline completes but with no audio
    expect(result.transcription).toBe('bonjour');
    expect(result.translation).toBe('hello');
  });
});

describe('Pipeline runner — speculative cache integration', () => {
  // #254
  it('uses speculative cache result when enabled and available', async () => {
    vi.mocked(getLabsFlags).mockReturnValueOnce({
      peakEwma: false,
      speculativeTranslation: true,
      streamingOverlap: false,
      ewmaDecayFactor: 0.3,
      speculationMinConfidence: 0.7,
      overlapMinTokens: 3,
      updatedAt: 0,
    });
    vi.mocked(speculativeCache.resolve).mockResolvedValueOnce('hello from cache');

    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts({ sessionId: 'sess-1' }), cb);

    expect(cb.onComplete).toHaveBeenCalledTimes(1);
    const result = cb.result as Record<string, unknown>;
    const timing = result.timing as Record<string, unknown>;
    expect(timing.llm_provider).toBe('speculation');
  });

  // #255
  it('falls through to LLM when speculative cache misses', async () => {
    vi.mocked(getLabsFlags).mockReturnValueOnce({
      peakEwma: false,
      speculativeTranslation: true,
      streamingOverlap: false,
      ewmaDecayFactor: 0.3,
      speculationMinConfidence: 0.7,
      overlapMinTokens: 3,
      updatedAt: 0,
    });
    vi.mocked(speculativeCache.resolve).mockResolvedValueOnce(null);

    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts({ sessionId: 'sess-1' }), cb);

    const result = cb.result as Record<string, unknown>;
    const timing = result.timing as Record<string, unknown>;
    // Should have fallen through to regular LLM
    expect(timing.llm_provider).not.toBe('speculation');
  });
});

describe('Pipeline runner — error handling', () => {
  // #256
  it('calls onError when STT throws', async () => {
    // Make raceProviders throw
    const raceModule = await import('../server/race-providers');
    vi.mocked(raceModule.raceProviders).mockRejectedValueOnce(new Error('STT failed'));

    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    expect(cb.onError).toHaveBeenCalled();
    expect(cb.errors).toContain('pipeline');
  });

  // #257
  it('calls onError when LLM throws', async () => {
    // STT succeeds, but LLM race fails
    const raceModule = await import('../server/race-providers');
    let callCount = 0;
    vi.mocked(raceModule.raceProviders).mockImplementation(async (candidates: any[]) => {
      callCount++;
      if (callCount === 1) {
        // First call = STT — succeed
        const signal = new AbortController().signal;
        const result = await candidates[0].run(signal);
        return { result, provider: candidates[0].name };
      }
      // Second call = LLM — fail
      throw new Error('LLM failed');
    });

    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    expect(cb.onError).toHaveBeenCalled();
  });
});

describe('Pipeline runner — source/target defaults', () => {
  beforeEach(() => {
    resetPipelineMocks();
  });

  // #258
  it('defaults source to fr and target to en', async () => {
    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, { source: '', target: '' }, cb);

    // Pipeline should still complete using defaults
    expect(cb.onComplete).toHaveBeenCalled();
  });
});

describe('Pipeline runner — onStageStart/onStageDone ordering', () => {
  beforeEach(() => {
    resetPipelineMocks();
  });

  // #259
  it('calls onStageStart before onStageDone for each stage', async () => {
    const events: string[] = [];

    const cb: PipelineCallbacks = {
      onStageStart: vi.fn((stage: string) => events.push(`start:${stage}`)),
      onStageDone: vi.fn((stage: string) => events.push(`done:${stage}`)),
      onAudioChunk: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    const sttStartIdx = events.indexOf('start:stt');
    const sttDoneIdx = events.indexOf('done:stt');
    const llmStartIdx = events.indexOf('start:llm');
    const llmDoneIdx = events.indexOf('done:llm');
    const ttsStartIdx = events.indexOf('start:tts');
    const ttsDoneIdx = events.indexOf('done:tts');

    expect(sttStartIdx).toBeLessThan(sttDoneIdx);
    expect(llmStartIdx).toBeLessThan(llmDoneIdx);
    expect(ttsStartIdx).toBeLessThan(ttsDoneIdx);
    expect(sttDoneIdx).toBeLessThan(llmStartIdx);
  });
});

describe('Pipeline runner — cached translation', () => {
  beforeEach(() => {
    resetPipelineMocks();
  });

  // #260
  it('uses cached translation when available (llm_provider = cache)', async () => {
    const aiHandlers = await import('../server/ai-handlers');
    vi.mocked(aiHandlers.getCachedTranslation).mockReturnValueOnce('cached hello');

    const cb = makeCallbacks();
    await runStreamingPipeline(fakeAudio, makeOpts(), cb);

    expect(cb.onComplete).toHaveBeenCalledTimes(1);
    const result = cb.result as Record<string, unknown>;
    const timing = result.timing as Record<string, unknown>;
    expect(timing.llm_provider).toBe('cache');
    expect(timing.llm_ms).toBe(0);
    expect(result.translation).toBe('cached hello');
  });
});
