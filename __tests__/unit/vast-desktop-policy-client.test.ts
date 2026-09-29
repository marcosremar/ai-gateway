/**
 * Regression: createInstance must respect explicit minInetDownMbps (no clamp to 500)
 * and apply desktop offerPolicy filters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VastClient } from '../../src/gateway/providers/gpu/vast-client';
import { AbstractGpuProvider } from '../../src/gateway/providers/gpu/abstract-provider';
import type { ProviderCredentials } from '../../src/gateway/providers/gpu/types';

const creds: ProviderCredentials = { apiKey: 'test-key' };

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('VastClient — inet_down clamp + desktop policy', () => {
  let client: VastClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new VastClient();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(AbstractGpuProvider, 'estimateImageDiskGb').mockResolvedValue(20);
    process.env.VAST_SKIP_IMAGE_PRECHECK = '1';
    vi.spyOn(client as any, '_pollForEndpoint').mockResolvedValue({
      endpoint: 'http://1.2.3.4:8000',
      ip: '1.2.3.4',
    });
  });

  afterEach(() => {
    delete process.env.VAST_SKIP_IMAGE_PRECHECK;
    vi.restoreAllMocks();
  });

  it('does not clamp explicit minInetDownMbps above 500', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse({ credit: 100 }))
      .mockResolvedValueOnce(mockFetchResponse({ offers: [] }))
      .mockResolvedValueOnce(mockFetchResponse({ offers: [] }))
      .mockResolvedValueOnce(mockFetchResponse({ offers: [] }));

    await expect(
      client.createInstance(
        { dockerImage: 'test:latest', minInetDownMbps: 1500, raceCount: 1 },
        creds,
      ),
    ).rejects.toThrow('No GPUs available');

    const bundleCalls = fetchSpy.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/bundles/'),
    );
    expect(bundleCalls.length).toBeGreaterThanOrEqual(1);
    const firstBody = JSON.parse((bundleCalls[0][1] as { body: string }).body);
    expect(firstBody.inet_down).toEqual({ gte: 1500 });
  });

  it('desktop offerPolicy sets inet_down gt 1000 and does not relax to 500', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse({ credit: 100 }))
      .mockResolvedValueOnce(mockFetchResponse({ offers: [] })) // primary
      .mockResolvedValueOnce(mockFetchResponse({ offers: [] })) // soft: drop verified
      .mockResolvedValueOnce(mockFetchResponse({ offers: [] })); // phase-2 ssh

    await expect(
      client.createInstance(
        {
          dockerImage: 'test:latest',
          offerPolicy: 'desktop',
          maxPricePerHr: 0.2,
          raceCount: 1,
          strictFastBoot: true, // skip phase-2 if possible — may still search
        },
        creds,
      ),
    ).rejects.toThrow('No GPUs available');

    const bundleCalls = fetchSpy.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/bundles/'),
    );
    expect(bundleCalls.length).toBeGreaterThanOrEqual(1);
    const firstBody = JSON.parse((bundleCalls[0][1] as { body: string }).body);
    expect(firstBody.inet_down).toEqual({ gt: 1000 });
    expect(firstBody.reliability2).toEqual({ gte: 0.95 });
    expect(firstBody.dph_total).toEqual({ lte: 0.2 });
    expect(firstBody.verified).toEqual({ eq: true });

    // No search should relax to inet_down 500 under desktop policy
    for (const call of bundleCalls) {
      const body = JSON.parse((call[1] as { body: string }).body);
      expect(body.inet_down).not.toEqual({ gte: 500 });
      if (body.reliability2) {
        expect(Number((body.reliability2 as { gte?: number }).gte ?? 1)).toBeGreaterThanOrEqual(0.95);
      }
    }
  });
});
