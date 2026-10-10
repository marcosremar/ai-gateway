/**
 * End-to-end check of deployments WITHOUT a cloud bill: each "machine" is a local Docker container
 * (Ubuntu + nginx + docker CLI, `--network host`) that runs the REAL replica cloud-init produced by
 * `replicaCloudInit`. Everything else is the production path: proxy auth, controller, planner, HTTP probe,
 * token-gated nginx front, forwarding.
 *
 * Proves: scale-from-zero on the first request (cold start wait), forwarding + header hygiene, the token gate,
 * warm latency, scale-to-zero after idleMinutes, DELETE.
 *
 * Needs a Docker daemon and the machine image:
 *   docker build -t aigw-machine -f scripts/deployments-machine.Dockerfile scripts/   (see that file)
 * Run: bun scripts/deployments-docker-e2e.ts
 * Only one replica at a time (the fake machine binds host :80).
 */

import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { createProxyServer } from '../src/gateway/proxy/server';
import { DeploymentController, FileDeploymentStore, HttpReplicaProbe, createDeploymentRoutes } from '../src/deployments';
import type { CreateReplicaInput, DeploymentBackend, ReplicaMachine } from '../src/deployments';

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

class LocalDockerBackend implements DeploymentBackend {
  readonly provider = 'scaleway' as const;
  constructor(private readonly dir: string) {}

  async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    const script = join(this.dir, `init-${Date.now()}.sh`);
    await writeFile(script, input.cloudInit, { mode: 0o755 });
    const createdAt = Date.now();
    const id = await docker('run', '-d', '--network', 'host', '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', `${script}:/init.sh:ro`, '--label', `aigw-ns=${input.namespace}`, '--label', `aigw-dep=${input.spec.name}`,
      '--label', `aigw-created=${createdAt}`, 'aigw-machine', 'bash', '-c', 'AIGW_TLS_SAN=IP:127.0.0.1 bash /init.sh; sleep infinity');
    return { id: id.slice(0, 12), deployment: input.spec.name, ip: '127.0.0.1', tls: true, state: 'running', createdAt,
      zone: input.spec.zone, machineType: input.spec.machineType, pricePerHour: 0 };
  }

  async listReplicas(namespace: string): Promise<ReplicaMachine[]> {
    const out = await docker('ps', '-a', '--filter', `label=aigw-ns=${namespace}`, '--format', '{{json .}}');
    return out.split('\n').filter(Boolean).map((line) => {
      const row = JSON.parse(line) as { ID: string; State: string; Labels: string };
      const labels = Object.fromEntries(row.Labels.split(',').map(kv => kv.split('=') as [string, string]));
      return { id: row.ID.slice(0, 12), deployment: labels['aigw-dep'], ip: '127.0.0.1', tls: true,
        state: row.State === 'running' ? 'running' : 'stopped', createdAt: Number(labels['aigw-created']),
        zone: 'local', machineType: 'docker', pricePerHour: 0 };
    });
  }

  async releaseReplica(machine: ReplicaMachine): Promise<void> {
    await docker('rm', '-f', machine.id, 'app').catch(() => docker('rm', '-f', machine.id));
  }

  async hourlyPrice(): Promise<number> {
    return 0;
  }
}

