import { describe, it, expect } from 'vitest';
import { handleBootTimeout } from '@ai-gateway/autoscaler/boot-timeout';
import { MAX_BOOT_FAILURES, BOOT_COOLDOWN_BASE_MS, BOOT_COOLDOWN_MAX_MS } from '@ai-gateway/autoscaler/engine';
import type { BootingTierState, GpuTierConfig } from '@ai-gateway';

const baseTierConfig: GpuTierConfig = {
  provider: 'runpod',
  instanceId: 'pod-123',
  apiKey: 'key-abc',
  endpoint: 'http://gpu:8000',
};

const baseBooting: BootingTierState = {
  state: 'booting',
  tierIndex: 0,
  endpoint: 'http://gpu:8000',
  bootTriggeredAt: 1000,
  trigger: 'sessions',
  prevBootFailCount: 0,
  discoveredInstanceId: 'disc-456',
};

describe('handleBootTimeout', () => {
  it('returns idle state with correct failCount and cooldown', () => {
    const now = 200_000;
    const result = handleBootTimeout(0, baseBooting, baseTierConfig, 120_000, now, 'engine');
    expect(result.newState.state).toBe('idle');
    expect(result.newState.tierIndex).toBe(0);
    expect(result.newState.bootFailCount).toBe(1);
    // failCount=1 → cooldown = BASE * 2^0 = BASE
    expect(result.newState.cooldownUntil).toBe(now + BOOT_COOLDOWN_BASE_MS);
  });

  it('exponential backoff: failCount 2 → 4min cooldown', () => {
    const booting = { ...baseBooting, prevBootFailCount: 1 };
    const result = handleBootTimeout(0, booting, baseTierConfig, 120_000, 300_000, 'engine');
    expect(result.newState.bootFailCount).toBe(2);
    // failCount=2 → BASE * 2^1 = 2*BASE
    expect(result.newState.cooldownUntil).toBe(300_000 + BOOT_COOLDOWN_BASE_MS * 2);
  });

  it('cooldown is capped at BOOT_COOLDOWN_MAX_MS', () => {
    const booting = { ...baseBooting, prevBootFailCount: 99 };
    const result = handleBootTimeout(0, booting, baseTierConfig, 120_000, 500_000, 'engine');
    expect(result.newState.cooldownUntil).toBe(500_000 + BOOT_COOLDOWN_MAX_MS);
  });

  it('clamps exponent to prevent overflow (failCount=50)', () => {
    const booting = { ...baseBooting, prevBootFailCount: 49 };
    const result = handleBootTimeout(0, booting, baseTierConfig, 120_000, 500_000, 'engine');
    const cooldown = result.newState.cooldownUntil! - 500_000;
    expect(cooldown).toBeLessThanOrEqual(BOOT_COOLDOWN_MAX_MS);
    expect(Number.isFinite(cooldown)).toBe(true);
  });

  it('sets unhealthy flag at MAX_BOOT_FAILURES', () => {
    const booting = { ...baseBooting, prevBootFailCount: MAX_BOOT_FAILURES - 1 };
    const result = handleBootTimeout(0, booting, baseTierConfig, 120_000, 500_000, 'engine');
    expect(result.newState.unhealthy).toBe(true);
  });

  it('does not set unhealthy below MAX_BOOT_FAILURES', () => {
    const result = handleBootTimeout(0, baseBooting, baseTierConfig, 120_000, 500_000, 'engine');
    expect(result.newState.unhealthy).toBeUndefined();
  });

  it('log entry contains durationMs, error message, and metadata', () => {
    const now = 61_000;
    const result = handleBootTimeout(0, baseBooting, baseTierConfig, 60_000, now, 'watchdog');
    expect(result.logEntry.durationMs).toBe(now - baseBooting.bootTriggeredAt);
    expect(result.logEntry.error).toContain('watchdog');
    expect(result.logEntry.error).toContain('timeout');
    expect(result.logEntry.metadata).toMatchObject({ failCount: 1, source: 'watchdog' });
    expect(result.logEntry.eventType).toBe('boot_timeout');
    expect(result.logEntry.oldState).toBe('booting');
    expect(result.logEntry.newState).toBe('idle');
  });

  it('cleanupConfig uses discoveredInstanceId when present', () => {
    const result = handleBootTimeout(0, baseBooting, baseTierConfig, 60_000, 200_000, 'engine');
    expect(result.cleanupConfig?.instanceId).toBe('disc-456');
  });

  it('cleanupConfig uses tierConfig.instanceId when no discoveredInstanceId', () => {
    const booting = { ...baseBooting, discoveredInstanceId: undefined };
    const result = handleBootTimeout(0, booting, baseTierConfig, 60_000, 200_000, 'engine');
    expect(result.cleanupConfig?.instanceId).toBe('pod-123');
  });

  it('cleanupConfig is undefined when tierConfig is undefined', () => {
    const result = handleBootTimeout(0, baseBooting, undefined, 60_000, 200_000, 'engine');
    expect(result.cleanupConfig).toBeUndefined();
  });
});
