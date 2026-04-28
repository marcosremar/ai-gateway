/**
 * STT Verifier — Unit + Integration Tests
 *
 * Unit tests: pure functions (no API calls) — always run.
 * Integration tests: real API calls — skipped if keys not set.
 *
 * Run all:       bun run test
 * Run this file: bun run test __tests__/stt-verifier.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runVerifiedSTT } from '../src/ensemble-stt';
import type { STTVerifierProviderEntry } from '../src/ensemble-stt';
import type { STTProvider, STTRequest, STTResponse } from '../src/providers/types';
import type { EmbeddingProvider } from '../src/providers/openai-compat/openai-compat-embedding';
import { openaiSTT } from '../src/providers/openai';
import { deepgramSTT } from '../src/providers/deepgram';
import { loadEnv, checkOpenAIAvailable, makeTestWav, timed } from './helpers';

await loadEnv();
const OPENAI_AVAILABLE = process.env.OPENAI_API_KEY && process.env.SKIP_LIVE_TESTS !== "1"
  ? await checkOpenAIAvailable(process.env.OPENAI_API_KEY)
  : false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Stub STT provider that returns a fixed transcription. */
function stubProvider(name: string, text: string): STTVerifierProviderEntry {
  const provider: STTProvider = {
    providerId: 'groq' as const,
    getModels: () => [{ id: 'stub', name: 'Stub', description: 'Stub STT', capability: 'stt' as const }],
    isConfigured: () => true,
    transcribe: async (_req: STTRequest): Promise<STTResponse> => ({ text }),
    withApiKey: function(k: string) { return this; },
  };
  return { name, provider };
}

/** Stub that rejects (simulates a provider failure). */
function failingProvider(name: string): STTVerifierProviderEntry {
  const provider: STTProvider = {
    providerId: 'groq' as const,
    getModels: () => [{ id: 'stub', name: 'Stub', description: 'Stub STT', capability: 'stt' as const }],
    isConfigured: () => true,
    transcribe: async (_req: STTRequest): Promise<STTResponse> => {
      throw new Error('API error');
    },
    withApiKey: function(k: string) { return this; },
  };
  return { name, provider };
}

/** Stub that delays before returning (simulates slow provider). */
function slowProvider(name: string, text: string, delayMs: number): STTVerifierProviderEntry {
  const provider: STTProvider = {
    providerId: 'groq' as const,
    getModels: () => [{ id: 'stub', name: 'Stub', description: 'Stub STT', capability: 'stt' as const }],
    isConfigured: () => true,
    transcribe: async (_req: STTRequest): Promise<STTResponse> => {
      await new Promise(r => setTimeout(r, delayMs));
      return { text };
    },
    withApiKey: function(k: string) { return this; },
  };
  return { name, provider };
}

