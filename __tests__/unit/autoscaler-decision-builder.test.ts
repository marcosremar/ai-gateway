import { describe, it, expect, vi } from 'vitest';
import { buildDecision, hashUserId } from '@ai-gateway/autoscaler/decision-builder';
import { GpuProviderRegistry } from '@ai-gateway/gpu-providers/registry';
import type { GpuTierConfig, ReadyTierState, BootingTierState, IdleTierState, AutoScalerConfig } from '@ai-gateway';

function makeRegistry(bootTimeSecs = 120): GpuProviderRegistry {
  const registry = new GpuProviderRegistry();
  registry.register({
    providerId: 'runpod',
    bootTimeSecs,
    discoverInstance: vi.fn(),
    createInstance: vi.fn(),
    startInstance: vi.fn(),
    stopInstance: vi.fn(),
    deleteInstance: vi.fn(),
    getInstanceStatus: vi.fn(),
    listInstances: vi.fn(),
    resolveInstanceEndpoint: vi.fn(),
  });
  return registry;
}

const config: AutoScalerConfig = {
  enabled: true,
  threshold: 1,
  windowMinutes: 30,
  maxLatencyMs: 1500,
  tiers: [
    { provider: 'runpod', instanceId: 'pod-1', endpoint: 'http://gpu1:8000' },
    { provider: 'runpod', instanceId: 'pod-2', endpoint: 'http://gpu2:8000' },
  ],
};

const readyState = (idx: number, endpoint: string): ReadyTierState => ({
  state: 'ready',
  tierIndex: idx,
  endpoint,
  lastHealthyAt: Date.now(),
  bootedAt: Date.now() - 60_000,
  trigger: 'sessions',
});

const bootingState = (idx: number): BootingTierState => ({
  state: 'booting',
  tierIndex: idx,
  endpoint: 'http://gpu1:8000',
  bootTriggeredAt: Date.now() - 30_000,
  trigger: 'sessions',
  prevBootFailCount: 0,
});

const idleState = (idx: number): IdleTierState => ({
  state: 'idle',
  tierIndex: idx,
});

describe('hashUserId', () => {
  it('returns consistent results for same input', () => {
    expect(hashUserId('user-abc', 5)).toBe(hashUserId('user-abc', 5));
  });

  it('returns values within [0, max)', () => {
    for (const userId of ['a', 'bb', 'test-user-123', 'x'.repeat(100)]) {
      const result = hashUserId(userId, 10);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(10);
    }
  });

  it('distributes better than simple charCode sum', () => {
    // Generate 100 similar user IDs and check distribution across 3 buckets
    const buckets = [0, 0, 0];
    for (let i = 0; i < 300; i++) {
      const idx = hashUserId(`user-${i}`, 3);
      buckets[idx]++;
    }
    // Each bucket should have at least 50 (vs 100 expected) — charCode sum often clusters
    for (const count of buckets) {
      expect(count).toBeGreaterThan(50);
    }
  });
});

describe('buildDecision', () => {
  it('returns s2s route with ready tiers', () => {
    const states = [readyState(0, 'http://gpu1:8000')];
    const decision = buildDecision(states, config.tiers, 2, config, 500, false, makeRegistry(), 'user-1');
    expect(decision.route).toBe('s2s');
    expect(decision.gpuState).toBe('ready');
    expect(decision.endpoint).toBe('http://gpu1:8000');
    expect(decision.allEndpoints).toEqual(['http://gpu1:8000']);
    expect(decision.activeTiers).toBe(1);
  });

  it('returns llm route when booting', () => {
    const states = [bootingState(0)];
    const decision = buildDecision(states, config.tiers, 1, config, null, false, makeRegistry(), 'user-1');
    expect(decision.route).toBe('llm');
    expect(decision.gpuState).toBe('booting');
    expect(decision.bootingTiers).toBe(1);
    expect(decision.estimatedReadySecs).toBeDefined();
  });

  it('returns llm route when idle', () => {
    const states = [idleState(0)];
    const decision = buildDecision(states, config.tiers, 0, config, null, false, makeRegistry(), 'user-1');
    expect(decision.route).toBe('llm');
    expect(decision.gpuState).toBe('idle');
    expect(decision.activeTiers).toBe(0);
    expect(decision.bootingTiers).toBe(0);
  });

  it('affinity is consistent for same userId', () => {
    const states = [readyState(0, 'http://gpu1:8000'), readyState(1, 'http://gpu2:8000')];
    const d1 = buildDecision(states, config.tiers, 1, config, null, false, makeRegistry(), 'user-xyz');
    const d2 = buildDecision(states, config.tiers, 1, config, null, false, makeRegistry(), 'user-xyz');
    expect(d1.endpoint).toBe(d2.endpoint);
  });

  it('provides allEndpoints for multiple ready tiers', () => {
    const states = [readyState(0, 'http://gpu1:8000'), readyState(1, 'http://gpu2:8000')];
    const decision = buildDecision(states, config.tiers, 2, config, null, false, makeRegistry(), 'user-1');
    expect(decision.allEndpoints).toHaveLength(2);
    expect(decision.allEndpoints).toContain('http://gpu1:8000');
    expect(decision.allEndpoints).toContain('http://gpu2:8000');
  });

  it('handles empty tier states', () => {
    const decision = buildDecision([], config.tiers, 0, config, null, false, makeRegistry(), 'user-1');
    expect(decision.route).toBe('llm');
    expect(decision.gpuState).toBe('idle');
  });

  it('includes estimatedReadySecs for booting tiers', () => {
    const states = [bootingState(0)];
    const decision = buildDecision(states, config.tiers, 1, config, null, true, makeRegistry(60), 'user-1');
    expect(decision.estimatedReadySecs).toBeGreaterThanOrEqual(0);
  });

  it('reports totalTiers from config', () => {
    const states = [idleState(0)];
    const decision = buildDecision(states, config.tiers, 0, config, null, false, makeRegistry(), 'user-1');
    expect(decision.totalTiers).toBe(config.tiers.length);
  });
});
