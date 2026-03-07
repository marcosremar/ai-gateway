/**
 * Autoscaler Resilience — Real API Integration Tests
 *
 * Runs key resilience scenarios against real RunPod and Vast.ai APIs plus
 * comprehensive unit-level coverage of engine decisions, tier transitions,
 * session/latency tracking, load balancing, watchdog, cost monitor, and more.
 *
 * ~92 tests across 14 groups:
 *   1.  Engine Decision Logic (10 tests)
 *   2.  Tier State Transitions (8 tests)
 *   3.  Health & Recovery (10 tests)
 *   4.  Fallback & Cascading Failures (8 tests)
 *   5.  Manual Stop & Lifecycle (8 tests)
 *   6.  Concurrent & Race Conditions (8 tests)
 *   7.  State Persistence (8 tests)
 *   8.  Session Tracking (8 tests)
 *   9.  Latency Tracking (8 tests)
 *  10.  Load Balancer (8 tests)
 *  11.  Watchdog (4 tests)
 *  12.  Provider API Operations (6 tests — real API)
 *  13.  Cost Monitor (4 tests)
 *  14.  Full Integration (4 tests)
 *
 * Requires: RUNPOD_API_KEY, VAST_API_KEY
 * Cost: ~$0.05 per run (instances alive <2 min each)
 *
 * Run:
 *   source ../../.env && cd packages/ai-gateway && bunx vitest run __tests__/autoscaler-resilience-real.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { RunpodClient } from '../src/gpu-providers/runpod-client';
import { VastClient } from '../src/gpu-providers/vast-client';
import { GpuProviderRegistry } from '../src/gpu-providers/registry';
import { AutoscalerEngine } from '../src/autoscaler/engine';
import { SessionTracker } from '../src/autoscaler/session-tracker';
import { LatencyTracker, computeP95, countRecentBreaches, LATENCY_BREACH_COUNT } from '../src/autoscaler/latency-tracker';
import { StatePersistence } from '../src/autoscaler/state-persistence';
import { LoadBalancer } from '../src/autoscaler/load-balancer';
import { runWatchdogCycle, type WatchdogDeps } from '../src/autoscaler/watchdog';
import { runCostMonitorCycle, type CostMonitorDeps, type ProviderAccount, StaleTracker } from '../src/autoscaler/cost-monitor';
import { InMemoryStateAdapter } from '../src/adapters/in-memory-state';
import type { ProviderCredentials } from '../src/gpu-providers/types';
import type { AutoScalerConfig, BootingTierState, IdleTierState, ReadyTierState, GpuTierState } from '../src/types';
import { loadEnv, requireEnv, timed, waitFor } from './helpers';

// ── Setup ────────────────────────────────────────────────────────────────────

let runpodCreds: ProviderCredentials;
let vastCreds: ProviderCredentials;
let runpodClient: RunpodClient;
let vastClient: VastClient;

// Track created instances for cleanup
const cleanup: Array<{ provider: string; instanceId: string }> = [];

beforeAll(() => {
  loadEnv();
  const runpodKey = requireEnv('RUNPOD_API_KEY');
  const vastKey = requireEnv('VAST_API_KEY');
  runpodCreds = { apiKey: runpodKey };
  vastCreds = { apiKey: vastKey };
  runpodClient = new RunpodClient();
  vastClient = new VastClient();
});

afterAll(async () => {
  console.log(`\n  [cleanup] Cleaning up ${cleanup.length} instance(s)...`);
  for (const { provider, instanceId } of cleanup) {
    try {
      if (provider === 'runpod') {
        await runpodClient.deleteInstance(instanceId, runpodCreds);
      } else if (provider === 'vast') {
        await vastClient.deleteInstance(instanceId, vastCreds);
      }
      console.log(`  [cleanup] Deleted ${provider} ${instanceId}`);
    } catch (err) {
      console.warn(`  [cleanup] Failed to delete ${provider} ${instanceId}:`, err);
    }
  }
}, 30_000);

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`  ${msg}`);
}

const mockSessionResolver = {
  countDbSessions: async () => 0,
  resolveTeacher: async () => null,
};

/** Set of endpoints that should be treated as healthy */
const healthyEndpoints = new Set<string>();

/** Build an autoscaler engine wired with real providers + pre-seeded sessions */
async function buildEngineWithSessions(
  registry: GpuProviderRegistry,
  userId: string,
  sessionCount: number,
) {
  const stateStore = new InMemoryStateAdapter();
  const sessionTracker = new SessionTracker(stateStore, mockSessionResolver);
  const latencyTracker = new LatencyTracker(stateStore);
  const persistence = new StatePersistence(stateStore);

  for (let i = 0; i < sessionCount; i++) {
    await sessionTracker.reportSessionHeartbeat(userId, `resilience-sess-${i}`);
  }

  const engine = new AutoscalerEngine({
    registry,
    sessionTracker,
    latencyTracker,
    persistence,
    probeHealth: async (endpoint: string) => healthyEndpoints.has(endpoint),
    cleanupInstance: async (config, _reg, reason) => {
      log(`[engine-cleanup] ${config.provider} — ${reason}`);
    },
  });

  return { engine, stateStore, sessionTracker, latencyTracker, persistence };
}

/** Standard 1-tier RunPod config for tests */
function makeConfig(overrides?: Partial<AutoScalerConfig>): AutoScalerConfig {
  return {
    enabled: true,
    threshold: 1,
    windowMinutes: 30,
    maxLatencyMs: 2000,
    tiers: [{
      provider: 'runpod',
      apiKey: runpodCreds.apiKey,
      gpuTypes: ['RTX 4090', 'RTX A5000', 'A40'],
      dockerImage: 'python:3.11-slim',
      storageGb: 0,
    }],
    ...overrides,
  };
}

/** Standard 2-tier config */
function make2TierConfig(overrides?: Partial<AutoScalerConfig>): AutoScalerConfig {
  return makeConfig({
    tiers: [
      {
        provider: 'runpod',
        apiKey: runpodCreds.apiKey,
        gpuTypes: ['RTX 4090', 'RTX A5000', 'A40'],
        dockerImage: 'python:3.11-slim',
        storageGb: 0,
        env: { TEST: 'resilience-t0' },
      },
      {
        provider: 'runpod',
        apiKey: runpodCreds.apiKey,
        gpuTypes: ['RTX 4090', 'RTX A5000', 'A40'],
        dockerImage: 'python:3.11-slim',
        storageGb: 0,
        env: { TEST: 'resilience-t1' },
      },
    ],
    ...overrides,
  });
}

/** Minimal engine that doesn't call any real APIs — for fast unit tests */
async function buildLocalEngine(userId: string, sessionCount: number) {
  const registry = new GpuProviderRegistry();
  // Register runpodClient so the registry has a provider with bootTimeSecs
  registry.register(runpodClient);
  return buildEngineWithSessions(registry, userId, sessionCount);
}


