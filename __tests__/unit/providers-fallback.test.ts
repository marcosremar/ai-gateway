/**
 * Provider Fallback Tests — CooldownTracker, error classification, withProviderFallback
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CooldownTracker,
  isRetryableError,
  isContextWindowError,
  withProviderFallback,
  type FallbackEntry,
} from '../../src/providers/fallback';
import { CreditBlockTracker, hashApiKey } from '../../src/providers/credit-block';
import { CreditExhaustedError } from '../../src/providers/errors';
// ── CooldownTracker ──────────────────────────────────────────────────

describe('CooldownTracker', () => {
  let tracker: CooldownTracker;
  beforeEach(() => { tracker = new CooldownTracker(); });
  it('starts not cooling down', () => {
    expect(tracker.isCoolingDown({ provider: 'groq', model: 'test' })).toBe(false);
  });
  it('enters cooldown after allowedFails failures', () => {
    const entry = { provider: 'groq', model: 'test' };
    tracker.recordFailure(entry, 2, 15_000);
    tracker.recordFailure(entry, 2, 15_000);
    expect(tracker.isCoolingDown(entry)).toBe(true);
  });
  it('does not cooldown below allowedFails', () => {
    const entry = { provider: 'groq', model: 'test' };
    tracker.recordFailure(entry, 5, 15_000);
    expect(tracker.isCoolingDown(entry)).toBe(false);
  });
  it('resets failure count in new rolling window', () => {
    const entry = { provider: 'groq', model: 'test' };
    tracker.recordFailure(entry, 5, 15_000);
    // Force window expiry
    const state = tracker.getState().get('groq:test')!;
    state.windowStart = Date.now() - 61_000;
    tracker.recordFailure(entry, 5, 15_000);
    expect(state.failures).toBeGreaterThanOrEqual(1);
  });
  it('recordSuccess clears cooldown state entirely', () => {
    const entry = { provider: 'groq', model: 'test' };
    tracker.recordFailure(entry, 1, 15_000);
    expect(tracker.isCoolingDown(entry)).toBe(true);
    tracker.recordSuccess(entry);
    expect(tracker.isCoolingDown(entry)).toBe(false);
    expect(tracker.getState().has('groq:test')).toBe(false);
  });
  it('tracks different models independently', () => {
    const e1 = { provider: 'groq', model: 'model-a' };
    const e2 = { provider: 'groq', model: 'model-b' };
    tracker.recordFailure(e1, 1, 15_000);
    expect(tracker.isCoolingDown(e1)).toBe(true);
    expect(tracker.isCoolingDown(e2)).toBe(false);
  });
  it('uses wildcard key for entries without model', () => {
    const entry = { provider: 'groq' };
    tracker.recordFailure(entry, 1, 15_000);
    expect(tracker.isCoolingDown(entry)).toBe(true);
    expect(tracker.isCoolingDown({ provider: 'groq' })).toBe(true);
  });
  it('toJSON/fromJSON round-trip preserves active cooldowns', () => {
    const entry = { provider: 'groq', model: 'test' };
    tracker.recordFailure(entry, 1, 60_000);
    const json = tracker.toJSON();
    expect(Object.keys(json).length).toBeGreaterThan(0);
    const tracker2 = new CooldownTracker();
    tracker2.fromJSON(json);
    expect(tracker2.isCoolingDown(entry)).toBe(true);
  });
  it('toJSON excludes expired cooldowns', async () => {
    const entry = { provider: 'groq', model: 'test' };
    tracker.recordFailure(entry, 1, 1);
    await new Promise(r => setTimeout(r, 50));
    expect(Object.keys(tracker.toJSON()).length).toBe(0);
  });
  it('reputation lookup scales cooldown for low-rep providers', () => {
    const entry = { provider: 'vast', model: 'test' };
    tracker.setReputationLookup(() => 0.2);
    tracker.recordFailure(entry, 1, 15_000);
    const state = tracker.getState().get('vast:test')!;
    expect(state.coolUntil - Date.now()).toBeGreaterThan(15_000 * 2.5);
  });
  it('reputation lookup does not scale for good-rep providers', () => {
    const entry = { provider: 'runpod', model: 'test' };
    tracker.setReputationLookup(() => 0.9);
    tracker.recordFailure(entry, 1, 15_000);
    const state = tracker.getState().get('runpod:test')!;
    expect(state.coolUntil - Date.now()).toBeGreaterThanOrEqual(14_000);
    expect(state.coolUntil - Date.now()).toBeLessThanOrEqual(16_000);
  });
  it('fromJSON ignores expired entries', async () => {
    const entry = { provider: 'groq', model: 'test' };
    tracker.recordFailure(entry, 1, 1);
    await new Promise(r => setTimeout(r, 50));
    const tracker2 = new CooldownTracker();
    tracker2.fromJSON(tracker.toJSON());
    expect(tracker2.isCoolingDown(entry)).toBe(false);
  });
});
// ── Error Classification ──────────────────────────────────────────────
describe('isRetryableError', () => {
  it('returns true for null/undefined', () => {
    expect(isRetryableError(null)).toBe(true);
    expect(isRetryableError(undefined)).toBe(true);
  });
  it('returns true for non-object errors (network/unknown)', () => {
    expect(isRetryableError('some error')).toBe(true);
    expect(isRetryableError(42)).toBe(true);
  });
  it('returns true for timeout errors', () => {
    expect(isRetryableError(new Error('timeout exceeded'))).toBe(true);
  });
  it('returns true for 429 rate limit', () => {
    const err: any = { status: 429, message: 'rate limited' };
    expect(isRetryableError(err)).toBe(true);
  });
  it('returns true for 5xx errors', () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 502 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ status: 504 })).toBe(true);
  });
  it('returns true for 401/402/403 auth errors', () => {
    expect(isRetryableError({ status: 401 })).toBe(true);
    expect(isRetryableError({ status: 402 })).toBe(true);
    expect(isRetryableError({ status: 403 })).toBe(true);
  });
  it('returns true for 404 not found', () => {
    expect(isRetryableError({ status: 404 })).toBe(true);
  });
  it('returns true for context window error', () => {
    expect(isRetryableError(new Error('context_length_exceeded'))).toBe(true);
  });
  it('returns true for retryable error codes', () => {
    expect(isRetryableError({ code: 'model_terms_required' })).toBe(true);
    expect(isRetryableError({ code: 'model_not_found' })).toBe(true);
    expect(isRetryableError({ code: 'model_decommissioned' })).toBe(true);
  });
  it('returns false for non-retryable 400 error', () => {
    expect(isRetryableError({ status: 400, message: 'bad request' })).toBe(false);
  });
  it('extracts status from err.status', () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });
  it('extracts status from err.response.status', () => {
    expect(isRetryableError({ response: { status: 500 } })).toBe(true);
  });
  it('extracts status from error message text', () => {
    expect(isRetryableError(new Error('Request failed with status 503'))).toBe(true);
  });
});
describe('isContextWindowError', () => {
  it('detects context_length_exceeded in message', () => {
    expect(isContextWindowError(new Error('context_length_exceeded'))).toBe(true);
  });
  it('detects "context window" in message', () => {
    expect(isContextWindowError(new Error('Exceeded context window limit'))).toBe(true);
  });
  it('detects "maximum context" in message', () => {
    expect(isContextWindowError(new Error('maximum context length reached'))).toBe(true);
  });
  it('detects "context too long" in message', () => {
    expect(isContextWindowError(new Error('context too long'))).toBe(true);
  });
  it('detects "tokens exceed" in message', () => {
    expect(isContextWindowError(new Error('tokens exceed model limit'))).toBe(true);
  });
  it('detects "prompt is too long" in message', () => {
    expect(isContextWindowError(new Error('prompt is too long'))).toBe(true);
  });
  it('detects "input too long" in message', () => {
    expect(isContextWindowError(new Error('input too long'))).toBe(true);
  });
  it('detects "too many tokens" in message', () => {
    expect(isContextWindowError(new Error('too many tokens in request'))).toBe(true);
  });
  it('detects patterns in error code', () => {
    expect(isContextWindowError({ code: 'CONTEXT_LENGTH_EXCEEDED', message: '' })).toBe(true);
  });
  it('returns false for normal errors', () => {
    expect(isContextWindowError(new Error('rate limited'))).toBe(false);
    expect(isContextWindowError(new Error('server error'))).toBe(false);
  });
  it('returns false for null/undefined', () => {
    expect(isContextWindowError(null)).toBe(false);
    expect(isContextWindowError(undefined)).toBe(false);
  });
});
// ── withProviderFallback ──────────────────────────────────────────────
describe('withProviderFallback', () => {
  const chain: FallbackEntry[] = [
    { provider: 'groq', model: 'whisper-v3' },
    { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
  ];
  it('returns result from first provider', async () => {
    const result = await withProviderFallback(
      chain,
      async (entry) => `ok-${entry.provider}`,
      { timeoutMs: 5_000, cooldownTracker: new CooldownTracker() },
    );
    expect(result.result).toBe('ok-groq');
    expect(result.usedProvider).toBe('groq');
    expect(result.usedModel).toBe('whisper-v3');
    expect(result.attempts).toBe(1);
  });
  it('falls back to second provider on error', async () => {
    const result = await withProviderFallback(
      chain,
      async (entry) => {
        if (entry.provider === 'groq') {
          const err: any = new Error('rate limited');
          err.status = 429;
          throw err;
        }
        return `ok-${entry.provider}`;
      },
      { timeoutMs: 5_000, cooldownTracker: new CooldownTracker() },
    );
    expect(result.result).toBe('ok-openai');
    expect(result.usedProvider).toBe('openai');
  });
  it('throws on empty chain', async () => {
    await expect(
      withProviderFallback([], async () => 'ok', {}),
    ).rejects.toThrow('Empty provider fallback chain');
  });
  it('accepts string as options (logPrefix)', async () => {
    const result = await withProviderFallback(
      [{ provider: 'groq', model: 'test' }],
      async () => 'result',
      '[test-prefix]',
    );
    expect(result.result).toBe('result');
  });
  it('retries 5xx with retriesPerProvider > 0', async () => {
    let attempts = 0;
    const result = await withProviderFallback(
      [{ provider: 'groq', model: 'test' }],
      async () => {
        attempts++;
        if (attempts < 2) {
          const err: any = new Error('server error');
          err.status = 500;
          throw err;
        }
        return 'recovered';
      },
      { timeoutMs: 5_000, retriesPerProvider: 2, retryBaseDelayMs: 10, cooldownTracker: new CooldownTracker() },
    );
    expect(result.result).toBe('recovered');
    expect(attempts).toBe(2);
  });
  it('does not retry 429 (moves to next provider)', async () => {
    let groqAttempts = 0;
    const result = await withProviderFallback(
      chain,
      async (entry) => {
        if (entry.provider === 'groq') {
          groqAttempts++;
          const err: any = new Error('rate limited');
          err.status = 429;
          throw err;
        }
        return `ok-${entry.provider}`;
      },
      { timeoutMs: 5_000, retriesPerProvider: 2, cooldownTracker: new CooldownTracker() },
    );
    expect(result.result).toBe('ok-openai');
    expect(groqAttempts).toBe(1);
  });
  it('aborts on non-retryable 400 error', async () => {
    await expect(
      withProviderFallback(
        chain,
        async () => {
          const err: any = new Error('invalid request');
          err.status = 400;
          throw err;
        },
        { timeoutMs: 5_000, cooldownTracker: new CooldownTracker() },
      ),
    ).rejects.toThrow('invalid request');
  });
  it('context window error triggers fallback', async () => {
    const result = await withProviderFallback(
      chain,
      async (entry) => {
        if (entry.provider === 'groq') throw new Error('context_length_exceeded');
        return 'ok-openai';
      },
      { timeoutMs: 5_000, cooldownTracker: new CooldownTracker() },
    );
    expect(result.result).toBe('ok-openai');
    expect(result.usedProvider).toBe('openai');
  });
  it('context window fallback inserts upgraded model', async () => {
    const fullChain: FallbackEntry[] = [
      { provider: 'groq', model: 'llama-3.1-8b-instant' },
      { provider: 'openai', model: 'gpt-4o-mini' },
    ];
    const result = await withProviderFallback(
      fullChain,
      async (entry) => {
        if (entry.model === 'llama-3.1-8b-instant') throw new Error('context_length_exceeded');
        return `ok-${entry.model}`;
      },
      {
        timeoutMs: 5_000,
        cooldownTracker: new CooldownTracker(),
        contextWindowFallbacks: { 'llama-3.1-8b-instant': 'llama-3.3-70b-versatile' },
      },
    );
    expect(result.result).toContain('llama-3.3-70b-versatile');
  });
  it('skips credit-blocked providers', async () => {
    const creditTracker = new CreditBlockTracker();
    const keyHash = hashApiKey('test-key');
    creditTracker.recordBlock('groq', keyHash);
    const result = await withProviderFallback(
      chain,
      async (entry) => `ok-${entry.provider}`,
      {
        timeoutMs: 5_000,
        creditBlockTracker: creditTracker,
        apiKeyHashes: { groq: keyHash },
        cooldownTracker: new CooldownTracker(),
      },
    );
    expect(result.result).toBe('ok-openai');
    expect(result.usedProvider).toBe('openai');
  });
  it('throws when all providers are credit-blocked', async () => {
    const creditTracker = new CreditBlockTracker();
    const k1 = hashApiKey('key1');
    const k2 = hashApiKey('key2');
    creditTracker.recordBlock('groq', k1);
    creditTracker.recordBlock('openai', k2);
    await expect(
      withProviderFallback(
        chain,
        async () => 'never',
        {
          timeoutMs: 5_000,
          creditBlockTracker: creditTracker,
          apiKeyHashes: { groq: k1, openai: k2 },
          cooldownTracker: new CooldownTracker(),
        },
      ),
    ).rejects.toThrow();
  });
  it('skips providers in cooldown', async () => {
    const ct = new CooldownTracker();
    ct.recordFailure({ provider: 'groq', model: 'whisper-v3' }, 1, 60_000);
    const result = await withProviderFallback(
      chain,
      async (entry) => `ok-${entry.provider}`,
      { timeoutMs: 5_000, cooldownTracker: ct },
    );
    expect(result.result).toBe('ok-openai');
  });
  it('ignores cooldown when all providers are cooling down', async () => {
    const ct = new CooldownTracker();
    ct.recordFailure({ provider: 'groq', model: 'whisper-v3' }, 1, 60_000);
    ct.recordFailure({ provider: 'openai', model: 'gpt-4o-mini-transcribe' }, 1, 60_000);
    const result = await withProviderFallback(
      chain,
      async (entry) => `ok-${entry.provider}`,
      { timeoutMs: 5_000, cooldownTracker: ct },
    );
    expect(result.result).toBe('ok-groq');
  });
  it('records success and clears cooldown', async () => {
    const ct = new CooldownTracker();
    ct.recordFailure({ provider: 'groq', model: 'test' }, 1, 60_000);
    await withProviderFallback(
      [{ provider: 'groq', model: 'test' }],
      async () => 'ok',
      { timeoutMs: 5_000, cooldownTracker: ct },
    );
    expect(ct.isCoolingDown({ provider: 'groq', model: 'test' })).toBe(false);
  });
});
