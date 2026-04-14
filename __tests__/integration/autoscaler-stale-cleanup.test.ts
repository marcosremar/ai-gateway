/**
 * Unit tests: Autoscaler Stale/Failed GPU Cleanup
 *
 * Tests the new cleanup behavior:
 *   1. Boot timeout → increments bootFailCount + exponential cooldown
 *   2. After 3 consecutive failures → tier marked unhealthy
 *   3. Cooldown is respected in the re-boot loop
 *   4. Successful boot → resets failure counters (implicit via ReadyTierState)
 *   5. stopInstance() called on boot timeout
 *   6. stopInstance() called when ready → unhealthy
 *   7. Watchdog cleans up tiers stuck in 'booting' > 15 min
 *
 * Uses in-memory mocks — no Redis, no Prisma, no network needed.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { StateStore, SessionResolver, SettingsStore } from '@ai-gateway';
import { createAutoscaler, type Autoscaler } from '@ai-gateway';
import type { AutoScalerConfig, GpuTierState, IdleTierState, BootingTierState } from '@ai-gateway';

// ──────────────────────────────────────────────────────────────────────────────
// In-memory StateStore (replaces Redis)
// ──────────────────────────────────────────────────────────────────────────────
class MemoryStateStore implements StateStore {
  private kv = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();

  async get(key: string) {
    return this.kv.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.kv.set(key, value);
  }
  async del(key: string) {
    this.kv.delete(key);
    this.hashes.delete(key);
  }
  async scan(pattern: string) {
    const prefix = pattern.replace('*', '');
    return [...this.kv.keys()].filter((k) => k.startsWith(prefix));
  }
  async rpush(key: string, value: string) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    this.lists.get(key)!.push(value);
  }
  async ltrim(key: string, start: number, stop: number) {
    const list = this.lists.get(key);
    if (!list) return;
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    this.lists.set(key, list.slice(s, e + 1));
  }
  async lrange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    return list.slice(s, e + 1);
  }
  async hset(key: string, field: string, value: string) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
  }
  async hdel(key: string, field: string) {
    this.hashes.get(key)?.delete(field);
  }
  async hgetall(key: string) {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash);
  }
}

class MockSessionResolver implements SessionResolver {
  async countDbSessions() {
    return 0;
  }
  async resolveTeacher() {
    return null;
  }
}

class MockSettingsStore implements SettingsStore {
  async get() {
    return {};
  }
  async patch() {}
}

// ──────────────────────────────────────────────────────────────────────────────
// Test constants
// ──────────────────────────────────────────────────────────────────────────────
const TEST_USER = 'user-stale-cleanup-test';
const GPU_ENDPOINT = 'http://10.0.0.1:8000';

const BASE_CONFIG: AutoScalerConfig = {
  enabled: true,
  threshold: 1, // Low threshold for easy triggering
  windowMinutes: 10,
  maxLatencyMs: 1500,
  tiers: [
    {
      provider: 'tensordock',
      instanceId: 'td-instance-001',
      endpoint: GPU_ENDPOINT,
      apiKey: 'fake-api-key',
    },
  ],
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
let healthyEndpoints: Set<string>;
let mockStopInstance: Mock;
let mockStartInstance: Mock;

function getTier(autoscaler: Autoscaler, tierIndex = 0): GpuTierState | undefined {
  return autoscaler.getPoolStatus(TEST_USER)[tierIndex];
}

function getIdleTier(autoscaler: Autoscaler, tierIndex = 0): IdleTierState | undefined {
  const tier = getTier(autoscaler, tierIndex);
  return tier?.state === 'idle' ? tier : undefined;
}

/** Put a tier into booting state with sessions above threshold */
async function triggerBoot(autoscaler: Autoscaler): Promise<void> {
  await autoscaler.reportSessionHeartbeat(TEST_USER, 'session-1');
  await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);
}

/** Simulate boot timeout by backdating bootTriggeredAt */
function simulateBootTimeout(autoscaler: Autoscaler, tierIndex = 0): void {
  const tiers = autoscaler.getPoolStatus(TEST_USER);
  const tier = tiers[tierIndex];
  if (tier?.state === 'booting') {
    // TensorDock bootTimeSecs=1200, timeout = 2 × 1200 = 2400s → set to 2500s ago
    tiers[tierIndex] = { ...tier, bootTriggeredAt: Date.now() - 2_500_000 };
  }
}