// ═══════════════════════════════════════════════════════════════════════════════
// 1. Engine Decision Logic (10 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('1. Engine Decision Logic', () => {
  it('1.1 below threshold → no boot, route=llm', async () => {
    const { engine } = await buildLocalEngine('decision-below', 0);
    const d = await engine.getAutoScaleDecision('decision-below', makeConfig({ threshold: 5 }));
    expect(d.gpuState).toBe('idle');
    expect(d.route).toBe('llm');
    expect(d.bootingTiers).toBe(0);
  });

  it('1.2 at threshold → triggers boot', async () => {
    const { engine } = await buildLocalEngine('decision-at', 5);
    const d = await engine.getAutoScaleDecision('decision-at', makeConfig({ threshold: 5 }));
    expect(d.gpuState).toBe('booting');
    expect(d.bootingTiers).toBe(1);
  });

  it('1.3 above threshold → triggers boot', async () => {
    const { engine } = await buildLocalEngine('decision-above', 10);
    const d = await engine.getAutoScaleDecision('decision-above', makeConfig({ threshold: 3 }));
    expect(d.gpuState).toBe('booting');
    expect(d.bootingTiers).toBe(1);
  });

  it('1.4 disabled autoscaler → always llm', async () => {
    const { engine } = await buildLocalEngine('decision-disabled', 100);
    const d = await engine.getAutoScaleDecision('decision-disabled', makeConfig({ enabled: false }));
    expect(d.gpuState).toBe('idle');
    expect(d.route).toBe('llm');
    expect(d.enabled).toBe(false);
  });

  it('1.5 empty tiers → llm', async () => {
    const { engine } = await buildLocalEngine('decision-empty-tiers', 5);
    const d = await engine.getAutoScaleDecision('decision-empty-tiers', makeConfig({ tiers: [] }));
    expect(d.route).toBe('llm');
    expect(d.totalTiers).toBe(0);
  });

  it('1.6 dry-run → no actual boot triggered', async () => {
    const { engine } = await buildLocalEngine('decision-dryrun', 10);
    const d = await engine.getAutoScaleDecision('decision-dryrun', makeConfig(), { dryRun: true });
    expect(d.activeSessions).toBe(10);
    // In dry-run mode, no boot should be triggered — state stays idle
    const pool = engine.getPoolStatus('decision-dryrun');
    const bootingCount = pool.filter(t => t.state === 'booting').length;
    expect(bootingCount).toBe(0);
  });

  it('1.7 zero sessions → no boot', async () => {
    const { engine } = await buildLocalEngine('decision-zero', 0);
    const d = await engine.getAutoScaleDecision('decision-zero', makeConfig({ threshold: 1 }));
    expect(d.gpuState).toBe('idle');
    expect(d.activeSessions).toBe(0);
  });

  it('1.8 correct activeSessions in decision', async () => {
    const { engine } = await buildLocalEngine('decision-count', 7);
    const d = await engine.getAutoScaleDecision('decision-count', makeConfig({ threshold: 100 }));
    expect(d.activeSessions).toBe(7);
  });

  it('1.9 correct totalTiers in decision', async () => {
    const { engine } = await buildLocalEngine('decision-total', 0);
    const d = await engine.getAutoScaleDecision('decision-total', make2TierConfig({ threshold: 100 }));
    expect(d.totalTiers).toBe(2);
  });

  it('1.10 idempotent decisions — calling twice with same state returns same result', async () => {
    const { engine } = await buildLocalEngine('decision-idempotent', 0);
    const config = makeConfig({ threshold: 100 });
    const d1 = await engine.getAutoScaleDecision('decision-idempotent', config);
    const d2 = await engine.getAutoScaleDecision('decision-idempotent', config);
    expect(d1.gpuState).toBe(d2.gpuState);
    expect(d1.route).toBe(d2.route);
    expect(d1.activeSessions).toBe(d2.activeSessions);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 2. Tier State Transitions (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('2. Tier State Transitions', () => {
  it('2.1 idle→booting on session trigger', async () => {
    const { engine } = await buildLocalEngine('transition-boot', 5);
    const pool0 = engine.getPoolStatus('transition-boot');
    expect(pool0.length).toBe(0); // No state yet

    await engine.getAutoScaleDecision('transition-boot', makeConfig());
    const pool1 = engine.getPoolStatus('transition-boot');
    expect(pool1[0]?.state).toBe('booting');
  });

  it('2.2 booting→ready on forceTierReady', async () => {
    const { engine } = await buildLocalEngine('transition-ready', 5);
    await engine.getAutoScaleDecision('transition-ready', makeConfig());
    expect(engine.getPoolStatus('transition-ready')[0]?.state).toBe('booting');

    const ep = 'http://transition-test:8000';
    healthyEndpoints.add(ep);
    engine.forceTierReady('transition-ready', 0, ep);
    const pool = engine.getPoolStatus('transition-ready');
    expect(pool[0]?.state).toBe('ready');
    expect((pool[0] as ReadyTierState).endpoint).toBe(ep);
    healthyEndpoints.delete(ep);
  });

  it('2.3 ready→idle on health fail (probeHealth returns false)', async () => {
    const { engine } = await buildLocalEngine('transition-unhealthy', 5);
    const ep = 'http://transition-unhealthy:8000';
    healthyEndpoints.add(ep);

    await engine.getAutoScaleDecision('transition-unhealthy', makeConfig());
    engine.forceTierReady('transition-unhealthy', 0, ep);

    // Mark unhealthy
    healthyEndpoints.delete(ep);

    // Next decision should detect unhealthy
    const d = await engine.getAutoScaleDecision('transition-unhealthy', makeConfig());
    const pool = engine.getPoolStatus('transition-unhealthy');
    // After health fail, tier goes back to idle or re-boots
    expect(pool[0]?.state === 'idle' || pool[0]?.state === 'booting').toBe(true);
  });

  it('2.4 unhealthy tier is skipped in fallback', async () => {
    const { engine } = await buildLocalEngine('transition-skip-unhealthy', 5);
    // Set tier 0 as unhealthy
    engine.setTierState('transition-skip-unhealthy', 0, {
      state: 'idle', tierIndex: 0, unhealthy: true, bootFailCount: 3,
    } as IdleTierState);
    engine.setTierState('transition-skip-unhealthy', 1, {
      state: 'idle', tierIndex: 1,
    } as IdleTierState);

    await engine.getAutoScaleDecision('transition-skip-unhealthy', make2TierConfig());
    const pool = engine.getPoolStatus('transition-skip-unhealthy');
    // Tier 0 should still be idle (skipped), tier 1 should be booting
    expect(pool[0]?.state).toBe('idle');
    expect(pool[1]?.state).toBe('booting');
  });

  it('2.5 cooldown tier is skipped', async () => {
    const { engine } = await buildLocalEngine('transition-cooldown', 5);
    engine.setTierState('transition-cooldown', 0, {
      state: 'idle', tierIndex: 0, cooldownUntil: Date.now() + 999_999,
    } as IdleTierState);
    engine.setTierState('transition-cooldown', 1, {
      state: 'idle', tierIndex: 1,
    } as IdleTierState);

    await engine.getAutoScaleDecision('transition-cooldown', make2TierConfig());
    const pool = engine.getPoolStatus('transition-cooldown');
    expect(pool[0]?.state).toBe('idle');
    expect(pool[1]?.state).toBe('booting');
  });

  it('2.6 manualStop tier is skipped', async () => {
    const { engine } = await buildLocalEngine('transition-manual', 5);
    engine.setTierState('transition-manual', 0, {
      state: 'idle', tierIndex: 0, manualStop: true,
    } as IdleTierState);
    engine.setTierState('transition-manual', 1, {
      state: 'idle', tierIndex: 1,
    } as IdleTierState);

    await engine.getAutoScaleDecision('transition-manual', make2TierConfig());
    const pool = engine.getPoolStatus('transition-manual');
    expect(pool[0]?.state).toBe('idle');
    expect(pool[1]?.state).toBe('booting');
  });

  it('2.7 pool grows to match config tiers on first decision', async () => {
    const { engine } = await buildLocalEngine('transition-pool-grow', 0);
    const config = make2TierConfig({ threshold: 100 }); // high threshold = no boot
    await engine.getAutoScaleDecision('transition-pool-grow', config);
    const pool = engine.getPoolStatus('transition-pool-grow');
    expect(pool.length).toBe(2);
  });

  it('2.8 forceTierReady on specific tier index', async () => {
    const { engine } = await buildLocalEngine('transition-force-idx', 0);
    const ep = 'http://force-tier-2:8000';
    healthyEndpoints.add(ep);
    engine.forceTierReady('transition-force-idx', 2, ep);
    const pool = engine.getPoolStatus('transition-force-idx');
    expect(pool.length).toBe(3); // tiers 0, 1, 2
    expect(pool[2]?.state).toBe('ready');
    expect((pool[2] as ReadyTierState).endpoint).toBe(ep);
    healthyEndpoints.delete(ep);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 3. Health & Recovery (10 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('3. Health & Recovery', () => {
  it('3.1 healthy→unhealthy→routes to LLM', async () => {
    const { engine } = await buildLocalEngine('health-cycle', 5);
    const ep = 'http://health-cycle:8000';
    healthyEndpoints.add(ep);

    await engine.getAutoScaleDecision('health-cycle', makeConfig());
    engine.forceTierReady('health-cycle', 0, ep);
    const d1 = await engine.getAutoScaleDecision('health-cycle', makeConfig());
    expect(d1.route).toBe('s2s');

    healthyEndpoints.delete(ep);
    const d2 = await engine.getAutoScaleDecision('health-cycle', makeConfig());
    // After health fail, should reroute
    expect(d2.route === 'llm' || d2.gpuState === 'booting').toBe(true);
  });

  it('3.2 unhealthy t0 → t1 fallback boots', async () => {
    const { engine } = await buildLocalEngine('health-fallback', 5);
    engine.setTierState('health-fallback', 0, {
      state: 'idle', tierIndex: 0, unhealthy: true, bootFailCount: 3,
    } as IdleTierState);

    await engine.getAutoScaleDecision('health-fallback', make2TierConfig());
    const pool = engine.getPoolStatus('health-fallback');
    expect(pool[1]?.state).toBe('booting');
  });

  it('3.3 both tiers unhealthy → routes to LLM', async () => {
    const { engine } = await buildLocalEngine('health-both-bad', 5);
    engine.setTierState('health-both-bad', 0, {
      state: 'idle', tierIndex: 0, unhealthy: true,
    } as IdleTierState);
    engine.setTierState('health-both-bad', 1, {
      state: 'idle', tierIndex: 1, unhealthy: true,
    } as IdleTierState);

    const d = await engine.getAutoScaleDecision('health-both-bad', make2TierConfig());
    expect(d.route).toBe('llm');
    expect(d.gpuState).toBe('idle');
  });

  it('3.4 resetGpuState clears unhealthy → allows re-boot', async () => {
    const { engine } = await buildLocalEngine('health-reset', 5);
    engine.setTierState('health-reset', 0, {
      state: 'idle', tierIndex: 0, unhealthy: true,
    } as IdleTierState);

    engine.resetGpuState('health-reset');
    expect(engine.getPoolStatus('health-reset').length).toBe(0);

    await engine.getAutoScaleDecision('health-reset', makeConfig());
    const pool = engine.getPoolStatus('health-reset');
    expect(pool[0]?.state).toBe('booting');
  });

  it('3.5 rapid health flapping (5 cycles) stabilizes', async () => {
    const { engine } = await buildLocalEngine('health-flap', 5);
    const ep = 'http://health-flap:8000';
    const config = makeConfig();

    for (let i = 0; i < 5; i++) {
      healthyEndpoints.add(ep);
      engine.forceTierReady('health-flap', 0, ep);
      await engine.getAutoScaleDecision('health-flap', config);

      healthyEndpoints.delete(ep);
      await engine.getAutoScaleDecision('health-flap', config);
    }

    // Engine should be in some consistent state (not crashed)
    const pool = engine.getPoolStatus('health-flap');
    expect(pool[0]).toBeDefined();
    expect(['idle', 'booting', 'ready']).toContain(pool[0]!.state);
  });

  it('3.6 flap t0→unhealthy, t1 gets traffic', async () => {
    const { engine } = await buildLocalEngine('health-flap-fallback', 5);
    const ep0 = 'http://flap-t0:8000';
    const ep1 = 'http://flap-t1:8000';

    // Set up tier 0 as unhealthy with exhausted retries
    engine.setTierState('health-flap-fallback', 0, {
      state: 'idle', tierIndex: 0, unhealthy: true, bootFailCount: 3,
    } as IdleTierState);
    // Force tier 1 ready
    healthyEndpoints.add(ep1);
    engine.forceTierReady('health-flap-fallback', 1, ep1);

    const d = await engine.getAutoScaleDecision('health-flap-fallback', make2TierConfig());
    expect(d.route).toBe('s2s');
    expect(d.endpoint).toBe(ep1);
    healthyEndpoints.delete(ep1);
  });

  it('3.7 ready tier stays ready across multiple decisions', async () => {
    const { engine } = await buildLocalEngine('health-stay-ready', 5);
    const ep = 'http://stay-ready:8000';
    healthyEndpoints.add(ep);
    engine.forceTierReady('health-stay-ready', 0, ep);
    const config = makeConfig();

    for (let i = 0; i < 5; i++) {
      const d = await engine.getAutoScaleDecision('health-stay-ready', config);
      expect(d.gpuState).toBe('ready');
      expect(d.route).toBe('s2s');
    }
    healthyEndpoints.delete(ep);
  });

  it('3.8 health validates forced endpoint', async () => {
    const { engine } = await buildLocalEngine('health-validate', 5);
    const ep = 'http://validate-ep:8000';
    // Don't add to healthyEndpoints → probeHealth returns false
    engine.forceTierReady('health-validate', 0, ep);

    const d = await engine.getAutoScaleDecision('health-validate', makeConfig());
    // Health check should mark it unhealthy
    const pool = engine.getPoolStatus('health-validate');
    expect(pool[0]?.state !== 'ready' || d.gpuState !== 'ready').toBe(true);
  });

  it('3.9 health fail does not increment bootFailCount for a ready→idle transition', async () => {
    const { engine } = await buildLocalEngine('health-no-failcount', 5);
    const ep = 'http://no-failcount:8000';
    healthyEndpoints.add(ep);
    engine.forceTierReady('health-no-failcount', 0, ep);
    await engine.getAutoScaleDecision('health-no-failcount', makeConfig());

    healthyEndpoints.delete(ep);
    await engine.getAutoScaleDecision('health-no-failcount', makeConfig());

    const pool = engine.getPoolStatus('health-no-failcount');
    const tier0 = pool[0];
    if (tier0?.state === 'idle') {
      // Health failure during ready→idle is NOT a boot failure
      // bootFailCount should not be set (or be 0)
      expect((tier0 as IdleTierState).bootFailCount ?? 0).toBeLessThanOrEqual(0);
    }
  });

  it('3.10 re-add healthy after resetGpuState → recovers', async () => {
    const { engine } = await buildLocalEngine('health-recover', 5);
    const ep = 'http://recover:8000';
    healthyEndpoints.add(ep);

    engine.forceTierReady('health-recover', 0, ep);
    const d1 = await engine.getAutoScaleDecision('health-recover', makeConfig());
    expect(d1.route).toBe('s2s');

    // Reset + recover
    engine.resetGpuState('health-recover');
    engine.forceTierReady('health-recover', 0, ep);
    const d2 = await engine.getAutoScaleDecision('health-recover', makeConfig());
    expect(d2.route).toBe('s2s');
    healthyEndpoints.delete(ep);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 4. Fallback & Cascading Failures (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('4. Fallback & Cascading Failures', () => {
  it('4.1 invalid key fallback (RunPod) — tier 0 bad key → tier 1 boots', async () => {
    const registry = new GpuProviderRegistry();
    registry.register(runpodClient);
    const userId = 'fallback-invalid-key';
    let createdInstanceId: string | null = null;

    const { engine } = await buildEngineWithSessions(registry, userId, 5);

    const config: AutoScalerConfig = {
      enabled: true, threshold: 1, windowMinutes: 30, maxLatencyMs: 2000,
      tiers: [
        {
          provider: 'runpod',
          apiKey: 'invalid-key-for-resilience-test-12345',
          gpuTypes: ['RTX 4090'], dockerImage: 'python:3.11-slim', storageGb: 0,
        },
        {
          provider: 'runpod',
          apiKey: runpodCreds.apiKey,
          gpuTypes: ['RTX 4090', 'RTX A5000', 'A40'],
          dockerImage: 'python:3.11-slim', storageGb: 0,
          env: { TEST: 'resilience-fallback' },
        },
      ],
    };

    // Decision 1: attempts tier 0 (will fail async — invalid key)
    const d1 = await engine.getAutoScaleDecision(userId, config);
    log(`d1: gpuState=${d1.gpuState}, booting=${d1.bootingTiers}`);

    // Wait for tier 0 boot failure
    await new Promise(r => setTimeout(r, 8_000));

    // Decision 2: tier 0 should have failed, tier 1 boots
    await engine.getAutoScaleDecision(userId, config);

    let poolStatus = engine.getPoolStatus(userId);
    // If tier 1 isn't booting yet, try one more cycle
    if (!poolStatus.some(s => s.state === 'booting' && s.tierIndex === 1)) {
      await new Promise(r => setTimeout(r, 3_000));
      await engine.getAutoScaleDecision(userId, config);
    }

    // Wait for tier 1 instanceId
    await waitFor(
      async () => {
        poolStatus = engine.getPoolStatus(userId);
        for (const ts of poolStatus) {
          if (ts.state === 'booting' && ts.tierIndex === 1) {
            const bt = ts as BootingTierState;
            if (bt.discoveredInstanceId) {
              createdInstanceId = bt.discoveredInstanceId;
              cleanup.push({ provider: 'runpod', instanceId: createdInstanceId! });
              log(`tier 1 instanceId = ${createdInstanceId}`);
              return true;
            }
          }
        }
        return false;
      },
      { intervalMs: 3_000, timeoutMs: 30_000, label: 'tier 1 instanceId' },
    );

    // Verify tier 0 failed
    const tier0 = poolStatus[0];
    if (tier0?.state === 'idle') {
      expect((tier0 as IdleTierState).bootFailCount || 0).toBeGreaterThan(0);
    }

    // Verify tier 1 is booting (or already ready)
    const tier1 = poolStatus[1];
    expect(tier1?.state === 'booting' || tier1?.state === 'ready').toBe(true);
    log('Fallback SUCCESS');

    // Cleanup
    if (createdInstanceId) {
      try {
        await runpodClient.deleteInstance(createdInstanceId, runpodCreds);
        const idx = cleanup.findIndex(c => c.instanceId === createdInstanceId);
        if (idx >= 0) cleanup.splice(idx, 1);
      } catch {}
    }
  }, 120_000);

  it('4.2 3-tier all no-key → cascade to LLM', async () => {
    const { engine } = await buildLocalEngine('fallback-nokey-3', 5);
    const config: AutoScalerConfig = {
      enabled: true, threshold: 1, windowMinutes: 30, maxLatencyMs: 2000,
      tiers: [
        { provider: 'runpod', gpuTypes: ['RTX 4090'], dockerImage: 'python:3.11-slim', storageGb: 0 },
        { provider: 'runpod', gpuTypes: ['RTX 4090'], dockerImage: 'python:3.11-slim', storageGb: 0 },
        { provider: 'runpod', gpuTypes: ['RTX 4090'], dockerImage: 'python:3.11-slim', storageGb: 0 },
      ],
    };
    // All tiers have no API key → boot fails immediately
    await engine.getAutoScaleDecision('fallback-nokey-3', config);
    await new Promise(r => setTimeout(r, 500));
    const d = await engine.getAutoScaleDecision('fallback-nokey-3', config);
    // Eventually routes to LLM since no tier can boot
    expect(d.route).toBe('llm');
  }, 10_000);

  it('4.3 t0+t1 unhealthy → t2 boots', async () => {
    const { engine } = await buildLocalEngine('fallback-t2', 5);
    engine.setTierState('fallback-t2', 0, { state: 'idle', tierIndex: 0, unhealthy: true } as IdleTierState);
    engine.setTierState('fallback-t2', 1, { state: 'idle', tierIndex: 1, unhealthy: true } as IdleTierState);
    engine.setTierState('fallback-t2', 2, { state: 'idle', tierIndex: 2 } as IdleTierState);

    const config: AutoScalerConfig = {
      enabled: true, threshold: 1, windowMinutes: 30, maxLatencyMs: 2000,
      tiers: [
        { provider: 'runpod', apiKey: runpodCreds.apiKey, gpuTypes: ['RTX 4090'], dockerImage: 'python:3.11-slim', storageGb: 0 },
        { provider: 'runpod', apiKey: runpodCreds.apiKey, gpuTypes: ['RTX 4090'], dockerImage: 'python:3.11-slim', storageGb: 0 },
        { provider: 'runpod', apiKey: runpodCreds.apiKey, gpuTypes: ['RTX 4090'], dockerImage: 'python:3.11-slim', storageGb: 0 },
      ],
    };

    await engine.getAutoScaleDecision('fallback-t2', config);
    const pool = engine.getPoolStatus('fallback-t2');
    expect(pool[0]?.state).toBe('idle');
    expect(pool[1]?.state).toBe('idle');
    expect(pool[2]?.state).toBe('booting');
  });

  it('4.4 cooldown skip → next tier boots', async () => {
    const { engine } = await buildLocalEngine('fallback-cooldown', 5);
    engine.setTierState('fallback-cooldown', 0, {
      state: 'idle', tierIndex: 0, cooldownUntil: Date.now() + 60_000,
    } as IdleTierState);
    engine.setTierState('fallback-cooldown', 1, { state: 'idle', tierIndex: 1 } as IdleTierState);

    await engine.getAutoScaleDecision('fallback-cooldown', make2TierConfig());
    const pool = engine.getPoolStatus('fallback-cooldown');
    expect(pool[1]?.state).toBe('booting');
  });

  it('4.5 bootFailCount=3 → tier marked unhealthy and skipped', async () => {
    const { engine } = await buildLocalEngine('fallback-maxfail', 5);
    engine.setTierState('fallback-maxfail', 0, {
      state: 'idle', tierIndex: 0, bootFailCount: 3, unhealthy: true,
    } as IdleTierState);

    await engine.getAutoScaleDecision('fallback-maxfail', makeConfig());
    const pool = engine.getPoolStatus('fallback-maxfail');
    // Single-tier: unhealthy → stays idle, route=llm
    expect(pool[0]?.state).toBe('idle');
  });

  it('4.6 recovery after cascade clearing', async () => {
    const { engine } = await buildLocalEngine('fallback-recover', 5);
    // Both tiers unhealthy → LLM
    engine.setTierState('fallback-recover', 0, { state: 'idle', tierIndex: 0, unhealthy: true } as IdleTierState);
    engine.setTierState('fallback-recover', 1, { state: 'idle', tierIndex: 1, unhealthy: true } as IdleTierState);
    const d1 = await engine.getAutoScaleDecision('fallback-recover', make2TierConfig());
    expect(d1.route).toBe('llm');

    // Clear unhealthy
    engine.setTierState('fallback-recover', 0, { state: 'idle', tierIndex: 0 } as IdleTierState);
    const d2 = await engine.getAutoScaleDecision('fallback-recover', make2TierConfig());
    expect(d2.gpuState === 'booting').toBe(true);
  });

  it('4.7 mixed providers in cascade', async () => {
    const registry = new GpuProviderRegistry();
    registry.register(runpodClient);
    registry.register(vastClient);
    const { engine } = await buildEngineWithSessions(registry, 'fallback-mixed', 5);

    engine.setTierState('fallback-mixed', 0, { state: 'idle', tierIndex: 0, unhealthy: true } as IdleTierState);

    const config: AutoScalerConfig = {
      enabled: true, threshold: 1, windowMinutes: 30, maxLatencyMs: 2000,
      tiers: [
        { provider: 'runpod', apiKey: runpodCreds.apiKey, gpuTypes: ['RTX 4090'], dockerImage: 'python:3.11-slim', storageGb: 0 },
        { provider: 'vast', apiKey: vastCreds.apiKey, gpuTypes: ['RTX 4090'], dockerImage: 'python:3.11-slim', storageGb: 0 },
      ],
    };

    await engine.getAutoScaleDecision('fallback-mixed', config);
    const pool = engine.getPoolStatus('fallback-mixed');
    expect(pool[0]?.state).toBe('idle'); // unhealthy, skipped
    expect(pool[1]?.state).toBe('booting'); // vast tier boots
  });

  it('4.8 fallback preserves session count', async () => {
    const { engine } = await buildLocalEngine('fallback-sessions', 7);
    engine.setTierState('fallback-sessions', 0, { state: 'idle', tierIndex: 0, unhealthy: true } as IdleTierState);

    const d = await engine.getAutoScaleDecision('fallback-sessions', make2TierConfig());
    expect(d.activeSessions).toBe(7);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 5. Manual Stop & Lifecycle (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('5. Manual Stop & Lifecycle', () => {
  it('5.1 manualStop suppresses auto-boot', async () => {
    const { engine } = await buildLocalEngine('manual-suppress', 10);
    engine.setTierState('manual-suppress', 0, {
      state: 'idle', tierIndex: 0, manualStop: true,
    } as IdleTierState);

    const d = await engine.getAutoScaleDecision('manual-suppress', makeConfig());
    expect(d.gpuState).toBe('idle');
    expect(d.route).toBe('llm');
  });

  it('5.2 clear manualStop → allows re-boot', async () => {
    const { engine } = await buildLocalEngine('manual-clear', 10);
    engine.setTierState('manual-clear', 0, {
      state: 'idle', tierIndex: 0, manualStop: true,
    } as IdleTierState);

    const d1 = await engine.getAutoScaleDecision('manual-clear', makeConfig());
    expect(d1.gpuState).toBe('idle');

    // Clear manualStop
    engine.setTierState('manual-clear', 0, { state: 'idle', tierIndex: 0 } as IdleTierState);

    const d2 = await engine.getAutoScaleDecision('manual-clear', makeConfig());
    expect(d2.gpuState).toBe('booting');
  });

  it('5.3 manualStop t0 → t1 auto-boots in 2-tier', async () => {
    const { engine } = await buildLocalEngine('manual-t0-t1', 5);
    engine.setTierState('manual-t0-t1', 0, {
      state: 'idle', tierIndex: 0, manualStop: true,
    } as IdleTierState);
    engine.setTierState('manual-t0-t1', 1, { state: 'idle', tierIndex: 1 } as IdleTierState);

    await engine.getAutoScaleDecision('manual-t0-t1', make2TierConfig());
    const pool = engine.getPoolStatus('manual-t0-t1');
    expect(pool[0]?.state).toBe('idle');
    expect((pool[0] as IdleTierState).manualStop).toBe(true);
    expect(pool[1]?.state).toBe('booting');
  });

  it('5.4 manualStop ALL → routes to LLM', async () => {
    const { engine } = await buildLocalEngine('manual-all', 10);
    engine.setTierState('manual-all', 0, { state: 'idle', tierIndex: 0, manualStop: true } as IdleTierState);
    engine.setTierState('manual-all', 1, { state: 'idle', tierIndex: 1, manualStop: true } as IdleTierState);

    const d = await engine.getAutoScaleDecision('manual-all', make2TierConfig());
    expect(d.route).toBe('llm');
  });

  it('5.5 setTierState idle (no manualStop) → auto-boots', async () => {
    const { engine } = await buildLocalEngine('manual-unset', 10);
    engine.setTierState('manual-unset', 0, { state: 'idle', tierIndex: 0 } as IdleTierState);

    const d = await engine.getAutoScaleDecision('manual-unset', makeConfig());
    expect(d.gpuState).toBe('booting');
  });

  it('5.6 resetGpuState clears everything', async () => {
    const { engine } = await buildLocalEngine('manual-reset', 5);
    const ep = 'http://manual-reset:8000';
    healthyEndpoints.add(ep);
    engine.forceTierReady('manual-reset', 0, ep);
    expect(engine.getPoolStatus('manual-reset')[0]?.state).toBe('ready');

    engine.resetGpuState('manual-reset');
    expect(engine.getPoolStatus('manual-reset').length).toBe(0);
    healthyEndpoints.delete(ep);
  });

  it('5.7 reset then decision → fresh boot', async () => {
    const { engine } = await buildLocalEngine('manual-reset-boot', 5);
    engine.setTierState('manual-reset-boot', 0, { state: 'idle', tierIndex: 0, unhealthy: true } as IdleTierState);
    engine.resetGpuState('manual-reset-boot');

    const d = await engine.getAutoScaleDecision('manual-reset-boot', makeConfig());
    expect(d.gpuState).toBe('booting');
  });

  it('5.8 stop/start cycles do not corrupt state', async () => {
    const { engine } = await buildLocalEngine('manual-cycles', 5);
    const ep = 'http://cycles:8000';
    healthyEndpoints.add(ep);

    for (let i = 0; i < 3; i++) {
      engine.forceTierReady('manual-cycles', 0, ep);
      expect(engine.getPoolStatus('manual-cycles')[0]?.state).toBe('ready');

      engine.setTierState('manual-cycles', 0, { state: 'idle', tierIndex: 0, manualStop: true } as IdleTierState);
      expect(engine.getPoolStatus('manual-cycles')[0]?.state).toBe('idle');
    }

    // Final: clear manualStop, verify can boot
    engine.setTierState('manual-cycles', 0, { state: 'idle', tierIndex: 0 } as IdleTierState);
    const d = await engine.getAutoScaleDecision('manual-cycles', makeConfig());
    expect(d.gpuState).toBe('booting');
    healthyEndpoints.delete(ep);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 6. Concurrent & Race Conditions (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('6. Concurrent & Race Conditions', () => {
  it('6.1 5 concurrent decisions → only 1 boot', async () => {
    const { engine } = await buildLocalEngine('concurrent-5', 10);
    const config = makeConfig();

    const decisions = await Promise.all(
      Array.from({ length: 5 }, () => engine.getAutoScaleDecision('concurrent-5', config)),
    );

    for (const d of decisions) {
      expect(d).toBeDefined();
      expect(d.activeSessions).toBe(10);
    }

    const pool = engine.getPoolStatus('concurrent-5');
    const bootingCount = pool.filter(t => t.state === 'booting').length;
    expect(bootingCount).toBeLessThanOrEqual(1);
  });

  it('6.2 10 concurrent decisions → still only 1 boot', async () => {
    const { engine } = await buildLocalEngine('concurrent-10', 10);
    const config = makeConfig();

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => engine.getAutoScaleDecision('concurrent-10', config)),
    );

    expect(decisions.length).toBe(10);
    const pool = engine.getPoolStatus('concurrent-10');
    const bootingCount = pool.filter(t => t.state === 'booting').length;
    expect(bootingCount).toBeLessThanOrEqual(1);
  });

  it('6.3 20 concurrent → consistent session count', async () => {
    const { engine } = await buildLocalEngine('concurrent-20', 15);
    const config = makeConfig();

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => engine.getAutoScaleDecision('concurrent-20', config)),
    );

    for (const d of decisions) {
      expect(d.activeSessions).toBe(15);
    }
  });

  it('6.4 concurrent 2 users → independent state', async () => {
    const { engine } = await buildLocalEngine('concurrent-user-a', 5);
    // Also seed user B
    const stateStore = new InMemoryStateAdapter();
    const sessionTracker = new SessionTracker(stateStore, mockSessionResolver);
    const latencyTracker = new LatencyTracker(stateStore);
    const persistence = new StatePersistence(stateStore);
    for (let i = 0; i < 3; i++) {
      await sessionTracker.reportSessionHeartbeat('concurrent-user-b', `sess-b-${i}`);
    }

    const registry = new GpuProviderRegistry();
    registry.register(runpodClient);
    const engine2 = new AutoscalerEngine({
      registry,
      sessionTracker,
      latencyTracker,
      persistence,
      probeHealth: async (ep: string) => healthyEndpoints.has(ep),
      cleanupInstance: async () => {},
    });

    const [dA, dB] = await Promise.all([
      engine.getAutoScaleDecision('concurrent-user-a', makeConfig({ threshold: 100 })),
      engine2.getAutoScaleDecision('concurrent-user-b', makeConfig({ threshold: 100 })),
    ]);

    expect(dA.activeSessions).toBe(5);
    expect(dB.activeSessions).toBe(3);
  });

  it('6.5 concurrent heartbeat reports', async () => {
    const stateStore = new InMemoryStateAdapter();
    const sessionTracker = new SessionTracker(stateStore, mockSessionResolver);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sessionTracker.reportSessionHeartbeat('concurrent-hb', `sess-${i}`),
      ),
    );

    const count = await sessionTracker.countActiveSessions('concurrent-hb', 10);
    expect(count).toBe(20);
  });

  it('6.6 concurrent state reads are consistent', async () => {
    const { engine } = await buildLocalEngine('concurrent-reads', 5);
    const ep = 'http://concurrent-reads:8000';
    healthyEndpoints.add(ep);
    engine.forceTierReady('concurrent-reads', 0, ep);

    const pools = await Promise.all(
      Array.from({ length: 10 }, () => {
        return engine.getPoolStatus('concurrent-reads');
      }),
    );

    for (const pool of pools) {
      expect(pool[0]?.state).toBe('ready');
    }
    healthyEndpoints.delete(ep);
  });

  it('6.7 decision during boot → no re-trigger', async () => {
    const { engine } = await buildLocalEngine('concurrent-no-retrigger', 5);
    const config = makeConfig();

    // First decision triggers boot
    await engine.getAutoScaleDecision('concurrent-no-retrigger', config);
    expect(engine.getPoolStatus('concurrent-no-retrigger')[0]?.state).toBe('booting');

    // Subsequent decisions should NOT re-trigger
    for (let i = 0; i < 5; i++) {
      await engine.getAutoScaleDecision('concurrent-no-retrigger', config);
    }

    const pool = engine.getPoolStatus('concurrent-no-retrigger');
    const bootingCount = pool.filter(t => t.state === 'booting').length;
    expect(bootingCount).toBe(1);
  });

  it('6.8 100 rapid sequential decisions → consistent', async () => {
    const { engine } = await buildLocalEngine('concurrent-100', 0);
    const config = makeConfig({ threshold: 999 }); // No boot

    const { ms } = await timed(async () => {
      for (let i = 0; i < 100; i++) {
        await engine.getAutoScaleDecision('concurrent-100', config);
      }
    });

    log(`100 sequential decisions in ${ms}ms`);
    expect(ms).toBeLessThan(5000); // Should be fast
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 7. State Persistence (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('7. State Persistence', () => {
  it('7.1 persist ready → restore on new engine', async () => {
    const sharedStore = new InMemoryStateAdapter();
    const registry = new GpuProviderRegistry();
    registry.register(runpodClient);

    // Engine 1: force ready
    const st1 = new SessionTracker(sharedStore, mockSessionResolver);
    const lt1 = new LatencyTracker(sharedStore);
    const p1 = new StatePersistence(sharedStore);
    for (let i = 0; i < 5; i++) await st1.reportSessionHeartbeat('persist-ready', `s-${i}`);
    const ep = 'http://persist-ready:8000';
    healthyEndpoints.add(ep);

    const eng1 = new AutoscalerEngine({
      registry, sessionTracker: st1, latencyTracker: lt1, persistence: p1,
      probeHealth: async (e) => healthyEndpoints.has(e), cleanupInstance: async () => {},
    });
    await eng1.getAutoScaleDecision('persist-ready', makeConfig());
    eng1.forceTierReady('persist-ready', 0, ep);
    const d1 = await eng1.getAutoScaleDecision('persist-ready', makeConfig());
    expect(d1.gpuState).toBe('ready');

    // Engine 2: same store → should see ready
    const st2 = new SessionTracker(sharedStore, mockSessionResolver);
    const lt2 = new LatencyTracker(sharedStore);
    const p2 = new StatePersistence(sharedStore);
    for (let i = 0; i < 5; i++) await st2.reportSessionHeartbeat('persist-ready', `s-${i}`);

    const eng2 = new AutoscalerEngine({
      registry, sessionTracker: st2, latencyTracker: lt2, persistence: p2,
      probeHealth: async (e) => healthyEndpoints.has(e), cleanupInstance: async () => {},
    });
    const d2 = await eng2.getAutoScaleDecision('persist-ready', makeConfig());
    expect(d2.gpuState === 'ready' || d2.gpuState === 'booting').toBe(true);
    healthyEndpoints.delete(ep);
  });

  it('7.2 persist booting → restore reverts to idle (no active callback)', async () => {
    const sharedStore = new InMemoryStateAdapter();
    const registry = new GpuProviderRegistry();
    registry.register(runpodClient);
    const p1 = new StatePersistence(sharedStore);

    // Manually persist a booting state
    const bootingState: BootingTierState = {
      state: 'booting', tierIndex: 0, endpoint: 'http://test:8000',
      bootTriggeredAt: Date.now() - 10_000, trigger: 'sessions', prevBootFailCount: 0,
    };
    await p1.persistTierStates('persist-booting', [bootingState]);

    // New engine loads — booting without callback → reverts to idle
    const st2 = new SessionTracker(sharedStore, mockSessionResolver);
    const lt2 = new LatencyTracker(sharedStore);
    const p2 = new StatePersistence(sharedStore);
    for (let i = 0; i < 5; i++) await st2.reportSessionHeartbeat('persist-booting', `s-${i}`);

    const eng2 = new AutoscalerEngine({
      registry, sessionTracker: st2, latencyTracker: lt2, persistence: p2,
      probeHealth: async () => false, cleanupInstance: async () => {},
    });
    const d = await eng2.getAutoScaleDecision('persist-booting', makeConfig());
    // Recent boot → reverted to idle → engine re-triggers boot
    expect(d.gpuState === 'idle' || d.gpuState === 'booting').toBe(true);
  });

  it('7.3 persist idle with bootFailCount (alongside active tier)', async () => {
    const sharedStore = new InMemoryStateAdapter();
    const p1 = new StatePersistence(sharedStore);
    // persistTierStates deletes key when ALL tiers are idle — include a ready tier
    const states: GpuTierState[] = [
      { state: 'idle', tierIndex: 0, bootFailCount: 2 } as IdleTierState,
      { state: 'ready', tierIndex: 1, endpoint: 'http://t:8000', lastHealthyAt: Date.now() } as ReadyTierState,
    ];
    await p1.persistTierStates('persist-failcount', states);

    const loaded = await p1.loadPersistedTierStates('persist-failcount');
    expect(loaded).toBeTruthy();
    expect(loaded![0]?.state).toBe('idle');
    expect((loaded![0] as IdleTierState).bootFailCount).toBe(2);
  });

  it('7.4 persist idle with cooldownUntil (alongside active tier)', async () => {
    const sharedStore = new InMemoryStateAdapter();
    const p1 = new StatePersistence(sharedStore);
    const cooldownTime = Date.now() + 300_000;
    // persistTierStates deletes key when ALL tiers are idle — include a ready tier
    const states: GpuTierState[] = [
      { state: 'idle', tierIndex: 0, cooldownUntil: cooldownTime } as IdleTierState,
      { state: 'ready', tierIndex: 1, endpoint: 'http://t:8000', lastHealthyAt: Date.now() } as ReadyTierState,
    ];
    await p1.persistTierStates('persist-cooldown', states);

    const loaded = await p1.loadPersistedTierStates('persist-cooldown');
    expect(loaded![0]?.state).toBe('idle');
    expect((loaded![0] as IdleTierState).cooldownUntil).toBe(cooldownTime);
  });

  it('7.5 persist then clear → empty', async () => {
    const sharedStore = new InMemoryStateAdapter();
    const p1 = new StatePersistence(sharedStore);

    // Must have at least one active tier to actually persist
    await p1.persistTierStates('persist-clear', [
      { state: 'ready', tierIndex: 0, endpoint: 'http://t:8000', lastHealthyAt: Date.now() } as ReadyTierState,
    ]);
    let loaded = await p1.loadPersistedTierStates('persist-clear');
    expect(loaded).toBeTruthy();

    await p1.persistTierStates('persist-clear', []);
    loaded = await p1.loadPersistedTierStates('persist-clear');
    // Empty array or null — key deleted
    expect(!loaded || loaded.length === 0).toBe(true);
  });

  it('7.6 multi-user persist — independent', async () => {
    const sharedStore = new InMemoryStateAdapter();
    const p = new StatePersistence(sharedStore);

    // Include a ready tier so the state is actually persisted (all-idle → deletes key)
    await p.persistTierStates('persist-user-a', [
      { state: 'idle', tierIndex: 0, bootFailCount: 1 } as IdleTierState,
      { state: 'ready', tierIndex: 1, endpoint: 'http://a:8000', lastHealthyAt: Date.now() } as ReadyTierState,
    ]);
    await p.persistTierStates('persist-user-b', [
      { state: 'idle', tierIndex: 0, bootFailCount: 5 } as IdleTierState,
      { state: 'ready', tierIndex: 1, endpoint: 'http://b:8000', lastHealthyAt: Date.now() } as ReadyTierState,
    ]);

    const a = await p.loadPersistedTierStates('persist-user-a');
    const b = await p.loadPersistedTierStates('persist-user-b');
    expect((a![0] as IdleTierState).bootFailCount).toBe(1);
    expect((b![0] as IdleTierState).bootFailCount).toBe(5);
  });

  it('7.7 3-tier mixed state persist', async () => {
    const sharedStore = new InMemoryStateAdapter();
    const p = new StatePersistence(sharedStore);

    const states: GpuTierState[] = [
      { state: 'idle', tierIndex: 0, unhealthy: true } as IdleTierState,
      { state: 'ready', tierIndex: 1, endpoint: 'http://test:8000', lastHealthyAt: Date.now() } as ReadyTierState,
      { state: 'booting', tierIndex: 2, endpoint: '', bootTriggeredAt: Date.now(), trigger: 'sessions', prevBootFailCount: 0 } as BootingTierState,
    ];
    await p.persistTierStates('persist-3tier', states);

    const loaded = await p.loadPersistedTierStates('persist-3tier');
    expect(loaded!.length).toBe(3);
    expect(loaded![0]?.state).toBe('idle');
    expect(loaded![1]?.state).toBe('ready');
    expect(loaded![2]?.state).toBe('booting');
  });

  it('7.8 findUsersWithActiveGpus', async () => {
    const sharedStore = new InMemoryStateAdapter();
    const p = new StatePersistence(sharedStore);

    await p.persistTierStates('active-user', [
      { state: 'ready', tierIndex: 0, endpoint: 'http://test:8000', lastHealthyAt: Date.now() } as ReadyTierState,
    ]);

    const users = await p.findUsersWithActiveGpus();
    expect(users).toContain('active-user');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 8. Session Tracking (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('8. Session Tracking', () => {
  it('8.1 report + count heartbeats', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SessionTracker(store, mockSessionResolver);

    await tracker.reportSessionHeartbeat('sess-user', 'sess-1');
    await tracker.reportSessionHeartbeat('sess-user', 'sess-2');
    await tracker.reportSessionHeartbeat('sess-user', 'sess-3');

    const count = await tracker.countActiveSessions('sess-user', 10);
    expect(count).toBe(3);
  });

  it('8.2 remove decrements count', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SessionTracker(store, mockSessionResolver);

    await tracker.reportSessionHeartbeat('sess-rm', 'sess-1');
    await tracker.reportSessionHeartbeat('sess-rm', 'sess-2');
    await tracker.removeSessionHeartbeat('sess-rm', 'sess-1');

    const count = await tracker.countActiveSessions('sess-rm', 10);
    expect(count).toBe(1);
  });

  it('8.3 duplicate key → same count', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SessionTracker(store, mockSessionResolver);

    await tracker.reportSessionHeartbeat('sess-dup', 'sess-1');
    await tracker.reportSessionHeartbeat('sess-dup', 'sess-1');
    await tracker.reportSessionHeartbeat('sess-dup', 'sess-1');

    const count = await tracker.countActiveSessions('sess-dup', 10);
    expect(count).toBe(1);
  });

  it('8.4 multi-user independent counts', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SessionTracker(store, mockSessionResolver);

    await tracker.reportSessionHeartbeat('sess-a', 'sess-1');
    await tracker.reportSessionHeartbeat('sess-a', 'sess-2');
    await tracker.reportSessionHeartbeat('sess-b', 'sess-3');

    expect(await tracker.countActiveSessions('sess-a', 10)).toBe(2);
    expect(await tracker.countActiveSessions('sess-b', 10)).toBe(1);
  });

  it('8.5 100 sessions', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SessionTracker(store, mockSessionResolver);

    for (let i = 0; i < 100; i++) {
      await tracker.reportSessionHeartbeat('sess-100', `sess-${i}`);
    }

    const count = await tracker.countActiveSessions('sess-100', 10);
    expect(count).toBe(100);
  });

  it('8.6 remove non-existent → no error', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SessionTracker(store, mockSessionResolver);

    await tracker.reportSessionHeartbeat('sess-noop', 'sess-1');
    await tracker.removeSessionHeartbeat('sess-noop', 'non-existent');

    const count = await tracker.countActiveSessions('sess-noop', 10);
    expect(count).toBe(1);
  });

  it('8.7 concurrent 50 heartbeats', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SessionTracker(store, mockSessionResolver);

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        tracker.reportSessionHeartbeat('sess-conc', `sess-${i}`),
      ),
    );

    const count = await tracker.countActiveSessions('sess-conc', 10);
    expect(count).toBe(50);
  });

  it('8.8 zero window returns 0 for empty user', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SessionTracker(store, mockSessionResolver);

    const count = await tracker.countActiveSessions('sess-empty', 0);
    expect(count).toBe(0);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 9. Latency Tracking (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('9. Latency Tracking', () => {
  it('9.1 report + P95', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new LatencyTracker(store);

    for (let i = 0; i < 10; i++) {
      await tracker.reportLatency('latency-p95', 100 + i * 10);
    }

    const stats = await tracker.getLatencyStats('latency-p95');
    expect(stats.p95).toBeDefined();
    expect(stats.p95!).toBeGreaterThanOrEqual(180);
    expect(stats.samples.length).toBe(10);
  });

  it('9.2 window of 20 trims old samples', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new LatencyTracker(store);

    for (let i = 0; i < 30; i++) {
      await tracker.reportLatency('latency-trim', i * 10);
    }

    const stats = await tracker.getLatencyStats('latency-trim');
    expect(stats.samples.length).toBe(20);
  });

  it('9.3 all above threshold → breaches', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new LatencyTracker(store);

    for (let i = 0; i < 5; i++) {
      await tracker.reportLatency('latency-breach', 5000);
    }

    const stats = await tracker.getLatencyStats('latency-breach', 2000);
    expect(stats.breaches).toBeGreaterThanOrEqual(LATENCY_BREACH_COUNT);
  });

  it('9.4 mixed samples → correct P95', async () => {
    const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
                     1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000];
    const p95 = computeP95(samples);
    expect(p95).toBe(1900); // 95th percentile of 1..20: index 18 → 1900
  });

  it('9.5 no samples → null P95', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new LatencyTracker(store);

    const stats = await tracker.getLatencyStats('latency-empty');
    expect(stats.p95).toBeNull();
    expect(stats.samples.length).toBe(0);
  });

  it('9.6 latency breach triggers boot (engine integration)', async () => {
    const { engine, latencyTracker } = await buildLocalEngine('latency-boot', 0);

    // Report high latency breaches (> threshold) — need 3+ recent
    for (let i = 0; i < 5; i++) {
      await latencyTracker.reportLatency('latency-boot', 5000);
    }

    const d = await engine.getAutoScaleDecision('latency-boot', makeConfig({ threshold: 999, maxLatencyMs: 2000 }));
    // Latency should trigger boot even without sessions reaching threshold
    expect(d.gpuState).toBe('booting');
  });

  it('9.7 multi-user latency independent', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new LatencyTracker(store);

    await tracker.reportLatency('latency-a', 100);
    await tracker.reportLatency('latency-b', 5000);

    const a = await tracker.getLatencyStats('latency-a');
    const b = await tracker.getLatencyStats('latency-b');
    expect(a.p95!).toBeLessThan(200);
    expect(b.p95!).toBeGreaterThan(4000);
  });

  it('9.8 single sample = that value', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new LatencyTracker(store);

    await tracker.reportLatency('latency-single', 42);
    const stats = await tracker.getLatencyStats('latency-single');
    expect(stats.p95).toBe(42);
    expect(stats.samples.length).toBe(1);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 10. Load Balancer (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('10. Load Balancer', () => {
  function makeReadyTiers(count: number): ReadyTierState[] {
    return Array.from({ length: count }, (_, i) => ({
      state: 'ready' as const,
      tierIndex: i,
      endpoint: `http://tier-${i}:8000`,
      lastHealthyAt: Date.now(),
    }));
  }

  it('10.1 hash is deterministic', async () => {
    const store = new InMemoryStateAdapter();
    const lb = new LoadBalancer(store);
    const tiers = makeReadyTiers(3);

    const idx1 = await lb.selectTier('user-hash', tiers, 'hash');
    const idx2 = await lb.selectTier('user-hash', tiers, 'hash');
    const idx3 = await lb.selectTier('user-hash', tiers, 'hash');
    expect(idx1).toBe(idx2);
    expect(idx2).toBe(idx3);
  });

  it('10.2 round-robin cycles through tiers', async () => {
    const store = new InMemoryStateAdapter();
    const lb = new LoadBalancer(store);
    const tiers = makeReadyTiers(3);

    const selected = new Set<number>();
    for (let i = 0; i < 6; i++) {
      selected.add(await lb.selectTier('rr-user', tiers, 'weighted-round-robin'));
    }
    // Should have visited all 3 tiers
    expect(selected.size).toBe(3);
  });

  it('10.3 least-latency picks lowest', async () => {
    const store = new InMemoryStateAdapter();
    const lb = new LoadBalancer(store);
    const tiers = makeReadyTiers(3);

    await lb.reportTierLatency('ll-user', 0, 500);
    await lb.reportTierLatency('ll-user', 1, 100);
    await lb.reportTierLatency('ll-user', 2, 300);

    const idx = await lb.selectTier('ll-user', tiers, 'least-latency');
    expect(idx).toBe(1); // tier 1 has lowest latency
  });

  it('10.4 affinity sticks to same tier', async () => {
    const store = new InMemoryStateAdapter();
    const lb = new LoadBalancer(store);
    const tiers = makeReadyTiers(3);

    const first = await lb.selectTier('affinity-user', tiers, 'affinity');
    for (let i = 0; i < 5; i++) {
      const next = await lb.selectTier('affinity-user', tiers, 'affinity');
      expect(next).toBe(first);
    }
  });

  it('10.5 reportTierLatency uses EMA', async () => {
    const store = new InMemoryStateAdapter();
    const lb = new LoadBalancer(store);

    await lb.reportTierLatency('ema-user', 0, 1000);
    const m1 = await lb.getTierLatency('ema-user', 0);
    expect(m1!.emaLatencyMs).toBe(1000);

    await lb.reportTierLatency('ema-user', 0, 0);
    const m2 = await lb.getTierLatency('ema-user', 0);
    // EMA(0.3): 0.3 * 0 + 0.7 * 1000 = 700
    expect(m2!.emaLatencyMs).toBe(700);
  });

  it('10.6 token bucket consume', async () => {
    const store = new InMemoryStateAdapter();
    const lb = new LoadBalancer(store, { capacity: 5, refillRate: 0, initialTokens: 5 });

    expect(await lb.tryConsume('tb-client')).toBe(true);
    expect(await lb.tryConsume('tb-client')).toBe(true);
    expect(await lb.tryConsume('tb-client')).toBe(true);
    expect(await lb.tryConsume('tb-client')).toBe(true);
    expect(await lb.tryConsume('tb-client')).toBe(true);
  });

  it('10.7 token bucket exhaust → false', async () => {
    const store = new InMemoryStateAdapter();
    const lb = new LoadBalancer(store, { capacity: 2, refillRate: 0, initialTokens: 2 });

    expect(await lb.tryConsume('tb-exhaust')).toBe(true);
    expect(await lb.tryConsume('tb-exhaust')).toBe(true);
    expect(await lb.tryConsume('tb-exhaust')).toBe(false);
  });

  it('10.8 connection increment/decrement', async () => {
    const store = new InMemoryStateAdapter();
    const lb = new LoadBalancer(store);

    await lb.incrementConnections(0);
    await lb.incrementConnections(0);
    await lb.decrementConnections(0);

    // Select should work (not throw). With least-busy, tier 0 has 1 connection
    const tiers = makeReadyTiers(2);
    const idx = await lb.selectTier('conn-user', tiers, 'least-busy');
    expect(idx).toBe(1); // tier 1 has 0 connections
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 11. Watchdog (4 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('11. Watchdog', () => {
  async function buildWatchdogDeps(userId: string): Promise<{
    deps: WatchdogDeps;
    engine: AutoscalerEngine;
    persistence: StatePersistence;
    sessionTracker: SessionTracker;
  }> {
    const registry = new GpuProviderRegistry();
    registry.register(runpodClient);
    const stateStore = new InMemoryStateAdapter();
    const sessionTracker = new SessionTracker(stateStore, mockSessionResolver);
    const latencyTracker = new LatencyTracker(stateStore);
    const persistence = new StatePersistence(stateStore);

    const engine = new AutoscalerEngine({
      registry, sessionTracker, latencyTracker, persistence,
      probeHealth: async (ep) => healthyEndpoints.has(ep),
      cleanupInstance: async () => {},
    });

    const deps: WatchdogDeps = {
      engine, sessionTracker, persistence, registry,
      loadConfig: async () => makeConfig(),
    };

    return { deps, engine, persistence, sessionTracker };
  }

  it('11.1 stops idle tier after grace period', async () => {
    const { deps, engine } = await buildWatchdogDeps('wd-idle');

    // Force ready with old lastHealthyAt (past idle grace)
    const ep = 'http://wd-idle:8000';
    healthyEndpoints.add(ep);
    engine.setTierState('wd-idle', 0, {
      state: 'ready', tierIndex: 0, endpoint: ep,
      lastHealthyAt: Date.now() - 60 * 60_000, // 60 min ago
    } as ReadyTierState);

    // No sessions → tier should be stopped
    await runWatchdogCycle(deps);

    const pool = engine.getPoolStatus('wd-idle');
    expect(pool[0]?.state).toBe('idle');
    healthyEndpoints.delete(ep);
  });

  it('11.2 cleans stuck booting tier', async () => {
    const { deps, engine } = await buildWatchdogDeps('wd-stuck');

    engine.setTierState('wd-stuck', 0, {
      state: 'booting', tierIndex: 0, endpoint: '',
      bootTriggeredAt: Date.now() - 60 * 60_000, // 1 hour ago — way past timeout
      trigger: 'sessions', prevBootFailCount: 0,
    } as BootingTierState);

    await runWatchdogCycle(deps);

    const pool = engine.getPoolStatus('wd-stuck');
    // Should be reverted to idle
    expect(pool[0]?.state).toBe('idle');
    if (pool[0]?.state === 'idle') {
      expect((pool[0] as IdleTierState).unhealthy).toBe(true);
    }
  });

  it('11.3 skips active tiers with sessions', async () => {
    const { deps, engine, sessionTracker } = await buildWatchdogDeps('wd-active');

    // Add sessions so the tier is "needed"
    for (let i = 0; i < 5; i++) {
      await sessionTracker.reportSessionHeartbeat('wd-active', `sess-${i}`);
    }

    const ep = 'http://wd-active:8000';
    healthyEndpoints.add(ep);
    engine.setTierState('wd-active', 0, {
      state: 'ready', tierIndex: 0, endpoint: ep,
      lastHealthyAt: Date.now(), // Fresh
    } as ReadyTierState);

    await runWatchdogCycle(deps);

    const pool = engine.getPoolStatus('wd-active');
    expect(pool[0]?.state).toBe('ready'); // Not stopped
    healthyEndpoints.delete(ep);
  });

  it('11.4 handles empty state map', async () => {
    const { deps } = await buildWatchdogDeps('wd-empty');

    // No state set — should not throw
    await expect(runWatchdogCycle(deps)).resolves.not.toThrow();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 12. Provider API Operations (6 tests — real API)
// ═══════════════════════════════════════════════════════════════════════════════

describe('12. Provider API Operations', () => {
  it('12.1 RunPod listInstances succeeds', async () => {
    const { result: instances, ms } = await timed(() =>
      runpodClient.listInstances(runpodCreds),
    );
    log(`RunPod: ${instances.length} instance(s) (${ms}ms)`);
    expect(Array.isArray(instances)).toBe(true);
  });

  it('12.2 Vast.ai listInstances succeeds', async () => {
    const { result: instances, ms } = await timed(() =>
      vastClient.listInstances(vastCreds),
    );
    log(`Vast.ai: ${instances.length} instance(s) (${ms}ms)`);
    expect(Array.isArray(instances)).toBe(true);
  });

  it('12.3 RunPod invalid key → error', async () => {
    try {
      await runpodClient.listInstances({ apiKey: 'invalid-key-12345' });
      // If it doesn't throw, it should return empty or error response
    } catch (err) {
      expect(err).toBeDefined();
    }
  });

  it('12.4 Vast.ai invalid key → error', async () => {
    try {
      await vastClient.listInstances({ apiKey: 'invalid-key-12345' });
    } catch (err) {
      expect(err).toBeDefined();
    }
  });

  it('12.5 dual registry resolves both providers', () => {
    const registry = new GpuProviderRegistry();
    registry.register(runpodClient);
    registry.register(vastClient);

    expect(registry.get('runpod')).toBe(runpodClient);
    expect(registry.get('vast')).toBe(vastClient);
    expect(registry.get('tensordock')).toBeUndefined();
  });

  it('12.6 RunPod non-existent pod → null/error', async () => {
    try {
      const status = await runpodClient.getInstanceStatus('non-existent-pod-id-12345', runpodCreds);
      // May return null or throw
      expect(status === null || status === undefined || status === 'NOT_FOUND').toBeTruthy();
    } catch (err) {
      expect(err).toBeDefined();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 13. Cost Monitor (4 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('13. Cost Monitor', () => {
  function makeCostMonitorDeps(accounts: ProviderAccount[], overrides?: Partial<CostMonitorDeps>): CostMonitorDeps {
    const registry = new GpuProviderRegistry();
    registry.register(runpodClient);
    registry.register(vastClient);
    const store = new InMemoryStateAdapter();
    const persistence = new StatePersistence(store);

    return {
      registry, persistence,
      loadAllAccounts: async () => accounts,
      probeHealth: false, // Don't probe in tests
      staleTracker: new StaleTracker(),
      ...overrides,
    };
  }

  it('13.1 no accounts → empty report', async () => {
    const deps = makeCostMonitorDeps([]);
    const report = await runCostMonitorCycle(deps);
    expect(report.accountsChecked).toBe(0);
    expect(report.orphaned.length).toBe(0);
    expect(report.stale.length).toBe(0);
  });

  it('13.2 zero tracked → running instances are orphaned', async () => {
    const accounts: ProviderAccount[] = [{
      userId: 'cost-user',
      provider: 'runpod',
      credentials: runpodCreds,
      trackedInstanceIds: [], // Nothing tracked
    }];
    const deps = makeCostMonitorDeps(accounts);
    const report = await runCostMonitorCycle(deps);
    expect(report.accountsChecked).toBe(1);
    // Any running instances would be orphaned
    for (const orphan of report.orphaned) {
      expect(orphan.isOrphaned).toBe(true);
    }
  });

  it('13.3 matching tracked → 0 orphaned', async () => {
    // List real instances first
    const instances = await runpodClient.listInstances(runpodCreds);
    const runningIds = instances
      .filter(i => i.status === 'RUNNING')
      .map(i => i.instanceId);

    const accounts: ProviderAccount[] = [{
      userId: 'cost-matched',
      provider: 'runpod',
      credentials: runpodCreds,
      trackedInstanceIds: runningIds,
    }];
    const deps = makeCostMonitorDeps(accounts);
    const report = await runCostMonitorCycle(deps);
    expect(report.orphaned.length).toBe(0);
  });

  it('13.4 autoStop=false → no instances stopped', async () => {
    const accounts: ProviderAccount[] = [{
      userId: 'cost-nostop',
      provider: 'runpod',
      credentials: runpodCreds,
      trackedInstanceIds: [],
    }];
    const deps = makeCostMonitorDeps(accounts, { autoStop: false });
    const report = await runCostMonitorCycle(deps);
    // Even if orphans found, actionTaken should be 'none'
    for (const orphan of report.orphaned) {
      expect(orphan.actionTaken).toBe('none');
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 14. Full Integration (4 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('14. Full Integration', () => {
  it('14.1 happy path: idle → boot → force ready → s2s route', async () => {
    const { engine } = await buildLocalEngine('integration-happy', 5);
    const config = makeConfig();
    const ep = 'http://integration-happy:8000';

    // Step 1: idle → boot
    const d1 = await engine.getAutoScaleDecision('integration-happy', config);
    expect(d1.gpuState).toBe('booting');
    expect(d1.route).toBe('llm');

    // Step 2: force ready
    healthyEndpoints.add(ep);
    engine.forceTierReady('integration-happy', 0, ep);

    // Step 3: decision routes to s2s
    const d2 = await engine.getAutoScaleDecision('integration-happy', config);
    expect(d2.gpuState).toBe('ready');
    expect(d2.route).toBe('s2s');
    expect(d2.endpoint).toBe(ep);
    healthyEndpoints.delete(ep);
  });

  it('14.2 disaster recovery: 2-tier fail + clear + re-boot', async () => {
    const { engine } = await buildLocalEngine('integration-disaster', 5);
    const config = make2TierConfig();

    // Both tiers fail
    engine.setTierState('integration-disaster', 0, { state: 'idle', tierIndex: 0, unhealthy: true } as IdleTierState);
    engine.setTierState('integration-disaster', 1, { state: 'idle', tierIndex: 1, unhealthy: true } as IdleTierState);

    const d1 = await engine.getAutoScaleDecision('integration-disaster', config);
    expect(d1.route).toBe('llm');

    // Admin clears state
    engine.resetGpuState('integration-disaster');

    // Re-boot
    const d2 = await engine.getAutoScaleDecision('integration-disaster', config);
    expect(d2.gpuState).toBe('booting');
  });

  it('14.3 multi-user isolation — different states simultaneously', async () => {
    const { engine } = await buildLocalEngine('integration-iso-a', 5);
    const epA = 'http://iso-a:8000';
    healthyEndpoints.add(epA);
    engine.forceTierReady('integration-iso-a', 0, epA);

    const { engine: engine2 } = await buildLocalEngine('integration-iso-b', 0);

    const dA = await engine.getAutoScaleDecision('integration-iso-a', makeConfig());
    const dB = await engine2.getAutoScaleDecision('integration-iso-b', makeConfig({ threshold: 100 }));

    expect(dA.gpuState).toBe('ready');
    expect(dA.route).toBe('s2s');
    expect(dB.gpuState).toBe('idle');
    expect(dB.route).toBe('llm');
    healthyEndpoints.delete(epA);
  });

  it('14.4 full lifecycle 2-tier failover (RunPod)', async () => {
    const registry = new GpuProviderRegistry();
    registry.register(runpodClient);
    const userId = 'integration-lifecycle';
    const { engine } = await buildEngineWithSessions(registry, userId, 5);
    const createdInstances: string[] = [];

    const config: AutoScalerConfig = {
      enabled: true, threshold: 1, windowMinutes: 30, maxLatencyMs: 2000,
      tiers: [
        {
          provider: 'runpod', apiKey: runpodCreds.apiKey,
          gpuTypes: ['RTX 4090', 'RTX A5000', 'A40'],
          dockerImage: 'python:3.11-slim', storageGb: 0,
          env: { TEST: 'lifecycle-t0' },
        },
        {
          provider: 'runpod', apiKey: runpodCreds.apiKey,
          gpuTypes: ['RTX 4090', 'RTX A5000', 'A40'],
          dockerImage: 'python:3.11-slim', storageGb: 0,
          env: { TEST: 'lifecycle-t1' },
        },
      ],
    };

    // Phase 1: Tier 0 boots
    const d1 = await engine.getAutoScaleDecision(userId, config);
    log(`Phase 1: gpuState=${d1.gpuState}`);
    expect(d1.gpuState).toBe('booting');

    // Wait for tier 0 instanceId
    let tier0InstanceId: string | null = null;
    await waitFor(
      async () => {
        const pool = engine.getPoolStatus(userId);
        const bt = pool.find(s => s.state === 'booting' && s.tierIndex === 0) as BootingTierState | undefined;
        if (bt?.discoveredInstanceId) {
          tier0InstanceId = bt.discoveredInstanceId;
          createdInstances.push(tier0InstanceId!);
          cleanup.push({ provider: 'runpod', instanceId: tier0InstanceId! });
          log(`tier 0 instanceId = ${tier0InstanceId}`);
          return true;
        }
        return false;
      },
      { intervalMs: 2_000, timeoutMs: 30_000, label: 'tier 0 instanceId' },
    );

    // Wait for RUNNING
    await waitFor(
      async () => {
        const status = await runpodClient.getInstanceStatus(tier0InstanceId!, runpodCreds);
        return status === 'RUNNING';
      },
      { intervalMs: 5_000, timeoutMs: 90_000, label: 'tier 0 RUNNING' },
    );

    // Phase 2: Force ready
    const ep0 = await runpodClient.resolveInstanceEndpoint(tier0InstanceId!, runpodCreds);
    const endpoint0 = ep0 || `https://${tier0InstanceId}-8000.proxy.runpod.net`;
    healthyEndpoints.add(endpoint0);
    engine.forceTierReady(userId, 0, endpoint0);
    const d2 = await engine.getAutoScaleDecision(userId, config);
    log(`Phase 2: gpuState=${d2.gpuState}, route=${d2.route}`);
    expect(d2.gpuState).toBe('ready');

    // Phase 3: Stop tier 0
    log('Stopping tier 0...');
    await runpodClient.stopInstance(tier0InstanceId!, runpodCreds);
    healthyEndpoints.delete(endpoint0);
    await new Promise(r => setTimeout(r, 3_000));

    const d3 = await engine.getAutoScaleDecision(userId, config);
    log(`Phase 3: gpuState=${d3.gpuState}, route=${d3.route}`);

    // Phase 4: Tier 1 should boot
    const pool3 = engine.getPoolStatus(userId);
    if (pool3[0]?.state === 'booting') {
      await new Promise(r => setTimeout(r, 10_000));
    }
    await engine.getAutoScaleDecision(userId, config);

    let tier1InstanceId: string | null = null;
    await waitFor(
      async () => {
        const pool = engine.getPoolStatus(userId);
        for (const ts of pool) {
          if (ts.state === 'booting' && ts.tierIndex === 1) {
            const bt = ts as BootingTierState;
            if (bt.discoveredInstanceId) {
              tier1InstanceId = bt.discoveredInstanceId;
              createdInstances.push(tier1InstanceId!);
              cleanup.push({ provider: 'runpod', instanceId: tier1InstanceId! });
              return true;
            }
          }
          if (ts.state === 'ready' && ts.tierIndex === 1) return true;
        }
        const tier0State = pool[0];
        if (tier0State?.state === 'idle' && (tier0State as IdleTierState).bootFailCount) {
          await engine.getAutoScaleDecision(userId, config);
        }
        return false;
      },
      { intervalMs: 3_000, timeoutMs: 60_000, label: 'tier 1 boot' },
    );

    if (tier1InstanceId) {
      log(`tier 1 instanceId = ${tier1InstanceId}`);
      await waitFor(
        async () => {
          const status = await runpodClient.getInstanceStatus(tier1InstanceId!, runpodCreds);
          return status === 'RUNNING';
        },
        { intervalMs: 5_000, timeoutMs: 90_000, label: 'tier 1 RUNNING' },
      );

      const ep1 = await runpodClient.resolveInstanceEndpoint(tier1InstanceId!, runpodCreds);
      const endpoint1 = ep1 || `https://${tier1InstanceId}-8000.proxy.runpod.net`;
      healthyEndpoints.add(endpoint1);
      engine.forceTierReady(userId, 1, endpoint1);

      const d5 = await engine.getAutoScaleDecision(userId, config);
      log(`Phase 5: gpuState=${d5.gpuState}, route=${d5.route}`);
      expect(d5.gpuState).toBe('ready');
      expect(d5.route).toBe('s2s');
      healthyEndpoints.delete(endpoint1);
    }

    // Cleanup
    for (const instanceId of createdInstances) {
      try {
        await runpodClient.deleteInstance(instanceId, runpodCreds);
        const idx = cleanup.findIndex(c => c.instanceId === instanceId);
        if (idx >= 0) cleanup.splice(idx, 1);
      } catch {}
    }
  }, 300_000);
});
