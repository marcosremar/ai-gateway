import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TierSelector } from '../src/autoscaler/tier-selector';
import type { GpuTierConfig, GpuTierState, IdleTierState } from '../src/types';
import type { GpuProviderRegistry } from '../src/gpu-providers/registry';
import type { Logger } from '../src/deps';
import type { ProviderMonitor } from '../src/autoscaler/provider-monitor';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeRegistry(bootTimeSecs = 120): GpuProviderRegistry {
  return {
    get: vi.fn(() => ({ bootTimeSecs })),
    register: vi.fn(),
    getAll: vi.fn(() => []),
  } as unknown as GpuProviderRegistry;
}

function makeMonitor(overrides: {
  getPriceInfo?: (p: string) => { price: number; timestamp: number } | undefined;
  getReliabilityScore?: (p: string) => number;
  getPriceUpdateIntervalMs?: () => number;
  updatePriceCacheIfNeeded?: () => Promise<void>;
} = {}): ProviderMonitor {
  return {
    getPriceInfo: vi.fn(overrides.getPriceInfo ?? (() => undefined)),
    getReliabilityScore: vi.fn(overrides.getReliabilityScore ?? (() => 0.5)),
    getProviderReliability: vi.fn(() => 0.5),
    getProviderPrice: vi.fn(() => null),
    getPriceUpdateIntervalMs: vi.fn(overrides.getPriceUpdateIntervalMs ?? (() => 5 * 60 * 1000)),
    updatePriceCacheIfNeeded: vi.fn(overrides.updatePriceCacheIfNeeded ?? (async () => {})),
    recordHealthEvent: vi.fn(),
  } as unknown as ProviderMonitor;
}

function makeIdleTier(
  provider: string,
  overrides: Partial<GpuTierConfig> = {},
): GpuTierConfig {
  return {
    provider,
    apiKey: 'test-key',
    gpuTypes: ['NVIDIA GeForce RTX 4090'],
    dockerImage: 'test/image:latest',
    storageGb: 0,
    ...overrides,
  };
}

function idleState(tierIndex = 0, overrides: Partial<IdleTierState> = {}): GpuTierState {
  return { state: 'idle', tierIndex, ...overrides } as GpuTierState;
}

function bootingState(tierIndex = 0): GpuTierState {
  return {
    state: 'booting',
    tierIndex,
    endpoint: '',
    bootTriggeredAt: Date.now(),
    trigger: 'sessions',
    prevBootFailCount: 0,
  } as GpuTierState;
}

function readyState(tierIndex = 0): GpuTierState {
  return {
    state: 'ready',
    tierIndex,
    endpoint: 'http://1.2.3.4:8000',
    lastHealthyAt: Date.now(),
  } as GpuTierState;
}

