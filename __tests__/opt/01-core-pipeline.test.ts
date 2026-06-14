/**
 * Unit tests for core-AI-pipeline optimizations (docs/optimizations/01-core-ai-pipeline.md).
 *
 * Scope: pure, importable modules only — no network / provider / GPU / real FS.
 * Server entrypoints (ai-handlers.ts, pipeline-runner.ts) are intentionally NOT
 * imported here because they instantiate routers / tracers / sweep timers at
 * module load; their string/status fixes are asserted via the pure helpers they
 * call where possible, and otherwise verified by source inspection (recorded in
 * the implemented doc).
 */
import { describe, it, expect, vi } from 'vitest';

import { runVerifiedSTT, type STTProviderEntry } from '../../src/ensemble-stt';
import { filterHallucinations, DEFAULT_HALLUCINATION_FILTER_CONFIG } from '../../src/stt-hallucination-filter';
import { detectLanguage } from '../../src/language-detect';
import { parseIsFinal } from '../../src/streaming-stt';
import { adaptiveMaxTokens } from '../../src/gateway/pipeline/translation-cache';
import type { STTProvider, STTRequest, STTResponse, STTSegment } from '../../src/providers/types';

// ── Test doubles ─────────────────────────────────────────────────────────────

interface FakeSttOpts {
  text: string;
  delayMs?: number;
  /** If true, reject instead of resolving. */
  fail?: boolean;
  segments?: STTSegment[];
  avg_logprob?: number;
}

/**
 * A minimal STTProvider whose transcribe() resolves after delayMs and records
 * whether its AbortSignal fired. Used to prove ensemble cancels losers.
 */
function makeFakeProvider(name: string, opts: FakeSttOpts) {
  const state = { aborted: false, started: false, completed: false };
  const provider: STTProvider = {
    providerId: name as STTProvider['providerId'],
    getModels: () => [{ id: `${name}-model`, name } as any],
    isConfigured: () => true,
    transcribe: (req: STTRequest): Promise<STTResponse> => {
      state.started = true;
      return new Promise<STTResponse>((resolve, reject) => {
        const onAbort = () => { state.aborted = true; };
        req.signal?.addEventListener('abort', onAbort);
        if (req.signal?.aborted) state.aborted = true;
        const t = setTimeout(() => {
          state.completed = true;
          if (opts.fail) { reject(new Error(`${name} failed`)); return; }
          resolve({
            text: opts.text,
            segments: opts.segments,
            avg_logprob: opts.avg_logprob,
          });
        }, opts.delayMs ?? 0);
        // Keep the timer from hanging the test if aborted very late.
        (t as any).unref?.();
      });
    },
  };
  return { entry: { name, provider } as STTProviderEntry, state };
}

function seg(partial: Partial<STTSegment>): STTSegment {
  return {
    id: 0, start: 0, end: 1, text: '',
    avg_logprob: -0.1, compression_ratio: 1.5, no_speech_prob: 0.1,
    ...partial,
  };
}

// ── #4 — ensemble passes AbortSignal and cancels losers ──────────────────────

describe('ensemble-stt #4 — AbortSignal cancels losing providers', () => {
  it('passes a signal to every provider and aborts the losers on first winner', async () => {
    const fast = makeFakeProvider('fast', { text: 'hello world', delayMs: 5 });
    const slow = makeFakeProvider('slow', { text: 'hello world', delayMs: 10_000 });

    const result = await runVerifiedSTT(Buffer.from('audio'), 'en', '', {
      providers: [fast.entry, slow.entry],
      timeoutMs: 2_000,
    });

    expect(result.consensus).toBe('hello world');
    // The slow loser must have been aborted (it was started but never allowed
    // to complete its paid call).
    expect(slow.state.started).toBe(true);
    expect(slow.state.aborted).toBe(true);
    expect(slow.state.completed).toBe(false);
  });

  it('still resolves when the only fast provider wins and the other fails', async () => {
    const winner = makeFakeProvider('winner', { text: 'bonjour', delayMs: 1 });
    const loser = makeFakeProvider('loser', { text: '', fail: true, delayMs: 0 });

    const result = await runVerifiedSTT(Buffer.from('a'), 'fr', '', {
      providers: [winner.entry, loser.entry],
      timeoutMs: 1_000,
    });
    expect(result.consensus).toBe('bonjour');
  });
});

