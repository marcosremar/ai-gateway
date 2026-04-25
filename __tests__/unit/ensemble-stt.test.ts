/**
 * Tests for src/ensemble-stt.ts (runVerifiedSTT / runEnsembleSTT)
 * Covers: single provider, multi-provider Jaccard consensus, embedding fallback,
 * timeout, failure modes, outlier detection, metadata propagation.
 */
import { describe, it, expect, vi } from 'vitest';
import { runVerifiedSTT, runEnsembleSTT } from '../../src/ensemble-stt';
import type { STTVerifierDeps } from '../../src/ensemble-stt';
import type { STTProvider, STTResponse } from '../../src/providers/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(text: string, name = 'provider', extra: Partial<STTResponse> = {}): { name: string; provider: STTProvider } {
  return {
    name,
    provider: {
      getModels: () => [{ id: 'model-1', name: 'Model 1' }],
      transcribe: vi.fn(async () => ({ text, provider: name, ...extra })),
    } as unknown as STTProvider,
  };
}

function makeFailingProvider(name = 'bad'): { name: string; provider: STTProvider } {
  return {
    name,
    provider: {
      getModels: () => [{ id: 'model-1', name: 'Model 1' }],
      transcribe: vi.fn(async () => { throw new Error('API error'); }),
    } as unknown as STTProvider,
  };
}

function makeSlowProvider(name = 'slow', delayMs = 5000): { name: string; provider: STTProvider } {
  return {
    name,
    provider: {
      getModels: () => [{ id: 'model-1', name: 'Model 1' }],
      transcribe: vi.fn(async () => {
        await new Promise(r => setTimeout(r, delayMs));
        return { text: 'slow result', provider: name };
      }),
    } as unknown as STTProvider,
  };
}

