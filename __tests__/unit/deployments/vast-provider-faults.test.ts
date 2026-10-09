import { describe, expect, it } from 'vitest';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { buildSpec } from '../../../src/deployments/spec';
import { LIST_CACHE_MS, VastDeploymentBackend } from '../../../src/deployments/vast-backend';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const spec = buildSpec('llm', {
  provider: 'vast', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda-b11382', bootScript: 'exec /app/llama-server', port: 8000,
  machineType: 'RTX 3090', maxEurPerHour: 0.22,
}, { profiles: new Map(BUILTIN_PROFILES.map(p => [p.name, p])) });
const input = { spec, replicaToken: TOKEN, cloudInit: '', namespace: 'stress' };
const offers = [1, 2, 3].map(id => ({
  id, machine_id: 100 + id, geolocation: 'Paris, FR', dph_total: 0.15 + id / 100, reliability2: 0.99, inet_down: 900, gpu_name: 'RTX 3090',
}));

function fake(put: () => Response | Promise<Response>, extra: (method: string, url: string) => Response | null = () => null) {
  const puts: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const other = extra(method, url);
    if (other) return other;
    if (method === 'POST') return new Response(JSON.stringify({ offers }));
    if (method === 'PUT') { puts.push(url); return put(); }
    return new Response('{}');
  };
  return { puts, fetchImpl };
}

describe('Vast provider faults on create', () => {
  it.each([
    ['429 rate limit', () => new Response('{"error":"rate_limited"}', { status: 429, headers: { 'retry-after': '7' } }), /HTTP 429/],
    ['500', () => new Response('internal', { status: 500 }), /HTTP 500/],
    ['timeout', () => Promise.reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })), /timed out/],
  ])('%s on the rent stops at the first offer instead of walking every offer', async (_name, put, error) => {
    const { puts, fetchImpl } = fake(put);
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl });
    await expect(backend.createReplica(input)).rejects.toThrow(error);
    expect(puts).toHaveLength(1);
  });

  it('insufficient_credit is a terminal, recognisable error: one rent attempt, the reason in the message', async () => {
    const { puts, fetchImpl } = fake(() => new Response('{"success":false,"error":"insufficient_credit","msg":"Your account lacks credit"}', { status: 400 }));
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl });
    await expect(backend.createReplica(input)).rejects.toThrow(/insufficient_credit/);
    expect(puts).toHaveLength(1);
  });

  it('a rent whose answer is lost is still found by its label on the next list, so it is never untracked', async () => {
    let created = false;
    const { fetchImpl } = fake(() => { created = true; return Promise.reject(new Error('socket hang up')); }, (method, url) => (
      method === 'GET' && url.includes('/instances/')
        ? new Response(JSON.stringify({ instances: created ? [{ id: 9, label: 'aigw:stress:llm', actual_status: 'loading', machine_id: 101 }] : [] }))
        : null));
    let now = 0;
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, now: () => now });
    expect(await backend.listReplicas('stress')).toEqual([]);
    await expect(backend.createReplica(input)).rejects.toThrow(/socket hang up/);
    now += LIST_CACHE_MS + 1;
    expect((await backend.listReplicas('stress')).map(m => ({ id: m.id, deployment: m.deployment }))).toEqual([{ id: '9', deployment: 'llm' }]);
  });
});
