/**
 * Vast desktop offer policy — ported from babylon vast-policy.spec.ts filter cases.
 */
import { describe, it, expect } from 'vitest';
import {
  VAST_DESKTOP_MAX_PER_HR,
  rankVastOffers,
  vastDesktopSearchFilters,
  type VastOfferRankInput,
} from '../../src/gateway/providers/gpu/vast/offer-policy';

const offer = (id: number, price = 0.1, extra: Partial<VastOfferRankInput> = {}): VastOfferRankInput => ({
  id,
  dph_total: price,
  reliability2: 0.95,
  inet_down: 1001,
  num_gpus: 1,
  gpu_name: 'GTX 1650',
  rentable: true,
  rented: false,
  verified: true,
  ...extra,
});

describe('Vast desktop offer policy', () => {
  it('exports VAST_DESKTOP_MAX_PER_HR = 0.20', () => {
    expect(VAST_DESKTOP_MAX_PER_HR).toBe(0.2);
  });

  it('chooses cheapest real GPU without imposing a card family or VRAM tier', () => {
    expect(
      rankVastOffers([offer(1), offer(2, 0.05), offer(3, 0.15, { gpu_name: 'Tesla T4' })]).map((x) => x.id),
    ).toEqual([2, 1, 3]);
  });

  it('revalidates strict download, reliability, finite price and availability client side', () => {
    const bad = [
      offer(1, 0.201),
      offer(2, NaN),
      offer(3, 0.1, { inet_down: 1000 }),
      offer(4, 0.1, { reliability2: 0.949 }),
      offer(5, 0.1, { num_gpus: 0 }),
      offer(6, 0.1, { rented: true }),
      offer(7, 0.1, { rentable: false }),
      offer(8, 0.1, { reliability2: NaN }),
      offer(9, 0.1, { inet_down: Infinity }),
      offer(10, 0.1, { gpu_name: '' }),
    ];
    expect(rankVastOffers([...bad, offer(11, 0.2)])).toEqual([offer(11, 0.2)]);
  });

  it('rejects invalid price caps', () => {
    expect(() => rankVastOffers([], 0)).toThrow('invalid Vast price cap');
    expect(() => rankVastOffers([], 0.21)).toThrow('invalid Vast price cap');
    expect(() => rankVastOffers([], NaN)).toThrow('invalid Vast price cap');
  });

  it('vastDesktopSearchFilters defaults: reliability≥0.95, inet_down>1000, dph≤0.20, verified', () => {
    expect(vastDesktopSearchFilters()).toEqual({
      reliability2: { gte: 0.95 },
      inet_down: { gt: 1000 },
      dph_total: { lte: 0.2 },
      verified: { eq: true },
    });
  });

  it('vastDesktopSearchFilters respects overrides', () => {
    expect(
      vastDesktopSearchFilters({ maxPerHr: 0.15, minReliability: 0.97, minInetDownMbps: 2000 }),
    ).toEqual({
      reliability2: { gte: 0.97 },
      inet_down: { gte: 2000 },
      dph_total: { lte: 0.15 },
      verified: { eq: true },
    });
  });
});
