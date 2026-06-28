/**
 * Unit tests for src/retry-policy/index.ts
 *
 * Tests RetryPolicy execution, backoff strategies, stats tracking, and presets.
 * All delays are mocked to zero so the suite runs in <100ms.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryPolicy, createRetryPolicy, RetryPolicies } from '../src/retry-policy/index';

vi.useFakeTimers();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run an async operation that needs fake-timer advancement.
 * Attaches the expectation BEFORE advancing timers so rejections are always
 * handled and never surface as unhandled-rejection warnings.
 */
async function expectWithTimers<T>(
  fn: () => Promise<T>,
): Promise<{ promise: Promise<T> }> {
  const promise = fn();
  await vi.runAllTimersAsync();
  return { promise };
}

/** A function that fails N times then succeeds. */
function failThenSucceed(failCount: number, value = 'ok') {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= failCount) throw new Error(`fail #${calls}`);
    return value;
  };
}

/** A function that always throws. */
function alwaysFails(msg = 'permanent') {
  return async () => { throw new Error(msg); };
}

/**
 * Execute a policy where the fn always fails, advancing fake timers so retries
 * run, and asserting the final promise rejects with the expected message.
 */
async function runFailingPolicy(policy: RetryPolicy, msg = 'permanent') {
  const [result] = await Promise.allSettled([
    (async () => {
      const p = policy.execute(alwaysFails(msg));
      await vi.runAllTimersAsync();
      return p;
    })(),
  ]);
  if (result.status === 'fulfilled') throw new Error('Expected rejection but got fulfillment');
  return result.reason as Error;
}

// ── execute(): basic success / failure paths ─────────────────────────────────

describe('RetryPolicy.execute — success', () => {
  it('returns value when function succeeds on first try', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 0 });
    const result = await policy.execute(async () => 42);
    expect(result).toBe(42);
  });

  it('returns value when function succeeds after 1 failure', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, backoff: 'fixed', baseDelayMs: 1 });
    const fn = failThenSucceed(1, 'win');
    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      policy.execute(fn),
    ]);
    expect(result).toBe('win');
  });

  it('returns value when function succeeds after maxAttempts-1 failures', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, backoff: 'fixed', baseDelayMs: 1 });
    const fn = failThenSucceed(2, 'success');
    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      policy.execute(fn),
    ]);
    expect(result).toBe('success');
  });

  it('propagates the exact return value from the wrapped function', async () => {
    const policy = new RetryPolicy({ maxAttempts: 1 });
    const obj = { a: 1 };
    expect(await policy.execute(async () => obj)).toBe(obj);
  });
});

describe('RetryPolicy.execute — failure', () => {
  it('throws after all attempts are exhausted', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, backoff: 'fixed', baseDelayMs: 1 });
    await expect(
      Promise.all([vi.runAllTimersAsync(), policy.execute(alwaysFails('boom'))]).then(([, v]) => v),
    ).rejects.toThrow('boom');
  });

  it('throws immediately with maxAttempts=1 (no retry)', async () => {
    const policy = new RetryPolicy({ maxAttempts: 1 });
    await expect(policy.execute(alwaysFails('instant'))).rejects.toThrow('instant');
  });

  it('wraps non-Error throws in an Error', async () => {
    const policy = new RetryPolicy({ maxAttempts: 1 });
    await expect(
      policy.execute(async () => { throw 'string-error'; }),
    ).rejects.toThrow('string-error');
  });

  it('throws immediately when isRetryable returns false', async () => {
    const policy = new RetryPolicy({
      maxAttempts: 5,
      isRetryable: (e) => !e.message.includes('fatal'),
    });
    await expect(
      policy.execute(async () => { throw new Error('fatal error'); }),
    ).rejects.toThrow('fatal error');
  });

  it('retries on retryable errors, stops on non-retryable', async () => {
    let calls = 0;
    const policy = new RetryPolicy({
      maxAttempts: 5,
      backoff: 'fixed',
      baseDelayMs: 1,
      isRetryable: (e) => e.message === 'transient',
    });
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      throw new Error('fatal');
    };
    await expect(
      Promise.all([vi.runAllTimersAsync(), policy.execute(fn)]).then(([, v]) => v),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(3);
  });
});

// ── onRetry callback ──────────────────────────────────────────────────────────