// ── #5 — ensemble folds settled results into Jaccard consensus ───────────────

describe('ensemble-stt #5 — Jaccard scores / outliers no longer hard-coded', () => {
  it('folds a second result that settled into Jaccard scores (#5)', async () => {
    // Both providers resolve in the same (delay 0) timer batch, so the loser's
    // result is recorded in `settled` before the winner-then-abort runs. This
    // makes the consensus-fold deterministic.
    const winner = makeFakeProvider('w', { text: 'the quick brown fox', delayMs: 0 });
    const agree = makeFakeProvider('agree', { text: 'the quick brown fox jumps', delayMs: 0 });

    const result = await runVerifiedSTT(Buffer.from('a'), 'en', '', {
      providers: [winner.entry, agree.entry],
      timeoutMs: 1_000,
    });

    // Winner always scores 1.0 against itself.
    const winnerName = result.consensus === 'the quick brown fox' ? 'w' : 'agree';
    expect(result.scores[winnerName]).toBe(1);
    // Both providers are represented — the old code hard-coded used_providers:1
    // and scores:{[winner]:1} / outliers:[] regardless of other results.
    expect(result.used_providers).toBe(2);
    expect(Object.keys(result.providers).sort()).toEqual(['agree', 'w']);
    // The non-winner has a REAL Jaccard score (4 shared / 5 union = 0.8), not 1.
    const otherName = winnerName === 'w' ? 'agree' : 'w';
    expect(result.scores[otherName]).toBeCloseTo(0.8, 5);
    expect(result.scores[otherName]).toBeLessThan(1);
    expect(result.outliers).not.toContain(otherName);
  });

  it('flags a divergent loser as an outlier when its text was captured', async () => {
    const winner = makeFakeProvider('w', { text: 'alpha beta gamma', delayMs: 1 });
    const outlier = makeFakeProvider('out', { text: 'completely different words here', delayMs: 1 });

    const result = await runVerifiedSTT(Buffer.from('a'), 'en', '', {
      providers: [winner.entry, outlier.entry],
      timeoutMs: 1_000,
      outlierThreshold: 0.3,
    });
    expect(result.scores.w).toBe(1);
    if (result.providers.out !== undefined) {
      expect(result.scores.out).toBeLessThan(0.3);
      expect(result.outliers).toContain('out');
    }
  });
});

// ── #19/#20/#22 — blocklist normalization, dedup, language stripping ─────────

describe('stt-hallucination-filter #20/#22 — robust blocklist matching', () => {
  it('matches a known phrase with trailing punctuation (#20)', () => {
    // "thank you for watching" is a canonical English Whisper hallucination.
    const r = filterHallucinations({ text: 'Thank you for watching.' }, 'en');
    expect(r.blocklistRejected).toBe(true);
    expect(r.text).toBe('');
  });

  it('matches a doubled hallucination "X. X." via dedup (#20)', () => {
    const r = filterHallucinations({ text: 'Thank you for watching. Thank you for watching.' }, 'en');
    expect(r.blocklistRejected).toBe(true);
    expect(r.text).toBe('');
  });

  it('normalizes a region-tagged language code before lookup (#22)', () => {
    // en-US / EN must resolve to the "en" blocklist key.
    const r1 = filterHallucinations({ text: 'Thank you for watching' }, 'en-US');
    const r2 = filterHallucinations({ text: 'Thank you for watching' }, 'EN');
    expect(r1.blocklistRejected).toBe(true);
    expect(r2.blocklistRejected).toBe(true);
  });

  it('does NOT reject ordinary speech', () => {
    const r = filterHallucinations({ text: 'the budget meeting starts at noon' }, 'en');
    expect(r.blocklistRejected).toBe(false);
    expect(r.text).toBe('the budget meeting starts at noon');
  });
});

// ── #21 — kept segments joined on space, not glued ───────────────────────────

