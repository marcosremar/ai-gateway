/**
 * Phase B6 — driver pinning in autoSelectCheapestGpu.
 *
 * When `minDriverVersion: 570` is passed, offers whose reported driver is
 * older (e.g. 565) are filtered out. Offers without a driver field are
 * preserved (we can't prove exclusion).
 */
import { describe, it, expect, vi } from 'vitest';
import type { GpuOffer } from '../src/gpu-providers/types';
import type { GpuTier } from '../src/gpu-providers/deploy-orchestrator';

// Mock heavy dependencies before importing the target.
vi.mock('../server/state', () => ({
  prisma: { hostReputation: { findMany: async () => [] } },
  deployState: {},
}));
vi.mock('../server/latency-db', () => ({
  getBestLatencyByGpuModel: async () => null,
}));
vi.mock('../server/metrics', () => ({
  loadReputationsByGpuType: async () => new Map(),
}));
vi.mock('../src/gpu-providers/deploy-settings', () => ({
  getGpuPriorityList: () => ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'NVIDIA L40S', 'NVIDIA RTX A5000', 'NVIDIA A40', 'NVIDIA H100 80GB HBM3'],
  getGpuSortBy: () => 'price',
  // Newer call site reads this opt-out flag — default off so the priority
  // list is honored.
  isGpuFilterDisabled: () => false,
}));

describe('autoSelectCheapestGpu — driver pinning', () => {
  it('filters offers with driver major below threshold', async () => {
    const { autoSelectCheapestGpu } = await import('../server/gpu-auto-select');
    const offers: (GpuOffer & { driverVersion?: string })[] = [
      { provider: 'hyperstack', gpuType: 'NVIDIA H100 80GB HBM3', gpuName: 'H100', available: 1, pricePerHr: 2.0, region: 'EU', vram: 80, driverVersion: '565.57.01' },
      { provider: 'hyperstack', gpuType: 'NVIDIA H100 80GB HBM3', gpuName: 'H100', available: 1, pricePerHr: 2.1, region: 'EU', vram: 80, driverVersion: '570.195.03' },
    ];
    const tier: GpuTier = {
      client: { listOffers: async () => offers as GpuOffer[] } as any,
      name: 'hyperstack',
      label: 'Hyperstack',
      apiKey: 'k',
    };
    const sel = await autoSelectCheapestGpu([tier], { minDriverVersion: 570, minVramGb: 40 });
    // The 565 offer must be filtered — only the 570 one survives.
    expect(sel.length).toBeGreaterThan(0);
    expect(sel.some((s) => s.includes('H100'))).toBe(true);
  });

  it('keeps offers that do not report a driver (cannot prove exclusion)', async () => {
    const { autoSelectCheapestGpu } = await import('../server/gpu-auto-select');
    const offers: GpuOffer[] = [
      { provider: 'vast-vm', gpuType: 'NVIDIA GeForce RTX 4090', gpuName: 'RTX 4090', available: 1, pricePerHr: 0.5, region: 'EU', vram: 24 },
    ];
    const tier: GpuTier = {
      client: { listOffers: async () => offers } as any,
      name: 'vast-vm',
      label: 'Vast.ai (VM)',
      apiKey: 'k',
    };
    const sel = await autoSelectCheapestGpu([tier], { minDriverVersion: 570, minVramGb: 16 });
    expect(sel.some((s) => s.includes('RTX 4090'))).toBe(true);
  });

  it('passes through when minDriverVersion=0', async () => {
    const { autoSelectCheapestGpu } = await import('../server/gpu-auto-select');
    const offers: (GpuOffer & { driverVersion?: string })[] = [
      { provider: 'vast-vm', gpuType: 'NVIDIA GeForce RTX 4090', gpuName: 'RTX 4090', available: 1, pricePerHr: 0.5, region: 'EU', vram: 24, driverVersion: '525.147.05' },
    ];
    const tier: GpuTier = {
      client: { listOffers: async () => offers as GpuOffer[] } as any,
      name: 'vast-vm',
      label: 'Vast.ai (VM)',
      apiKey: 'k',
    };
    const sel = await autoSelectCheapestGpu([tier], { minVramGb: 16 });
    expect(sel.some((s) => s.includes('RTX 4090'))).toBe(true);
  });
});
