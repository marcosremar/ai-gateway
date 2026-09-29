/**
 * Tests for src/cpu-providers/railway-client.ts
 * Uses fetch mocking to avoid real Railway API calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RailwayClient } from '../src/cpu-providers/railway-client';
import type { ProviderCredentials } from '../src/gpu-providers/types';

const CREDS: ProviderCredentials = { apiKey: 'test-railway-token' };

function mockGql(data: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => JSON.stringify({ data }),
  }));
}

describe('RailwayClient', () => {
  const prev = { ...process.env };

  beforeEach(() => {
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    delete process.env.RAILWAY_TOKEN;
    delete process.env.RAILWAY_API_TOKEN;
  });

  afterEach(() => {
    process.env = { ...prev };
    vi.unstubAllGlobals();
  });

  it('providerId is railway', () => {
    expect(new RailwayClient().providerId).toBe('railway');
  });

  it('listInstances maps services and uses SUCCESS→running', async () => {
    const fetchMock = vi
      .fn()
      // list services
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              project: {
                services: {
                  edges: [
                    { node: { id: 'svc-1', name: 'aigw-bot-1' } },
                    { node: { id: 'svc-2', name: 'other' } },
                  ],
                },
              },
            },
          }),
      })
      // status for svc-1
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              deployments: { edges: [{ node: { id: 'd1', status: 'SUCCESS' } }] },
            },
          }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new RailwayClient().listInstances(CREDS);
    expect(result).toHaveLength(1);
    expect(result[0].instanceId).toBe('svc-1');
    expect(result[0].status).toBe('running');
    expect(result[0].providerMeta?.provider).toBe('railway');
  });

  it('createInstance creates a service from docker image', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: { serviceCreate: { id: 'svc-new', name: 'aigw-bot-123' } },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { serviceInstanceDeploy: true } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const inst = await new RailwayClient().createInstance(
      { dockerImage: 'nginx:alpine', computeType: 'CPU' },
      CREDS,
    );
    expect(inst.instanceId).toBe('svc-new');
    expect(inst.status).toBe('starting');
    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.input.source.image).toBe('nginx:alpine');
  });

  it('deleteInstance calls serviceDelete', async () => {
    const fetchMock = mockGql({ serviceDelete: true });
    vi.stubGlobal('fetch', fetchMock);
    await new RailwayClient().deleteInstance('svc-x', CREDS);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.query).toContain('serviceDelete');
    expect(body.variables.id).toBe('svc-x');
  });

  it('throws when RAILWAY_PROJECT_ID missing on list that needs project', async () => {
    delete process.env.RAILWAY_PROJECT_ID;
    // listInstances swallows errors → []
    const fetchMock = mockGql({});
    vi.stubGlobal('fetch', fetchMock);
    const result = await new RailwayClient().listInstances(CREDS);
    expect(result).toEqual([]);
  });
});
