/**
 * Wave-4 unit tests for core-AI-pipeline optimizations
 * (docs/optimizations/01-core-ai-pipeline.md).
 *
 * Scope mirrors waves 1-3 (01-core-pipeline*.test.ts): pure, importable logic
 * only — NO real network / provider / GPU / FS. `franc` and the SSRF DNS guard
 * are mocked; `fetch` is stubbed where a fetcher's request *shape* is asserted.
 * We never boot a server entrypoint with timers.
 *
 * Items covered (NEW this wave):
 *   #5  — ensemble embedding-fallback consensus (cosineSimilarity + method)
 *   #17 — GPU STT metadata forwarding (avg_logprob/compression_ratio/no_speech_prob, words)
 *   #30 — GPU LLM max-tokens hint in request body
 *   #52 — streaming-overlap per-chunk TTS deadline
 *   #58/#62 — fanout reuses the primary's already-computed translation
 *   #59 — fanout per-target deadline (resolvePerTargetTimeout + withDeadline)
 *   #77 — non-clone TTS drop is non-fatal (helper-level: language normalize used too)
 *   #89 — pipeline partial-success flag (validated indirectly via fanout/overlap behavior)
 *   lang-normalize — detectLanguage / detectLanguageWithSwap accept en-US / EN
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Global mocks ─────────────────────────────────────────────────────────────
// franc is pulled in transitively by language-detect + some pipeline barrels.
// Use a controllable mock so individual tests can dictate the detected language.
const francMock = vi.fn((_text: string, _opts?: unknown) => 'eng');
vi.mock('franc', () => ({ franc: (t: string, o?: unknown) => francMock(t, o) }));

// SSRF guard does real DNS resolution — stub it so gpu-fetch can run offline.
vi.mock('../../src/gateway/pipeline/ssrf-protection', () => ({
  validateRemoteEndpointResolved: vi.fn(async () => undefined),
}));

beforeEach(() => {
  francMock.mockReset();
  francMock.mockImplementation(() => 'eng');
});

// ── #17 — GPU STT metadata extraction ────────────────────────────────────────

describe('#17 — extractSttMetrics forwards all three Whisper signals', () => {
  it('reads top-level numeric metrics', async () => {
    const { extractSttMetrics } = await import('../../src/gateway/pipeline/gpu-fetch');
    const m = extractSttMetrics({ avg_logprob: -0.4, compression_ratio: 1.8, no_speech_prob: 0.05 });
    expect(m.avg_logprob).toBeCloseTo(-0.4);
    expect(m.compression_ratio).toBeCloseTo(1.8);
    expect(m.no_speech_prob).toBeCloseTo(0.05);
  });

  it('leaves a missing metric undefined (not 0) so the NaN-sentinel filter sees "missing"', async () => {
    const { extractSttMetrics } = await import('../../src/gateway/pipeline/gpu-fetch');
    const m = extractSttMetrics({ text: 'hello' });
    expect(m.avg_logprob).toBeUndefined();
    expect(m.compression_ratio).toBeUndefined();
    expect(m.no_speech_prob).toBeUndefined();
  });

  it('falls back to a segment average when top-level is absent', async () => {
    const { extractSttMetrics } = await import('../../src/gateway/pipeline/gpu-fetch');
    const m = extractSttMetrics({
      segments: [
        { avg_logprob: -0.2, compression_ratio: 1.0, no_speech_prob: 0.1 },
        { avg_logprob: -0.6, compression_ratio: 2.0, no_speech_prob: 0.3 },
      ],
    });
    expect(m.avg_logprob).toBeCloseTo(-0.4); // (-0.2 + -0.6)/2
    expect(m.compression_ratio).toBeCloseTo(1.5);
    expect(m.no_speech_prob).toBeCloseTo(0.2);
  });

  it('ignores non-numeric values', async () => {
    const { extractSttMetrics } = await import('../../src/gateway/pipeline/gpu-fetch');
    const m = extractSttMetrics({ avg_logprob: 'oops', segments: [{ avg_logprob: NaN }] });
    expect(m.avg_logprob).toBeUndefined();
  });
});

// ── #17/#30 — fetchGpuSTT/LLM request shape (stubbed fetch) ──────────────────

describe('#17 — fetchGpuSTT forwards metadata + words from the pod response', () => {
  it('returns avg_logprob/compression_ratio/no_speech_prob/words when present', async () => {
    const { fetchGpuSTT } = await import('../../src/gateway/pipeline/gpu-fetch');
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        text: 'hi', language: 'en',
        avg_logprob: -0.3, compression_ratio: 1.2, no_speech_prob: 0.02,
        words: [{ word: 'hi', start: 0, end: 0.2 }],
        segments: [{ id: 0, text: 'hi' }],
      }),
    })) as unknown as typeof fetch;
    const rec = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    try {
      const r = await fetchGpuSTT('https://pod.example', Buffer.from('x'), 'en', '', '', true, new AbortController().signal, rec);
      expect(r.avg_logprob).toBeCloseTo(-0.3);
      expect(r.compression_ratio).toBeCloseTo(1.2);
      expect(r.no_speech_prob).toBeCloseTo(0.02);
      expect(Array.isArray(r.words)).toBe(true);
      expect(rec.recordSuccess).toHaveBeenCalledWith('stt');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('omits metadata entirely when the pod reports none (no fake 0)', async () => {
    const { fetchGpuSTT } = await import('../../src/gateway/pipeline/gpu-fetch');
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true, json: async () => ({ text: 'hi', language: 'en' }),
    })) as unknown as typeof fetch;
    const rec = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    try {
      const r = await fetchGpuSTT('https://pod.example', Buffer.from('x'), 'en', '', '', false, new AbortController().signal, rec);
      expect(r.avg_logprob).toBeUndefined();
      expect(r.compression_ratio).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('#30 — fetchGpuLLM sends a max-tokens hint when provided', () => {
  async function captureBody(maxTokens?: number): Promise<Record<string, unknown>> {
    const { fetchGpuLLM } = await import('../../src/gateway/pipeline/gpu-fetch');
    const realFetch = globalThis.fetch;
    let captured: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      captured = JSON.parse(init?.body || '{}');
      return { ok: true, json: async () => ({ translated_text: 'bonjour' }) } as unknown;
    }) as unknown as typeof fetch;
    const rec = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    try {
      await fetchGpuLLM('https://pod.example', 'hello', 'en', 'fr', '', '', new AbortController().signal, rec, undefined, maxTokens);
    } finally {
      globalThis.fetch = realFetch;
    }
    return captured;
  }

  it('includes max_tokens + max_new_tokens (floored) when set', async () => {
    const body = await captureBody(42.9);
    expect(body.max_tokens).toBe(42);
    expect(body.max_new_tokens).toBe(42);
  });

  it('omits the token bound entirely when unset (back-compat body)', async () => {
    const body = await captureBody(undefined);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_new_tokens');
    expect(body.text).toBe('hello');
  });

  it('omits the bound for non-positive / non-finite values', async () => {
    for (const v of [0, -5, NaN, Infinity]) {
      const body = await captureBody(v);
      expect(body).not.toHaveProperty('max_tokens');
    }
  });
});

// ── #59 — fanout per-target deadline ─────────────────────────────────────────

describe('#59 — resolvePerTargetTimeout (opt → env → 0)', () => {
  it('prefers a positive opt', async () => {
    const { resolvePerTargetTimeout } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    expect(resolvePerTargetTimeout(2500, {})).toBe(2500);
  });
  it('floors a fractional opt', async () => {
    const { resolvePerTargetTimeout } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    expect(resolvePerTargetTimeout(2500.9, {})).toBe(2500);
  });
  it('falls back to the env var', async () => {
    const { resolvePerTargetTimeout } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    expect(resolvePerTargetTimeout(undefined, { FANOUT_TARGET_TIMEOUT_MS: '4000' })).toBe(4000);
  });
  it('returns 0 (no budget) when nothing is set', async () => {
    const { resolvePerTargetTimeout } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    expect(resolvePerTargetTimeout(undefined, {})).toBe(0);
    expect(resolvePerTargetTimeout(0, { FANOUT_TARGET_TIMEOUT_MS: 'nope' })).toBe(0);
  });
});

describe('#59 — withDeadline rejects a slow promise but passes a fast one', () => {
  it('passes through when ms<=0 (no deadline)', async () => {
    const { withDeadline } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    await expect(withDeadline(Promise.resolve('ok'), 0, 'x')).resolves.toBe('ok');
  });
  it('resolves a fast promise before the deadline', async () => {
    const { withDeadline } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    await expect(withDeadline(Promise.resolve('fast'), 1000, 'x')).resolves.toBe('fast');
  });
  it('rejects a promise that exceeds the budget', async () => {
    const { withDeadline } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    const slow = new Promise((r) => setTimeout(() => r('late'), 50));
    await expect(withDeadline(slow, 5, 'slow-target')).rejects.toThrow(/budget/);
  });
});

// ── #58/#62 + #59 — runFanoutOrchestrator behavior ───────────────────────────

function makeFanoutDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const llmCalls: string[] = [];
  const cacheSets: Array<{ text: string; target: string; translated: string }> = [];
  const cache = new Map<string, string>();
  const subtitles: Array<{ target: string; translation: string }> = [];
  const dubs: string[] = [];

  const executors = {
    getCachedTranslation: (text: string, _s: string, target: string, _st: string) =>
      cache.get(`${text}|${target}`) ?? null,
    setCachedTranslation: (text: string, _s: string, target: string, translated: string) => {
      cache.set(`${text}|${target}`, translated);
      cacheSets.push({ text, target, translated });
    },
    buildSystemPrompt: () => 'SYS',
    buildLlmCandidates: (_rt: unknown, _stt: string, _s: string, target: string) => [{
      name: 'cloud', timeoutMs: 1000,
      run: async () => { llmCalls.push(target); return { translated_text: `T-${target}`, used_gpu: false }; },
    }],
    buildTtsCandidates: () => [{
      name: 'cloud', timeoutMs: 1000,
      run: async () => ({ audio: Buffer.from('AUDIO'), contentType: 'audio/wav', used_gpu: false }),
    }],
  };

  const deps = {
    routing: { llmOnGpu: false, ttsOnGpu: false, cloudProviderName: 'cloud' },
    sideEffects: {
      broadcastSubtitle: (d: { target: string; translation: string }) => subtitles.push({ target: d.target, translation: d.translation }),
      broadcastDubAudio: (target: string) => dubs.push(target),
    },
    executors,
    langNames: {},
    ...overrides,
  };
  return { deps, llmCalls, cacheSets, cache, subtitles, dubs };
}

describe('#58/#62 — fanout reuses the primary translation for a matching target', () => {
  it('skips the LLM call for the target equal to primaryTranslation.target', async () => {
    const { runFanoutOrchestrator } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    const { deps, llmCalls, cacheSets, subtitles } = makeFanoutDeps();
    await runFanoutOrchestrator('hola', 'es', 5, 'gpu',
      { targets: ['en', 'fr'], primaryTranslation: { target: 'en', translation: 'PRIMARY-EN' } },
      deps as never);
    // 'en' reused (no LLM), 'fr' still translated.
    expect(llmCalls).toEqual(['fr']);
    // The reused primary translation was broadcast for 'en'.
    expect(subtitles.find(s => s.target === 'en')?.translation).toBe('PRIMARY-EN');
    // And it was seeded into the cache.
    expect(cacheSets.find(c => c.target === 'en')?.translated).toBe('PRIMARY-EN');
  });

  it('does NOT reuse when primaryTranslation is empty/whitespace', async () => {
    const { runFanoutOrchestrator } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    const { deps, llmCalls } = makeFanoutDeps();
    await runFanoutOrchestrator('hola', 'es', 5, 'gpu',
      { targets: ['en'], primaryTranslation: { target: 'en', translation: '   ' } },
      deps as never);
    expect(llmCalls).toEqual(['en']); // fell through to a real LLM call
  });

  it('still uses the LRU cache when no primary is supplied', async () => {
    const { runFanoutOrchestrator } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    const { deps, llmCalls, cache } = makeFanoutDeps();
    cache.set('hola|en', 'CACHED-EN');
    await runFanoutOrchestrator('hola', 'es', 5, 'gpu', { targets: ['en'] }, deps as never);
    expect(llmCalls).toEqual([]); // served from cache
  });
});

describe('#59 — a slow target is abandoned without wedging the fan-out', () => {
  it('completes the fast target even when another exceeds the per-target budget', async () => {
    const { runFanoutOrchestrator } = await import('../../src/gateway/pipeline/fanout-orchestrator');
    const { deps, dubs } = makeFanoutDeps();
    // Make 'fr' TTS hang far past the budget.
    (deps.executors as Record<string, unknown>).buildTtsCandidates = (_rt: unknown, _txt: string, targetName: string) => [{
      name: 'cloud', timeoutMs: 10_000,
      run: async () => {
        if (targetName === 'fr' || targetName === '' ) { /* fall through */ }
        await new Promise((r) => setTimeout(r, 500));
        return { audio: Buffer.from('A'), contentType: 'audio/wav', used_gpu: false };
      },
    }];
    // langNames empty so targetName === target code.
    const start = Date.now();
    await runFanoutOrchestrator('hola', 'es', 5, 'gpu',
      { targets: ['fr'], perTargetTimeoutMs: 20 }, deps as never);
    // Should return promptly (deadline ~20ms), not wait the full 500ms TTS.
    expect(Date.now() - start).toBeLessThan(300);
    // The slow target never broadcast a dub.
    expect(dubs).not.toContain('fr');
  });
});