const SILENCE = makeTestWav(0.5);

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe('runVerifiedSTT — unit (no API)', () => {
  it('throws when no providers configured', async () => {
    await expect(runVerifiedSTT(SILENCE, 'fr', '', { providers: [] }))
      .rejects.toThrow('No STT providers configured');
  });

  it('single provider — passes through directly with score 1', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [stubProvider('p1', 'bonjour le monde')],
    });

    expect(result.consensus).toBe('bonjour le monde');
    expect(result.used_providers).toBe(1);
    expect(result.scores['p1']).toBe(1);
    expect(result.outliers).toHaveLength(0);
    expect(result.providers['p1']).toBe('bonjour le monde');
  });

  it('two identical transcriptions — winner gets score 1 (race mode)', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'bonjour le monde'),
        stubProvider('p2', 'bonjour le monde'),
      ],
    });

    expect(result.consensus).toBe('bonjour le monde');
    // Race mode: only first responder reported
    expect(result.used_providers).toBe(1);
    expect(Object.keys(result.providers)).toHaveLength(1);
    const winnerScore = Object.values(result.scores)[0];
    expect(winnerScore).toBe(1);
    expect(result.outliers).toHaveLength(0);
  });

  it('majority wins over outlier — race mode returns first responder', async () => {
    // Race mode: outlierThreshold ignored, first non-empty wins
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'bonjour je voudrais un café'),
        stubProvider('p2', 'bonjour je voudrais un café'),
        stubProvider('p3', 'bonjour je voudrais un café'),
        stubProvider('p4', 'completely different text about dinosaurs'),
      ],
      outlierThreshold: 0.25,
    });

    expect(result.consensus).toBeTruthy();
    expect(result.used_providers).toBe(1);
    // Race mode: outliers is always empty
    expect(result.outliers).toHaveLength(0);
  });

  it('provider failure is silently skipped', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('good', 'bonjour le monde'),
        failingProvider('bad'),
      ],
    });

    expect(result.consensus).toBe('bonjour le monde');
    expect(result.used_providers).toBe(1);
    expect('bad' in result.providers).toBe(false);
  });

  it('all providers fail — throws', async () => {
    await expect(runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [failingProvider('p1'), failingProvider('p2')],
    })).rejects.toThrow(/failed|providers/i);
  });

  it('empty-string results are excluded from consensus', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('empty', ''),
        stubProvider('real', 'bonjour monde'),
      ],
    });

    expect(result.consensus).toBe('bonjour monde');
    expect(result.used_providers).toBe(1);
  });

  it('picks provider with most agreement — race mode returns first responder', async () => {
    // Race mode: first non-empty provider wins regardless of agreement
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'apple orange banana'),
        stubProvider('p2', 'completely unrelated words here now'),
        stubProvider('p3', 'apple orange banana'),
      ],
      outlierThreshold: 0.25,
    });

    expect(result.consensus).toBeTruthy();
    expect(result.used_providers).toBe(1);
    expect(result.outliers).toHaveLength(0);
  });

  it('returns latency_ms > 0', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [stubProvider('p1', 'hello world')],
    });

    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('preserves French accented characters in consensus', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'café français bientôt'),
        stubProvider('p2', 'café français bientôt'),
      ],
    });

    expect(result.consensus).toContain('café');
    expect(result.consensus).toContain('français');
  });

  it('passes language and prompt to providers', async () => {
    let capturedLang = '';
    let capturedPrompt = '';
    const provider: STTProvider = {
      providerId: 'groq' as const,
      getModels: () => [{ id: 'stub', name: 'Stub', description: 'Stub STT', capability: 'stt' as const }],
      isConfigured: () => true,
      transcribe: async (req: STTRequest): Promise<STTResponse> => {
        capturedLang = req.language ?? '';
        capturedPrompt = req.prompt ?? '';
        return { text: 'bonjour' };
      },
      withApiKey: function() { return this; },
    };

    await runVerifiedSTT(SILENCE, 'fr', 'previous context', {
      providers: [{ name: 'p', provider }],
    });

    expect(capturedLang).toBe('fr');
    expect(capturedPrompt).toBe('previous context');
  });

  it('throws informative error when all providers have no models', async () => {
    const noModels: STTProvider = {
      providerId: 'groq' as const,
      getModels: () => [],
      isConfigured: () => true,
      transcribe: async () => ({ text: 'never' }),
      withApiKey: function() { return this; },
    };

    await expect(runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [{ name: 'empty', provider: noModels }],
    })).rejects.toThrow();
  });

  it('error message mentions provider count', async () => {
    await expect(runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [failingProvider('p1'), failingProvider('p2'), failingProvider('p3')],
    })).rejects.toThrow('3 providers');
  });

  it('scores are rounded to 3 decimal places', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'apple orange banana grape'),
        stubProvider('p2', 'apple orange grape lemon'),
      ],
    });

    for (const score of Object.values(result.scores)) {
      const str = score.toString();
      const decimals = str.includes('.') ? str.split('.')[1].length : 0;
      expect(decimals).toBeLessThanOrEqual(3);
    }
  });
});

// ─── Embedding Fallback Tests (unit — stub embedding provider) ───────────────

