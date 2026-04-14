/**
 * Tests for self-hosted provider warmup, alwaysActive, and replicas.
 *
 * Covers:
 * - warmup() only warms self-hosted providers (skips cloud)
 * - warmup() health-checks self-hosted endpoints
 * - replicas expand the fallback chain for self-hosted only
 * - watchdog skips alwaysActive tiers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AIClient } from '../../src/client/ai-client';
import { AIProviderRegistry } from '../../src/providers/registry';
import type { AIProfile, StageConfig } from '../../src/client/types';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  STTProvider,
  STTRequest,
  STTResponse,
  ModelInfo,
  ProviderId,
} from '../../src/providers/types';
import { runWatchdogCycle } from '../../src/autoscaler/watchdog';
import type { WatchdogDeps } from '../../src/autoscaler/watchdog';
import type {
  AutoScalerConfig,
  ReadyTierState,
  GpuTierState,
  IdleTierState,
} from '../../src/types';

// ── Mock providers ─────────────────────────────────────────────────────────

class MockLLMProvider implements LLMProvider {
  readonly providerId = 'mock-llm';
  calls = 0;

  isConfigured() {
    return true;
  }
  withApiKey() {
    return this;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    return { content: 'mock response', model: request.model || 'mock' };
  }
}

class MockSTTProvider {
  readonly providerId: ProviderId = 'groq';

  isConfigured() {
    return true;
  }
  getModels(): ModelInfo[] {
    return [];
  }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    return { text: 'mock transcription' };
  }
}

function makeRegistry(): {
  registry: AIProviderRegistry;
  llm: MockLLMProvider;
  stt: MockSTTProvider;
} {
  const registry = new AIProviderRegistry();
  const llm = new MockLLMProvider();
  const stt = new MockSTTProvider();

  registry.register({
    id: 'ollama',
    name: 'Ollama',
    description: 'Local Ollama',
    capabilities: ['llm', 'stt'],
    requiresApiKey: false,
    llm,
    stt: stt as unknown as STTProvider,
  });

  registry.register({
    id: 'groq',
    name: 'Groq',
    description: 'Groq Cloud',
    capabilities: ['llm', 'stt'],
    requiresApiKey: true,
    llm: new MockLLMProvider(),
    stt: new MockSTTProvider() as unknown as STTProvider,
  });

  return { registry, llm, stt };
}

// ── Warmup tests ───────────────────────────────────────────────────────────

describe('AIClient.warmup() — self-hosted', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('health-checks self-hosted endpoints on warmup', async () => {
    const { registry } = makeRegistry();

    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: 'llama3.2',
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
          },
        ],
        stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
      },
    });

    const result = await client.warmup();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('ok');
    expect(result.entries[0].provider).toBe('ollama');
    // Should have called fetch with the health endpoint
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:11434/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('skips cloud providers — does NOT warm them up', async () => {
    const { registry } = makeRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          { provider: 'groq', model: 'llama-3.3-70b-versatile', alwaysActive: true },
          {
            provider: 'ollama',
            model: 'llama3.2',
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
          },
        ],
        stt: [{ provider: 'groq' }],
      },
    });

    fetchSpy.mockResolvedValue({ ok: true });

    const result = await client.warmup();

    // Only the self-hosted provider should be warmed
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].provider).toBe('ollama');
  });

  it('warms multiple replicas in parallel', async () => {
    const { registry } = makeRegistry();

    fetchSpy.mockResolvedValue({ ok: true });

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: 'llama3.2',
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
            replicas: 3,
          },
        ],
        stt: [{ provider: 'groq' }],
      },
    });

    const result = await client.warmup();

    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((e) => e.status === 'ok')).toBe(true);
    // fetch should have been called 3 times (one per replica)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('reports error when self-hosted endpoint is not reachable', async () => {
    const { registry } = makeRegistry();

    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: 'llama3.2',
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
          },
        ],
        stt: [{ provider: 'groq' }],
      },
    });

    const result = await client.warmup();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('error');
    expect(result.entries[0].error).toContain('not reachable');
  });

  it('skips selfHosted without endpoint and logs warning', async () => {
    const { registry } = makeRegistry();

    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [{ provider: 'ollama', model: 'llama3.2', selfHosted: true, alwaysActive: true }],
        stt: [{ provider: 'groq' }],
      },
      logger,
    });

    const result = await client.warmup();

    expect(result.entries).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('selfHosted requires endpoint'),
    );
  });

  it('falls back to /v1/models when /health fails', async () => {
    const { registry } = makeRegistry();

    let callCount = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes('/health')) {
        throw new Error('not found');
      }
      if (url.includes('/v1/models')) {
        return { ok: true };
      }
      throw new Error('unexpected');
    });

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: 'llama3.2',
            selfHosted: true,
            endpoint: 'http://localhost:11434',
            alwaysActive: true,
          },
        ],
        stt: [{ provider: 'groq' }],
      },
    });

    const result = await client.warmup();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('ok');
    // Should have tried /health first, then /v1/models
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('warms GPU endpoint from profile.gpuEndpoint', async () => {
    const { registry } = makeRegistry();

    fetchSpy.mockResolvedValue({ ok: true });

    const client = new AIClient({
      registry,
      defaultProfile: {
        gpuEndpoint: 'http://runpod-gpu:8000',
        llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
        stt: [{ provider: 'groq' }],
      },
    });

    const result = await client.warmup();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].stage).toBe('gpu');
    expect(fetchSpy).toHaveBeenCalledWith('http://runpod-gpu:8000/health', expect.any(Object));
  });
});

// ── Replica chain expansion tests ──────────────────────────────────────────

describe('buildChain — replica expansion for self-hosted', () => {
  it('expands replicas for self-hosted alwaysActive providers', async () => {
    const { registry, llm } = makeRegistry();

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [
          {
            provider: 'ollama',
            model: 'llama3.2',
            selfHosted: true,
            alwaysActive: true,
            replicas: 2,
          },
          { provider: 'groq', model: 'llama-3.3-70b-versatile' },
        ],
        stt: [{ provider: 'groq' }],
      },
    });

    // Chat should work — the chain has 3 entries (2x ollama + 1x groq)
    const result = await client.chat([{ role: 'user', content: 'test' }]);
    expect(result.content).toBeTruthy();
  });

  it('does NOT expand replicas for cloud providers', async () => {
    const { registry } = makeRegistry();

    const groqLlm = registry.getProvider('groq')?.llm as MockLLMProvider;

    const client = new AIClient({
      registry,
      defaultProfile: {
        llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile', replicas: 3 }],
        stt: [{ provider: 'groq' }],
      },
    });

    // Chat succeeds on first try — chain has only 1 entry (replicas ignored)
    const result = await client.chat([{ role: 'user', content: 'test' }]);
    expect(result.content).toBeTruthy();
    expect(result.fallbackUsed).toBe(false);
  });
});

// ── Watchdog alwaysActive tests ────────────────────────────────────────────

describe('watchdog — respects alwaysActive on GpuTierConfig', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeReadyState(idx: number, lastHealthyMs: number): ReadyTierState {
    return {
      state: 'ready',
      tierIndex: idx,
      endpoint: `http://gpu${idx}:8000`,
      lastHealthyAt: Date.now() - lastHealthyMs,
      bootedAt: Date.now() - 60_000,
      trigger: 'sessions',
    };
  }

  function makeDeps(stateMap: Map<string, GpuTierState[]>, config: AutoScalerConfig): WatchdogDeps {
    const mockClient = {
      providerId: 'runpod',
      bootTimeSecs: 120,
      discoverInstance: vi.fn(),
      createInstance: vi.fn(),
      startInstance: vi.fn(),
      stopInstance: vi.fn().mockResolvedValue(undefined),
      deleteInstance: vi.fn(),
      getInstanceStatus: vi.fn(),
      listInstances: vi.fn(),
      resolveInstanceEndpoint: vi.fn(),
    };

    return {
      engine: {
        getStateMap: () => stateMap,
        getPoolStatus: (userId: string) => stateMap.get(userId) ?? [],
        setTierState: vi.fn(),
        cancelBootPoller: vi.fn(),
        initTierStatesFromDb: vi.fn(),
        evictIdleUsers: vi.fn(),
        isDecisionInFlight: vi.fn().mockReturnValue(false),
        waitForDecision: vi.fn().mockResolvedValue(undefined),
      } as any,
      sessionTracker: { countActiveSessions: vi.fn().mockResolvedValue(0) } as any,
      persistence: {
        persistTierStates: vi.fn().mockResolvedValue(undefined),
        findUsersWithActiveGpus: vi.fn().mockResolvedValue([]),
      } as any,
      registry: { get: vi.fn().mockReturnValue(mockClient) } as any,
      loadConfig: vi.fn().mockResolvedValue(config),
      hooks: {},
      lifecycleLogger: { log: vi.fn() },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
  }

  it('does NOT stop idle tier when alwaysActive is true', async () => {
    const idleMs = 30 * 60_000; // 30 min — well past grace period
    const stateMap = new Map([['user-1', [makeReadyState(0, idleMs)]]]);

    const config: AutoScalerConfig = {
      enabled: true,
      threshold: 1,
      windowMinutes: 30,
      maxLatencyMs: 1500,
      idleGraceMinutes: 15,
      tiers: [{ provider: 'runpod', instanceId: 'pod-1', apiKey: 'key-1', alwaysActive: true }],
    };

    const deps = makeDeps(stateMap, config);
    await runWatchdogCycle(deps);

    const client = deps.registry.get('runpod')!;
    expect(client.stopInstance).not.toHaveBeenCalled();
    expect(stateMap.get('user-1')![0].state).toBe('ready');
  });

  it('DOES stop idle tier when alwaysActive is false/undefined', async () => {
    const idleMs = 30 * 60_000;
    const stateMap = new Map([['user-1', [makeReadyState(0, idleMs)]]]);

    const config: AutoScalerConfig = {
      enabled: true,
      threshold: 1,
      windowMinutes: 30,
      maxLatencyMs: 1500,
      idleGraceMinutes: 15,
      tiers: [
        { provider: 'runpod', instanceId: 'pod-1', apiKey: 'key-1' }, // no alwaysActive
      ],
    };

    const deps = makeDeps(stateMap, config);
    await runWatchdogCycle(deps);

    const client = deps.registry.get('runpod')!;
    expect(client.stopInstance).toHaveBeenCalledWith(
      'pod-1',
      expect.objectContaining({ apiKey: 'key-1' }),
    );
  });

  it('mixed tiers: stops non-alwaysActive, keeps alwaysActive', async () => {
    const idleMs = 30 * 60_000;
    const stateMap = new Map([['user-1', [makeReadyState(0, idleMs), makeReadyState(1, idleMs)]]]);

    const config: AutoScalerConfig = {
      enabled: true,
      threshold: 1,
      windowMinutes: 30,
      maxLatencyMs: 1500,
      idleGraceMinutes: 15,
      tiers: [
        { provider: 'runpod', instanceId: 'pod-1', apiKey: 'key-1', alwaysActive: true },
        { provider: 'runpod', instanceId: 'pod-2', apiKey: 'key-2' }, // not alwaysActive
      ],
    };

    const deps = makeDeps(stateMap, config);
    await runWatchdogCycle(deps);

    const client = deps.registry.get('runpod')!;
    // Should stop pod-2 but NOT pod-1
    expect(client.stopInstance).toHaveBeenCalledTimes(1);
    expect(client.stopInstance).toHaveBeenCalledWith(
      'pod-2',
      expect.objectContaining({ apiKey: 'key-2' }),
    );
    expect(stateMap.get('user-1')![0].state).toBe('ready'); // pod-1 stays ready
    expect(stateMap.get('user-1')![1].state).toBe('idle'); // pod-2 stopped
  });
});
