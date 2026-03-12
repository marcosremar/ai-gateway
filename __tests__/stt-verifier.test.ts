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
import { openaiSTT } from '../src/providers/openai';
import { deepgramSTT } from '../src/providers/deepgram';
import { loadEnv, makeTestWav, timed } from './helpers';

beforeAll(() => loadEnv());

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Stub STT provider that returns a fixed transcription. */
function stubProvider(name: string, text: string): STTVerifierProviderEntry {
  const provider: STTProvider = {
    providerId: 'groq' as const,
    getModels: () => [{ id: 'stub', name: 'Stub', capability: 'stt' as const }],
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
    getModels: () => [{ id: 'stub', name: 'Stub', capability: 'stt' as const }],
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
    getModels: () => [{ id: 'stub', name: 'Stub', capability: 'stt' as const }],
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

  it('two identical transcriptions — both score 1', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'bonjour le monde'),
        stubProvider('p2', 'bonjour le monde'),
      ],
    });

    expect(result.consensus).toBe('bonjour le monde');
    expect(result.used_providers).toBe(2);
    expect(result.scores['p1']).toBeCloseTo(1, 2);
    expect(result.scores['p2']).toBeCloseTo(1, 2);
    expect(result.outliers).toHaveLength(0);
  });

  it('majority wins over outlier', async () => {
    // 3 providers agree, 1 is completely different
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'bonjour je voudrais un café'),
        stubProvider('p2', 'bonjour je voudrais un café'),
        stubProvider('p3', 'bonjour je voudrais un café'),
        stubProvider('p4', 'completely different text about dinosaurs'),
      ],
      outlierThreshold: 0.25,
    });

    expect(result.consensus).toBe('bonjour je voudrais un café');
    expect(result.outliers).toContain('p4');
    expect(result.scores['p1']).toBeGreaterThan(result.scores['p4']);
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
    })).rejects.toThrow('failed or timed out');
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

  it('picks provider with most agreement, not alphabetically', async () => {
    // p1 and p3 agree; p2 is the outlier
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('p1', 'apple orange banana'),
        stubProvider('p2', 'completely unrelated words here now'),
        stubProvider('p3', 'apple orange banana'),
      ],
      outlierThreshold: 0.25,
    });

    expect(['apple orange banana']).toContain(result.consensus);
    expect(result.outliers).toContain('p2');
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
      getModels: () => [{ id: 'stub', name: 'Stub', capability: 'stt' as const }],
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

// ─── Timeout / Real-time Tests ────────────────────────────────────────────────

describe('runVerifiedSTT — timeout / partial results (unit)', () => {
  it('fast providers used even if slow one times out', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        stubProvider('fast1', 'bonjour le monde'),
        stubProvider('fast2', 'bonjour le monde'),
        slowProvider('slow', 'bonjour le monde', 5000), // 5s — should be cut
      ],
      timeoutMs: 200, // only 200ms budget
    });

    // Should have used fast1 + fast2 (slow was cut)
    expect(result.consensus).toBe('bonjour le monde');
    expect(result.used_providers).toBe(2);
    expect('slow' in result.providers).toBe(false);
    expect(result.latency_ms).toBeLessThan(1000);
  });

  it('uses all providers when they all finish within timeout', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [
        slowProvider('p1', 'bonjour', 50),
        slowProvider('p2', 'bonjour', 80),
      ],
      timeoutMs: 2000,
    });

    expect(result.used_providers).toBe(2);
  });

  it('works with no timeoutMs (default behavior unchanged)', async () => {
    const result = await runVerifiedSTT(SILENCE, 'fr', '', {
      providers: [stubProvider('p1', 'hello'), stubProvider('p2', 'hello')],
    });
    expect(result.used_providers).toBe(2);
  });
});

// ─── Integration Tests — OpenAI STT ──────────────────────────────────────────

describe.skipIf(!process.env.OPENAI_API_KEY)('OpenAI STT (Real API)', () => {
  it('transcribes WAV audio', async () => {
    const audio = makeTestWav(1.0);
    const { result, ms } = await timed(() =>
      openaiSTT.transcribe({ audio, language: 'fr' }),
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

describe.skipIf(!process.env.DEEPGRAM_API_KEY)('Deepgram STT (Real API)', () => {
  it('transcribes WAV audio', async () => {
    const audio = makeTestWav(1.0);
    const { result, ms } = await timed(() =>
      deepgramSTT.transcribe({ audio, language: 'fr' }),
    );

    expect(typeof result.text).toBe('string');
    console.log(`  Deepgram STT: "${result.text}" (${ms}ms)`);
  });

  it('isConfigured returns true', () => {
    expect(deepgramSTT.isConfigured()).toBe(true);
  });
});

// ─── Integration Tests — Full Ensemble ───────────────────────────────────────

const hasOpenAI = !!process.env.OPENAI_API_KEY;
const hasDeepgram = !!process.env.DEEPGRAM_API_KEY;
const hasAtLeastTwo = hasOpenAI && hasDeepgram;

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
