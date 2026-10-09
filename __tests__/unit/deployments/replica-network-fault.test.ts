import { afterEach, describe, expect, it } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'net';
import type { Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { DeploymentController } from '../../../src/deployments/controller';
import { createDeploymentRoutes, HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { DOWN_GRACE_MS } from '../../../src/deployments/planner';
import { AppRegistry, MemoryAppStore } from '../../../src/deployments/apps';
import { FakeCloud, until } from './_fake-cloud';

const ADMIN = 'admin-key-0123456789';

class FaultyLink {
  mode: 'pass' | 'blackhole' = 'pass';
  readonly sockets = new Set<Socket>();
  private server: Server;
  constructor(private readonly target: string) {
    this.server = createServer((client) => {
      this.sockets.add(client);
      client.on('close', () => this.sockets.delete(client));
      client.on('error', () => {});
      if (this.mode === 'blackhole') return;
      const [host, port] = this.target.split(':');
      const upstream = connect(Number(port), host);
      upstream.on('error', () => client.destroy());
      client.on('data', (d) => { if (this.mode === 'pass') upstream.write(d); });
      upstream.on('data', (d) => { if (this.mode === 'pass') client.write(d); });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => { if (this.mode === 'pass') client.destroy(); });
    });
  }
  async listen(): Promise<string> {
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', () => r()));
    return `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>(r => this.server.close(() => r()));
  }
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

async function setup() {
  const cloud = new FakeCloud();
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(300), namespace: 'test', reconcileMs: 50,
    maxTotalReplicas: 4, busyGraceMs: 200, unhealthyStrikes: 2,
  });
  await controller.init();
  controller.start();
  const apps = new AppRegistry(new MemoryAppStore());
  await apps.init();
  const handler = createDeploymentRoutes({ controller, apps, isAdmin: () => true, userOf: () => 'owner', invokeIdleMs: 2_000 });
  const server: HttpServer = createProxyServer({
    apiKeys: [`${ADMIN}:owner`], providers: { stt: {}, chat: {}, tts: {} } as never,
    prefixRoutes: [{ prefix: '/v1/deployments', handler }],
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  cleanup.push(async () => { await cloud.closeAll(); }, () => controller.stop(), async () => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  });
  return { cloud, controller, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('a replica behind a network path that goes dark', () => {
  it('a request to a blackholed replica is cut once the dead replica is released instead of hanging for the 15-min invoke timeout', async () => {
    const x = await setup();
    await x.controller.put('llm', { profile: 'cpu-echo', minReplicas: 1, maxReplicas: 1 });
    await until(() => x.cloud.machines.size === 1);
    const fake = [...x.cloud.machines.values()][0];
    const link = new FaultyLink(fake.machine.ip!);
    fake.machine.ip = await link.listen();
    cleanup.push(() => link.close());
    await until(() => x.controller.get('llm')!.status === 'ready', 3000);
    const invoke = () => fetch(`${x.base}/v1/deployments/llm/invoke/x`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(75_000),
    });
    expect((await invoke()).status).toBe(200);

    link.mode = 'blackhole';
    const started = Date.now();
    const status = await invoke().then(r => r.status, (e: Error) => e.name);
    const waitedMs = Date.now() - started;
    expect(status).not.toBe('TimeoutError');
    expect(waitedMs).toBeLessThan(DOWN_GRACE_MS + 10_000);
    expect(x.cloud.releaseReasons).toContain('unhealthy');
  }, 90_000);
});
