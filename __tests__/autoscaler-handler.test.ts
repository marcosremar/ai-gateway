import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAutoscalerGet, handleAutoscalerAction } from '@ai-gateway/handlers/autoscaler-handler';
import type { HandlerDeps } from '@ai-gateway/handlers/types';
import type { AutoScalerConfig } from '@ai-gateway/types';
import type { GpuProviderClient, MonitorableProvider } from '@ai-gateway/gpu-providers/types';
import { GpuProviderRegistry } from '@ai-gateway/gpu-providers/registry';

// ── Mock autoscaler deps ────────────────────────────────────────────────

function makeMockClient(providerId: string): GpuProviderClient & { listInstances: ReturnType<typeof vi.fn> } {
  return {
    providerId,
    bootTimeSecs: 120,
    discoverInstance: vi.fn().mockResolvedValue(null),
    createInstance: vi.fn().mockResolvedValue({ instanceId: 'i-1', endpoint: 'http://x', status: 'running' }),
    startInstance: vi.fn().mockResolvedValue(undefined),
    stopInstance: vi.fn().mockResolvedValue(undefined),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
    getInstanceStatus: vi.fn().mockResolvedValue('running'),
    listInstances: vi.fn().mockResolvedValue([]),
    resolveInstanceEndpoint: vi.fn().mockResolvedValue('http://resolved'),
  };
}

function createDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const registry = new GpuProviderRegistry();
  const mockClient = makeMockClient('tensordock');
  registry.register(mockClient);
  registry.register(makeMockClient('runpod'));
  registry.register(makeMockClient('vast'));
  registry.register(makeMockClient('modal'));

  return {
    autoscaler: {
      getAutoScaleDecision: vi.fn().mockResolvedValue({
        enabled: true,
        route: 'llm',
        reason: 'Below threshold',
        activeSessions: 0,
        threshold: 5,
        maxLatencyMs: 1500,
        p95LatencyMs: null,
        gpuState: 'idle',
      }),
      scheduleReconcile: vi.fn().mockResolvedValue(undefined),
      scheduleWatchdog: vi.fn().mockResolvedValue(undefined),
      reportSessionHeartbeat: vi.fn().mockResolvedValue(undefined),
      reportLatency: vi.fn().mockResolvedValue(undefined),
      resetGpuState: vi.fn(),
      forceGpuReady: vi.fn(),
      getPoolStatus: vi.fn().mockReturnValue([]),
      stopTier: vi.fn().mockResolvedValue({ ok: true }),
      startTier: vi.fn().mockResolvedValue({ ok: true }),
      deleteTier: vi.fn().mockResolvedValue({ ok: true }),
      restartTier: vi.fn().mockResolvedValue({ ok: true }),
      deployTier: vi.fn().mockResolvedValue({ ok: true }),
      getTierDetail: vi.fn().mockResolvedValue({ tierIndex: 0, state: 'idle' }),
      getAllTierDetails: vi.fn().mockResolvedValue([]),
      reportInferenceBenchmark: vi.fn().mockResolvedValue(undefined),
      getBenchmarkSummary: vi.fn().mockResolvedValue({ date: '2026-03-03', boot: null, inference: { total: null, stt: null, llm: null, tts: null, ttfa: null }, byProvider: {} }),
      getBenchmarkTrend: vi.fn().mockResolvedValue({ dates: [], bootP95: [], inferP95: [], inferMean: [] }),
      getReadyEndpoints: vi.fn().mockReturnValue([]),
      removeSession: vi.fn(),
      registry,
    } as any,
    settingsStore: {
      get: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue(undefined),
    },
    credentialStore: {
      resolve: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
    },
    lifecycleLogStore: {
      query: vi.fn().mockResolvedValue([]),
    },
    userRoleResolver: {
      resolveVisibleUserIds: vi.fn().mockResolvedValue(['user-1']),
    },
    benchmarkStore: {
      create: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    },
    signGpuToken: vi.fn().mockReturnValue('signed-token-123'),
    ...overrides,
  };
}

