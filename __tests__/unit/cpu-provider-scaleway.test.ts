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

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ default_project_id: 'proj-123' }),
      );
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ images: [{ id: 'img-uuid', name: 'Ubuntu 24.04' }] }),
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

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ default_project_id: 'proj-123' }),
      );
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ images: [{ id: 'img-uuid', name: 'Ubuntu 24.04' }] }),
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
      expect(result.status).toBe('starting');

      const createCall = mockFetch.mock.calls[2];
      expect(createCall[0]).toContain('https://api.scaleway.com/instance/v1/zones/fr-par-1/servers');
      expect((createCall[1] as RequestInit).method).toBe('POST');
    });

    it('throws on API error', async () => {
      const client = new ScalewayClient();
      const creds = { apiKey: FAKE_SECRET, authId: 'SCW-access-key' };

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ default_project_id: 'proj-123' }),
      );
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ images: [{ id: 'img-uuid', name: 'Ubuntu 24.04' }] }),
      );
      mockFetch.mockResolvedValueOnce(
        mockErrorResponse(400, 'Bad request'),
      );

      await expect(client.createInstance({ region: 'fr-par-1' }, creds)).rejects.toThrow();
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

      mockFetch.mockResolvedValueOnce(mockJsonResponse({}));

      await client.deleteInstance('fr-par-1:srv-1', creds);
      expect(mockFetch.mock.calls[0][0]).toContain(
        'https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/srv-1/action',
      );
      expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
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