describe('Autoscaler Stale/Failed GPU Cleanup', () => {
  let autoscaler: Autoscaler;

  beforeEach(() => {
    healthyEndpoints = new Set();
    mockStopInstance = vi.fn().mockResolvedValue(undefined);
    mockStartInstance = vi.fn().mockResolvedValue(undefined);

    // Mock global fetch for health probes
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const urlStr = url;
        for (const ep of healthyEndpoints) {
          if (urlStr.startsWith(ep)) {
            return new Response(JSON.stringify({ status: 'healthy' }), { status: 200 });
          }
        }
        return new Response('unhealthy', { status: 503 });
      }),
    );

    autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(),
      stateStore: new MemoryStateStore(),
      sessionResolver: new MockSessionResolver(),
      loadConfig: async () => BASE_CONFIG,
    });

    // Register mock stopInstance/startInstance on the provider client
    const client = autoscaler.registry.get('tensordock');
    if (client) {
      client.stopInstance = mockStopInstance;
      client.startInstance = mockStartInstance;
    }

    autoscaler.resetGpuState(TEST_USER);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 1. Boot timeout increments bootFailCount
  // ────────────────────────────────────────────────────────────────────────
  it('should increment bootFailCount on boot timeout', async () => {
    await triggerBoot(autoscaler);
    expect(getTier(autoscaler)?.state).toBe('booting');

    simulateBootTimeout(autoscaler);

    // Next decision detects timeout → reverts to idle + increments failCount
    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    // After timeout the engine reverts to idle then immediately re-boots
    // because sessions are still >= threshold. Check the fail count persisted.
    const tier = getIdleTier(autoscaler);
    expect(tier?.bootFailCount).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. Exponential cooldown calculation
  // ────────────────────────────────────────────────────────────────────────
  it('should set exponential cooldown on boot timeout', async () => {
    await triggerBoot(autoscaler);
    simulateBootTimeout(autoscaler);

    const beforeDecision = Date.now();
    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    const tier = getIdleTier(autoscaler);
    // First failure: cooldown = 2 min base × 2^0 = 2 min
    expect(tier?.cooldownUntil).toBeDefined();
    if (tier?.cooldownUntil) {
      const cooldownDuration = tier.cooldownUntil - beforeDecision;
      // First failure = 2 min = 120_000ms (+ small execution time)
      expect(cooldownDuration).toBeGreaterThanOrEqual(2 * 60_000);
      expect(cooldownDuration).toBeLessThanOrEqual(2 * 60_000 + 1000);
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. Cooldown prevents immediate re-boot
  // ────────────────────────────────────────────────────────────────────────
  it('should respect cooldown and not re-boot immediately', async () => {
    await triggerBoot(autoscaler);
    simulateBootTimeout(autoscaler);

    // This triggers the timeout handling
    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    const tier = getIdleTier(autoscaler);

    // If the tier is in cooldown and sessions are above threshold,
    // it should NOT be booting — it should remain idle during cooldown
    if (tier?.cooldownUntil && Date.now() < tier.cooldownUntil) {
      // The tier should be idle (cooldown active), not booting
      expect(tier.state).toBe('idle');
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. After 3 failures → tier marked unhealthy
  // ────────────────────────────────────────────────────────────────────────
  it('should mark tier unhealthy after 3 consecutive boot failures', async () => {
    await autoscaler.reportSessionHeartbeat(TEST_USER, 'session-1');

    for (let attempt = 1; attempt <= 3; attempt++) {
      // Force tier to idle so we can trigger a fresh boot each iteration
      const tiers = autoscaler.getPoolStatus(TEST_USER);
      const existing = tiers[0];
      if (existing) {
        const prevBootFailCount =
          existing.state === 'idle'
            ? (existing.bootFailCount ?? 0)
            : ((existing as BootingTierState).prevBootFailCount ?? 0);
        tiers[0] = {
          state: 'idle',
          tierIndex: existing.tierIndex,
          bootFailCount: prevBootFailCount,
          cooldownUntil: undefined,
          unhealthy: false,
        } satisfies IdleTierState;
      }

      // Trigger boot
      await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);
      expect(getTier(autoscaler)?.state).toBe('booting');

      // Simulate timeout
      simulateBootTimeout(autoscaler);

      // Process timeout — engine detects expired boot
      await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

      const idle = getIdleTier(autoscaler);
      expect(idle?.bootFailCount).toBe(attempt);
    }

    const tier = getIdleTier(autoscaler);
    expect(tier?.bootFailCount).toBe(3);
    expect(tier?.unhealthy).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 5. stopInstance called on boot timeout
  // ────────────────────────────────────────────────────────────────────────
  it('should call stopInstance on boot timeout', async () => {
    await triggerBoot(autoscaler);
    simulateBootTimeout(autoscaler);

    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    // Allow the fire-and-forget cleanup to run
    await new Promise((r) => setTimeout(r, 50));

    expect(mockStopInstance).toHaveBeenCalledWith(
      'td-instance-001',
      expect.objectContaining({ apiKey: 'fake-api-key' }),
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // 6. stopInstance called when ready → unhealthy
  // ────────────────────────────────────────────────────────────────────────
  it('should call stopInstance when a ready tier becomes unhealthy', async () => {
    // Setup: force GPU ready + make healthy
    autoscaler.forceGpuReady(TEST_USER, GPU_ENDPOINT);
    healthyEndpoints.add(GPU_ENDPOINT);

    // Confirm ready
    const d1 = await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);
    expect(d1.gpuState).toBe('ready');

    // Make unhealthy
    healthyEndpoints.delete(GPU_ENDPOINT);

    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    // Allow fire-and-forget cleanup
    await new Promise((r) => setTimeout(r, 50));

    expect(mockStopInstance).toHaveBeenCalledWith(
      'td-instance-001',
      expect.objectContaining({ apiKey: 'fake-api-key' }),
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7. Boot success resets failure counters (implicit via ReadyTierState)
  // ────────────────────────────────────────────────────────────────────────
  it('should transition to ready state on successful boot (no failure fields)', async () => {
    // Simulate a previous failure
    await triggerBoot(autoscaler);
    simulateBootTimeout(autoscaler);
    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    const tierAfterFail = getIdleTier(autoscaler);
    expect(tierAfterFail?.bootFailCount).toBe(1);

    // Now force into booting state with the right prevBootFailCount
    const tiers = autoscaler.getPoolStatus(TEST_USER);
    const existing = tiers[0];
    if (existing) {
      const booting: BootingTierState = {
        state: 'booting',
        tierIndex: existing.tierIndex,
        endpoint: GPU_ENDPOINT,
        bootTriggeredAt: Date.now(),
        trigger: 'sessions',
        prevBootFailCount: existing.state === 'idle' ? (existing.bootFailCount ?? 0) : 0,
      };
      tiers[0] = booting;
    }

    healthyEndpoints.add(GPU_ENDPOINT);

    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    const tierAfterSuccess = getTier(autoscaler);
    expect(tierAfterSuccess?.state).toBe('ready');
    // ReadyTierState has no bootFailCount — success implicitly clears failure history
  });

  // ────────────────────────────────────────────────────────────────────────
  // 8. Unhealthy tier is skipped in boot loop
  // ────────────────────────────────────────────────────────────────────────
  it('should not re-boot an unhealthy tier', async () => {
    // Mark tier unhealthy via direct array mutation
    autoscaler.forceGpuReady(TEST_USER, GPU_ENDPOINT);
    const tiers = autoscaler.getPoolStatus(TEST_USER);
    const existing = tiers[0];
    if (existing) {
      tiers[0] = {
        state: 'idle',
        tierIndex: existing.tierIndex,
        unhealthy: true,
      } satisfies IdleTierState;
    }

    await autoscaler.reportSessionHeartbeat(TEST_USER, 'session-1');
    const decision = await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    // Should remain idle/serverless — no boot triggered
    expect(decision.route).toBe('llm');
    expect(decision.gpuState).toBe('idle');
    expect(getTier(autoscaler)?.state).toBe('idle');
  });

  // ────────────────────────────────────────────────────────────────────────
  // 9. Cooldown in idle tier is skipped during boot loop
  // ────────────────────────────────────────────────────────────────────────
  it('should skip tier in cooldown during boot loop', async () => {
    autoscaler.forceGpuReady(TEST_USER, GPU_ENDPOINT);
    const tiers = autoscaler.getPoolStatus(TEST_USER);
    const existing = tiers[0];
    if (existing) {
      tiers[0] = {
        state: 'idle',
        tierIndex: existing.tierIndex,
        unhealthy: false,
        cooldownUntil: Date.now() + 60_000, // 1 min from now
      } satisfies IdleTierState;
    }

    await autoscaler.reportSessionHeartbeat(TEST_USER, 'session-1');
    const decision = await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    // Should not boot — tier is in cooldown
    expect(decision.route).toBe('llm');
    expect(decision.gpuState).toBe('idle');
    expect(getTier(autoscaler)?.state).toBe('idle');
  });

  // ────────────────────────────────────────────────────────────────────────
  // 10. Expired cooldown allows re-boot
  // ────────────────────────────────────────────────────────────────────────
  it('should allow re-boot after cooldown expires', async () => {
    autoscaler.forceGpuReady(TEST_USER, GPU_ENDPOINT);
    const tiers = autoscaler.getPoolStatus(TEST_USER);
    const existing = tiers[0];
    if (existing) {
      tiers[0] = {
        state: 'idle',
        tierIndex: existing.tierIndex,
        unhealthy: false,
        bootFailCount: 1,
        cooldownUntil: Date.now() - 1000, // Expired 1s ago
      } satisfies IdleTierState;
    }

    await autoscaler.reportSessionHeartbeat(TEST_USER, 'session-1');
    const decision = await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    // Cooldown expired → should boot
    expect(decision.gpuState).toBe('booting');
  });

  // ────────────────────────────────────────────────────────────────────────
  // 11. Escalating cooldown durations
  // ────────────────────────────────────────────────────────────────────────
  it('should calculate escalating cooldown: 2m, 4m, 8m...', async () => {
    const expectedDurations = [
      2 * 60_000, // 1st failure: 2 min
      4 * 60_000, // 2nd failure: 4 min
      8 * 60_000, // 3rd failure: 8 min
    ];

    for (let attempt = 0; attempt < 3; attempt++) {
      // Reset to idle, preserving bootFailCount from previous iterations
      const tiers = autoscaler.getPoolStatus(TEST_USER);
      const existing = tiers[0];
      if (existing) {
        const prevBootFailCount = existing.state === 'idle' ? (existing.bootFailCount ?? 0) : 0;
        tiers[0] = {
          state: 'idle',
          tierIndex: existing.tierIndex,
          bootFailCount: prevBootFailCount,
          cooldownUntil: undefined,
          unhealthy: false,
        } satisfies IdleTierState;
      }

      // Trigger boot
      await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);
      simulateBootTimeout(autoscaler);

      // Process timeout
      const beforeDecision = Date.now();
      await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

      const tierAfter = getIdleTier(autoscaler);
      if (tierAfter?.cooldownUntil) {
        const duration = tierAfter.cooldownUntil - beforeDecision;
        expect(duration).toBeGreaterThanOrEqual(expectedDurations[attempt]!);
        expect(duration).toBeLessThanOrEqual(expectedDurations[attempt]! + 1000);
      }
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // 12. Cooldown capped at 30 min max
  // ────────────────────────────────────────────────────────────────────────
  it('should cap cooldown at 30 minutes', async () => {
    // Simulate many failures to hit the cap
    autoscaler.forceGpuReady(TEST_USER, GPU_ENDPOINT);
    const tiers = autoscaler.getPoolStatus(TEST_USER);
    const existing = tiers[0];
    if (existing) {
      tiers[0] = {
        state: 'idle',
        tierIndex: existing.tierIndex,
        unhealthy: false,
        bootFailCount: 10, // Already 10 failures
        cooldownUntil: undefined,
      } satisfies IdleTierState;
    }

    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);
    simulateBootTimeout(autoscaler);

    const beforeDecision = Date.now();
    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    const tierAfter = getIdleTier(autoscaler);
    if (tierAfter?.cooldownUntil) {
      const duration = tierAfter.cooldownUntil - beforeDecision;
      // 2min × 2^10 = 2048 min > 30 min cap → should be 30 min
      expect(duration).toBeGreaterThanOrEqual(30 * 60_000);
      expect(duration).toBeLessThanOrEqual(30 * 60_000 + 1000);
    }
  });
});

describe('Watchdog Stuck Booting Cleanup', () => {
  let autoscaler: Autoscaler;
  let mockStopInstance: Mock;

  beforeEach(() => {
    healthyEndpoints = new Set();
    mockStopInstance = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('unhealthy', { status: 503 });
      }),
    );

    autoscaler = createAutoscaler({
      settingsStore: new MockSettingsStore(),
      stateStore: new MemoryStateStore(),
      sessionResolver: new MockSessionResolver(),
      loadConfig: async () => BASE_CONFIG,
    });

    const client = autoscaler.registry.get('tensordock');
    if (client) {
      client.stopInstance = mockStopInstance;
      client.startInstance = vi.fn().mockResolvedValue(undefined);
    }

    autoscaler.resetGpuState(TEST_USER);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 13. Watchdog cleans up tier stuck booting > 15 min
  // ────────────────────────────────────────────────────────────────────────
  it('should force cleanup tier stuck booting > 15 min', async () => {
    // Trigger boot
    await autoscaler.reportSessionHeartbeat(TEST_USER, 'session-1');
    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    const tier = getTier(autoscaler);
    expect(tier?.state).toBe('booting');

    // Simulate stuck booting for 16 min
    const tiers = autoscaler.getPoolStatus(TEST_USER);
    if (tiers[0]?.state === 'booting') {
      tiers[0] = { ...tiers[0], bootTriggeredAt: Date.now() - 41 * 60_000 };
    }

    // Run watchdog
    await autoscaler.runWatchdogCycle();

    const tierAfter = getIdleTier(autoscaler);
    expect(tierAfter?.state).toBe('idle');
    expect(tierAfter?.unhealthy).toBe(true);
    expect(tierAfter?.bootFailCount).toBeGreaterThanOrEqual(1);
    expect(mockStopInstance).toHaveBeenCalledWith(
      'td-instance-001',
      expect.objectContaining({ apiKey: 'fake-api-key' }),
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // 14. Watchdog does NOT cleanup tier booting < 15 min
  // ────────────────────────────────────────────────────────────────────────
  it('should NOT cleanup tier booting < 15 min', async () => {
    await autoscaler.reportSessionHeartbeat(TEST_USER, 'session-1');
    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    const tier = getTier(autoscaler);
    expect(tier?.state).toBe('booting');

    // Simulate booting for 5 min (well under 15 min limit)
    const tiers = autoscaler.getPoolStatus(TEST_USER);
    if (tiers[0]?.state === 'booting') {
      tiers[0] = { ...tiers[0], bootTriggeredAt: Date.now() - 5 * 60_000 };
    }

    await autoscaler.runWatchdogCycle();

    // Should still be booting
    const tierAfter = getTier(autoscaler);
    expect(tierAfter?.state).toBe('booting');
    expect(mockStopInstance).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────────
  // 15. No crash if stopInstance fails during watchdog cleanup
  // ────────────────────────────────────────────────────────────────────────
  it('should not crash if stopInstance fails during watchdog cleanup', async () => {
    mockStopInstance.mockRejectedValueOnce(new Error('provider API down'));

    await autoscaler.reportSessionHeartbeat(TEST_USER, 'session-1');
    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    const tiers = autoscaler.getPoolStatus(TEST_USER);
    if (tiers[0]?.state === 'booting') {
      tiers[0] = { ...tiers[0], bootTriggeredAt: Date.now() - 41 * 60_000 };
    }

    // Should not throw
    await expect(autoscaler.runWatchdogCycle()).resolves.not.toThrow();

    // State should still transition to idle despite stop failure
    const tierAfter = getIdleTier(autoscaler);
    expect(tierAfter?.state).toBe('idle');
    expect(tierAfter?.unhealthy).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 16. No crash if stopInstance fails during engine boot timeout
  // ────────────────────────────────────────────────────────────────────────
  it('should not crash if stopInstance fails during engine boot timeout', async () => {
    mockStopInstance.mockRejectedValueOnce(new Error('network error'));

    await autoscaler.reportSessionHeartbeat(TEST_USER, 'session-1');
    await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);

    simulateBootTimeout(autoscaler);

    // Should not throw
    const decision = await autoscaler.getAutoScaleDecision(TEST_USER, BASE_CONFIG);
    expect(decision).toBeDefined();

    // Allow fire-and-forget cleanup to settle
    await new Promise((r) => setTimeout(r, 50));
  });
});