const KEY = 'e2e-key-0123456789abcdef';
const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
function check(step: string, ok: boolean, detail: string) {
  steps.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`);
}

const dir = await mkdtemp(join(tmpdir(), 'aigw-e2e-'));
const backend = new LocalDockerBackend(dir);
const controller = new DeploymentController({
  backend, store: FileDeploymentStore.inDir(dir), probe: new HttpReplicaProbe(2000), namespace: 'e2e', reconcileMs: 2000,
  log: (msg, data) => console.log(`  · ${msg} ${data ? JSON.stringify(data) : ''}`),
});
await controller.init();
controller.start();
const handler = createDeploymentRoutes({ controller });
const server = createProxyServer({
  apiKeys: [`${KEY}:e2e`], providers: { stt: {}, chat: {}, tts: {} } as never,
  prefixRoutes: [{ prefix: '/v1/deployments', handler }, { prefix: '/v1/profiles', handler }],
});
await new Promise<void>(r => server.listen(4100, '127.0.0.1', () => r()));
const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:4100${path}`, {
    method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

try {
  const put = await api('PUT', '/v1/deployments/echo', {
    image: 'traefik/whoami:v1.10', port: 80, healthPath: '/health', machineType: 'DEV1-S', gpu: false,
    idleMinutes: 1, coldStartWaitSeconds: 180, env: { WHOAMI_NAME: 'aigw-e2e' },
  });
  check('PUT deployment', put.status === 201, `HTTP ${put.status}`);
  await controller.reconcile();
  const before = await (await api('GET', '/v1/deployments/echo')).json() as { status: string };
  check('starts scaled to zero', before.status === 'scaled-to-zero', before.status);

  const t0 = Date.now();
  const cold = await api('GET', '/v1/deployments/echo/invoke/hello?x=1', undefined, { 'x-custom': 'kept' });
  const coldText = await cold.text();
  const coldMs = Date.now() - t0;
  check('cold request waits for boot and is answered by the container', cold.status === 200 && coldText.includes('GET /hello?x=1'),
    `HTTP ${cold.status} in ${coldMs} ms`);
  check('caller headers forwarded, gateway secrets stripped',
    coldText.includes('X-Custom: kept') && !/authorization|x-aigw-token/i.test(coldText), coldText.split('\n').filter(l => /^X-|^Authorization/i.test(l)).join(' | '));
  check('container env applied', coldText.includes('Name: aigw-e2e'), coldText.split('\n')[0]);

  const t1 = Date.now();
  const warm = await api('POST', '/v1/deployments/echo/invoke/v1/audio/speech', { input: 'olá' });
  const warmMs = Date.now() - t1;
  const warmText = await warm.text();
  check('warm POST with JSON body', warm.status === 200 && warmText.includes('POST /v1/audio/speech'), `HTTP ${warm.status} in ${warmMs} ms, replica ${warm.headers.get('x-aigw-replica')}`);

  const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;
  const noToken = await fetch('https://127.0.0.1:80/hello', insecure);
  const badToken = await fetch('https://127.0.0.1:80/__aigw/ready', { ...insecure, headers: { 'X-Aigw-Token': 'guess' } });
  check('replica front refuses calls without the deployment token', noToken.status === 401 && badToken.status === 401,
    `no token ${noToken.status}, wrong token ${badToken.status}`);

  const view = await (await api('GET', '/v1/deployments/echo')).json() as { status: string; replicas: unknown[] };
  check('status ready with 1 replica', view.status === 'ready' && view.replicas.length === 1, `${view.status}, ${view.replicas.length} replica(s)`);

  console.log('  · waiting for idleMinutes (1 min) to pass …');
  const idleStart = Date.now();
  while (Date.now() - idleStart < 150_000) {
    if (!(await backend.listReplicas('e2e')).length) break;
    await new Promise(r => setTimeout(r, 3000));
  }
  const left = await backend.listReplicas('e2e');
  check('scaled back to zero after idle', left.length === 0, `${left.length} machine(s) after ${Math.round((Date.now() - idleStart) / 1000)} s idle wait`);

  const del = await api('DELETE', '/v1/deployments/echo');
  check('DELETE deployment', del.status === 200, `HTTP ${del.status}`);
} finally {
  controller.stop();
  server.closeAllConnections();
  server.close();
  for (const m of await backend.listReplicas('e2e').catch(() => [])) await backend.releaseReplica(m);
  await rm(dir, { recursive: true, force: true });
}

const failed = steps.filter(s => !s.ok);
console.log(`\n${steps.length - failed.length}/${steps.length} passed`);
process.exit(failed.length ? 1 : 0);
