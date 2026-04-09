/**
 * Unit tests for refreshGpuTypeCache() in server/gpu-deploy.ts.
 * Verifies single-attempt behaviour: no retries on timeout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockPrisma, mockRunpod, mockVast, mockTensordock, mockModal } = vi.hoisted(() => {
  const mockPrisma = {
    $transaction: vi.fn(),
    gpuTypeCache: {
      upsert: vi.fn(),
    },
  };

  const makeMockClient = () => ({
    listOffers:        vi.fn(),
    createInstance:    vi.fn(),
    terminateInstance: vi.fn(),
    getInstance:       vi.fn(),
    listInstances:     vi.fn(),
    getLogs:           vi.fn(),
  });

  return {
    mockPrisma,
    mockRunpod:     makeMockClient(),
    mockVast:       makeMockClient(),
    mockTensordock: makeMockClient(),
    mockModal:      makeMockClient(),
  };
});

// Mock bun:sqlite
vi.mock('bun:sqlite', () => ({
  Database: class MockDatabase {
    exec() {}
    prepare() { return { all: () => [], get: () => null, run: () => {} }; }
    close() {}
  },
}));

// Mock @prisma/client
vi.mock('@prisma/client', () => ({
  PrismaClient: class MockPrismaClient {
    $disconnect = vi.fn(async () => {});
    $connect    = vi.fn(async () => {});
  },
}));

// Mock @prisma/adapter-pg
vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class MockPrismaPg {
    constructor(_opts: unknown) {}
  },
}));

// Mock server/state
vi.mock('../server/state', () => ({
  prisma:               mockPrisma,
  deployState:          { status: 'idle', podId: null, endpoint: null, gpuType: null, dockerImage: null, message: '', step: 'idle', stepDetail: '', startedAt: 0, retryCount: 0, provider: null, alert: '', sshHost: '', sshPort: 0, lastLogs: '', deployDurationMs: 0, costPerHr: 0, providerMeta: null, transitions: [] },
  deploymentSM:         { state: 'idle', send: vi.fn() },
  deployCancelled:      false,
  deployApiKey:         '',
  deployVastApiKey:     '',
  deployTensordockApiKey: '',
  deployTensordockAuthId: '',
  deployModalApiKey:    '',
  activeProvider:       null,
  gpuHealthy:           false,
  monitorInterval:      null,
  lastRequestTime:      0,
  lastModelRequestTime: 0,
  DAILY_BUDGET_USD:     0,
  dailyGpuSpendUsd:     0,
  dailySpendResetDate:  new Date().toDateString(),
  latencyRing:          [],
  latencyRingIdx:       0,
  LATENCY_RING_SIZE:    1000,
  setLatencyRingIdx:    vi.fn(),
  metricsCounters:      { requestsTotal: 0, errorsTotal: 0, dbLogFailures: 0, byStage: {}, byProvider: {}, totalInputTokens: 0, totalOutputTokens: 0 },
  providerMetrics:      {},
  pendingDbWrites:      0,
  consecutiveDbFailures: 0,
  DB_FAILURE_WARN_THRESHOLD: 10,
  setDeployState:       vi.fn(),
  setActiveProvider:    vi.fn(),
  setGpuHealthy:        vi.fn(),
  setLastRequestTime:   vi.fn(),
  setMonitorInterval:   vi.fn(),
  setDeployApiKey:      vi.fn(),
  setDeployVastApiKey:  vi.fn(),
  setDeployTensordockApiKey: vi.fn(),
  setDeployTensordockAuthId: vi.fn(),
  setDeployModalApiKey: vi.fn(),
  setDeployVastApiKey2: vi.fn(),
  resetDeployState:     vi.fn(),
  loadPersistedDeploy:  vi.fn(() => false),
  clearPersistedDeploy: vi.fn(),
  setDeployCancelled:   vi.fn(),
  updateGpuModelWarmth: vi.fn(),
  isStageWarm:          vi.fn(() => false),
  isGpuReadyForProduction: false,
  getPerStageP95:       vi.fn(() => null),
  setGpuReadyForProduction: vi.fn(),
  setServiceReadiness:  vi.fn(),
  perStageLatencyRing:  {},
  setDailyGpuSpendUsd:  vi.fn(),
  setDailySpendResetDate: vi.fn(),
  setLastModelRequestTime: vi.fn(),
  activeRequests:       0,
  startedAt:            Date.now(),
  // gpu readiness
  gpuShadowMode:        false,
  setGpuShadowMode:     vi.fn(),
  resetGpuReadinessState: vi.fn(),
  setGpuReadinessState: vi.fn(),
  ttsWarmth:            null,
  isTtsWarm:            vi.fn(() => false),
  getColdStartProfile:  vi.fn(() => null),
  gpuModelWarmth:       {},
  isGpuAvailable:       vi.fn(() => false),
  isGpuLatencyAcceptable: vi.fn(() => false),
  activeDeploySessionId: null,
  setActiveDeploySessionId: vi.fn(),
  setPendingDbWrites:   vi.fn(),
  setConsecutiveDbFailures: vi.fn(),
  gatewayServer:        null,
}));

// Mock server/providers to inject our mock clients
vi.mock('../server/providers', () => ({
  runpod:              mockRunpod,
  vast:                mockVast,
  tensordock:          mockTensordock,
  modal:               mockModal,
  snapgpu:             mockRunpod,   // snapgpu shares the same mock shape
  translationProfile:  null,
  updateTranslationProfile: vi.fn(),
  markGpuHealthy:      vi.fn(),
  markGpuUnhealthy:    vi.fn(),
  markGpuShadowMode:   vi.fn(),
  markGpuWarmupFailed: vi.fn(),
  _startReadinessCheck: vi.fn(),
}));

// Mock gpu-readiness
vi.mock('../server/gpu-readiness', () => ({
  isReadinessCheckInProgress: vi.fn(() => false),
}));

// Mock heavy deps
vi.mock('../server/metrics', () => ({
  logGpuEvent:           vi.fn(),
  startDeploySession:    vi.fn(),
  updateDeploySession:   vi.fn(),
  upsertHostReputation:  vi.fn(),
  loadReputations:       vi.fn(async () => ({})),
  loadReputationsByGpuType: vi.fn(async () => ({})),
  deriveHostKey:         vi.fn(() => 'key'),
  recordHostCrash:       vi.fn(),
  updateHostLatency:     vi.fn(),
}));

vi.mock('../server/latency-db', () => ({
  getBestLatencyByGpuModel: vi.fn(async () => ({})),
  upsertHostMeta:        vi.fn(),
  saveProbeResult:       vi.fn(),
  getHostsToProbe:       vi.fn(async () => []),
  getHostRttMap:         vi.fn(async () => ({})),
  getAllHostLatencies:    vi.fn(async () => []),
  setHostsMonitored:     vi.fn(),
  getLatencyDbStats:     vi.fn(async () => ({ totalHosts: 0, monitoredHosts: 0, probedInLast2h: 0, unstable: 0, failing: 0, historyRows: 0 })),
  sortGpuTypesByLatency: vi.fn(async (types: string[]) => types),
  closeLatencyDb:        vi.fn(),
}));

vi.mock('../server/ws-state', () => ({
  broadcastProviderStatus: vi.fn(),
  broadcastWs:             vi.fn(),
}));

vi.mock('../src/autoscaler/health', () => ({
  probeGpuHealth: vi.fn(),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { refreshGpuTypeCache } from '../server/gpu-deploy';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOffer(gpuName: string, gpuType = gpuName) {
  return { gpuName, gpuType, vram: 24, pricePerHr: 0.5, available: 3, region: 'us-east' };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: $transaction runs the callback
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<void>) => {
    await fn(mockPrisma);
  });
  mockPrisma.gpuTypeCache.upsert.mockResolvedValue({});
  // By default no API keys, so no providers are queried
  delete process.env.RUNPOD_API_KEY;
  delete process.env.VAST_API_KEY;
  delete process.env.TENSORDOCK_API_KEY;
  delete process.env.TENSORDOCK_AUTH_ID;
  delete process.env.MODAL_TOKEN_ID;
  delete process.env.MODAL_TOKEN_SECRET;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('refreshGpuTypeCache', () => {
  it('skips refresh entirely when no API keys are configured', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await refreshGpuTypeCache();

    expect(mockRunpod.listOffers).not.toHaveBeenCalled();
    expect(mockVast.listOffers).not.toHaveBeenCalled();
    expect(mockTensordock.listOffers).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No provider API keys'));

    consoleSpy.mockRestore();
  });

  it('makes exactly ONE attempt when a provider listOffers times out (no retry)', async () => {
    process.env.TENSORDOCK_API_KEY = 'td-key';
    process.env.TENSORDOCK_AUTH_ID = 'td-auth';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Make listOffers hang forever (timeout race will fire first)
    mockTensordock.listOffers.mockImplementation(
      () => new Promise<never>(() => {}), // never resolves
    );

    // Fast-forward: use fake timers to trigger the 15s timeout quickly
    vi.useFakeTimers();
    const refreshPromise = refreshGpuTypeCache();
    await vi.runAllTimersAsync();
    await refreshPromise;
    vi.useRealTimers();

    // listOffers called exactly ONCE
    expect(mockTensordock.listOffers).toHaveBeenCalledTimes(1);

    // Exactly one warning logged
    const timeoutWarnings = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('tensordock') && call[0].includes('timed out'),
    );
    expect(timeoutWarnings).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it('upserts offers to DB when a provider succeeds', async () => {
    process.env.RUNPOD_API_KEY = 'rp-key';

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const offers = [
      makeOffer('NVIDIA RTX 4090', 'RTX4090'),
      makeOffer('NVIDIA A100', 'A100'),
    ];
    mockRunpod.listOffers.mockResolvedValueOnce(offers);

    await refreshGpuTypeCache();

    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
    expect(mockPrisma.gpuTypeCache.upsert).toHaveBeenCalledTimes(2);

    const firstUpsert = mockPrisma.gpuTypeCache.upsert.mock.calls[0][0];
    expect(firstUpsert.where.provider_gpuName.provider).toBe('runpod');
  });

  it('when ALL providers fail, caches 0 types and logs appropriate message', async () => {
    process.env.RUNPOD_API_KEY = 'rp-key';
    process.env.VAST_API_KEY   = 'vast-key';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy  = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockRunpod.listOffers.mockRejectedValueOnce(new Error('runpod error'));
    mockVast.listOffers.mockRejectedValueOnce(new Error('vast error'));

    await refreshGpuTypeCache();

    // No upserts since all providers returned empty offers
    expect(mockPrisma.gpuTypeCache.upsert).not.toHaveBeenCalled();

    // Log message should mention 0 types cached
    const cachedLog = logSpy.mock.calls.find(
      call => typeof call[0] === 'string' && call[0].includes('Cached 0 GPU types'),
    );
    expect(cachedLog).toBeDefined();

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('TensorDock timeout produces exactly 1 log warning (not 3)', async () => {
    process.env.TENSORDOCK_API_KEY = 'td-key';
    process.env.TENSORDOCK_AUTH_ID = 'td-auth';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockTensordock.listOffers.mockImplementation(
      () => new Promise<never>(() => {}),
    );

    vi.useFakeTimers();
    const promise = refreshGpuTypeCache();
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    const tdWarnings = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].toLowerCase().includes('tensordock'),
    );
    expect(tdWarnings).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it('deduplicates GPU names within the same provider (keeps cheapest)', async () => {
    process.env.RUNPOD_API_KEY = 'rp-key';

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const offers = [
      { gpuName: 'RTX 4090', gpuType: 'RTX4090', vram: 24, pricePerHr: 0.9, available: 1, region: 'us' },
      { gpuName: 'RTX 4090', gpuType: 'RTX4090', vram: 24, pricePerHr: 0.5, available: 2, region: 'eu' }, // cheaper
    ];
    mockRunpod.listOffers.mockResolvedValueOnce(offers);

    await refreshGpuTypeCache();

    // Only one upsert (deduplicated)
    expect(mockPrisma.gpuTypeCache.upsert).toHaveBeenCalledTimes(1);
    const call = mockPrisma.gpuTypeCache.upsert.mock.calls[0][0];
    expect(call.create.pricePerHr).toBe(0.5); // cheaper one kept
  });
});