const AUDIO = Buffer.from('fake-audio');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runVerifiedSTT', () => {
  describe('no providers', () => {
    it('throws when providers array is empty', async () => {
      const deps: STTVerifierDeps = { providers: [] };
      await expect(runVerifiedSTT(AUDIO, 'en', '', deps)).rejects.toThrow('No STT providers configured');
    });
  });

  describe('single provider', () => {
    it('returns consensus from single provider', async () => {
      const p = makeProvider('hello world', 'groq');
      const result = await runVerifiedSTT(AUDIO, 'en', '', { providers: [p] });
      expect(result.consensus).toBe('hello world');
      expect(result.similarity_method).toBe('jaccard');
      expect(result.used_providers).toBe(1);
      expect(result.providers).toEqual({ groq: 'hello world' });
      expect(result.scores.groq).toBe(1);
    });

    it('reports latency_ms', async () => {
      const p = makeProvider('test', 'p1');
      const result = await runVerifiedSTT(AUDIO, 'en', '', { providers: [p] });
      expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    });

    it('propagates segments from provider', async () => {
      const segs = [{ id: 0, start: 0, end: 1, text: 'hello', no_speech_prob: 0.1, compression_ratio: 1.2, avg_logprob: -0.3 }];
      const p = makeProvider('hello', 'groq', { segments: segs });
      const result = await runVerifiedSTT(AUDIO, 'en', '', { providers: [p] });
      expect(result.segments).toEqual(segs);
    });

    it('propagates avg_logprob from provider', async () => {
      const p = makeProvider('hello', 'groq', { avg_logprob: -0.4 });
      const result = await runVerifiedSTT(AUDIO, 'en', '', { providers: [p] });
      expect(result.avg_logprob).toBe(-0.4);
    });
  });

  describe('multiple providers — race mode', () => {
    it('returns the first provider to respond', async () => {
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('hello world today', 'p1'),
          makeProvider('hello world today', 'p2'),
          makeProvider('completely different text', 'p3'),
        ],
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      // First to respond wins — used_providers is always 1
      expect(result.consensus).toBeTruthy();
      expect(result.similarity_method).toBe('jaccard');
      expect(result.used_providers).toBe(1);
    });

    it('outliers is always empty in race mode', async () => {
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('the quick brown fox', 'p1'),
          makeProvider('the quick brown fox jumps', 'p2'),
          makeProvider('completely unrelated', 'p3'),
        ],
        outlierThreshold: 0.3,
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      expect(result.outliers).toEqual([]);
    });

    it('providers map contains only the winner', async () => {
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('text one', 'p1'),
          makeProvider('text two', 'p2'),
        ],
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      expect(Object.keys(result.providers)).toHaveLength(1);
      expect(result.used_providers).toBe(1);
    });

    it('scores sum to values between 0 and 1', async () => {
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('hello world', 'p1'),
          makeProvider('hello world', 'p2'),
          makeProvider('hello world', 'p3'),
        ],
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      for (const score of Object.values(result.scores)) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('provider failures', () => {
    it('throws when all providers fail', async () => {
      const deps: STTVerifierDeps = {
        providers: [makeFailingProvider('p1'), makeFailingProvider('p2')],
      };
      await expect(runVerifiedSTT(AUDIO, 'en', '', deps)).rejects.toThrow('All 2 providers failed');
    });

    it('continues with remaining providers when one fails', async () => {
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('good result', 'p1'),
          makeFailingProvider('p2'),
        ],
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      expect(result.consensus).toBe('good result');
      expect(result.used_providers).toBe(1);
    });

    it('skips providers with empty transcription', async () => {
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('', 'empty-provider'),
          makeProvider('real text', 'real-provider'),
        ],
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      expect(result.consensus).toBe('real text');
      expect(result.providers).not.toHaveProperty('empty-provider');
    });
  });

  describe('timeout', () => {
    it('drops slow providers after timeout', async () => {
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('fast result', 'fast'),
          makeSlowProvider('slow', 5000),
        ],
        timeoutMs: 50,
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      expect(result.consensus).toBe('fast result');
      expect(result.providers).toHaveProperty('fast');
      expect(result.providers).not.toHaveProperty('slow');
    });
  });

  describe('embedding fallback', () => {
    it('embeddingFallbacks is ignored — always returns jaccard (first wins)', async () => {
      const mockEmbProvider = {
        name: 'test-embed',
        providerId: 'openai',
        isConfigured: () => true,
        embed: vi.fn(),
      };

      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('bonjour le monde', 'p1'),
          makeProvider('hello the world', 'p2'),
        ],
        embeddingFallbacks: [mockEmbProvider as any],
        embeddingFallbackThreshold: 0.99,
      };
      const result = await runVerifiedSTT(AUDIO, 'fr', '', deps);
      // Race mode: always jaccard, embedding not used
      expect(result.similarity_method).toBe('jaccard');
      expect(result.used_providers).toBe(1);
      expect(mockEmbProvider.embed).not.toHaveBeenCalled();
    });

    it('falls back to Jaccard when embedding provider not configured', async () => {
      const unconfiguredEmbed = {
        name: 'unconfigured',
        providerId: 'openai',
        isConfigured: () => false,
        embed: vi.fn(),
      };

      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('hello world', 'p1'),
          makeProvider('hi there', 'p2'),
        ],
        embeddingFallbacks: [unconfiguredEmbed as any],
        embeddingFallbackThreshold: 0.99,
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      // Falls back to Jaccard since embedding not configured
      expect(result.similarity_method).toBe('jaccard');
    });

    it('falls back to Jaccard when embedding throws', async () => {
      const failingEmbed = {
        name: 'failing-embed',
        providerId: 'openai',
        isConfigured: () => true,
        embed: vi.fn(async () => { throw new Error('embedding API down'); }),
      };

      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('hello world', 'p1'),
          makeProvider('hi there friend', 'p2'),
        ],
        embeddingFallbacks: [failingEmbed as any],
        embeddingFallbackThreshold: 0.99,
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      expect(result.similarity_method).toBe('jaccard');
    });
  });

  describe('race winner score', () => {
    it('winner always gets score of 1', async () => {
      const text = 'the quick brown fox';
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider(text, 'p1'),
          makeProvider(text, 'p2'),
        ],
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      // Only winner in scores, always 1
      const scores = Object.values(result.scores);
      expect(scores).toHaveLength(1);
      expect(scores[0]).toBe(1);
    });

    it('completely different texts still picks best', async () => {
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('apple orange banana', 'p1'),
          makeProvider('dog cat mouse', 'p2'),
        ],
      };
      // They're completely different — both score 0, but still picks one
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      expect(result.consensus).toBeTruthy();
    });
  });

  describe('runEnsembleSTT alias', () => {
    it('is same function as runVerifiedSTT', () => {
      expect(runEnsembleSTT).toBe(runVerifiedSTT);
    });

    it('works the same way', async () => {
      const p = makeProvider('ensemble result', 'p1');
      const result = await runEnsembleSTT(AUDIO, 'en', '', { providers: [p] });
      expect(result.consensus).toBe('ensemble result');
    });
  });

  describe('edge cases', () => {
    it('handles whitespace-only transcription as empty', async () => {
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('   ', 'whitespace'),
          makeProvider('real text here', 'real'),
        ],
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      expect(result.consensus).toBe('real text here');
    });

    it('passes language and prompt to provider', async () => {
      const transcribeSpy = vi.fn(async () => ({ text: 'bonjour', provider: 'p1' }));
      const p = {
        name: 'p1',
        provider: {
          getModels: () => [{ id: 'model-1', name: 'M' }],
          transcribe: transcribeSpy,
        } as unknown as STTProvider,
      };
      await runVerifiedSTT(AUDIO, 'fr', 'system-prompt', { providers: [p] });
      expect(transcribeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'fr', prompt: 'system-prompt' }),
      );
    });

    it('provider with no models is rejected', async () => {
      const p = {
        name: 'no-models',
        provider: {
          getModels: () => [],
          transcribe: vi.fn(),
        } as unknown as STTProvider,
      };
      const deps: STTVerifierDeps = {
        providers: [p, makeProvider('fallback', 'good')],
      };
      // no-models fails (rejected), good succeeds
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      expect(result.consensus).toBe('fallback');
    });

    it('result has outliers as empty array when no outliers', async () => {
      const deps: STTVerifierDeps = {
        providers: [
          makeProvider('hello world', 'p1'),
          makeProvider('hello world', 'p2'),
        ],
      };
      const result = await runVerifiedSTT(AUDIO, 'en', '', deps);
      expect(result.outliers).toEqual([]);
    });
  });
});
