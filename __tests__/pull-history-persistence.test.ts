// ── Pull History Persistence ────────────────────────────────────────────────
// Validates that the pull-time-estimator's in-memory history survives a
// gateway restart via ~/.babelcast/pull-history.json. Mirrors the cooldown
// persistence pattern (ADR-009): toJSON/fromJSON round-trip + atomic write.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Pull History Persistence', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    // Redirect ~/.babelcast/ to a temp dir so tests don't touch real state.
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-gateway-pull-history-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Reset module registry so each test gets a fresh in-memory history.
    vi.resetModules();
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('round-trips history across simulated restart', async () => {
    // ── Phase 1: populate and save ─────────────────────────────────────────
    const estMod = await import('../src/gpu-providers/pull-time-estimator');
    const persistMod = await import('../server/pull-history-persistence');

    persistMod.initPullHistoryPersistence();

    estMod.recordPullTime('myimage:latest', 120, 500, 'vast:host-abc', 180);
    estMod.recordPullTime('myimage:latest', 130, 500, 'vast:host-abc', 190);
    estMod.recordPullTime('other:latest', 60, 1000, 'runpod:host-xyz', 90);

    // Force a synchronous flush — debounce would take 10s.
    persistMod.savePullHistoryNow();

    const file = join(tmpHome, '.babelcast', 'pull-history.json');
    expect(existsSync(file)).toBe(true);
    const rawSaved = JSON.parse(readFileSync(file, 'utf-8'));
    expect(Array.isArray(rawSaved.records)).toBe(true);
    expect(rawSaved.records).toHaveLength(3);
    expect(typeof rawSaved.savedAt).toBe('number');

    // ── Phase 2: simulate restart — fresh module, load from disk ──────────
    vi.resetModules();
    const estMod2 = await import('../src/gpu-providers/pull-time-estimator');
    const persistMod2 = await import('../server/pull-history-persistence');

    // Before init: fresh module has empty history.
    expect(estMod2.getHistorySize()).toBe(0);

    persistMod2.initPullHistoryPersistence();

    // After init: 3 records restored.
    expect(estMod2.getHistorySize()).toBe(3);
    expect(estMod2.getObservationCount('myimage:latest')).toBe(2);
    expect(estMod2.getObservationCount('myimage:latest', 'vast:host-abc')).toBe(2);
    expect(estMod2.getObservationCount('other:latest')).toBe(1);

    // And the estimator now uses the restored data (3 host-specific observations
    // → 'historical' confidence, tight avg × 1.3 timeout rather than the 30-min
    // default first-run fallback).
    estMod2.recordPullTime('myimage:latest', 140, 500, 'vast:host-abc', 200);
    const est = await estMod2.estimatePullTimeout({
      dockerImage: 'myimage:latest',
      inetDownMbps: 500,
      hostKey: 'vast:host-abc',
    });
    expect(est.confidence).toBe('historical');
    expect(est.basis).toContain('host vast:host-abc');
  });

  it('tolerates missing file (first-ever startup)', async () => {
    const persistMod = await import('../server/pull-history-persistence');
    const estMod = await import('../src/gpu-providers/pull-time-estimator');
    // Should not throw even though no file exists.
    expect(() => persistMod.initPullHistoryPersistence()).not.toThrow();
    expect(estMod.getHistorySize()).toBe(0);
  });

  it('tolerates corrupt JSON without throwing', async () => {
    const dir = join(tmpHome, '.babelcast');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pull-history.json'), '{ this is not: valid json');

    const persistMod = await import('../server/pull-history-persistence');
    const estMod = await import('../src/gpu-providers/pull-time-estimator');
    expect(() => persistMod.initPullHistoryPersistence()).not.toThrow();
    // Corrupt file → empty history, gateway keeps running.
    expect(estMod.getHistorySize()).toBe(0);
  });

  it('drops invalid records but keeps valid ones', async () => {
    const dir = join(tmpHome, '.babelcast');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pull-history.json'), JSON.stringify({
      records: [
        { dockerImage: 'ok:1', hostKey: 'h1', inetDownMbps: 500, pullTimeS: 60, bootTimeS: 100, recordedAt: Date.now() },
        { dockerImage: 123 /* wrong type */, hostKey: 'h2', pullTimeS: 60, recordedAt: Date.now() },
        'not an object',
        null,
        { dockerImage: 'ok:2', hostKey: 'h3', inetDownMbps: 800, pullTimeS: 30, bootTimeS: 50, recordedAt: Date.now() },
      ],
      savedAt: Date.now(),
    }));

    const persistMod = await import('../server/pull-history-persistence');
    const estMod = await import('../src/gpu-providers/pull-time-estimator');
    persistMod.initPullHistoryPersistence();
    expect(estMod.getHistorySize()).toBe(2);
  });

  it('debounced writes coalesce inside the 10s window', async () => {
    vi.useFakeTimers();
    try {
      const estMod = await import('../src/gpu-providers/pull-time-estimator');
      const persistMod = await import('../server/pull-history-persistence');

      persistMod.initPullHistoryPersistence();

      const file = join(tmpHome, '.babelcast', 'pull-history.json');
      expect(existsSync(file)).toBe(false);

      // 3 rapid writes in <1s — should schedule a single debounced flush.
      estMod.recordPullTime('img:1', 10, 500, 'h1', 20);
      estMod.recordPullTime('img:1', 12, 500, 'h1', 22);
      estMod.recordPullTime('img:1', 14, 500, 'h1', 24);
      // Before the debounce elapses: nothing on disk.
      expect(existsSync(file)).toBe(false);

      // Advance past the 10s debounce.
      vi.advanceTimersByTime(11_000);
      // Flush any microtasks scheduled by the timer.
      await vi.runAllTicks();

      expect(existsSync(file)).toBe(true);
      const saved = JSON.parse(readFileSync(file, 'utf-8'));
      expect(saved.records).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
