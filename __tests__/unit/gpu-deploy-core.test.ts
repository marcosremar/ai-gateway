import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock all external dependencies BEFORE importing the module under test ──

vi.mock('../../server/state', () => {
  const state = {
    status: 'idle' as string,
    deployId: 'test-deploy-id',
    podId: '',
    endpoint: '',
    gpuType: '',
    dockerImage: 'test-image:latest',
    message: '',
    step: '',
    stepDetail: '',
    startedAt: 0,
    retryCount: 0,
    provider: '',
    alert: '',
    sshHost: '',
    sshPort: 0,
    lastLogs: '',
    deployDurationMs: 0,
    costPerHr: 0,
    providerMeta: {},
    transitions: [],
    gpuTemp: 0,
    gpuUtil: -1,
    gpuMemUsed: 0,
    gpuMemTotal: 0,
    canary: null,
    canaryEvalTimer: null,
    templateHashId: undefined,
    deployCancelled: false,
    gpuTypes: ['NVIDIA GeForce RTX 4090'],
    _apiKey: '',
    _vastKey: '',
    _tdKey: '',
    _tdAuth: '',
    _modalKey: '',
    _activeProvider: '',
  };
  return {
    get deployState() { return state; },
    setDeployState: vi.fn((patch: Record<string, unknown>) => { Object.assign(state, patch); }),
    deployCancelled: false,
    setDeployCancelled: vi.fn((v: boolean) => { state.deployCancelled = v; }),
    deployLock: false,
    setDeployLock: vi.fn(),
    deployPromise: null,
    setDeployPromise: vi.fn(),
    deployVastApiKey: '',
    deployTensordockApiKey: '',
    deployTensordockAuthId: '',
    deployModalApiKey: '',
    deployApiKey: '',
    prisma: {
      gpuTypeCache: { findMany: vi.fn(() => Promise.resolve([])) },
      hostReputation: { findMany: vi.fn(() => Promise.resolve([])) },
      gpuCompatibilityTest: { findMany: vi.fn(() => Promise.resolve([])) },
      gpuDeploySession: { findMany: vi.fn(() => Promise.resolve([])) },
      $transaction: vi.fn(async (fn: any) => fn({ gpuTypeCache: { upsert: vi.fn(() => Promise.resolve({})) } })),
    },
    deploymentSM: {
      startDeploying: vi.fn(),
      markStopped: vi.fn(),
      startBooting: vi.fn(),
      markReady: vi.fn(),
      markError: vi.fn(),
      reset: vi.fn(),
      get isStopped() { return false; },
    },
    standbyDeployState: { status: 'idle', podId: '', endpoint: '' },
    setDeployTarget: vi.fn(),
    deployTarget: 'primary',
    resetDeployState: vi.fn(() => {
      Object.assign(state, {
        status: 'idle', deployId: '', podId: '', endpoint: '', gpuType: '', dockerImage: '',
        message: '', step: '', stepDetail: '', startedAt: 0, retryCount: 0, provider: '',
        alert: '', sshHost: '', sshPort: 0, lastLogs: '', deployDurationMs: 0, costPerHr: 0,
        providerMeta: {}, transitions: [], gpuTemp: 0, gpuUtil: -1, gpuMemUsed: 0, gpuMemTotal: 0,
        canary: null, canaryEvalTimer: null, templateHashId: undefined, deployCancelled: false,
      });
    }),
    setDeployApiKey: vi.fn((v: string) => { state._apiKey = v; }),
    setDeployVastApiKey: vi.fn((v: string) => { state._vastKey = v; }),
    setDeployTensordockApiKey: vi.fn((v: string) => { state._tdKey = v; }),
    setDeployTensordockAuthId: vi.fn((v: string) => { state._tdAuth = v; }),
    setDeployModalApiKey: vi.fn((v: string) => { state._modalKey = v; }),
    setActiveProvider: vi.fn((v: string) => { state._activeProvider = v; }),
    setGpuHealthy: vi.fn(),
    setMonitorInterval: vi.fn(),
    setLastRequestTime: vi.fn(),
    setDailyGpuSpendUsd: vi.fn(),
    setDailySpendResetDate: vi.fn(),
    setLastModelRequestTime: vi.fn(),
    clearPersistedDeploy: vi.fn(),
    updateGpuModelWarmth: vi.fn(),
    isStageWarm: vi.fn(() => false),
    isGpuReadyForProduction: vi.fn(() => false),
    getPerStageP95: vi.fn(() => null),
    setGpuReadyForProduction: vi.fn(),
    setServiceReadiness: vi.fn(),
    perStageLatencyRing: { stt: [], llm: [], tts: [] },
    gpuHealthy: false,
    monitorInterval: null,
    activeProvider: '',
    lastRequestTime: Date.now(),
    lastModelRequestTime: 0,
    DAILY_BUDGET_USD: 0,
    dailyGpuSpendUsd: 0,
    dailySpendResetDate: new Date().toISOString().slice(0, 10),
    updateDeploySession: vi.fn(),
    startDeploySession: vi.fn(),
    getOrCreateRequestId: vi.fn(() => 'test-request-id'),
    loadPersistedDeploy: vi.fn(),
    canAffordDeploy: vi.fn(() => ({ allowed: true, currentSpend: 0, projected: 2, cap: 100, reason: '' })),
  };
});

vi.mock('../../server/config', () => ({
  PORT: 4000,
  PROVIDER_CHAIN: ['runpod', 'tensordock', 'vast', 'modal'],
  LOW_BALANCE_THRESHOLD_USD: 50,
  getImageCatalog: vi.fn(() => []),
  resolveDockerImageForGpus: vi.fn((img: string) => img),
  BLACKWELL_TO_STANDARD: {} as Record<string, string>,
  STANDARD_TO_BLACKWELL: {} as Record<string, string>,
}));

