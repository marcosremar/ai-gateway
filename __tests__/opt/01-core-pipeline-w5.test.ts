/**
 * Wave-5 unit tests for core-AI-pipeline optimizations
 * (docs/optimizations/01-core-ai-pipeline.md).
 *
 * Scope mirrors waves 1-4 (01-core-pipeline*.test.ts): pure, importable logic
 * only — NO real network / provider / GPU / FS. `franc` and the SSRF DNS guard
 * are mocked so the imported pipeline modules run offline. We never boot a
 * server entrypoint with live timers.
 *
 * Items covered (NEW this wave — not present in waves 1-4):
 *   #8  — cap on concurrent paid STT race candidates (resolveMaxSttCandidates + capSttCandidates)
 *   #36 — speculative cache per-session ring (final matches an EARLIER partial a later one overwrote)
 *   #64 — audio-duration guard (estimateAudioSeconds / isAudioTooShort + orchestrator short-circuit)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Global mocks ─────────────────────────────────────────────────────────────
// franc is pulled in transitively by language-detect + some pipeline barrels.
const francMock = vi.fn((_text: string, _opts?: unknown) => 'eng');
vi.mock('franc', () => ({ franc: (t: string, o?: unknown) => francMock(t, o) }));

// SSRF guard does real DNS resolution — stub it so pipeline barrels run offline.
vi.mock('../../src/gateway/pipeline/ssrf-protection', () => ({
  validateRemoteEndpointResolved: vi.fn(async () => undefined),
}));

beforeEach(() => {
  francMock.mockReset();
  francMock.mockImplementation(() => 'eng');
});

// ── #64 — audio-duration guard (pure helpers) ────────────────────────────────

describe('#64 — estimateAudioSeconds / isAudioTooShort', () => {
  it('estimateAudioSeconds uses 16kHz/16-bit mono PCM (32000 bytes/sec)', async () => {
    const { estimateAudioSeconds, PCM16_BYTES_PER_SEC } = await import('../../src/gateway/pipeline/pipeline-orchestrator');
    expect(PCM16_BYTES_PER_SEC).toBe(32000);
    // 32000 bytes = 1.0s, 16000 bytes = 0.5s.
    expect(estimateAudioSeconds(Buffer.alloc(32000))).toBeCloseTo(1.0);
    expect(estimateAudioSeconds(Buffer.alloc(16000))).toBeCloseTo(0.5);
  });

  it('estimateAudioSeconds returns 0 for empty / invalid input', async () => {
    const { estimateAudioSeconds } = await import('../../src/gateway/pipeline/pipeline-orchestrator');
    expect(estimateAudioSeconds(Buffer.alloc(0))).toBe(0);
    expect(estimateAudioSeconds(Buffer.alloc(100), 0)).toBe(0); // bad bytesPerSec
  });

  it('isAudioTooShort: minMs<=0 disables the guard (legacy — never short-circuits)', async () => {
    const { isAudioTooShort } = await import('../../src/gateway/pipeline/pipeline-orchestrator');
    expect(isAudioTooShort(Buffer.alloc(0), 0)).toBe(false);
    expect(isAudioTooShort(Buffer.alloc(0), -5)).toBe(false);
    expect(isAudioTooShort(Buffer.alloc(10), 0)).toBe(false);
  });

  it('isAudioTooShort flags sub-threshold buffers and passes long enough ones', async () => {
    const { isAudioTooShort } = await import('../../src/gateway/pipeline/pipeline-orchestrator');
    // 1600 bytes = 50ms. Guard at 200ms → too short.
    expect(isAudioTooShort(Buffer.alloc(1600), 200)).toBe(true);
    // 16000 bytes = 500ms. Guard at 200ms → fine.
    expect(isAudioTooShort(Buffer.alloc(16000), 200)).toBe(false);
    // Exactly the threshold (6400 bytes = 200ms) is NOT "too short" (strict <).
    expect(isAudioTooShort(Buffer.alloc(6400), 200)).toBe(false);
  });
});

describe('#64 — orchestrator short-circuits sub-threshold audio', () => {
  // Minimal deps/cb shaped for the early-guard path only. The guard runs before
  // STT, so buildSttCandidates must NEVER be invoked when audio is too short.
  function makeHarness() {
    const calls = { stt: 0, complete: 0, prewarm: 0 };
    let completeArg: any = null;
    const sideEffects: any = {
      onPipelineStart: () => {},
      onCloneStart: () => {},
      preWarmConnections: () => { calls.prewarm++; },
      getOtherDubTargets: () => [],
      runDubFanout: () => {},
      broadcastSubtitle: () => {},
      broadcastDubAudio: () => {},
      forwardToAvatar: () => {},
      logRequest: () => {},
      stampProfile: () => {},
      recordGpuTtsWarmth: () => {},
      recordPerStageLatency: () => {},
    };
    const executors: any = {
      buildSystemPrompt: () => 'sys',
      getVoiceReference: () => null,
      getCachedTranslation: () => null,
      setCachedTranslation: () => {},
      buildSttCandidates: () => { calls.stt++; return []; },
      buildLlmCandidates: () => [],
      buildTtsCandidates: () => [],
    };
    const deps: any = {
      routing: { cloudProviderName: 'groq', isCloneRequest: false },
      labs: { peakEwma: false, speculativeTranslation: false, streamingOverlap: false, ewmaDecayFactor: 1, speculationMinConfidence: 0.8, overlapMinTokens: 3 },
      sideEffects,
      executors,
      ewmaTracker: { record: () => {}, snapshot: () => ({}) },
      langNames: {},
      adaptiveStageTimeout: (_s: string, d: number) => d,
    };
    const cb: any = {
      onStageStart: () => {},
      onStageDone: () => {},
      onAudioChunk: () => {},
      onComplete: (r: any) => { calls.complete++; completeArg = r; },
      onError: () => {},
    };
    return { calls, deps, cb, getComplete: () => completeArg };
  }

  it('emits an empty result and never builds STT candidates when below minAudioMs', async () => {
    const { runPipelineOrchestrator } = await import('../../src/gateway/pipeline/pipeline-orchestrator');
    const h = makeHarness();
    // 1600 bytes = 50ms, guard at 300ms.
    await runPipelineOrchestrator(Buffer.alloc(1600), { source: 'fr', target: 'en', minAudioMs: 300 } as any, h.cb, h.deps);

    expect(h.calls.stt).toBe(0);          // STT fan-out skipped
    expect(h.calls.prewarm).toBe(0);      // returned before pre-warm
    expect(h.calls.complete).toBe(1);
    const r = h.getComplete();
    expect(r.transcription).toBe('');
    expect(r.translation).toBe('');
    expect(r.audioBase64).toBe('');
    expect(r.timing.stt_provider).toBe('none');
    expect(r.timing.used_gpu).toBe(false);
  });

  it('does NOT short-circuit when minAudioMs is unset (legacy path proceeds to STT)', async () => {
    const { runPipelineOrchestrator } = await import('../../src/gateway/pipeline/pipeline-orchestrator');
    const h = makeHarness();
    // buildSttCandidates returns [] → raceProviders will reject; we only care
    // that the guard did NOT fire (STT was attempted) and onError/onComplete ran.
    await runPipelineOrchestrator(Buffer.alloc(1600), { source: 'fr', target: 'en' } as any, h.cb, h.deps).catch(() => {});
    expect(h.calls.stt).toBe(1); // guard disabled → STT candidate build attempted
  });
});

// ── #36 — speculative cache per-session ring ─────────────────────────────────

describe('#36 — speculative cache retains a per-session ring of recent partials', () => {
  it('default (ring size 1) discards an earlier partial when a later one overwrites it', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const sc = new SpeculativeCache();
    const final = 'the quick brown fox jumps';
    // Partial A is a clean prefix of the final → would match.
    sc.speculate('s1', 'the quick brown fox', async () => 'A-translation');
    // Partial B (later) is unrelated → overwrites A in the single-entry cache.
    sc.speculate('s1', 'zzz totally different words here', async () => 'B-translation');

    const out = await sc.resolve('s1', final, 0.8);
    expect(out).toBeNull(); // only B was kept; B doesn't match → miss
    expect(sc.stats().hits).toBe(0);
  });

  it('ring size > 1 lets the final match an EARLIER partial a later one overwrote', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const sc = new SpeculativeCache();
    sc.setRingSize(3);
    const final = 'the quick brown fox jumps';
    sc.speculate('s1', 'the quick brown fox', async () => 'A-translation'); // matches final
    sc.speculate('s1', 'zzz totally different words here', async () => 'B-translation'); // doesn't

    const out = await sc.resolve('s1', final, 0.8);
    expect(out).toBe('A-translation'); // earlier partial recovered via the ring
    expect(sc.stats().hits).toBe(1);
  });

  it('ring resolve cleans up the session (a second resolve is a miss)', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const sc = new SpeculativeCache();
    sc.setRingSize(2);
    sc.speculate('s1', 'hello there friend', async () => 'X');
    expect(await sc.resolve('s1', 'hello there friend everyone', 0.5)).toBe('X');
    // session consumed → ring + pending cleared.
    expect(await sc.resolve('s1', 'hello there friend everyone', 0.5)).toBeNull();
  });

  it('ring keeps only the last N partials (oldest beyond N is dropped)', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const sc = new SpeculativeCache();
    sc.setRingSize(2);
    const final = 'alpha beta gamma delta';
    // Three partials; ring=2 → the first ("alpha beta") is evicted.
    sc.speculate('s1', 'alpha beta', async () => 'FIRST');     // would match, but evicted
    sc.speculate('s1', 'qqq www eee', async () => 'SECOND');   // no match
    sc.speculate('s1', 'rrr ttt yyy', async () => 'THIRD');    // no match
    const out = await sc.resolve('s1', final, 0.8);
    expect(out).toBeNull(); // the matching "alpha beta" fell out of the ring
  });

  it('setRingSize(1) is exactly the legacy single-entry behaviour (a clean prefix hits)', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const sc = new SpeculativeCache();
    sc.setRingSize(1);
    sc.speculate('s1', 'good morning', async () => 'bonjour');
    const out = await sc.resolve('s1', 'good morning everyone', 0.5);
    expect(out).toBe('bonjour');
  });

  it('clear() drops the ring too', async () => {
    const { SpeculativeCache } = await import('../../src/gateway/pipeline/speculative-cache');
    const sc = new SpeculativeCache();
    sc.setRingSize(3);
    sc.speculate('s1', 'one two three', async () => 'Y');
    sc.clear('s1');
    expect(await sc.resolve('s1', 'one two three four', 0.5)).toBeNull();
  });
});

// ── #8 — cap concurrent paid STT race candidates ─────────────────────────────

describe('#8 — resolveMaxSttCandidates + capSttCandidates', () => {
  it('resolveMaxSttCandidates: opt wins, else env, else 0 (unlimited)', async () => {
    const { resolveMaxSttCandidates } = await import('../../server/pipeline-runner');
    // explicit opt
    expect(resolveMaxSttCandidates(2)).toBe(2);
    expect(resolveMaxSttCandidates(3.9)).toBe(3); // floored
    // env fallback
    expect(resolveMaxSttCandidates(undefined, { STT_MAX_CANDIDATES: '2' })).toBe(2);
    // default
    expect(resolveMaxSttCandidates(undefined, {})).toBe(0);
  });

  it('resolveMaxSttCandidates ignores non-positive / non-numeric values', async () => {
    const { resolveMaxSttCandidates } = await import('../../server/pipeline-runner');
    expect(resolveMaxSttCandidates(0)).toBe(0);
    expect(resolveMaxSttCandidates(-1)).toBe(0);
    expect(resolveMaxSttCandidates(undefined, { STT_MAX_CANDIDATES: 'nope' })).toBe(0);
    expect(resolveMaxSttCandidates(undefined, { STT_MAX_CANDIDATES: '0' })).toBe(0);
  });

  it('capSttCandidates: 0/unset = unchanged (legacy); preserves priority order when capping', async () => {
    const { capSttCandidates } = await import('../../server/pipeline-runner');
    const list = ['gpu', 'modal-babelcast', 'cloud', 'ensemble-fallback'];
    // unlimited
    expect(capSttCandidates(list, 0)).toBe(list);
    expect(capSttCandidates(list, -1)).toBe(list);
    // list shorter than cap → unchanged reference
    expect(capSttCandidates(list, 10)).toBe(list);
    // cap to 2 → keep the two highest-priority (cheapest/most-likely) legs
    expect(capSttCandidates(list, 2)).toEqual(['gpu', 'modal-babelcast']);
  });

  it('capSttCandidates never starves the race (keeps at least one)', async () => {
    const { capSttCandidates } = await import('../../server/pipeline-runner');
    expect(capSttCandidates(['gpu', 'cloud'], 1)).toEqual(['gpu']);
  });
});