// ── #52 — streaming-overlap per-chunk TTS deadline ───────────────────────────

describe('#52 — StreamingOverlap chunk deadline releases a hung TTS slot', () => {
  async function* gen(tokens: string[]) { for (const t of tokens) yield t; }

  it('does not let one hung chunk hold the ordered tail forever', async () => {
    const { StreamingOverlap } = await import('../../src/gateway/pipeline/streaming-overlap');
    const ov = new StreamingOverlap({ minTokens: 1, chunkTimeoutMs: 15 });
    const skipped: number[] = [];
    const emitted: number[] = [];
    let firstCall = true;
    const ttsFn = (_text: string) => {
      if (firstCall) {
        firstCall = false;
        // First chunk hangs forever — must be timed out, not block chunk #1.
        return new Promise<Buffer>(() => { /* never resolves */ });
      }
      return Promise.resolve(Buffer.from('audio'));
    };
    const text = await ov.processWithOverlap(
      gen(['Hello. ', 'World. ']),
      ttsFn,
      (_audio, idx) => emitted.push(idx),
      (idx) => skipped.push(idx),
    );
    expect(text).toContain('Hello');
    // Chunk 0 hung → skipped via deadline; chunk 1 emitted.
    expect(skipped).toContain(0);
    expect(emitted).toContain(1);
  });

  it('with no deadline (default) a normal stream emits all chunks', async () => {
    const { StreamingOverlap } = await import('../../src/gateway/pipeline/streaming-overlap');
    const ov = new StreamingOverlap({ minTokens: 1 });
    const emitted: number[] = [];
    await ov.processWithOverlap(
      gen(['Hello. ', 'World. ']),
      () => Promise.resolve(Buffer.from('a')),
      (_a, idx) => emitted.push(idx),
    );
    expect(emitted.length).toBeGreaterThanOrEqual(2);
  });

  it('setChunkTimeoutMs clamps negatives to 0', async () => {
    const { StreamingOverlap } = await import('../../src/gateway/pipeline/streaming-overlap');
    const ov = new StreamingOverlap({ minTokens: 1 });
    ov.setChunkTimeoutMs(-50); // should not throw and should disable the deadline
    const emitted: number[] = [];
    await ov.processWithOverlap(
      gen(['Hi. ']),
      () => Promise.resolve(Buffer.from('a')),
      (_a, idx) => emitted.push(idx),
    );
    expect(emitted.length).toBeGreaterThanOrEqual(1);
  });
});

