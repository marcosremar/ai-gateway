/**
 * Phase B6 — Hyperstack provider basic smoke tests.
 *
 * Uses a mocked fetch to verify that the client maps responses correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HyperstackClient } from '../src/gpu-providers/hyperstack';

const creds = { apiKey: 'test-key' } as const;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.spyOn(globalThis, 'fetch');
  spy.mockImplementation(async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  });
  return spy;
}

describe('HyperstackClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listInstances parses virtual-machines response', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/core/virtual-machines')) {
        return new Response(JSON.stringify({
          instances: [
            {
              id: 42,
              name: 'test-vm',
              status: 'ACTIVE',
              power_state: 'RUNNING',
              fixed_ip: '',
              floating_ip: '203.0.113.5',
              flavor: { id: 1, name: 'H100-PCIe-80G', gpu: 'H100' },
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });
    const client = new HyperstackClient();
    const instances = await client.listInstances(creds);
    expect(instances.length).toBe(1);
    expect(instances[0].instanceId).toBe('42');
    expect(instances[0].endpoint).toBe('http://203.0.113.5:8000');
    expect(instances[0].status).toBe('running');
  });

  it('listOffers filters by gpuType substring', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/core/flavors')) {
        return new Response(JSON.stringify({
          flavors: [
            { id: 1, name: 'H100-PCIe-80G', gpu: 'H100', price_per_hour: 2.0, region: 'CANADA-1' },
            { id: 2, name: 'A100-PCIe-80G', gpu: 'A100', price_per_hour: 1.5, region: 'CANADA-1' },
            { id: 3, name: 'L40-PCIe-48G', gpu: 'L40', price_per_hour: 1.0, region: 'CANADA-1' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });
    const client = new HyperstackClient();
    const offers = await client.listOffers({ gpuTypes: ['H100'] }, creds);
    expect(offers.length).toBe(1);
    expect(offers[0].gpuType).toBe('H100');
    expect(offers[0].pricePerHr).toBe(2.0);
  });

  it('listOffers parses the nested live payload shape from /core/flavors', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/core/flavors')) {
        return new Response(JSON.stringify({
          status: true,
          message: 'Getting flavors successful',
          data: [
            {
              gpu: 'A100-80G-PCIe',
              region_name: 'CANADA-1',
              flavors: [
                {
                  id: 100,
                  name: 'n3-A100x1',
                  gpu: 'A100-80G-PCIe',
                  region_name: 'CANADA-1',
                  gpu_count: 1,
                  cpu: 28,
                  ram: 120,
                  disk: 100,
                  stock_available: true,
                },
              ],
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });
    const client = new HyperstackClient();
    const offers = await client.listOffers({ gpuTypes: ['NVIDIA A100 80GB PCIe'] }, creds);
    expect(offers).toHaveLength(1);
    expect(offers[0].gpuType).toBe('A100-80G-PCIe');
    expect(offers[0].offerId).toBe('n3-A100x1');
    expect(offers[0].region).toBe('CANADA-1');
    expect(offers[0].available).toBe(1);
    expect(offers[0].pricePerHr).toBe(0);
  });

  it('getInstanceStatus maps API status to canonical values', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        instance: { id: 9, status: 'ACTIVE', power_state: 'RUNNING' },
      }), { status: 200 }),
    );
    const client = new HyperstackClient();
    expect(await client.getInstanceStatus('9', creds)).toBe('running');
  });

  it('resolveInstanceEndpoint returns http://<ip>:8000', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        instance: { id: 10, floating_ip: '198.51.100.7', status: 'ACTIVE', power_state: 'RUNNING' },
      }), { status: 200 }),
    );
    const client = new HyperstackClient();
    expect(await client.resolveInstanceEndpoint('10', creds)).toBe('http://198.51.100.7:8000');
  });

  it('DEFAULT_DRIVER_MAJOR exposes 570 as the confirmed baseline', () => {
    expect(HyperstackClient.DEFAULT_DRIVER_MAJOR).toBe(570);
  });
});
