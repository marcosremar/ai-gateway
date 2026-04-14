import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderMonitor } from '../../src/autoscaler/provider-monitor';
import type { GpuProviderRegistry } from '../../src/gpu-providers/registry';
import type { Logger } from '../../src/deps';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRegistry(overrides: Record<string, unknown> = {}): GpuProviderRegistry {
  const mockClient = {
    providerId: 'vast',
    bootTimeSecs: 120,
    listOffers: vi.fn(async () => []),
    ...overrides,
  };
  return {
    get: vi.fn((id: string) => id === 'vast' ? mockClient : null),
    register: vi.fn(),
    getAll: vi.fn(() => [mockClient]),
    _client: mockClient,
  } as unknown as GpuProviderRegistry;
}

function makeLogger(): Logger {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  } as unknown as Logger;
}

function makeMonitor(overrides: {
  registryGet?: (id: string) => unknown;
  resolveCredentials?: (p: string) => Promise<{ apiKey: string } | null>;
} = {}): ProviderMonitor {
  const registry = {
    get: vi.fn(overrides.registryGet ?? (() => null)),
    register: vi.fn(),
    getAll: vi.fn(() => []),
  } as unknown as GpuProviderRegistry;

  return new ProviderMonitor({
    registry,
    logger: makeLogger(),
    resolveCredentials: overrides.resolveCredentials,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ProviderMonitor', () => {
  describe('getPriceUpdateIntervalMs', () => {
    it('returns 5 minutes', () => {
      const monitor = makeMonitor();
      expect(monitor.getPriceUpdateIntervalMs()).toBe(5 * 60 * 1000);
    });
  });

  describe('getPriceInfo', () => {
    it('returns undefined when no price cached', () => {
      const monitor = makeMonitor();
      expect(monitor.getPriceInfo('vast')).toBeUndefined();
    });

    it('returns price info after cache update', async () => {
      const offers = [
        { pricePerHr: 0.30, reliability: 0.9 },
        { pricePerHr: 0.50, reliability: 0.8 },
      ];
      const client = { listOffers: vi.fn(async () => offers) };
      const registry = {
        get: vi.fn((id: string) => id === 'vast' ? client : null),
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({
        registry,
        logger: makeLogger(),
        resolveCredentials: async (p) => p === 'vast' ? { apiKey: 'test-key' } : null,
      });

      await monitor.updatePriceCacheIfNeeded();

      const info = monitor.getPriceInfo('vast');
      expect(info).toBeDefined();
      expect(info!.price).toBe(0.30); // cheapest
      expect(info!.timestamp).toBeGreaterThan(0);
    });
  });

  describe('getProviderPrice', () => {
    it('returns null when no price cached', () => {
      const monitor = makeMonitor();
      expect(monitor.getProviderPrice('runpod')).toBeNull();
    });
  });

  describe('getReliabilityScore / getProviderReliability', () => {
    it('defaults to 0.5 with no history', () => {
      const monitor = makeMonitor();
      expect(monitor.getReliabilityScore('vast')).toBe(0.5);
      expect(monitor.getProviderReliability('vast')).toBe(0.5);
    });

    it('getReliabilityScore and getProviderReliability return same value', () => {
      const monitor = makeMonitor();
      monitor.recordHealthEvent('runpod', true);
      expect(monitor.getReliabilityScore('runpod')).toBe(monitor.getProviderReliability('runpod'));
    });
  });

  describe('recordHealthEvent', () => {
    it('increases reliability after success', () => {
      const monitor = makeMonitor();
      const before = monitor.getReliabilityScore('vast');
      monitor.recordHealthEvent('vast', true);
      expect(monitor.getReliabilityScore('vast')).toBeGreaterThan(before);
    });

    it('decreases reliability after many consecutive failures', () => {
      const monitor = makeMonitor();
      // Many successes first to push score high
      for (let i = 0; i < 20; i++) monitor.recordHealthEvent('vast', true);
      const afterManySuccesses = monitor.getReliabilityScore('vast');
      // Now many failures — cumulative rawReliability drops toward 0.5, pulling score down
      for (let i = 0; i < 50; i++) monitor.recordHealthEvent('vast', false);
      expect(monitor.getReliabilityScore('vast')).toBeLessThan(afterManySuccesses);
    });

    it('keeps score in [0, 1] range', () => {
      const monitor = makeMonitor();
      // Many failures
      for (let i = 0; i < 50; i++) monitor.recordHealthEvent('vast', false);
      expect(monitor.getReliabilityScore('vast')).toBeGreaterThanOrEqual(0);
      expect(monitor.getReliabilityScore('vast')).toBeLessThanOrEqual(1);
      // Many successes
      for (let i = 0; i < 50; i++) monitor.recordHealthEvent('vast', true);
      expect(monitor.getReliabilityScore('vast')).toBeGreaterThanOrEqual(0);
      expect(monitor.getReliabilityScore('vast')).toBeLessThanOrEqual(1);
    });

    it('uses exponential moving average (90% old, 10% new)', () => {
      const monitor = makeMonitor();
      // First event: starts at 0.5 default
      monitor.recordHealthEvent('vast', true);
      // Expected: 0.5 * 0.9 + 1.0 * 0.1 = 0.55
      expect(monitor.getReliabilityScore('vast')).toBeCloseTo(0.55, 5);
    });

    it('tracks different providers independently', () => {
      const monitor = makeMonitor();
      monitor.recordHealthEvent('vast', true);
      monitor.recordHealthEvent('runpod', false);
      expect(monitor.getReliabilityScore('vast')).toBeGreaterThan(0.5);
      expect(monitor.getReliabilityScore('runpod')).toBeLessThan(0.5);
    });
  });

  describe('updatePriceCacheIfNeeded', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('is no-op when cache is fresh', async () => {
      const client = { listOffers: vi.fn(async () => [{ pricePerHr: 0.35, reliability: 0.9 }]) };
      const registry = {
        get: vi.fn(() => client),
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({
        registry,
        logger: makeLogger(),
        resolveCredentials: async () => ({ apiKey: 'key' }),
      });

      await monitor.updatePriceCacheIfNeeded(); // first update
      const callCount = client.listOffers.mock.calls.length;

      await monitor.updatePriceCacheIfNeeded(); // should be no-op
      expect(client.listOffers.mock.calls.length).toBe(callCount);
    });

    it('updates after interval passes', async () => {
      const client = { listOffers: vi.fn(async () => [{ pricePerHr: 0.35 }]) };
      const registry = {
        get: vi.fn(() => client),
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({
        registry,
        logger: makeLogger(),
        resolveCredentials: async () => ({ apiKey: 'key' }),
      });

      await monitor.updatePriceCacheIfNeeded();
      const after1 = client.listOffers.mock.calls.length;

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await monitor.updatePriceCacheIfNeeded();
      expect(client.listOffers.mock.calls.length).toBeGreaterThan(after1);
    });

    it('falls back to hardcoded price when no credentials', async () => {
      const client = { listOffers: vi.fn(async () => []) };
      const registry = {
        get: vi.fn(() => client),
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({
        registry,
        logger: makeLogger(),
        resolveCredentials: async () => null, // no creds
      });

      await monitor.updatePriceCacheIfNeeded();

      // Fallback price for 'vast' is 0.35
      const info = monitor.getPriceInfo('vast');
      expect(info).toBeDefined();
      expect(info!.price).toBe(0.35);
    });

    it('falls back to hardcoded price when listOffers throws', async () => {
      const client = { listOffers: vi.fn(async () => { throw new Error('API down'); }) };
      const registry = {
        get: vi.fn(() => client),
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({
        registry,
        logger: makeLogger(),
        resolveCredentials: async () => ({ apiKey: 'key' }),
      });

      await expect(monitor.updatePriceCacheIfNeeded()).resolves.not.toThrow();

      // Should have fallback price for known providers
      const info = monitor.getPriceInfo('vast');
      expect(info).toBeDefined();
    });

    it('falls back when listOffers returns empty array', async () => {
      const client = { listOffers: vi.fn(async () => []) };
      const registry = {
        get: vi.fn(() => client),
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({
        registry,
        logger: makeLogger(),
        resolveCredentials: async () => ({ apiKey: 'key' }),
      });

      await monitor.updatePriceCacheIfNeeded();

      const info = monitor.getPriceInfo('vast');
      expect(info).toBeDefined();
      expect(info!.price).toBe(0.35); // fallback
    });

    it('selects cheapest offer', async () => {
      const offers = [
        { pricePerHr: 0.80 },
        { pricePerHr: 0.20 },
        { pricePerHr: 0.50 },
      ];
      const client = { listOffers: vi.fn(async () => offers) };
      const registry = {
        get: vi.fn(() => client),
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({
        registry,
        logger: makeLogger(),
        resolveCredentials: async () => ({ apiKey: 'key' }),
      });

      await monitor.updatePriceCacheIfNeeded();

      // Should use cheapest
      expect(monitor.getProviderPrice('vast')).toBe(0.20);
    });

    it('updates reliability from offer data', async () => {
      const offers = [
        { pricePerHr: 0.30, reliability: 0.95 },
        { pricePerHr: 0.50, reliability: 0.85 },
      ];
      const client = { listOffers: vi.fn(async () => offers) };
      const registry = {
        get: vi.fn(() => client),
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({
        registry,
        logger: makeLogger(),
        resolveCredentials: async () => ({ apiKey: 'key' }),
      });

      await monitor.updatePriceCacheIfNeeded();

      // avg reliability = (0.95 + 0.85) / 2 = 0.90
      // new score = 0.5 * 0.3 + 0.90 * 0.7 = 0.15 + 0.63 = 0.78
      expect(monitor.getReliabilityScore('vast')).toBeCloseTo(0.78, 2);
    });

    it('uses env var fallback when resolveCredentials not provided', async () => {
      process.env.VAST_API_KEY = 'env-vast-key';
      const offers = [{ pricePerHr: 0.25 }];
      const client = { listOffers: vi.fn(async () => offers) };
      const registry = {
        get: vi.fn(() => client),
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({ registry, logger: makeLogger() });

      await monitor.updatePriceCacheIfNeeded();
      expect(monitor.getProviderPrice('vast')).toBe(0.25);

      delete process.env.VAST_API_KEY;
    });

    it('skips provider when no listOffers method', async () => {
      const clientWithoutListOffers = { discoverInstance: vi.fn() };
      const registry = {
        get: vi.fn(() => clientWithoutListOffers),
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({ registry, logger: makeLogger() });

      await expect(monitor.updatePriceCacheIfNeeded()).resolves.not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('handles unknown provider gracefully', () => {
      const monitor = makeMonitor();
      expect(monitor.getReliabilityScore('unknown-provider')).toBe(0.5);
      expect(monitor.getProviderPrice('unknown-provider')).toBeNull();
      expect(monitor.getPriceInfo('unknown-provider')).toBeUndefined();
    });

    it('accumulates health events accurately', () => {
      const monitor = makeMonitor();
      // 10 successes
      for (let i = 0; i < 10; i++) monitor.recordHealthEvent('vast', true);
      const scoreAfterSuccesses = monitor.getReliabilityScore('vast');

      // 10 failures on same provider
      for (let i = 0; i < 10; i++) monitor.recordHealthEvent('vast', false);
      const scoreAfterFailures = monitor.getReliabilityScore('vast');

      expect(scoreAfterSuccesses).toBeGreaterThan(0.5);
      expect(scoreAfterFailures).toBeLessThan(scoreAfterSuccesses);
    });

    it('fallback prices cover all known providers when credentials unavailable', async () => {
      // Provide clients with listOffers, but resolveCredentials returns null
      const client = { listOffers: vi.fn(async () => []) };
      const registry = {
        get: vi.fn(() => client), // all providers get a client
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const monitor = new ProviderMonitor({
        registry,
        logger: makeLogger(),
        resolveCredentials: async () => null, // no creds → fallback
      });

      await monitor.updatePriceCacheIfNeeded();

      // vast, runpod, tensordock, modal should all get fallback prices
      const expectedFallbacks: Record<string, number> = {
        vast: 0.35, runpod: 0.45, tensordock: 0.60, modal: 1.20,
      };
      for (const [provider, expected] of Object.entries(expectedFallbacks)) {
        expect(monitor.getProviderPrice(provider)).toBe(expected);
      }
    });
  });
});
