// ── Tier Ranking (cold-start plan A2) ───────────────────────────────────────
// Fake latency observations should reorder the cascade; cost breaks ties;
// providers with no data stay at the end; persistence round-trips.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { GpuTier, ProviderName } from '../src/gpu-providers/deploy-orchestrator';

function mkTier(name: ProviderName): GpuTier {
  // Minimal fake — the ranking code only reads `.name`.
  return {
    name,
    label: name,
    apiKey: 'test',
    // The client is never invoked during reordering, so a stub is fine.
    client: {} as unknown as GpuTier['client'],
  };
}

describe('Tier Ranking — dynamic reorder by observed P50 latency', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-gateway-tier-ranking-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('reorders tiers by observed P50 (fastest first)', async () => {
    const { recordTierLatency, reorderByLatency, __resetTierRankingForTests } = await import('../server/tier-ranking');
    __resetTierRankingForTests();

    // Vast is slow (600s), RunPod is fast (180s), TensorDock middle (300s).
    for (let i = 0; i < 5; i++) {
      recordTierLatency('vast', { totalMs: 600_000 + i * 1000, recordedAt: Date.now() });
      recordTierLatency('runpod', { totalMs: 180_000 + i * 500, recordedAt: Date.now() });
      recordTierLatency('tensordock', { totalMs: 300_000 + i * 800, recordedAt: Date.now() });
    }

    // Input cascade in static order [vast, runpod, tensordock].
    const original = [mkTier('vast'), mkTier('runpod'), mkTier('tensordock')];
    const reordered = reorderByLatency(original);
    expect(reordered.map(t => t.name)).toEqual(['runpod', 'tensordock', 'vast']);
    // Original array not mutated.
    expect(original.map(t => t.name)).toEqual(['vast', 'runpod', 'tensordock']);
  });

  it('keeps providers with no observations at the end, in their original order', async () => {
    const { recordTierLatency, reorderByLatency, __resetTierRankingForTests } = await import('../server/tier-ranking');
    __resetTierRankingForTests();

    recordTierLatency('runpod', { totalMs: 200_000, recordedAt: Date.now() });
    recordTierLatency('vast', { totalMs: 500_000, recordedAt: Date.now() });
    // tensordock + modal have no data.

    const original = [mkTier('vast'), mkTier('runpod'), mkTier('tensordock'), mkTier('modal')];
    const reordered = reorderByLatency(original);
    expect(reordered.map(t => t.name)).toEqual(['runpod', 'vast', 'tensordock', 'modal']);
  });

  it('uses cost prior as tiebreaker when P50 latencies are within 10%', async () => {
    const { recordTierLatency, reorderByLatency, __resetTierRankingForTests } = await import('../server/tier-ranking');
    __resetTierRankingForTests();

    // RunPod and Vast are within 5% of each other → cost prior wins.
    // Cost prior: vast ($0.35) < runpod ($0.45), so vast should come first.
    for (let i = 0; i < 3; i++) {
      recordTierLatency('runpod', { totalMs: 300_000 + i * 500, recordedAt: Date.now() });
      recordTierLatency('vast', { totalMs: 315_000 + i * 500, recordedAt: Date.now() });
    }

    const reordered = reorderByLatency([mkTier('runpod'), mkTier('vast')]);
    expect(reordered.map(t => t.name)).toEqual(['vast', 'runpod']);
  });

  it('returns a single-element input unchanged', async () => {
    const { reorderByLatency } = await import('../server/tier-ranking');
    const input = [mkTier('vast')];
    const reordered = reorderByLatency(input);
    expect(reordered).toHaveLength(1);
    expect(reordered[0].name).toBe('vast');
  });

  it('computes EWMA and P50 correctly on each record', async () => {
    const { recordTierLatency, getTierRanking, __resetTierRankingForTests } = await import('../server/tier-ranking');
    __resetTierRankingForTests();

    recordTierLatency('runpod', { totalMs: 100_000, recordedAt: Date.now() });
    recordTierLatency('runpod', { totalMs: 200_000, recordedAt: Date.now() });
    recordTierLatency('runpod', { totalMs: 300_000, recordedAt: Date.now() });
    const r = getTierRanking('runpod');
    expect(r).not.toBeNull();
    expect(r!.count).toBe(3);
    // P50 of [100, 200, 300] = 200 seconds
    expect(r!.p50Ms).toBe(200_000);
    // EWMA with alpha=0.3:
    //   s0 = 100_000 (first sample seeds EWMA)
    //   s1 = 0.3*200_000 + 0.7*100_000 = 130_000
    //   s2 = 0.3*300_000 + 0.7*130_000 = 181_000
    expect(r!.ewmaMs).toBeCloseTo(181_000, 0);
  });

  it('prunes observations older than 7 days', async () => {
    const { recordTierLatency, getTierRanking, __resetTierRankingForTests, __testing } =
      await import('../server/tier-ranking');
    __resetTierRankingForTests();

    const now = Date.now();
    const oldTs = now - __testing.WINDOW_MS - 60_000; // 7 days + 1 min old
    recordTierLatency('runpod', { totalMs: 999_999, recordedAt: oldTs });
    // The above record is stale relative to the NEXT record (which uses Date.now()).
    recordTierLatency('runpod', { totalMs: 200_000, recordedAt: now });
    const r = getTierRanking('runpod');
    expect(r!.count).toBe(1);
    expect(r!.observations[0].totalMs).toBe(200_000);
  });

  it('persists rankings to ~/.babelcast/tier-ranking.json and reloads across restart', async () => {
    const mod = await import('../server/tier-ranking');
    mod.__resetTierRankingForTests();

    mod.recordTierLatency('runpod', { totalMs: 180_000, recordedAt: Date.now() });
    mod.recordTierLatency('vast', { totalMs: 500_000, recordedAt: Date.now() });
    mod.saveRankingNow();

    const file = join(tmpHome, '.babelcast', 'tier-ranking.json');
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    expect(raw.ranking.runpod).toBeDefined();
    expect(raw.ranking.vast).toBeDefined();

    // Simulate restart.
    vi.resetModules();
    const mod2 = await import('../server/tier-ranking');
    mod2.__resetTierRankingForTests();
    mod2.loadTierRanking();
    const r = mod2.getTierRanking('runpod');
    expect(r).not.toBeNull();
    expect(r!.count).toBe(1);
    expect(r!.p50Ms).toBe(180_000);

    const reordered = mod2.reorderByLatency([mkTier('vast'), mkTier('runpod')]);
    expect(reordered.map(t => t.name)).toEqual(['runpod', 'vast']);
  });

  it('tolerates corrupt tier-ranking.json without throwing', async () => {
    const { mkdirSync, writeFileSync } = await import('fs');
    const dir = join(tmpHome, '.babelcast');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tier-ranking.json'), 'this is not valid JSON at all');

    const mod = await import('../server/tier-ranking');
    mod.__resetTierRankingForTests();
    expect(() => mod.loadTierRanking()).not.toThrow();
    expect(mod.getTierRanking('runpod')).toBeNull();
  });
});
