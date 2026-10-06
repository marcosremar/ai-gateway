// ── gpu-auto-select unit tests ────────────────────────────────────────────────
// Tests the filtering, scoring, and sorting logic inside autoSelectCheapestGpu.
// All Prisma, latency-db, and metrics calls are mocked so these tests run
// without a database and complete in milliseconds.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GpuOffer } from '../../src/gpu-providers/types';

// ── Module mocks (declared before any import of the module under test) ─────────

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Prisma mock — each test can override findMany return values
const mockPrismaHostRep = vi.fn().mockResolvedValue([]);
const mockPrismaGpuCompat = vi.fn().mockResolvedValue([]);
const mockPrismaGpuSession = vi.fn().mockResolvedValue([]);

vi.mock('../../server/state', () => ({
  prisma: {
    hostReputation: { findMany: (...args: unknown[]) => mockPrismaHostRep(...args) },
    gpuCompatibilityTest: { findMany: (...args: unknown[]) => mockPrismaGpuCompat(...args) },
    gpuDeploySession: { findMany: (...args: unknown[]) => mockPrismaGpuSession(...args) },
  },
  deployState: { dockerImage: '' },
  activeProvider: 'vast',
}));

const mockGetBestLatency = vi.fn().mockResolvedValue({});

vi.mock('../../server/latency-db', () => ({
  getBestLatencyByGpuModel: (...args: unknown[]) => mockGetBestLatency(...args),
}));

const mockLoadReputations = vi.fn().mockResolvedValue(new Map());

vi.mock('../../server/metrics', () => ({
  loadReputationsByGpuType: (...args: unknown[]) => mockLoadReputations(...args),
}));

const mockGetGpuPriorityList = vi.fn().mockReturnValue([
  'NVIDIA GeForce RTX 4090',
  'NVIDIA RTX A6000',
  'NVIDIA L40S',
]);
const mockGetGpuSortBy = vi.fn().mockReturnValue('balanced');
const mockIsGpuFilterDisabled = vi.fn().mockReturnValue(false);

vi.mock('../../src/gpu-providers/deploy-settings', () => ({
  getGpuPriorityList: (...args: unknown[]) => mockGetGpuPriorityList(...args),
  getGpuSortBy: (...args: unknown[]) => mockGetGpuSortBy(...args),
  isGpuFilterDisabled: (...args: unknown[]) => mockIsGpuFilterDisabled(...args),
}));

// ── Import function under test ────────────────────────────────────────────────

import { autoSelectCheapestGpu } from '../../server/gpu-auto-select';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOffer(overrides: Partial<GpuOffer> & { driverVersion?: string; inetDown?: number; diskBwReadMbps?: number } = {}): GpuOffer & Record<string, unknown> {
  return {
    provider: 'vast',
    gpuType: 'RTX4090',
    gpuName: 'NVIDIA GeForce RTX 4090',
    available: 1,
    pricePerHr: 0.50,
    vram: 24,
    region: 'US',
    ...overrides,
  } as GpuOffer & Record<string, unknown>;
}