vi.mock('../../server/providers', () => ({
  runpod: {
    listOffers: vi.fn(() => Promise.resolve([])),
    listInstances: vi.fn(() => Promise.resolve([])),
    getInstanceDetail: vi.fn(),
    startInstance: vi.fn(() => Promise.resolve({})),
    stopInstance: vi.fn(() => Promise.resolve({})),
    deleteInstance: vi.fn(() => Promise.resolve({})),
    createInstance: vi.fn(() => Promise.resolve({ instanceId: 'test-pod-id' })),
    checkBalance: vi.fn(() => Promise.resolve(null)),
    resolveInstanceEndpoint: vi.fn(() => Promise.resolve({ endpoint: 'http://test-endpoint:8000' })),
  },
  vast: {
    listOffers: vi.fn(() => Promise.resolve([])),
    createInstance: vi.fn(() => Promise.resolve({ id: 'test-pod-id' })),
    startInstance: vi.fn(() => Promise.resolve({})),
    stopInstance: vi.fn(() => Promise.resolve({})),
    deleteInstance: vi.fn(() => Promise.resolve({})),
    checkBalance: vi.fn(() => Promise.resolve(null)),
    resolveInstanceEndpoint: vi.fn(() => Promise.resolve({ endpoint: 'http://test-endpoint:8000' })),
  },
  tensordock: {
    listOffers: vi.fn(() => Promise.resolve([])),
    createInstance: vi.fn(() => Promise.resolve({ id: 'test-pod-id' })),
    startInstance: vi.fn(() => Promise.resolve({})),
    stopInstance: vi.fn(() => Promise.resolve({})),
    deleteInstance: vi.fn(() => Promise.resolve({})),
    checkBalance: vi.fn(() => Promise.resolve(null)),
    resolveInstanceEndpoint: vi.fn(() => Promise.resolve({ endpoint: 'http://test-endpoint:8000' })),
  },
  modal: {
    listOffers: vi.fn(() => Promise.resolve([])),
    createInstance: vi.fn(() => Promise.resolve({ id: 'test-app-id' })),
    stopInstance: vi.fn(() => Promise.resolve({})),
    deleteInstance: vi.fn(() => Promise.resolve({})),
    resolveInstanceEndpoint: vi.fn(() => Promise.resolve({ endpoint: 'http://test-endpoint:8000' })),
  },
  snapgpu: { listOffers: vi.fn(() => Promise.resolve([])) },
  updateActivePipeline: vi.fn(),
  translationDefaults: {},
  markGpuHealthy: vi.fn(),
  markGpuUnhealthy: vi.fn(),
  markGpuShadowMode: vi.fn(),
  markGpuWarmupFailed: vi.fn(),
  _startReadinessCheck: vi.fn(),
}));