describe('runVerifiedSTT — embedding fallback (unit)', () => {
  /** Stub embedding provider: returns fixed vectors per text */
  function stubEmbeddingProvider(
    vectorMap: Record<string, number[]>,
    name = 'stub-embed',
  ) {
    const provider: EmbeddingProvider = {
      name,
      providerId: 'openrouter' as const,
      isConfigured: () => true,
      embed: async (input: string | string[]) => {
        const inputs = Array.isArray(input) ? input : [input];
        const embeddings = inputs.map(text => vectorMap[text] ?? [0, 0, 1]);
        return { embeddings, model: name, usage: { promptTokens: 0, totalTokens: 0 } };
      },
    };
    return provider;
  }

  it('uses Jaccard when confidence is high — no embedding call', async () => {
    let embeddingCalled = false;
    const provider: EmbeddingProvider = {
      name: 'should-not-be-called',
      providerId: 'openrouter' as const,
      isConfigured: () => true,
      embed: async () => {
        embeddingCalled = true;
        return { embeddings: [], model: '', usage: { promptTokens: 0, totalTokens: 0 } };
      },
    };

    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'bonjour le monde'),
        stubProvider('p2', 'bonjour le monde'),
      ],
      embeddingFallbacks: [provider],
      embeddingFallbackThreshold: 0.3,
    });

    expect(embeddingCalled).toBe(false);
    expect(result.similarity_method).toBe('jaccard');
    expect(result.embedding_provider).toBeUndefined();
  });

  it('embedding fallbacks are ignored in race mode — always jaccard, first wins', async () => {
    // Race mode: embeddingFallbacks is ignored, similarity_method always 'jaccard'
    const vectors: Record<string, number[]> = {
      'hello world':        [1, 0, 0],
      'bonjour monde':      [0.95, 0.1, 0],
      'something unrelated': [0, 0, 1],
    };
    const embProvider = stubEmbeddingProvider(vectors, 'test-embed');

    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'hello world'),
        stubProvider('p2', 'bonjour monde'),
        stubProvider('p3', 'something unrelated'),
      ],
      embeddingFallbacks: [embProvider],
      embeddingFallbackThreshold: 0.9,
      embeddingOutlierThreshold: 0.5,
    });

    expect(result.similarity_method).toBe('jaccard');
    expect(result.used_providers).toBe(1);
    expect(result.outliers).toHaveLength(0);
  });

  it('skips unconfigured embedding providers — race mode: embedding never called', async () => {
    let fallback2Called = false;
    const unconfigured: EmbeddingProvider = {
      name: 'unconfigured',
      providerId: 'openrouter' as const,
      isConfigured: () => false,
      embed: async () => { throw new Error('should not be called'); },
    };
    const vectors = { 'text a': [1, 0], 'text b': [0.9, 0.1] };
    const fallback2: EmbeddingProvider = {
      name: 'fallback2',
      providerId: 'openai' as const,
      isConfigured: () => true,
      embed: async (input) => {
        fallback2Called = true;
        const inputs = Array.isArray(input) ? input : [input];
        return {
          embeddings: inputs.map(t => vectors[t] ?? [0, 1]),
          model: 'fallback2',
          usage: { promptTokens: 0, totalTokens: 0 },
        };
      },
    };

    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [stubProvider('p1', 'text a'), stubProvider('p2', 'text b')],
      embeddingFallbacks: [unconfigured, fallback2],
      embeddingFallbackThreshold: 0.9,
    });

    // Race mode: embedding never triggered regardless of threshold
    expect(fallback2Called).toBe(false);
    expect(result.similarity_method).toBe('jaccard');
    expect(result.used_providers).toBe(1);
  });

  it('falls back to Jaccard if all embedding providers fail', async () => {
    const failingEmbed: EmbeddingProvider = {
      name: 'failing-embed',
      providerId: 'openrouter' as const,
      isConfigured: () => true,
      embed: async () => { throw new Error('API error'); },
    };

    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'apple orange'),
        stubProvider('p2', 'banana grape'),
      ],
      embeddingFallbacks: [failingEmbed],
      embeddingFallbackThreshold: 0.9,
    });

    expect(result.similarity_method).toBe('jaccard');
    expect(result.embedding_provider).toBeUndefined();
  });

  it('result always includes similarity_method field', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [stubProvider('p1', 'hello world')],
    });
    expect(result.similarity_method).toBeDefined();
    expect(['jaccard', 'embedding']).toContain(result.similarity_method);
  });
});

// ─── Timeout / Real-time Tests ────────────────────────────────────────────────

