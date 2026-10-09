import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { vastReplicaInit } from '../../../src/deployments/cloud-init';
import { RealtimeService } from '../../../src/realtime/service';
import { ScalewayDeploymentBackend } from '../../../src/deployments/scaleway-backend';
import { VastDeploymentBackend } from '../../../src/deployments/vast-backend';
import { deriveRealtimeKey, signSessionToken } from '../../../src/realtime/token';
import { FakeCloud, until } from '../deployments/_fake-cloud';

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

async function twoReplicas() {
  const cloud = new FakeCloud();
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6,
  });
  controllers.push(controller);
  clouds.push(cloud);
  await controller.init();
  controller.start();
  await controller.put('speech', { profile: 'cpu-echo', maxReplicas: 2, minActiveReplicas: 2, idleMinutes: 15 });
  controller.wake('speech');
  await until(() => controller.get('speech')!.replicas.filter(r => r.phase === 'ready').length === 2);
  const secret = (controller as unknown as { deployments: Map<string, { record: { replicaToken: string } }> }).deployments.get('speech')!.record.replicaToken;
  return { cloud, controller, secret };
}

describe('audit 2026-10-09 #16: every replica gets its own token; the deployment secret stays in the gateway', () => {
  it('two replicas of one deployment get two different tokens, neither the deployment secret, and both serve', async () => {
    const { cloud, controller, secret } = await twoReplicas();
    const given = cloud.created.map(c => c.replicaToken);
    expect(new Set(given).size).toBe(2);
    expect(given).not.toContain(secret);
    for (const c of cloud.created) {
      expect(c.cloudInit).not.toContain(secret);
      expect(vastReplicaInit({ ...c.spec, bootScript: 'true' }, c.replicaToken)).not.toContain(secret);
    }
    const ids = controller.get('speech')!.replicas.map(r => r.id);
    const tokens = ids.map(id => controller.replicaAuth(id)!.replicaToken);
    expect(new Set(tokens)).toEqual(new Set(given));
    for (let i = 0; i < 4; i++) {
      const lease = await controller.acquire('speech', { waitMs: 0 });
      expect(lease.token).toBe(controller.replicaAuth(lease.machine.id)!.replicaToken);
      lease.done(false);
    }
  });

  it('a session token signed with one replica\'s key is refused for its sibling', async () => {
    const { controller } = await twoReplicas();
    const [a, b] = controller.get('speech')!.replicas.map(r => r.id) as [string, string];
    const service = new RealtimeService({ controller, userOf: () => null, isAdmin: () => false, pollMs: 0, netProbeMs: 0, turnCheckMs: 0 });
    const now = Math.floor(Date.now() / 1000);
    const claims = { sid: 's1', app: 'x', dep: 'speech', cfg: '', iat: now, exp: now + 60 };
    const keyOfA = deriveRealtimeKey(controller.tokenOf('speech', a)!);
    expect(service.resolveToken(signSessionToken({ ...claims, rep: a }, keyOfA))).toMatchObject({ replicaId: a });
    expect(service.resolveToken(signSessionToken({ ...claims, rep: b }, keyOfA))).toMatchObject({ status: 401 });
    service.stop();
  });
});

describe('audit 2026-10-09 #16: the replica key travels with the machine, so a restarted gateway finds it', () => {
  it('Scaleway keeps it in a tag; Vast in the label; a machine from before has none (deployment token, legacy)', async () => {
    const tags = ['aigw-deploy', 'aigw-ns-prod', 'aigw-dep-speech', 'aigw-rk-abc123'];
    const scw = new ScalewayDeploymentBackend('k', { client: {
      listInstancesByTag: async () => [{ instanceId: 'fr-par-1:a', status: 'running', providerMeta: { zone: 'fr-par-1', tags } },
        { instanceId: 'fr-par-1:b', status: 'running', providerMeta: { zone: 'fr-par-1', tags: tags.slice(0, 3) } }],
    } as never });
    expect((await scw.listReplicas('prod')).map(m => [m.deployment, m.tokenKey])).toEqual([['speech', 'abc123'], ['speech', undefined]]);
    const instances = [{ id: 1, label: 'aigw:prod:speech:abc123', actual_status: 'running' }, { id: 2, label: 'aigw:prod:speech', actual_status: 'running' }];
    const vast = new VastDeploymentBackend('k', { fetch: (async () => Response.json({ instances })) as never });
    expect((await vast.listReplicas('prod')).map(m => [m.deployment, m.tokenKey])).toEqual([['speech', 'abc123'], ['speech', undefined]]);
  });
});
