/**
 * autoSelectCheapestGpu — latency sort must actually see latency-db data.
 *
 * latency-db keys GPU models as "rtx 4090" (inner space kept) while the
 * auto-select normalizer strips all whitespace ("rtx4090"). Before the fix
 * no offer ever matched, so sortBy=latency/realtime ranked as if every host
 * had unknown latency.
 */
import { describe, it, expect, vi } from 'vitest';
import type { GpuOffer } from '../src/gpu-providers/types';
import type { GpuTier } from '../src/gpu-providers/deploy-orchestrator';

vi.mock('../server/state', () => ({
  prisma: { hostReputation: { findMany: async () => [] } },
  deployState: {},
}));
vi.mock('../server/latency-db', () => ({
  getBestLatencyByGpuModel: async () => ({
    'rtx 4090':  { bestMs: 18,  region: 'France, FR' },
    'rtx a6000': { bestMs: 240, region: 'United States, US' },
  }),
}));
vi.mock('../server/metrics', () => ({
  loadReputationsByGpuType: async () => new Map(),
}));
vi.mock('../src/gpu-providers/deploy-settings', () => ({
  getGpuPriorityList: () => ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000'],
  getGpuSortBy: () => 'latency',
  isGpuFilterDisabled: () => false,
}));

describe('autoSelectCheapestGpu — latency sort', () => {
  it('ranks the low-RTT GPU model first even when it is pricier', async () => {
    const { autoSelectCheapestGpu } = await import('../server/gpu-auto-select');
    const offers: GpuOffer[] = [
      { provider: 'vast', gpuType: 'RTX A6000', gpuName: 'RTX A6000', available: 1, pricePerHr: 0.30, region: 'US', vram: 48 },
      { provider: 'vast', gpuType: 'RTX 4090',  gpuName: 'RTX 4090',  available: 1, pricePerHr: 0.45, region: 'FR', vram: 24 },
    ];
    const tier: GpuTier = {
      client: { listOffers: async () => offers } as any,
      name: 'vast',
      label: 'Vast.ai',
      apiKey: 'k',
    };
    const sel = await autoSelectCheapestGpu([tier], { minVramGb: 16 });
    expect(sel[0]).toBe('RTX 4090');
  });
});