describe('RetryPolicy.execute — onRetry callback', () => {
  it('calls onRetry with attempt number and delay', async () => {
    const calls: Array<{ attempt: number; delayMs: number }> = [];
    const policy = new RetryPolicy({
      maxAttempts: 3,
      backoff: 'fixed',
      baseDelayMs: 10,
      onRetry: (attempt, _err, delay) => calls.push({ attempt, delayMs: delay }),
    });
    const fn = failThenSucceed(2);
    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      policy.execute(fn),
    ]);
    expect(result).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ attempt: 1, delayMs: 10 });
    expect(calls[1]).toMatchObject({ attempt: 2, delayMs: 10 });
  });

  it('does not call onRetry when function succeeds on first try', async () => {
    const onRetry = vi.fn();
    const policy = new RetryPolicy({ maxAttempts: 3, onRetry });
    await policy.execute(async () => 'ok');
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('does not call onRetry on the final failing attempt', async () => {
    const calls: number[] = [];
    const policy = new RetryPolicy({
      maxAttempts: 3,
      backoff: 'fixed',
      baseDelayMs: 1,
      onRetry: (a) => calls.push(a),
    });
    await expect(
      Promise.all([vi.runAllTimersAsync(), policy.execute(alwaysFails())]).then(([, v]) => v),
    ).rejects.toThrow();
    // 3 attempts → 2 retries → onRetry called 2 times (not on final attempt)
    expect(calls).toHaveLength(2);
    expect(calls).toEqual([1, 2]);
  });
});

// ── Stats tracking ────────────────────────────────────────────────────────────

describe('RetryPolicy.getStats', () => {
  it('starts with zeroed stats', () => {
    const policy = new RetryPolicy();
    expect(policy.getStats()).toEqual({
      executions: 0,
      successes: 0,
      failures: 0,
      successRate: 0,
    });
  });

  it('increments executions and successes on success', async () => {
    const policy = new RetryPolicy({ maxAttempts: 1 });
    await policy.execute(async () => 'ok');
    await policy.execute(async () => 'ok');
    const s = policy.getStats();
    expect(s.executions).toBe(2);
    expect(s.successes).toBe(2);
    expect(s.failures).toBe(0);
    expect(s.successRate).toBe(1);
  });

  it('increments executions and failures on exhaustion', async () => {
    const policy = new RetryPolicy({ maxAttempts: 2, backoff: 'fixed', baseDelayMs: 1 });
    await expect(
      Promise.all([vi.runAllTimersAsync(), policy.execute(alwaysFails())]).then(([, v]) => v),
    ).rejects.toThrow();
    const s = policy.getStats();
    expect(s.executions).toBe(1);
    expect(s.successes).toBe(0);
    expect(s.failures).toBe(1);
    expect(s.successRate).toBe(0);
  });

  it('counts retried-then-succeeded execution as 1 success', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, backoff: 'fixed', baseDelayMs: 1 });
    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      policy.execute(failThenSucceed(1)),
    ]);
    expect(result).toBe('ok');
    const s = policy.getStats();
    expect(s.executions).toBe(1);
    expect(s.successes).toBe(1);
    expect(s.failures).toBe(0);
  });

  it('computes successRate correctly across mixed results', async () => {
    const policy = new RetryPolicy({ maxAttempts: 1 });
    await policy.execute(async () => 'ok');
    await expect(policy.execute(alwaysFails())).rejects.toThrow();
    await policy.execute(async () => 'ok');
    const { successRate } = policy.getStats();
    expect(successRate).toBeCloseTo(2 / 3);
  });
});

describe('RetryPolicy.resetStats', () => {
  it('clears all counters', async () => {
    const policy = new RetryPolicy({ maxAttempts: 1 });
    await policy.execute(async () => 'ok');
    policy.resetStats();
    expect(policy.getStats()).toEqual({
      executions: 0,
      successes: 0,
      failures: 0,
      successRate: 0,
    });
  });

  it('accumulates fresh stats after reset', async () => {
    const policy = new RetryPolicy({ maxAttempts: 1 });
    await policy.execute(async () => 'first');
    policy.resetStats();
    await policy.execute(async () => 'second');
    expect(policy.getStats().executions).toBe(1);
  });
});

// ── Backoff calculation ───────────────────────────────────────────────────────

