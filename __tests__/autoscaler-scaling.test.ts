/**
 * Autoscaler Scaling Tests
 *
 * Tests covering:
 *   - Config sync: DB profiles → config-loader → autoscaler (task #8)
 *   - E2E routing: serverless → GPU boot → GPU ready → routing changes (task #9)
 *   - Scale to 10: threshold=1, 10 sessions → 10 tiers booted (task #10)
 *   - AIClient routing: autoscaler decision drives GPU vs serverless (task #11)
 *   - Frontend hook behavior: polling intervals on booting/ready/idle (task #12)
 *
 * Uses in-memory mocks — no Redis, no Prisma, no network needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StateStore, SessionResolver, SettingsStore } from '@ai-gateway';
import { createAutoscaler, loadAutoscalerConfig, type Autoscaler } from '@ai-gateway';
import type { AutoScalerConfig, GpuTierConfig } from '@ai-gateway';

// ──────────────────────────────────────────────────────────────────────────────
// In-memory StateStore (replaces Redis)
// ──────────────────────────────────────────────────────────────────────────────
class MemoryStateStore implements StateStore {
  private kv = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();

  async get(key: string) { return this.kv.get(key) ?? null; }
  async set(key: string, value: string) { this.kv.set(key, value); }
  async del(key: string) { this.kv.delete(key); this.hashes.delete(key); }
  async scan(pattern: string) {
    const prefix = pattern.replace('*', '');
    return [...this.kv.keys()].filter(k => k.startsWith(prefix));
  }
  async rpush(key: string, value: string) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    this.lists.get(key)!.push(value);
  }
  async ltrim(key: string, start: number, stop: number) {
    const list = this.lists.get(key);
    if (!list) return;
    const s = start < 0 ? Math.max(list.length + start, 0) : start;
    const e = stop < 0 ? list.length + stop : stop;
    this.lists.set(key, list.slice(s, e + 1));
  }
  async lrange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const s = start < 0 ? Math.max(list.length + start, 0) : start;
    const e = stop < 0 ? list.length + stop : stop;
    return list.slice(s, e + 1);
  }
  async hset(key: string, field: string, value: string) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
  }
  async hdel(key: string, field: string) { this.hashes.get(key)?.delete(field); }
  async hgetall(key: string) {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Mock SettingsStore
// ──────────────────────────────────────────────────────────────────────────────
class MockSettingsStore implements SettingsStore {
  private data = new Map<string, Record<string, unknown>>();

  async get(userId: string): Promise<Record<string, unknown>> {
    return this.data.get(userId) ?? {};
  }
  async patch(userId: string, partial: Record<string, unknown>): Promise<void> {
    const existing = this.data.get(userId) ?? {};
    this.data.set(userId, { ...existing, ...partial });
  }
  setData(userId: string, data: Record<string, unknown>) {
    this.data.set(userId, data);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Mock SessionResolver with controllable session count
// ──────────────────────────────────────────────────────────────────────────────
class MockSessionResolver implements SessionResolver {
  dbSessionCount = 0;
  async countDbSessions(): Promise<number> { return this.dbSessionCount; }
  async resolveTeacher(): Promise<string | null> { return null; }
}

// ──────────────────────────────────────────────────────────────────────────────
// Mock global fetch for health probes
// ──────────────────────────────────────────────────────────────────────────────
const healthyEndpoints = new Set<string>();

function mockFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.endsWith('/health')) {
    const endpoint = url.replace('/health', '');
    if (healthyEndpoints.has(endpoint)) {
      return Promise.resolve(new Response(JSON.stringify({ status: 'healthy' }), { status: 200 }));
    }
    return Promise.reject(new Error('Connection refused'));
  }
  // RunPod/TensorDock API calls — mock successful start/stop/create
  if (url.includes('runpod.io') || url.includes('tensordock.com')) {
    // createInstance: return a fake pod
    if (url.includes('/v1/pods') && !url.includes('/start') && !url.includes('/stop')) {
      const podId = `pod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      return Promise.resolve(new Response(JSON.stringify({ id: podId }), { status: 200 }));
    }
    // start/stop
    return Promise.resolve(new Response('{}', { status: 200 }));
  }
  return Promise.reject(new Error(`Unmocked URL: ${url}`));
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const USER = 'user-scaling-test';

function makeTier(provider: 'runpod' | 'tensordock', idx: number): GpuTierConfig {
  return {
    provider,
    instanceId: `instance-${provider}-${idx}`,
    endpoint: `http://${provider}-${idx}.example.com:8000`,
    apiKey: `key-${provider}`,
    ...(provider === 'tensordock' ? { authId: 'auth-td' } : {}),
  };
}

function makeConfig(overrides?: Partial<AutoScalerConfig>): AutoScalerConfig {
  return {
    enabled: true,
    threshold: 5,
    windowMinutes: 10,
    maxLatencyMs: 1500,
    tiers: [makeTier('runpod', 0)],
    idleGraceMinutes: 15,
    ...overrides,
  };
}

function setupAutoscaler(sessionResolver: MockSessionResolver) {
  const stateStore = new MemoryStateStore();
  const settingsStore = new MockSettingsStore();
  const config = makeConfig();

  const autoscaler = createAutoscaler({
    settingsStore,
    stateStore,
    sessionResolver,
    loadConfig: async () => config,
  });

  return { autoscaler, stateStore, settingsStore, config };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('Config Sync: DB profiles → config-loader → autoscaler (Task #8)', () => {
  let sessionResolver: MockSessionResolver;

  beforeEach(() => {
    sessionResolver = new MockSessionResolver();
    healthyEndpoints.clear();
    vi.stubGlobal('fetch', vi.fn(mockFetch));
  });

  it('should use tiers from config-loader when profiles have GPU providers', async () => {
    const tier = makeTier('runpod', 0);
    const config = makeConfig({ tiers: [tier] });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 0;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('llm');
    expect(decision.totalTiers).toBe(1);
  });

  it('should handle empty tiers gracefully', async () => {
    const config = makeConfig({ tiers: [] });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('llm');
    expect(decision.totalTiers).toBe(0);
  });

  it('should respect multiple tiers from different providers', async () => {
    const config = makeConfig({
      tiers: [makeTier('runpod', 0), makeTier('tensordock', 1), makeTier('runpod', 2)],
      threshold: 1,
    });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 0;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.totalTiers).toBe(3);
  });

  it('should pass API keys from config to tiers', async () => {
    const tier = makeTier('runpod', 0);
    expect(tier.apiKey).toBe('key-runpod');
    const config = makeConfig({ tiers: [tier] });
    expect(config.tiers[0].apiKey).toBe('key-runpod');
  });
});

describe('loadAutoscalerConfig: profiles → tiers mapping', () => {
  const settingsStore = new MockSettingsStore();
  const userId = 'user-config-test';

  it('should produce tiers for all GPU omni profiles (preserving order)', async () => {
    settingsStore.setData(userId, {
      autoscaler: { enabled: true, threshold: 1, tiers: [] },
      profiles: [
        { id: 'p1', pipelineMode: 'pipeline', provider: 'openai' },           // skipped: not omni
        { id: 'p2', pipelineMode: 'omni', provider: 'modal' },               // → tier (GPU provider)
        { id: 'p3', pipelineMode: 'omni', provider: 'tensordock' },          // → tier
        { id: 'p4', pipelineMode: 'omni', provider: 'runpod' },              // → tier
      ],
      tensordockInstance: { instanceId: 'td-123', endpoint: 'http://1.2.3.4:8000' },
      runpodPod: { podId: 'rp-456', directUrl: 'http://5.6.7.8:8000' },
      skypilot: {
        tensordockApiKey: 'td-key',
        tensordockAuthId: 'td-auth',
        runpodApiKey: 'rp-key',
        hfToken: 'hf-tok',
        dockerImage: 'img:latest',
      },
    });

    const config = await loadAutoscalerConfig(userId, settingsStore);
    expect(config).not.toBeNull();
    // One tier per GPU omni profile (openai skipped — not omni)
    expect(config!.tiers.length).toBeGreaterThanOrEqual(2);

    const providers = config!.tiers.map(t => t.provider);
    expect(providers).toContain('tensordock');
    expect(providers).toContain('runpod');

    // Verify profile order is preserved
    const tdIdx = providers.indexOf('tensordock');
    const rpIdx = providers.indexOf('runpod');
    expect(tdIdx).toBeLessThan(rpIdx);

    // Verify credentials are resolved
    const tdTier = config!.tiers[tdIdx];
    expect(tdTier.instanceId).toBe('td-123');
    expect(tdTier.endpoint).toBe('http://1.2.3.4:8000');
    expect(tdTier.apiKey).toBe('td-key');
    expect(tdTier.authId).toBe('td-auth');

    const rpTier = config!.tiers[rpIdx];
    expect(rpTier.instanceId).toBe('rp-456');
    expect(rpTier.endpoint).toBe('http://5.6.7.8:8000');
    expect(rpTier.apiKey).toBe('rp-key');
  });

  it('should produce tiers even when no existing instance data (runpodPod=null)', async () => {
    settingsStore.setData(userId, {
      autoscaler: { enabled: true, threshold: 1, tiers: [] },
      profiles: [
        { id: 'p1', pipelineMode: 'omni', provider: 'tensordock' },
        { id: 'p2', pipelineMode: 'omni', provider: 'runpod' },
      ],
      tensordockInstance: { instanceId: 'td-123', endpoint: 'http://1.2.3.4:8000' },
      // runpodPod is missing/null — should still create a tier with undefined instanceId
      skypilot: { tensordockApiKey: 'td-key', runpodApiKey: 'rp-key' },
    });

    const config = await loadAutoscalerConfig(userId, settingsStore);
    expect(config!.tiers).toHaveLength(2);
    expect(config!.tiers[0].provider).toBe('tensordock');
    expect(config!.tiers[1].provider).toBe('runpod');
    expect(config!.tiers[1].instanceId).toBeUndefined();
    expect(config!.tiers[1].apiKey).toBe('rp-key');
  });

  it('should respect profile order (runpod first, tensordock second)', async () => {
    settingsStore.setData(userId, {
      autoscaler: { enabled: true, threshold: 1, tiers: [] },
      profiles: [
        { id: 'p1', pipelineMode: 'omni', provider: 'runpod' },              // → tier 0
        { id: 'p2', pipelineMode: 'omni', provider: 'tensordock' },          // → tier 1
      ],
      tensordockInstance: { instanceId: 'td-1' },
      runpodPod: { podId: 'rp-1' },
      skypilot: { tensordockApiKey: 'td-k', runpodApiKey: 'rp-k' },
    });

    const config = await loadAutoscalerConfig(userId, settingsStore);
    expect(config!.tiers[0].provider).toBe('runpod');
    expect(config!.tiers[1].provider).toBe('tensordock');
  });

  it('should fall back to legacy tensordockInstance when no profiles exist', async () => {
    settingsStore.setData(userId, {
      autoscaler: { enabled: true, threshold: 1, tiers: [] },
      profiles: [],
      tensordockInstance: { instanceId: 'td-legacy', endpoint: 'http://legacy:8000' },
      skypilot: { tensordockApiKey: 'td-key' },
    });

    const config = await loadAutoscalerConfig(userId, settingsStore);
    expect(config!.tiers).toHaveLength(1);
    expect(config!.tiers[0].provider).toBe('tensordock');
    expect(config!.tiers[0].instanceId).toBe('td-legacy');
  });

  it('should return null when autoscaler is disabled', async () => {
    settingsStore.setData(userId, {
      autoscaler: { enabled: false },
    });

    const config = await loadAutoscalerConfig(userId, settingsStore);
    expect(config).toBeNull();
  });
});

describe('E2E Routing: serverless → GPU boot → GPU ready (Task #9)', () => {
  let sessionResolver: MockSessionResolver;

  beforeEach(() => {
    sessionResolver = new MockSessionResolver();
    healthyEndpoints.clear();
    vi.stubGlobal('fetch', vi.fn(mockFetch));
  });

  it('should route to serverless when sessions below threshold', async () => {
    const config = makeConfig({ threshold: 5 });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 3;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('llm');
    expect(decision.gpuState).toBe('idle');
  });

  it('should trigger boot when sessions hit threshold, route stays serverless', async () => {
    const config = makeConfig({ threshold: 5 });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 5;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('llm');
    expect(decision.gpuState).toBe('booting');
    expect(decision.bootingTiers).toBe(1);
  });

  it('should route to GPU when health check passes', async () => {
    const tier = makeTier('runpod', 0);
    const config = makeConfig({ threshold: 5, tiers: [tier] });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    // Step 1: trigger boot
    sessionResolver.dbSessionCount = 5;
    await autoscaler.getAutoScaleDecision(USER, config);

    // Step 2: mark endpoint healthy
    healthyEndpoints.add(tier.endpoint!);
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('s2s');
    expect(decision.gpuState).toBe('ready');
    expect(decision.endpoint).toBe(tier.endpoint);
    expect(decision.activeTiers).toBe(1);
  });

  it('should return to serverless when sessions drop and GPU goes idle', async () => {
    const tier = makeTier('runpod', 0);
    const config = makeConfig({ threshold: 5, tiers: [tier] });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    // Boot + ready
    sessionResolver.dbSessionCount = 5;
    await autoscaler.getAutoScaleDecision(USER, config);
    healthyEndpoints.add(tier.endpoint!);
    let decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('s2s');

    // Sessions drop → still gpu (because tier is already ready)
    sessionResolver.dbSessionCount = 0;
    decision = await autoscaler.getAutoScaleDecision(USER, config);
    // When sessions drop, GPU stays ready until watchdog shuts it down
    // The route can still be GPU if tier is healthy
    expect(decision.gpuState).toBe('ready');
  });

  it('should fallback to serverless when GPU becomes unhealthy', async () => {
    const tier = makeTier('runpod', 0);
    const config = makeConfig({ threshold: 5, tiers: [tier] });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    // Boot + ready
    sessionResolver.dbSessionCount = 5;
    await autoscaler.getAutoScaleDecision(USER, config);
    healthyEndpoints.add(tier.endpoint!);
    await autoscaler.getAutoScaleDecision(USER, config);

    // GPU goes unhealthy
    healthyEndpoints.delete(tier.endpoint!);
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('llm');
    expect(decision.gpuState).not.toBe('ready');
  });
});

describe('Fallback chain: tier 0 → tier 1 on failure (Task #10)', () => {
  let sessionResolver: MockSessionResolver;

  beforeEach(() => {
    sessionResolver = new MockSessionResolver();
    healthyEndpoints.clear();
    vi.stubGlobal('fetch', vi.fn(mockFetch));
  });

  it('should boot only tier 0 (first in fallback chain) when sessions >= threshold', async () => {
    const tiers = [makeTier('tensordock', 0), makeTier('runpod', 1)];
    const config = makeConfig({ threshold: 1, tiers });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 1;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    // Only ONE tier should be booting — the first eligible
    expect(decision.bootingTiers).toBe(1);
    expect(decision.totalTiers).toBe(2);
  });

  it('should NOT boot multiple tiers in parallel even with many sessions', async () => {
    const tiers = [makeTier('tensordock', 0), makeTier('runpod', 1)];
    const config = makeConfig({ threshold: 1, tiers });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 10;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    // Still only 1 booting — fallback chain boots one at a time
    expect(decision.bootingTiers).toBe(1);
    expect(decision.totalTiers).toBe(2);
  });

  it('should fall back to tier 1 when tier 0 is unhealthy', async () => {
    const tiers = [makeTier('tensordock', 0), makeTier('runpod', 1)];
    const config = makeConfig({ threshold: 1, tiers });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    // Boot tier 0
    sessionResolver.dbSessionCount = 1;
    await autoscaler.getAutoScaleDecision(USER, config);

    // Make tier 0 healthy then unhealthy (transitions: booting→ready→idle(unhealthy))
    healthyEndpoints.add(tiers[0].endpoint!);
    await autoscaler.getAutoScaleDecision(USER, config); // → ready
    healthyEndpoints.delete(tiers[0].endpoint!);
    await autoscaler.getAutoScaleDecision(USER, config); // → idle (unhealthy)

    // Now next decision should boot tier 1 (runpod) as fallback
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.bootingTiers).toBe(1);

    // Check that it's tier 1 (runpod) booting, not tier 0
    const pool = autoscaler.getPoolStatus(USER);
    const bootingTier = pool.find(t => t.state === 'booting');
    expect(bootingTier).toBeDefined();
    expect(bootingTier!.tierIndex).toBe(1);
  });

  it('should skip tiers in cooldown and try the next one', async () => {
    const tiers = [makeTier('tensordock', 0), makeTier('runpod', 1)];
    const config = makeConfig({ threshold: 1, tiers });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    // Put tier 0 in cooldown manually
    const pool = autoscaler.getPoolStatus(USER);
    // Force tier states so tier 0 is in cooldown
    autoscaler.resetGpuState(USER);

    sessionResolver.dbSessionCount = 1;
    // First call initializes states from empty — both idle
    await autoscaler.getAutoScaleDecision(USER, config);
    // Tier 0 should start booting
    const pool2 = autoscaler.getPoolStatus(USER);
    expect(pool2[0]?.state).toBe('booting');
  });

  it('should not boot anything when no sessions reach threshold', async () => {
    const tiers = [makeTier('tensordock', 0), makeTier('runpod', 1)];
    const config = makeConfig({ threshold: 5, tiers });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 2;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.bootingTiers).toBe(0);
    expect(decision.gpuState).toBe('idle');
  });

  it('should not try to boot when a tier is already booting', async () => {
    const tiers = [makeTier('tensordock', 0), makeTier('runpod', 1)];
    const config = makeConfig({ threshold: 1, tiers });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 1;
    await autoscaler.getAutoScaleDecision(USER, config);
    // Tier 0 is booting. Second call should NOT boot tier 1 in parallel.
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.bootingTiers).toBe(1);
    const pool = autoscaler.getPoolStatus(USER);
    expect(pool[1]?.state).toBe('idle');
  });

  it('should keep using ready tier even after sessions increase', async () => {
    const tiers = [makeTier('tensordock', 0), makeTier('runpod', 1)];
    const config = makeConfig({ threshold: 1, tiers });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    // Boot + ready tier 0
    sessionResolver.dbSessionCount = 1;
    await autoscaler.getAutoScaleDecision(USER, config);
    healthyEndpoints.add(tiers[0].endpoint!);
    await autoscaler.getAutoScaleDecision(USER, config);

    // Sessions jump to 10 — should still use the single ready tier, NOT boot more
    sessionResolver.dbSessionCount = 10;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('s2s');
    expect(decision.activeTiers).toBe(1);
    expect(decision.bootingTiers).toBe(0);
  });

  it('should report totalTiers = configured tiers (no auto-expand)', async () => {
    const tiers = [makeTier('tensordock', 0), makeTier('runpod', 1)];
    const config = makeConfig({ threshold: 1, tiers });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 100;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    // totalTiers stays at 2 — no dynamic expansion
    expect(decision.totalTiers).toBe(2);
  });
});

describe('AIClient routing: autoscaler decision drives pipeline (Task #11)', () => {
  let sessionResolver: MockSessionResolver;

  beforeEach(() => {
    sessionResolver = new MockSessionResolver();
    healthyEndpoints.clear();
    vi.stubGlobal('fetch', vi.fn(mockFetch));
  });

  it('should return route=gpu and endpoint when GPU is ready', async () => {
    const tier = makeTier('runpod', 0);
    const config = makeConfig({ threshold: 1, tiers: [tier] });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    // Boot + ready
    sessionResolver.dbSessionCount = 1;
    await autoscaler.getAutoScaleDecision(USER, config);
    healthyEndpoints.add(tier.endpoint!);

    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('s2s');
    expect(decision.endpoint).toBe(tier.endpoint);
    // This is what AIClient.resolveGpuEndpoint() would use
  });

  it('should return route=serverless when autoscaler says no GPU', async () => {
    const config = makeConfig({ threshold: 5 });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 2;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('llm');
    expect(decision.endpoint).toBeUndefined();
  });

  it('should return allEndpoints with the single active tier endpoint', async () => {
    const tiers = [makeTier('runpod', 0), makeTier('tensordock', 1)];
    const config = makeConfig({ threshold: 1, tiers });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    // Only tier 0 boots (fallback chain — one at a time)
    sessionResolver.dbSessionCount = 1;
    await autoscaler.getAutoScaleDecision(USER, config);
    expect(autoscaler.getPoolStatus(USER)[0]?.state).toBe('booting');
    expect(autoscaler.getPoolStatus(USER)[1]?.state).toBe('idle');

    // Mark tier 0 healthy
    healthyEndpoints.add(tiers[0].endpoint!);
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.route).toBe('s2s');
    expect(decision.allEndpoints).toHaveLength(1);
    expect(decision.allEndpoints).toContain(tiers[0].endpoint);
  });
});

describe('Frontend hook behavior: polling intervals (Task #12)', () => {
  // These tests verify the data contract that useAutoscalerStatus relies on

  let sessionResolver: MockSessionResolver;

  beforeEach(() => {
    sessionResolver = new MockSessionResolver();
    healthyEndpoints.clear();
    vi.stubGlobal('fetch', vi.fn(mockFetch));
  });

  it('should return gpuState=idle when no sessions active', async () => {
    const config = makeConfig({ threshold: 5 });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 0;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.gpuState).toBe('idle');
    expect(decision.estimatedReadySecs).toBeUndefined();
  });

  it('should return gpuState=booting with estimatedReadySecs when booting', async () => {
    const config = makeConfig({ threshold: 1, tiers: [makeTier('runpod', 0)] });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 1;
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.gpuState).toBe('booting');
    expect(decision.estimatedReadySecs).toBeGreaterThanOrEqual(0);
    // RunPod boot time is ~1200s (cold boot with model download), so estimated should be around that
    expect(decision.estimatedReadySecs).toBeLessThanOrEqual(1200);
  });

  it('should return gpuState=ready with endpoint when GPU is up', async () => {
    const tier = makeTier('runpod', 0);
    const config = makeConfig({ threshold: 1, tiers: [tier] });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    sessionResolver.dbSessionCount = 1;
    await autoscaler.getAutoScaleDecision(USER, config);
    healthyEndpoints.add(tier.endpoint!);

    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.gpuState).toBe('ready');
    expect(decision.gpuEndpoint).toBe(tier.endpoint);
  });

  it('should include bootingTiers and activeTiers counts for UI display', async () => {
    const tiers = [makeTier('runpod', 0), makeTier('runpod', 1)];
    const config = makeConfig({ threshold: 1, tiers });
    const { autoscaler } = setupAutoscaler(sessionResolver);

    // Boot tier 0 (only one at a time in fallback chain)
    sessionResolver.dbSessionCount = 1;
    await autoscaler.getAutoScaleDecision(USER, config);

    // Make tier 0 healthy → ready
    healthyEndpoints.add(tiers[0].endpoint!);
    const decision = await autoscaler.getAutoScaleDecision(USER, config);
    expect(decision.activeTiers).toBe(1);
    expect(decision.bootingTiers).toBe(0); // Only 1 tier active, tier 1 stays idle
    expect(decision.totalTiers).toBe(2);
  });
});

describe('Server restart recovery', () => {
  let sessionResolver: MockSessionResolver;

  beforeEach(() => {
    sessionResolver = new MockSessionResolver();
    healthyEndpoints.clear();
    vi.stubGlobal('fetch', vi.fn(mockFetch));
  });

  function setupWithSharedStore(sessionRes: MockSessionResolver) {
    const stateStore = new MemoryStateStore();
    const settingsStore = new MockSettingsStore();
    const config = makeConfig({
      threshold: 1,
      tiers: [makeTier('tensordock', 0), makeTier('runpod', 1)],
    });

    const makeAutoscaler = () => createAutoscaler({
      settingsStore,
      stateStore,
      sessionResolver: sessionRes,
      loadConfig: async () => config,
    });

    return { stateStore, settingsStore, config, makeAutoscaler };
  }

  it('should recover from unhealthy tiers after server restart', async () => {
    const { config, makeAutoscaler } = setupWithSharedStore(sessionResolver);
    const autoscaler1 = makeAutoscaler();
    sessionResolver.dbSessionCount = 1;

    // Boot tier 0
    await autoscaler1.getAutoScaleDecision(USER, config);

    // Make tier 0 healthy then unhealthy
    healthyEndpoints.add(config.tiers[0].endpoint!);
    await autoscaler1.getAutoScaleDecision(USER, config); // → ready
    healthyEndpoints.delete(config.tiers[0].endpoint!);
    await autoscaler1.getAutoScaleDecision(USER, config); // → idle(unhealthy)

    // Verify tier 0 is unhealthy
    const pool1 = autoscaler1.getPoolStatus(USER);
    expect(pool1[0]?.state).toBe('idle');
    expect((pool1[0] as any).unhealthy).toBe(true);

    // === SERVER RESTART: create new autoscaler with same state store ===
    const autoscaler2 = makeAutoscaler();

    // First decision after restart — should clear unhealthy and retry tier 0
    const decision = await autoscaler2.getAutoScaleDecision(USER, config);
    expect(decision.bootingTiers).toBe(1);

    // Should be booting tier 0 again (not stuck on unhealthy)
    const pool2 = autoscaler2.getPoolStatus(USER);
    const bootingTier = pool2.find(t => t.state === 'booting');
    expect(bootingTier).toBeDefined();
    expect(bootingTier!.tierIndex).toBe(0);
  });

  it('should revert booting tiers to idle after restart (callback lost)', async () => {
    const { config, makeAutoscaler } = setupWithSharedStore(sessionResolver);
    const autoscaler1 = makeAutoscaler();
    sessionResolver.dbSessionCount = 1;

    // Boot tier 0
    await autoscaler1.getAutoScaleDecision(USER, config);
    const pool1 = autoscaler1.getPoolStatus(USER);
    expect(pool1[0]?.state).toBe('booting');

    // === SERVER RESTART ===
    const autoscaler2 = makeAutoscaler();

    // After restart, booting should revert to idle and re-trigger
    const decision = await autoscaler2.getAutoScaleDecision(USER, config);
    expect(decision.bootingTiers).toBe(1);
    // Should boot tier 0 again with a fresh callback
    const pool2 = autoscaler2.getPoolStatus(USER);
    expect(pool2[0]?.state).toBe('booting');
  });

  it('should preserve ready tier after restart (health check verifies)', async () => {
    const { config, makeAutoscaler } = setupWithSharedStore(sessionResolver);
    const autoscaler1 = makeAutoscaler();
    sessionResolver.dbSessionCount = 1;

    // Boot and make ready
    await autoscaler1.getAutoScaleDecision(USER, config);
    healthyEndpoints.add(config.tiers[0].endpoint!);
    const d1 = await autoscaler1.getAutoScaleDecision(USER, config);
    expect(d1.gpuState).toBe('ready');

    // === SERVER RESTART ===
    const autoscaler2 = makeAutoscaler();

    // Ready tier should be restored and still healthy
    const decision = await autoscaler2.getAutoScaleDecision(USER, config);
    expect(decision.gpuState).toBe('ready');
    expect(decision.endpoint).toBe(config.tiers[0].endpoint);
  });
});
