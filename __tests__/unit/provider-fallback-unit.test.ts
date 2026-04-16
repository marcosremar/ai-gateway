/**
 * Provider Fallback Unit Tests (#423-#438)
 *
 * Tests for withProviderFallback in src/providers/fallback.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withProviderFallback,
  CooldownTracker,
  isTimeoutError,
  isContextWindowError,
  isRetryableError,
  type FallbackEntry,
  type FallbackOptions,
} from '../src/providers/fallback';
import { CreditBlockTracker } from '../src/providers/credit-block';
import { CreditExhaustedError } from '../src/providers/errors';

// ── Helpers ──────────────────────────────────────────────────────────────────

function entry(provider: string, model?: string): FallbackEntry {
  return { provider, model };
}

function makeError(status: number, message = ''): Error & { status: number } {
  const err = new Error(message || `HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

function contextError(): Error {
  return new Error('context_length_exceeded: prompt is too long');
}

const silentLogger = {
  debug: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function baseOpts(overrides: Partial<FallbackOptions> = {}): FallbackOptions {
  return {
    logPrefix: '[test]',
    cooldownTracker: new CooldownTracker(),
    creditBlockTracker: new CreditBlockTracker(),
    logger: silentLogger,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('withProviderFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #423 — tries providers in order
  it('tries providers in declared order', async () => {
    const callOrder: string[] = [];
    const chain = [entry('groq', 'whisper'), entry('openai', 'whisper'), entry('fireworks', 'whisper')];
    const fn = async (e: FallbackEntry) => {
      callOrder.push(e.provider);
      if (e.provider !== 'fireworks') throw makeError(500);
      return 'ok';
    };
    const result = await withProviderFallback(chain, fn, baseOpts());
    expect(callOrder).toEqual(['groq', 'openai', 'fireworks']);
    expect(result.usedProvider).toBe('fireworks');
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(3);
  });

  // #424 — skips providers in cooldown
  it('skips providers in cooldown', async () => {
    const tracker = new CooldownTracker();
    const cooledEntry = entry('groq', 'whisper');
    // Manually put groq into cooldown
    tracker.recordFailure(cooledEntry, 1, 60_000);

    const callOrder: string[] = [];
    const chain = [cooledEntry, entry('openai', 'whisper')];
    const fn = async (e: FallbackEntry) => {
      callOrder.push(e.provider);
      return 'ok';
    };
    const result = await withProviderFallback(chain, fn, baseOpts({ cooldownTracker: tracker }));
    expect(callOrder).toEqual(['openai']);
    expect(result.usedProvider).toBe('openai');
  });

  // #425 — does NOT record failures in allCooledDown mode
  it('does not record failures when all providers are cooled down (allCooledDown mode)', async () => {
    const tracker = new CooldownTracker();
    const e1 = entry('groq', 'whisper');
    const e2 = entry('openai', 'whisper');
    // Put both into cooldown
    tracker.recordFailure(e1, 1, 60_000);
    tracker.recordFailure(e2, 1, 60_000);

    const recordSpy = vi.spyOn(tracker, 'recordFailure');

    const chain = [e1, e2];
    let attempt = 0;
    const fn = async (e: FallbackEntry) => {
      attempt++;
      if (attempt < 2) throw makeError(500);
      return 'ok';
    };
    await withProviderFallback(chain, fn, baseOpts({ cooldownTracker: tracker }));
    // recordFailure should NOT be called because allCooledDown = true
    expect(recordSpy).not.toHaveBeenCalled();
  });

  // #426 — records 402 in credit block tracker
  it('records 402 errors in credit block tracker', async () => {
    const creditTracker = new CreditBlockTracker();
    const chain = [entry('groq', 'whisper'), entry('openai', 'whisper')];
    const fn = async (e: FallbackEntry) => {
      if (e.provider === 'groq') throw makeError(402);
      return 'ok';
    };
    await withProviderFallback(chain, fn, baseOpts({
      creditBlockTracker: creditTracker,
      apiKeyHashes: { groq: 'hash123' },
    }));
    expect(creditTracker.isBlocked('groq', 'hash123')).toBe(true);
  });

  // #427 — context window fallback inserts upgrade model
  it('inserts upgraded model on context_length_exceeded', async () => {
    const callOrder: string[] = [];
    const chain = [entry('openai', 'gpt-4o-mini'), entry('groq', 'llama')];
    const fn = async (e: FallbackEntry) => {
      callOrder.push(`${e.provider}/${e.model}`);
      if (e.model === 'gpt-4o-mini') throw contextError();
      if (e.model === 'gpt-4o') return 'upgraded';
      return 'fallback';
    };
    const result = await withProviderFallback(chain, fn, baseOpts({
      contextWindowFallbacks: { 'gpt-4o-mini': 'gpt-4o' },
    }));
    expect(callOrder).toContain('openai/gpt-4o');
    expect(result.result).toBe('upgraded');
    expect(result.usedProvider).toBe('openai');
    expect(result.usedModel).toBe('gpt-4o');
  });

  // #428 — retries per provider with backoff on 5xx
  it('retries on 5xx up to retriesPerProvider times', async () => {
    let attempts = 0;
    const chain = [entry('groq', 'model')];
    const fn = async () => {
      attempts++;
      if (attempts <= 2) throw makeError(500);
      return 'ok';
    };
    const result = await withProviderFallback(chain, fn, baseOpts({
      retriesPerProvider: 2,
      retryBaseDelayMs: 1, // fast for tests
    }));
    expect(attempts).toBe(3);
    expect(result.result).toBe('ok');
  });

  // #429 — non-retryable errors (400 other than context) throw immediately
  it('throws immediately on non-retryable 400 errors', async () => {
    const chain = [entry('groq', 'model'), entry('openai', 'model')];
    const callOrder: string[] = [];
    const fn = async (e: FallbackEntry) => {
      callOrder.push(e.provider);
      throw makeError(400, 'invalid_request: bad input');
    };
    await expect(withProviderFallback(chain, fn, baseOpts())).rejects.toThrow('invalid_request');
    // Should not try the second provider for a 400
    expect(callOrder).toEqual(['groq']);
  });

  // #430 — 401/403 skip retries but move to next provider
  it('moves to next provider on 401 without retrying', async () => {
    const callOrder: string[] = [];
    const chain = [entry('groq', 'model'), entry('openai', 'model')];
    const fn = async (e: FallbackEntry) => {
      callOrder.push(e.provider);
      if (e.provider === 'groq') throw makeError(401);
      return 'ok';
    };
    const result = await withProviderFallback(chain, fn, baseOpts({ retriesPerProvider: 2 }));
    expect(callOrder).toEqual(['groq', 'openai']);
    expect(result.usedProvider).toBe('openai');
  });

  it('moves to next provider on 403 without retrying', async () => {
    const callOrder: string[] = [];
    const chain = [entry('groq', 'model'), entry('openai', 'model')];
    const fn = async (e: FallbackEntry) => {
      callOrder.push(e.provider);
      if (e.provider === 'groq') throw makeError(403);
      return 'ok';
    };
    const result = await withProviderFallback(chain, fn, baseOpts({ retriesPerProvider: 2 }));
    expect(callOrder).toEqual(['groq', 'openai']);
    expect(result.usedProvider).toBe('openai');
  });

  // #431 — timeout errors skip retries but count as failure
  it('moves to next provider on timeout without retrying', async () => {
    const callOrder: string[] = [];
    const chain = [entry('groq', 'model'), entry('openai', 'model')];
    const fn = async (e: FallbackEntry) => {
      callOrder.push(e.provider);
      if (e.provider === 'groq') {
        // Simulate a slow provider that will timeout
        return new Promise((resolve) => setTimeout(resolve, 100));
      }
      return 'ok';
    };
    const result = await withProviderFallback(chain, fn, baseOpts({
      timeoutMs: 10,
      retriesPerProvider: 2,
    }));
    expect(callOrder).toEqual(['groq', 'openai']);
    expect(result.usedProvider).toBe('openai');
  });

  // #432 — returns first successful result
  it('returns the first successful result', async () => {
    const chain = [entry('groq', 'model'), entry('openai', 'model')];
    const fn = async (e: FallbackEntry) => {
      return `result-from-${e.provider}`;
    };
    const result = await withProviderFallback(chain, fn, baseOpts());
    expect(result.result).toBe('result-from-groq');
    expect(result.usedProvider).toBe('groq');
    expect(result.attempts).toBe(1);
  });

  // #433 — throws last error when all fail
  it('throws last error when all providers fail', async () => {
    const chain = [entry('groq', 'model'), entry('openai', 'model')];
    const fn = async (e: FallbackEntry) => {
      throw makeError(500, `fail-${e.provider}`);
    };
    await expect(withProviderFallback(chain, fn, baseOpts())).rejects.toThrow('fail-openai');
  });

  // #434 — throws on empty chain
  it('throws on empty chain', async () => {
    const fn = async () => 'ok';
    await expect(withProviderFallback([], fn, baseOpts())).rejects.toThrow('Empty provider fallback chain');
  });

  // #435 — 429 rate limit moves to next provider
  it('moves to next provider on 429 rate limit', async () => {
    const callOrder: string[] = [];
    const chain = [entry('groq', 'model'), entry('openai', 'model')];
    const fn = async (e: FallbackEntry) => {
      callOrder.push(e.provider);
      if (e.provider === 'groq') throw makeError(429);
      return 'ok';
    };
    const result = await withProviderFallback(chain, fn, baseOpts({ retriesPerProvider: 2 }));
    expect(callOrder).toEqual(['groq', 'openai']);
    expect(result.usedProvider).toBe('openai');
  });

  // #436 — CreditExhaustedError when all providers are credit-blocked
  it('throws CreditExhaustedError when all providers are pre-blocked', async () => {
    const creditTracker = new CreditBlockTracker();
    creditTracker.recordBlock('groq', 'hash1');
    creditTracker.recordBlock('openai', 'hash2');

    const chain = [entry('groq', 'model'), entry('openai', 'model')];
    const fn = async () => 'ok';
    await expect(withProviderFallback(chain, fn, baseOpts({
      creditBlockTracker: creditTracker,
      apiKeyHashes: { groq: 'hash1', openai: 'hash2' },
    }))).rejects.toThrow(CreditExhaustedError);
  });

  // #437 — string options is treated as logPrefix
  it('accepts a string as logPrefix shorthand', async () => {
    const chain = [entry('groq', 'model')];
    const fn = async () => 'ok';
    // Use the module-level cooldown tracker (string option path)
    const result = await withProviderFallback(chain, fn, '[STT]');
    expect(result.result).toBe('ok');
  });

  // #438 — records success clears cooldown
  it('clears cooldown state on successful response', async () => {
    const tracker = new CooldownTracker();
    const e1 = entry('groq', 'model');
    // Record some failures but not enough to enter cooldown
    tracker.recordFailure(e1, 5, 60_000);
    tracker.recordFailure(e1, 5, 60_000);

    const chain = [e1];
    const fn = async () => 'ok';
    await withProviderFallback(chain, fn, baseOpts({ cooldownTracker: tracker }));

    // After success, the cooldown state should be cleared
    expect(tracker.isCoolingDown(e1)).toBe(false);
    const state = tracker.getState().get('groq:model');
    expect(state).toBeUndefined();
  });
});

// ── CooldownTracker unit tests ───────────────────────────────────────────────

describe('CooldownTracker', () => {
  it('is not cooling down initially', () => {
    const tracker = new CooldownTracker();
    expect(tracker.isCoolingDown(entry('groq', 'model'))).toBe(false);
  });

  it('enters cooldown after allowedFails failures', () => {
    const tracker = new CooldownTracker();
    const e = entry('groq', 'model');
    tracker.recordFailure(e, 2, 60_000);
    expect(tracker.isCoolingDown(e)).toBe(false);
    tracker.recordFailure(e, 2, 60_000);
    expect(tracker.isCoolingDown(e)).toBe(true);
  });

  it('serializes and deserializes cooldown state', () => {
    const tracker = new CooldownTracker();
    const e = entry('groq', 'model');
    tracker.recordFailure(e, 1, 60_000);

    const json = tracker.toJSON();
    expect(Object.keys(json)).toHaveLength(1);

    const restored = new CooldownTracker();
    restored.fromJSON(json);
    expect(restored.isCoolingDown(e)).toBe(true);
  });
});

// ── Error classification tests ───────────────────────────────────────────────

describe('error classification helpers', () => {
  it('isContextWindowError detects context_length_exceeded', () => {
    expect(isContextWindowError(new Error('context_length_exceeded: ...'))).toBe(true);
    expect(isContextWindowError(new Error('too many tokens in input'))).toBe(true);
    expect(isContextWindowError(new Error('something else'))).toBe(false);
    expect(isContextWindowError(null)).toBe(false);
  });

  it('isRetryableError returns true for 5xx', () => {
    expect(isRetryableError(makeError(500))).toBe(true);
    expect(isRetryableError(makeError(502))).toBe(true);
  });

  it('isRetryableError returns false for 400 (non-context)', () => {
    expect(isRetryableError(makeError(400))).toBe(false);
  });

  it('isRetryableError returns true for network/unknown errors', () => {
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableError(null)).toBe(true);
  });
});