function makeTier(offers: GpuOffer[]) {
  return {
    client: {
      providerId: 'vast',
      bootTimeSecs: 120,
      listOffers: vi.fn().mockResolvedValue(offers),
      discoverInstance: vi.fn(),
      createInstance: vi.fn(),
      startInstance: vi.fn(),
      stopInstance: vi.fn(),
      terminateInstance: vi.fn(),
      getInstanceStatus: vi.fn(),
    },
    name: 'vast' as const,
    label: 'Vast.ai',
    apiKey: 'test-key',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrismaHostRep.mockResolvedValue([]);
  mockPrismaGpuCompat.mockResolvedValue([]);
  mockPrismaGpuSession.mockResolvedValue([]);
  mockGetBestLatency.mockResolvedValue({});
  mockLoadReputations.mockResolvedValue(new Map());
  mockGetGpuPriorityList.mockReturnValue(['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'NVIDIA L40S']);
  mockGetGpuSortBy.mockReturnValue('balanced');
  mockIsGpuFilterDisabled.mockReturnValue(false);
});

// ── Tests: basic offer collection ────────────────────────────────────────────

describe('autoSelectCheapestGpu — no tiers / no offers', () => {
  it('returns empty array when no tiers provided', async () => {
    const result = await autoSelectCheapestGpu([]);
    expect(result).toEqual([]);
  });

  it('returns empty array when tier has no listOffers method', async () => {
    const tier = { client: { providerId: 'runpod', bootTimeSecs: 60 }, name: 'runpod' as const, label: 'RunPod', apiKey: 'k' };
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toEqual([]);
  });

  it('returns empty array when listOffers returns empty list', async () => {
    const tier = makeTier([]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toEqual([]);
  });

  it('returns empty array when all offers have zero price', async () => {
    const tier = makeTier([makeOffer({ pricePerHr: 0 })]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toEqual([]);
  });
});

// ── Tests: VRAM filtering ─────────────────────────────────────────────────────

describe('autoSelectCheapestGpu — VRAM filtering', () => {
  it('excludes offers below minimum VRAM (default 16 GB)', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 3080', vram: 10 }),
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', vram: 24 }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).not.toContain('NVIDIA GeForce RTX 3080');
    expect(result).toContain('NVIDIA GeForce RTX 4090');
  });

  it('includes offers that exactly meet minVramGb', async () => {
    const tier = makeTier([makeOffer({ vram: 24 })]);
    const result = await autoSelectCheapestGpu([tier as never], { minVramGb: 24 });
    expect(result).toHaveLength(1);
  });

  it('excludes offers one GB below minVramGb', async () => {
    const tier = makeTier([makeOffer({ vram: 23 })]);
    const result = await autoSelectCheapestGpu([tier as never], { minVramGb: 24 });
    expect(result).toHaveLength(0);
  });

  it('respects custom minVramGb threshold', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA A100', vram: 80 }),
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', vram: 24 }),
    ]);
    mockIsGpuFilterDisabled.mockReturnValue(true);
    const result = await autoSelectCheapestGpu([tier as never], { minVramGb: 40 });
    expect(result).toContain('NVIDIA A100');
    expect(result).not.toContain('NVIDIA GeForce RTX 4090');
  });
});

// ── Tests: availability filtering ────────────────────────────────────────────

describe('autoSelectCheapestGpu — availability filtering', () => {
  it('excludes offers where available === 0 (out of stock)', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', available: 0 }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', available: 5 }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).not.toContain('NVIDIA GeForce RTX 4090');
    expect(result).toContain('NVIDIA RTX A6000');
  });

  it('keeps offers where available === -1 (unknown stock)', async () => {
    const tier = makeTier([makeOffer({ available: -1 })]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(1);
  });

  it('keeps offers where available is a positive count', async () => {
    const tier = makeTier([makeOffer({ available: 3 })]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(1);
  });
});

// ── Tests: driver version pinning ─────────────────────────────────────────────

describe('autoSelectCheapestGpu — driver version pinning', () => {
  it('passes offer with no driverVersion when minDriverVersion set', async () => {
    const offer = makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090' });
    delete (offer as Record<string, unknown>).driverVersion;
    const tier = makeTier([offer]);
    const result = await autoSelectCheapestGpu([tier as never], { minDriverVersion: 570 });
    expect(result).toHaveLength(1);
  });

  it('excludes offer whose driver major is below minimum', async () => {
    const offer = makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', driverVersion: '535.129.03' } as never);
    const tier = makeTier([offer]);
    const result = await autoSelectCheapestGpu([tier as never], { minDriverVersion: 570 });
    expect(result).toHaveLength(0);
  });

  it('includes offer whose driver major meets minimum', async () => {
    const offer = makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', driverVersion: '570.00.01' } as never);
    const tier = makeTier([offer]);
    const result = await autoSelectCheapestGpu([tier as never], { minDriverVersion: 570 });
    expect(result).toHaveLength(1);
  });

  it('includes offer with driver major above minimum', async () => {
    const offer = makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', driverVersion: '600.0.0' } as never);
    const tier = makeTier([offer]);
    const result = await autoSelectCheapestGpu([tier as never], { minDriverVersion: 570 });
    expect(result).toHaveLength(1);
  });

  it('does not filter by driver when minDriverVersion is 0 (default)', async () => {
    const offer = makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', driverVersion: '400.0.0' } as never);
    const tier = makeTier([offer]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(1);
  });
});

// ── Tests: internet speed filtering ──────────────────────────────────────────

describe('autoSelectCheapestGpu — internet speed filtering', () => {
  it('keeps offers with unknown inetDown (undefined)', async () => {
    const offer = makeOffer();
    delete (offer as Record<string, unknown>).inetDown;
    const tier = makeTier([offer]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(1);
  });

  it('keeps offers with inetDown === 0 (treated as unknown)', async () => {
    const tier = makeTier([makeOffer({ inetDown: 0 } as never)]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(1);
  });

  it('keeps fast offers with inetDown >= 500 Mbps', async () => {
    const tier = makeTier([makeOffer({ inetDown: 1000 } as never)]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(1);
  });

  it('filters slow offers when fast alternatives exist', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', inetDown: 100 } as never),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', inetDown: 800 } as never),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).not.toContain('NVIDIA GeForce RTX 4090');
    expect(result).toContain('NVIDIA RTX A6000');
  });

  it('falls back to all offers when ALL have slow inetDown', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', inetDown: 100 } as never),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', inetDown: 200 } as never),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(2);
  });
});

