/**
 * Unit tests for src/gateway/pipeline/fanout-orchestrator.ts
 *
 * Covers: empty targets early-exit, target deduplication, FANOUT_MAX cap,
 * translation cache hit (skips LLM), cache miss (races LLM + populates cache),
 * empty translation short-circuit (no TTS/broadcast), full happy-path
 * (subtitle + TTS + dub:audio broadcast), per-target failure isolation,
 * langNames fallback to code when no entry, timing fields shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runFanoutOrchestrator,
  type FanoutDeps,
  type FanoutOpts,
  type FanoutRouting,
  type FanoutSideEffects,
  type FanoutStageExecutors,
} from '../src/gateway/pipeline/fanout-orchestrator';

// ── Mock raceProviders ────────────────────────────────────────────────────────

vi.mock('../src/gateway/routing/provider-racer', () => ({
  raceProviders: vi.fn(),
}));

import { raceProviders } from '../src/gateway/routing/provider-racer';
const mockRace = vi.mocked(raceProviders);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AUDIO_BUF = Buffer.from('fake-tts-audio');

// A universal response that works for both LLM and TTS call sites:
// LLM reads result.translated_text, TTS reads result.audio.
const UNIVERSAL_OK = {
  result: { translated_text: 'Bonjour', audio: AUDIO_BUF },
  provider: 'groq',
  latencyMs: 50,
  otherCancelled: false,
};

const DEFAULT_ROUTING: FanoutRouting = {
  llmOnGpu: false,
  ttsOnGpu: false,
  cloudProviderName: 'groq',
};

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
};

function makeDeps(overrides: {
  cachedTranslation?: string | null;
  sideEffects?: Partial<FanoutSideEffects>;
  executors?: Partial<FanoutStageExecutors>;
} = {}): FanoutDeps {
  const sideEffects: FanoutSideEffects = {
    broadcastSubtitle: vi.fn(),
    broadcastDubAudio: vi.fn(),
    ...overrides.sideEffects,
  };

  const executors: FanoutStageExecutors = {
    getCachedTranslation: vi.fn().mockReturnValue(overrides.cachedTranslation ?? null),
    setCachedTranslation: vi.fn(),
    buildSystemPrompt: vi.fn().mockReturnValue('Translate from English to French.'),
    buildLlmCandidates: vi.fn().mockReturnValue([{ name: 'groq-llm', run: vi.fn() }]),
    buildTtsCandidates: vi.fn().mockReturnValue([{ name: 'groq-tts', run: vi.fn() }]),
    ...overrides.executors,
  };

  return {
    routing: DEFAULT_ROUTING,
    sideEffects,
    executors,
    langNames: LANG_NAMES,
  };
}

/**
 * Queue exactly one LLM response then one TTS response.
 * Only safe for single-target tests where order is deterministic.
 */
