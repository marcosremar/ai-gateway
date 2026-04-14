import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock heavy server modules to avoid Prisma/DB initialization ──────────────

const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma = {
    hostReputation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    requestLog: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    gpuEvent: {
      create: vi.fn(),
    },
    gpuDeploySession: {
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  return { mockPrisma };
});

vi.mock('../server/state', () => ({
  prisma: mockPrisma,
  deployState: {
    status: 'ready',
    podId: 'pod-123',
    endpoint: 'http://gpu:8000',
    gpuType: 'RTX 4090',
    dockerImage: 'marcosremar/babelcast-mistral:latest',
    message: '',
    step: 'ready',
    stepDetail: '',
    startedAt: Date.now(),
    retryCount: 0,
    provider: 'vast',
    alert: '',
    sshHost: '',
    sshPort: 0,
    lastLogs: '',
    deployDurationMs: 0,
    costPerHr: 0.5,
    providerMeta: { machineId: 123, hostIp: '192.168.1.1' },
    transitions: [],
  },
  latencyRing: [],
  latencyRingIdx: 0,
  setLatencyRingIdx: vi.fn(),
  LATENCY_RING_SIZE: 1000,
  metricsCounters: {
    requestsTotal: 0,
    errorsTotal: 0,
    dbLogFailures: 0,
    byStage: {},
    byProvider: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
  },
  providerMetrics: {},
  pendingDbWrites: 0,
  setPendingDbWrites: vi.fn(),
  consecutiveDbFailures: 0,
  setConsecutiveDbFailures: vi.fn(),
  DB_FAILURE_WARN_THRESHOLD: 10,
  activeDeploySessionId: null,
  setActiveDeploySessionId: vi.fn(),
  startedAt: Date.now(),
  dailyGpuSpendUsd: 0,
  DAILY_BUDGET_USD: 0,
}));

vi.mock('../server/http-utils', () => ({
  getOrCreateRequestId: vi.fn(() => 'test-req-id'),
  setRequestIdHeader: vi.fn(),
}));

vi.mock('../server/ai-handlers', () => ({
  getTranslationCacheStats: vi.fn(() => ({ size: 0, hits: 0, misses: 0 })),
}));