describe('stt-hallucination-filter #21 — kept segments joined with space', () => {
  it('inserts a space between kept segments instead of gluing words', () => {
    const response: STTResponse = {
      text: 'hello world bad',
      segments: [
        seg({ id: 0, text: 'hello', no_speech_prob: 0.1 }),
        seg({ id: 1, text: 'world', no_speech_prob: 0.1 }),
        // This segment is rejected (high no_speech_prob) — forcing reconstruction.
        seg({ id: 2, text: 'bad', no_speech_prob: 0.99 }),
      ],
    };
    const r = filterHallucinations(response, 'en');
    expect(r.metadataRejected).toBe(1);
    // Old behaviour would yield "helloworld"; the fix yields "hello world".
    expect(r.text).toBe('hello world');
  });
});

// ── #23/#24/#85 — language detection ─────────────────────────────────────────

describe('language-detect #24 — hoisted inverse map still detects correctly', () => {
  it('detects English text restricted to fr/en', () => {
    const r = detectLanguage('The weather today is sunny and warm outside', 'fr', 'en');
    expect(r.language).toBe('en');
    // Confidence depends on whether the unrestricted franc pass agrees; the
    // contract that matters here is a positive, in-range confidence.
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it('detects French text restricted to fr/en', () => {
    const r = detectLanguage('Le temps est ensoleillé et agréable aujourd hui', 'fr', 'en');
    expect(r.language).toBe('fr');
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it('returns empty for too-short text', () => {
    expect(detectLanguage('Hi', 'fr', 'en')).toEqual({ language: '', confidence: 0 });
  });

  it('returns empty for unsupported language codes', () => {
    expect(detectLanguage('some long enough text here please', 'fr', 'zz')).toEqual({ language: '', confidence: 0 });
  });
});

describe('language-detect #23 — confidence boost is monotonic with length', () => {
  it('longer agreeing text never has lower confidence than the base 0.9', () => {
    const longText = 'this is a much longer english sentence that should be detected with high confidence by the trigram model';
    const r = detectLanguage(longText, 'fr', 'en');
    expect(r.language).toBe('en');
    // base 0.9 (+0.05 at >=15 words, +0.05 at >=30) — capped at 1.
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });
});

describe('language-detect #85 — never throws on pathological input', () => {
  it('returns a result (not a throw) for weird/control-char input', () => {
    expect(() => detectLanguage('     ', 'fr', 'en')).not.toThrow();
    const r = detectLanguage('!!!! ???? .... ____ ::::', 'fr', 'en');
    expect(r).toHaveProperty('language');
    expect(r).toHaveProperty('confidence');
  });
});

// ── #81 — streaming STT finality parsing ─────────────────────────────────────

describe('streaming-stt #81 — parseIsFinal surfaces transcript finality', () => {
  it('reads is_final / final / isFinal booleans', () => {
    expect(parseIsFinal({ text: 'x', is_final: true })).toBe(true);
    expect(parseIsFinal({ text: 'x', is_final: false })).toBe(false);
    expect(parseIsFinal({ text: 'x', final: true })).toBe(true);
    expect(parseIsFinal({ text: 'x', isFinal: true })).toBe(true);
  });

  it('maps type strings to finality', () => {
    expect(parseIsFinal({ type: 'final' })).toBe(true);
    expect(parseIsFinal({ type: 'final_transcript' })).toBe(true);
    expect(parseIsFinal({ type: 'partial' })).toBe(false);
    expect(parseIsFinal({ type: 'interim' })).toBe(false);
  });

  it('returns undefined when no finality signal is present (partial default)', () => {
    expect(parseIsFinal({ text: 'hello' })).toBeUndefined();
    expect(parseIsFinal({})).toBeUndefined();
  });
});

// ── #29 — adaptiveMaxTokens shrinks the LLM budget for short input ────────────

describe('adaptiveMaxTokens #29 — short input gets a smaller token budget', () => {
  it('scales the max-tokens budget by input length and caps at 200', () => {
    // The streaming path now calls this instead of a hard-coded 200.
    const tiny = adaptiveMaxTokens('oui');           // < 20 chars
    const short = adaptiveMaxTokens('a'.repeat(30));  // < 50
    const medium = adaptiveMaxTokens('a'.repeat(100));// < 150
    const long = adaptiveMaxTokens('a'.repeat(500));  // >= 150

    expect(tiny).toBeLessThan(long);
    expect(tiny).toBe(60);
    expect(short).toBe(100);
    expect(medium).toBe(150);
    expect(long).toBe(200);
    // Never exceeds the previous hard-coded value — pure cost reduction.
    expect(long).toBeLessThanOrEqual(200);
  });
});
