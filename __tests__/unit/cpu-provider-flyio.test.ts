/**
 * Tests for src/cpu-providers/flyio-client.ts
 * Uses fetch mocking to avoid real Fly.io API calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlyioClient } from '../../src/cpu-providers/flyio-client';
import type { ProviderCredentials, InstanceSpec } from '../../src/gpu-providers/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(): FlyioClient {
  return new FlyioClient();
}

const CREDS: ProviderCredentials = { apiKey: 'test-fly-token' };

function makeMachine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'machine-abc123',
    name: 'babelcast-bot-1234567890',
    state: 'started',
    region: 'iad',
    instance_id: 'inst-xyz',
    private_ip: '10.0.0.1',
    config: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:01Z',
    ...overrides,
  };
}

function mockFetch(responses: Array<{ ok: boolean; status?: number; body?: unknown; text?: string }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 400),
      json: async () => resp.body ?? {},
      text: async () => resp.text ?? JSON.stringify(resp.body ?? {}),
    };
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FlyioClient', () => {
  describe('static properties', () => {
    it('providerId is flyio', () => {
      expect(makeClient().providerId).toBe('flyio');
    });

    it('bootTimeSecs is 20', () => {
      expect(makeClient().bootTimeSecs).toBe(20);
    });
  });

  describe('listInstances', () => {
    it('returns empty array on fetch error', async () => {
      const client = makeClient();
      const fetchMock = vi.fn(async () => { throw new Error('network error'); });
      vi.stubGlobal('fetch', fetchMock);
      const result = await client.listInstances(CREDS);
      expect(result).toEqual([]);
      vi.unstubAllGlobals();
    });

    it('returns empty array on non-ok response', async () => {
      const client = makeClient();
      vi.stubGlobal('fetch', mockFetch([{ ok: false, status: 401 }]));
      const result = await client.listInstances(CREDS);
      expect(result).toEqual([]);
      vi.unstubAllGlobals();
    });

    it('filters only babelcast-bot machines', async () => {
      const client = makeClient();
      const machines = [
        makeMachine({ id: 'm1', name: 'babelcast-bot-111', state: 'started' }),
        makeMachine({ id: 'm2', name: 'other-app-machine', state: 'started' }),
        makeMachine({ id: 'm3', name: 'babelcast-bot-222', state: 'stopped' }),
      ];
      vi.stubGlobal('fetch', mockFetch([{ ok: true, body: machines }]));
      const result = await client.listInstances(CREDS);
      expect(result).toHaveLength(2);
      expect(result.map(r => r.instanceId)).toEqual(['m1', 'm3']);
      vi.unstubAllGlobals();
    });

    it('maps started state to running', async () => {
      const client = makeClient();
      vi.stubGlobal('fetch', mockFetch([{
        ok: true,
        body: [makeMachine({ state: 'started' })],
      }]));
      const result = await client.listInstances(CREDS);
      expect(result[0].status).toBe('running');
      vi.unstubAllGlobals();
    });

    it('maps non-started state to stopped', async () => {
      const client = makeClient();
      vi.stubGlobal('fetch', mockFetch([{
        ok: true,
        body: [makeMachine({ state: 'stopped' })],
      }]));
      const result = await client.listInstances(CREDS);
      expect(result[0].status).toBe('stopped');
      vi.unstubAllGlobals();
    });

    it('includes required fields on each instance', async () => {
      const client = makeClient();
      vi.stubGlobal('fetch', mockFetch([{
        ok: true,
        body: [makeMachine({ id: 'm1' })],
      }]));
      const [inst] = await client.listInstances(CREDS);
      expect(inst.instanceId).toBe('m1');
      expect(inst.providerMeta?.provider).toBe('flyio');
      expect((inst.providerMeta as any)?.costPerHr).toBe(0.03);
      expect((inst.providerMeta as any)?.createdAt).toBeTruthy();
      vi.unstubAllGlobals();
    });
  });

  describe('deleteInstance', () => {
    it('throws on non-ok non-404 response', async () => {
      const client = makeClient();
      // stop → ok, waitForState → ok, delete → 500
      vi.stubGlobal('fetch', mockFetch([
        { ok: true },  // stop POST
        { ok: true },  // waitForState GET (stops wait)
        { ok: false, status: 500, text: 'server error' }, // DELETE
      ]));
      await expect(client.deleteInstance('machine-id', CREDS)).rejects.toThrow('Fly.io delete failed (500)');
      vi.unstubAllGlobals();
    });

    it('succeeds on 404 (already deleted)', async () => {
      const client = makeClient();
      // stop throws (caught), delete → 404 (also ok)
      vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
        if ((opts?.method === 'POST') || url.includes('/wait')) {
          throw new Error('machine already stopped');
        }
        // DELETE request
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      }));
      await expect(client.deleteInstance('machine-id', CREDS)).resolves.not.toThrow();
      vi.unstubAllGlobals();
    });
  });

  describe('getInstanceDetail', () => {
    it('returns parsed JSON on success', async () => {
      const client = makeClient();
      const detail = { id: 'm1', state: 'started', config: {} };
      vi.stubGlobal('fetch', mockFetch([{ ok: true, body: detail }]));
      const result = await client.getInstanceDetail('m1', CREDS);
      expect(result).toEqual(detail);
      vi.unstubAllGlobals();
    });

    it('throws on non-ok response', async () => {
      const client = makeClient();
      vi.stubGlobal('fetch', mockFetch([{ ok: false, status: 404 }]));
      await expect(client.getInstanceDetail('m1', CREDS)).rejects.toThrow('Fly.io get failed (404)');
      vi.unstubAllGlobals();
    });
  });

  describe('resolveInstanceEndpoint', () => {
    it('returns fly.dev URL', async () => {
      const client = makeClient();
      const url = await client.resolveInstanceEndpoint('m1', CREDS);
      expect(url).toMatch(/\.fly\.dev$/);
    });

    it('uses FLY_APP_NAME env var in URL', async () => {
      process.env.FLY_APP_NAME = 'my-custom-app';
      const client = makeClient();
      const url = await client.resolveInstanceEndpoint('m1', CREDS);
      expect(url).toContain('my-custom-app');
      delete process.env.FLY_APP_NAME;
    });
  });

  describe('probeHealth', () => {
    it('returns true when /version responds 200', async () => {
      const client = makeClient();
      vi.stubGlobal('fetch', mockFetch([{ ok: true }]));
      const result = await client.probeHealth('machine-id', CREDS);
      expect(result).toBe(true);
      vi.unstubAllGlobals();
    });

    it('returns false when /version returns error', async () => {
      const client = makeClient();
      vi.stubGlobal('fetch', mockFetch([{ ok: false, status: 500 }]));
      const result = await client.probeHealth('machine-id', CREDS);
      expect(result).toBe(false);
      vi.unstubAllGlobals();
    });

    it('returns false on network error', async () => {
      const client = makeClient();
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
      const result = await client.probeHealth('machine-id', CREDS);
      expect(result).toBe(false);
      vi.unstubAllGlobals();
    });
  });

  describe('getFlyHost', () => {
    it('returns empty string initially', () => {
      const client = makeClient();
      expect(client.getFlyHost()).toBe('');
    });
  });

  describe('image resolution', () => {
    it('createInstance calls ensureApp before creating machine', async () => {
      const client = makeClient();
      const calls: string[] = [];

      vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
        calls.push(`${opts?.method ?? 'GET'} ${url}`);
        if (url.includes('/apps/') && !url.includes('/machines')) {
          // ensureApp check — return ok (app exists)
          return { ok: true, json: async () => ({}), text: async () => '' };
        }
        if (url.includes('/machines') && opts?.method === 'POST') {
          // createInstance
          return {
            ok: true,
            json: async () => makeMachine(),
            text: async () => JSON.stringify(makeMachine()),
          };
        }
        if (url.includes('/wait')) {
          // waitForState
          return { ok: true, json: async () => ({}), text: async () => '' };
        }
        if (url.includes('/version')) {
          // DNS check
          return { ok: false, json: async () => ({}), text: async () => '' };
        }
        return { ok: true, json: async () => ({}), text: async () => '' };
      }));

      // resolveAppIp uses Bun.spawn — mock it too
      const origSpawn = (globalThis as any).Bun?.spawn;
      if ((globalThis as any).Bun) {
        (globalThis as any).Bun.spawn = vi.fn(() => ({
          exited: Promise.resolve(0),
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('[]'));
              controller.close();
            }
          }),
        }));
      }

      const spec: InstanceSpec = {
        dockerImage: 'myrepo/myimage:latest',
        region: 'iad',
      };

      const instance = await client.createInstance(spec, CREDS);
      expect(instance.instanceId).toBe('machine-abc123');
      expect(instance.providerMeta?.provider).toBe('flyio');
      expect((instance.providerMeta as any)?.costPerHr).toBe(0.03);

      if ((globalThis as any).Bun && origSpawn) {
        (globalThis as any).Bun.spawn = origSpawn;
      }
      vi.unstubAllGlobals();
    });
  });

  describe('edge cases', () => {
    it('listInstances handles empty machine list', async () => {
      const client = makeClient();
      vi.stubGlobal('fetch', mockFetch([{ ok: true, body: [] }]));
      const result = await client.listInstances(CREDS);
      expect(result).toEqual([]);
      vi.unstubAllGlobals();
    });

    it('uses default app name when FLY_APP_NAME not set', async () => {
      delete process.env.FLY_APP_NAME;
      const client = makeClient();
      const fetchMock = vi.fn(async (url: string) => ({
        ok: true,
        json: async () => [],
        text: async () => '[]',
      }));
      vi.stubGlobal('fetch', fetchMock);
      await client.listInstances(CREDS);
      expect(fetchMock.mock.calls[0][0]).toContain('babelcast-bot');
      vi.unstubAllGlobals();
    });

    it('uses FLY_APP_NAME when set', async () => {
      process.env.FLY_APP_NAME = 'my-app';
      const client = makeClient();
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => [],
        text: async () => '[]',
      }));
      vi.stubGlobal('fetch', fetchMock);
      await client.listInstances(CREDS);
      expect(fetchMock.mock.calls[0][0]).toContain('my-app');
      delete process.env.FLY_APP_NAME;
      vi.unstubAllGlobals();
    });
  });
});