describe('backoff strategies via onRetry delayMs', () => {
  it('fixed: delay is always baseDelayMs', async () => {
    const delays: number[] = [];
    const policy = new RetryPolicy({
      maxAttempts: 4,
      backoff: 'fixed',
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      onRetry: (_a, _e, d) => delays.push(d),
    });
    await expect(
      Promise.all([vi.runAllTimersAsync(), policy.execute(alwaysFails())]).then(([, v]) => v),
    ).rejects.toThrow();
    expect(delays).toEqual([100, 100, 100]);
  });

  it('linear: delay grows linearly', async () => {
    const delays: number[] = [];
    const policy = new RetryPolicy({
      maxAttempts: 4,
      backoff: 'linear',
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      onRetry: (_a, _e, d) => delays.push(d),
    });
    await expect(
      Promise.all([vi.runAllTimersAsync(), policy.execute(alwaysFails())]).then(([, v]) => v),
    ).rejects.toThrow();
    // attempt 0 → 100*(0+1)=100, attempt 1 → 200, attempt 2 → 300
    expect(delays).toEqual([100, 200, 300]);
  });

  it('exponential: delay doubles each retry', async () => {
    const delays: number[] = [];
    const policy = new RetryPolicy({
      maxAttempts: 4,
      backoff: 'exponential',
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      onRetry: (_a, _e, d) => delays.push(d),
    });
    await expect(
      Promise.all([vi.runAllTimersAsync(), policy.execute(alwaysFails())]).then(([, v]) => v),
    ).rejects.toThrow();
    // 100*2^0=100, 100*2^1=200, 100*2^2=400
    expect(delays).toEqual([100, 200, 400]);
  });

  it('exponential: caps at maxDelayMs', async () => {
    const delays: number[] = [];
    const policy = new RetryPolicy({
      maxAttempts: 5,
      backoff: 'exponential',
      baseDelayMs: 1000,
      maxDelayMs: 2000,
      onRetry: (_a, _e, d) => delays.push(d),
    });
    await expect(
      Promise.all([vi.runAllTimersAsync(), policy.execute(alwaysFails())]).then(([, v]) => v),
    ).rejects.toThrow();
    for (const d of delays) expect(d).toBeLessThanOrEqual(2000);
    expect(delays[delays.length - 1]).toBe(2000);
  });

  it('jittered: with jitter=0 matches exponential', async () => {
    const delays: number[] = [];
    const policy = new RetryPolicy({
      maxAttempts: 3,
      backoff: 'jittered',
      baseDelayMs: 100,
      jitter: 0,
      maxDelayMs: 10_000,
      onRetry: (_a, _e, d) => delays.push(d),
    });
    await expect(
      Promise.all([vi.runAllTimersAsync(), policy.execute(alwaysFails())]).then(([, v]) => v),
    ).rejects.toThrow();
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
  });
});

// ── createRetryPolicy factory ─────────────────────────────────────────────────

describe('createRetryPolicy', () => {
  it('returns a RetryPolicy instance', () => {
    expect(createRetryPolicy()).toBeInstanceOf(RetryPolicy);
  });

  it('passes options through', async () => {
    const onRetry = vi.fn();
    const policy = createRetryPolicy({ maxAttempts: 2, backoff: 'fixed', baseDelayMs: 1, onRetry });
    await expect(
      Promise.all([vi.runAllTimersAsync(), policy.execute(alwaysFails())]).then(([, v]) => v),
    ).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

// ── RetryPolicies presets ─────────────────────────────────────────────────────

describe('RetryPolicies presets', () => {
  it('Quick preset succeeds after 1 failure', async () => {
    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      RetryPolicies.Quick.execute(failThenSucceed(1, 'fast')),
    ]);
    expect(result).toBe('fast');
  });

  it('Standard preset succeeds after 2 failures', async () => {
    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      RetryPolicies.Standard.execute(failThenSucceed(2, 'std')),
    ]);
    expect(result).toBe('std');
  });

  it('Conservative preset exhausts after 2 failures (maxAttempts=2)', async () => {
    await expect(
      Promise.all([
        vi.runAllTimersAsync(),
        RetryPolicies.Conservative.execute(alwaysFails()),
      ]).then(([, v]) => v),
    ).rejects.toThrow();
  });

  it('Aggressive preset succeeds after 4 failures (maxAttempts=5)', async () => {
    const [, result] = await Promise.all([
      vi.runAllTimersAsync(),
      RetryPolicies.Aggressive.execute(failThenSucceed(4, 'agg')),
    ]);
    expect(result).toBe('agg');
  });
});
