import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScalewayClient } from '../../src/cpu-providers/scaleway-client';

const FAKE_SECRET = 'scw-secret-xxxxxxxxxxxxxxxxxx';

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

function mockErrorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ScalewayClient', () => {
  describe('constructor', () => {
    it('creates instance with default options', () => {
      const client = new ScalewayClient();
      expect(client.providerId).toBe('scaleway');
      expect(client.bootTimeSecs).toBe(90);
    });

    it('accepts logger option', () => {
      const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const client = new ScalewayClient({ logger: log as any });
      expect(client.providerId).toBe('scaleway');
    });
  });

  describe('auth headers', () => {
    it('uses X-Auth-Token header (not Bearer)', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET };

      // Mock responses in call order: findUbuntuImage, then resolveProjectId (which may fail without authId)
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ images: [{ id: 'img-uuid', name: 'Ubuntu 24.04' }] }),
      );
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ default_project_id: 'proj-123' }),
      );
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ server: { id: 'srv-1', name: 'test', state: 'running', commercial_type: 'DEV1-L' } }),
      );
      mockFetch.mockResolvedValueOnce(mockJsonResponse({}));
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ server: { id: 'srv-1', name: 'test', state: 'running', public_ip: { address: '1.2.3.4' } } }),
      );

      try {
        await client.createInstance({ region: 'fr-par-1' }, creds);
      } catch {
        // may fail on project resolution if authId missing, but we already asserted headers
      }

      const calls = mockFetch.mock.calls;
      for (const call of calls) {
        const opts = call[1] as RequestInit;
        const headers = opts?.headers as Record<string, string>;
        if (headers) {
          expect(headers['X-Auth-Token']).toBe(FAKE_SECRET);
          expect(headers['Authorization']).toBeUndefined();
        }
      }
    });
  });

  describe('createInstance()', () => {
    it('calls correct Scaleway API endpoint', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET, authId: 'SCW-access-key' };

      // Mock responses in call order: findUbuntuImage, resolveProjectId, create, poweron, waitForIp
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ images: [{ id: 'img-uuid', name: 'Ubuntu 24.04' }] }),
      );
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ default_project_id: 'proj-123' }),
      );
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ server: { id: 'srv-1', name: 'test', state: 'running', commercial_type: 'DEV1-XL' } }),
      );
      mockFetch.mockResolvedValueOnce(mockJsonResponse({}));
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ server: { id: 'srv-1', name: 'test', state: 'running', public_ip: { address: '1.2.3.4' } } }),
      );

      const result = await client.createInstance({ region: 'fr-par-1' }, creds);

      expect(result.instanceId).toContain('fr-par-1:srv-1');
      expect(result.ipAddress).toBe('1.2.3.4');
      expect(result.status).toBe('booting');

      const createCall = mockFetch.mock.calls[2];
      expect(createCall[0]).toContain('https://api.scaleway.com/instance/v1/zones/fr-par-1/servers');
      expect((createCall[1] as RequestInit).method).toBe('POST');
    });

    it('throws on API error', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET, authId: 'SCW-access-key' };

      // Mock responses in call order: findUbuntuImage, resolveProjectId, create (error)
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ images: [{ id: 'img-uuid', name: 'Ubuntu 24.04' }] }),
      );
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ default_project_id: 'proj-123' }),
      );
      mockFetch.mockResolvedValueOnce(
        mockErrorResponse(400, 'Bad request'),
      );

      await expect(client.createInstance({ region: 'fr-par-1' }, creds)).rejects.toThrow();
    });

    it('creates L4 GPU with sbs_volume and GPU image UUID', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET, authId: 'SCW-access-key' };
      const gpuImage = '3307b9e4-3cfa-49b5-896e-ce914e4ef4aa';

      // projectId override → no IAM/ubuntu lookup: create, poweron, waitForIp
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          server: {
            id: 'srv-l4',
            name: 'qwen-tts',
            state: 'stopped',
            commercial_type: 'L4-1-24G',
            volumes: { '0': { id: 'vol-1' } },
          },
        }),
      );
      mockFetch.mockResolvedValueOnce(mockJsonResponse({})); // poweron
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          server: {
            id: 'srv-l4',
            name: 'qwen-tts',
            state: 'running',
            commercial_type: 'L4-1-24G',
            public_ip: { address: '5.6.7.8' },
          },
        }),
      );

      const result = await client.createInstance(
        {
          region: 'fr-par-2',
          commercialType: 'L4-1-24G',
          label: 'qwen-tts',
          projectId: 'proj-123',
        },
        creds,
      );

      expect(result.instanceId).toBe('fr-par-2:srv-l4');
      expect(result.providerMeta).toMatchObject({
        provider: 'scaleway',
        commercialType: 'L4-1-24G',
        volumeIds: ['vol-1'],
      });

      const createCall = mockFetch.mock.calls[0];
      expect(createCall[0]).toContain('/zones/fr-par-2/servers');
      const body = JSON.parse((createCall[1] as RequestInit).body as string);
      expect(body.commercial_type).toBe('L4-1-24G');
      expect(body.image).toBe(gpuImage);
      expect(body.volumes).toEqual({
        0: { size: 60 * 1e9, volume_type: 'sbs_volume' },
      });
      expect(body.routed_ip_enabled).toBe(true);
      expect(body.name).toBe('qwen-tts');
      expect(body.tags).toContain('gpu');
      expect(body.tags).toContain('babelcast');
    });

    it('sets custom cloudInit via PATCH user_data', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET, authId: 'SCW-access-key' };

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          server: {
            id: 'srv-ci',
            name: 'ci',
            state: 'stopped',
            commercial_type: 'L4-1-24G',
            volumes: { '0': { id: 'vol-ci' } },
          },
        }),
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({}),
        text: async () => '',
      } as Response); // PATCH user_data
      mockFetch.mockResolvedValueOnce(mockJsonResponse({})); // poweron
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          server: {
            id: 'srv-ci',
            name: 'ci',
            state: 'running',
            commercial_type: 'L4-1-24G',
            public_ip: { address: '9.9.9.9' },
          },
        }),
      );

      await client.createInstance(
        {
          region: 'fr-par-2',
          commercialType: 'L4-1-24G',
          cloudInit: 'echo hi',
          projectId: 'proj-123',
        },
        creds,
      );

      const patchCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('/user_data/cloud-init'),
      );
      expect(patchCall).toBeTruthy();
      expect((patchCall![1] as RequestInit).method).toBe('PATCH');
      expect((patchCall![1] as RequestInit).body).toBe('#!/bin/bash\necho hi\n');
      const headers = (patchCall![1] as RequestInit).headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('text/plain');
    });
  });

  describe('getInstanceStatus()', () => {
    it('calls GET endpoint and returns state', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET };

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ server: { id: 'srv-1', state: 'running' } }),
      );

      const status = await client.getInstanceStatus('fr-par-1:srv-1', creds);
      expect(status).toBe('running');
      expect(mockFetch.mock.calls[0][0]).toContain(
        'https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-1',
      );
    });
  });

  describe('deleteInstance()', () => {
    it('calls DELETE endpoint via terminate action', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET };

      // GET server (no volumes), then terminate
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ server: { id: 'srv-1', state: 'running', commercial_type: 'DEV1-L' } }),
      );
      mockFetch.mockResolvedValueOnce(mockJsonResponse({}));

      await client.deleteInstance('fr-par-1:srv-1', creds);
      expect(mockFetch.mock.calls[0][0]).toContain(
        'https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-1',
      );
      expect(mockFetch.mock.calls[1][0]).toContain(
        'https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-1/action',
      );
      expect((mockFetch.mock.calls[1][1] as RequestInit).method).toBe('POST');
    });

    it('deletes SBS volumes via block API after terminate', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET };

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          server: {
            id: 'srv-l4',
            state: 'running',
            commercial_type: 'L4-1-24G',
            volumes: { '0': { id: 'vol-abc' } },
          },
        }),
      );
      mockFetch.mockResolvedValueOnce(mockJsonResponse({})); // terminate
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({}),
        text: async () => '',
      } as Response); // DELETE volume

      await client.deleteInstance('fr-par-2:srv-l4', creds);

      const volumeDelete = mockFetch.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('/block/v1alpha1/zones/fr-par-2/volumes/vol-abc'),
      );
      expect(volumeDelete).toBeTruthy();
      expect((volumeDelete![1] as RequestInit).method).toBe('DELETE');
    });
  });

  describe('listInstances()', () => {
    it('queries all known zones', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET };

      const zones = [
        'fr-par-1', 'fr-par-2', 'fr-par-3',
        'nl-ams-1', 'nl-ams-2', 'nl-ams-3',
        'pl-waw-1', 'pl-waw-2', 'pl-waw-3',
      ];

      for (const zone of zones) {
        mockFetch.mockResolvedValueOnce(
          mockJsonResponse({ servers: [{ id: `${zone}-srv`, name: 'test', state: 'running', commercial_type: 'DEV1-L' }] }),
        );
      }

      const instances = await client.listInstances(creds);

      expect(instances.length).toBe(zones.length);
      for (const zone of zones) {
        expect(mockFetch.mock.calls.some(
          (call: any[]) => (call[0] as string).includes(`/zones/${zone}/servers`),
        )).toBe(true);
      }
    });

    it('returns empty array when all zones fail', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET };

      const zones = [
        'fr-par-1', 'fr-par-2', 'fr-par-3',
        'nl-ams-1', 'nl-ams-2', 'nl-ams-3',
        'pl-waw-1', 'pl-waw-2', 'pl-waw-3',
      ];
      for (const zone of zones) {
        mockFetch.mockResolvedValueOnce(mockErrorResponse(403, 'Forbidden'));
      }

      const instances = await client.listInstances(creds);
      expect(instances).toEqual([]);
    });
  });
});