// ── Tests: SSD preference filtering ──────────────────────────────────────────

describe('autoSelectCheapestGpu — SSD preference filtering', () => {
  it('does not filter by disk speed when preferSsd is false (default)', async () => {
    const tier = makeTier([makeOffer({ diskBwReadMbps: 50 } as never)]);
    const result = await autoSelectCheapestGpu([tier as never], { preferSsd: false });
    expect(result).toHaveLength(1);
  });

  it('keeps SSD offers when preferSsd is true', async () => {
    const tier = makeTier([makeOffer({ diskBwReadMbps: 500 } as never)]);
    const result = await autoSelectCheapestGpu([tier as never], { preferSsd: true });
    expect(result).toHaveLength(1);
  });

  it('filters HDD offers when SSD alternatives exist', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', diskBwReadMbps: 50 } as never),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', diskBwReadMbps: 600 } as never),
    ]);
    const result = await autoSelectCheapestGpu([tier as never], { preferSsd: true });
    expect(result).not.toContain('NVIDIA GeForce RTX 4090');
    expect(result).toContain('NVIDIA RTX A6000');
  });

  it('falls back to all offers when no SSD offers exist', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', diskBwReadMbps: 50 } as never),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', diskBwReadMbps: 80 } as never),
    ]);
    const result = await autoSelectCheapestGpu([tier as never], { preferSsd: true });
    expect(result).toHaveLength(2);
  });

  it('keeps offer with unknown diskBwReadMbps when preferSsd is true', async () => {
    const offer = makeOffer();
    delete (offer as Record<string, unknown>).diskBwReadMbps;
    const tier = makeTier([offer]);
    const result = await autoSelectCheapestGpu([tier as never], { preferSsd: true });
    expect(result).toHaveLength(1);
  });
});

// ── Tests: GPU type allowlist filtering ──────────────────────────────────────

describe('autoSelectCheapestGpu — allowlist filtering', () => {
  it('includes only offers matching the allowlist', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', gpuType: 'RTX4090' }),
      makeOffer({ gpuName: 'NVIDIA V100', gpuType: 'V100' }),
    ]);
    mockGetGpuPriorityList.mockReturnValue(['NVIDIA GeForce RTX 4090']);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toContain('NVIDIA GeForce RTX 4090');
    expect(result).not.toContain('NVIDIA V100');
  });

  it('falls back to all offers when no allowlisted GPU matches', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA V100', gpuType: 'V100' }),
    ]);
    mockGetGpuPriorityList.mockReturnValue(['NVIDIA GeForce RTX 4090']);
    const result = await autoSelectCheapestGpu([tier as never]);
    // Falls back to all suitable offers
    expect(result).toContain('NVIDIA V100');
  });

  it('matches allowlist ignoring NVIDIA/GeForce prefixes (normalization)', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', gpuType: 'RTX4090' }),
    ]);
    // Allowlist uses short name; normalization should match
    mockGetGpuPriorityList.mockReturnValue(['RTX 4090']);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toContain('NVIDIA GeForce RTX 4090');
  });

  it('shows all GPU types when filter is disabled (empty priority list)', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA V100', gpuType: 'V100' }),
      makeOffer({ gpuName: 'AMD RX 6900 XT', gpuType: 'RX6900XT' }),
    ]);
    mockIsGpuFilterDisabled.mockReturnValue(true);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(2);
  });

  it('respects custom allowedTypes opt', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090' }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000' }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never], {
      allowedTypes: new Set(['NVIDIA RTX A6000']),
    });
    expect(result).toContain('NVIDIA RTX A6000');
    expect(result).not.toContain('NVIDIA GeForce RTX 4090');
  });
});

// ── Tests: sort mode — price ──────────────────────────────────────────────────

