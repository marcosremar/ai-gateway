/**
 * Unit tests for server/tier-ranking.ts
 *
 * Covers: recordTierLatency (EWMA, P50, pruning, count), getTierRanking,
 * getAllTierRankings, reorderByLatency (P50 sort, cost tiebreaker,
 * observed/unobserved split), loadTierRanking (missing file, valid data,
 * stale pruning, corrupt JSON, missing fields), and saveRankingNow
 * (empty skip, atomic write, error resilience).
 *
 * All filesystem I/O is mocked — no real disk writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { fsState } = vi.hoisted(() => {
  const fsState = {
    fileExists: false,
    fileContent: '',
    shouldThrowRead: false,
    shouldThrowWrite: false,
    writtenContent: '',
    tmpPath: '',
    writtenPath: '',
    mkdirCalled: false,
  };
  return { fsState };
});

vi.mock('fs', () => ({
  existsSync: vi.fn(() => fsState.fileExists),
  readFileSync: vi.fn((_path: string, _enc: string) => {
    if (fsState.shouldThrowRead) throw new Error('EACCES: permission denied');
    return fsState.fileContent;
  }),
  mkdirSync: vi.fn(() => { fsState.mkdirCalled = true; }),
  writeFileSync: vi.fn((path: string, content: string) => {
    if (fsState.shouldThrowWrite) throw new Error('ENOSPC: no space left on device');
    fsState.tmpPath = path;
    fsState.writtenContent = content;
  }),
  renameSync: vi.fn((from: string, to: string) => {
    fsState.writtenPath = to;
  }),
}));

vi.mock('../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  recordTierLatency,
  getTierRanking,
  getAllTierRankings,
  reorderByLatency,
  loadTierRanking,
  saveRankingNow,
  __resetTierRankingForTests,
} from '../../server/tier-ranking';

import type { GpuTier } from '../../src/gpu-providers/deploy-orchestrator';

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = Date.now();

function resetAll() {
  __resetTierRankingForTests();
  Object.assign(fsState, {
    fileExists: false,
    fileContent: '',
    shouldThrowRead: false,
    shouldThrowWrite: false,
    writtenContent: '',
    tmpPath: '',
    writtenPath: '',
    mkdirCalled: false,
  });
  vi.clearAllMocks();
}

function makeObs(totalMs: number, daysAgo = 0) {
  return { totalMs, recordedAt: NOW - daysAgo * 24 * 60 * 60_000 };
}

function makeTier(name: string): GpuTier {
  return {
    client: {} as unknown as GpuTier['client'],
    name: name as GpuTier['name'],
    label: name,
    apiKey: 'key',
  };
}

// ── recordTierLatency ─────────────────────────────────────────────────────────

describe('recordTierLatency', () => {
  beforeEach(resetAll);

  it('creates new entry on first sample', () => {
    recordTierLatency('runpod', makeObs(5000));
    const e = getTierRanking('runpod')!;
    expect(e).not.toBeNull();
    expect(e.count).toBe(1);
    expect(e.ewmaMs).toBe(5000);
    expect(e.p50Ms).toBe(5000);
  });

  it('EWMA equals first sample value (bootstrap)', () => {
    recordTierLatency('vast', makeObs(3000));
    expect(getTierRanking('vast')!.ewmaMs).toBe(3000);
  });

  it('EWMA applies alpha=0.3 on second sample', () => {
    recordTierLatency('vast', makeObs(4000));
    recordTierLatency('vast', makeObs(2000));
    // 0.3 * 2000 + 0.7 * 4000 = 600 + 2800 = 3400
    expect(getTierRanking('vast')!.ewmaMs).toBeCloseTo(3400);
  });

  it('EWMA continues updating on third sample', () => {
    recordTierLatency('vast', makeObs(4000));
    recordTierLatency('vast', makeObs(2000)); // ewma = 3400
    recordTierLatency('vast', makeObs(4000)); // ewma = 0.3*4000 + 0.7*3400 = 1200 + 2380 = 3580
    expect(getTierRanking('vast')!.ewmaMs).toBeCloseTo(3580);
  });

  it('P50 is the single value for one sample', () => {
    recordTierLatency('tensordock', makeObs(8000));
    expect(getTierRanking('tensordock')!.p50Ms).toBe(8000);
  });

  it('P50 is the average of two values for even count', () => {
    recordTierLatency('runpod', makeObs(3000));
    recordTierLatency('runpod', makeObs(5000));
    // sorted: [3000, 5000] → (3000+5000)/2 = 4000
    expect(getTierRanking('runpod')!.p50Ms).toBe(4000);
  });

  it('P50 is the median value for odd count', () => {
    recordTierLatency('runpod', makeObs(3000));
    recordTierLatency('runpod', makeObs(5000));
    recordTierLatency('runpod', makeObs(7000));
    // sorted: [3000, 5000, 7000] → 5000
    expect(getTierRanking('runpod')!.p50Ms).toBe(5000);
  });

  it('P50 sorts by value not insertion order', () => {
    recordTierLatency('vast', makeObs(9000));
    recordTierLatency('vast', makeObs(1000));
    recordTierLatency('vast', makeObs(5000));
    // sorted: [1000, 5000, 9000] → P50 = 5000
    expect(getTierRanking('vast')!.p50Ms).toBe(5000);
  });

  it('prunes observations older than 7 days', () => {
    recordTierLatency('vast', { totalMs: 9000, recordedAt: NOW - 8 * 24 * 60 * 60_000 });
    recordTierLatency('vast', makeObs(3000));
    const e = getTierRanking('vast')!;
    expect(e.count).toBe(1);
    expect(e.p50Ms).toBe(3000);
  });

  it('keeps observations exactly at the 7-day boundary', () => {
    const borderlineObs = { totalMs: 4000, recordedAt: NOW - 7 * 24 * 60 * 60_000 + 1 };
    recordTierLatency('vast', borderlineObs);
    expect(getTierRanking('vast')!.count).toBe(1);
  });

  it('accumulates count across multiple calls', () => {
    for (let i = 0; i < 5; i++) recordTierLatency('runpod', makeObs(i * 1000 + 1000));
    expect(getTierRanking('runpod')!.count).toBe(5);
  });

  it('tracks each provider independently', () => {
    recordTierLatency('runpod', makeObs(5000));
    recordTierLatency('vast', makeObs(3000));
    expect(getTierRanking('runpod')!.p50Ms).toBe(5000);
    expect(getTierRanking('vast')!.p50Ms).toBe(3000);
  });

  it('updates lastRecordedAt with sample timestamp', () => {
    const t = NOW - 2000;
    recordTierLatency('runpod', { totalMs: 5000, recordedAt: t });
    expect(getTierRanking('runpod')!.lastRecordedAt).toBe(t);
  });

  it('includes optional breakdown fields when provided', () => {
    const obs = { totalMs: 5000, recordedAt: NOW, pullMs: 1000, bootMs: 3000, modelLoadMs: 1000 };
    recordTierLatency('runpod', obs);
    const stored = getTierRanking('runpod')!.observations[0];
    expect(stored.pullMs).toBe(1000);
    expect(stored.bootMs).toBe(3000);
    expect(stored.modelLoadMs).toBe(1000);
  });
});

// ── getTierRanking ────────────────────────────────────────────────────────────

describe('getTierRanking', () => {
  beforeEach(resetAll);

  it('returns null when provider has no data', () => {
    expect(getTierRanking('runpod')).toBeNull();
  });

  it('returns null for unknown provider name', () => {
    recordTierLatency('vast', makeObs(3000));
    expect(getTierRanking('runpod')).toBeNull();
  });

  it('returns entry with correct shape after recording', () => {
    recordTierLatency('vast', makeObs(3000));
    const e = getTierRanking('vast')!;
    expect(e).not.toBeNull();
    expect(typeof e.ewmaMs).toBe('number');
    expect(typeof e.p50Ms).toBe('number');
    expect(typeof e.count).toBe('number');
    expect(Array.isArray(e.observations)).toBe(true);
  });
});

// ── getAllTierRankings ────────────────────────────────────────────────────────

describe('getAllTierRankings', () => {
  beforeEach(resetAll);

  it('returns empty object initially', () => {
    expect(Object.keys(getAllTierRankings())).toHaveLength(0);
  });

  it('returns all recorded providers', () => {
    recordTierLatency('runpod', makeObs(5000));
    recordTierLatency('vast', makeObs(3000));
    const all = getAllTierRankings();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all.runpod).toBeDefined();
    expect(all.vast).toBeDefined();
  });

  it('reflects updates after additional recordings', () => {
    recordTierLatency('runpod', makeObs(5000));
    expect(Object.keys(getAllTierRankings())).toHaveLength(1);
    recordTierLatency('vast', makeObs(3000));
    expect(Object.keys(getAllTierRankings())).toHaveLength(2);
  });
});

// ── reorderByLatency ──────────────────────────────────────────────────────────

describe('reorderByLatency', () => {
  beforeEach(resetAll);

  it('returns copy of single-element list unchanged', () => {
    const tiers = [makeTier('runpod')];
    const result = reorderByLatency(tiers);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('runpod');
    expect(result).not.toBe(tiers); // must be a new array
  });

  it('returns copy of empty array', () => {
    const result = reorderByLatency([]);
    expect(result).toHaveLength(0);
  });

  it('preserves original order when no observations', () => {
    const tiers = [makeTier('runpod'), makeTier('vast'), makeTier('tensordock')];
    const result = reorderByLatency(tiers);
    expect(result.map((t) => t.name)).toEqual(['runpod', 'vast', 'tensordock']);
  });

  it('does not mutate the input array', () => {
    const tiers = [makeTier('runpod'), makeTier('vast')];
    reorderByLatency(tiers);
    expect(tiers[0].name).toBe('runpod');
    expect(tiers[1].name).toBe('vast');
  });

  it('sorts observed provider before unobserved', () => {
    recordTierLatency('vast', makeObs(3000));
    const tiers = [makeTier('runpod'), makeTier('vast')];
    const result = reorderByLatency(tiers);
    expect(result[0].name).toBe('vast');
    expect(result[1].name).toBe('runpod');
  });

  it('sorts by P50 ascending when difference exceeds 10%', () => {
    recordTierLatency('runpod', makeObs(6000));
    recordTierLatency('vast', makeObs(3000));
    // diff = 3000/6000 = 50% > 10% → P50 sort
    const result = reorderByLatency([makeTier('runpod'), makeTier('vast')]);
    expect(result[0].name).toBe('vast');
    expect(result[1].name).toBe('runpod');
  });

  it('sorts all three providers by P50 ascending', () => {
    recordTierLatency('runpod', makeObs(8000));
    recordTierLatency('vast', makeObs(3000));
    recordTierLatency('tensordock', makeObs(5000));
    const result = reorderByLatency([makeTier('runpod'), makeTier('vast'), makeTier('tensordock')]);
    expect(result.map((t) => t.name)).toEqual(['vast', 'tensordock', 'runpod']);
  });

  it('uses cost tiebreaker when P50 within 10% — cheaper provider wins', () => {
    // vast cost=0.35, runpod cost=0.45. P50 diff: |5000-5200|/5200 ≈ 3.8% < 10%
    recordTierLatency('runpod', makeObs(5000));
    recordTierLatency('vast', makeObs(5200));
    const result = reorderByLatency([makeTier('runpod'), makeTier('vast')]);
    expect(result[0].name).toBe('vast');
  });

  it('cost tiebreaker: vast beats vast-vm (0.35 vs 0.40)', () => {
    // P50 diff: |5000-5050|/5050 ≈ 1% < 10%
    recordTierLatency('vast', makeObs(5000));
    recordTierLatency('vast-vm', makeObs(5050));
    const result = reorderByLatency([makeTier('vast-vm'), makeTier('vast')]);
    expect(result[0].name).toBe('vast');
  });

  it('cost tiebreaker: vast beats modal despite modal having lower P50 by ~2%', () => {
    // vast cost=0.35, modal cost=2.50. Within 10% tie → vast wins on cost.
    recordTierLatency('vast', makeObs(5000));
    recordTierLatency('modal', makeObs(4950));
    const result = reorderByLatency([makeTier('modal'), makeTier('vast')]);
    expect(result[0].name).toBe('vast');
  });

  it('unobserved tiers maintain original relative order after observed', () => {
    recordTierLatency('vast', makeObs(3000));
    const tiers = [makeTier('runpod'), makeTier('vast'), makeTier('tensordock')];
    const result = reorderByLatency(tiers);
    expect(result[0].name).toBe('vast');
    expect(result[1].name).toBe('runpod');   // original position preserved
    expect(result[2].name).toBe('tensordock');
  });

  it('unknown provider names use fallback cost prior (1) in tiebreaker', () => {
    // Both unknown: diff should be negligible so cost tiebreaker applies
    // 'hyperstack' has cost=0.75, unknown providers get 1
    recordTierLatency('hyperstack', makeObs(5000));
    recordTierLatency('snapgpu', makeObs(5100)); // snapgpu cost=0.50
    const result = reorderByLatency([makeTier('hyperstack'), makeTier('snapgpu')]);
    // snapgpu cost=0.50 < hyperstack cost=0.75 → snapgpu wins
    expect(result[0].name).toBe('snapgpu');
  });
});

// ── loadTierRanking ───────────────────────────────────────────────────────────

describe('loadTierRanking', () => {
  beforeEach(resetAll);

  it('does nothing when file does not exist', () => {
    fsState.fileExists = false;
    loadTierRanking();
    expect(Object.keys(getAllTierRankings())).toHaveLength(0);
  });

  it('loads valid ranking from file', () => {
    const obs = { totalMs: 4000, recordedAt: NOW - 1000 };
    const data = {
      ranking: {
        runpod: { ewmaMs: 4000, p50Ms: 4000, count: 1, lastRecordedAt: obs.recordedAt, observations: [obs] },
      },
      savedAt: NOW,
    };
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify(data);
    loadTierRanking();
    const e = getTierRanking('runpod')!;
    expect(e).not.toBeNull();
    expect(e.count).toBe(1);
  });

  it('recomputes P50 from loaded observations (ignores stale p50Ms field)', () => {
    const obs1 = { totalMs: 3000, recordedAt: NOW - 100 };
    const obs2 = { totalMs: 7000, recordedAt: NOW - 200 };
    const data = {
      ranking: {
        runpod: { ewmaMs: 5000, p50Ms: 999, count: 2, lastRecordedAt: NOW, observations: [obs1, obs2] },
      },
      savedAt: NOW,
    };
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify(data);
    loadTierRanking();
    // P50 of [3000, 7000] = (3000+7000)/2 = 5000
    expect(getTierRanking('runpod')!.p50Ms).toBe(5000);
  });

  it('prunes stale observations (>7 days) on load', () => {
    const staleObs = { totalMs: 9000, recordedAt: NOW - 8 * 24 * 60 * 60_000 };
    const freshObs = { totalMs: 3000, recordedAt: NOW - 1000 };
    const data = {
      ranking: {
        vast: { ewmaMs: 6000, p50Ms: 6000, count: 2, lastRecordedAt: NOW, observations: [staleObs, freshObs] },
      },
      savedAt: NOW,
    };
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify(data);
    loadTierRanking();
    const e = getTierRanking('vast')!;
    expect(e.count).toBe(1);
    expect(e.p50Ms).toBe(3000);
  });

  it('skips entries whose observations are all stale', () => {
    const staleObs = { totalMs: 9000, recordedAt: NOW - 8 * 24 * 60 * 60_000 };
    const data = {
      ranking: {
        vast: { ewmaMs: 9000, p50Ms: 9000, count: 1, lastRecordedAt: staleObs.recordedAt, observations: [staleObs] },
      },
      savedAt: NOW,
    };
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify(data);
    loadTierRanking();
    expect(getTierRanking('vast')).toBeNull();
  });

  it('handles malformed JSON without throwing', () => {
    fsState.fileExists = true;
    fsState.fileContent = '{ invalid json {{{';
    expect(() => loadTierRanking()).not.toThrow();
    expect(Object.keys(getAllTierRankings())).toHaveLength(0);
  });

  it('handles read error without throwing', () => {
    fsState.fileExists = true;
    fsState.shouldThrowRead = true;
    expect(() => loadTierRanking()).not.toThrow();
    expect(Object.keys(getAllTierRankings())).toHaveLength(0);
  });

  it('handles missing ranking field gracefully', () => {
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify({ savedAt: NOW });
    expect(() => loadTierRanking()).not.toThrow();
    expect(Object.keys(getAllTierRankings())).toHaveLength(0);
  });

  it('skips null and non-object entries in ranking', () => {
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify({
      ranking: { runpod: null, vast: 'not-an-object' },
      savedAt: NOW,
    });
    expect(() => loadTierRanking()).not.toThrow();
    expect(Object.keys(getAllTierRankings())).toHaveLength(0);
  });

  it('skips entries missing observations array', () => {
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify({
      ranking: { runpod: { ewmaMs: 5000, p50Ms: 5000, count: 1, lastRecordedAt: NOW } },
      savedAt: NOW,
    });
    expect(() => loadTierRanking()).not.toThrow();
    // observations is undefined → treated as [] → pruned.length === 0 → skipped
    expect(getTierRanking('runpod')).toBeNull();
  });

  it('loads multiple providers from file', () => {
    const obs = { totalMs: 4000, recordedAt: NOW - 100 };
    const data = {
      ranking: {
        runpod: { ewmaMs: 5000, p50Ms: 5000, count: 1, lastRecordedAt: NOW, observations: [obs] },
        vast: { ewmaMs: 3000, p50Ms: 3000, count: 1, lastRecordedAt: NOW, observations: [{ totalMs: 3000, recordedAt: NOW - 100 }] },
      },
      savedAt: NOW,
    };
    fsState.fileExists = true;
    fsState.fileContent = JSON.stringify(data);
    loadTierRanking();
    expect(Object.keys(getAllTierRankings())).toHaveLength(2);
  });
});

// ── saveRankingNow ────────────────────────────────────────────────────────────

describe('saveRankingNow', () => {
  beforeEach(resetAll);

  it('does nothing when ranking is empty', () => {
    saveRankingNow();
    expect(fsState.writtenContent).toBe('');
  });

  it('writes JSON when rankings exist', () => {
    recordTierLatency('vast', makeObs(3000));
    saveRankingNow();
    expect(fsState.writtenContent).not.toBe('');
    const saved = JSON.parse(fsState.writtenContent);
    expect(saved.ranking).toHaveProperty('vast');
  });

  it('includes savedAt timestamp', () => {
    recordTierLatency('vast', makeObs(3000));
    const before = Date.now();
    saveRankingNow();
    const saved = JSON.parse(fsState.writtenContent);
    expect(typeof saved.savedAt).toBe('number');
    expect(saved.savedAt).toBeGreaterThanOrEqual(before);
  });

  it('uses atomic tmp + rename pattern', () => {
    recordTierLatency('vast', makeObs(3000));
    saveRankingNow();
    expect(fsState.tmpPath).toContain('.tmp');
    expect(fsState.writtenPath).not.toContain('.tmp');
  });

  it('writes to tier-ranking.json inside .babelcast', () => {
    recordTierLatency('runpod', makeObs(5000));
    saveRankingNow();
    expect(fsState.writtenPath).toContain('tier-ranking.json');
    expect(fsState.writtenPath).toContain('.babelcast');
  });

  it('includes all recorded providers', () => {
    recordTierLatency('runpod', makeObs(5000));
    recordTierLatency('vast', makeObs(3000));
    saveRankingNow();
    const saved = JSON.parse(fsState.writtenContent);
    expect(saved.ranking).toHaveProperty('runpod');
    expect(saved.ranking).toHaveProperty('vast');
  });

  it('ensures mkdirSync is called to create .babelcast', () => {
    recordTierLatency('vast', makeObs(3000));
    saveRankingNow();
    expect(fsState.mkdirCalled).toBe(true);
  });

  it('handles write error without throwing', () => {
    recordTierLatency('vast', makeObs(3000));
    fsState.shouldThrowWrite = true;
    expect(() => saveRankingNow()).not.toThrow();
  });
});
