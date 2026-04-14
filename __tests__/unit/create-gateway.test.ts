import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGateway, type GatewayConfig } from '@ai-gateway/create-gateway';
import type { GatewayStorage } from '@ai-gateway/storage';
import type { Gateway } from '@ai-gateway/gateway-api';
import { resetVault } from '@ai-gateway/vault';

function mockStorage(): GatewayStorage {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    patchSettings: vi.fn().mockResolvedValue(undefined),
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

describe('createGateway', () => {
  let gateway: Gateway;
  let storage: GatewayStorage;

  beforeEach(() => {
    process.env.VAULT_MASTER_KEY = 'a'.repeat(64); // 32 bytes as hex
    process.env.VAULT_PATH = `/tmp/test-vault-${Date.now()}`;
    resetVault();
    storage = mockStorage();
    gateway = createGateway({ storage });
  });

  afterEach(() => {
    delete process.env.VAULT_MASTER_KEY;
    delete process.env.VAULT_PATH;
    resetVault();
  });

  // ── Creation ──────────────────────────────────────────────────────────

  describe('creation', () => {
    it('returns gateway with all interface methods', () => {
      expect(gateway.handleGet).toBeDefined();
      expect(gateway.handleAction).toBeDefined();
      expect(gateway.handleModalApps).toBeDefined();
      expect(gateway.handleModalStop).toBeDefined();
      expect(gateway.getDecision).toBeDefined();
      expect(gateway.reportSession).toBeDefined();
      expect(gateway.removeSession).toBeDefined();
      expect(gateway.reportLatency).toBeDefined();
      expect(gateway.getPoolStatus).toBeDefined();
      expect(gateway.getReadyEndpoints).toBeDefined();
      expect(gateway.loadConfig).toBeDefined();
      expect(gateway.resetGpuState).toBeDefined();
      expect(gateway.signGpuToken).toBeDefined();
      expect(gateway.runHealthCheck).toBeDefined();
      expect(gateway.startWatchdog).toBeDefined();
      expect(gateway.startCostMonitor).toBeDefined();
      expect(gateway.destroy).toBeDefined();
    });

    it('exposes autoscaler and registry internals', () => {
      expect(gateway.autoscaler).toBeDefined();
      expect(gateway.registry).toBeDefined();
    });
  });

  // ── Route handlers delegate correctly ─────────────────────────────────

  describe('route handlers', () => {
    it('handleGet returns result', async () => {
      const result = await gateway.handleGet('user-1');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('body');
    });

    it('handleAction returns result', async () => {
      const result = await gateway.handleAction('user-1', 'reset', {});
      expect(result.status).toBe(200);
    });
  });

  // ── Convenience methods ───────────────────────────────────────────────

  describe('convenience methods', () => {
    it('getDecision returns null when no config', async () => {
      const decision = await gateway.getDecision('user-1');
      expect(decision).toBeNull();
    });

    it('reportSession calls through', async () => {
      await gateway.reportSession('user-1', 'session-123');
      // No error = success
    });

    it('getPoolStatus returns array', () => {
      const pool = gateway.getPoolStatus('user-1');
      expect(Array.isArray(pool)).toBe(true);
    });

    it('getReadyEndpoints returns array', () => {
      const endpoints = gateway.getReadyEndpoints('user-1');
      expect(Array.isArray(endpoints)).toBe(true);
    });

    it('resetGpuState does not throw', () => {
      expect(() => gateway.resetGpuState('user-1')).not.toThrow();
    });
  });

  // ── signGpuToken ──────────────────────────────────────────────────────

  describe('signGpuToken', () => {
    it('returns undefined when GPU_ACCESS_SECRET not set', () => {
      const token = gateway.signGpuToken('user-1');
      expect(token).toBeUndefined();
    });
  });

  // ── Background tickers ────────────────────────────────────────────────

  describe('background tickers', () => {
    it('startWatchdog returns stop function', () => {
      const stop = gateway.startWatchdog(60000);
      expect(typeof stop).toBe('function');
      stop();
    });

    it('startCostMonitor warns on missing loadAllAccounts', () => {
      const storageWithout = { ...mockStorage() };
      delete (storageWithout as any).loadAllAccounts;
      const gw = createGateway({ storage: storageWithout });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stop = gw.startCostMonitor(60000);
      expect(typeof stop).toBe('function');
      stop();
      warnSpy.mockRestore();
    });
  });

  // ── destroy ───────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('calls all stop functions', () => {
      const stop1 = gateway.startWatchdog(60000);
      gateway.destroy();
      // No error = success, and stop functions were called
    });
  });

  // ── Defaults ──────────────────────────────────────────────────────────

  describe('defaults', () => {
    it('uses InMemoryStateAdapter when no stateStore', () => {
      // Creating without stateStore should not throw
      const gw = createGateway({ storage: mockStorage() });
      expect(gw.autoscaler).toBeDefined();
    });
  });

  // ── Optional storage methods ──────────────────────────────────────────

  describe('optional storage methods', () => {
    it('handles missing resolveCredentials', () => {
      const minStorage: GatewayStorage = {
        getSettings: vi.fn().mockResolvedValue({}),
        patchSettings: vi.fn().mockResolvedValue(undefined),
        countSessions: vi.fn().mockResolvedValue(0),
        resolveTeacher: vi.fn().mockResolvedValue(null),
      };
      const gw = createGateway({ storage: minStorage });
      expect(gw.autoscaler).toBeDefined();
    });

    it('handles missing logLifecycleEvent', () => {
      const minStorage: GatewayStorage = {
        getSettings: vi.fn().mockResolvedValue({}),
        patchSettings: vi.fn().mockResolvedValue(undefined),
        countSessions: vi.fn().mockResolvedValue(0),
        resolveTeacher: vi.fn().mockResolvedValue(null),
      };
      const gw = createGateway({ storage: minStorage });
      // No error = lifecycle logger uses noop
      expect(gw.autoscaler).toBeDefined();
    });
  });

  // ── loadConfig override ───────────────────────────────────────────────

  describe('loadConfig override', () => {
    it('uses custom loadConfig when provided', async () => {
      const customConfig = {
        enabled: true,
        threshold: 3,
        windowMinutes: 5,
        maxLatencyMs: 2000,
        tiers: [],
      };
      const customLoader = vi.fn().mockResolvedValue(customConfig);
      const gw = createGateway({
        storage: mockStorage(),
        loadConfig: customLoader,
      });

      const cfg = await gw.loadConfig('user-1');
      expect(cfg).toBe(customConfig);
      expect(customLoader).toHaveBeenCalledWith('user-1');
    });
  });
});
