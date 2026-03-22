import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TensordockClient,
  GPU_ID_MAP,
  TENSORDOCK_V2_BASE,
  findSshKey,
  findCheapestLocations,
  type HostnodeCandidate,
  type SshKeyInfo,
} from '@ai-gateway/gpu-providers/tensordock-client';
import type { ProviderCredentials, InstanceSpec } from '@ai-gateway/gpu-providers/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

const creds: ProviderCredentials = {
  apiKey: 'test-api-key',
  authId: 'test-auth-id',
};

const credsNoAuth: ProviderCredentials = {
  apiKey: 'test-api-key',
};

describe('TensordockClient', () => {
  let client: TensordockClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = new TensordockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constants ───────────────────────────────────────────────────────────

  describe('constants', () => {
    it('GPU_ID_MAP has correct mappings', () => {
      expect(GPU_ID_MAP['RTX3090']).toBe('geforcertx3090-pcie-24gb');
      expect(GPU_ID_MAP['RTX4090']).toBe('geforcertx4090-pcie-24gb');
      expect(GPU_ID_MAP['rtx3090-pcie-24gb']).toBe('geforcertx3090-pcie-24gb');
    });

    it('providerId is tensordock', () => {
      expect(client.providerId).toBe('tensordock');
    });

    it('bootTimeSecs is 1200', () => {
      expect(client.bootTimeSecs).toBe(1200);
    });
  });

  // ── findSshKey ──────────────────────────────────────────────────────────

  describe('findSshKey', () => {
    const headers = { Authorization: 'Bearer test' };

    it('returns SSH key when found', async () => {
      // First call: list secrets
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          secrets: [
            { id: 'key-123', type: 'SSHKEY' },
          ],
        },
      }));
      // Second call: secret detail
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: { attributes: { value: 'ssh-ed25519 AAAA...' } },
      }));

      const result = await findSshKey(headers);
      expect(result).toBeDefined();
      expect(result!.id).toBe('key-123');
      expect(result!.publicKey).toBe('ssh-ed25519 AAAA...');
    });

    it('returns undefined when no secrets', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ data: { secrets: [] } }));
      const result = await findSshKey(headers);
      expect(result).toBeUndefined();
    });

    it('returns undefined on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(textResponse('error', 500));
      const result = await findSshKey(headers);
      expect(result).toBeUndefined();
    });

    it('returns undefined on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network down'));
      const result = await findSshKey(headers);
      expect(result).toBeUndefined();
    });

    it('handles attributes.type = SSHKEY format', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          secrets: [
            { id: 'key-456', attributes: { type: 'SSHKEY' } },
          ],
        },
      }));
      fetchSpy.mockResolvedValueOnce(jsonResponse({ data: { value: 'ssh-rsa BBBB...' } }));

      const result = await findSshKey(headers);
      expect(result!.id).toBe('key-456');
      expect(result!.publicKey).toBe('ssh-rsa BBBB...');
    });

    it('returns key with no publicKey when detail fetch fails', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: { secrets: [{ id: 'key-789', type: 'SSHKEY' }] },
      }));
      fetchSpy.mockRejectedValueOnce(new Error('detail fail'));

      const result = await findSshKey(headers);
      expect(result!.id).toBe('key-789');
      expect(result!.publicKey).toBeUndefined();
    });
  });

  // ── findCheapestLocations ───────────────────────────────────────────────

  describe('findCheapestLocations', () => {
    const headers = { Authorization: 'Bearer test' };

    it('returns sorted candidates', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          hostnodes: [
            {
              location_id: 'loc-b',
              location: { city: 'London' },
              available_resources: {
                gpus: [{ v0Name: 'gpu-a', availableCount: 1, price_per_hr: 2.0 }],
                available_ports: [20000, 20001, 20002],
                max_vcpus_per_gpu: 8,
                max_ram_per_gpu: 32,
              },
            },
            {
              location_id: 'loc-a',
              location: { city: 'Paris' },
              available_resources: {
                gpus: [{ v0Name: 'gpu-a', availableCount: 2, price_per_hr: 1.0 }],
                available_ports: [30000, 30001, 30002],
                max_vcpus_per_gpu: 4,
                max_ram_per_gpu: 16,
              },
            },
          ],
        },
      }));

      const result = await findCheapestLocations('gpu-a', headers);
      expect(result).toHaveLength(2);
      expect(result[0].price).toBe(1.0);
      expect(result[0].city).toBe('Paris');
      expect(result[1].price).toBe(2.0);
    });

    it('filters by minPorts', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          hostnodes: [
            {
              location_id: 'loc-a',
              location: { city: 'Berlin' },
              available_resources: {
                gpus: [{ v0Name: 'gpu-x', availableCount: 1, price_per_hr: 1.0 }],
                available_ports: [20000], // only 1 port
                max_vcpus_per_gpu: 4,
                max_ram_per_gpu: 16,
              },
            },
          ],
        },
      }));

      const result = await findCheapestLocations('gpu-x', headers, 2);
      expect(result).toHaveLength(0);
    });

    it('returns empty on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(textResponse('error', 500));
      const result = await findCheapestLocations('gpu-a', headers);
      expect(result).toHaveLength(0);
    });

    it('returns empty on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('timeout'));
      const result = await findCheapestLocations('gpu-a', headers);
      expect(result).toHaveLength(0);
    });

    it('skips nodes with 0 availableCount', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          hostnodes: [
            {
              location_id: 'loc-a',
              location: { city: 'Tokyo' },
              available_resources: {
                gpus: [{ v0Name: 'gpu-a', availableCount: 0, price_per_hr: 0.5 }],
                available_ports: [20000, 20001, 20002],
              },
            },
          ],
        },
      }));

      const result = await findCheapestLocations('gpu-a', headers);
      expect(result).toHaveLength(0);
    });
  });

  // ── discoverInstance ────────────────────────────────────────────────────

  describe('discoverInstance', () => {
    it('returns running VM from v2 API', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: [{
          id: 'vm-1',
          attributes: {
            status: 'running',
            ip_address: '10.0.0.1',
            port_forwards: [{ internal_port: 8000, external_port: 20002 }],
          },
        }],
      }));

      const result = await client.discoverInstance(creds, ['RTX3090']);
      expect(result).toBeDefined();
      expect(result!.instanceId).toBe('vm-1');
      expect(result!.endpoint).toBe('http://10.0.0.1:20002');
      expect(result!.status).toBe('running');
    });

    it('returns VM with ip but no 8000 port_forward (uses default :8000)', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: [{
          id: 'vm-2',
          attributes: {
            status: 'running',
            ip_address: '10.0.0.2',
            port_forwards: [],
          },
        }],
      }));

      const result = await client.discoverInstance(creds, ['RTX3090']);
      expect(result).toBeDefined();
      expect(result!.endpoint).toBe('http://10.0.0.2:8000');
    });

    it('returns null when no VMs exist', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ data: [] }));
      const result = await client.discoverInstance(creds, ['RTX3090']);
      expect(result).toBeNull();
    });

    it('returns null on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(textResponse('unauthorized', 401));
      const result = await client.discoverInstance(creds, ['RTX3090']);
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await client.discoverInstance(creds, ['RTX3090']);
      expect(result).toBeNull();
    });

    it('prefers running VM over non-running', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: [
          {
            id: 'vm-stopped',
            attributes: { status: 'stopped', ip_address: '10.0.0.1', port_forwards: [] },
          },
          {
            id: 'vm-running',
            attributes: { status: 'running', ip_address: '10.0.0.2', port_forwards: [] },
          },
        ],
      }));

      const result = await client.discoverInstance(creds, ['RTX3090']);
      expect(result!.instanceId).toBe('vm-running');
    });

    it('returns VM with non-8000 port_forward (endpoint defaults to :8000)', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: [{
          id: 'vm-1',
          attributes: {
            status: 'running',
            ip_address: '10.0.0.1',
            port_forwards: [{ internal_port: 9090, external_port: 20001 }],
          },
        }],
      }));

      const result = await client.discoverInstance(creds, ['RTX3090']);
      // No 8000 port_forward → falls back to default :8000
      expect(result!.endpoint).toBe('http://10.0.0.1:8000');
    });
  });

  // ── createInstance ──────────────────────────────────────────────────────

  describe('createInstance', () => {
    const spec: InstanceSpec = {
      dockerImage: 'marcosremar/parle-s2s:latest',
      gpuTypes: ['RTX3090'],
    };

    function mockCreateDeps() {
      // 1. findSshKey: list secrets
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: { secrets: [{ id: 'ssh-1', type: 'SSHKEY' }] },
      }));
      // 2. findSshKey: secret detail
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: { attributes: { value: 'ssh-ed25519 AAAA...' } },
      }));
    }

    function mockCandidatesAndCreate(ip = '10.0.0.5') {
      // 3. findCheapestLocations
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          hostnodes: [{
            location_id: 'loc-1',
            location: { city: 'Paris' },
            available_resources: {
              gpus: [{ v0Name: 'geforcertx3090-pcie-24gb', availableCount: 1, price_per_hr: 0.5 }],
              available_ports: [20000, 20001, 20002],
              max_vcpus_per_gpu: 8,
              max_ram_per_gpu: 32,
            },
          }],
        },
      }));
      // 4. create POST
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          id: 'new-vm-1',
          attributes: {
            status: 'creating',
            ip_address: ip,
            port_forwards: [
              { internal_port: 22, external_port: 20000 },
              { internal_port: 9090, external_port: 20001 },
              { internal_port: 8000, external_port: 20002 },
            ],
          },
        },
      }));
    }

    it('requires SSH key', async () => {
      // findSshKey returns nothing
      fetchSpy.mockResolvedValueOnce(jsonResponse({ data: { secrets: [] } }));

      await expect(client.createInstance(spec, creds)).rejects.toThrow('SSH key');
    });

    it('creates instance with GPU fallback chain', async () => {
      mockCreateDeps();
      mockCandidatesAndCreate();

      const result = await client.createInstance(spec, creds);
      expect(result.instanceId).toBe('new-vm-1');
      expect(result.endpoint).toBe('http://10.0.0.5:20002');
      expect(result.status).toBe('creating');
    });

    it('calls onInstancePersist when userId provided', async () => {
      const onPersist = vi.fn().mockResolvedValue(undefined);
      const clientWithPersist = new TensordockClient({ onInstancePersist: onPersist });
      mockCreateDeps();
      mockCandidatesAndCreate();

      await clientWithPersist.createInstance(spec, creds, 'user-1');
      expect(onPersist).toHaveBeenCalledWith('user-1', 'tensordockInstance', expect.objectContaining({
        instanceId: 'new-vm-1',
        endpoint: 'http://10.0.0.5:20002',
      }));
    });

    it('uses spec.machineKey for persist callback', async () => {
      const onPersist = vi.fn().mockResolvedValue(undefined);
      const clientWithPersist = new TensordockClient({ onInstancePersist: onPersist });
      mockCreateDeps();
      mockCandidatesAndCreate();

      await clientWithPersist.createInstance({ ...spec, machineKey: 'tensordockInstance' as const }, creds, 'user-1');
      expect(onPersist).toHaveBeenCalledWith('user-1', 'mySlot', expect.anything());
    });

    it('throws when all GPU types exhausted', async () => {
      mockCreateDeps();
      // No candidates for RTX3090
      fetchSpy.mockResolvedValueOnce(jsonResponse({ data: { hostnodes: [] } }));

      await expect(client.createInstance(spec, creds)).rejects.toThrow('No GPUs available on TensorDock');
    });

    it('tries default GPU_FALLBACK when no gpuTypes in spec', async () => {
      mockCreateDeps();
      // RTX3090 has no candidates
      fetchSpy.mockResolvedValueOnce(jsonResponse({ data: { hostnodes: [] } }));
      // RTX4090 has candidates
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          hostnodes: [{
            location_id: 'loc-1',
            location: { city: 'London' },
            available_resources: {
              gpus: [{ v0Name: 'geforcertx4090-pcie-24gb', availableCount: 1, price_per_hr: 1.0 }],
              available_ports: [20000, 20001, 20002],
              max_vcpus_per_gpu: 4,
              max_ram_per_gpu: 16,
            },
          }],
        },
      }));
      // create
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          id: 'fallback-vm',
          attributes: {
            status: 'creating',
            ip_address: '10.0.0.6',
            port_forwards: [
              { internal_port: 22, external_port: 20000 },
              { internal_port: 9090, external_port: 20001 },
              { internal_port: 8000, external_port: 20002 },
            ],
          },
        },
      }));

      const result = await client.createInstance({ dockerImage: 'test' }, creds);
      expect(result.instanceId).toBe('fallback-vm');
    });

    it('skips failed create attempts and tries next candidate', async () => {
      mockCreateDeps();
      // Two candidates
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          hostnodes: [
            {
              location_id: 'loc-fail',
              location: { city: 'Rzeszow' },
              available_resources: {
                gpus: [{ v0Name: 'geforcertx3090-pcie-24gb', availableCount: 1, price_per_hr: 0.3 }],
                available_ports: [20000, 20001, 20002],
                max_vcpus_per_gpu: 4,
                max_ram_per_gpu: 16,
              },
            },
            {
              location_id: 'loc-ok',
              location: { city: 'Ontario' },
              available_resources: {
                gpus: [{ v0Name: 'geforcertx3090-pcie-24gb', availableCount: 1, price_per_hr: 0.5 }],
                available_ports: [30000, 30001, 30002],
                max_vcpus_per_gpu: 8,
                max_ram_per_gpu: 32,
              },
            },
          ],
        },
      }));
      // First create fails
      fetchSpy.mockResolvedValueOnce(textResponse('capacity exceeded', 503));
      // Second create succeeds
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          id: 'ok-vm',
          attributes: {
            status: 'creating',
            ip_address: '10.0.0.7',
            port_forwards: [
              { internal_port: 22, external_port: 30000 },
              { internal_port: 9090, external_port: 30001 },
              { internal_port: 8000, external_port: 30002 },
            ],
          },
        },
      }));

      const result = await client.createInstance(spec, creds);
      expect(result.instanceId).toBe('ok-vm');
      expect(result.endpoint).toBe('http://10.0.0.7:30002');
    });

    it('polls for IP when not in create response', async () => {
      mockCreateDeps();
      // Candidates
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          hostnodes: [{
            location_id: 'loc-1',
            location: { city: 'Paris' },
            available_resources: {
              gpus: [{ v0Name: 'geforcertx3090-pcie-24gb', availableCount: 1, price_per_hr: 0.5 }],
              available_ports: [20000, 20001, 20002],
              max_vcpus_per_gpu: 4,
              max_ram_per_gpu: 16,
            },
          }],
        },
      }));
      // Create returns no IP
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          id: 'poll-vm',
          attributes: {
            status: 'creating',
            ip_address: '',
            port_forwards: [],
          },
        },
      }));
      // Poll attempt 1: no IP yet
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: { attributes: { ip_address: '', port_forwards: [] } },
      }));
      // Poll attempt 2: IP available
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          attributes: {
            ip_address: '10.0.0.8',
            port_forwards: [
              { internal_port: 8000, external_port: 20002 },
            ],
          },
        },
      }));

      const result = await client.createInstance(spec, creds);
      expect(result.instanceId).toBe('poll-vm');
      expect(result.endpoint).toBe('http://10.0.0.8:20002');
    }, 60_000);

    it('respects spec.vcpus and spec.ramGb', async () => {
      mockCreateDeps();
      mockCandidatesAndCreate();

      await client.createInstance({ ...spec, vcpus: 2, ramGb: 8, storageGb: 50 }, creds);

      // Find the v2 create call (should be the 4th call)
      const createCall = fetchSpy.mock.calls.find(
        (c: [string, RequestInit]) => typeof c[0] === 'string' && c[0].endsWith('/instances') && c[1]?.method === 'POST',
      );
      expect(createCall).toBeDefined();
      const body = JSON.parse(createCall![1].body as string);
      expect(body.data.attributes.resources.vcpu_count).toBe(2);
      expect(body.data.attributes.resources.ram_gb).toBe(8);
      expect(body.data.attributes.resources.storage_gb).toBe(50);
    });
  });

  // ── startInstance ───────────────────────────────────────────────────────

  describe('startInstance', () => {
    it('starts via v2 API', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));

      await client.startInstance('vm-1', creds);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${TENSORDOCK_V2_BASE}/instances/vm-1/start`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('treats 409 as already running', async () => {
      fetchSpy.mockResolvedValueOnce(textResponse('already running', 409));
      await expect(client.startInstance('vm-1', creds)).resolves.toBeUndefined();
    });

    it('treats "already running" in body as success', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('already running', { status: 400 }));
      await expect(client.startInstance('vm-1', creds)).resolves.toBeUndefined();
    });

    it('throws not found for 404', async () => {
      fetchSpy.mockResolvedValueOnce(textResponse('not found', 404));
      await expect(client.startInstance('vm-1', creds)).rejects.toThrow('not found');
    });

    it('falls back to v0 when v2 fails and authId present', async () => {
      // v2 fails
      fetchSpy.mockResolvedValueOnce(textResponse('server error', 500));
      // v0 succeeds
      fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true }));

      await client.startInstance('vm-1', creds);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('throws GPU slot expired on dual 400', async () => {
      // v2 returns 400
      fetchSpy.mockResolvedValueOnce(textResponse('cannot start', 400));
      // v0 returns 400
      fetchSpy.mockResolvedValueOnce(textResponse('cannot start', 400));

      await expect(client.startInstance('vm-1', creds)).rejects.toThrow('GPU slot');
    });

    it('silently succeeds on v2 non-throwing failure without authId (no v0 fallback)', async () => {
      // v2 returns 500 (non-ok) but code doesn't throw for generic errors —
      // only network errors throw in the catch block
      fetchSpy.mockResolvedValueOnce(textResponse('server error', 500));
      await expect(client.startInstance('vm-1', credsNoAuth)).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1); // no v0 fallback attempt
    });

    it('throws on v2 network error without authId', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(client.startInstance('vm-1', credsNoAuth)).rejects.toThrow('ECONNREFUSED');
    });
  });

  // ── stopInstance ────────────────────────────────────────────────────────

  describe('stopInstance', () => {
    it('stops via v2 API', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));

      await client.stopInstance('vm-1', creds);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${TENSORDOCK_V2_BASE}/instances/vm-1/stop`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(textResponse('error', 500));
      await expect(client.stopInstance('vm-1', creds)).rejects.toThrow('stop failed');
    });
  });

  // ── deleteInstance ──────────────────────────────────────────────────────

  describe('deleteInstance', () => {
    it('deletes via v2 API', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));

      await client.deleteInstance('vm-1', creds);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${TENSORDOCK_V2_BASE}/instances/vm-1`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('throws on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(textResponse('not found', 404));
      await expect(client.deleteInstance('vm-1', creds)).rejects.toThrow('delete failed');
    });
  });

  // ── listInstances ──────────────────────────────────────────────────────

  describe('listInstances', () => {
    it('returns instances from v2 API', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: [
          {
            id: 'vm-1',
            attributes: {
              name: 'my-vm',
              status: 'running',
              ip_address: '10.0.0.1',
              port_forwards: [{ internal_port: 8000, external_port: 20002 }],
            },
          },
        ],
      }));

      const result = await client.listInstances(creds);
      expect(result).toHaveLength(1);
      expect(result[0].instanceId).toBe('vm-1');
      expect(result[0].endpoint).toBe('http://10.0.0.1:20002');
    });

    it('returns instances from v2 (single API, no v0 fallback)', async () => {
      // v2 returns instances
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: [
          {
            id: 'v2-vm',
            attributes: {
              name: 'v2-instance',
              status: 'running',
              ip_address: '10.0.0.2',
              port_forwards: [{ internal_port: 8000, external_port: 30002 }],
            },
          },
        ],
      }));

      const result = await client.listInstances(creds);
      expect(result).toHaveLength(1);
      expect(result[0].instanceId).toBe('v2-vm');
      expect(result[0].endpoint).toBe('http://10.0.0.2:30002');
    });

    it('uses v2 only when no authId', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: [
          {
            id: 'v2-only',
            attributes: {
              name: 'test',
              status: 'running',
              ip_address: '10.0.0.3',
              port_forwards: [],
            },
          },
        ],
      }));

      const result = await client.listInstances(credsNoAuth);
      expect(result).toHaveLength(1);
      expect(result[0].instanceId).toBe('v2-only');
      // No port forwards → default 8000
      expect(result[0].endpoint).toBe('http://10.0.0.3:8000');
    });

    it('returns empty on v2 error', async () => {
      // v2 fails
      fetchSpy.mockResolvedValueOnce(textResponse('error', 500));

      const result = await client.listInstances(creds);
      expect(result).toHaveLength(0);
    });

    it('parses v2 port_forwards correctly', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: [
          {
            id: 'pf-vm',
            attributes: {
              status: 'running',
              ip_address: '10.0.0.4',
              port_forwards: [
                { internal_port: 22, external_port: 20000 },
                { internal_port: 9090, external_port: 20001 },
                { internal_port: 8000, external_port: 20002 },
              ],
            },
          },
        ],
      }));

      const result = await client.listInstances(credsNoAuth);
      expect(result[0].endpoint).toBe('http://10.0.0.4:20002');
    });
  });

  // ── getInstanceStatus ───────────────────────────────────────────────────

  describe('getInstanceStatus', () => {
    it('returns status from v2 when found', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: { attributes: { status: 'running' } },
      }));

      const result = await client.getInstanceStatus('vm-1', creds);
      expect(result).toBe('running');
    });

    it('returns null when not found (v2 404)', async () => {
      fetchSpy.mockResolvedValueOnce(textResponse('not found', 404));

      const result = await client.getInstanceStatus('vm-1', creds);
      expect(result).toBeNull();
    });

    it('returns status from v2 directly', async () => {
      // v2 returns status
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: { attributes: { status: 'stopped' } },
      }));

      const result = await client.getInstanceStatus('vm-1', creds);
      expect(result).toBe('stopped');
    });

    it('uses v2 directly when no authId', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: { attributes: { status: 'running' } },
      }));

      const result = await client.getInstanceStatus('vm-1', credsNoAuth);
      expect(result).toBe('running');
    });

    it('returns null on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('timeout'));
      const result = await client.getInstanceStatus('vm-1', credsNoAuth);
      expect(result).toBeNull();
    });
  });

  // ── checkHealth ───────────────────────────────────────────────────────

  describe('checkHealth', () => {
    it('returns true when monitor reports app healthy', async () => {
      // v2 instance detail
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          attributes: {
            ip_address: '10.0.0.1',
            port_forwards: [
              { internal_port: 9090, external_port: 20001 },
              { internal_port: 8000, external_port: 20002 },
            ],
          },
        },
      }));
      // Monitor /health
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        phase: 'ready',
        progress_pct: 100,
        elapsed_secs: 120,
        error: null,
        healthy: true,
        status: 'ready',
      }));

      const result = await client.checkHealth('vm-1', creds);
      expect(result).toBe(true);
    });

    it('returns false when monitor reports setup in progress', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          attributes: {
            ip_address: '10.0.0.1',
            port_forwards: [{ internal_port: 9090, external_port: 20001 }],
          },
        },
      }));
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        phase: 'pulling_image',
        progress_pct: 30,
        healthy: false,
      }));

      const result = await client.checkHealth('vm-1', creds);
      expect(result).toBe(false);
    });

    it('returns false when monitor reports failed', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          attributes: {
            ip_address: '10.0.0.1',
            port_forwards: [{ internal_port: 9090, external_port: 20001 }],
          },
        },
      }));
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        phase: 'failed',
        error: 'docker pull failed',
        healthy: false,
      }));

      const result = await client.checkHealth('vm-1', creds);
      expect(result).toBe(false);
    });

    it('returns false when instance detail not available', async () => {
      fetchSpy.mockResolvedValueOnce(textResponse('not found', 404));
      const result = await client.checkHealth('vm-1', creds);
      expect(result).toBe(false);
    });

    it('returns false when no monitor port forward', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          attributes: {
            ip_address: '10.0.0.1',
            port_forwards: [{ internal_port: 8000, external_port: 20002 }],
          },
        },
      }));

      const result = await client.checkHealth('vm-1', creds);
      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await client.checkHealth('vm-1', creds);
      expect(result).toBe(false);
    });
  });

  // ── getInstanceLogs ───────────────────────────────────────────────────

  describe('getInstanceLogs', () => {
    it('returns debug output from monitor root endpoint', async () => {
      // v2 instance detail
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          attributes: {
            ip_address: '10.0.0.1',
            port_forwards: [
              { internal_port: 9090, external_port: 20001 },
            ],
          },
        },
      }));
      // Monitor root /
      const debugData = {
        setup: 'log content here...',
        gpu: 'RTX 3090, 2048/24576 MiB',
        state: { phase: 'ready', progress_pct: 100 },
      };
      fetchSpy.mockResolvedValueOnce(jsonResponse(debugData));

      const result = await client.getInstanceLogs('vm-1', creds);
      expect(result).toBeDefined();
      const parsed = JSON.parse(result!);
      expect(parsed.gpu).toContain('RTX 3090');
      expect(parsed.state.phase).toBe('ready');
    });

    it('returns null when instance not found', async () => {
      fetchSpy.mockResolvedValueOnce(textResponse('not found', 404));
      const result = await client.getInstanceLogs('vm-1', creds);
      expect(result).toBeNull();
    });

    it('returns null when no monitor port', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        data: {
          attributes: {
            ip_address: '10.0.0.1',
            port_forwards: [{ internal_port: 8000, external_port: 20002 }],
          },
        },
      }));

      const result = await client.getInstanceLogs('vm-1', creds);
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('timeout'));
      const result = await client.getInstanceLogs('vm-1', creds);
      expect(result).toBeNull();
    });
  });
});
