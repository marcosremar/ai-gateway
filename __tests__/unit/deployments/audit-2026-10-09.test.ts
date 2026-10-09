import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { replicaCloudInit } from '../../../src/deployments/cloud-init';
import { DeploymentController } from '../../../src/deployments/controller';
import { createDeploymentRoutes, HttpReplicaProbe } from '../../../src/deployments/http';
import { ScalewayDeploymentBackend } from '../../../src/deployments/scaleway-backend';
import { planReplicas, type ObservedReplica } from '../../../src/deployments/planner';
import { buildSpec } from '../../../src/deployments/spec';
import { FileDeploymentStore, MemoryDeploymentStore } from '../../../src/deployments/store';
import type { DeploymentSpec, ProbeResult, ReplicaProbe } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const cloud = new FakeCloud();
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6,
  });
  controllers.push(controller);
  clouds.push(cloud);
  await controller.init();
  controller.start();
  return { controller, cloud };
}

describe('audit 2026-10-09: one request at a time reaches every ready replica', () => {
  it('sequential requests alternate between two ready replicas', async () => {
    const x = await setup();
    await x.controller.put('tts', { profile: 'cpu-echo', maxReplicas: 2, minActiveReplicas: 2, targetInflightPerReplica: 4, idleMinutes: 15 });
    x.controller.wake('tts');
    await until(() => x.controller.get('tts')!.replicas.filter(r => r.phase === 'ready').length === 2);
    const served = new Map<string, number>();
    for (let i = 0; i < 20; i++) {
      const lease = await x.controller.acquire('tts', { waitMs: 0 });
      served.set(lease.machine.id, (served.get(lease.machine.id) ?? 0) + 1);
      lease.done(false);
    }
    expect([...served.values()].sort()).toEqual([10, 10]);
  });
});

describe('audit 2026-10-09: the provider API secret stays off the machine', () => {
  it('cloud-init for an image on the Scaleway registry does not carry the Scaleway API secret', () => {
    const secret = 'scw-secret-0000-1111-2222-333344445555';
    const backend = new ScalewayDeploymentBackend(secret, {});
    const spec = buildSpec('speech', { image: 'rg.fr-par.scw.cloud/aigw/speech-stack:1', port: 8000 }, { profiles: new Map() });
    const auth = backend.registryAuthFor(spec.image);
    const init = replicaCloudInit({ ...spec, ...(auth ? { registryAuth: auth } : {}) }, 'x'.repeat(32));
    expect(init).not.toContain(secret);
  });
});

describe('audit 2026-10-09: stored profiles are not readable with an app key', () => {
  it('GET /v1/profiles hides env, registry credentials, boot script and files from a non-admin key', async () => {
    const x = await setup();
    await x.controller.putProfile('private', {
      image: 'a/b:1', port: 8000, env: { HF_TOKEN: 'hf_secret_value' }, registryAuth: { username: 'u', password: 'registry-password' },
    });
    const handler = createDeploymentRoutes({ controller: x.controller, userOf: () => 'someapp', isAdmin: () => false });
    const body = await new Promise<string>((resolve) => {
      const res = { writeHead() { return res; }, setHeader() {}, end(text: string) { resolve(text); } };
      handler({ headers: {}, url: '/v1/profiles', method: 'GET' } as never, res as never, '/v1/profiles', 'GET');
    });
    expect(body).toContain('private');
    expect(body).not.toContain('hf_secret_value');
    expect(body).not.toContain('registry-password');
  });
});

describe('audit 2026-10-09: a damaged state file', () => {
  it.fails('an empty deployments.json does not stop the gateway from starting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aigw-audit-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'deployments.json'), '');
    await expect(FileDeploymentStore.inDir(dir).load()).resolves.toBeDefined();
  });
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 100 * HOUR;

function ttsSpec(over: Partial<DeploymentSpec> = {}): DeploymentSpec {
  return {
    ...buildSpec('tts', { image: 'a/b:1', port: 8000 }, { profiles: new Map() }),
    minReplicas: 0, maxReplicas: 2, minActiveReplicas: 2, idleMinutes: 15, bootTimeoutMinutes: 45, maxHours: 4, ...over,
  };
}

function observed(id: string, createdAt: number, over: Partial<ObservedReplica> = {}): ObservedReplica {
  return {
    machine: { id, deployment: 'tts', ip: '1.2.3.4', state: 'running', createdAt, zone: 'fr-par-2', machineType: 'L4-1-24G', pricePerHour: 0.79 },
    everReady: true, readyNow: true, failures: 0, inflight: 0, ...over,
  };
}

describe('audit 2026-10-09: maxHours while a class is being served', () => {
  it.fails('replicas with requests in flight are not all released at the same tick when they reach maxHours together', () => {
    const born = NOW - 4 * HOUR - 1000;
    const plan = planReplicas({
      spec: ttsSpec(), now: NOW, inflight: 6, waiting: 0, lastRequestAt: NOW - 1000, aboveSince: null,
      replicas: [observed('a', born, { inflight: 3, readyAt: born + 8 * MIN }), observed('b', born - 5000, { inflight: 3, readyAt: born + 8 * MIN })],
    });
    expect(plan.release.length).toBeLessThan(2);
  });
});

describe('audit 2026-10-09: a replica that never becomes ready', () => {
  it.fails('is not replaced again and again when no request arrived since the first one', () => {
    const firstRequest = NOW - 46 * MIN;
    const plan = planReplicas({
      spec: ttsSpec({ maxReplicas: 1, minActiveReplicas: 1 }), now: NOW, inflight: 0, waiting: 0, lastRequestAt: firstRequest, aboveSince: null,
      replicas: [observed('never-ready', firstRequest, { everReady: false, readyNow: false })],
    });
    expect(plan.release).toEqual([{ id: 'never-ready', reason: 'boot-timeout' }]);
    expect(plan.create).toBe(0);
  });
});

describe('audit 2026-10-09: gateway restart while old replicas are busy', () => {
  it.fails('a replica older than bootTimeoutMinutes whose first health check after the restart is busy is kept', async () => {
    const store = new MemoryDeploymentStore();
    const cloud = new FakeCloud();
    clouds.push(cloud);
    const options = { backend: cloud, store, namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6 };
    const before = new DeploymentController({ ...options, probe: new HttpReplicaProbe(1000) });
    controllers.push(before);
    await before.init();
    before.start();
    await before.put('tts', { profile: 'cpu-echo', maxReplicas: 1, bootTimeoutMinutes: 45, idleMinutes: 15 });
    before.wake('tts');
    await until(() => before.get('tts')!.status === 'ready');
    before.stop();
    for (const fake of cloud.machines.values()) fake.machine.createdAt -= 60 * MIN;

    const busy: ReplicaProbe = { ready: async () => false, check: async (): Promise<ProbeResult> => 'busy' };
    const after = new DeploymentController({ ...options, probe: busy });
    controllers.push(after);
    await after.init();
    after.start();
    await new Promise(r => setTimeout(r, 300));
    expect(cloud.releaseReasons).toEqual([]);
  });
});
