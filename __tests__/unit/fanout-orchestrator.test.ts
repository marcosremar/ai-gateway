import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runFanoutOrchestrator } from '../../src/gateway/pipeline/fanout-orchestrator';
import type { FanoutDeps, FanoutOpts, FanoutRouting } from '../../src/gateway/pipeline/fanout-orchestrator';

// Mock raceProviders — the only external side-effecting import
vi.mock('../../src/gateway/routing/provider-racer', () => ({
  raceProviders: vi.fn(),
}));

import { raceProviders } from '../../src/gateway/routing/provider-racer';
const mockRace = vi.mocked(raceProviders);

// ── Helpers ──────────────────────────────────────────────────────────────────

const routing: FanoutRouting = {
  gpuEndpoint: undefined,
  llmOnGpu: false,
  ttsOnGpu: false,
  cloudProviderName: 'groq',
};

const langNames: Record<string, string> = {
  en: 'English',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
};

function makeDeps(overrides: Partial<FanoutDeps['executors']> = {}): FanoutDeps {
  const executors: FanoutDeps['executors'] = {
    getCachedTranslation: vi.fn().mockReturnValue(null),
    setCachedTranslation: vi.fn(),
    buildSystemPrompt: vi.fn().mockReturnValue('You are a translator.'),
    buildLlmCandidates: vi.fn().mockReturnValue([
      { name: 'groq', run: vi.fn().mockResolvedValue({ translated_text: 'Bonjour' }) },
    ]),
    buildTtsCandidates: vi.fn().mockReturnValue([
      { name: 'groq-tts', run: vi.fn().mockResolvedValue({ audio: Buffer.from([1, 2, 3]) }) },
    ]),
    ...overrides,
  };
  return {
    routing,
    langNames,
    sideEffects: {
      broadcastSubtitle: vi.fn(),
      broadcastDubAudio: vi.fn(),
    },
    executors,
  };
}

function makeOpts(targets: string[], style?: string): FanoutOpts {
  return { targets, style };
}

// Default raceProviders behavior: run first candidate and return its result
function setupRaceToWin(translated = 'Bonjour', audioBytes: number[] = [1, 2, 3]) {
  mockRace.mockImplementation(async (candidates) => {
    const c = candidates[0];
    const ac = new AbortController();
    const result = await c.run(ac.signal);
    return { result, provider: c.name, latencyMs: 10, otherCancelled: false };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupRaceToWin();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runFanoutOrchestrator — early exit', () => {
  it('returns immediately when targets array is empty', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts([]), deps);
    expect(mockRace).not.toHaveBeenCalled();
    expect(deps.sideEffects.broadcastSubtitle).not.toHaveBeenCalled();
    expect(deps.sideEffects.broadcastDubAudio).not.toHaveBeenCalled();
  });
});

describe('runFanoutOrchestrator — target deduplication and cap', () => {
  it('deduplicates repeated targets', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr', 'fr', 'de']), deps);
    // Two unique targets → raceProviders called twice for LLM + twice for TTS
    expect(deps.executors.buildLlmCandidates).toHaveBeenCalledTimes(2);
  });

  it('caps targets at FANOUT_MAX=16', async () => {
    const deps = makeDeps();
    const tooMany = Array.from({ length: 20 }, (_, i) => `lang${i}`);
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(tooMany), deps);
    expect(deps.executors.buildLlmCandidates).toHaveBeenCalledTimes(16);
  });

  it('processes deduplicated target list after cap', async () => {
    const deps = makeDeps();
    // 18 unique targets + 2 dupes of first two → should produce 16 after dedup+cap
    const mixed = [
      ...Array.from({ length: 18 }, (_, i) => `lang${i}`),
      'lang0', 'lang1',
    ];
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(mixed), deps);
    expect(deps.executors.buildLlmCandidates).toHaveBeenCalledTimes(16);
  });
});

describe('runFanoutOrchestrator — cache hit path', () => {
  it('skips LLM when cache has a translation', async () => {
    const deps = makeDeps({
      getCachedTranslation: vi.fn().mockReturnValue('Bonjour (cached)'),
    });
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr']), deps);

    expect(deps.executors.buildLlmCandidates).not.toHaveBeenCalled();
    // TTS should still run with the cached translation
    expect(deps.executors.buildTtsCandidates).toHaveBeenCalledWith(
      routing,
      'Bonjour (cached)',
      expect.any(String),
      expect.any(String),
    );
  });

  it('broadcasts subtitle even on cache hit', async () => {
    const deps = makeDeps({
      getCachedTranslation: vi.fn().mockReturnValue('Bonjour (cached)'),
    });
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr']), deps);

    expect(deps.sideEffects.broadcastSubtitle).toHaveBeenCalledWith(
      expect.objectContaining({
        transcription: 'hello',
        translation: 'Bonjour (cached)',
        source: 'en',
        target: 'fr',
      }),
    );
  });

  it('does not call setCachedTranslation on a cache hit', async () => {
    const deps = makeDeps({
      getCachedTranslation: vi.fn().mockReturnValue('already cached'),
    });
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr']), deps);
    expect(deps.executors.setCachedTranslation).not.toHaveBeenCalled();
  });
});