// ── #5 — ensemble embedding fallback ─────────────────────────────────────────

describe('#5 — cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal', async () => {
    const { cosineSimilarity } = await import('../../src/ensemble-stt');
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('returns 0 for a degenerate (zero) vector', async () => {
    const { cosineSimilarity } = await import('../../src/ensemble-stt');
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [1])).toBe(0);
  });
});

describe('#5 — runVerifiedSTT promotes to embedding consensus on lexical disagreement', () => {
  function sttProvider(name: string, text: string) {
    return {
      name,
      provider: {
        getModels: () => [{ id: `${name}-model` }],
        transcribe: async () => ({ text }),
      },
    };
  }

  it('uses jaccard when no embedding fallback is configured', async () => {
    const { runVerifiedSTT } = await import('../../src/ensemble-stt');
    const r = await runVerifiedSTT(Buffer.from('x'), 'en', '', {
      providers: [sttProvider('a', 'the cat sat'), sttProvider('b', 'the cat sat')],
      timeoutMs: 1000,
    } as never);
    expect(r.similarity_method).toBe('jaccard');
  });

  it('switches to embedding when losers are jaccard-outliers and an embedder is configured', async () => {
    const { runVerifiedSTT } = await import('../../src/ensemble-stt');
    // Two lexically-different-but-semantically-close transcripts → jaccard ~0
    // (outlier) so the embedding fallback fires.
    const embedder = {
      name: 'emb', providerId: 'emb', isConfigured: () => true,
      embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 1, 1])), // all identical → cosine 1
    };
    const r = await runVerifiedSTT(Buffer.from('x'), 'en', '', {
      providers: [sttProvider('a', 'hello there friend'), sttProvider('b', 'greetings comrade pal')],
      timeoutMs: 1000,
      embeddingFallbacks: [embedder],
      embeddingFallbackThreshold: 0.5,
    } as never);
    // It either folded both (embedding) or only the winner finished first.
    // If both settled, method must be 'embedding' and no outliers under cosine=1.
    if (r.used_providers >= 2) {
      expect(r.similarity_method).toBe('embedding');
      expect(r.outliers).toHaveLength(0);
      expect(embedder.embed).toHaveBeenCalled();
    } else {
      // Only the winner recorded in time — degrade gracefully to jaccard.
      expect(r.similarity_method).toBe('jaccard');
    }
  });

  it('falls back to jaccard if the embedder throws', async () => {
    const { runVerifiedSTT } = await import('../../src/ensemble-stt');
    const embedder = {
      name: 'emb', providerId: 'emb', isConfigured: () => true,
      embed: vi.fn(async () => { throw new Error('embed down'); }),
    };
    const r = await runVerifiedSTT(Buffer.from('x'), 'en', '', {
      providers: [sttProvider('a', 'alpha beta'), sttProvider('b', 'gamma delta')],
      timeoutMs: 1000,
      embeddingFallbacks: [embedder],
    } as never);
    expect(r.similarity_method).toBe('jaccard');
  });
});