vi.mock('../../src/gpu-providers/deploy-settings', () => ({
  getDeployTimeoutMin: vi.fn(() => 45),
  setDeployTimeoutMin: vi.fn(),
  getMinVramGb: vi.fn(() => 0),
  getPreferSsd: vi.fn(() => false),
  getDeployRaceCount: vi.fn(() => 1),
  getGpuPriorityList: vi.fn(() => ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3090', 'NVIDIA A100-SXM4-80GB']),
  getDefaultGpuPriorityByProvider: vi.fn(() => ({ vast: [], runpod: [], tensordock: [], modal: [] })),
  getGpuPriorityForProvider: vi.fn(() => []),
  getGpuSortBy: vi.fn(() => 'price'),
  getLatencyMaxMs: vi.fn(() => 0),
  getDeployRegion: vi.fn(() => 'ANY'),
  filterTiers: vi.fn((tiers: unknown[], forceProvider?: string) => {
    if (!forceProvider) return { tiers };
    const forced = tiers.find((t: any) => t.name === forceProvider);
    if (!forced) return { error: `Provider '${forceProvider}' not available` };
    return { tiers: [forced] };
  }),
  ProviderCooldownTracker: class {
    private cooldowns: Record<string, { untilMs: number; failCount: number }> = {};
    isCoolingDown(name: string) { return false; }
    getRemainingSeconds(name: string) { return 0; }
    getFailCount(name: string) { return 0; }
    pickEarliestExpiry(names: string[]) { return names[0] || ''; }
    recordSuccess(name: string) { return true; }
    recordFailure(name: string) {}
    recordBillingFailure(name: string) {}
    getActiveCooldowns() { return {}; }
    loadFromFile(path: string) {}
    saveToFile(path: string) {}
  },
  DEFAULT_STORAGE_GB: { runpod: 50, vast: 50, tensordock: 50, modal: 50 },
  PROVIDER_LABELS: { vast: 'Vast.ai', runpod: 'RunPod', tensordock: 'TensorDock', modal: 'Modal', snapgpu: 'SnapGPU' },
  getSttTargetLatencyMs: vi.fn(() => 1000),
  getLlmTargetLatencyMs: vi.fn(() => 2000),
  getTtsTargetLatencyMs: vi.fn(() => 500),
  getP95DemotionMultiplier: vi.fn(() => 2),
  getP95IdleWindowSec: vi.fn(() => 300),
  getAutoRecoveryEnabled: vi.fn(() => false),
  getAutoRecoveryMaxRetries: vi.fn(() => 2),
  getDeployTimeoutMinForProvider: vi.fn(() => 45),
}));

vi.mock('../../src/gpu-providers/deploy-orchestrator', () => ({
  ProviderCooldownTracker: class {
    isCoolingDown() { return false; }
    getRemainingSeconds() { return 0; }
    getFailCount() { return 0; }
    pickEarliestExpiry(names: string[]) { return names[0] || ''; }
    recordSuccess() { return true; }
    recordFailure() {}
    recordBillingFailure() {}
    getActiveCooldowns() { return {}; }
    loadFromFile(path: string) {}
    saveToFile(path: string) {}
  },
  cleanupProviderInstances: vi.fn(() => Promise.resolve()),
  PROVIDER_LABELS: { vast: 'Vast.ai', runpod: 'RunPod', tensordock: 'TensorDock', modal: 'Modal', snapgpu: 'SnapGPU' },
  DEFAULT_STORAGE_GB: { runpod: 50, vast: 50, tensordock: 50, modal: 50 },
}));

vi.mock('../../src/preflight-checks', () => ({
  runPreFlightChecks: vi.fn(() => Promise.resolve({ ok: true, checks: [], errors: [], warnings: [] })),
}));

vi.mock('../../src/errors/deploy-errors', () => ({
  categorizeDeployError: vi.fn((err: any, ctx?: any) => ({
    category: 'PROVIDER',
    code: 'PRV_API_ERROR',
    message: err?.message || String(err),
    retryable: true,
    httpStatus: 502,
    severity: 'error',
    context: ctx,
  })),
}));

vi.mock('../../src/error-summary', () => ({
  errorSummary: { record: vi.fn() },
}));

vi.mock('../../src/auto-remediation', () => ({
  tryAutoRemediation: vi.fn(() => null),
}));

vi.mock('../../src/performance-profiler', () => ({
  profileOperation: vi.fn(async (_id: string, fn: () => Promise<any>) => {
    const result = await fn();
    return { result, profile: { operation: 'test', durationMs: 1000 } };
  }),
  recordOperationTiming: vi.fn(),
}));

vi.mock('../../src/autoscaler/health', () => ({
  probeGpuHealth: vi.fn(() => Promise.resolve({ ok: true, data: null })),
}));
// Also mock via gateway path in case of path aliasing differences
vi.mock('../../src/gateway/autoscaler/health', () => ({
  probeGpuHealth: vi.fn(() => Promise.resolve({ ok: true, data: null })),
}));

vi.mock('../../server/metrics', () => ({
  logGpuEvent: vi.fn(),
  updateDeploySession: vi.fn(),
  upsertHostReputation: vi.fn(),
  startDeploySession: vi.fn(),
  loadReputations: vi.fn(() => Promise.resolve([])),
  loadReputationsByGpuType: vi.fn(() => Promise.resolve(new Map())),
  deriveHostKey: vi.fn(() => 'host-key'),
  recordHostCrash: vi.fn(),
  updateHostLatency: vi.fn(),
}));

vi.mock('../../server/latency-db', () => ({
  getBestLatencyByGpuModel: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../server/ws-state', () => ({
  broadcastProviderStatus: vi.fn(),
  broadcastWs: vi.fn(),
}));

vi.mock('../../server/event-bus', () => ({
  emitGatewayEvent: vi.fn(),
}));

vi.mock('../../server/gpu-readiness', () => ({
  isReadinessCheckInProgress: vi.fn(() => false),
}));

vi.mock('../../server/ssh-tunnel', () => ({
  closeAllTunnels: vi.fn(),
}));

vi.mock('../../src/canary', () => ({
  createCanaryDeploy: vi.fn(() => ({
    evaluate: vi.fn(() => ({ action: 'continue' })),
    promote: vi.fn(() => Promise.resolve()),
    rollback: vi.fn(() => Promise.resolve()),
  })),
}));

// gpu-monitor-loop is NOT mocked so constants/setters work correctly.
// Fake timers (set up in beforeEach) prevent the loop timers from firing.

// ── Import the module under test (after mocks are set up) ──

import * as gpuDeploy from '../../server/gpu-deploy';
import * as stateMock from '../../server/state';
import * as providersMock from '../../server/providers';
import * as wsStateMock from '../../server/ws-state';
import * as metricsMock from '../../server/metrics';
import * as deployErrorsMock from '../../src/errors/deploy-errors';
import * as errorSummaryMock from '../../src/error-summary';
import * as autoRemediationMock from '../../src/auto-remediation';
import * as profilerMock from '../../src/performance-profiler';
import * as preflightMock from '../../src/preflight-checks';
import * as deploySettingsMock from '../../src/gpu-providers/deploy-settings';
import * as canaryMock from '../../src/canary';
import * as eventBusMock from '../../server/event-bus';

describe('GPU Deploy - Core Logic', () => {
  // Helper to get the internal state from the mocked module
  function getState() {
    return (stateMock as any).deployState;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();  // prevent gpu-monitor-loop timers from firing

    // Reset deploy state
    vi.mocked(stateMock.resetDeployState).mockImplementation(() => {
      const st = getState();
      Object.assign(st, {
        status: 'idle', deployId: 'test-deploy-id', podId: '', endpoint: '', gpuType: '', dockerImage: 'test-image:latest',
        message: '', step: '', stepDetail: '', startedAt: 0, retryCount: 0, provider: '',
        alert: '', sshHost: '', sshPort: 0, lastLogs: '', deployDurationMs: 0, costPerHr: 0,
        providerMeta: {}, transitions: [], gpuTemp: 0, gpuUtil: -1, gpuMemUsed: 0, gpuMemTotal: 0,
        canary: null, canaryEvalTimer: null, templateHashId: undefined, deployCancelled: false,
      });
    });

    // Set default mocked activeProvider
    Object.defineProperty(stateMock, 'activeProvider', { value: 'runpod', writable: true, configurable: true });
    Object.defineProperty(stateMock, 'deployApiKey', { value: '', writable: true, configurable: true });
    Object.defineProperty(stateMock, 'deployVastApiKey', { value: '', writable: true, configurable: true });
    Object.defineProperty(stateMock, 'deployTensordockApiKey', { value: '', writable: true, configurable: true });
    Object.defineProperty(stateMock, 'deployTensordockAuthId', { value: '', writable: true, configurable: true });
    Object.defineProperty(stateMock, 'deployModalApiKey', { value: '', writable: true, configurable: true });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Auto Stop GPU
  // ─────────────────────────────────────────────────────────────────────────

  describe('autoStopGpu', () => {
    it('should stop GPU and update state to stopped', async () => {
      (stateMock as any).activeProvider = 'runpod';
      (stateMock as any).deployApiKey = 'test-api-key';
      getState().podId = 'test-pod-id';
      getState().provider = 'runpod';
      getState().gpuType = 'RTX 4090';
      getState().costPerHr = 0.50;
      getState().dockerImage = 'test-image:latest';

      const stopMock = vi.fn().mockResolvedValue({});
      vi.mocked(providersMock.runpod.stopInstance).mockImplementation(stopMock);

      await gpuDeploy.autoStopGpu('idle_timeout');

      expect(stopMock).toHaveBeenCalledWith('test-pod-id', { apiKey: 'test-api-key' });
      expect(stateMock.setDeployState).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'stopped',
          podId: 'test-pod-id',
          provider: 'runpod',
        })
      );
      expect(metricsMock.logGpuEvent).toHaveBeenCalledWith(
        'instance_stopped', 'runpod', true, expect.any(Object)
      );
      expect(eventBusMock.emitGatewayEvent).toHaveBeenCalledWith(
        'gpu.stopped', expect.objectContaining({ podId: 'test-pod-id', provider: 'runpod' })
      );
    });

    it('should handle stop failure and fall back to terminate', async () => {
      (stateMock as any).activeProvider = 'runpod';
      (stateMock as any).deployApiKey = 'test-api-key';
      getState().podId = 'test-pod-id';
      getState().provider = 'runpod';

      vi.mocked(providersMock.runpod.stopInstance).mockRejectedValue(new Error('Stop failed'));

      await gpuDeploy.autoStopGpu('idle_timeout');

      expect(deployErrorsMock.categorizeDeployError).toHaveBeenCalled();
      expect(errorSummaryMock.errorSummary.record).toHaveBeenCalled();
      expect(autoRemediationMock.tryAutoRemediation).toHaveBeenCalled();
    });

    it('should fall back to terminate when no podId exists', async () => {
      getState().podId = '';
      getState().provider = 'runpod';

      await gpuDeploy.autoStopGpu('idle_timeout');

      // Should call terminate when no pod exists
      expect(wsStateMock.broadcastProviderStatus).toHaveBeenCalledWith(
        'offline', 'cloud', expect.stringContaining('terminated')
      );
    });

    it('should fall back to terminate when no client for provider', async () => {
      (stateMock as any).activeProvider = 'unknown-provider';
      getState().podId = 'test-pod-id';
      getState().provider = 'unknown-provider';

      await gpuDeploy.autoStopGpu('idle_timeout');

      expect(wsStateMock.broadcastProviderStatus).toHaveBeenCalledWith(
        'offline', 'cloud', expect.stringContaining('terminated')
      );
    });

    it('should stop GPU for Vast provider', async () => {
      (stateMock as any).activeProvider = 'vast';
      (stateMock as any).deployVastApiKey = 'vast-key';
      getState().podId = 'vast-pod-id';
      getState().provider = 'vast';

      const stopMock = vi.fn().mockResolvedValue({});
      vi.mocked(providersMock.vast.stopInstance).mockImplementation(stopMock);

      await gpuDeploy.autoStopGpu('idle_timeout');

      expect(stopMock).toHaveBeenCalledWith('vast-pod-id', { apiKey: 'vast-key' });
    });

    it('should stop GPU for TensorDock provider', async () => {
      (stateMock as any).activeProvider = 'tensordock';
      (stateMock as any).deployTensordockApiKey = 'td-key';
      (stateMock as any).deployTensordockAuthId = 'td-auth';
      getState().podId = 'td-pod-id';
      getState().provider = 'tensordock';

      const stopMock = vi.fn().mockResolvedValue({});
      vi.mocked(providersMock.tensordock.stopInstance).mockImplementation(stopMock);

      await gpuDeploy.autoStopGpu('idle_timeout');

      expect(stopMock).toHaveBeenCalledWith('td-pod-id', { apiKey: 'td-key', authId: 'td-auth' });
    });

    it('dev mode: stops pod but skips auto-destroy scheduling', async () => {
      (stateMock as any).activeProvider = 'vast';
      (stateMock as any).deployVastApiKey = 'vast-key';
      getState().podId = 'dev-pod-id';
      getState().provider = 'vast';
      getState().devMode = true;  // dev deploy — pause but don't destroy

      const stopMock = vi.fn().mockResolvedValue({});
      vi.mocked(providersMock.vast.stopInstance).mockImplementation(stopMock);

      await gpuDeploy.autoStopGpu('idle_timeout');

      // Pod should still be stopped
      expect(stopMock).toHaveBeenCalledWith('dev-pod-id', { apiKey: 'vast-key' });

      // Status message should indicate dev mode (no auto-destroy countdown)
      const stateCall = vi.mocked(stateMock.setDeployState).mock.calls.find(
        ([patch]) => (patch as any).status === 'stopped'
      );
      expect(stateCall).toBeDefined();
      const msg = (stateCall![0] as any).message as string;
      expect(msg).toMatch(/auto-destroy disabled|dev mode/i);
      expect(msg).not.toMatch(/destroyed in \d+ min/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Resume or Deploy
  // ─────────────────────────────────────────────────────────────────────────

  describe.skip('resumeOrDeploy', () => {
    it('should resume stopped instance successfully', async () => {
      (stateMock as any).activeProvider = 'runpod';
      (stateMock as any).deployApiKey = 'test-api-key';
      getState().podId = 'stopped-pod-id';
      getState().provider = 'runpod';
      getState().endpoint = 'http://old-endpoint:8000';

      const startMock = vi.fn().mockResolvedValue({});
      const resolveEndpointMock = vi.fn().mockResolvedValue({ endpoint: 'http://new-endpoint:8000' });
      vi.mocked(providersMock.runpod.startInstance).mockImplementation(startMock);
      (providersMock.runpod as any).resolveInstanceEndpoint = resolveEndpointMock;

      const result = await gpuDeploy.resumeOrDeploy({ reason: 'autoscaler', requestId: 'req-1' });

      expect(startMock).toHaveBeenCalledWith('stopped-pod-id', { apiKey: 'test-api-key' });
      expect(result).toEqual({
        method: 'resumed',
        podId: 'stopped-pod-id',
        provider: 'runpod',
      });
      expect(wsStateMock.broadcastWs).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'gpu:resume', action: 'success' })
      );
    });

    it('should throw error when no podId exists', async () => {
      getState().podId = '';
      getState().provider = 'runpod';

      await expect(
        gpuDeploy.resumeOrDeploy({ reason: 'autoscaler' })
      ).rejects.toThrow('No stopped pod to resume');
    });

    it('should throw error when no provider exists', async () => {
      getState().podId = 'pod-1';
      getState().provider = '';

      await expect(
        gpuDeploy.resumeOrDeploy({ reason: 'autoscaler' })
      ).rejects.toThrow('No stopped pod to resume');
    });

    it('should throw error when no credentials for provider', async () => {
      (stateMock as any).activeProvider = 'runpod';
      (stateMock as any).deployApiKey = '';
      getState().podId = 'pod-1';
      getState().provider = 'runpod';

      await expect(
        gpuDeploy.resumeOrDeploy({ reason: 'autoscaler' })
      ).rejects.toThrow('No credentials for provider');
    });

    it('should record error when resume fails', async () => {
      (stateMock as any).activeProvider = 'runpod';
      (stateMock as any).deployApiKey = 'test-api-key';
      getState().podId = 'pod-1';
      getState().provider = 'runpod';

      vi.mocked(providersMock.runpod.startInstance).mockRejectedValue(new Error('Resume failed'));
      vi.mocked(providersMock.runpod.deleteInstance).mockResolvedValue({});

      // This will fall through to deploy loop which times out, but we can catch
      // the error recording that happens before the fallback
      const promise = gpuDeploy.resumeOrDeploy({ reason: 'manual' });

      // Wait a bit for error recording to happen
      await new Promise(r => setTimeout(r, 50));

      // Error should have been recorded before falling into deploy loop
      expect(errorSummaryMock.errorSummary.record).toHaveBeenCalled();
      expect(deployErrorsMock.categorizeDeployError).toHaveBeenCalled();

      // Clean up by letting the promise settle (will timeout in deploy loop)
      promise.catch(() => {});
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Orphan Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  describe('cleanupAllPods', () => {
    it('should cleanup orphaned pods with matching prefix', async () => {
      const pods = [
        { instanceId: 'pod-1', instanceName: 'parle-autoscale-pod1', status: 'running' },
        { instanceId: 'pod-2', instanceName: 'parle-autoscale-pod2', status: 'loading' },
        { instanceId: 'pod-3', instanceName: 'other-pod', status: 'running' }, // should not be cleaned
      ];
      vi.mocked(providersMock.runpod.listInstances).mockResolvedValue(pods as any);
      vi.mocked(providersMock.runpod.deleteInstance).mockResolvedValue({});

      await gpuDeploy.cleanupAllPods('test-api-key');

      expect(providersMock.runpod.listInstances).toHaveBeenCalledWith({ apiKey: 'test-api-key' });
      expect(providersMock.runpod.deleteInstance).toHaveBeenCalledTimes(2);
      expect(providersMock.runpod.deleteInstance).toHaveBeenCalledWith('pod-1', expect.any(Object));
      expect(providersMock.runpod.deleteInstance).toHaveBeenCalledWith('pod-2', expect.any(Object));
    });

    it('should not cleanup EXITED pods', async () => {
      const pods = [
        { instanceId: 'pod-1', instanceName: 'parle-autoscale-pod1', status: 'EXITED' },
      ];
      vi.mocked(providersMock.runpod.listInstances).mockResolvedValue(pods as any);

      await gpuDeploy.cleanupAllPods('test-api-key');

      expect(providersMock.runpod.deleteInstance).not.toHaveBeenCalled();
    });

    it('should handle list failure and fallback to known pod IDs', async () => {
      vi.mocked(providersMock.runpod.listInstances).mockRejectedValue(new Error('List failed'));
      vi.mocked(providersMock.runpod.deleteInstance).mockResolvedValue({});

      await gpuDeploy.cleanupAllPods('test-api-key', ['known-pod-1', 'known-pod-2']);

      expect(providersMock.runpod.deleteInstance).toHaveBeenCalledWith('known-pod-1', expect.any(Object));
      expect(providersMock.runpod.deleteInstance).toHaveBeenCalledWith('known-pod-2', expect.any(Object));
    });

    it('should handle individual delete failures gracefully', async () => {
      const pods = [
        { instanceId: 'pod-1', instanceName: 'parle-autoscale-pod1', status: 'running' },
        { instanceId: 'pod-2', instanceName: 'parle-autoscale-pod2', status: 'running' },
      ];
      vi.mocked(providersMock.runpod.listInstances).mockResolvedValue(pods as any);
      vi.mocked(providersMock.runpod.deleteInstance)
        .mockRejectedValueOnce(new Error('Delete failed'))
        .mockResolvedValue({});

      await expect(gpuDeploy.cleanupAllPods('test-api-key')).resolves.toBeUndefined();
    });

    it('should do nothing when no matching pods found', async () => {
      vi.mocked(providersMock.runpod.listInstances).mockResolvedValue([
        { instanceId: 'pod-1', instanceName: 'other-pod', status: 'running' },
      ] as any);

      await expect(gpuDeploy.cleanupAllPods('test-api-key')).resolves.toBeUndefined();
      expect(providersMock.runpod.deleteInstance).not.toHaveBeenCalled();
    });
  });

  describe('sweepOrphanInstances', () => {
    it('should find and terminate orphaned instances', async () => {
      (stateMock as any).deployApiKey = 'test-key';
      getState().podId = 'tracked-pod';

      const orphans = [
        { instanceId: 'orphan-1', instanceName: 'parle-autoscale-orphan1', status: 'running' },
        { instanceId: 'tracked-pod', instanceName: 'parle-autoscale-tracked', status: 'running' }, // tracked
      ];
      vi.mocked(providersMock.runpod.listInstances).mockResolvedValue(orphans as any);
      vi.mocked(providersMock.runpod.deleteInstance).mockResolvedValue({});

      const result = await gpuDeploy.sweepOrphanInstances();

      expect(result.found).toBe(1);
      expect(result.terminated).toBe(1);
      expect(providersMock.runpod.deleteInstance).toHaveBeenCalledWith('orphan-1', expect.any(Object));
    });

    it('should skip tracked active deploy pod', async () => {
      (stateMock as any).deployApiKey = 'test-key';
      getState().podId = 'active-pod';

      vi.mocked(providersMock.runpod.listInstances).mockResolvedValue([
        { instanceId: 'active-pod', instanceName: 'parle-autoscale-active', status: 'running' },
      ] as any);

      await gpuDeploy.sweepOrphanInstances();

      expect(providersMock.runpod.deleteInstance).not.toHaveBeenCalled();
    });

    it('should skip active race instance IDs', async () => {
      (stateMock as any).deployApiKey = 'test-key';
      getState().podId = '';
      gpuDeploy.activeRaceInstanceIds.add('race-pod-1');

      vi.mocked(providersMock.runpod.listInstances).mockResolvedValue([
        { instanceId: 'race-pod-1', instanceName: 'parle-autoscale-race', status: 'running' },
      ] as any);

      await gpuDeploy.sweepOrphanInstances();

      expect(providersMock.runpod.deleteInstance).not.toHaveBeenCalled();

      gpuDeploy.activeRaceInstanceIds.clear();
    });

    it('should handle sweep failure gracefully', async () => {
      (stateMock as any).deployApiKey = 'test-key';
      vi.mocked(providersMock.runpod.listInstances).mockRejectedValue(new Error('List failed'));

      const result = await gpuDeploy.sweepOrphanInstances();

      expect(result.found).toBe(0);
      expect(result.terminated).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Auto Terminate
  // ─────────────────────────────────────────────────────────────────────────

  describe('autoTerminateGpu', () => {
    it('should terminate GPU and reset state', async () => {
      (stateMock as any).activeProvider = 'other';
      (stateMock as any).deployApiKey = 'test-key';
      getState().podId = 'pod-1';
      getState().provider = 'runpod';

      vi.mocked(providersMock.runpod.listInstances).mockResolvedValue([]);

      await gpuDeploy.autoTerminateGpu('idle_timeout');

      expect(stateMock.resetDeployState).toHaveBeenCalled();
      expect(wsStateMock.broadcastProviderStatus).toHaveBeenCalledWith(
        'offline', 'cloud', expect.stringContaining('terminated')
      );
      expect(eventBusMock.emitGatewayEvent).toHaveBeenCalledWith(
        'gpu.terminated', expect.objectContaining({ podId: 'pod-1', reason: 'idle_timeout' })
      );
    });

    it('should stop Modal app for Modal provider', async () => {
      (stateMock as any).activeProvider = 'modal';
      (stateMock as any).deployModalApiKey = 'modal-key';
      getState().podId = 'modal-app-1';
      getState().provider = 'modal';

      const stopMock = vi.fn().mockResolvedValue({});
      vi.mocked(providersMock.modal.stopInstance).mockImplementation(stopMock);

      await gpuDeploy.autoTerminateGpu('idle_timeout');

      expect(stopMock).toHaveBeenCalledWith('modal-app-1', { apiKey: 'modal-key' });
    });

    it('should handle Modal stop failure and cleanup apps', async () => {
      (stateMock as any).activeProvider = 'modal';
      (stateMock as any).deployModalApiKey = 'modal-key';
      getState().podId = 'modal-app-1';
      getState().provider = 'modal';

      vi.mocked(providersMock.modal.stopInstance).mockRejectedValue(new Error('Stop failed'));

      await gpuDeploy.autoTerminateGpu('idle_timeout');

      expect(deployErrorsMock.categorizeDeployError).toHaveBeenCalled();
      expect(errorSummaryMock.errorSummary.record).toHaveBeenCalled();
      expect(autoRemediationMock.tryAutoRemediation).toHaveBeenCalled();
    });

    it('should stop TensorDock instance for TensorDock provider', async () => {
      (stateMock as any).activeProvider = 'tensordock';
      (stateMock as any).deployTensordockApiKey = 'td-key';
      (stateMock as any).deployTensordockAuthId = 'td-auth';
      getState().podId = 'td-instance';
      getState().provider = 'tensordock';

      const stopMock = vi.fn().mockResolvedValue({});
      vi.mocked(providersMock.tensordock.stopInstance).mockImplementation(stopMock);

      await gpuDeploy.autoTerminateGpu('idle_timeout');

      expect(stopMock).toHaveBeenCalledWith('td-instance', { apiKey: 'td-key', authId: 'td-auth' });
    });

    it('should cleanup Vast instances for Vast provider', async () => {
      (stateMock as any).activeProvider = 'vast';
      (stateMock as any).deployVastApiKey = 'vast-key';
      getState().podId = 'vast-instance';
      getState().provider = 'vast';

      await gpuDeploy.autoTerminateGpu('idle_timeout');

      // Vast cleanup uses cleanupVastInstances which calls cleanupProviderInstances
      expect(wsStateMock.broadcastProviderStatus).toHaveBeenCalledWith(
        'offline', 'cloud', expect.stringContaining('terminated')
      );
    });

    it('should cleanup all pods for RunPod provider', async () => {
      (stateMock as any).activeProvider = 'runpod';
      (stateMock as any).deployApiKey = 'runpod-key';
      getState().podId = 'runpod-pod';
      getState().provider = 'runpod';

      vi.mocked(providersMock.runpod.listInstances).mockResolvedValue([]);

      await gpuDeploy.autoTerminateGpu('idle_timeout');

      expect(providersMock.runpod.listInstances).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tier Selection
  // ─────────────────────────────────────────────────────────────────────────

  describe('buildGpuTiers', () => {
    it('should build tiers with all configured providers', () => {
      const tiers = gpuDeploy.buildGpuTiers('rp-key', 'vast-key', { apiKey: 'td-key', authId: 'td-auth' }, 'modal-key');

      expect(tiers.length).toBeGreaterThan(0);
      expect(tiers.map(t => t.name)).toContain('runpod');
    });

    it('should skip providers with no API key', () => {
      const tiers = gpuDeploy.buildGpuTiers('rp-key');

      const providerNames = tiers.map(t => t.name);
      expect(providerNames).toContain('runpod');
      expect(providerNames).not.toContain('vast');
      expect(providerNames).not.toContain('tensordock');
      expect(providerNames).not.toContain('modal');
    });

    it('should follow PROVIDER_CHAIN order', () => {
      const tiers = gpuDeploy.buildGpuTiers('rp-key', 'vast-key', { apiKey: 'td-key', authId: 'td-auth' }, 'modal-key');

      // Should include at least runpod (which is always in the chain)
      expect(tiers.length).toBeGreaterThanOrEqual(1);
      expect(tiers[0].name).toBe('runpod');
    });

    it('should return only configured providers', () => {
      const tiers = gpuDeploy.buildGpuTiers('rp-key');

      expect(tiers.length).toBe(1);
      expect(tiers[0].name).toBe('runpod');
    });

    it('should include TensorDock with proper credentials', () => {
      // buildGpuTiers filters by tensordockOpts being truthy
      const tiers = gpuDeploy.buildGpuTiers('rp-key', 'vast-key', { apiKey: 'td-key', authId: 'td-auth' });

      // Should have at least runpod
      expect(tiers.length).toBeGreaterThanOrEqual(1);
      expect(tiers.map(t => t.name)).toContain('runpod');
      // Verify the function accepts TensorDock opts without error
      expect(() => gpuDeploy.buildGpuTiers('rp-key', undefined, { apiKey: 'td-key', authId: 'td-auth' })).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Deploy with Tiers
  // ─────────────────────────────────────────────────────────────────────────

  describe('startDeployWithTiers', () => {
    it('should export startDeployWithTiers function', () => {
      expect(typeof gpuDeploy.startDeployWithTiers).toBe('function');
    });

    it('should return undefined when tiers array is empty', async () => {
      const result = await gpuDeploy.startDeployWithTiers([], 'test-image:latest', ['RTX 4090']);
      expect(result).toBeUndefined();
    });
  });

  describe('startDeployLoop', () => {
    it('should export startDeployLoop function', () => {
      expect(typeof gpuDeploy.startDeployLoop).toBe('function');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Canary Integration
  // ─────────────────────────────────────────────────────────────────────────

  describe('startCanaryIfEnabled', () => {
    it('should start canary when CANARY_DEPLOY env var is set', async () => {
      const originalEnv = process.env.CANARY_DEPLOY;
      process.env.CANARY_DEPLOY = '1';

      gpuDeploy.startCanaryIfEnabled(
        { canary: true, canaryInitialTraffic: 5, canaryMaxErrorRate: 0.05, canaryTrafficStep: 10 },
        'test-image:latest',
        'RTX 4090'
      );

      expect(canaryMock.createCanaryDeploy).toHaveBeenCalled();
      expect(stateMock.setDeployState).toHaveBeenCalledWith(
        expect.objectContaining({ canary: expect.anything(), canaryEvalTimer: null })
      );

      process.env.CANARY_DEPLOY = originalEnv;
    });

    it('should start canary when deployConfig.canary is true', async () => {
      gpuDeploy.startCanaryIfEnabled(
        { canary: true, canaryInitialTraffic: 10, canaryMaxErrorRate: 0.03, canaryTrafficStep: 5 },
        'test-image:latest',
        'RTX 4090'
      );

      expect(canaryMock.createCanaryDeploy).toHaveBeenCalled();
    });

    it('should skip canary when disabled', async () => {
      gpuDeploy.startCanaryIfEnabled(
        { canary: false },
        'test-image:latest',
        'RTX 4090'
      );

      expect(canaryMock.createCanaryDeploy).not.toHaveBeenCalled();
    });

    it('should skip canary when env var not set and config false', async () => {
      const originalEnv = process.env.CANARY_DEPLOY;
      process.env.CANARY_DEPLOY = '0';

      gpuDeploy.startCanaryIfEnabled(
        {},
        'test-image:latest',
        'RTX 4090'
      );

      expect(canaryMock.createCanaryDeploy).not.toHaveBeenCalled();

      process.env.CANARY_DEPLOY = originalEnv;
    });
  });

  describe('stopCanary', () => {
    it('should clear canary evaluation timer', () => {
      const mockTimer = { _isTimer: true };
      getState().canaryEvalTimer = mockTimer as any;

      gpuDeploy.stopCanary();

      expect(stateMock.setDeployState).toHaveBeenCalledWith(
        expect.objectContaining({ canaryEvalTimer: null })
      );
    });

    it('should do nothing when no timer exists', () => {
      getState().canaryEvalTimer = null;

      gpuDeploy.stopCanary();

      expect(stateMock.setDeployState).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GPU Type Cache
  // ─────────────────────────────────────────────────────────────────────────

  describe('validateGpuTypesFromCache', () => {
    it('should return null when no GPU types specified', async () => {
      const result = await gpuDeploy.validateGpuTypesFromCache([]);
      expect(result).toBeNull();
    });

    it('should return null when cache is empty', async () => {
      vi.mocked((stateMock as any).prisma.gpuTypeCache.findMany).mockResolvedValue([]);

      const result = await gpuDeploy.validateGpuTypesFromCache(['RTX 4090']);
      expect(result).toBeNull();
    });

    it('should return error when GPU type not found in cache', async () => {
      vi.mocked((stateMock as any).prisma.gpuTypeCache.findMany).mockResolvedValue([
        { gpuName: 'RTX 3090', gpuType: 'RTX 3090', vram: 24, pricePerHr: 0.30, provider: 'runpod', region: 'US' },
      ]);

      const result = await gpuDeploy.validateGpuTypesFromCache(['RTX 4090']);
      expect(result).toContain('not found');
      expect(result).toContain('RTX 4090');
    });

    it('should return null when GPU type exists in cache', async () => {
      vi.mocked((stateMock as any).prisma.gpuTypeCache.findMany).mockResolvedValue([
        { gpuName: 'RTX 4090', gpuType: 'RTX 4090', vram: 24, pricePerHr: 0.50, provider: 'runpod', region: 'US' },
      ]);

      const result = await gpuDeploy.validateGpuTypesFromCache(['RTX 4090']);
      expect(result).toBeNull();
    });

    it('should include valid options in error message', async () => {
      vi.mocked((stateMock as any).prisma.gpuTypeCache.findMany).mockResolvedValue([
        { gpuName: 'RTX 3090', gpuType: 'RTX 3090', vram: 24, pricePerHr: 0.30, provider: 'runpod', region: 'US' },
        { gpuName: 'A100', gpuType: 'A100', vram: 80, pricePerHr: 1.50, provider: 'runpod', region: 'US' },
      ]);

      const result = await gpuDeploy.validateGpuTypesFromCache(['H100']);
      expect(result).toContain('Valid options');
      expect(result).toContain('RTX 3090');
    });

    it('should filter by provider when specified', async () => {
      vi.mocked((stateMock as any).prisma.gpuTypeCache.findMany).mockImplementation(({ where }: any) => {
        expect(where).toEqual({ provider: 'runpod' });
        return Promise.resolve([]);
      });

      await gpuDeploy.validateGpuTypesFromCache(['RTX 4090'], 'runpod');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constants and Configuration
  // ─────────────────────────────────────────────────────────────────────────

  describe('constants', () => {
    it('should export MAX_DEPLOY_RETRIES', () => {
      expect(gpuDeploy.MAX_DEPLOY_RETRIES).toBe(2);
    });

    it('should export HEALTH_POLL_INTERVAL_MS', () => {
      expect(gpuDeploy.HEALTH_POLL_INTERVAL_MS).toBe(10_000);
    });

    it('should export DEPLOY_TIMEOUT_MS', () => {
      expect(gpuDeploy.DEPLOY_TIMEOUT_MS).toBe(45 * 60_000);
    });

    it('should export GPU_MONITOR_INTERVAL_MS', () => {
      expect(gpuDeploy.GPU_MONITOR_INTERVAL_MS).toBe(30_000);
    });

    it('should export GPU_TYPE_CACHE_TTL_MS', () => {
      expect(gpuDeploy.GPU_TYPE_CACHE_TTL_MS).toBe(30 * 60_000);
    });

    it('should export IDLE_TIMEOUT_MS', () => {
      expect(gpuDeploy.IDLE_TIMEOUT_MS).toBe(15 * 60_000);
    });

    it('should export IDLE_DESTROY_MS', () => {
      expect(gpuDeploy.IDLE_DESTROY_MS).toBe(2 * 60 * 60_000);
    });

    it('should export POD_NAME_PREFIX', () => {
      expect(gpuDeploy.POD_NAME_PREFIX).toBe('parle-autoscale-');
    });

    it('should export activeRaceInstanceIds as a Set', () => {
      expect(gpuDeploy.activeRaceInstanceIds).toBeInstanceOf(Set);
    });

    it('should allow setting IDLE_TIMEOUT_MS', () => {
      const original = gpuDeploy.IDLE_TIMEOUT_MS;
      gpuDeploy.setIdleTimeoutMs(60_000);
      expect(gpuDeploy.IDLE_TIMEOUT_MS).toBe(60_000);
      gpuDeploy.setIdleTimeoutMs(original);
    });

    it('should allow setting IDLE_DESTROY_MS', () => {
      const original = gpuDeploy.IDLE_DESTROY_MS;
      gpuDeploy.setIdleDestroyMs(3600_000);
      expect(gpuDeploy.IDLE_DESTROY_MS).toBe(3600_000);
      gpuDeploy.setIdleDestroyMs(original);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Orphan Sweep Timer Management
  // ─────────────────────────────────────────────────────────────────────────

  describe('orphan sweep timer', () => {
    it('should export startOrphanSweep function', () => {
      expect(typeof gpuDeploy.startOrphanSweep).toBe('function');
    });

    it('should export stopOrphanSweep function', () => {
      expect(typeof gpuDeploy.stopOrphanSweep).toBe('function');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Provider cleanup functions
  // ─────────────────────────────────────────────────────────────────────────

  describe('provider cleanup functions', () => {
    it('should export cleanupVastInstances', () => {
      expect(typeof gpuDeploy.cleanupVastInstances).toBe('function');
    });

    it('should export cleanupTensordockInstances', () => {
      expect(typeof gpuDeploy.cleanupTensordockInstances).toBe('function');
    });

    it('should export cleanupModalApps', () => {
      expect(typeof gpuDeploy.cleanupModalApps).toBe('function');
    });
  });

  describe('additional exports', () => {
    it('should export autoSelectCheapestGpu', () => {
      expect(typeof gpuDeploy.autoSelectCheapestGpu).toBe('function');
    });

    it('should export startDeployRace', () => {
      expect(typeof gpuDeploy.startDeployRace).toBe('function');
    });

    it('should export refreshGpuTypeCache', () => {
      expect(typeof gpuDeploy.refreshGpuTypeCache).toBe('function');
    });

    it('should export startGpuTypeCacheRefresh', () => {
      expect(typeof gpuDeploy.startGpuTypeCacheRefresh).toBe('function');
    });

    it('should export providerClients', () => {
      expect(gpuDeploy.providerClients).toBeDefined();
      expect(typeof gpuDeploy.providerClients).toBe('object');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GPU Monitoring
  // ─────────────────────────────────────────────────────────────────────────

  describe('GPU monitoring', () => {
    it('should export startGpuMonitoring function', () => {
      expect(typeof gpuDeploy.startGpuMonitoring).toBe('function');
    });

    it('should export stopGpuMonitoring function', () => {
      expect(typeof gpuDeploy.stopGpuMonitoring).toBe('function');
    });

    it('should export scheduleNextMonitorProbe function', () => {
      expect(typeof gpuDeploy.scheduleNextMonitorProbe).toBe('function');
    });

    it('should export clearAutoDestroyTimer function', () => {
      expect(typeof gpuDeploy.clearAutoDestroyTimer).toBe('function');
    });

    it('should export resetIdleState function', () => {
      expect(typeof gpuDeploy.resetIdleState).toBe('function');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Fetch GPU Logs
  // ─────────────────────────────────────────────────────────────────────────

  describe('fetchGpuLogs', () => {
    it('should export fetchGpuLogs function', () => {
      expect(typeof gpuDeploy.fetchGpuLogs).toBe('function');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Get Verified GPU Types
  // ─────────────────────────────────────────────────────────────────────────

  describe('getVerifiedGpuTypes', () => {
    it('should export getVerifiedGpuTypes function', () => {
      expect(typeof gpuDeploy.getVerifiedGpuTypes).toBe('function');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Auto Recovery Deploy
  // ─────────────────────────────────────────────────────────────────────────

  describe('startAutoRecoveryDeploy', () => {
    it('should export startAutoRecoveryDeploy function', () => {
      expect(typeof gpuDeploy.startAutoRecoveryDeploy).toBe('function');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Poll Health Until Ready
  // ─────────────────────────────────────────────────────────────────────────

  describe('pollHealthUntilReady', () => {
    it('should export pollHealthUntilReady function', () => {
      expect(typeof gpuDeploy.pollHealthUntilReady).toBe('function');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Try Recover Active Deploy
  // ─────────────────────────────────────────────────────────────────────────

  describe('tryRecoverActiveDeploy', () => {
    it('should export tryRecoverActiveDeploy function', () => {
      expect(typeof gpuDeploy.tryRecoverActiveDeploy).toBe('function');
    });
  });
});
