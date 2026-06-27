import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { raceSTT } from '../../src/proxy/routes/stt-race';
import type { STTProvider, STTResponse } from '../../src/gateway/providers/cloud/types';

function makeProvider(id: string, result: Partial<STTResponse> = {}, delayMs = 0): STTProvider {
  return {
    providerId: id as any,
    getModels: () => [],
    isConfigured: () => true,
    transcribe: vi.fn(async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { text: 'hello', language: 'en', ...result };
    }),
  };
}

function makeFailProvider(id: string, error: Error | string, delayMs = 0): STTProvider {
  return {
    providerId: id as any,
    getModels: () => [],
    isConfigured: () => true,
    transcribe: vi.fn(async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      throw typeof error === 'string' ? new Error(error) : error;
    }),
  };
}

const AUDIO = Buffer.from([1, 2, 3]);

describe('raceSTT', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Zero-provider guard ────────────────────────────────────────────────────

  it('throws when no providers given', async () => {
    await expect(raceSTT(AUDIO, 'whisper', [])).rejects.toThrow('No STT providers to race');
  });

  // ── Single-provider shortcut ───────────────────────────────────────────────

  it('single provider: returns result with latency', async () => {
    const p = makeProvider('groq');
    const res = await raceSTT(AUDIO, 'whisper-large', [p]);
    expect(res.result.text).toBe('hello');
    expect(res.provider).toBe('groq');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('single provider: passes audio, model, language, prompt', async () => {
    const p = makeProvider('groq');
    await raceSTT(AUDIO, 'whisper', [p], { language: 'fr', prompt: 'ctx' });
    expect(p.transcribe).toHaveBeenCalledWith({ audio: AUDIO, model: 'whisper', language: 'fr', prompt: 'ctx' });
  });

  it('single provider: throws when transcription fails', async () => {
    const p = makeFailProvider('groq', 'network error');
    await expect(raceSTT(AUDIO, 'whisper', [p])).rejects.toThrow('network error');
  });

  // ── Multi-provider racing ──────────────────────────────────────────────────

  it('two providers: returns fastest winner', async () => {
    const fast = makeProvider('fast', { text: 'fast result' }, 10);
    const slow = makeProvider('slow', { text: 'slow result' }, 200);

    const promise = raceSTT(AUDIO, 'whisper', [fast, slow]);
    await vi.advanceTimersByTimeAsync(50);
    const res = await promise;

    expect(res.provider).toBe('fast');
    expect(res.result.text).toBe('fast result');
  });

  it('two providers: falls back to second if first fails', async () => {
    const fail = makeFailProvider('bad', 'provider error', 0);
    const ok = makeProvider('good', { text: 'good result' }, 10);

    const promise = raceSTT(AUDIO, 'whisper', [fail, ok]);
    await vi.advanceTimersByTimeAsync(50);
    const res = await promise;

    expect(res.provider).toBe('good');
    expect(res.result.text).toBe('good result');
  });

  it('all providers fail: throws AggregateError', async () => {
    const a = makeFailProvider('p1', 'err-a');
    const b = makeFailProvider('p2', 'err-b');

    await expect(raceSTT(AUDIO, 'whisper', [a, b])).rejects.toBeInstanceOf(AggregateError);
  });

  // ── Empty-text rejection ───────────────────────────────────────────────────

  it('rejects provider returning empty text, falls back to next', async () => {
    const empty = makeProvider('empty', { text: '   ' }, 0);  // whitespace-only → rejected
    const real = makeProvider('real', { text: 'actual words' }, 10);

    const promise = raceSTT(AUDIO, 'whisper', [empty, real]);
    await vi.advanceTimersByTimeAsync(50);
    const res = await promise;

    expect(res.provider).toBe('real');
    expect(res.result.text).toBe('actual words');
  });

  it('all providers return empty text: throws AggregateError', async () => {
    const a = makeProvider('p1', { text: '' });
    const b = makeProvider('p2', { text: '   ' });

    await expect(raceSTT(AUDIO, 'whisper', [a, b])).rejects.toBeInstanceOf(AggregateError);
  });

  // ── Timeout option ─────────────────────────────────────────────────────────

  it('timeout kills slow provider and returns fast one', async () => {
    const fast = makeProvider('fast', { text: 'quick' }, 10);
    const slug = makeProvider('slug', { text: 'late' }, 5000);

    const promise = raceSTT(AUDIO, 'whisper', [fast, slug], { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(50);
    const res = await promise;

    expect(res.provider).toBe('fast');
  });

  it('all providers time out: throws AggregateError', async () => {
    const a = makeProvider('p1', { text: 'a' }, 5000);
    const b = makeProvider('p2', { text: 'b' }, 5000);

    // Attach .rejects handler immediately so the rejection is not "unhandled"
    const racePromise = raceSTT(AUDIO, 'whisper', [a, b], { timeoutMs: 50 });
    const assertion = expect(racePromise).rejects.toBeInstanceOf(AggregateError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  // ── Abort signal ───────────────────────────────────────────────────────────

  it('aborts immediately if signal already aborted (single provider)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const p = makeProvider('groq');

    await expect(raceSTT(AUDIO, 'whisper', [p], undefined, ctrl.signal)).rejects.toThrow('Aborted');
    expect(p.transcribe).not.toHaveBeenCalled();
  });

  it('aborts immediately if signal already aborted (multi provider)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const a = makeProvider('p1');
    const b = makeProvider('p2');

    await expect(raceSTT(AUDIO, 'whisper', [a, b], undefined, ctrl.signal)).rejects.toThrow('Aborted');
  });

  // ── Returned shape ─────────────────────────────────────────────────────────

  it('latencyMs is a non-negative number', async () => {
    const p = makeProvider('groq');
    const res = await raceSTT(AUDIO, 'whisper', [p]);
    expect(typeof res.latencyMs).toBe('number');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passes language and prompt to all racing providers', async () => {
    const a = makeProvider('p1', { text: 'hi' });
    const b = makeProvider('p2', { text: 'hi' }, 10);
    await raceSTT(AUDIO, 'whisper', [a, b], { language: 'de', prompt: 'hint' });
    expect(a.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'de', prompt: 'hint' }),
    );
    expect(b.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'de', prompt: 'hint' }),
    );
  });

  it('three providers: winner takes all, returns first successful', async () => {
    const p1 = makeFailProvider('p1', 'fail', 0);
    const p2 = makeProvider('p2', { text: 'winner' }, 10);
    const p3 = makeProvider('p3', { text: 'also ok' }, 50);

    const promise = raceSTT(AUDIO, 'whisper', [p1, p2, p3]);
    await vi.advanceTimersByTimeAsync(30);
    const res = await promise;

    expect(res.provider).toBe('p2');
  });
});
