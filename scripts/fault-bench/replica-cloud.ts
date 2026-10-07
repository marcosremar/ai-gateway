/**
 * Fake cloud for the deployment scenarios of the fault bench: every "machine" is an HTTP server on 127.0.0.1 that
 * behaves like a replica's nginx front (token gate, `/__aigw/ready` once booted, the app's health path) and hands
 * every other request to a scripted app (`ReplicaCloud.app`), so a replica can stream, stall or die mid-answer.
 *
 * Nothing leaves the machine. The cloud counts what a real provider would bill: creates, releases, stops, list calls,
 * and can fail its list (`failList`) or slow its creates (`createMs`).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CreateReplicaInput, DeploymentBackend, DeploymentProvider, ReplicaMachine } from '../../src/deployments/types';

export type ReplicaApp = (req: IncomingMessage, res: ServerResponse, body: Buffer, machine: ReplicaMachine) => void | Promise<void>;

interface FakeReplica {
  machine: ReplicaMachine;
  server: Server;
  token: string;
  bootedAt: number;
  alive: boolean;
}

const defaultApp: ReplicaApp = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'olá da réplica' }, finish_reason: 'stop' }] }));
};

export class ReplicaCloud implements DeploymentBackend {
  readonly replicas = new Map<string, FakeReplica>();
  created: string[] = [];
  released: Array<{ id: string; reason?: string }> = [];
  stops: string[] = [];
  starts: string[] = [];
  listCalls = 0;
  failList = false;
  /** Time a create takes (the provider's API), during which the machine is not listed yet. */
  createMs = 0;
  bootMs = 30;
  price: number | null = 0.5;
  stoppingMs = 0;
  app: ReplicaApp = defaultApp;
  /** Concurrent creates seen at once (a create storm shows here). */
  maxConcurrentCreates = 0;
  private creating = 0;
  private seq = 0;
  private stopSettlesAt = new Map<string, number>();

  constructor(readonly provider: DeploymentProvider = 'scaleway') {}

  async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    this.creating++;
    this.maxConcurrentCreates = Math.max(this.maxConcurrentCreates, this.creating);
    try {
      const id = `${input.spec.zone}:bench-${++this.seq}`;
      input.onCreated?.(id);
      if (this.createMs) await new Promise(r => setTimeout(r, this.createMs));
      this.created.push(id);
      const replica: FakeReplica = {
        machine: {
          id, deployment: input.spec.name, ip: null, state: 'running', createdAt: Date.now(),
          zone: input.spec.zone, machineType: input.spec.machineType, pricePerHour: this.price,
        },
        server: createServer(), token: input.replicaToken, bootedAt: Date.now() + this.bootMs, alive: true,
      };
      replica.server.on('request', (req, res) => {
        if (req.headers['x-aigw-token'] !== replica.token) { res.writeHead(401); res.end(); return; }
        if (req.url === '/__aigw/ready') {
          const up = Date.now() >= replica.bootedAt;
          res.writeHead(up ? 200 : 404, { 'content-type': 'application/json' });
          res.end(up ? '{"ready":true}' : '{}');
          return;
        }
        if (req.url === input.spec.healthPath) { res.writeHead(200); res.end(); return; }
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c as Buffer));
        req.on('end', () => { void Promise.resolve(this.app(req, res, Buffer.concat(chunks), replica.machine)).catch(() => res.destroy()); });
      });
      await new Promise<void>(r => replica.server.listen(0, '127.0.0.1', () => r()));
      replica.machine.ip = `127.0.0.1:${(replica.server.address() as AddressInfo).port}`;
      this.replicas.set(id, replica);
      return { ...replica.machine };
    } finally {
      this.creating--;
    }
  }

  async listReplicas(): Promise<ReplicaMachine[]> {
    this.listCalls++;
    if (this.failList) throw new Error(`${this.provider} list failed (bench)`);
    for (const [id, at] of this.stopSettlesAt) {
      const r = this.replicas.get(id);
      if (!r) this.stopSettlesAt.delete(id);
      else if (Date.now() >= at) { r.machine.state = 'stopped'; this.stopSettlesAt.delete(id); }
    }
    return [...this.replicas.values()].map(r => ({ ...r.machine }));
  }

  async releaseReplica(machine: ReplicaMachine, reason?: string): Promise<void> {
    this.released.push({ id: machine.id, reason });
    const r = this.replicas.get(machine.id);
    if (!r) return;
    this.replicas.delete(machine.id);
    await this.kill(r);
  }

  async stopReplica(machine: ReplicaMachine): Promise<void> {
    const r = this.replicas.get(machine.id);
    if (!r) return;
    this.stops.push(machine.id);
    r.machine.state = this.stoppingMs > 0 ? 'stopping' : 'stopped';
    if (this.stoppingMs > 0) this.stopSettlesAt.set(machine.id, Date.now() + this.stoppingMs);
    r.bootedAt = Infinity;
  }

  async startReplica(machine: ReplicaMachine): Promise<void> {
    const r = this.replicas.get(machine.id);
    if (!r) return;
    this.starts.push(machine.id);
    r.machine.state = 'running';
    r.bootedAt = Date.now() + this.bootMs;
  }

  async hourlyPrice(): Promise<number | null> { return this.price; }

  /** The machine dies without the provider noticing: every open connection is cut and nothing answers any more. */
  async crash(id: string): Promise<void> {
    const r = this.replicas.get(id);
    if (r) await this.kill(r);
  }

  private async kill(r: FakeReplica): Promise<void> {
    if (!r.alive) return;
    r.alive = false;
    r.server.closeAllConnections();
    await new Promise<void>(res => r.server.close(() => res()));
  }

  running(): number { return [...this.replicas.values()].filter(r => r.machine.state === 'running').length; }

  async closeAll(): Promise<void> {
    for (const r of this.replicas.values()) await this.kill(r);
    this.replicas.clear();
  }
}

export async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 10): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return true;
}
