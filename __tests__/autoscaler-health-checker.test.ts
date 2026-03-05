/**
 * Tests for autoscaler/health-checker.ts
 * - probeAllTiers()
 * - processHealthResults()
 */

import { describe, it, expect } from 'vitest';
import { probeAllTiers, processHealthResults, type HealthCheckResult, type ProcessHealthOpts } from '../src/autoscaler/health-checker';
import { GpuProviderRegistry } from '../src/gpu-providers/registry';
import type { GpuTierState, GpuTierConfig, IdleTierState, BootingTierState, ReadyTierState } from '../src/types';
import type { GpuLifecycleLogger } from '../src/autoscaler/lifecycle-logger';
import type { Logger } from '../src/deps';

const silentLogger: Logger = { log: () => {}, warn: () => {}, error: () => {} };
const noopLogger: GpuLifecycleLogger = { log: () => {} };

function makeBooting(tierIndex: number, extra: Partial<BootingTierState> = {}): BootingTierState {
  return {
    state: 'booting',
    tierIndex,
    endpoint: `http://endpoint-${tierIndex}:8000`,
    bootTriggeredAt: Date.now() - 10_000,
    trigger: 'sessions',
    prevBootFailCount: 0,
    ...extra,
  };
}

function makeReady(tierIndex: number, extra: Partial<ReadyTierState> = {}): ReadyTierState {
  return {
    state: 'ready',
    tierIndex,
    endpoint: `http://endpoint-${tierIndex}:8000`,
    lastHealthyAt: Date.now() - 5000,
    ...extra,
  };
}

function makeIdle(tierIndex: number, extra: Partial<IdleTierState> = {}): IdleTierState {
  return { state: 'idle', tierIndex, ...extra };
}

function makeTierConfig(tierIndex: number, provider = 'runpod'): GpuTierConfig {
  return {
    provider: provider as GpuTierConfig['provider'],
    instanceId: `inst-${tierIndex}`,
    endpoint: `http://endpoint-${tierIndex}:8000`,
    apiKey: 'test-key',
  };
}

function makeRegistry(): GpuProviderRegistry {
  const registry = new GpuProviderRegistry();
  registry.register({
    providerId: 'runpod',
    bootTimeSecs: 120,
    async discoverInstance() { return null; },
    async createInstance() { return { instanceId: 'new', endpoint: '', status: 'running' }; },
    async startInstance() {},
    async stopInstance() {},
    async deleteInstance() {},
    async getInstanceStatus() { return null; },
    async listInstances() { return []; },
    async resolveInstanceEndpoint() { return null; },
  });
  return registry;
}

describe('probeAllTiers', () => {
  it('returns empty array for no non-idle states', async () => {
    const tierStates: GpuTierState[] = [makeIdle(0), makeIdle(1)];
    const results = await probeAllTiers(tierStates, async () => true);
    expect(results).toHaveLength(0);
  });

  it('probes booting tiers', async () => {
    const tierStates: GpuTierState[] = [makeBooting(0), makeBooting(1)];
    // endpoint-0:8000 contains '0', endpoint-1:8000 also contains '0' and '1'
    // Use explicit endpoint matching
    const probeHealth = async (endpoint: string) => endpoint === 'http://endpoint-0:8000';
    const results = await probeAllTiers(tierStates, probeHealth);
    expect(results).toHaveLength(2);
    const r0 = results.find(r => r.tierIndex === 0)!;
    const r1 = results.find(r => r.tierIndex === 1)!;
    expect(r0.healthy).toBe(true);
    expect(r1.healthy).toBe(false);
  });

  it('probes ready tiers', async () => {
    const tierStates: GpuTierState[] = [makeReady(0), makeReady(1)];
    const results = await probeAllTiers(tierStates, async () => true);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.healthy)).toBe(true);
  });

  it('skips idle tiers', async () => {
    const tierStates: GpuTierState[] = [makeIdle(0), makeBooting(1), makeIdle(2)];
    const results = await probeAllTiers(tierStates, async () => true);
    expect(results).toHaveLength(1);
    expect(results[0].tierIndex).toBe(1);
  });

  it('runs probes in parallel', async () => {
    const callOrder: number[] = [];
    const tierStates: GpuTierState[] = [makeBooting(0), makeBooting(1), makeBooting(2)];
    const probeHealth = async (_endpoint: string) => {
      await new Promise(r => setTimeout(r, 10));
      return true;
    };

    const start = Date.now();
    const results = await probeAllTiers(tierStates, probeHealth);
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(3);
    // Parallel: should be < 3 * 10ms = 30ms (with some margin)
    expect(elapsed).toBeLessThan(60);
  });
});