describe('autoSelectCheapestGpu — sort mode: price', () => {
  beforeEach(() => {
    mockGetGpuSortBy.mockReturnValue('price');
    mockIsGpuFilterDisabled.mockReturnValue(true);
  });

  it('returns cheapest GPU first', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA A100', pricePerHr: 2.50 }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', pricePerHr: 0.90 }),
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', pricePerHr: 0.50 }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result[0]).toBe('NVIDIA GeForce RTX 4090');
    expect(result[1]).toBe('NVIDIA RTX A6000');
    expect(result[2]).toBe('NVIDIA A100');
  });

  it('puts equal-price offers in stable relative order', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'GPU-A', pricePerHr: 1.00 }),
      makeOffer({ gpuName: 'GPU-B', pricePerHr: 1.00 }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(2);
  });
});

// ── Tests: sort mode — latency ────────────────────────────────────────────────

describe('autoSelectCheapestGpu — sort mode: latency', () => {
  beforeEach(() => {
    mockGetGpuSortBy.mockReturnValue('latency');
    mockIsGpuFilterDisabled.mockReturnValue(true);
  });

  it('returns lowest-latency GPU first', async () => {
    mockGetBestLatency.mockResolvedValue({
      rtxa6000: { bestMs: 25, region: 'EU' },
      rtx4090: { bestMs: 120, region: 'US' },
    });
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', gpuType: 'RTX4090' }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', gpuType: 'RTX A6000' }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result[0]).toBe('NVIDIA RTX A6000');
  });

  it('deprioritizes offers with unknown latency (put last after known)', async () => {
    mockGetBestLatency.mockResolvedValue({
      rtx4090: { bestMs: 50, region: 'US' },
    });
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', gpuType: 'RTX4090' }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', gpuType: 'RTX A6000' }), // no latency data
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result[0]).toBe('NVIDIA GeForce RTX 4090');
  });
});

// ── Tests: sort mode — balanced (default) ────────────────────────────────────

describe('autoSelectCheapestGpu — sort mode: balanced', () => {
  beforeEach(() => {
    mockGetGpuSortBy.mockReturnValue('balanced');
    mockIsGpuFilterDisabled.mockReturnValue(true);
  });

  it('factors in reputation score when sorting', async () => {
    const repMap = new Map([
      ['vast:NVIDIA RTX A6000', { avgScore: 0.95, hostCount: 10 }],
      ['vast:NVIDIA GeForce RTX 4090', { avgScore: 0.20, hostCount: 5 }],
    ]);
    mockLoadReputations.mockResolvedValue(repMap);
    const tier = makeTier([
      // RTX 4090 is cheaper but has very low reputation
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', pricePerHr: 0.40 }),
      // A6000 is pricier but highly reputable
      makeOffer({ gpuName: 'NVIDIA RTX A6000', pricePerHr: 0.80 }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    // A6000 has rep 0.95, 4090 has rep 0.20 → effective price of A6000 wins
    expect(result[0]).toBe('NVIDIA RTX A6000');
  });

  it('uses neutral 0.5 reputation for unknown GPU types', async () => {
    mockLoadReputations.mockResolvedValue(new Map());
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', pricePerHr: 0.50 }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', pricePerHr: 0.80 }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    // Both get 0.5 rep, so cheaper one wins
    expect(result[0]).toBe('NVIDIA GeForce RTX 4090');
  });
});

// ── Tests: sort mode — realtime ───────────────────────────────────────────────

describe('autoSelectCheapestGpu — sort mode: realtime', () => {
  beforeEach(() => {
    mockGetGpuSortBy.mockReturnValue('realtime');
    mockIsGpuFilterDisabled.mockReturnValue(true);
  });

  it('filters out offers with latency > 150ms', async () => {
    mockGetBestLatency.mockResolvedValue({
      rtxa6000: { bestMs: 30, region: 'EU' },
      rtx4090: { bestMs: 200, region: 'US' },
    });
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', gpuType: 'RTX4090' }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', gpuType: 'RTX A6000' }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).not.toContain('NVIDIA GeForce RTX 4090');
    expect(result).toContain('NVIDIA RTX A6000');
  });

  it('falls back to all offers when all exceed 150ms latency', async () => {
    mockGetBestLatency.mockResolvedValue({
      rtxa6000: { bestMs: 200, region: 'US' },
      rtx4090: { bestMs: 300, region: 'US' },
    });
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', gpuType: 'RTX4090' }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', gpuType: 'RTX A6000' }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(2);
  });

  it('prefers low-latency offer over unknown-latency offer', async () => {
    mockGetBestLatency.mockResolvedValue({
      rtxa6000: { bestMs: 30, region: 'EU' },
    });
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', gpuType: 'RTX4090', pricePerHr: 0.30 }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', gpuType: 'RTX A6000', pricePerHr: 0.80 }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    // A6000 has 30ms, 4090 has unknown (treated as 0.3 score) → A6000 first
    expect(result[0]).toBe('NVIDIA RTX A6000');
  });
});

