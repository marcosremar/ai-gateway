/**
 * Unit tests for src/stt-race.ts
 *
 * Covers: input validation, fan-out race, empty-text rejection, provider
 * with no models, timeout, abort propagation, winner metadata, all-fail path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sttRace } from '../src/stt-race';
import type { STTRaceProvider } from '../src/stt-race';
import type { STTProvider, STTResponse } from '../src/providers/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const AUDIO = Buffer.from('fake-audio-data');

function makeProvider(
  text: string,
  name = 'provider',
  extra: Partial<STTResponse> = {},
  delayMs = 0,
): STTRaceProvider {
  return {
    name,
    provider: {
      providerId: 'mock-stt',
      isConfigured: () => true,
      getModels: () => [{ id: 'whisper-1', name: 'Whisper', description: '', capability: 'stt' }],
      transcribe: vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
        if (delayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, delayMs);
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          });
        }
        return { text, provider: name, ...extra };
      }),
    } as unknown as STTProvider,
  };
}

function makeFailingProvider(name = 'bad', delayMs = 0): STTRaceProvider {
  return {
    name,
    provider: {
      providerId: 'mock-stt',
      isConfigured: () => true,
      getModels: () => [{ id: 'whisper-1', name: 'Whisper', description: '', capability: 'stt' }],
      transcribe: vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
        if (delayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, delayMs);
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          });
        }
        throw new Error(`${name}: API error`);
      }),
    } as unknown as STTProvider,
  };
}

function makeNoModelProvider(name = 'no-models'): STTRaceProvider {
  return {
    name,
    provider: {
      providerId: 'mock-stt',
      isConfigured: () => true,
      getModels: () => [],
      transcribe: vi.fn(async () => ({ text: 'should not reach', provider: name })),
    } as unknown as STTProvider,
  };
}

function makeEmptyTextProvider(name = 'empty', delayMs = 0): STTRaceProvider {
  return {
    name,
    provider: {
      providerId: 'mock-stt',
      isConfigured: () => true,
      getModels: () => [{ id: 'whisper-1', name: 'Whisper', description: '', capability: 'stt' }],
      transcribe: vi.fn(async () => {
        if (delayMs > 0) await new Promise<void>((r) => setTimeout(r, delayMs));
        return { text: '   ', provider: name }; // whitespace only
      }),
    } as unknown as STTProvider,
  };
}

// ── Input validation ───────────────────────────────────────────────────────────

describe('sttRace — input validation', () => {
  it('throws when providers array is empty', async () => {
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [] }),
    ).rejects.toThrow('No STT providers configured');
  });

  it('throws when audio exceeds maxAudioSizeBytes', async () => {
    const p = makeProvider('hello', 'groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p], maxAudioSizeBytes: 1 }),
    ).rejects.toThrow('Audio too large');
  });

  it('throws when maxAudioSizeBytes is zero', async () => {
    const p = makeProvider('hello', 'groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p], maxAudioSizeBytes: 0 }),
    ).rejects.toThrow('maxAudioSizeBytes must be positive');
  });

  it('throws when maxAudioSizeBytes is negative', async () => {
    const p = makeProvider('hello', 'groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p], maxAudioSizeBytes: -10 }),
    ).rejects.toThrow('maxAudioSizeBytes must be positive');
  });

  it('throws when maxAudioSizeBytes is Infinity', async () => {
    const p = makeProvider('hello', 'groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p], maxAudioSizeBytes: Infinity }),
    ).rejects.toThrow('maxAudioSizeBytes must be positive');
  });

  it('throws when maxAudioSizeBytes is NaN', async () => {
    const p = makeProvider('hello', 'groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p], maxAudioSizeBytes: NaN }),
    ).rejects.toThrow('maxAudioSizeBytes must be positive');
  });

  it('throws when timeoutMs is zero', async () => {
    const p = makeProvider('hello', 'groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p], timeoutMs: 0 }),
    ).rejects.toThrow('timeoutMs must be positive');
  });

  it('throws when timeoutMs is negative', async () => {
    const p = makeProvider('hello', 'groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p], timeoutMs: -1 }),
    ).rejects.toThrow('timeoutMs must be positive');
  });

  it('throws when timeoutMs is Infinity', async () => {
    const p = makeProvider('hello', 'groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p], timeoutMs: Infinity }),
    ).rejects.toThrow('timeoutMs must be positive');
  });

  it('throws when timeoutMs is NaN', async () => {
    const p = makeProvider('hello', 'groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p], timeoutMs: NaN }),
    ).rejects.toThrow('timeoutMs must be positive');
  });
});

// ── Single provider ───────────────────────────────────────────────────────────

describe('sttRace — single provider', () => {
  it('returns transcription text from single provider', async () => {
    const p = makeProvider('hello world', 'groq');
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(result.text).toBe('hello world');
    expect(result.provider).toBe('groq');
  });

  it('includes latencyMs in result', async () => {
    const p = makeProvider('hello', 'groq');
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passes language and prompt to transcribe()', async () => {
    const p = makeProvider('hello', 'groq');
    const result = await sttRace(AUDIO, 'es', 'glossary terms', { providers: [p] });
    expect(result.text).toBe('hello');
    // Verify call args
    expect(p.provider.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'es',
        prompt: 'glossary terms',
        audio: AUDIO,
        model: 'whisper-1',
      }),
    );
  });

  it('throws when single provider fails', async () => {
    const p = makeFailingProvider('groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p] }),
    ).rejects.toThrow('All 1 provider(s) failed or timed out');
  });

  it('throws when single provider has no models', async () => {
    const p = makeNoModelProvider('groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p] }),
    ).rejects.toThrow('All 1 provider(s) failed or timed out');
  });

  it('throws when single provider returns empty text', async () => {
    const p = makeEmptyTextProvider('groq');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p] }),
    ).rejects.toThrow('All 1 provider(s) failed or timed out');
  });
});

// ── Multi-provider race ────────────────────────────────────────────────────────

describe('sttRace — multi-provider race', () => {
  it('returns first provider that responds', async () => {
    const fast = makeProvider('fast result', 'groq', {}, 0);
    const slow = makeProvider('slow result', 'openai', {}, 50);
    const result = await sttRace(AUDIO, 'en', '', { providers: [fast, slow] });
    expect(result.text).toBe('fast result');
    expect(result.provider).toBe('groq');
  });

  it('returns second provider when first fails', async () => {
    const failing = makeFailingProvider('groq');
    const working = makeProvider('fallback result', 'openai');
    const result = await sttRace(AUDIO, 'en', '', { providers: [failing, working] });
    expect(result.text).toBe('fallback result');
    expect(result.provider).toBe('openai');
  });

  it('returns third provider when first two fail', async () => {
    const p1 = makeFailingProvider('groq');
    const p2 = makeFailingProvider('openai');
    const p3 = makeProvider('last resort', 'deepgram');
    const result = await sttRace(AUDIO, 'en', '', { providers: [p1, p2, p3] });
    expect(result.text).toBe('last resort');
    expect(result.provider).toBe('deepgram');
  });

  it('throws when all providers fail', async () => {
    const p1 = makeFailingProvider('groq');
    const p2 = makeFailingProvider('openai');
    const p3 = makeFailingProvider('deepgram');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p1, p2, p3] }),
    ).rejects.toThrow('All 3 provider(s) failed or timed out');
  });

  it('skips provider with no models and uses next', async () => {
    const noModels = makeNoModelProvider('groq');
    const working = makeProvider('from openai', 'openai');
    const result = await sttRace(AUDIO, 'en', '', { providers: [noModels, working] });
    expect(result.text).toBe('from openai');
    expect(result.provider).toBe('openai');
  });

  it('skips providers returning only whitespace', async () => {
    const empty = makeEmptyTextProvider('groq');
    const working = makeProvider('real transcript', 'openai');
    const result = await sttRace(AUDIO, 'en', '', { providers: [empty, working] });
    expect(result.text).toBe('real transcript');
  });

  it('all whitespace-only providers → throws', async () => {
    const p1 = makeEmptyTextProvider('groq');
    const p2 = makeEmptyTextProvider('openai');
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p1, p2] }),
    ).rejects.toThrow('All 2 provider(s) failed or timed out');
  });
});

// ── Metadata propagation ──────────────────────────────────────────────────────

describe('sttRace — metadata propagation', () => {
  it('includes segments when provider returns them', async () => {
    const segments = [
      {
        id: 0, start: 0, end: 1.5, text: 'hello',
        avg_logprob: -0.2, compression_ratio: 1.1, no_speech_prob: 0.05,
      },
    ];
    const p = makeProvider('hello', 'groq', { segments });
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(result.segments).toEqual(segments);
  });

  it('omits segments when provider does not return them', async () => {
    const p = makeProvider('hello', 'groq');
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(result.segments).toBeUndefined();
  });

  it('propagates avgLogprob from provider', async () => {
    const p = makeProvider('hello', 'groq', { avg_logprob: -0.35 });
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(result.avgLogprob).toBe(-0.35);
  });

  it('propagates compressionRatio from provider', async () => {
    const p = makeProvider('hello', 'groq', { compression_ratio: 1.8 });
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(result.compressionRatio).toBe(1.8);
  });

  it('propagates noSpeechProb from provider', async () => {
    const p = makeProvider('hello', 'groq', { no_speech_prob: 0.15 });
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(result.noSpeechProb).toBe(0.15);
  });

  it('omits avgLogprob when not returned', async () => {
    const p = makeProvider('hello', 'groq');
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(result.avgLogprob).toBeUndefined();
  });

  it('omits compressionRatio when not returned', async () => {
    const p = makeProvider('hello', 'groq');
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(result.compressionRatio).toBeUndefined();
  });

  it('omits noSpeechProb when not returned', async () => {
    const p = makeProvider('hello', 'groq');
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(result.noSpeechProb).toBeUndefined();
  });

  it('propagates all metadata fields together', async () => {
    const p = makeProvider('hello world', 'groq', {
      avg_logprob: -0.25,
      compression_ratio: 1.3,
      no_speech_prob: 0.08,
    });
    const result = await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(result.avgLogprob).toBe(-0.25);
    expect(result.compressionRatio).toBe(1.3);
    expect(result.noSpeechProb).toBe(0.08);
  });
});

// ── Timeout ───────────────────────────────────────────────────────────────────

describe('sttRace — timeout', () => {
  it('throws when single provider times out', async () => {
    const slow = makeProvider('late result', 'groq', {}, 200);
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [slow], timeoutMs: 20 }),
    ).rejects.toThrow('All 1 provider(s) failed or timed out');
  }, 2000);

  it('uses fallback provider when primary times out', async () => {
    const slow = makeProvider('late', 'groq', {}, 200);
    const fast = makeProvider('quick', 'openai', {}, 0);
    const result = await sttRace(AUDIO, 'en', '', {
      providers: [slow, fast],
      timeoutMs: 50,
    });
    expect(result.text).toBe('quick');
    expect(result.provider).toBe('openai');
  }, 2000);

  it('throws when all providers time out', async () => {
    const p1 = makeProvider('late1', 'groq', {}, 200);
    const p2 = makeProvider('late2', 'openai', {}, 200);
    await expect(
      sttRace(AUDIO, 'en', '', { providers: [p1, p2], timeoutMs: 20 }),
    ).rejects.toThrow('All 2 provider(s) failed or timed out');
  }, 2000);
});

// ── Abort propagation ─────────────────────────────────────────────────────────

describe('sttRace — abort propagation', () => {
  it('passes AbortSignal to all providers', async () => {
    const p1 = makeProvider('hello', 'groq');
    const p2 = makeProvider('world', 'openai', {}, 100);
    await sttRace(AUDIO, 'en', '', { providers: [p1, p2] });
    // Both transcribe calls received a signal
    expect(p1.provider.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(p2.provider.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

// ── Default maxAudioSizeBytes ─────────────────────────────────────────────────

describe('sttRace — defaults', () => {
  it('accepts audio up to default 100 MB limit', async () => {
    const smallAudio = Buffer.alloc(1024); // 1 KB — well within limit
    const p = makeProvider('transcript', 'groq');
    const result = await sttRace(smallAudio, 'en', '', { providers: [p] });
    expect(result.text).toBe('transcript');
  });

  it('uses first model from provider model list', async () => {
    const p = makeProvider('result', 'groq');
    await sttRace(AUDIO, 'en', '', { providers: [p] });
    expect(p.provider.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'whisper-1' }),
    );
  });
});
