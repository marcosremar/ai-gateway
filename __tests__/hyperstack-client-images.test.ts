/**
 * Hyperstack Custom OS Image + snapshot surface — unit tests for the
 * methods added to support pre-baked boot images. Mocks fetch so each
 * request shape can be asserted (URL, method, headers, body) without
 * hitting the real API.
 *
 * Route shapes match the live probe (2026-04-18):
 *   POST /core/virtual-machines/{id}/snapshots  {name, description}
 *   DELETE /core/snapshots/{id}
 *   POST /core/snapshots/{id}/image             {name}    (only!)
 *   GET /core/images
 *   GET /core/snapshots
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { HyperstackClient } from '../src/gpu-providers/hyperstack';

const creds = { apiKey: 'test-key' } as const;

interface Captured { url: string; method: string; headers: Record<string, string>; body?: string }

function mockFetch(handler: (captured: Captured) => Response | Promise<Response>) {
  const spy = vi.spyOn(globalThis, 'fetch');
  spy.mockImplementation(async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = String(init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    const body = typeof init?.body === 'string' ? init?.body as string : undefined;
    return handler({ url, method, headers, body });
  });
  return spy;
}

describe('HyperstackClient images/snapshots surface', () => {
  afterEach(() => vi.restoreAllMocks());

  it('createSnapshot POSTs {name, description} to /core/virtual-machines/{id}/snapshots', async () => {
    const captured: Captured[] = [];
    mockFetch((req) => {
      captured.push(req);
      return new Response(
        JSON.stringify({
          status: true,
          snapshot: {
            id: 777,
            name: 'my-snap',
            status: 'CREATING',
            description: 'probe',
            region_name: 'CANADA-1',
            vm_id: 42,
            created_at: '2026-04-18T10:00:00Z',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = new HyperstackClient();
    const snap = await client.createSnapshot('42', 'my-snap', creds, 'probe');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.url).toBe('https://infrahub-api.nexgencloud.com/v1/core/virtual-machines/42/snapshots');
    expect(captured[0]!.headers['api_key']).toBe('test-key');
    expect(JSON.parse(captured[0]!.body!)).toEqual({ name: 'my-snap', description: 'probe' });
    expect(snap).toEqual({
      id: 777,
      name: 'my-snap',
      status: 'CREATING',
      description: 'probe',
      region: 'CANADA-1',
      sourceVmId: 42,
      createdAt: '2026-04-18T10:00:00Z',
    });
  });

  it('createSnapshot defaults description when caller omits it', async () => {
    let capturedBody: string | undefined;
    mockFetch((req) => {
      capturedBody = req.body;
      return new Response(JSON.stringify({ snapshot: { id: 1, name: 'x', status: 'ACTIVE' } }), { status: 200 });
    });
    const client = new HyperstackClient();
    await client.createSnapshot('99', 'x', creds);
    expect(JSON.parse(capturedBody!).description).toMatch(/VM 99/);
  });

  it('listSnapshots GETs /core/snapshots and returns empty array on empty list', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({
        status: true,
        message: 'Successfully retrieved Snapshots',
        count: 0,
        snapshots: [],
      }), { status: 200 }),
    );
    const client = new HyperstackClient();
    const snaps = await client.listSnapshots(creds);
    expect(snaps).toEqual([]);
  });

  it('listSnapshots maps multiple snapshot entries', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({
        snapshots: [
          { id: 1, name: 'a', status: 'ACTIVE', region_name: 'CANADA-1' },
          { id: 2, name: 'b', status: 'CREATING', vm: { id: 50 } },
        ],
      }), { status: 200 }),
    );
    const client = new HyperstackClient();
    const snaps = await client.listSnapshots(creds);
    expect(snaps).toHaveLength(2);
    expect(snaps[0]!.id).toBe(1);
    expect(snaps[0]!.region).toBe('CANADA-1');
    expect(snaps[1]!.sourceVmId).toBe(50);
  });

  it('deleteSnapshot DELETEs /core/snapshots/{id}', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    mockFetch((req) => {
      capturedUrl = req.url;
      capturedMethod = req.method;
      // Response constructor disallows a body with 204 — use 200 + empty body.
      return new Response('', { status: 200 });
    });
    const client = new HyperstackClient();
    await client.deleteSnapshot(777, creds);
    expect(capturedMethod).toBe('DELETE');
    expect(capturedUrl).toBe('https://infrahub-api.nexgencloud.com/v1/core/snapshots/777');
  });

  it('createImageFromSnapshot POSTs {name} only (no description/region) to /core/snapshots/{id}/image', async () => {
    const captured: Captured[] = [];
    mockFetch((req) => {
      captured.push(req);
      return new Response(JSON.stringify({
        image: { id: 999, name: 'bench', region_name: 'CANADA-1', type: 'custom' },
      }), { status: 200 });
    });
    const client = new HyperstackClient();
    const img = await client.createImageFromSnapshot(777, 'bench', creds);
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.url).toBe('https://infrahub-api.nexgencloud.com/v1/core/snapshots/777/image');
    // The live API explicitly rejects 'description', 'is_public', 'region' —
    // making sure we don't accidentally forward them.
    const body = JSON.parse(captured[0]!.body!);
    expect(body).toEqual({ name: 'bench' });
    expect(img).toEqual({ id: 999, name: 'bench', region: 'CANADA-1', type: 'custom' });
  });

  it('listImages flattens the nested region/type group structure', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({
        images: [
          {
            region_name: 'CANADA-1',
            type: 'Ubuntu',
            images: [
              { id: 300, name: 'Ubuntu 22.04 R570' },
              { id: 301, name: 'Ubuntu 24.04 R570' },
            ],
          },
          {
            region_name: 'US-1',
            type: 'Rocky',
            images: [{ id: 500, name: 'Rocky 9' }],
          },
        ],
      }), { status: 200 }),
    );
    const client = new HyperstackClient();
    const images = await client.listImages(creds);
    expect(images).toHaveLength(3);
    expect(images[0]).toEqual({ id: 300, name: 'Ubuntu 22.04 R570', region: 'CANADA-1' });
    expect(images[2]!.region).toBe('US-1');
  });

  it('createInstance prefers spec.imageId over spec.imageName over HYPERSTACK_BENCH_IMAGE_ID env', async () => {
    // Stub the five dependent GETs used inside createInstance. We only care
    // about the body of the VM-create POST.
    const captured: Captured[] = [];
    const origEnv = { ...process.env };
    process.env.HYPERSTACK_BENCH_IMAGE_ID = '555';
    try {
      mockFetch((req) => {
        captured.push(req);
        if (req.url.endsWith('/core/flavors')) {
          return new Response(JSON.stringify({
            flavors: [{ id: 1, name: 'n3-A4000x1', gpu: 'RTX A4000', price_per_hour: 0.5, region: 'CANADA-1', stock_available: true }],
          }), { status: 200 });
        }
        if (req.url.endsWith('/core/environments')) {
          return new Response(JSON.stringify({ environments: [{ id: 1, name: 'default-CANADA-1', region: 'CANADA-1' }] }), { status: 200 });
        }
        if (req.url.endsWith('/core/images')) {
          // Client validates imageId against listImages — must include it.
          return new Response(JSON.stringify({
            images: [{
              region_name: 'CANADA-1',
              type: 'Ubuntu',
              images: [
                { id: 123, name: 'user-override' },
                { id: 555, name: 'env-fallback' },
              ],
            }],
          }), { status: 200 });
        }
        if (req.method === 'POST' && req.url.endsWith('/core/virtual-machines')) {
          return new Response(JSON.stringify({ instances: [{ id: 1, status: 'CREATING' }] }), { status: 200 });
        }
        if (req.url.includes('/core/virtual-machines/1')) {
          return new Response(JSON.stringify({
            instance: { id: 1, status: 'ACTIVE', power_state: 'RUNNING', floating_ip: '10.0.0.1' },
          }), { status: 200 });
        }
        return new Response('', { status: 200 });
      });
      const client = new HyperstackClient();
      await client.createInstance(
        { gpuTypes: ['RTX A4000'], dockerImage: 'test', imageId: 123 },
        creds,
      );
      const createPost = captured.find((r) => r.method === 'POST' && r.url.endsWith('/core/virtual-machines'));
      const body = JSON.parse(createPost!.body!);
      // Hyperstack's VM-create endpoint only accepts `image_name`. Callers
      // passing `imageId` get the id resolved to a name via listImages().
      expect(body.image_name).toBe('user-override');
      expect(body.image_id).toBeUndefined();
    } finally {
      process.env = origEnv;
    }
  });

  it('createInstance falls back to HYPERSTACK_BENCH_IMAGE_ID env when spec has no image override', async () => {
    const captured: Captured[] = [];
    const origEnv = { ...process.env };
    process.env.HYPERSTACK_BENCH_IMAGE_ID = '555';
    try {
      mockFetch((req) => {
        captured.push(req);
        if (req.url.endsWith('/core/flavors')) {
          return new Response(JSON.stringify({
            flavors: [{ id: 1, name: 'n3-A4000x1', gpu: 'RTX A4000', price_per_hour: 0.5, region: 'CANADA-1', stock_available: true }],
          }), { status: 200 });
        }
        if (req.url.endsWith('/core/environments')) {
          return new Response(JSON.stringify({ environments: [{ id: 1, name: 'default-CANADA-1', region: 'CANADA-1' }] }), { status: 200 });
        }
        if (req.url.endsWith('/core/images')) {
          // Client validates HYPERSTACK_BENCH_IMAGE_ID against listImages.
          return new Response(JSON.stringify({
            images: [{
              region_name: 'CANADA-1',
              type: 'Ubuntu',
              images: [
                { id: 555, name: 'env-fallback' },
              ],
            }],
          }), { status: 200 });
        }
        if (req.method === 'POST' && req.url.endsWith('/core/virtual-machines')) {
          return new Response(JSON.stringify({ instances: [{ id: 1, status: 'CREATING' }] }), { status: 200 });
        }
        if (req.url.includes('/core/virtual-machines/1')) {
          return new Response(JSON.stringify({
            instance: { id: 1, status: 'ACTIVE', power_state: 'RUNNING', floating_ip: '10.0.0.1' },
          }), { status: 200 });
        }
        return new Response('', { status: 200 });
      });
      const client = new HyperstackClient();
      await client.createInstance({ gpuTypes: ['RTX A4000'], dockerImage: 'test' }, creds);
      const createPost = captured.find((r) => r.method === 'POST' && r.url.endsWith('/core/virtual-machines'));
      const body = JSON.parse(createPost!.body!);
      // HYPERSTACK_BENCH_IMAGE_ID is resolved to its name via listImages()
      // and the VM-create POST sends `image_name`, not `image_id`.
      expect(body.image_name).toBe('env-fallback');
      expect(body.image_id).toBeUndefined();
    } finally {
      process.env = origEnv;
    }
  });
});
