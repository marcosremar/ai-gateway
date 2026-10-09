import { describe, expect, it } from 'vitest';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { buildSpec } from '../../../src/deployments/spec';
import { LIST_CACHE_MS, VastDeploymentBackend } from '../../../src/deployments/vast-backend';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { FakeCloud, until } from './_fake-cloud';

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

describe('an image the host cannot pull', () => {
  it('the listing carries the provider error for a machine still loading, nothing for a running one', async () => {
    const msg = 'Error response from daemon: manifest unknown\n';
    const fetchImpl = async () => new Response(JSON.stringify({ instances: [
      { id: 1, label: 'aigw:stress:llm', actual_status: 'loading', status_msg: msg },
      { id: 2, label: 'aigw:stress:llm', actual_status: 'loading', status_msg: 'pulling layer 3/9' },
      { id: 3, label: 'aigw:stress:llm', actual_status: 'running', status_msg: msg },
    ] }));
    const listed = await new VastDeploymentBackend('k', { fetch: fetchImpl }).listReplicas('stress');
    expect(listed.map(m => m.bootError ?? null)).toEqual(['Error response from daemon: manifest unknown', null, null]);
  });

  it('the controller releases it at once without blaming the host, says why, and backs off instead of renting in a loop', async () => {
    const cloud = new FakeCloud(Date.now, 'vast');
    cloud.bootMs = 60_000;
    const controller = new DeploymentController({
      backends: { vast: cloud }, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(500), namespace: 'test', reconcileMs: 20,
    });
    await controller.init();
    controller.start();
    try {
      await controller.put('llm', { profile: 'cpu-echo', provider: 'vast', machineType: 'RTX 3090', bootScript: 'serve', image: 'x/y:missing', minReplicas: 1 });
      await until(() => cloud.machines.size === 1);
      [...cloud.machines.values()][0].machine.bootError = 'manifest unknown';
      await until(() => cloud.releaseReasons.includes('boot-failed'));
      await new Promise(r => setTimeout(r, 300));
      expect(cloud.created).toHaveLength(1);
      expect(controller.get('llm')!.lastError).toMatch(/boot failed on the provider: manifest unknown/);
    } finally {
      controller.stop();
      await cloud.closeAll();
    }
  });
});
