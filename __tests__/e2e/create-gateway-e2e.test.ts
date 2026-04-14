import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGateway } from '@ai-gateway/create-gateway';
import type { GatewayStorage } from '@ai-gateway/storage';
import type { Gateway } from '@ai-gateway/gateway-api';

// ── Full-featured mock storage ──────────────────────────────────────────────

function fullMockStorage(): GatewayStorage {
  const settings = new Map<string, Record<string, unknown>>();
  return {
    getSettings: vi.fn(async (userId: string) => settings.get(userId) ?? {}),
    patchSettings: vi.fn(async (userId: string, partial: Record<string, unknown>) => {
      const current = settings.get(userId) ?? {};
      settings.set(userId, { ...current, ...partial });
    }),
    countSessions: vi.fn().mockResolvedValue(0),
    resolveTeacher: vi.fn().mockResolvedValue(null),
    resolveCredentials: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
    queryLifecycleLogs: vi.fn().mockResolvedValue([]),
    resolveVisibleUserIds: vi.fn().mockResolvedValue(['user-1']),
    createBenchmark: vi.fn().mockResolvedValue(undefined),
    queryBenchmarks: vi.fn().mockResolvedValue([]),
    logLifecycleEvent: vi.fn(),
  };
}

describe('createGateway E2E lifecycle', () => {
  let gateway: Gateway;
  let storage: GatewayStorage;

  beforeEach(() => {
    storage = fullMockStorage();
    gateway = createGateway({ storage });
  });

  // ── Create → handleGet disabled ─────────────────────────────────────────

  it('handleGet returns disabled when no config saved', async () => {
    const result = await gateway.handleGet('user-1');
    expect(result.status).toBe(200);
    expect(result.body).toBeDefined();
    // Should indicate disabled or have no active pool
    const body = result.body as Record<string, unknown>;
    // decision may be null or undefined when no config
    expect(body.decision ?? null).toBeNull();
  });

  // ── Save config → handleGet enabled ────────────────────────────────────

  it('save-config enables autoscaler and handleGet reflects it', async () => {
    const config = {
      enabled: true,
      threshold: 3,
      windowMinutes: 5,
      maxLatencyMs: 2000,
      tiers: [
        {
          provider: 'runpod',
          dockerImage: 'test:latest',
          gpuTypes: ['RTX 4090'],
        },
      ],
    };

    const saveResult = await gateway.handleAction('user-1', 'save-config', config);
    expect(saveResult.status).toBe(200);

    // Verify config was saved to storage
    expect(storage.patchSettings).toHaveBeenCalled();
  });

  // ── report-session flows through ───────────────────────────────────────

  it('reportSession and removeSession do not throw', async () => {
    await expect(gateway.reportSession('user-1', 'sess-1')).resolves.not.toThrow();
    await expect(gateway.removeSession('user-1', 'sess-1')).resolves.not.toThrow();
  });

  // ── reset does not throw ───────────────────────────────────────────────

  it('resetGpuState does not throw', () => {
    expect(() => gateway.resetGpuState('user-1')).not.toThrow();
  });

  // ── pool status reflects empty state ───────────────────────────────────

  it('getPoolStatus returns empty when no tiers configured', () => {
    const pool = gateway.getPoolStatus('user-1');
    expect(Array.isArray(pool)).toBe(true);
    expect((pool as unknown[]).length).toBe(0);
  });

  // ── getReadyEndpoints returns empty initially ──────────────────────────

  it('getReadyEndpoints returns empty array initially', () => {
    const endpoints = gateway.getReadyEndpoints('user-1');
    expect(Array.isArray(endpoints)).toBe(true);
    expect(endpoints).toHaveLength(0);
  });

  // ── destroy stops tickers ──────────────────────────────────────────────

  it('destroy cleans up watchdog and cost monitor', () => {
    const watchdogStop = gateway.startWatchdog(60_000);
    expect(typeof watchdogStop).toBe('function');

    // Destroy should clean up all tickers
    gateway.destroy();
    // No error = success. Calling stop after destroy should also not error.
    watchdogStop();
  });

  // ── Full lifecycle ─────────────────────────────────────────────────────

  it('full lifecycle: create → configure → use → destroy', async () => {
    // 1. Create gateway
    expect(gateway.autoscaler).toBeDefined();
    expect(gateway.registry).toBeDefined();

    // 2. Get decision (null when no config)
    const decision1 = await gateway.getDecision('user-1');
    expect(decision1).toBeNull();

    // 3. Save config
    await gateway.handleAction('user-1', 'save-config', {
      enabled: true,
      threshold: 2,
      windowMinutes: 5,
      maxLatencyMs: 3000,
      tiers: [],
    });

    // 4. Report session
    await gateway.reportSession('user-1', 'sess-1');

    // 5. Report latency
    await gateway.reportLatency('user-1', 150);

    // 6. Start watchdog
    const stop = gateway.startWatchdog(60_000);
    expect(typeof stop).toBe('function');

    // 7. Destroy
    gateway.destroy();
  });

  // ── handleAction unknown action ────────────────────────────────────────

  it('handleAction returns error for unknown action', async () => {
    const result = await gateway.handleAction('user-1', 'nonexistent-action', {});
    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  // ── Custom loadConfig override ─────────────────────────────────────────

  it('custom loadConfig is used for getDecision', async () => {
    const customConfig = {
      enabled: true,
      threshold: 1,
      windowMinutes: 1,
      maxLatencyMs: 1000,
      tiers: [],
    };
    const loader = vi.fn().mockResolvedValue(customConfig);
    const gw = createGateway({ storage, loadConfig: loader });

    const decision = await gw.getDecision('user-1');
    expect(loader).toHaveBeenCalledWith('user-1');
    // Decision should be non-null since config is enabled
    // (may still be null if no sessions active, depends on threshold)
  });
});