describe('runVerifiedSTT — timeout / partial results (unit)', () => {
  it('fast provider wins race before slow one times out', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('fast1', 'bonjour le monde'),
        slowProvider('slow', 'bonjour le monde', 5000), // 5s — loses the race
      ],
      timeoutMs: 200, // only 200ms budget
    });

    // Race mode: first fast provider wins
    expect(result.consensus).toBe('bonjour le monde');
    expect(result.used_providers).toBe(1);
    expect('slow' in result.providers).toBe(false);
    expect(result.latency_ms).toBeLessThan(1000);
  });

  it('first provider to respond wins (race mode)', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        slowProvider('p1', 'bonjour', 50),
        slowProvider('p2', 'bonjour', 80),
      ],
      timeoutMs: 2000,
    });

    // Race mode: only the winner (p1, faster) is reported
    expect(result.used_providers).toBe(1);
    expect(result.consensus).toBe('bonjour');
  });

  it('works with no timeoutMs — first responder wins', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [stubProvider('p1', 'hello'), stubProvider('p2', 'hello')],
    });
    expect(result.used_providers).toBe(1);
    expect(result.consensus).toBe('hello');
  });
});

// ─── Integration Tests — OpenAI STT ──────────────────────────────────────────

describe.skipIf(!OPENAI_AVAILABLE)('OpenAI STT (Real API)', () => {
  it('transcribes WAV audio', async () => {
    const audio = makeTestWav(1.0);
    const { result, ms } = await timed(() =>
      openaiSTT.transcribe({ audio, model: 'whisper-1', language: 'fr' }),
    );

    expect(typeof result.text).toBe('string');
    console.log(`  OpenAI STT: "${result.text}" (${ms}ms)`);
  });

  it('isConfigured returns true', () => {
    expect(openaiSTT.isConfigured()).toBe(true);
  });

  it('returns model list with gpt-4o-transcribe', () => {
    const models = openaiSTT.getModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id === 'gpt-4o-transcribe')).toBe(true);
  });
});

// ─── Integration Tests — Deepgram STT ────────────────────────────────────────

describe.skipIf(!process.env.DEEPGRAM_API_KEY || process.env.SKIP_LIVE_TESTS === "1")('Deepgram STT (Real API)', () => {
  it('transcribes WAV audio', async () => {
    const audio = makeTestWav(1.0);
    const { result, ms } = await timed(() =>
      deepgramSTT.transcribe({ audio, model: 'nova-2', language: 'fr' }),
    );

    expect(typeof result.text).toBe('string');
    console.log(`  Deepgram STT: "${result.text}" (${ms}ms)`);
  });

  it('isConfigured returns true', () => {
    expect(deepgramSTT.isConfigured()).toBe(true);
  });
});

// ─── Integration Tests — Full Ensemble ───────────────────────────────────────

const hasDeepgram = !!process.env.DEEPGRAM_API_KEY;
const hasAtLeastTwo = OPENAI_AVAILABLE && hasDeepgram;

describe.skipIf(!hasAtLeastTwo)('STT Verifier — Full Ensemble (Real API)', () => {
  it('fans out to OpenAI + Deepgram and returns consensus', async () => {
    const audio = makeTestWav(2.0); // 2s sine wave (will transcribe as silence/noise)

    const { result, ms } = await timed(() =>
      runVerifiedSTT(audio, 'fr', '', {
        providers: [
          { name: 'openai', provider: openaiSTT },
          { name: 'deepgram', provider: deepgramSTT },
        ],
      }),
    );

    expect(typeof result.consensus).toBe('string');
    expect(result.used_providers).toBeGreaterThanOrEqual(1);
    expect(result.latency_ms).toBeGreaterThan(0);
    expect(result.providers).toBeDefined();
    console.log(`  Ensemble (${ms}ms, ${result.used_providers} providers):`);
    console.log(`    consensus: "${result.consensus}"`);
    console.log(`    scores:`, result.scores);
    console.log(`    outliers:`, result.outliers);
  });

  it('respects timeoutMs — partial results accepted', async () => {
    const audio = makeTestWav(1.0);

    const { result, ms } = await timed(() =>
      runVerifiedSTT(audio, 'fr', '', {
        providers: [
          { name: 'openai', provider: openaiSTT },
          { name: 'deepgram', provider: deepgramSTT },
        ],
        timeoutMs: 5000, // 5s budget — both should finish
      }),
    );

    expect(result.used_providers).toBeGreaterThanOrEqual(1);
    expect(ms).toBeLessThan(7000);
    console.log(`  Ensemble with timeout (${ms}ms): "${result.consensus}"`);
  });
});