const userId = 'user-1';

function makeConfig(overrides: Partial<AutoScalerConfig> = {}): AutoScalerConfig {
  return {
    enabled: true,
    threshold: 5,
    windowMinutes: 10,
    maxLatencyMs: 1500,
    tiers: [{ provider: 'tensordock', gpuTypes: ['RTX 3090'] }],
    ...overrides,
  } as AutoScalerConfig;
}

const loadConfigNull = vi.fn().mockResolvedValue(null);
const loadConfigEnabled = vi.fn().mockResolvedValue(makeConfig());

describe('autoscaler-handler', () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
  });

  // ── handleAutoscalerGet ───────────────────────────────────────────────

  describe('handleAutoscalerGet', () => {
    it('returns decision with GPU token when route=s2s', async () => {
      vi.mocked(deps.autoscaler.getAutoScaleDecision).mockResolvedValueOnce({
        enabled: true,
        route: 's2s',
        endpoint: 'http://gpu:8000',
        reason: 'GPU ready',
        activeSessions: 3,
        threshold: 5,
        maxLatencyMs: 1500,
        p95LatencyMs: 800,
        gpuState: 'ready',
        activeTiers: 1,
        bootingTiers: 0,
        totalTiers: 1,
      });

      const result = await handleAutoscalerGet(deps, userId, loadConfigEnabled);
      expect(result.status).toBe(200);
      const body = result.body as Record<string, unknown>;
      expect(body.route).toBe('s2s');
      expect(body.gpuToken).toBe('signed-token-123');
    });

    it('returns disabled state when config is null', async () => {
      const result = await handleAutoscalerGet(deps, userId, loadConfigNull);
      expect(result.status).toBe(200);
      const body = result.body as Record<string, unknown>;
      expect(body.enabled).toBe(false);
      expect(body.route).toBe('llm');
    });

    it('fires reconcile + watchdog in background', async () => {
      await handleAutoscalerGet(deps, userId, loadConfigEnabled);
      expect(deps.autoscaler.scheduleReconcile).toHaveBeenCalledWith(userId);
      expect(deps.autoscaler.scheduleWatchdog).toHaveBeenCalledWith(userId, expect.any(Object));
    });

    it('uses own autoscaler config for enabled state when main config null', async () => {
      const readOwn = vi.fn().mockResolvedValue({ enabled: true, threshold: 10 });
      const result = await handleAutoscalerGet(deps, userId, loadConfigNull, readOwn);
      const body = result.body as Record<string, unknown>;
      expect(body.enabled).toBe(true);
      expect(body.threshold).toBe(10);
    });
  });

  // ── save-config ───────────────────────────────────────────────────────

  describe('save-config', () => {
    it('saves valid config and resets state', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'save-config', {
        enabled: true,
        threshold: 5,
        windowMinutes: 10,
        maxLatencyMs: 1500,
        gpuProvider: 'tensordock',
      }, loadConfigEnabled);

      expect(result.status).toBe(200);
      expect(deps.settingsStore.patch).toHaveBeenCalledWith(userId, expect.objectContaining({
        autoscaler: expect.objectContaining({ enabled: true, threshold: 5 }),
      }));
      expect(deps.autoscaler.resetGpuState).toHaveBeenCalledWith(userId);
    });

    it('rejects threshold < 1', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'save-config', {
        threshold: 0, windowMinutes: 10,
      }, loadConfigEnabled);
      expect(result.status).toBe(400);
      expect((result.body as Record<string, unknown>).error).toContain('threshold');
    });

    it('rejects threshold > 100', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'save-config', {
        threshold: 101, windowMinutes: 10,
      }, loadConfigEnabled);
      expect(result.status).toBe(400);
    });

    it('rejects maxLatencyMs < 500', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'save-config', {
        threshold: 5, windowMinutes: 10, maxLatencyMs: 100,
      }, loadConfigEnabled);
      expect(result.status).toBe(400);
      expect((result.body as Record<string, unknown>).error).toContain('maxLatencyMs');
    });

    it('accepts maxLatencyMs = 500 (boundary)', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'save-config', {
        enabled: true, threshold: 5, windowMinutes: 10, maxLatencyMs: 500,
      }, loadConfigEnabled);
      expect(result.status).toBe(200);
    });
  });

  // ── pool-status ───────────────────────────────────────────────────────

  describe('pool-status', () => {
    it('enriches tier states with config data', async () => {
      vi.mocked(deps.autoscaler.getPoolStatus).mockReturnValueOnce([
        { state: 'ready', endpoint: 'http://gpu:8000' },
      ] as any);

      const config = makeConfig({ tiers: [{ provider: 'runpod', instanceId: 'pod-1', endpoint: 'http://gpu:8000', gpuTypes: ['RTX 4090'] }] });
      const loadCfg = vi.fn().mockResolvedValue(config);

      const result = await handleAutoscalerAction(deps, userId, 'pool-status', {}, loadCfg);
      expect(result.status).toBe(200);
      const body = result.body as Record<string, unknown>;
      const tiers = body.tiers as Array<Record<string, unknown>>;
      expect(tiers[0].provider).toBe('runpod');
      expect(tiers[0].instanceId).toBe('pod-1');
    });

    it('returns config metadata', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'pool-status', {}, loadConfigEnabled);
      const body = result.body as Record<string, unknown>;
      expect(body.config).not.toBeNull();
      expect((body.config as Record<string, unknown>).enabled).toBe(true);
    });
  });

  // ── report-session / report-latency ───────────────────────────────────

  describe('report-session', () => {
    it('calls reportSessionHeartbeat', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'report-session', {
        sessionKey: 'session-abc',
      }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.reportSessionHeartbeat).toHaveBeenCalledWith(userId, 'session-abc');
    });

    it('ignores empty sessionKey', async () => {
      await handleAutoscalerAction(deps, userId, 'report-session', {
        sessionKey: '',
      }, loadConfigEnabled);
      expect(deps.autoscaler.reportSessionHeartbeat).not.toHaveBeenCalled();
    });
  });

  describe('report-latency', () => {
    it('calls reportLatency with valid totalMs', async () => {
      await handleAutoscalerAction(deps, userId, 'report-latency', {
        totalMs: 1200,
      }, loadConfigEnabled);
      expect(deps.autoscaler.reportLatency).toHaveBeenCalledWith(userId, 1200);
    });

    it('ignores invalid totalMs', async () => {
      await handleAutoscalerAction(deps, userId, 'report-latency', {
        totalMs: -1,
      }, loadConfigEnabled);
      expect(deps.autoscaler.reportLatency).not.toHaveBeenCalled();
    });
  });

  // ── reset / force-ready ───────────────────────────────────────────────

  describe('reset', () => {
    it('resets GPU state', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'reset', {}, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.resetGpuState).toHaveBeenCalledWith(userId);
    });
  });

  describe('force-ready', () => {
    it('marks GPU as ready with endpoint', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'force-ready', {
        endpoint: 'http://gpu:8000',
      }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.forceGpuReady).toHaveBeenCalledWith(userId, 'http://gpu:8000');
    });

    it('returns error when endpoint missing', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'force-ready', {}, loadConfigEnabled);
      expect(result.status).toBe(400);
      expect((result.body as Record<string, unknown>).error).toContain('endpoint');
    });
  });

  // ── get-decision ──────────────────────────────────────────────────────

  describe('get-decision', () => {
    it('returns decision when config exists', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'get-decision', {}, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect((result.body as Record<string, unknown>).enabled).toBe(true);
    });

    it('returns disabled when no config', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'get-decision', {}, loadConfigNull);
      expect(result.status).toBe(200);
      expect((result.body as Record<string, unknown>).enabled).toBe(false);
    });
  });

  // ── lifecycle-logs ────────────────────────────────────────────────────

  describe('lifecycle-logs', () => {
    it('queries with userRoleResolver and limit', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'lifecycle-logs', {
        limit: 100,
      }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.userRoleResolver!.resolveVisibleUserIds).toHaveBeenCalledWith(userId);
      expect(deps.lifecycleLogStore!.query).toHaveBeenCalledWith(expect.objectContaining({
        userIds: ['user-1'],
        limit: 100,
      }));
    });

    it('caps limit at 200', async () => {
      await handleAutoscalerAction(deps, userId, 'lifecycle-logs', {
        limit: 500,
      }, loadConfigEnabled);
      expect(deps.lifecycleLogStore!.query).toHaveBeenCalledWith(expect.objectContaining({
        limit: 200,
      }));
    });

    it('returns error when lifecycleLogStore not configured', async () => {
      const depsNoLog = createDeps({ lifecycleLogStore: undefined });
      const result = await handleAutoscalerAction(depsNoLog, userId, 'lifecycle-logs', {}, loadConfigEnabled);
      expect(result.status).toBe(500);
    });
  });

  // ── destroy-all ───────────────────────────────────────────────────────

  describe('destroy-all', () => {
    it('deletes all tiers and resets', async () => {
      const config = makeConfig({ tiers: [
        { provider: 'runpod', gpuTypes: [] },
        { provider: 'tensordock', gpuTypes: [] },
      ] });
      const loadCfg = vi.fn().mockResolvedValue(config);

      const result = await handleAutoscalerAction(deps, userId, 'destroy-all', {}, loadCfg);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.deleteTier).toHaveBeenCalledTimes(2);
      expect(deps.autoscaler.resetGpuState).toHaveBeenCalledWith(userId);
    });
  });

  // ── Tier lifecycle ────────────────────────────────────────────────────

  describe('tier lifecycle actions', () => {
    it('stop-tier validates tierIndex', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'stop-tier', {}, loadConfigEnabled);
      expect(result.status).toBe(400);
    });

    it('stop-tier calls stopTier', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'stop-tier', { tierIndex: 0 }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.stopTier).toHaveBeenCalledWith(userId, 0);
    });

    it('start-tier calls startTier', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'start-tier', { tierIndex: 1 }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.startTier).toHaveBeenCalledWith(userId, 1);
    });

    it('delete-tier calls deleteTier', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'delete-tier', { tierIndex: 0 }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.deleteTier).toHaveBeenCalledWith(userId, 0);
    });

    it('restart-tier calls restartTier', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'restart-tier', { tierIndex: 0 }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.restartTier).toHaveBeenCalledWith(userId, 0);
    });

    it('deploy-tier calls deployTier', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'deploy-tier', { tierIndex: 0 }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.deployTier).toHaveBeenCalledWith(userId, 0);
    });
  });

  // ── tier-detail / all-tier-details ────────────────────────────────────

  describe('tier-detail', () => {
    it('returns tier detail', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'tier-detail', { tierIndex: 0 }, loadConfigEnabled);
      expect(result.status).toBe(200);
    });

    it('returns error for not found', async () => {
      vi.mocked(deps.autoscaler.getTierDetail).mockResolvedValueOnce(null);
      const result = await handleAutoscalerAction(deps, userId, 'tier-detail', { tierIndex: 99 }, loadConfigEnabled);
      expect(result.status).toBe(400);
    });
  });

  describe('all-tier-details', () => {
    it('returns all details', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'all-tier-details', {}, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect((result.body as Record<string, unknown>).tiers).toBeDefined();
    });
  });

  // ── Benchmark tracking ────────────────────────────────────────────────

  describe('report-inference-benchmark', () => {
    it('records benchmark with valid totalMs', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'report-inference-benchmark', {
        provider: 'runpod',
        endpoint: 'http://gpu:8000',
        totalMs: 1500,
        sttMs: 200,
        llmMs: 800,
        ttsMs: 500,
      }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.reportInferenceBenchmark).toHaveBeenCalled();
    });

    it('rejects missing totalMs', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'report-inference-benchmark', {
        provider: 'runpod',
      }, loadConfigEnabled);
      expect(result.status).toBe(400);
    });
  });

  describe('benchmark-summary', () => {
    it('returns summary', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'benchmark-summary', {}, loadConfigEnabled);
      expect(result.status).toBe(200);
    });
  });

  describe('benchmark-trend', () => {
    it('returns trend data', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'benchmark-trend', { days: 7 }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect(deps.autoscaler.getBenchmarkTrend).toHaveBeenCalledWith(userId, 7);
    });
  });

  // ── Modal actions ─────────────────────────────────────────────────────

  describe('modal-stop', () => {
    it('requires appId', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'modal-stop', {}, loadConfigEnabled);
      expect(result.status).toBe(400);
    });

    it('returns error when no credentials', async () => {
      vi.mocked(deps.credentialStore.resolve).mockResolvedValueOnce(null);
      const result = await handleAutoscalerAction(deps, userId, 'modal-stop', {
        appId: 'ap-1',
      }, loadConfigEnabled);
      expect(result.status).toBe(400);
      expect((result.body as Record<string, unknown>).error).toContain('Modal API key');
    });
  });

  describe('modal-status', () => {
    it('returns error when no credentials', async () => {
      vi.mocked(deps.credentialStore.resolve).mockResolvedValueOnce(null);
      const result = await handleAutoscalerAction(deps, userId, 'modal-status', {}, loadConfigEnabled);
      expect(result.status).toBe(400);
    });
  });

  // ── Instance CRUD ─────────────────────────────────────────────────────

  describe('instance-list', () => {
    it('validates provider', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'instance-list', {
        provider: 'invalid',
      }, loadConfigEnabled);
      expect(result.status).toBe(400);
    });

    it('returns error when no credentials', async () => {
      vi.mocked(deps.credentialStore.resolve).mockResolvedValueOnce(null);
      const result = await handleAutoscalerAction(deps, userId, 'instance-list', {
        provider: 'runpod',
      }, loadConfigEnabled);
      expect(result.status).toBe(400);
    });

    it('lists instances for valid provider', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'instance-list', {
        provider: 'runpod',
      }, loadConfigEnabled);
      expect(result.status).toBe(200);
      expect((result.body as Record<string, unknown>).provider).toBe('runpod');
    });
  });

  describe('instance-create', () => {
    it('validates provider', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'instance-create', {
        provider: 'bogus',
      }, loadConfigEnabled);
      expect(result.status).toBe(400);
    });

    it('creates instance for valid provider', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'instance-create', {
        provider: 'runpod',
        gpuTypes: ['RTX 4090'],
      }, loadConfigEnabled);
      expect(result.status).toBe(200);
    });
  });

  describe('instance-start/stop/delete/status', () => {
    it('instance-start requires provider and instanceId', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'instance-start', {
        provider: 'runpod',
      }, loadConfigEnabled);
      expect(result.status).toBe(400);
    });

    it('instance-stop works with valid params', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'instance-stop', {
        provider: 'runpod',
        instanceId: 'pod-1',
      }, loadConfigEnabled);
      expect(result.status).toBe(200);
    });

    it('instance-delete works', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'instance-delete', {
        provider: 'runpod',
        instanceId: 'pod-1',
      }, loadConfigEnabled);
      expect(result.status).toBe(200);
    });

    it('instance-status returns status + endpoint', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'instance-status', {
        provider: 'runpod',
        instanceId: 'pod-1',
      }, loadConfigEnabled);
      expect(result.status).toBe(200);
      const body = result.body as Record<string, unknown>;
      expect(body.status).toBe('running');
    });
  });

  // ── Unknown action ────────────────────────────────────────────────────

  describe('unknown action', () => {
    it('returns error for unknown action', async () => {
      const result = await handleAutoscalerAction(deps, userId, 'does-not-exist', {}, loadConfigEnabled);
      expect(result.status).toBe(400);
      expect((result.body as Record<string, unknown>).error).toContain('desconhecida');
    });
  });
});