// ── Tests: deduplication ──────────────────────────────────────────────────────

describe('autoSelectCheapestGpu — deduplication', () => {
  beforeEach(() => {
    mockIsGpuFilterDisabled.mockReturnValue(true);
    mockGetGpuSortBy.mockReturnValue('price');
  });

  it('deduplicates multiple offers for the same GPU name', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', pricePerHr: 0.50 }),
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', pricePerHr: 0.45 }),
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', pricePerHr: 0.60 }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result.filter(r => r === 'NVIDIA GeForce RTX 4090')).toHaveLength(1);
  });

  it('keeps first (best-ranked) offer per GPU name after sorting', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', pricePerHr: 1.00 }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', pricePerHr: 0.50 }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result[0]).toBe('NVIDIA RTX A6000');
  });
});

// ── Tests: maxResults cap ─────────────────────────────────────────────────────

describe('autoSelectCheapestGpu — maxResults cap', () => {
  beforeEach(() => {
    mockIsGpuFilterDisabled.mockReturnValue(true);
    mockGetGpuSortBy.mockReturnValue('price');
  });

  it('returns at most maxResults unique GPU types', async () => {
    const offers = Array.from({ length: 12 }, (_, i) =>
      makeOffer({ gpuName: `NVIDIA GPU-${i}`, gpuType: `GPU${i}`, pricePerHr: i * 0.1 + 0.1 }),
    );
    const tier = makeTier(offers);
    const result = await autoSelectCheapestGpu([tier as never], { maxResults: 4 });
    expect(result).toHaveLength(4);
  });

  it('returns fewer than maxResults when fewer types are available', async () => {
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090' }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000' }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never], { maxResults: 10 });
    expect(result).toHaveLength(2);
  });
});

// ── Tests: blacklist filtering ────────────────────────────────────────────────

describe('autoSelectCheapestGpu — host blacklisting', () => {
  beforeEach(() => {
    mockIsGpuFilterDisabled.mockReturnValue(true);
    mockGetGpuSortBy.mockReturnValue('price');
  });

  it('excludes hosts with 3+ crashes in 7 days', async () => {
    mockPrismaHostRep.mockResolvedValue([{ hostKey: 'vast:host-bad' }]);
    const tier = makeTier([
      makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', hostId: 'host-bad' }),
      makeOffer({ gpuName: 'NVIDIA RTX A6000', hostId: 'host-good' }),
    ]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).not.toContain('NVIDIA GeForce RTX 4090');
    expect(result).toContain('NVIDIA RTX A6000');
  });

  it('proceeds normally when prisma hostReputation query fails', async () => {
    mockPrismaHostRep.mockRejectedValue(new Error('DB unavailable'));
    const tier = makeTier([makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090' })]);
    const result = await autoSelectCheapestGpu([tier as never]);
    expect(result).toHaveLength(1);
  });
});

// ── Tests: multi-tier offer aggregation ──────────────────────────────────────

describe('autoSelectCheapestGpu — multi-tier aggregation', () => {
  beforeEach(() => {
    mockIsGpuFilterDisabled.mockReturnValue(true);
    mockGetGpuSortBy.mockReturnValue('price');
  });

  it('collects offers from multiple tiers', async () => {
    const tier1 = makeTier([makeOffer({ gpuName: 'NVIDIA GeForce RTX 4090', provider: 'runpod' })]);
    const tier2 = makeTier([makeOffer({ gpuName: 'NVIDIA RTX A6000', provider: 'vast' })]);
    const result = await autoSelectCheapestGpu([tier1 as never, tier2 as never]);
    expect(result).toContain('NVIDIA GeForce RTX 4090');
    expect(result).toContain('NVIDIA RTX A6000');
  });

  it('continues with other tiers when one tier listOffers throws', async () => {
    const tier1 = {
      client: {
        providerId: 'runpod',
        bootTimeSecs: 60,
        listOffers: vi.fn().mockRejectedValue(new Error('network error')),
      },
      name: 'runpod' as const,
      label: 'RunPod',
      apiKey: 'k',
    };
    const tier2 = makeTier([makeOffer({ gpuName: 'NVIDIA RTX A6000' })]);
    const result = await autoSelectCheapestGpu([tier1 as never, tier2 as never]);
    expect(result).toContain('NVIDIA RTX A6000');
  });
});