describe('processHealthResults', () => {
  function makeOpts(cleanupFn?: () => Promise<void>): ProcessHealthOpts {
    return {
      cleanupInstance: cleanupFn ?? (async () => {}),
      lifecycleLogger: noopLogger,
      logger: silentLogger,
    };
  }

  it('transitions booting→ready on healthy', () => {
    const tierStates: GpuTierState[] = [makeBooting(0)];
    const tiers = [makeTierConfig(0)];
    const registry = makeRegistry();
    const results: HealthCheckResult[] = [{ tierIndex: 0, healthy: true }];

    processHealthResults('user-1', tierStates, tiers, results, registry, makeOpts());

    expect(tierStates[0].state).toBe('ready');
    const ready = tierStates[0] as ReadyTierState;
    expect(ready.endpoint).toBe('http://endpoint-0:8000');
  });

  it('does not change booting state when not yet timed out', () => {
    const booting = makeBooting(0, { bootTriggeredAt: Date.now() - 10_000 }); // 10s, timeout=240s
    const tierStates: GpuTierState[] = [booting];
    const tiers = [makeTierConfig(0)];
    const registry = makeRegistry();
    const results: HealthCheckResult[] = [{ tierIndex: 0, healthy: false }];

    processHealthResults('user-1', tierStates, tiers, results, registry, makeOpts());

    expect(tierStates[0].state).toBe('booting'); // No change yet
  });

  it('transitions booting→idle on timeout', () => {
    // bootTimeSecs=120, timeout=240s. Set bootTriggeredAt to 241s ago
    const booting = makeBooting(0, {
      bootTriggeredAt: Date.now() - 241_000,
      prevBootFailCount: 0,
    });
    const tierStates: GpuTierState[] = [booting];
    const tiers = [makeTierConfig(0)];
    const registry = makeRegistry();
    const results: HealthCheckResult[] = [{ tierIndex: 0, healthy: false }];

    processHealthResults('user-1', tierStates, tiers, results, registry, makeOpts());

    expect(tierStates[0].state).toBe('idle');
  });

  it('transitions ready→idle on unhealthy', () => {
    const tierStates: GpuTierState[] = [makeReady(0)];
    const tiers = [makeTierConfig(0)];
    const registry = makeRegistry();
    const results: HealthCheckResult[] = [{ tierIndex: 0, healthy: false }];

    processHealthResults('user-1', tierStates, tiers, results, registry, makeOpts());

    expect(tierStates[0].state).toBe('idle');
    expect((tierStates[0] as IdleTierState).unhealthy).toBe(true);
  });

  it('refreshes lastHealthyAt on ready+healthy', () => {
    const ready = makeReady(0, { lastHealthyAt: Date.now() - 5000 });
    const tierStates: GpuTierState[] = [ready];
    const tiers = [makeTierConfig(0)];
    const registry = makeRegistry();
    const results: HealthCheckResult[] = [{ tierIndex: 0, healthy: true }];

    const before = Date.now();
    processHealthResults('user-1', tierStates, tiers, results, registry, makeOpts());

    const newReady = tierStates[0] as ReadyTierState;
    expect(newReady.state).toBe('ready');
    expect(newReady.lastHealthyAt).toBeGreaterThanOrEqual(before);
  });

  it('calls cleanupInstance on ready→idle transition', async () => {
    const tierStates: GpuTierState[] = [makeReady(0)];
    const tiers = [makeTierConfig(0)];
    const registry = makeRegistry();
    const results: HealthCheckResult[] = [{ tierIndex: 0, healthy: false }];

    let cleanupCalled = false;
    const opts = makeOpts(async () => { cleanupCalled = true; });

    processHealthResults('user-1', tierStates, tiers, results, registry, opts);
    await new Promise(r => setTimeout(r, 20));

    expect(cleanupCalled).toBe(true);
  });

  it('ignores results for unknown tier indices', () => {
    const tierStates: GpuTierState[] = [makeBooting(0)];
    const tiers = [makeTierConfig(0)];
    const registry = makeRegistry();
    const results: HealthCheckResult[] = [{ tierIndex: 99, healthy: true }]; // out of bounds

    expect(() => {
      processHealthResults('user-1', tierStates, tiers, results, registry, makeOpts());
    }).not.toThrow();
    expect(tierStates[0].state).toBe('booting'); // unchanged
  });

  it('handles empty results', () => {
    const tierStates: GpuTierState[] = [makeBooting(0), makeReady(1)];
    const tiers = [makeTierConfig(0), makeTierConfig(1)];
    const registry = makeRegistry();

    expect(() => {
      processHealthResults('user-1', tierStates, tiers, [], registry, makeOpts());
    }).not.toThrow();
  });

  it('marks tier unhealthy after MAX_BOOT_FAILURES', () => {
    const booting = makeBooting(0, {
      bootTriggeredAt: Date.now() - 241_000,
      prevBootFailCount: 2, // 3rd failure = MAX_BOOT_FAILURES
    });
    const tierStates: GpuTierState[] = [booting];
    const tiers = [makeTierConfig(0)];
    const registry = makeRegistry();
    const results: HealthCheckResult[] = [{ tierIndex: 0, healthy: false }];

    processHealthResults('user-1', tierStates, tiers, results, registry, makeOpts());

    const idle = tierStates[0] as IdleTierState;
    expect(idle.state).toBe('idle');
    expect(idle.unhealthy).toBe(true);
  });
});