function queueOneTarget(
  translatedText = 'Bonjour',
  audioBuffer: Buffer = AUDIO_BUF,
) {
  mockRace
    .mockResolvedValueOnce({
      result: { translated_text: translatedText },
      provider: 'groq-llm',
      latencyMs: 120,
      otherCancelled: false,
    })
    .mockResolvedValueOnce({
      result: { audio: audioBuffer },
      provider: 'groq-tts',
      latencyMs: 80,
      otherCancelled: false,
    });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runFanoutOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Early-exit / guard clauses ────────────────────────────────────────────

  it('returns immediately when targets is empty', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator('Hello world', 'en', 50, 'groq', { targets: [] }, deps);
    expect(mockRace).not.toHaveBeenCalled();
    expect(deps.sideEffects.broadcastSubtitle).not.toHaveBeenCalled();
    expect(deps.sideEffects.broadcastDubAudio).not.toHaveBeenCalled();
  });

  // ── Target deduplication ──────────────────────────────────────────────────

  it('deduplicates repeated targets — only one LLM+TTS call per unique target', async () => {
    queueOneTarget();
    const deps = makeDeps();
    await runFanoutOrchestrator('Hello', 'en', 50, 'groq', { targets: ['fr', 'fr', 'fr'] }, deps);
    // Deduped to ['fr'] → 1 LLM race + 1 TTS race = 2 total
    expect(mockRace).toHaveBeenCalledTimes(2);
  });

  it('deduplicates mixed targets keeping unique set', async () => {
    // Two unique targets → 2 × (LLM + TTS) = 4 races
    mockRace.mockResolvedValue(UNIVERSAL_OK);
    const deps = makeDeps();
    await runFanoutOrchestrator('Hello', 'en', 50, 'groq', { targets: ['fr', 'es', 'fr', 'es'] }, deps);
    expect(mockRace).toHaveBeenCalledTimes(4);
  });

  // ── FANOUT_MAX cap ────────────────────────────────────────────────────────

  it('caps targets at 16 (FANOUT_MAX) regardless of how many are passed', async () => {
    mockRace.mockResolvedValue(UNIVERSAL_OK);
    const manyTargets = Array.from({ length: 25 }, (_, i) => `lang${i}`);
    const deps = makeDeps();
    await runFanoutOrchestrator('Hi', 'en', 30, 'groq', { targets: manyTargets }, deps);
    // Max 16 targets × 2 calls each = 32 race calls
    expect(mockRace).toHaveBeenCalledTimes(32);
  });

  it('still processes all 16 capped targets successfully', async () => {
    mockRace.mockResolvedValue(UNIVERSAL_OK);
    const manyTargets = Array.from({ length: 20 }, (_, i) => `lang${i}`);
    const deps = makeDeps();
    await runFanoutOrchestrator('Hi', 'en', 30, 'groq', { targets: manyTargets }, deps);
    expect(deps.sideEffects.broadcastSubtitle).toHaveBeenCalledTimes(16);
    expect(deps.sideEffects.broadcastDubAudio).toHaveBeenCalledTimes(16);
  });

  // ── Translation cache hit ─────────────────────────────────────────────────

  it('uses cached translation and skips LLM race', async () => {
    // Only TTS race needed (cache hit skips LLM)
    mockRace.mockResolvedValueOnce({
      result: { audio: AUDIO_BUF },
      provider: 'groq-tts',
      latencyMs: 80,
      otherCancelled: false,
    });

    const deps = makeDeps({ cachedTranslation: 'Bonjour le monde' });
    await runFanoutOrchestrator('Hello world', 'en', 50, 'groq', { targets: ['fr'] }, deps);

    expect(deps.executors.buildLlmCandidates).not.toHaveBeenCalled();
    expect(mockRace).toHaveBeenCalledTimes(1);
    expect(deps.executors.buildTtsCandidates).toHaveBeenCalledWith(
      DEFAULT_ROUTING,
      'Bonjour le monde',
      'French',
      'Ryan',
    );
  });

  it('does not call setCachedTranslation on cache hit', async () => {
    mockRace.mockResolvedValueOnce({
      result: { audio: AUDIO_BUF },
      provider: 'groq-tts',
      latencyMs: 80,
      otherCancelled: false,
    });

    const deps = makeDeps({ cachedTranslation: 'Salut' });
    await runFanoutOrchestrator('Hi', 'en', 30, 'groq', { targets: ['fr'] }, deps);
    expect(deps.executors.setCachedTranslation).not.toHaveBeenCalled();
  });

  // ── Translation cache miss ────────────────────────────────────────────────

  it('races LLM on cache miss and stores result in cache', async () => {
    queueOneTarget('Hola mundo');
    const deps = makeDeps({ cachedTranslation: null });
    await runFanoutOrchestrator('Hello world', 'en', 50, 'groq', { targets: ['es'] }, deps);

    expect(deps.executors.buildLlmCandidates).toHaveBeenCalledOnce();
    expect(deps.executors.setCachedTranslation).toHaveBeenCalledWith(
      'Hello world', 'en', 'es', 'Hola mundo', 'default',
    );
  });

  it('uses custom style parameter for cache key and system prompt', async () => {
    queueOneTarget('formal text');
    const deps = makeDeps({ cachedTranslation: null });
    await runFanoutOrchestrator('Hello', 'en', 30, 'groq', { targets: ['fr'], style: 'formal' }, deps);

    expect(deps.executors.getCachedTranslation).toHaveBeenCalledWith('Hello', 'en', 'fr', 'formal');
    expect(deps.executors.setCachedTranslation).toHaveBeenCalledWith(
      'Hello', 'en', 'fr', 'formal text', 'formal',
    );
    expect(deps.executors.buildSystemPrompt).toHaveBeenCalledWith('English', 'French', 'formal');
  });

  // ── Empty translation short-circuit ──────────────────────────────────────

  it('skips TTS and broadcast when LLM returns empty text', async () => {
    mockRace.mockResolvedValueOnce({
      result: { translated_text: '' },
      provider: 'groq-llm',
      latencyMs: 100,
      otherCancelled: false,
    });

    const deps = makeDeps();
    await runFanoutOrchestrator('Hello', 'en', 50, 'groq', { targets: ['fr'] }, deps);

    expect(deps.executors.buildTtsCandidates).not.toHaveBeenCalled();
    expect(deps.sideEffects.broadcastSubtitle).not.toHaveBeenCalled();
    expect(deps.sideEffects.broadcastDubAudio).not.toHaveBeenCalled();
  });

  it('skips TTS and broadcast when translation is whitespace-only', async () => {
    mockRace.mockResolvedValueOnce({
      result: { translated_text: '   ' },
      provider: 'groq-llm',
      latencyMs: 100,
      otherCancelled: false,
    });

    const deps = makeDeps();
    await runFanoutOrchestrator('Hello', 'en', 50, 'groq', { targets: ['fr'] }, deps);

    expect(deps.sideEffects.broadcastSubtitle).not.toHaveBeenCalled();
    expect(deps.sideEffects.broadcastDubAudio).not.toHaveBeenCalled();
  });

  // ── Happy path — full pipeline ────────────────────────────────────────────

  it('broadcasts subtitle with correct fields on successful translation', async () => {
    queueOneTarget('Bonjour');
    const deps = makeDeps();
    await runFanoutOrchestrator('Hello', 'en', 55, 'groq', { targets: ['fr'] }, deps);

    expect(deps.sideEffects.broadcastSubtitle).toHaveBeenCalledOnce();
    const call = vi.mocked(deps.sideEffects.broadcastSubtitle).mock.calls[0][0];
    expect(call.transcription).toBe('Hello');
    expect(call.translation).toBe('Bonjour');
    expect(call.source).toBe('en');
    expect(call.target).toBe('fr');
    expect(call.timing.stt_ms).toBe(55);
    expect(typeof call.timing.llm_ms).toBe('number');
  });

  it('broadcasts dub:audio with correct fields and buffer', async () => {
    queueOneTarget('Bonjour', AUDIO_BUF);
    const deps = makeDeps();
    await runFanoutOrchestrator('Hello', 'en', 55, 'groq', { targets: ['fr'] }, deps);

    expect(deps.sideEffects.broadcastDubAudio).toHaveBeenCalledOnce();
    const [tgt, data, buf] = vi.mocked(deps.sideEffects.broadcastDubAudio).mock.calls[0];
    expect(tgt).toBe('fr');
    expect(data.type).toBe('dub:audio');
    expect(data.target).toBe('fr');
    expect(data.transcription).toBe('Hello');
    expect(data.translation).toBe('Bonjour');
    expect(typeof data.audio).toBe('string');
    expect(data.timing.stt_ms).toBe(55);
    expect(typeof data.timing.tts_ms).toBe('number');
    expect(typeof data.timing.total_ms).toBe('number');
    expect(buf).toBe(AUDIO_BUF);
  });

  it('audio field in dub:audio is valid base64 of TTS buffer', async () => {
    const customBuf = Buffer.from('custom-audio-bytes');
    queueOneTarget('text', customBuf);
    const deps = makeDeps();
    await runFanoutOrchestrator('hi', 'en', 10, 'groq', { targets: ['fr'] }, deps);

    const [, data] = vi.mocked(deps.sideEffects.broadcastDubAudio).mock.calls[0];
    expect(Buffer.from(data.audio, 'base64')).toEqual(customBuf);
  });

  it('passes speaker to buildTtsCandidates', async () => {
    queueOneTarget('Hola');
    const deps = makeDeps();
    await runFanoutOrchestrator('Hi', 'en', 30, 'groq', { targets: ['es'], speaker: 'Alice' }, deps);

    expect(deps.executors.buildTtsCandidates).toHaveBeenCalledWith(
      DEFAULT_ROUTING,
      'Hola',
      'Spanish',
      'Alice',
    );
  });

  it('defaults speaker to "Ryan" when not specified', async () => {
    queueOneTarget('Hola');
    const deps = makeDeps();
    await runFanoutOrchestrator('Hi', 'en', 30, 'groq', { targets: ['es'] }, deps);

    const [, , , speaker] = vi.mocked(deps.executors.buildTtsCandidates).mock.calls[0];
    expect(speaker).toBe('Ryan');
  });

  // ── Lang name fallback ────────────────────────────────────────────────────

  it('falls back to lang code as name when langNames has no entry', async () => {
    queueOneTarget('Text in jp');
    const deps = makeDeps();
    await runFanoutOrchestrator('Hello', 'en', 30, 'groq', { targets: ['jp'] }, deps);

    // 'jp' has no entry in LANG_NAMES → pass 'jp' as both targetName
    expect(deps.executors.buildSystemPrompt).toHaveBeenCalledWith('English', 'jp', 'default');
  });

  it('uses source lang code as name fallback when source not in langNames', async () => {
    queueOneTarget('Translated');
    const deps = makeDeps();
    await runFanoutOrchestrator('Hello', 'zh', 30, 'groq', { targets: ['fr'] }, deps);

    // 'zh' has no entry in LANG_NAMES → sourceName = 'zh'
    expect(deps.executors.buildSystemPrompt).toHaveBeenCalledWith('zh', 'French', 'default');
  });

  // ── Per-target failure isolation ──────────────────────────────────────────

  it('does not throw when LLM race rejects for a single target', async () => {
    mockRace.mockRejectedValueOnce(new Error('LLM timeout'));
    const deps = makeDeps();
    await expect(
      runFanoutOrchestrator('Hello', 'en', 30, 'groq', { targets: ['fr'] }, deps),
    ).resolves.toBeUndefined();

    expect(deps.sideEffects.broadcastSubtitle).not.toHaveBeenCalled();
    expect(deps.sideEffects.broadcastDubAudio).not.toHaveBeenCalled();
  });

  it('does not throw when TTS race rejects for a single target', async () => {
    // LLM succeeds, TTS fails
    mockRace
      .mockResolvedValueOnce({
        result: { translated_text: 'Bonjour' },
        provider: 'groq-llm',
        latencyMs: 100,
        otherCancelled: false,
      })
      .mockRejectedValueOnce(new Error('TTS provider error'));

    const deps = makeDeps();
    await expect(
      runFanoutOrchestrator('Hello', 'en', 30, 'groq', { targets: ['fr'] }, deps),
    ).resolves.toBeUndefined();

    // Subtitle broadcast happens before TTS call
    expect(deps.sideEffects.broadcastSubtitle).toHaveBeenCalledOnce();
    // dub:audio NOT broadcast because TTS failed
    expect(deps.sideEffects.broadcastDubAudio).not.toHaveBeenCalled();
  });

  it('all targets fail — resolves without throw', async () => {
    mockRace.mockRejectedValue(new Error('provider down'));
    const deps = makeDeps();
    await expect(
      runFanoutOrchestrator('Hello', 'en', 30, 'groq', { targets: ['fr', 'es', 'de'] }, deps),
    ).resolves.toBeUndefined();
  });

  // ── Multi-target parallel execution ──────────────────────────────────────

  it('processes all unique targets when all succeed', async () => {
    mockRace.mockResolvedValue(UNIVERSAL_OK);
    const deps = makeDeps();
    await runFanoutOrchestrator('Hello', 'en', 50, 'groq', { targets: ['fr', 'es', 'de'] }, deps);

    expect(deps.sideEffects.broadcastSubtitle).toHaveBeenCalledTimes(3);
    expect(deps.sideEffects.broadcastDubAudio).toHaveBeenCalledTimes(3);
  });

  it('targets for dub:audio broadcast have correct target codes', async () => {
    mockRace.mockResolvedValue(UNIVERSAL_OK);
    const deps = makeDeps();
    await runFanoutOrchestrator('Hello', 'en', 50, 'groq', { targets: ['fr', 'es'] }, deps);

    const broadcastTargets = vi.mocked(deps.sideEffects.broadcastDubAudio).mock.calls
      .map(([tgt]) => tgt)
      .sort();
    expect(broadcastTargets).toEqual(['es', 'fr']);
  });

  it('buildLlmCandidates receives routing, sttText, source, target, and systemPrompt', async () => {
    queueOneTarget('Hola');
    const deps = makeDeps();
    await runFanoutOrchestrator('Hello there', 'en', 40, 'groq', { targets: ['es'] }, deps);

    expect(deps.executors.buildLlmCandidates).toHaveBeenCalledWith(
      DEFAULT_ROUTING,
      'Hello there',
      'en',
      'es',
      'Translate from English to French.', // what buildSystemPrompt mock returns
    );
  });

  // ── Translation cache — key parameters ───────────────────────────────────

  it('calls getCachedTranslation with correct key fields', async () => {
    queueOneTarget('x');
    const deps = makeDeps({ cachedTranslation: null });
    await runFanoutOrchestrator('Input text', 'en', 20, 'groq',
      { targets: ['fr'], style: 'casual' }, deps);

    expect(deps.executors.getCachedTranslation).toHaveBeenCalledWith(
      'Input text', 'en', 'fr', 'casual',
    );
  });

  it('default style is "default" when style not provided', async () => {
    queueOneTarget('x');
    const deps = makeDeps({ cachedTranslation: null });
    await runFanoutOrchestrator('Hello', 'en', 20, 'groq', { targets: ['fr'] }, deps);

    expect(deps.executors.getCachedTranslation).toHaveBeenCalledWith(
      'Hello', 'en', 'fr', 'default',
    );
  });

  // ── Routing passed through to executors ──────────────────────────────────

  it('passes routing to buildLlmCandidates and buildTtsCandidates', async () => {
    const customRouting: FanoutRouting = {
      llmOnGpu: true,
      ttsOnGpu: true,
      cloudProviderName: 'fireworks',
      gpuEndpoint: 'http://gpu:8000',
    };
    queueOneTarget('Translated');
    const deps = makeDeps();
    deps.routing = customRouting;

    await runFanoutOrchestrator('Hello', 'en', 30, 'groq', { targets: ['fr'] }, deps);

    expect(deps.executors.buildLlmCandidates).toHaveBeenCalledWith(
      customRouting,
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
    expect(deps.executors.buildTtsCandidates).toHaveBeenCalledWith(
      customRouting,
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });
});
