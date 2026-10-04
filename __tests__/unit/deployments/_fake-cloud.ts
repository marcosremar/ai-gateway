/**
 * Test double for a cloud: every "machine" is an in-process HTTP server that behaves like the replica's nginx
 * front (token gate, /__aigw/ready after boot, everything else answered by the app).
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { CreateReplicaInput, DeploymentBackend, RegistryAuth, ReplicaMachine } from '../../../src/deployments/types';

export interface FakeMachine {
  machine: ReplicaMachine;
  server: Server;
  token: string;
  bootedAt: number;
  requests: number;
  /** When false the app answers 500 on its health path. */
  healthy: boolean;
}

export class FakeCloud implements DeploymentBackend {
  readonly provider = 'scaleway' as const;
  machines = new Map<string, FakeMachine>();
  created: CreateReplicaInput[] = [];
  released: string[] = [];
  price: number | null = 0.01;
  failList = false;
  failCreate: string | null = null;
  bootMs = 50;
  registryAuthFor?: (image: string) => RegistryAuth | null;
  appDelayMs = 0;
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    if (this.failCreate) throw new Error(this.failCreate);
    this.created.push(input);
    const id = `fr-par-2:fake-${++this.seq}`;
    const fake: FakeMachine = {
      machine: {
        id, deployment: input.spec.name, ip: null, state: 'running', createdAt: this.now(),
        zone: input.spec.zone, machineType: input.spec.machineType, pricePerHour: this.price,
      },
      server: createServer(),
      token: input.replicaToken,
      bootedAt: Date.now() + this.bootMs,
      requests: 0,
      healthy: true,
    };
    fake.server.on('request', (req, res) => {
      if (req.headers['x-aigw-token'] !== fake.token) { res.writeHead(401); res.end(); return; }
      if (req.url === '/__aigw/ready') {
        if (Date.now() < fake.bootedAt) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ready":true}');
        return;
      }
      if (req.url === input.spec.healthPath) { res.writeHead(fake.healthy ? 200 : 500); res.end(); return; }
      fake.requests++;
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
        res.end(JSON.stringify({
          replica: id, method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8'),
          sawAuthorization: Boolean(req.headers.authorization),
        }));
      }, this.appDelayMs));
    });
    await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', () => r()));
    fake.machine.ip = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    this.machines.set(id, fake);
    return { ...fake.machine };
  }

  async listReplicas(): Promise<ReplicaMachine[]> {
    if (this.failList) throw new Error('scaleway list failed');
    return [...this.machines.values()].map(m => ({ ...m.machine }));
  }

  async releaseReplica(machine: ReplicaMachine): Promise<void> {
    const fake = this.machines.get(machine.id);
    this.released.push(machine.id);
    if (!fake) return;
    this.machines.delete(machine.id);
    fake.server.closeAllConnections();
    await new Promise<void>(r => fake.server.close(() => r()));
  }

  async hourlyPrice(): Promise<number | null> {
    return this.price;
  }

  /** Machine dies without the provider noticing (connection refused). */
  async crash(id: string): Promise<void> {
    const fake = this.machines.get(id)!;
    fake.server.closeAllConnections();
    await new Promise<void>(r => fake.server.close(() => r()));
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.machines.keys()]) await this.releaseReplica(this.machines.get(id)!.machine);
  }
}

export async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, stepMs));
  }
}