// Import after mocks are set up
import {
  computeReputationScore,
  deriveHostKey,
  isHostAttributableFailure,
  computePercentile,
  aggregateRequestLogsToReputation,
  startReputationAggregation,
  stopReputationAggregation,
} from '../../server/metrics';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('metrics-reputation-aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console.log/warn during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    stopReputationAggregation();
    vi.restoreAllMocks();
  });

  // ── deriveHostKey ────────────────────────────────────────────────────────

  describe('deriveHostKey', () => {
    it('derives vast host key from hostIp', () => {
      expect(deriveHostKey('vast', { hostIp: '10.0.0.1' })).toBe('vast:10.0.0.1');
    });

    it('derives tensordock host key from hostnodeId', () => {
      expect(deriveHostKey('tensordock', { hostnodeId: 'node-42' })).toBe('tensordock:node-42');
    });

    it('falls back to provider:gpuType for RunPod', () => {
      expect(deriveHostKey('runpod', { gpuType: 'A100' })).toBe('runpod:A100');
    });

    it('uses provider:unknown when no metadata', () => {
      expect(deriveHostKey('modal')).toBe('modal:unknown');
    });

    it('uses provider:unknown for vast without hostIp', () => {
      expect(deriveHostKey('vast', { machineId: 123 })).toBe('vast:unknown');
    });
  });

  // ── computeReputationScore ───────────────────────────────────────────────

  describe('computeReputationScore', () => {
    const baseHost = {
      deployCount: 10,
      successCount: 9,
      failCount: 1,
      crashCount: 0,
      avgBootTimeS: 120,
      avgUptimeS: 3600,
      avgLatencyMs: 200,
      latencyVariance: 900, // stddev=30
      requestCount: 100,
      reliability: 0.95,
      inetDownMbps: 200,
      inetUpMbps: 150,
      tier: 3,
      uptimePct: 99.5,
      pcieBw: 15,
      diskReadMbps: 500,
      lastDeployAt: new Date(), // recent = no decay
    };

    it('returns 0.5 for unknown hosts with zero deploys', () => {
      const score = computeReputationScore({ ...baseHost, deployCount: 0 });
      expect(score).toBe(0.5);
    });

    it('returns a score between 0 and 1', () => {
      const score = computeReputationScore(baseHost);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('scores high-quality hosts above 0.7', () => {
      const goodHost = {
        ...baseHost,
        avgLatencyMs: 120,       // excellent latency
        successCount: 10,
        failCount: 0,
        crashCount: 0,
        inetDownMbps: 500,
        reliability: 0.99,
      };
      const score = computeReputationScore(goodHost);
      expect(score).toBeGreaterThan(0.7);
    });

    it('scores low-quality hosts below 0.5', () => {
      const badHost = {
        ...baseHost,
        avgLatencyMs: 800,       // terrible latency
        successCount: 3,
        failCount: 7,
        crashCount: 5,
        inetDownMbps: 5,
        reliability: 0.3,
        avgBootTimeS: 600,
        avgUptimeS: 300,
      };
      const score = computeReputationScore(badHost);
      expect(score).toBeLessThan(0.5);
    });

    it('applies recency decay — old data moves toward 0.5', () => {
      const recent = computeReputationScore(baseHost);
      const stale = computeReputationScore({
        ...baseHost,
        lastDeployAt: new Date(Date.now() - 60 * 24 * 60 * 60_000), // 60 days ago
      });
      // Stale score should be closer to 0.5 than recent
      expect(Math.abs(stale - 0.5)).toBeLessThan(Math.abs(recent - 0.5));
    });

    it('penalizes crashes proportionally', () => {
      const noCrash = computeReputationScore({ ...baseHost, crashCount: 0 });
      const oneCrash = computeReputationScore({ ...baseHost, crashCount: 1 });
      const manyCrashes = computeReputationScore({ ...baseHost, crashCount: 5 });
      expect(noCrash).toBeGreaterThan(oneCrash);
      expect(oneCrash).toBeGreaterThan(manyCrashes);
    });

    it('latency dominates the score (0.30 weight)', () => {
      const fastHost = computeReputationScore({ ...baseHost, avgLatencyMs: 100 });
      const slowHost = computeReputationScore({ ...baseHost, avgLatencyMs: 700 });
      // ~0.30 weight for latency: going from 100ms to 700ms should drop score significantly
      expect(fastHost - slowHost).toBeGreaterThan(0.1);
    });
  });

  // ── isHostAttributableFailure ────────────────────────────────────────────

  describe('isHostAttributableFailure', () => {
    it('returns true for undefined category (unknown = host fault)', () => {
      expect(isHostAttributableFailure(undefined)).toBe(true);
    });

    it('returns true for host-attributable failures', () => {
      expect(isHostAttributableFailure('timeout')).toBe(true);
      expect(isHostAttributableFailure('crashed')).toBe(true);
      expect(isHostAttributableFailure('network')).toBe(true);
      expect(isHostAttributableFailure('unknown')).toBe(true);
    });

    it('returns false for non-host failures', () => {
      expect(isHostAttributableFailure('billing')).toBe(false);
      expect(isHostAttributableFailure('api_error')).toBe(false);
      expect(isHostAttributableFailure('docker_image')).toBe(false);
      expect(isHostAttributableFailure('cancelled')).toBe(false);
    });
  });

  // ── computePercentile ────────────────────────────────────────────────────

  describe('computePercentile', () => {
    it('returns 0 for empty array', () => {
      expect(computePercentile([], 50)).toBe(0);
    });

    it('returns the only element for single-element array', () => {
      expect(computePercentile([42], 50)).toBe(42);
      expect(computePercentile([42], 99)).toBe(42);
    });

    it('computes p50 correctly', () => {
      const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const p50 = computePercentile(sorted, 50);
      expect(p50).toBe(50);
    });

    it('computes p99 correctly', () => {
      const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
      const p99 = computePercentile(sorted, 99);
      expect(p99).toBe(99);
    });

    it('computes p0 — returns first element', () => {
      const sorted = [5, 10, 15];
      expect(computePercentile(sorted, 0)).toBe(5);
    });
  });

  // ── startReputationAggregation / stopReputationAggregation ───────────────

  describe('timer lifecycle', () => {
    it('startReputationAggregation does not throw', () => {
      expect(() => startReputationAggregation()).not.toThrow();
    });

    it('startReputationAggregation is idempotent (calling twice is safe)', () => {
      startReputationAggregation();
      startReputationAggregation(); // should not create a second timer
      // If it created two timers, stopReputationAggregation would only clear one
      // and the test afterEach cleanup would leak. No throw = success.
      stopReputationAggregation();
    });

    it('stopReputationAggregation is safe to call when not started', () => {
      expect(() => stopReputationAggregation()).not.toThrow();
    });

    it('stopReputationAggregation clears the timer', () => {
      startReputationAggregation();
      stopReputationAggregation();
      // Calling stop again should be a no-op
      expect(() => stopReputationAggregation()).not.toThrow();
    });
  });

  // ── aggregateRequestLogsToReputation ─────────────────────────────────────

  describe('aggregateRequestLogsToReputation', () => {
    it('returns {processed: 0} when no deployState.provider', async () => {
      // Temporarily override the dynamic import to return empty provider
      const stateModule = await import('../server/state');
      const origProvider = stateModule.deployState.provider;
      (stateModule.deployState as any).provider = '';

      const result = await aggregateRequestLogsToReputation();
      expect(result.processed).toBe(0);
      expect(result.hostKey).toBeNull();

      // Restore
      (stateModule.deployState as any).provider = origProvider;
    });

    it('returns {processed: 0} when no existing HostReputation row', async () => {
      mockPrisma.hostReputation.findUnique.mockResolvedValueOnce(null);

      const result = await aggregateRequestLogsToReputation();
      expect(result.processed).toBe(0);
      expect(result.hostKey).toBe('vast:192.168.1.1');
    });

    it('returns {processed: 0} when no new request logs', async () => {
      mockPrisma.hostReputation.findUnique.mockResolvedValueOnce({
        hostKey: 'vast:192.168.1.1',
        deployCount: 5,
        successCount: 5,
        failCount: 0,
        crashCount: 0,
        avgBootTimeS: 100,
        avgUptimeS: 3600,
        avgLatencyMs: 200,
        latencyVariance: 400,
        requestCount: 50,
        reliability: 0.95,
        inetDownMbps: 200,
        inetUpMbps: 100,
        tier: 3,
        uptimePct: 99,
        pcieBw: 15,
        diskReadMbps: 500,
        reputationScore: 0.8,
        avgSttMs: 100,
        avgLlmMs: 200,
        avgTtsMs: 150,
        avgPipelineMs: 450,
        lastDeployAt: new Date(),
      });
      mockPrisma.requestLog.findMany.mockResolvedValueOnce([]);

      const result = await aggregateRequestLogsToReputation();
      expect(result.processed).toBe(0);
      expect(result.hostKey).toBe('vast:192.168.1.1');
    });

    it('processes logs and updates reputation score', async () => {
      const existingHost = {
        hostKey: 'vast:192.168.1.1',
        deployCount: 5,
        successCount: 5,
        failCount: 0,
        crashCount: 0,
        avgBootTimeS: 100,
        avgUptimeS: 3600,
        avgLatencyMs: 200,
        latencyVariance: 400,
        requestCount: 50,
        reliability: 0.95,
        inetDownMbps: 200,
        inetUpMbps: 100,
        tier: 3,
        uptimePct: 99,
        pcieBw: 15,
        diskReadMbps: 500,
        reputationScore: 0.8,
        avgSttMs: 100,
        avgLlmMs: 200,
        avgTtsMs: 150,
        avgPipelineMs: 450,
        lastDeployAt: new Date(),
      };

      const now = new Date();
      const logs = [
        { stage: 'stt', latencyMs: 120, timestamp: new Date(now.getTime() - 3000) },
        { stage: 'llm', latencyMs: 180, timestamp: new Date(now.getTime() - 2000) },
        { stage: 'tts', latencyMs: 90,  timestamp: new Date(now.getTime() - 1000) },
        { stage: 'pipeline', latencyMs: 400, timestamp: now },
      ];

      mockPrisma.hostReputation.findUnique.mockResolvedValueOnce(existingHost);
      mockPrisma.requestLog.findMany.mockResolvedValueOnce(logs);
      mockPrisma.hostReputation.update.mockResolvedValueOnce({});

      const result = await aggregateRequestLogsToReputation();
      expect(result.processed).toBe(4);
      expect(result.hostKey).toBe('vast:192.168.1.1');

      // Verify the update was called with correct hostKey
      expect(mockPrisma.hostReputation.update).toHaveBeenCalledOnce();
      const updateCall = mockPrisma.hostReputation.update.mock.calls[0][0];
      expect(updateCall.where.hostKey).toBe('vast:192.168.1.1');
      // Should have updated latency/variance/requestCount/score
      expect(updateCall.data).toHaveProperty('avgLatencyMs');
      expect(updateCall.data).toHaveProperty('latencyVariance');
      expect(updateCall.data).toHaveProperty('requestCount');
      expect(updateCall.data).toHaveProperty('reputationScore');
      expect(updateCall.data).toHaveProperty('avgSttMs');
      expect(updateCall.data).toHaveProperty('avgLlmMs');
      expect(updateCall.data).toHaveProperty('avgTtsMs');
      expect(updateCall.data).toHaveProperty('avgPipelineMs');
      // requestCount should have incremented by 4
      expect(updateCall.data.requestCount).toBe(54);
      // reputationScore should be a valid number between 0 and 1
      expect(updateCall.data.reputationScore).toBeGreaterThan(0);
      expect(updateCall.data.reputationScore).toBeLessThanOrEqual(1);
    });

    it('handles Prisma errors gracefully (returns processed: 0)', async () => {
      mockPrisma.hostReputation.findUnique.mockRejectedValueOnce(
        new Error('DB connection lost'),
      );

      const result = await aggregateRequestLogsToReputation();
      expect(result.processed).toBe(0);
      expect(result.hostKey).toBe('vast:192.168.1.1');
    });

    it('handles update failure gracefully', async () => {
      const existingHost = {
        hostKey: 'vast:192.168.1.1',
        deployCount: 5, successCount: 5, failCount: 0, crashCount: 0,
        avgBootTimeS: 100, avgUptimeS: 3600, avgLatencyMs: 200,
        latencyVariance: 400, requestCount: 50, reliability: 0.95,
        inetDownMbps: 200, inetUpMbps: 100, tier: 3, uptimePct: 99,
        pcieBw: 15, diskReadMbps: 500, reputationScore: 0.8,
        avgSttMs: 100, avgLlmMs: 200, avgTtsMs: 150, avgPipelineMs: 450,
        lastDeployAt: new Date(),
      };

      mockPrisma.hostReputation.findUnique.mockResolvedValueOnce(existingHost);
      mockPrisma.requestLog.findMany.mockResolvedValueOnce([
        { stage: 'stt', latencyMs: 120, timestamp: new Date() },
      ]);
      mockPrisma.hostReputation.update.mockRejectedValueOnce(
        new Error('DB write failure'),
      );

      const result = await aggregateRequestLogsToReputation();
      // Error is caught inside the try/catch, returns processed: 0
      expect(result.processed).toBe(0);
      expect(result.hostKey).toBe('vast:192.168.1.1');
    });

    it('returns correct hostKey even when no gpuType', async () => {
      const stateModule = await import('../server/state');
      const origGpuType = stateModule.deployState.gpuType;
      (stateModule.deployState as any).gpuType = '';

      const result = await aggregateRequestLogsToReputation();
      // No gpuType → should bail early
      expect(result.processed).toBe(0);
      expect(result.hostKey).toBeNull();

      (stateModule.deployState as any).gpuType = origGpuType;
    });
  });
});