describe('runFanoutOrchestrator — cache miss path', () => {
  it('builds LLM candidates and calls raceProviders', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr']), deps);

    expect(deps.executors.buildSystemPrompt).toHaveBeenCalledWith('English', 'French', 'default');
    expect(deps.executors.buildLlmCandidates).toHaveBeenCalledOnce();
    expect(mockRace).toHaveBeenCalled();
  });

  it('caches the translated text after a successful LLM call', async () => {
    const deps = makeDeps({
      buildLlmCandidates: vi.fn().mockReturnValue([
        { name: 'groq', run: vi.fn().mockResolvedValue({ translated_text: 'Hola' }) },
      ]),
    });
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['es']), deps);

    expect(deps.executors.setCachedTranslation).toHaveBeenCalledWith(
      'hello', 'en', 'es', 'Hola', 'default',
    );
  });

  it('uses the default style "default" when style not provided', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', { targets: ['fr'] }, deps);
    expect(deps.executors.buildSystemPrompt).toHaveBeenCalledWith('English', 'French', 'default');
  });

  it('forwards custom style to buildSystemPrompt and setCachedTranslation', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr'], 'formal'), deps);
    expect(deps.executors.buildSystemPrompt).toHaveBeenCalledWith('English', 'French', 'formal');
    expect(deps.executors.setCachedTranslation).toHaveBeenCalledWith(
      'hello', 'en', 'fr', expect.any(String), 'formal',
    );
  });
});

describe('runFanoutOrchestrator — empty/blank translation', () => {
  it('skips TTS and broadcast when translated text is empty', async () => {
    const deps = makeDeps({
      buildLlmCandidates: vi.fn().mockReturnValue([
        { name: 'groq', run: vi.fn().mockResolvedValue({ translated_text: '' }) },
      ]),
    });
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr']), deps);
    expect(deps.executors.buildTtsCandidates).not.toHaveBeenCalled();
    expect(deps.sideEffects.broadcastSubtitle).not.toHaveBeenCalled();
    expect(deps.sideEffects.broadcastDubAudio).not.toHaveBeenCalled();
  });

  it('skips TTS when translation is only whitespace', async () => {
    const deps = makeDeps({
      buildLlmCandidates: vi.fn().mockReturnValue([
        { name: 'groq', run: vi.fn().mockResolvedValue({ translated_text: '   \t\n  ' }) },
      ]),
    });
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr']), deps);
    expect(deps.executors.buildTtsCandidates).not.toHaveBeenCalled();
  });
});

describe('runFanoutOrchestrator — broadcast payloads', () => {
  it('broadcasts subtitle with correct fields', async () => {
    const deps = makeDeps({
      buildLlmCandidates: vi.fn().mockReturnValue([
        { name: 'groq', run: vi.fn().mockResolvedValue({ translated_text: 'Bonjour' }) },
      ]),
    });
    await runFanoutOrchestrator('hello', 'en', 50, 'groq', makeOpts(['fr']), deps);

    const call = (deps.sideEffects.broadcastSubtitle as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.transcription).toBe('hello');
    expect(call.translation).toBe('Bonjour');
    expect(call.source).toBe('en');
    expect(call.target).toBe('fr');
    expect(call.timing.stt_ms).toBe(50);
    expect(typeof call.timing.llm_ms).toBe('number');
  });

  it('broadcasts dub:audio with base64-encoded buffer', async () => {
    const audioBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const deps = makeDeps({
      buildLlmCandidates: vi.fn().mockReturnValue([
        { name: 'groq', run: vi.fn().mockResolvedValue({ translated_text: 'Bonjour' }) },
      ]),
      buildTtsCandidates: vi.fn().mockReturnValue([
        { name: 'groq-tts', run: vi.fn().mockResolvedValue({ audio: audioBytes }) },
      ]),
    });
    await runFanoutOrchestrator('hello', 'en', 50, 'groq', makeOpts(['fr']), deps);

    const [target, data, buffer] = (deps.sideEffects.broadcastDubAudio as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(target).toBe('fr');
    expect(data.type).toBe('dub:audio');
    expect(data.audio).toBe(audioBytes.toString('base64'));
    expect(buffer).toBe(audioBytes);
    expect(data.transcription).toBe('hello');
    expect(data.translation).toBe('Bonjour');
  });

  it('includes stt_ms in timing for dub:audio', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator('hello', 'en', 123, 'groq', makeOpts(['fr']), deps);
    const [, data] = (deps.sideEffects.broadcastDubAudio as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(data.timing.stt_ms).toBe(123);
  });

  it('uses default speaker "Ryan" when not specified', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr']), deps);
    expect(deps.executors.buildTtsCandidates).toHaveBeenCalledWith(
      routing,
      expect.any(String),
      expect.any(String),
      'Ryan',
    );
  });

  it('forwards custom speaker to buildTtsCandidates', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator(
      'hello', 'en', 100, 'groq',
      { targets: ['fr'], speaker: 'Aria' },
      deps,
    );
    expect(deps.executors.buildTtsCandidates).toHaveBeenCalledWith(
      routing, expect.any(String), expect.any(String), 'Aria',
    );
  });
});

