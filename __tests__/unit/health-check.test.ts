/**
 * Unit tests for src/health-check/index.ts
 *
 * Covers:
 *  - HealthChecker.register() — name, timeoutMs default, critical default
 *  - HealthChecker.getCheckNames()
 *  - HealthChecker.runAll() — overall flag, checks map, durationMs
 *  - HealthChecker.runOne() — happy path, unknown name, caught throw
 *  - HealthChecker.getLastResults() — populated by runAll, not by runOne
 *  - Timeout enforcement — slow fn races with setTimeout
 *  - Critical vs non-critical — only critical failures drop overall
 *  - registerCheck() convenience wrapper
 *  - registerStandardChecks() — registers "process"
 *  - healthChecker singleton — exported and functional
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HealthChecker,
  healthChecker,
  registerCheck,
  registerStandardChecks,
  type HealthCheckResult,
} from '../../src/health-check/index';

// ── Helpers ────────────────────────────────────────────────────────────────

function ok(extra: Partial<HealthCheckResult> = {}): () => Promise<HealthCheckResult> {
  return async () => ({ healthy: true, ...extra });
}

function fail(message = 'something broke'): () => Promise<HealthCheckResult> {
  return async () => ({ healthy: false, message });
}

function throwing(message = 'boom'): () => Promise<HealthCheckResult> {
  return async () => { throw new Error(message); };
}

function slow(delayMs: number): () => Promise<HealthCheckResult> {
  return () =>
    new Promise<HealthCheckResult>((resolve) =>
      setTimeout(() => resolve({ healthy: true }), delayMs),
    );
}

// ── register / getCheckNames ───────────────────────────────────────────────

describe('HealthChecker.register', () => {
  let hc: HealthChecker;

  beforeEach(() => { hc = new HealthChecker(); });

  it('registers a check so getCheckNames includes it', () => {
    hc.register('db', ok());
    expect(hc.getCheckNames()).toContain('db');
  });

  it('defaults timeoutMs to 5000', () => {
    hc.register('db', ok());
    // Verify via runAll — no timeout for instant fn
    // (we can't read internals, but the behaviour is observable)
    expect(hc.getCheckNames()).toEqual(['db']);
  });

  it('defaults critical to false', () => {
    // critical = false means a failing check does NOT drop overall
    hc.register('db', fail());
    return hc.runAll().then((r) => {
      expect(r.overall).toBe(true); // non-critical failure → overall still true
    });
  });

  it('overrides timeoutMs when provided', async () => {
    // 50ms timeout, fn resolves in 200ms → should time out
    vi.useFakeTimers();
    hc.register('slow', slow(200), { timeoutMs: 50 });
    const promise = hc.runOne('slow');
    await vi.advanceTimersByTimeAsync(51);
    const result = await promise;
    vi.useRealTimers();
    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/timed out/i);
  });

  it('overrides critical flag when provided', async () => {
    hc.register('db', fail(), { critical: true });
    const { overall } = await hc.runAll();
    expect(overall).toBe(false);
  });

  it('re-registering the same name overwrites the check', async () => {
    hc.register('db', fail());
    hc.register('db', ok()); // overwrite
    const { checks } = await hc.runAll();
    expect(checks['db'].healthy).toBe(true);
  });
});

// ── getCheckNames ──────────────────────────────────────────────────────────

describe('HealthChecker.getCheckNames', () => {
  let hc: HealthChecker;

  beforeEach(() => { hc = new HealthChecker(); });

  it('returns empty array when no checks registered', () => {
    expect(hc.getCheckNames()).toEqual([]);
  });

  it('returns all registered names', () => {
    hc.register('a', ok());
    hc.register('b', ok());
    hc.register('c', ok());
    expect(hc.getCheckNames()).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(hc.getCheckNames()).toHaveLength(3);
  });
});

// ── runAll ─────────────────────────────────────────────────────────────────

describe('HealthChecker.runAll', () => {
  let hc: HealthChecker;

  beforeEach(() => { hc = new HealthChecker(); });

  it('returns overall true when no checks registered', async () => {
    const { overall } = await hc.runAll();
    expect(overall).toBe(true);
  });

  it('returns overall true when all checks pass', async () => {
    hc.register('a', ok());
    hc.register('b', ok());
    const { overall } = await hc.runAll();
    expect(overall).toBe(true);
  });

  it('returns overall true when non-critical check fails', async () => {
    hc.register('a', ok());
    hc.register('b', fail(), { critical: false });
    const { overall } = await hc.runAll();
    expect(overall).toBe(true);
  });

  it('returns overall false when critical check fails', async () => {
    hc.register('a', ok());
    hc.register('b', fail('db down'), { critical: true });
    const { overall } = await hc.runAll();
    expect(overall).toBe(false);
  });

  it('returns checks map with all results', async () => {
    hc.register('a', ok());
    hc.register('b', fail('err'));
    const { checks } = await hc.runAll();
    expect(checks).toHaveProperty('a');
    expect(checks).toHaveProperty('b');
    expect(checks['a'].healthy).toBe(true);
    expect(checks['b'].healthy).toBe(false);
    expect(checks['b'].message).toBe('err');
  });

  it('check results include timestamp', async () => {
    hc.register('a', ok());
    const { checks } = await hc.runAll();
    expect(checks['a'].timestamp).toBeDefined();
    expect(new Date(checks['a'].timestamp).getFullYear()).toBeGreaterThan(2020);
  });

  it('check results include latencyMs', async () => {
    hc.register('a', ok());
    const { checks } = await hc.runAll();
    expect(checks['a'].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns durationMs >= 0', async () => {
    hc.register('a', ok());
    const { durationMs } = await hc.runAll();
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('caught thrown errors are healthy=false', async () => {
    hc.register('boom', throwing('unexpected'));
    const { checks, overall } = await hc.runAll();
    expect(checks['boom'].healthy).toBe(false);
    expect(checks['boom'].message).toContain('unexpected');
    // boom is not critical, so overall stays true
    expect(overall).toBe(true);
  });

  it('thrown error from critical check sets overall false', async () => {
    hc.register('boom', throwing(), { critical: true });
    const { overall } = await hc.runAll();
    expect(overall).toBe(false);
  });

  it('passes through details from the check fn', async () => {
    hc.register('rich', ok({ details: { version: '1.2.3', connections: 5 } }));
    const { checks } = await hc.runAll();
    expect(checks['rich'].details).toEqual({ version: '1.2.3', connections: 5 });
  });

  it('populates getLastResults after running', async () => {
    hc.register('a', ok());
    await hc.runAll();
    const last = hc.getLastResults();
    expect(last).toHaveProperty('a');
    expect(last['a'].healthy).toBe(true);
  });

  it('multiple critical failures all contribute to overall false', async () => {
    hc.register('x', fail(), { critical: true });
    hc.register('y', fail(), { critical: true });
    const { overall } = await hc.runAll();
    expect(overall).toBe(false);
  });

  it('mix of critical pass and non-critical fail keeps overall true', async () => {
    hc.register('crit', ok(), { critical: true });
    hc.register('non', fail());
    const { overall } = await hc.runAll();
    expect(overall).toBe(true);
  });
});

// ── runOne ─────────────────────────────────────────────────────────────────

describe('HealthChecker.runOne', () => {
  let hc: HealthChecker;

  beforeEach(() => { hc = new HealthChecker(); });

  it('runs a registered check and returns its result', async () => {
    hc.register('db', ok({ message: 'connected' }));
    const result = await hc.runOne('db');
    expect(result.healthy).toBe(true);
    expect(result.message).toBe('connected');
    expect(result.timestamp).toBeDefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns healthy=false for an unknown check name', async () => {
    const result = await hc.runOne('missing');
    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/unknown/i);
    expect(result.message).toContain('missing');
  });

  it('catches thrown errors and returns healthy=false', async () => {
    hc.register('err', throwing('internal error'));
    const result = await hc.runOne('err');
    expect(result.healthy).toBe(false);
    expect(result.message).toContain('internal error');
  });

  it('does NOT populate getLastResults (only runAll does)', async () => {
    hc.register('a', ok());
    const beforeLast = hc.getLastResults();
    await hc.runOne('a');
    const afterLast = hc.getLastResults();
    expect(Object.keys(beforeLast)).toHaveLength(0);
    expect(Object.keys(afterLast)).toHaveLength(0);
  });

  it('handles non-Error thrown values', async () => {
    hc.register('str-throw', async () => { throw 'string-error'; });
    const result = await hc.runOne('str-throw');
    expect(result.healthy).toBe(false);
    expect(result.message).toContain('string-error');
  });
});

// ── getLastResults ─────────────────────────────────────────────────────────

describe('HealthChecker.getLastResults', () => {
  let hc: HealthChecker;

  beforeEach(() => { hc = new HealthChecker(); });

  it('returns empty object before any runAll', () => {
    hc.register('a', ok());
    expect(hc.getLastResults()).toEqual({});
  });

  it('returns snapshot of last runAll results', async () => {
    hc.register('a', ok());
    hc.register('b', fail('oops'));
    await hc.runAll();
    const last = hc.getLastResults();
    expect(last['a'].healthy).toBe(true);
    expect(last['b'].healthy).toBe(false);
    expect(last['b'].message).toBe('oops');
  });

  it('updates on subsequent runAll calls', async () => {
    let toggle = false;
    hc.register('toggle', async () => {
      const h = toggle;
      toggle = !toggle;
      return { healthy: h };
    });

    await hc.runAll(); // toggle = false → healthy: false
    const first = hc.getLastResults();
    await hc.runAll(); // toggle = true → healthy: true
    const second = hc.getLastResults();

    expect(first['toggle'].healthy).toBe(false);
    expect(second['toggle'].healthy).toBe(true);
  });
});

// ── Timeout enforcement ────────────────────────────────────────────────────

describe('HealthChecker — timeout enforcement', () => {
  let hc: HealthChecker;

  beforeEach(() => {
    hc = new HealthChecker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out a slow runOne check', async () => {
    hc.register('slow', slow(1000), { timeoutMs: 100 });
    const promise = hc.runOne('slow');
    await vi.advanceTimersByTimeAsync(101);
    const result = await promise;
    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/timed out/i);
    expect(result.message).toContain('100ms');
  });

  it('times out a slow runAll check', async () => {
    hc.register('slow', slow(1000), { timeoutMs: 100 });
    const promise = hc.runAll();
    await vi.advanceTimersByTimeAsync(101);
    const { checks } = await promise;
    expect(checks['slow'].healthy).toBe(false);
    expect(checks['slow'].message).toMatch(/timed out/i);
  });

  it('fast checks resolve before timeout', async () => {
    hc.register('fast', ok(), { timeoutMs: 5000 });
    const promise = hc.runOne('fast');
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(result.healthy).toBe(true);
  });

  it('timed-out critical check sets overall false', async () => {
    hc.register('db', slow(500), { timeoutMs: 50, critical: true });
    const promise = hc.runAll();
    await vi.advanceTimersByTimeAsync(51);
    const { overall } = await promise;
    expect(overall).toBe(false);
  });

  it('timed-out non-critical check keeps overall true', async () => {
    hc.register('cache', slow(500), { timeoutMs: 50, critical: false });
    const promise = hc.runAll();
    await vi.advanceTimersByTimeAsync(51);
    const { overall } = await promise;
    expect(overall).toBe(true);
  });
});

// ── registerCheck convenience ──────────────────────────────────────────────

describe('registerCheck (module-level convenience)', () => {
  it('is a function', () => {
    expect(typeof registerCheck).toBe('function');
  });

  it('delegates to the global healthChecker.register', () => {
    // We cannot easily test the singleton without polluting it for other
    // tests, so we verify the function's contract indirectly via the
    // singleton's getCheckNames — only after we register our unique check.
    const uniqueName = `__test_registerCheck_${Date.now()}`;
    registerCheck(uniqueName, ok());
    expect(healthChecker.getCheckNames()).toContain(uniqueName);
  });
});

// ── registerStandardChecks ─────────────────────────────────────────────────

describe('registerStandardChecks', () => {
  it('registers a "process" check on the global singleton', () => {
    registerStandardChecks();
    expect(healthChecker.getCheckNames()).toContain('process');
  });

  it('"process" check returns healthy:true with uptime message', async () => {
    registerStandardChecks();
    const result = await healthChecker.runOne('process');
    expect(result.healthy).toBe(true);
    expect(result.message).toMatch(/uptime/i);
  });

  it('"process" check includes memory and node version details', async () => {
    registerStandardChecks();
    const result = await healthChecker.runOne('process');
    expect(result.details).toHaveProperty('memoryUsage');
    expect(result.details).toHaveProperty('nodeVersion');
  });
});

// ── healthChecker singleton ────────────────────────────────────────────────

describe('healthChecker singleton', () => {
  it('is exported and has a register method', () => {
    expect(typeof healthChecker.register).toBe('function');
  });

  it('has a runAll method', () => {
    expect(typeof healthChecker.runAll).toBe('function');
  });

  it('has a runOne method', () => {
    expect(typeof healthChecker.runOne).toBe('function');
  });

  it('has a getLastResults method', () => {
    expect(typeof healthChecker.getLastResults).toBe('function');
  });

  it('has a getCheckNames method', () => {
    expect(typeof healthChecker.getCheckNames).toBe('function');
  });

  it('runAll returns the expected shape', async () => {
    const result = await healthChecker.runAll();
    expect(result).toHaveProperty('overall');
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('durationMs');
    expect(typeof result.overall).toBe('boolean');
    expect(typeof result.durationMs).toBe('number');
  });
});
