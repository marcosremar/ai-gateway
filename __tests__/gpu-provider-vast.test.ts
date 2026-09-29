import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VastClient } from '@ai-gateway/gpu-providers/vast-client';
import { AbstractGpuProvider } from '@ai-gateway/gpu-providers/abstract-provider';
import type { ProviderCredentials, InstanceSpec } from '@ai-gateway/gpu-providers/types';

const VAST_API_BASE = 'https://console.vast.ai/api/v0';

const creds: ProviderCredentials = { apiKey: 'vast-key-123' };

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchText(text: string, status: number): Response {
  return new Response(text, { status });
}

describe('VastClient', () => {
  let client: VastClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  /** Mock the preflight balance check (Vast checkBalance → /users/current/). */
  const mockPreflight = () => mockFetchResponse({ credit: 100 });

  beforeEach(() => {
    client = new VastClient();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // Prevent Docker Hub calls during createInstance — return fixed disk size
    vi.spyOn(AbstractGpuProvider, 'estimateImageDiskGb').mockResolvedValue(20);
    process.env.VAST_SKIP_IMAGE_PRECHECK = '1';
    // Mock the poll+probe loop to return immediately — avoids 5s initial delay
    // + TCP probe on fake IPs that time out (60s test timeout).
    vi.spyOn(client as any, '_pollForEndpoint').mockResolvedValue({
      endpoint: 'http://5.5.5.5:8000', ip: '5.5.5.5',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constants ────────────────────────────────────────────────────────────

  describe('constants', () => {
    it('providerId is vast', () => {
      expect(client.providerId).toBe('vast');
    });

    it('bootTimeSecs is 600', () => {
      expect(client.bootTimeSecs).toBe(600);
    });
  });

  // ── discoverInstance ──────────────────────────────────────────────────

  describe('discoverInstance', () => {
    it('returns first running instance from listInstances', async () => {
      // listInstances calls /instances/ then /endptjobs/
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse({
          instances: [
            { id: '123', actual_status: 'running', public_ipaddr: '1.2.3.4', ports: { '8000/tcp': [{ HostPort: '18000' }] } },
          ],
        }))
        .mockResolvedValueOnce(mockFetchResponse([])); // endptjobs

      const result = await client.discoverInstance(creds, []);
      expect(result).not.toBeNull();
      expect(result!.instanceId).toBe('inst-123');
      expect(result!.status).toBe('running');
    });

    it('returns null when no running instances', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse({ instances: [{ id: '1', actual_status: 'stopped' }] }))
        .mockResolvedValueOnce(mockFetchResponse([]));

      const result = await client.discoverInstance(creds, []);
      expect(result).toBeNull();
    });
  });

  // ── createInstance ─────────────────────────────────────────────────────

  describe('createInstance', () => {
    const baseSpec: InstanceSpec = { gpuTypes: ['RTX 3090'], dockerImage: 'test/image:latest' };

    it('searches offers and creates instance', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())                                   // preflight balance check
        .mockResolvedValueOnce(mockFetchResponse({                                // search offers
          offers: [{ id: 'offer-1', gpu_name: 'RTX 3090', dph_total: 0.50 }],
        }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true, new_contract: '999' })); // create

      const result = await client.createInstance(baseSpec, creds);
      expect(result.instanceId).toBe('inst-999');
      expect(result.gpuType).toBe('RTX 3090');
      expect(result.status).toBe('booting');
    }, 60000);

    it('throws when no offers available', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())                    // preflight balance check
        .mockResolvedValueOnce(mockFetchResponse({ offers: [] }))  // strict search → empty
        .mockResolvedValueOnce(mockFetchResponse({ offers: [] }))  // relaxed search fallback → empty
        .mockResolvedValueOnce(mockFetchResponse({ offers: [] })); // SSH-only fallback → empty

      await expect(client.createInstance(baseSpec, creds)).rejects.toThrow('No GPUs available on Vast.ai');
    });

    it('throws when search fails', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())                      // preflight balance check
        .mockResolvedValueOnce(mockFetchText('Server Error', 500));  // strict search fails

      await expect(client.createInstance(baseSpec, creds)).rejects.toThrow('Search offers failed');
    });

    it('filters by GPU type in search', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())                    // preflight balance check
        .mockResolvedValueOnce(mockFetchResponse({ offers: [] }))  // strict search → empty
        .mockResolvedValueOnce(mockFetchResponse({ offers: [] }))  // relaxed search fallback → empty
        .mockResolvedValueOnce(mockFetchResponse({ offers: [] })); // SSH-only fallback → empty

      await expect(client.createInstance({ gpuTypes: ['RTX3090'], dockerImage: 'test/image:latest' }, creds)).rejects.toThrow();

      // calls[0] = preflight, calls[1] = first search
      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.gpu_name).toEqual({ in: ['RTX 3090'] }); // Normalized from RTX3090
    });

    it('tries up to 5 offers when earlier ones fail', async () => {
      const offers = Array.from({ length: 5 }, (_, i) => ({
        id: `offer-${i}`, gpu_name: 'RTX 3090', dph_total: 0.50 + i * 0.1,
      }));

      fetchSpy
        .mockResolvedValueOnce(mockPreflight())                // preflight balance check
        .mockResolvedValueOnce(mockFetchResponse({ offers }))  // search offers
        // First 4 fail
        .mockResolvedValueOnce(mockFetchText('not available', 400))
        .mockResolvedValueOnce(mockFetchText('not available', 400))
        .mockResolvedValueOnce(mockFetchText('not available', 400))
        .mockResolvedValueOnce(mockFetchText('not available', 400))
        // 5th succeeds
        .mockResolvedValueOnce(mockFetchResponse({ success: true, new_contract: '555' }));

      const result = await client.createInstance(baseSpec, creds);
      expect(result.instanceId).toBe('inst-555');
    }, 60000);

    it('injects env vars (HF_TOKEN, spec.env)', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())                                   // preflight balance check
        .mockResolvedValueOnce(mockFetchResponse({                                // search offers
          offers: [{ id: 'offer-1', gpu_name: 'RTX 3090', dph_total: 0.50 }],
        }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true, new_contract: '777' })); // create

      await client.createInstance(
        { gpuTypes: ['RTX 3090'], env: { CUSTOM_KEY: 'val' }, dockerImage: 'test/image:latest' },
        { ...creds, hfToken: 'hf_test' },
      );

      // calls[0]=preflight, calls[1]=search, calls[2]=create
      const createBody = JSON.parse(fetchSpy.mock.calls[2][1].body);
      expect(createBody.env.HF_TOKEN).toBe('hf_test');
      expect(createBody.env.CUSTOM_KEY).toBe('val');
      // Port exposure via env dict keys (Vast.ai format: "-p X:X": "1")
      expect(createBody.env['-p 8000:8000']).toBe('1');
      expect(createBody.env['-p 8001:8001/udp']).toBe('1');
    }, 60000);

    it('calls onInstancePersist when userId provided', async () => {
      const onPersist = vi.fn().mockResolvedValue(undefined);
      const clientWithPersist = new VastClient({ onInstancePersist: onPersist });
      // Must mock _pollForEndpoint on the new client too (beforeEach only mocks `client`)
      vi.spyOn(clientWithPersist as any, '_pollForEndpoint').mockResolvedValue({
        endpoint: 'http://2.2.2.2:8000', ip: '2.2.2.2',
      });
      vi.spyOn(AbstractGpuProvider, 'estimateImageDiskGb').mockResolvedValue(20);
      vi.stubGlobal('fetch', fetchSpy);

      fetchSpy
        .mockResolvedValueOnce(mockPreflight())                                   // preflight balance check
        .mockResolvedValueOnce(mockFetchResponse({                                // search offers
          offers: [{ id: 'offer-1', gpu_name: 'RTX 3090', dph_total: 0.50 }],
        }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true, new_contract: '888' })); // create

      await clientWithPersist.createInstance(baseSpec, creds, 'user-1');

      expect(onPersist).toHaveBeenCalledWith('user-1', 'vastInstance', expect.objectContaining({
        instanceId: 'inst-888',
        gpuType: 'RTX 3090',
      }));
    }, 60000);
  });

  // ── startInstance ─────────────────────────────────────────────────────

  describe('startInstance', () => {
    it('PUTs state=running for on-demand instance', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      await client.startInstance('inst-123', creds);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${VAST_API_BASE}/instances/123/`,
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    it('strips prefix before API call', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      await client.startInstance('inst-456', creds);
      expect(fetchSpy.mock.calls[0][0]).toContain('/instances/456/');
    });

    it('ignores "already running" errors', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('instance already running', 400));
      await expect(client.startInstance('inst-123', creds)).resolves.toBeUndefined();
    });

    it('throws on real errors', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('server error', 500));
      await expect(client.startInstance('inst-123', creds)).rejects.toThrow('Vast start failed');
    });
  });

  // ── stopInstance ──────────────────────────────────────────────────────

  describe('stopInstance', () => {
    it('PUTs state=stopped for on-demand instance (pause, not destroy)', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      await client.stopInstance('inst-123', creds);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${VAST_API_BASE}/instances/123/`,
        expect.objectContaining({ method: 'PUT' }),
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.state).toBe('stopped');
    });

    it('DELETEs endpoint via endptjobs API (endpoints can only be deleted)', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      await client.stopInstance('endpt-789', creds);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${VAST_API_BASE}/endptjobs/789/`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('is idempotent for already-stopped instances', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('already stopped', 400));
      await expect(client.stopInstance('inst-123', creds)).resolves.toBeUndefined();
    });

    it('throws on real errors', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Internal Server Error', 500));
      await expect(client.stopInstance('inst-999', creds)).rejects.toThrow('Vast stop failed');
    });
  });

  // ── deleteInstance ────────────────────────────────────────────────────

  describe('deleteInstance', () => {
    it('routes instance to /instances/ DELETE', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      await client.deleteInstance('inst-100', creds);
      expect(fetchSpy.mock.calls[0][0]).toContain('/instances/100/');
    });

    it('routes endpoint to /endptjobs/ DELETE', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      await client.deleteInstance('endpt-200', creds);
      expect(fetchSpy.mock.calls[0][0]).toContain('/endptjobs/200/');
    });

    it('bare id treated as instance', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      await client.deleteInstance('300', creds);
      expect(fetchSpy.mock.calls[0][0]).toContain('/instances/300/');
    });
  });

  // ── listInstances ─────────────────────────────────────────────────────

  describe('listInstances', () => {
    it('combines on-demand + serverless instances', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse({
          instances: [
            { id: '10', actual_status: 'running', public_ipaddr: '1.1.1.1', direct_port_start: 18000, ports: { '8000/tcp': [{ HostPort: '18000' }] }, gpu_name: 'RTX 3090' },
          ],
        }))
        .mockResolvedValueOnce(mockFetchResponse([
          { id: '20', endpoint_name: 'my-endpoint', endpoint_url: 'https://vast.ai/ep/20', current_workers: 2, gpu_name: 'A100' },
        ]));

      const result = await client.listInstances(creds);
      expect(result).toHaveLength(2);
      expect(result[0].instanceId).toBe('inst-10');
      expect(result[0].endpoint).toBe('http://1.1.1.1:18000');
      expect(result[1].instanceId).toBe('endpt-20');
      expect(result[1].status).toBe('running');
    });

    it('parses Docker port format', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse({
          instances: [
            { id: '1', actual_status: 'running', public_ipaddr: '2.2.2.2', direct_port_start: 28000, ports: { '8000/tcp': [{ HostPort: '28000' }] } },
          ],
        }))
        .mockResolvedValueOnce(mockFetchResponse([]));

      const result = await client.listInstances(creds);
      expect(result[0].endpoint).toBe('http://2.2.2.2:28000');
    });

    it('falls back to direct_port_start', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse({
          instances: [
            { id: '1', actual_status: 'running', public_ipaddr: '3.3.3.3', direct_port_start: 9000 },
          ],
        }))
        .mockResolvedValueOnce(mockFetchResponse([]));

      const result = await client.listInstances(creds);
      expect(result[0].endpoint).toBe('http://3.3.3.3:9000');
    });

    it('returns empty on errors', async () => {
      fetchSpy
        .mockRejectedValueOnce(new Error('network'))
        .mockRejectedValueOnce(new Error('network'));

      const result = await client.listInstances(creds);
      expect(result).toEqual([]);
    });

    it('endpoint workers > 0 = running, 0 = unknown', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse({ instances: [] }))
        .mockResolvedValueOnce(mockFetchResponse([
          { id: '30', current_workers: 0, endpoint_name: 'idle-ep' },
          { id: '31', current_workers: 3, endpoint_name: 'active-ep' },
        ]));

      const result = await client.listInstances(creds);
      expect(result.find(r => r.instanceId === 'endpt-30')!.status).toBe('unknown');
      expect(result.find(r => r.instanceId === 'endpt-31')!.status).toBe('running');
    });
  });

  // ── getInstanceStatus ─────────────────────────────────────────────────

  describe('getInstanceStatus', () => {
    it('returns worker-based status for endpoints', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ current_workers: 2 }));
      expect(await client.getInstanceStatus('endpt-50', creds)).toBe('running');
    });

    it('returns unknown for endpoint with no workers', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ current_workers: 0 }));
      expect(await client.getInstanceStatus('endpt-50', creds)).toBe('unknown');
    });

    it('returns status from instance detail for on-demand', async () => {
      // First try: GET /instances/60/ → returns null (Vast.ai quirk)
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ instances: null }));
      // Fallback: GET /instances/ → list all, find id=60
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({
        instances: [{ id: '60', actual_status: 'running', public_ipaddr: '4.4.4.4' }],
      }));
      expect(await client.getInstanceStatus('inst-60', creds)).toBe('running');
    });

    it('uses individual endpoint when it returns valid data', async () => {
      // GET /instances/60/ → returns valid instance object
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({
        instances: { id: '60', actual_status: 'running', public_ipaddr: '4.4.4.4' },
      }));
      expect(await client.getInstanceStatus('inst-60', creds)).toBe('running');
      // Only 1 fetch call (no list fallback needed)
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null on error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('timeout'));
      // Fallback also fails
      fetchSpy.mockRejectedValueOnce(new Error('timeout'));
      expect(await client.getInstanceStatus('inst-99', creds)).toBeNull();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles missing ports gracefully in listInstances', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse({
          instances: [{ id: '1', actual_status: 'loading', public_ipaddr: '5.5.5.5' }],
        }))
        .mockResolvedValueOnce(mockFetchResponse([]));

      const result = await client.listInstances(creds);
      // No ports assigned yet (loading state) → empty endpoint (more correct than guessing :8000)
      expect(result[0].endpoint).toBe('');
      expect(result[0].ipAddress).toBe('5.5.5.5');
    });

    it('handles instances without IP', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse({
          instances: [{ id: '2', actual_status: 'loading' }],
        }))
        .mockResolvedValueOnce(mockFetchResponse([]));

      const result = await client.listInstances(creds);
      expect(result[0].endpoint).toBe('');
    });
  });

  // ── rebootInstance ──────────────────────────────────────────────────────

  describe('rebootInstance', () => {
    it('PUTs to /instances/reboot/{id}/', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ success: true }));
      await client.rebootInstance('inst-123', creds);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${VAST_API_BASE}/instances/reboot/123/`,
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    it('skips reboot for serverless endpoints', async () => {
      await client.rebootInstance('endpt-456', creds);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws on API error', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Instance not found', 404));
      await expect(client.rebootInstance('inst-999', creds)).rejects.toThrow('Vast reboot failed');
    });
  });

  // ── takeSnapshot ────────────────────────────────────────────────────────

  describe('takeSnapshot', () => {
    it('calls execute API with take_snapshot command', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({
        success: true,
        result_url: 'https://vast.ai/snapshots/123',
      }));
      const result = await client.takeSnapshot('inst-123', creds);
      expect(result).toBe('https://vast.ai/snapshots/123');
      expect(fetchSpy).toHaveBeenCalledWith(
        `${VAST_API_BASE}/instances/command/123/`,
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    it('returns null for endpoints', async () => {
      const result = await client.takeSnapshot('endpt-456', creds);
      expect(result).toBeNull();
    });

    it('throws on API error', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Not running', 400));
      await expect(client.takeSnapshot('inst-999', creds)).rejects.toThrow('Vast snapshot failed');
    });
  });

  // ── template and cancel_unavail ──────────────────────────────────────────

  describe('createInstance with template', () => {
    it.skip('passes template_hash_id in create body', async () => {
      // URL-based mock to handle any fetch order (image size lookup, search, create, poll)
      fetchSpy.mockImplementation((url: string, opts?: any) => {
        if (url.includes('/bundles/')) return Promise.resolve(mockFetchResponse({ offers: [{ id: 'offer-1', gpu_name: 'RTX 3090', dph_total: 0.50 }] }));
        if (url.includes('/asks/')) return Promise.resolve(mockFetchResponse({ success: true, new_contract: '111' }));
        if (url.includes('/instances/')) return Promise.resolve(mockFetchResponse({ instances: { id: '111', actual_status: 'running', public_ipaddr: '1.1.1.1', direct_port_start: 8000 } }));
        return Promise.resolve(mockFetchResponse({})); // Docker Hub, etc.
      });

      await client.createInstance(
        { gpuTypes: ['RTX 3090'], templateHashId: 'tpl_abc123', dockerImage: 'test/image:latest' },
        creds,
      );

      // Find the PUT call (create instance) — index varies due to image size lookup
      const createCall = fetchSpy.mock.calls.find((c: any[]) => c[1]?.method === 'PUT' && c[0]?.includes('/asks/'));
      expect(createCall).toBeDefined();
      const createBody = JSON.parse(createCall![1].body);
      expect(createBody.template_hash_id).toBe('tpl_abc123');
      expect(createBody.cancel_unavail).toBe(true);
    }, 60000);
  });
});
