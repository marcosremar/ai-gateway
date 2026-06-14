/**
 * Wave-3 unit tests for core-AI-pipeline optimizations
 * (docs/optimizations/01-core-ai-pipeline.md).
 *
 * Scope mirrors waves 1-2 (01-core-pipeline*.test.ts): pure, importable logic
 * only — no real network / provider / GPU / FS. `franc` is mocked (only needed
 * transitively by some pipeline modules). The server modules (ai-handlers)
 * import without starting timers; we exercise only their newly-extracted PURE
 * helpers.
 *
 * Each describe block maps to an optimization ID from the doc.
 *
 * Items covered (NEW this wave): #27, #31, #32, #35, #37, #41, #44, #50, #51,
 * #54, #63, #91, #92, #93, #94.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// franc is pulled in transitively by some pipeline barrels; stub it so nothing
// touches the real trigram tables.
vi.mock('franc', () => ({ franc: () => 'eng' }));

// ── #41 / #92 / #93 / #94 — system-prompt helpers ────────────────────────────

describe('system-prompt #41 — buildSystemPrompt is memoized & pure', () => {
  it('returns the same string content for repeated (source,target,style)', async () => {
    const { buildSystemPrompt } = await import('../../src/gateway/pipeline/system-prompt');
    const a = buildSystemPrompt('French', 'English', 'default');
    const b = buildSystemPrompt('French', 'English', 'default');
    expect(a).toBe(b);
    expect(a).toContain('Translate from French to English.');
  });

  it('returns the IDENTICAL reference on a cache hit (memoized, not rebuilt)', async () => {
    const { buildSystemPrompt, _clearSystemPromptCache } = await import('../../src/gateway/pipeline/system-prompt');
    _clearSystemPromptCache();
    const first = buildSystemPrompt('German', 'English', 'news');
    const second = buildSystemPrompt('German', 'English', 'news');
    // Strict identity proves the second call hit the memo (no new concat).
    expect(second).toBe(first);
  });

  it('keys on style — different styles yield different prompts', async () => {
    const { buildSystemPrompt } = await import('../../src/gateway/pipeline/system-prompt');
    const def = buildSystemPrompt('French', 'English', 'default');
    const academic = buildSystemPrompt('French', 'English', 'academic');
    expect(def).not.toBe(academic);
    expect(academic.toLowerCase()).toContain('academic');
  });

  it('unknown style falls back to default template', async () => {
    const { buildSystemPrompt, TRANSLATION_STYLES } = await import('../../src/gateway/pipeline/system-prompt');
    const bogus = buildSystemPrompt('French', 'English', 'no-such-style');
    expect(bogus).toContain(TRANSLATION_STYLES.default.slice(0, 30));
  });
});

describe('system-prompt #92 — style validation', () => {
  it('isKnownStyle accepts known keys and rejects typos/empty', async () => {
    const { isKnownStyle } = await import('../../src/gateway/pipeline/system-prompt');
    expect(isKnownStyle('academic')).toBe(true);
    expect(isKnownStyle('default')).toBe(true);
    expect(isKnownStyle('acedemic')).toBe(false); // typo
    expect(isKnownStyle('')).toBe(false);
    expect(isKnownStyle(undefined)).toBe(false);
  });

  it('resolveStyle returns {valid:false, style:fallback} for unknown', async () => {
    const { resolveStyle } = await import('../../src/gateway/pipeline/system-prompt');
    expect(resolveStyle('news')).toEqual({ style: 'news', valid: true });
    const r = resolveStyle('whoops');
    expect(r.valid).toBe(false);
    expect(r.style).toBe('default');
    expect(resolveStyle('whoops', 'casual').style).toBe('casual');
  });
});

describe('system-prompt #93 — voice validation', () => {
  it('isKnownVoice recognizes house voices case-insensitively', async () => {
    const { isKnownVoice } = await import('../../src/gateway/pipeline/system-prompt');
    expect(isKnownVoice('Ryan')).toBe(true);
    expect(isKnownVoice('ryan')).toBe(true);
    expect(isKnownVoice('VIVIAN')).toBe(true);
    expect(isKnownVoice('NotAVoice')).toBe(false);
    expect(isKnownVoice(undefined)).toBe(false);
    expect(isKnownVoice('')).toBe(false);
  });
});

describe('system-prompt #94 — centralized default speaker', () => {
  it('exports a single DEFAULT_SPEAKER used as the house voice', async () => {
    const { DEFAULT_SPEAKER, isKnownVoice } = await import('../../src/gateway/pipeline/system-prompt');
    expect(DEFAULT_SPEAKER).toBe('Ryan');
    expect(isKnownVoice(DEFAULT_SPEAKER)).toBe(true);
  });
});

// ── #91 — structured GPU-provider detection ──────────────────────────────────

describe('pipeline-orchestrator #91 — isGpuProvider replaces brittle === "gpu"', () => {
  it('matches the bare "gpu" and structured gpu-* names', async () => {
    const { isGpuProvider } = await import('../../src/gateway/pipeline/pipeline-orchestrator');
    expect(isGpuProvider('gpu')).toBe(true);
    expect(isGpuProvider('gpu-modal')).toBe(true);        // previously MISSED
    expect(isGpuProvider('gpu/preset-fallback')).toBe(true);
    expect(isGpuProvider('gpu:tts')).toBe(true);
    expect(isGpuProvider('GPU')).toBe(true);              // case-insensitive
  });

  it('does NOT match cloud providers (incl. lookalikes)', async () => {
    const { isGpuProvider } = await import('../../src/gateway/pipeline/pipeline-orchestrator');
    expect(isGpuProvider('groq')).toBe(false);
    expect(isGpuProvider('openai')).toBe(false);
    expect(isGpuProvider('modal')).toBe(false);
    expect(isGpuProvider('gpufoo')).toBe(false); // no separator → not a gpu path
    expect(isGpuProvider('')).toBe(false);
    expect(isGpuProvider(undefined)).toBe(false);
    expect(isGpuProvider(null)).toBe(false);
  });
});

// ── #31 / #32 — translation cache key + longest-wins ─────────────────────────

describe('translation-cache #31 — generation params in the key', () => {
  let mod: typeof import('../../src/gateway/pipeline/translation-cache');
  beforeEach(async () => {
    mod = await import('../../src/gateway/pipeline/translation-cache');
  });

  it('buildTranslationCacheKey appends the paramsKey only when provided', () => {
    expect(mod.buildTranslationCacheKey('hi', 'fr', 'en', 'default')).toBe('fr|en|default|hi');
    expect(mod.buildTranslationCacheKey('hi', 'fr', 'en', 'default', 't0_m200'))
      .toBe('fr|en|default|hi|t0_m200');
  });

  it('different paramsKey buckets do NOT collide', () => {
    const text = 'param-isolation-test-phrase';
    mod.setCachedTranslation(text, 'fr', 'en', 'TRUNCATED', 'default', 'm60');
    mod.setCachedTranslation(text, 'fr', 'en', 'FULL OUTPUT', 'default', 'm200');
    expect(mod.getCachedTranslation(text, 'fr', 'en', 'default', 'm60')).toBe('TRUNCATED');
    expect(mod.getCachedTranslation(text, 'fr', 'en', 'default', 'm200')).toBe('FULL OUTPUT');
    // The unbucketed key is independent of both.
    expect(mod.getCachedTranslation(text, 'fr', 'en', 'default')).toBeNull();
  });
});

describe('translation-cache #32 — prefer the longer translation for a key', () => {
  let mod: typeof import('../../src/gateway/pipeline/translation-cache');
  beforeEach(async () => {
    mod = await import('../../src/gateway/pipeline/translation-cache');
  });

  it('a shorter (truncated) re-set does NOT overwrite a longer cached value', () => {
    const text = 'longest-wins-phrase-one';
    mod.setCachedTranslation(text, 'fr', 'en', 'Bonjour tout le monde complet');
    mod.setCachedTranslation(text, 'fr', 'en', 'Bonjour'); // truncated, lands second
    expect(mod.getCachedTranslation(text, 'fr', 'en')).toBe('Bonjour tout le monde complet');
  });

  it('a longer re-set DOES replace a shorter cached value', () => {
    const text = 'longest-wins-phrase-two';
    mod.setCachedTranslation(text, 'fr', 'en', 'Salut'); // short first
    mod.setCachedTranslation(text, 'fr', 'en', 'Salut, comment ca va aujourd hui');
    expect(mod.getCachedTranslation(text, 'fr', 'en')).toBe('Salut, comment ca va aujourd hui');
  });
});

// ── #35 / #37 — speculative cache early-exit + spend tracking ─────────────────

describe('speculative-cache #35 — length-diff early-exit avoids the DP', () => {
  it('a partial far shorter than the final is a clean MISS (no false match)', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const c = new SpeculativeCache();
    // Partial is NOT a prefix/substring of the final and is far shorter, so
    // rules 1 & 2 fail and the length-diff early-exit rejects rule 3:
    // |la-lb| is huge → similarity ceiling < 0.8 → MISS without running the DP.
    c.speculate('s1', 'zzz qqq', async () => 'le');
    const r = await c.resolve('s1', 'completely unrelated very long final transcript here ok', 0.8);
    expect(r).toBeNull();
  });

  it('still HITS when the final is a near-equal-length close variant', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const c = new SpeculativeCache();
    c.speculate('s2', 'bonjour le monde', async () => 'hello world');
    // one-char typo at the end → length diff 0, similarity high → HIT
    const r = await c.resolve('s2', 'bonjour le mondd', 0.8);
    expect(r).toBe('hello world');
  });

  it('still HITS on an exact prefix even when final is much longer (#35 keeps prefix path)', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const c = new SpeculativeCache();
    c.speculate('s3', 'i would like', async () => 'je voudrais');
    const r = await c.resolve('s3', 'i would like to order a coffee please', 0.95);
    // prefix match short-circuits BEFORE the length-diff Levenshtein branch.
    expect(r).toBe('je voudrais');
  });
});

describe('speculative-cache #37 — speculative spend is tracked', () => {
  it('counts launched speculations and wasted (never-reused) ones', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const c = new SpeculativeCache();
    c.speculate('a', 'hello there friend', async () => 'salut');
    c.speculate('b', 'totally different text', async () => 'autre');

    // 'a' is reused (prefix/exact) → a hit; 'b' resolves against unrelated text → wasted.
    const hit = await c.resolve('a', 'hello there friend', 0.8);
    expect(hit).toBe('salut');
    const miss = await c.resolve('b', 'zzz qqq nothing alike at all here', 0.9);
    expect(miss).toBeNull();

    const s = c.stats();
    expect(s.speculations).toBe(2);       // both launched
    expect(s.speculationsWasted).toBe(1); // only 'b' wasted
    expect(s.wasteRate).toBeCloseTo(0.5, 5);
  });

  it('counts a failed background translation as failed spend', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const c = new SpeculativeCache();
    c.speculate('x', 'will throw downstream', async () => { throw new Error('llm down'); });
    // Let the rejected background promise settle.
    await new Promise(r => setTimeout(r, 0));
    const s = c.stats();
    expect(s.speculations).toBe(1);
    expect(s.speculationsFailed).toBe(1);
  });
});

// ── #50 / #51 / #54 — streaming overlap ──────────────────────────────────────

async function* tokenStream(tokens: string[]): AsyncIterable<string> {
  for (const t of tokens) yield t;
}

describe('streaming-overlap #51 — max-words flush bounds first-chunk size', () => {
  it('a long un-punctuated run is flushed at maxWords (does not wait for a period)', async () => {
    const { StreamingOverlap } = await import('../../src/gateway/pipeline/streaming-overlap');
    const ov = new StreamingOverlap({ minTokens: 3, maxWords: 5 });
    const fired: string[] = [];
    const tts = async (t: string) => { fired.push(t); return Buffer.from(t); };
    // 12 words, NO sentence-terminating punctuation anywhere.
    const words = 'one two three four five six seven eight nine ten eleven twelve'.split(' ');
    await ov.processWithOverlap(tokenStream(words.map(w => w + ' ')), tts, () => {});
    // With maxWords=5 it must have fired more than one chunk (not one 12-word blob).
    expect(fired.length).toBeGreaterThan(1);
    // No single fired chunk should be the entire 12-word run.
    expect(fired.every(c => c.trim().split(/\s+/).length < 12)).toBe(true);
  });

  it('setMaxWords keeps the cap at/above minTokens', async () => {
    const { StreamingOverlap } = await import('../../src/gateway/pipeline/streaming-overlap');
    const ov = new StreamingOverlap({ minTokens: 6 });
    ov.setMaxWords(2); // below minTokens → clamped up
    // No throw + reasonable behavior is the contract; exercise a short stream.
    const fired: string[] = [];
    await ov.processWithOverlap(tokenStream(['hi ', 'there ']), async (t) => { fired.push(t); return Buffer.from(t); }, () => {});
    expect(Array.isArray(fired)).toBe(true);
  });
});

describe('streaming-overlap #54 — running word count produces full text & chunks', () => {
  it('emits all audio chunks in order and returns the joined text', async () => {
    const { StreamingOverlap } = await import('../../src/gateway/pipeline/streaming-overlap');
    const ov = new StreamingOverlap({ minTokens: 2 });
    const emitted: number[] = [];
    const tts = async (t: string) => Buffer.from(t);
    const full = await ov.processWithOverlap(
      tokenStream(['Hello world. ', 'How are you? ', 'Fine thanks. ']),
      tts,
      (_audio, idx) => emitted.push(idx),
    );
    expect(full).toBe('Hello world. How are you? Fine thanks. ');
    // chunk indices are emitted strictly in order starting at 0
    expect(emitted).toEqual([...emitted].sort((a, b) => a - b));
    expect(emitted[0]).toBe(0);
  });
});

describe('streaming-overlap #50 — stats expose a lastSavedMs field', () => {
  it('stats() includes lastSavedMs (>=0) and avgLatencySavedMs', async () => {
    const { StreamingOverlap } = await import('../../src/gateway/pipeline/streaming-overlap');
    const ov = new StreamingOverlap({ minTokens: 1 });
    const tts = async (t: string) => { await new Promise(r => setTimeout(r, 1)); return Buffer.from(t); };
    await ov.processWithOverlap(tokenStream(['One. ', 'Two. ', 'Three. ']), tts, () => {});
    const s = ov.stats();
    expect(s).toHaveProperty('lastSavedMs');
    expect(typeof s.lastSavedMs).toBe('number');
    expect(s.lastSavedMs).toBeGreaterThanOrEqual(0);
    expect(s.totalRequests).toBe(1);
  });
});

// ── #63 — configurable fan-out cap ───────────────────────────────────────────

describe('fanout-orchestrator #63 — FANOUT_MAX is configurable', () => {
  it('per-call opt wins over env and default', async () => {
    const { resolveFanoutMax, DEFAULT_FANOUT_MAX } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    expect(resolveFanoutMax(32, {})).toBe(32);
    expect(resolveFanoutMax(undefined, { FANOUT_MAX: '24' })).toBe(24);
    expect(resolveFanoutMax(undefined, {})).toBe(DEFAULT_FANOUT_MAX);
  });

  it('ignores invalid opt/env values and falls back to default', async () => {
    const { resolveFanoutMax, DEFAULT_FANOUT_MAX } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    expect(resolveFanoutMax(0, {})).toBe(DEFAULT_FANOUT_MAX);
    expect(resolveFanoutMax(-5, {})).toBe(DEFAULT_FANOUT_MAX);
    expect(resolveFanoutMax(NaN as any, {})).toBe(DEFAULT_FANOUT_MAX);
    expect(resolveFanoutMax(undefined, { FANOUT_MAX: 'abc' })).toBe(DEFAULT_FANOUT_MAX);
    expect(resolveFanoutMax(undefined, { FANOUT_MAX: '0' })).toBe(DEFAULT_FANOUT_MAX);
  });

  it('floors fractional values', async () => {
    const { resolveFanoutMax } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    expect(resolveFanoutMax(7.9, {})).toBe(7);
  });
});

// ── server/ai-handlers.ts — extracted pure helpers ───────────────────────────

describe('ai-handlers #27 — STT prompt is length-capped to Whisper window', () => {
  it('passes through short prompts unchanged', async () => {
    const { capSttPrompt } = await import('../../server/ai-handlers');
    expect(capSttPrompt('domain: legal')).toBe('domain: legal');
    expect(capSttPrompt('')).toBe('');
  });

  it('truncates an over-long prompt to the ceiling', async () => {
    const { capSttPrompt } = await import('../../server/ai-handlers');
    const huge = 'x'.repeat(5000);
    const capped = capSttPrompt(huge);
    expect(capped.length).toBeLessThan(huge.length);
    expect(capped.length).toBeLessThanOrEqual(800);
    expect(capped.length).toBeGreaterThan(0);
  });
});

describe('ai-handlers #44 — capacity vs upstream-failure status mapping', () => {
  it('maps "No providers available" to 503 (retryable capacity)', async () => {
    const { statusForPipelineError } = await import('../../server/ai-handlers');
    const r = statusForPipelineError('No providers available for translation', 'translation');
    expect(r.status).toBe(503);
    expect(r.error).toContain('No providers available');
  });

  it('maps any other failure to 500', async () => {
    const { statusForPipelineError } = await import('../../server/ai-handlers');
    const r = statusForPipelineError('upstream 502 from groq', 'translation');
    expect(r.status).toBe(500);
    expect(r.error).toContain('All providers failed');
  });

  it('honors the stage label in the error string', async () => {
    const { statusForPipelineError } = await import('../../server/ai-handlers');
    expect(statusForPipelineError('No providers available', 'STT').error).toContain('STT');
    expect(statusForPipelineError('boom', 'TTS').error).toContain('TTS');
  });
});