describe('runFanoutOrchestrator — language name resolution', () => {
  it('resolves source and target names from langNames map', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr']), deps);
    expect(deps.executors.buildSystemPrompt).toHaveBeenCalledWith('English', 'French', 'default');
  });

  it('falls back to raw code when langNames has no entry', async () => {
    const deps = makeDeps();
    await runFanoutOrchestrator('hello', 'xx', 100, 'groq', makeOpts(['zz']), deps);
    expect(deps.executors.buildSystemPrompt).toHaveBeenCalledWith('xx', 'zz', 'default');
  });
});

describe('runFanoutOrchestrator — failure isolation', () => {
  it('does not propagate LLM failure — other targets still complete', async () => {
    let callCount = 0;
    const deps = makeDeps({
      buildLlmCandidates: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return [{ name: 'groq', run: vi.fn().mockRejectedValue(new Error('LLM down')) }];
        }
        return [{ name: 'groq', run: vi.fn().mockResolvedValue({ translated_text: 'Hola' }) }];
      }),
    });

    // Should not throw even though first target fails
    await expect(
      runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr', 'es']), deps),
    ).resolves.toBeUndefined();

    // Second target should have succeeded
    expect(deps.sideEffects.broadcastSubtitle).toHaveBeenCalledTimes(1);
    expect((deps.sideEffects.broadcastSubtitle as ReturnType<typeof vi.fn>).mock.calls[0][0].target).toBe('es');
  });

  it('does not propagate TTS failure', async () => {
    const deps = makeDeps({
      buildTtsCandidates: vi.fn().mockReturnValue([
        { name: 'groq-tts', run: vi.fn().mockRejectedValue(new Error('TTS down')) },
      ]),
    });

    await expect(
      runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr']), deps),
    ).resolves.toBeUndefined();

    // broadcastSubtitle still fires (before TTS), but broadcastDubAudio must not
    expect(deps.sideEffects.broadcastSubtitle).toHaveBeenCalledOnce();
    expect(deps.sideEffects.broadcastDubAudio).not.toHaveBeenCalled();
  });

  it('does not propagate raceProviders throwing on empty candidates', async () => {
    const deps = makeDeps({
      buildLlmCandidates: vi.fn().mockReturnValue([]),
    });
    mockRace.mockRejectedValue(new Error('raceProviders: no candidates'));

    await expect(
      runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr']), deps),
    ).resolves.toBeUndefined();

    expect(deps.sideEffects.broadcastSubtitle).not.toHaveBeenCalled();
  });
});

describe('runFanoutOrchestrator — parallel execution', () => {
  it('processes multiple targets in parallel', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      buildLlmCandidates: vi.fn().mockImplementation((_r, _t, _s, target) => [{
        name: 'groq',
        run: vi.fn().mockImplementation(async () => {
          order.push(`llm:${target}`);
          return { translated_text: `translation for ${target}` };
        }),
      }]),
    });

    await runFanoutOrchestrator('hello', 'en', 100, 'groq', makeOpts(['fr', 'de', 'es']), deps);

    expect(deps.sideEffects.broadcastSubtitle).toHaveBeenCalledTimes(3);
    expect(deps.sideEffects.broadcastDubAudio).toHaveBeenCalledTimes(3);
    // All three completed
    expect(order).toHaveLength(3);
  });
});