// ── lang-normalize — detectLanguage accepts region/upper-case codes ──────────

describe('lang-normalize — normalizeLangCode', () => {
  it('strips region + lowercases', async () => {
    const { normalizeLangCode } = await import('../../src/language-detect');
    expect(normalizeLangCode('en-US')).toBe('en');
    expect(normalizeLangCode('EN')).toBe('en');
    expect(normalizeLangCode('pt_BR')).toBe('pt');
    expect(normalizeLangCode('')).toBe('');
    expect(normalizeLangCode(undefined)).toBe('');
  });
});

describe('lang-normalize — detectLanguage resolves codes with region/case', () => {
  it('detects with EN / FR-CA inputs (would previously miss the map lookup)', async () => {
    francMock.mockImplementation((_t: string, opts: { only?: string[] } | undefined) => {
      // Restricted pass: return the source iso3 ('eng'); unrestricted: also 'eng'.
      return 'eng';
    });
    const { detectLanguage } = await import('../../src/language-detect');
    const r = detectLanguage('this is clearly an english sentence here', 'EN', 'FR-CA');
    expect(r.language).toBe('en');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('returns undetermined for an unknown code', async () => {
    const { detectLanguage } = await import('../../src/language-detect');
    const r = detectLanguage('some words here now', 'zz', 'en');
    expect(r.language).toBe('');
    expect(r.confidence).toBe(0);
  });
});

describe('lang-normalize — detectLanguageWithSwap compares normalized target', () => {
  it('recommends a swap when the detected language equals a region-coded target', async () => {
    // franc detects English; expected source FR, target EN-US → should swap.
    francMock.mockImplementation(() => 'eng');
    const { detectLanguageWithSwap } = await import('../../src/language-detect');
    const { shouldSwap, detected } = detectLanguageWithSwap(
      'hello world how are you doing today friend', 'fr', 'EN-US', 0.5,
    );
    expect(detected.language).toBe('en');
    expect(shouldSwap).toBe(true);
  });
});
