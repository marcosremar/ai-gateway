/**
 * Unit tests for server/latency-db.ts (Prisma/Neon implementation).
 * All Prisma calls are mocked — no real DB is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock prisma ───────────────────────────────────────────────────────

const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma = {
    hostLatency: {
      upsert:     vi.fn(),
      update:     vi.fn(),
      updateMany: vi.fn(),
      findMany:   vi.fn(),
      count:      vi.fn(),
    },
    hostLatencyHistory: {
      create:     vi.fn(),
      findMany:   vi.fn(),
      deleteMany: vi.fn(),
      count:      vi.fn(),
    },
  };
  return { mockPrisma };
});

vi.mock('../server/state', () => ({
  prisma: mockPrisma,
  // other exports gpu-deploy / providers may pull in — stubs only
  deployState:          { status: 'idle' },
  deploymentSM:         {},
  latencyRing:          [],
  latencyRingIdx:       0,
  setLatencyRingIdx:    vi.fn(),
  LATENCY_RING_SIZE:    1000,
  metricsCounters:      { requestsTotal: 0, errorsTotal: 0, dbLogFailures: 0, byStage: {}, byProvider: {}, totalInputTokens: 0, totalOutputTokens: 0 },
  providerMetrics:      {},
  pendingDbWrites:      0,
  consecutiveDbFailures: 0,
  DB_FAILURE_WARN_THRESHOLD: 10,
}));

// ── Import module under test AFTER mocking ────────────────────────────────────

import {
  upsertHostMeta,
  saveProbeResult,
  getHostsToProbe,
  getHostRttMap,
  getAllHostLatencies,
  setHostsMonitored,
  getLatencyDbStats,
  sortGpuTypesByLatency,
  getBestLatencyByGpuModel,
  closeLatencyDb,
  INTERVAL_STABLE_MS,
  INTERVAL_UNSTABLE_MS,
  INTERVAL_FAILING_MS,
} from '../../server/latency-db';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePrismaRow(overrides: Partial<{
  hostId: string; hostIp: string; provider: string; gpuName: string;
  geolocation: string; priceUsd: number; directPort: number | null;
  medianMs: number | null; p90Ms: number | null; stddevMs: number | null;
  successRate: number; lastProbedAt: bigint; probeCount: number;
  consecutiveFailures: number; monitored: boolean;
}> = {}) {
  return {
    hostId:              'host-1',
    hostIp:              '1.2.3.4',
    provider:            'runpod',
    gpuName:             'NVIDIA RTX 4090',
    geolocation:         'us-east',
    priceUsd:            0.5,
    directPort:          null,
    medianMs:            30,
    p90Ms:               50,
    stddevMs:            5,
    successRate:         1,
    lastProbedAt:        BigInt(1_000_000),
    probeCount:          10,
    consecutiveFailures: 0,
    monitored:           true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('upsertHostMeta', () => {
  it('calls prisma.hostLatency.upsert with correct fields', async () => {
    mockPrisma.hostLatency.upsert.mockResolvedValueOnce({});

    const meta = {
      hostIp:      '10.0.0.1',
      provider:    'vast',
      gpuName:     'NVIDIA RTX 3090',
      geolocation: 'eu-west',
      priceUsd:    0.4,
      directPort:  22,
    };
    await upsertHostMeta('host-abc', meta);

    expect(mockPrisma.hostLatency.upsert).toHaveBeenCalledOnce();
    const call = mockPrisma.hostLatency.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ hostId: 'host-abc' });
    expect(call.update.hostIp).toBe('10.0.0.1');
    expect(call.update.provider).toBe('vast');
    expect(call.update.directPort).toBe(22);
    expect(call.create.hostId).toBe('host-abc');
    expect(call.create.gpuName).toBe('NVIDIA RTX 3090');
  });

  it('sets directPort to null when not provided', async () => {
    mockPrisma.hostLatency.upsert.mockResolvedValueOnce({});

    await upsertHostMeta('host-xyz', {
      hostIp: '1.1.1.1', provider: 'runpod', gpuName: 'A100',
      geolocation: 'us-west', priceUsd: 1.0,
    });

    const call = mockPrisma.hostLatency.upsert.mock.calls[0][0];
    expect(call.create.directPort).toBeNull();
    expect(call.update.directPort).toBeNull();
  });
});

describe('saveProbeResult', () => {
  it('creates a history entry with correct data', async () => {
    mockPrisma.hostLatencyHistory.create.mockResolvedValueOnce({});
    mockPrisma.hostLatencyHistory.findMany
      .mockResolvedValueOnce([{ id: 5 }])         // toKeep (< HISTORY_SIZE=24)
      .mockResolvedValueOnce([{ medianMs: 30 }]);  // rolling stats
    mockPrisma.hostLatencyHistory.count.mockResolvedValueOnce(1);
    mockPrisma.hostLatency.update.mockResolvedValueOnce({});

    const now = 1_700_000_000_000;
    await saveProbeResult('host-1', { medianMs: 30, p90Ms: 50, samples: 5 }, now);

    expect(mockPrisma.hostLatencyHistory.create).toHaveBeenCalledOnce();
    const createCall = mockPrisma.hostLatencyHistory.create.mock.calls[0][0];
    expect(createCall.data.hostId).toBe('host-1');
    expect(createCall.data.probedAt).toBe(BigInt(now));
    expect(createCall.data.medianMs).toBe(30);
    expect(createCall.data.samples).toBe(5);
  });

  it('prunes old entries when history is full (24 rows)', async () => {
    const toKeep = Array.from({ length: 24 }, (_, i) => ({ id: 100 - i }));
    mockPrisma.hostLatencyHistory.create.mockResolvedValueOnce({});
    mockPrisma.hostLatencyHistory.findMany
      .mockResolvedValueOnce(toKeep)               // toKeep — exactly HISTORY_SIZE
      .mockResolvedValueOnce([{ medianMs: 30 }]);  // rolling stats
    mockPrisma.hostLatencyHistory.deleteMany.mockResolvedValueOnce({});
    mockPrisma.hostLatencyHistory.count.mockResolvedValueOnce(24);
    mockPrisma.hostLatency.update.mockResolvedValueOnce({});

    await saveProbeResult('host-1', { medianMs: 30, p90Ms: 50, samples: 5 });

    expect(mockPrisma.hostLatencyHistory.deleteMany).toHaveBeenCalledOnce();
    const deleteCall = mockPrisma.hostLatencyHistory.deleteMany.mock.calls[0][0];
    expect(deleteCall.where.hostId).toBe('host-1');
    // minId is toKeep[23].id = 77
    expect(deleteCall.where.id).toEqual({ lt: 77 });
  });

  it('updates host stats with computed median and success rate', async () => {
    mockPrisma.hostLatencyHistory.create.mockResolvedValueOnce({});
    mockPrisma.hostLatencyHistory.findMany
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce([{ medianMs: 40 }, { medianMs: 60 }]);
    mockPrisma.hostLatencyHistory.count.mockResolvedValueOnce(4); // 2 successes / 4 total = 0.5
    mockPrisma.hostLatency.update.mockResolvedValueOnce({});

    await saveProbeResult('host-1', { medianMs: 40, p90Ms: 70, samples: 3 });

    const updateCall = mockPrisma.hostLatency.update.mock.calls[0][0];
    expect(updateCall.data.successRate).toBe(0.5); // 2/4
    expect(updateCall.data.consecutiveFailures).toBe(0); // samples > 0
    expect(updateCall.where).toEqual({ hostId: 'host-1' });
  });

  it('increments consecutiveFailures when samples=0', async () => {
    mockPrisma.hostLatencyHistory.create.mockResolvedValueOnce({});
    mockPrisma.hostLatencyHistory.findMany
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce([]);  // no successful history
    mockPrisma.hostLatencyHistory.count.mockResolvedValueOnce(1);
    mockPrisma.hostLatency.update.mockResolvedValueOnce({});

    await saveProbeResult('host-1', { medianMs: null, p90Ms: null, samples: 0 });

    const updateCall = mockPrisma.hostLatency.update.mock.calls[0][0];
    expect(updateCall.data.consecutiveFailures).toEqual({ increment: 1 });
  });
});

describe('getHostsToProbe', () => {
  it('queries with correct cutoff timestamps for all probe tiers', async () => {
    mockPrisma.hostLatency.findMany.mockResolvedValueOnce([]);

    const now = 1_700_000_000_000;
    await getHostsToProbe(now);

    expect(mockPrisma.hostLatency.findMany).toHaveBeenCalledOnce();
    const call = mockPrisma.hostLatency.findMany.mock.calls[0][0];

    const failCutoff     = BigInt(now - INTERVAL_FAILING_MS);
    const unstableCutoff = BigInt(now - INTERVAL_UNSTABLE_MS);
    const stableCutoff   = BigInt(now - INTERVAL_STABLE_MS);

    expect(call.where.monitored).toBe(true);
    const [failingClause, unstableClause, stableClause] = call.where.OR;

    expect(failingClause.consecutiveFailures).toEqual({ gte: 3 });
    expect(failingClause.lastProbedAt).toEqual({ lt: failCutoff });

    expect(unstableClause.lastProbedAt).toEqual({ lt: unstableCutoff });
    expect(stableClause.lastProbedAt).toEqual({ lt: stableCutoff });
  });

  it('maps prisma rows to HostLatencyRow shape', async () => {
    mockPrisma.hostLatency.findMany.mockResolvedValueOnce([makePrismaRow()]);

    const rows = await getHostsToProbe(Date.now());
    expect(rows).toHaveLength(1);
    expect(rows[0].host_id).toBe('host-1');
    expect(rows[0].median_ms).toBe(30);
    expect(rows[0].last_probed_at).toBe(1_000_000);
  });
});

describe('getHostRttMap', () => {
  it('returns empty object for empty hostIds array', async () => {
    const result = await getHostRttMap([]);
    expect(result).toEqual({});
    expect(mockPrisma.hostLatency.findMany).not.toHaveBeenCalled();
  });

  it('filters out stale and failing hosts and returns map', async () => {
    mockPrisma.hostLatency.findMany.mockResolvedValueOnce([
      { hostId: 'host-1', medianMs: 25 },
      { hostId: 'host-2', medianMs: 80 },
    ]);

    const result = await getHostRttMap(['host-1', 'host-2', 'host-3']);
    expect(result).toEqual({ 'host-1': 25, 'host-2': 80 });

    const call = mockPrisma.hostLatency.findMany.mock.calls[0][0];
    expect(call.where.hostId).toEqual({ in: ['host-1', 'host-2', 'host-3'] });
    expect(call.where.medianMs).toEqual({ not: null });
    expect(call.where.consecutiveFailures).toEqual({ lt: 3 });
  });
});

describe('getAllHostLatencies', () => {
  it('returns rows sorted by medianMs asc nulls last', async () => {
    const row1 = makePrismaRow({ hostId: 'host-1', medianMs: 50 });
    const row2 = makePrismaRow({ hostId: 'host-2', medianMs: null });
    mockPrisma.hostLatency.findMany.mockResolvedValueOnce([row1, row2]);

    const rows = await getAllHostLatencies();
    expect(rows).toHaveLength(2);
    expect(rows[0].host_id).toBe('host-1');
    expect(rows[1].median_ms).toBeNull();

    const call = mockPrisma.hostLatency.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ medianMs: { sort: 'asc', nulls: 'last' } }]);
  });
});

describe('setHostsMonitored', () => {
  it('calls updateMany for all hosts when hostIds is empty', async () => {
    mockPrisma.hostLatency.updateMany.mockResolvedValueOnce({ count: 5 });

    await setHostsMonitored([], true);

    const call = mockPrisma.hostLatency.updateMany.mock.calls[0][0];
    expect(call.where).toBeUndefined();
    expect(call.data).toEqual({ monitored: true });
  });

  it('filters by hostId when hostIds is provided', async () => {
    mockPrisma.hostLatency.updateMany.mockResolvedValueOnce({ count: 2 });

    await setHostsMonitored(['h1', 'h2'], false);

    const call = mockPrisma.hostLatency.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ hostId: { in: ['h1', 'h2'] } });
    expect(call.data).toEqual({ monitored: false });
  });
});

describe('getLatencyDbStats', () => {
  it('returns correct totals from parallel count queries', async () => {
    // The function calls Promise.all with 6 counts
    mockPrisma.hostLatency.count
      .mockResolvedValueOnce(100)  // total
      .mockResolvedValueOnce(80)   // monitored
      .mockResolvedValueOnce(40)   // recent (2h)
      .mockResolvedValueOnce(5)    // unstable
      .mockResolvedValueOnce(3);   // failing
    mockPrisma.hostLatencyHistory.count.mockResolvedValueOnce(2400);

    const stats = await getLatencyDbStats();
    expect(stats.totalHosts).toBe(100);
    expect(stats.monitoredHosts).toBe(80);
    expect(stats.probedInLast2h).toBe(40);
    expect(stats.unstable).toBe(5);
    expect(stats.failing).toBe(3);
    expect(stats.historyRows).toBe(2400);
  });
});

describe('sortGpuTypesByLatency', () => {
  it('returns input unchanged when thresholdMs <= 0', async () => {
    const result = await sortGpuTypesByLatency(['RTX 4090', 'A100'], 0);
    expect(result).toEqual(['RTX 4090', 'A100']);
    expect(mockPrisma.hostLatency.findMany).not.toHaveBeenCalled();
  });

  it('returns input unchanged when gpuTypes is empty', async () => {
    const result = await sortGpuTypesByLatency([], 100);
    expect(result).toEqual([]);
  });

  it('groups GPU types into good/unknown/allBad', async () => {
    // RTX 4090: best=20ms < 50ms → good
    // A100: no data → unknown
    // RTX 3090: best=100ms > 50ms → allBad
    mockPrisma.hostLatency.findMany
      .mockResolvedValueOnce([{ medianMs: 20 }])   // RTX 4090
      .mockResolvedValueOnce([])                    // A100 (no data)
      .mockResolvedValueOnce([{ medianMs: 100 }]);  // RTX 3090

    const result = await sortGpuTypesByLatency(['RTX 4090', 'A100', 'RTX 3090'], 50);
    expect(result).toEqual(['RTX 4090', 'A100', 'RTX 3090']);
    // Order: good first, then unknown, then allBad
    expect(result[0]).toBe('RTX 4090');
    expect(result[1]).toBe('A100');
    expect(result[2]).toBe('RTX 3090');
  });

  it('strips NVIDIA prefix before querying', async () => {
    mockPrisma.hostLatency.findMany.mockResolvedValueOnce([{ medianMs: 15 }]);

    await sortGpuTypesByLatency(['NVIDIA RTX 4090'], 50);

    const call = mockPrisma.hostLatency.findMany.mock.calls[0][0];
    // model = 'RTX 4090' (NVIDIA stripped)
    expect(call.where.gpuName.contains).toBe('RTX 4090');
  });
});

describe('getBestLatencyByGpuModel', () => {
  it('normalizes GPU names and picks best per model', async () => {
    mockPrisma.hostLatency.findMany.mockResolvedValueOnce([
      { gpuName: 'NVIDIA RTX 4090', medianMs: 50, geolocation: 'us-east' },
      { gpuName: 'NVIDIA RTX 4090', medianMs: 30, geolocation: 'eu-west' },
      { gpuName: 'A100',            medianMs: 20, geolocation: 'us-west' },
    ]);

    const result = await getBestLatencyByGpuModel();
    // 'NVIDIA RTX 4090' normalizes to 'rtx 4090'
    expect(result['rtx 4090']).toBeDefined();
    expect(result['rtx 4090'].bestMs).toBe(30);
    expect(result['rtx 4090'].region).toBe('eu-west');
    expect(result['a100'].bestMs).toBe(20);
  });

  it('filters rows where medianMs is null (handled in loop)', async () => {
    mockPrisma.hostLatency.findMany.mockResolvedValueOnce([
      { gpuName: 'A100', medianMs: null, geolocation: 'us' },
    ]);

    const result = await getBestLatencyByGpuModel();
    // The where clause already filters null, but row.medianMs null check in loop skips it
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('closeLatencyDb', () => {
  it('is a no-op and does not throw', () => {
    expect(() => closeLatencyDb()).not.toThrow();
  });
});