const SELECTOR_OPTS = (registry?: GpuProviderRegistry) => ({
  registry: registry ?? makeRegistry(),
  logger: makeLogger(),
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TierSelector', () => {
  describe('isTierEligibleForBoot', () => {
    it('allows idle tier with no flags', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const tier = makeIdleTier('runpod');
      const state = idleState();
      expect(selector.isTierEligibleForBoot(tier, state)).toBe(true);
    });

    it('blocks manually stopped tier', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const tier = makeIdleTier('runpod');
      const state = idleState(0, { manualStop: true });
      expect(selector.isTierEligibleForBoot(tier, state)).toBe(false);
    });

    it('blocks unhealthy tier', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const tier = makeIdleTier('runpod');
      const state = idleState(0, { unhealthy: true });
      expect(selector.isTierEligibleForBoot(tier, state)).toBe(false);
    });

    it('blocks tier in cooldown', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const tier = makeIdleTier('runpod');
      const state = idleState(0, { cooldownUntil: Date.now() + 60_000 });
      expect(selector.isTierEligibleForBoot(tier, state)).toBe(false);
    });

    it('allows tier whose cooldown has expired', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const tier = makeIdleTier('runpod');
      const state = idleState(0, { cooldownUntil: Date.now() - 1 });
      expect(selector.isTierEligibleForBoot(tier, state)).toBe(true);
    });

    it('blocks booting tier', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const tier = makeIdleTier('runpod');
      expect(selector.isTierEligibleForBoot(tier, bootingState())).toBe(false);
    });

    it('blocks ready tier', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const tier = makeIdleTier('runpod');
      expect(selector.isTierEligibleForBoot(tier, readyState())).toBe(false);
    });
  });

  describe('calculateTierScore', () => {
    it('returns neutral price score (20) when no price data', () => {
      const monitor = makeMonitor({ getPriceInfo: () => undefined });
      const selector = new TierSelector(SELECTOR_OPTS());
      const tier = makeIdleTier('runpod');
      const score = selector.calculateTierScore(tier, idleState(), 'user', monitor);
      // 20 (neutral price) + 0.5 * 30 (reliability) + boot bonus + spot bonus if applicable
      expect(score).toBeGreaterThanOrEqual(20);
    });

    it('gives higher score for cheaper provider', () => {
      const now = Date.now();
      const cheapMonitor = makeMonitor({
        getPriceInfo: () => ({ price: 0.20, timestamp: now }),
        getPriceUpdateIntervalMs: () => 5 * 60 * 1000,
      });
      const expensiveMonitor = makeMonitor({
        getPriceInfo: () => ({ price: 4.00, timestamp: now }),
        getPriceUpdateIntervalMs: () => 5 * 60 * 1000,
      });
      const selector = new TierSelector(SELECTOR_OPTS());
      const tier = makeIdleTier('runpod');

      const cheapScore = selector.calculateTierScore(tier, idleState(), 'user', cheapMonitor);
      const expensiveScore = selector.calculateTierScore(tier, idleState(), 'user', expensiveMonitor);
      expect(cheapScore).toBeGreaterThan(expensiveScore);
    });

    it('gives higher score for more reliable provider', () => {
      const highReliabilityMonitor = makeMonitor({ getReliabilityScore: () => 0.9 });
      const lowReliabilityMonitor = makeMonitor({ getReliabilityScore: () => 0.1 });
      const selector = new TierSelector(SELECTOR_OPTS());
      const tier = makeIdleTier('runpod');

      const highScore = selector.calculateTierScore(tier, idleState(), 'user', highReliabilityMonitor);
      const lowScore = selector.calculateTierScore(tier, idleState(), 'user', lowReliabilityMonitor);
      expect(highScore).toBeGreaterThan(lowScore);
    });

    it('gives higher score for faster boot time', () => {
      const fastRegistry = makeRegistry(60);   // 60s boot
      const slowRegistry = makeRegistry(500);  // 500s boot
      const monitor = makeMonitor();

      const fastSelector = new TierSelector(SELECTOR_OPTS(fastRegistry));
      const slowSelector = new TierSelector(SELECTOR_OPTS(slowRegistry));
      const tier = makeIdleTier('runpod');

      const fastScore = fastSelector.calculateTierScore(tier, idleState(), 'user', monitor);
      const slowScore = slowSelector.calculateTierScore(tier, idleState(), 'user', monitor);
      expect(fastScore).toBeGreaterThan(slowScore);
    });

    it('adds spot bonus for stateless workloads on vast/runpod', () => {
      const monitor = makeMonitor();
      const selector = new TierSelector(SELECTOR_OPTS());

      const statelessTier = makeIdleTier('vast', { storageGb: 0 });
      const statefulTier = makeIdleTier('vast', { storageGb: 50 });

      const statelessScore = selector.calculateTierScore(statelessTier, idleState(), 'user', monitor);
      const statefulScore = selector.calculateTierScore(statefulTier, idleState(), 'user', monitor);
      expect(statelessScore).toBeGreaterThan(statefulScore);
      expect(statelessScore - statefulScore).toBe(5); // exactly 5 bonus points
    });

    it('no spot bonus for tensordock', () => {
      const monitor = makeMonitor();
      const selector = new TierSelector(SELECTOR_OPTS());

      const tensordockTier = makeIdleTier('tensordock', { storageGb: 0 });
      const score = selector.calculateTierScore(tensordockTier, idleState(), 'user', monitor);
      // Price factor 20 + reliability 0.5*30 + boot factor + 0 spot bonus
      expect(score).toBeLessThan(20 + 30 + 20 + 5); // no spot bonus
    });

    it('uses neutral boot score (10) when provider not in registry', () => {
      const registry = {
        get: vi.fn(() => null), // no client
        register: vi.fn(), getAll: vi.fn(() => []),
      } as unknown as GpuProviderRegistry;
      const selector = new TierSelector({ registry, logger: makeLogger() });
      const monitor = makeMonitor();
      const tier = makeIdleTier('unknown-provider');
      const score = selector.calculateTierScore(tier, idleState(), 'user', monitor);
      // 20 (price) + 15 (reliability 0.5*30) + 10 (neutral boot) = 45
      expect(score).toBe(45);
    });

    it('price 0 gives maximum price score (40 points)', () => {
      const now = Date.now();
      const monitor = makeMonitor({
        getPriceInfo: () => ({ price: 0, timestamp: now }),
        getReliabilityScore: () => 0,
        getPriceUpdateIntervalMs: () => 5 * 60 * 1000,
      });
      const registry = { get: vi.fn(() => null), register: vi.fn(), getAll: vi.fn(() => []) } as unknown as GpuProviderRegistry;
      const selector = new TierSelector({ registry, logger: makeLogger() });
      const tier = makeIdleTier('runpod', { storageGb: 10 });
      const score = selector.calculateTierScore(tier, idleState(), 'user', monitor);
      // 40 (max price) + 0 (reliability=0) + 10 (neutral boot) + 0 (no spot) = 50
      expect(score).toBe(50);
    });

    it('price $5 gives minimum price score (0 points)', () => {
      const now = Date.now();
      const monitor = makeMonitor({
        getPriceInfo: () => ({ price: 5, timestamp: now }),
        getReliabilityScore: () => 0,
        getPriceUpdateIntervalMs: () => 5 * 60 * 1000,
      });
      const registry = { get: vi.fn(() => null), register: vi.fn(), getAll: vi.fn(() => []) } as unknown as GpuProviderRegistry;
      const selector = new TierSelector({ registry, logger: makeLogger() });
      const tier = makeIdleTier('runpod', { storageGb: 10 });
      const score = selector.calculateTierScore(tier, idleState(), 'user', monitor);
      // 0 (min price at $5) + 0 + 10 + 0 = 10
      expect(score).toBe(10);
    });

    it('ignores stale price data (falls back to neutral 20)', () => {
      const STALE_TIMESTAMP = Date.now() - (6 * 60 * 1000); // 6 min ago
      const monitor = makeMonitor({
        getPriceInfo: () => ({ price: 0.10, timestamp: STALE_TIMESTAMP }),
        getPriceUpdateIntervalMs: () => 5 * 60 * 1000, // 5 min interval
        getReliabilityScore: () => 0,
      });
      const registry = { get: vi.fn(() => null), register: vi.fn(), getAll: vi.fn(() => []) } as unknown as GpuProviderRegistry;
      const selector = new TierSelector({ registry, logger: makeLogger() });
      const tier = makeIdleTier('runpod', { storageGb: 10 });
      const score = selector.calculateTierScore(tier, idleState(), 'user', monitor);
      // 20 (stale price → neutral) + 0 + 10 + 0 = 30
      expect(score).toBe(30);
    });
  });

  describe('selectBestTierSync', () => {
    it('returns -1 when no tiers', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const monitor = makeMonitor();
      expect(selector.selectBestTierSync([], [], 'user', monitor)).toBe(-1);
    });

    it('returns -1 when all tiers are in cooldown', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const monitor = makeMonitor();
      const tiers = [makeIdleTier('vast'), makeIdleTier('runpod')];
      const states = [
        idleState(0, { cooldownUntil: Date.now() + 60_000 }),
        idleState(1, { cooldownUntil: Date.now() + 60_000 }),
      ];
      expect(selector.selectBestTierSync(tiers, states, 'user', monitor)).toBe(-1);
    });

    it('returns -1 when all tiers are booting/ready', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const monitor = makeMonitor();
      const tiers = [makeIdleTier('vast'), makeIdleTier('runpod')];
      const states = [bootingState(0), readyState(1)];
      expect(selector.selectBestTierSync(tiers, states, 'user', monitor)).toBe(-1);
    });

    it('returns the only eligible idle tier', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const monitor = makeMonitor();
      const tiers = [makeIdleTier('vast'), makeIdleTier('runpod')];
      const states = [bootingState(0), idleState(1)];
      expect(selector.selectBestTierSync(tiers, states, 'user', monitor)).toBe(1);
    });

    it('selects tier with higher score (cheaper price)', () => {
      const now = Date.now();
      const monitor = makeMonitor({
        getPriceInfo: (provider) => {
          if (provider === 'vast') return { price: 0.20, timestamp: now };
          if (provider === 'runpod') return { price: 1.50, timestamp: now };
          return undefined;
        },
        getPriceUpdateIntervalMs: () => 5 * 60 * 1000,
      });
      const selector = new TierSelector(SELECTOR_OPTS());
      const tiers = [makeIdleTier('vast'), makeIdleTier('runpod')];
      const states = [idleState(0), idleState(1)];
      expect(selector.selectBestTierSync(tiers, states, 'user', monitor)).toBe(0); // vast is cheaper
    });

    it('skips unhealthy tiers and picks healthy one', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const monitor = makeMonitor();
      const tiers = [makeIdleTier('vast'), makeIdleTier('runpod'), makeIdleTier('tensordock')];
      const states = [
        idleState(0, { unhealthy: true }),
        idleState(1, { manualStop: true }),
        idleState(2), // only eligible
      ];
      expect(selector.selectBestTierSync(tiers, states, 'user', monitor)).toBe(2);
    });
  });

  describe('findBestTierForBoot', () => {
    it('calls updatePriceCacheIfNeeded on the monitor', async () => {
      const monitor = makeMonitor();
      const selector = new TierSelector(SELECTOR_OPTS());
      const tiers = [makeIdleTier('runpod')];
      const states = [idleState(0)];

      await selector.findBestTierForBoot(tiers, states, 'user', monitor);

      expect(monitor.updatePriceCacheIfNeeded).toHaveBeenCalledOnce();
    });

    it('returns best tier index after price cache update', async () => {
      const now = Date.now();
      const monitor = makeMonitor({
        getPriceInfo: () => ({ price: 0.30, timestamp: now }),
        getPriceUpdateIntervalMs: () => 5 * 60 * 1000,
        updatePriceCacheIfNeeded: async () => {},
      });
      const selector = new TierSelector(SELECTOR_OPTS());
      const tiers = [makeIdleTier('runpod')];
      const states = [idleState(0)];

      const result = await selector.findBestTierForBoot(tiers, states, 'user', monitor);
      expect(result).toBe(0);
    });

    it('returns -1 when no eligible tiers after price update', async () => {
      const monitor = makeMonitor();
      const selector = new TierSelector(SELECTOR_OPTS());
      const tiers = [makeIdleTier('runpod')];
      const states = [bootingState(0)]; // no idle tiers

      const result = await selector.findBestTierForBoot(tiers, states, 'user', monitor);
      expect(result).toBe(-1);
    });
  });

  describe('edge cases', () => {
    it('handles single tier correctly', () => {
      const selector = new TierSelector(SELECTOR_OPTS());
      const monitor = makeMonitor();
      const tiers = [makeIdleTier('runpod')];
      const states = [idleState(0)];
      expect(selector.selectBestTierSync(tiers, states, 'user', monitor)).toBe(0);
    });

    it('score is always non-negative', () => {
      const monitor = makeMonitor({
        getPriceInfo: () => undefined,
        getReliabilityScore: () => 0,
      });
      const registry = { get: vi.fn(() => null), register: vi.fn(), getAll: vi.fn(() => []) } as unknown as GpuProviderRegistry;
      const selector = new TierSelector({ registry, logger: makeLogger() });
      const tier = makeIdleTier('runpod', { storageGb: 50 });
      const score = selector.calculateTierScore(tier, idleState(), 'user', monitor);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('price capped at $5 (no negative score)', () => {
      const now = Date.now();
      const monitor = makeMonitor({
        getPriceInfo: () => ({ price: 100, timestamp: now }), // $100/hr
        getReliabilityScore: () => 0,
        getPriceUpdateIntervalMs: () => 5 * 60 * 1000,
      });
      const registry = { get: vi.fn(() => null), register: vi.fn(), getAll: vi.fn(() => []) } as unknown as GpuProviderRegistry;
      const selector = new TierSelector({ registry, logger: makeLogger() });
      const tier = makeIdleTier('runpod', { storageGb: 10 });
      const score = selector.calculateTierScore(tier, idleState(), 'user', monitor);
      // Price capped at 5 → 0 price points. Score should not go negative.
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('works with many tiers correctly ranking all', () => {
      const now = Date.now();
      const monitor = makeMonitor({
        getPriceInfo: (provider) => {
          const prices: Record<string, number> = { vast: 0.20, runpod: 0.50, tensordock: 0.80, modal: 2.00 };
          const price = prices[provider];
          return price !== undefined ? { price, timestamp: now } : undefined;
        },
        getPriceUpdateIntervalMs: () => 5 * 60 * 1000,
        getReliabilityScore: () => 0.5,
      });
      const selector = new TierSelector(SELECTOR_OPTS());
      const tiers = [
        makeIdleTier('vast'),
        makeIdleTier('runpod'),
        makeIdleTier('tensordock'),
        makeIdleTier('modal'),
      ];
      const states = [idleState(0), idleState(1), idleState(2), idleState(3)];
      // vast is cheapest, should win
      expect(selector.selectBestTierSync(tiers, states, 'user', monitor)).toBe(0);
    });
  });
});
