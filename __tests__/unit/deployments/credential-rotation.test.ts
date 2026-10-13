import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { ScalewayDeploymentBackend } from '../../../src/deployments/scaleway-backend';
import { VastDeploymentBackend } from '../../../src/deployments/vast-backend';
import { rotateBackendCredentials } from '../../../src/deployments';
import { bootFile, signedFileUrls } from '../../../src/deployments/boot-files';
import { PartialListError } from '../../../src/cpu-providers/scaleway-client';
import { FakeCloud, until } from './_fake-cloud';

function scwClient(refused: Set<string>) {
  return {
    createInstance: vi.fn(),
    listInstancesByTag: vi.fn(async (_tag: string, creds: { apiKey: string }) => {
      if (refused.has(creds.apiKey)) throw new Error('scaleway HTTP 401: denied');
      return [];
    }),
    releaseInstance: vi.fn(async () => {}),
    getHourlyPrice: vi.fn(async () => 0.1),
    imageLike: vi.fn(async () => null),
  };
}

function vastFetch(good: Set<string>) {
  const auth: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const header = String((init?.headers as Record<string, string>)?.Authorization ?? '');
    auth.push(`${url.replace(/^.*\/api\/v0/, '')} ${header}`);
    if (!good.has(header.replace('Bearer ', ''))) return new Response('{"error":"bad key"}', { status: 401 });
    return Response.json(url.includes('/instances') ? { instances: [] } : { id: 1 });
  });
  return { fetchImpl, auth };
}

describe('machine credentials rotate without a restart', () => {
  it('Scaleway: a valid key replaces the old one in place; the next call uses it', async () => {
    const client = scwClient(new Set());
    const backend = new ScalewayDeploymentBackend('old-secret', { client: client as never, projectId: 'p1' });
    await backend.rotateCredentials({ secretKey: 'new-secret', projectId: 'p2', registrySecret: 'ro' });
    client.listInstancesByTag.mockClear();
    await backend.listReplicas('prod');
    expect(client.listInstancesByTag.mock.calls[0]![1]).toEqual({ apiKey: 'new-secret' });
    expect(client.listInstancesByTag.mock.calls[0]![2]).toEqual({ projectId: 'p2' });
    expect(backend.registryAuthFor('rg.fr-par.scw.cloud/a/b')?.password).toBe('ro');
  });

  it('Scaleway: a refused key is rejected and the backend keeps the old one', async () => {
    const client = scwClient(new Set(['bad-secret']));
    const backend = new ScalewayDeploymentBackend('old-secret', { client: client as never });
    await expect(backend.rotateCredentials({ secretKey: 'bad-secret' })).rejects.toThrow(/refused/);
    expect(backend.secretKey).toBe('old-secret');
  });

  it('Scaleway: a list that fails in some zones only still proves the key', async () => {
    const client = scwClient(new Set());
    client.listInstancesByTag.mockRejectedValueOnce(new PartialListError([], ['pl-waw-3'], 'pl-waw-3: timeout'));
    const backend = new ScalewayDeploymentBackend('old-secret', { client: client as never });
    await backend.rotateCredentials({ secretKey: 'new-secret' });
    expect(backend.secretKey).toBe('new-secret');
  });

  it('Vast: a valid key swaps in place; a refused one keeps the old key', async () => {
    const { fetchImpl, auth } = vastFetch(new Set(['old-key', 'new-key']));
    const backend = new VastDeploymentBackend('old-key', { fetch: fetchImpl });
    await expect(backend.rotateKey('bad-key')).rejects.toThrow(/HTTP 401/);
    expect(backend.currentKey).toBe('old-key');
    await backend.rotateKey('new-key');
    auth.length = 0;
    await backend.listReplicas('prod');
    expect(auth[0]).toMatch(/^\/instances.* Bearer new-key$/);
  });

  it('rotateBackendCredentials puts a refused key back in the environment and reports it (names only)', async () => {
    const scaleway = new ScalewayDeploymentBackend('scw-old', { client: scwClient(new Set(['scw-bad'])) as never });
    const vast = new VastDeploymentBackend('vast-old', { fetch: vastFetch(new Set(['vast-old', 'vast-new'])).fetchImpl });
    const env: Record<string, string | undefined> = { SCW_SECRET_KEY: 'scw-bad', VAST_API_KEY: 'vast-new' };
    const r = await rotateBackendCredentials({ scaleway, vast }, env);
    expect(r.rotated).toEqual(['vast']);
    expect(r.rejected.map(x => x.provider)).toEqual(['scaleway']);
    expect(JSON.stringify(r)).not.toContain('scw-bad');
    expect(env.SCW_SECRET_KEY).toBe('scw-old');
    expect(vast.currentKey).toBe('vast-new');
    expect(await rotateBackendCredentials({}, { VAST_API_KEY: 'x' })).toMatchObject({ needsRestart: ['vast'] });
  });
});

describe('replica secret rotation', () => {
  const controllers: DeploymentController[] = [];
  const clouds: FakeCloud[] = [];
  afterEach(async () => {
    for (const c of controllers.splice(0)) c.stop();
    for (const c of clouds.splice(0)) await c.closeAll();
  });

  it('live replicas keep the token they boot with; replicas made after the rotation get the new secret', async () => {
    const cloud = new FakeCloud();
    const store = new MemoryDeploymentStore();
    const controller = new DeploymentController({
      backend: cloud, store, probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6,
    });
    controllers.push(controller);
    clouds.push(cloud);
    await controller.init();
    controller.start();
    await controller.put('s', { image: 'me/app:1', port: 8000, minReplicas: 1, maxReplicas: 2, maxEurPerHour: 2 });
    await until(() => cloud.machines.size === 1);
    const [first] = [...cloud.machines.values()];
    const secretBefore = controller.deploymentSecretsOf('s')[0];
    const r = await controller.rotateReplicaSecret('s');
    expect(r).toEqual({ deployment: 's', pinnedReplicas: 1 });
    expect(controller.deploymentSecretsOf('s')[0]).not.toBe(secretBefore);
    expect(controller.tokenOf('s', first!.machine.id)).toBe(first!.token);
    expect(controller.replicaAuth(first!.machine.id)?.replicaToken).toBe(first!.token);
    await controller.put('s', { image: 'me/app:1', port: 8000, minReplicas: 2, maxReplicas: 2, maxEurPerHour: 2 });
    await until(() => cloud.machines.size === 2);
    const second = [...cloud.machines.values()].find(m => m !== first)!;
    expect(second.token).not.toBe(first!.token);
    expect(controller.tokenOf('s', second.machine.id)).toBe(second.token);
    expect(controller.tokenOf('s', first!.machine.id)).toBe(first!.token);
    const saved = (await store.load()).deployments.find(d => d.spec.name === 's')!;
    expect(Object.values(saved.secretPins ?? {})).toEqual([secretBefore]);
  });

  it('boot files signed before the rotation still verify while their replica is pinned', () => {
    const spec = { name: 'd', files: { 'a.txt': Buffer.from('hi').toString('base64') } } as never;
    const url = new URL(signedFileUrls(spec, 'old-secret-0123456789', 'https://gw', 2_000_000_000)['a.txt']!.url);
    const source = { specOf: () => spec, deploymentSecretsOf: () => ['new-secret-0123456789', 'old-secret-0123456789'] };
    expect(bootFile(source, url.searchParams, 0)?.toString()).toBe('hi');
    expect(bootFile({ ...source, deploymentSecretsOf: () => ['new-secret-0123456789'] }, url.searchParams, 0)).toBeNull();
  });
});
