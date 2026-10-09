/**
 * Test double for a cloud: every "machine" is an in-process HTTP server that behaves like the replica's nginx
 * front (token gate, /__aigw/ready after boot, everything else answered by the app).
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { CreateReplicaInput, DeploymentBackend, DeploymentProvider, DeploymentNetwork, DeploymentSpec, RegistryAuth, ReplicaMachine } from '../../../src/deployments/types';

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
  machines = new Map<string, FakeMachine>();
  created: CreateReplicaInput[] = [];
  released: string[] = [];
  price: number | null = 0.01;
  failList = false;
  failCreate: string | null = null;
  /** Per-place create failure (placement ladder tests): an error message for that spec, or null to succeed. */
  failCreateFor?: (spec: DeploymentSpec) => string | null;
  /** Per-place catalog price; falls back to `price`. */
  priceFor?: (zone: string, machineType: string) => number | null;
  marketPriced?: boolean;
  /** RTT gate hook (Vast-like backends); absent = no gate. */
  measureRtt?: (machine: ReplicaMachine) => Promise<number | null>;
  measureBaselineRtt?: DeploymentBackend['measureBaselineRtt'];
  recordRtt?: DeploymentBackend['recordRtt'];
  previewOffers?: DeploymentBackend['previewOffers'];
  placementNote?: string;
  releaseReasons: Array<string | undefined> = [];
  bootMs = 50;
  registryAuthFor?: (image: string) => RegistryAuth | null;
  appDelayMs = 0;
  /** A stop is listed `stopping` for this long (Scaleway: ~1 min) before `stopped`; 0 = `stopped` at once. */
  stoppingMs = 0;
  private stopSettlesAt = new Map<string, number>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now, readonly provider: DeploymentProvider = 'scaleway') {}

  async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    if (this.failCreate) throw new Error(this.failCreate);
    const placeError = this.failCreateFor?.(input.spec);
    if (placeError) throw new Error(placeError);
    this.created.push(input);
    const id = `${this.provider === 'vast' ? 'vast' : input.spec.zone}:fake-${++this.seq}`;
    const fake: FakeMachine = {
      machine: {
        id, deployment: input.spec.name, ip: null, state: 'running', createdAt: this.now(),
        zone: input.spec.zone, machineType: input.spec.machineType, pricePerHour: this.price,
        ...(input.tokenKey ? { tokenKey: input.tokenKey } : {}),
        ...(this.placementNote ? { placementNote: this.placementNote } : {}),
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
    if (this.failList) throw new Error(`${this.provider} list failed`);
    for (const [id, at] of this.stopSettlesAt) {
      const fake = this.machines.get(id);
      if (!fake) this.stopSettlesAt.delete(id);
      else if (Date.now() >= at) { fake.machine.state = 'stopped'; this.stopSettlesAt.delete(id); }
    }
    return [...this.machines.values()].map(m => ({ ...m.machine }));
  }

  async releaseReplica(machine: ReplicaMachine, reason?: string): Promise<void> {
    const fake = this.machines.get(machine.id);
    this.released.push(machine.id);
    this.releaseReasons.push(reason);
    if (!fake) return;
    this.machines.delete(machine.id);
    fake.server.closeAllConnections();
    await new Promise<void>(r => fake.server.close(() => r()));
  }

  async hourlyPrice(zone: string, machineType: string): Promise<number | null> {
    return this.priceFor ? this.priceFor(zone, machineType) : this.price;
  }

  /** Exposed deployments: reserved IP + firewall per deployment, reused while they exist. */
  networks = new Map<string, DeploymentNetwork>();
  networkCalls = 0;
  releasedNetworks: string[] = [];
  starts: string[] = [];
  stops: string[] = [];

  async ensureNetwork(spec: DeploymentSpec, _ns: string, known?: DeploymentNetwork): Promise<DeploymentNetwork> {
    this.networkCalls++;
    const have = this.networks.get(spec.name);
    if (have && (!known || known.ipId === have.ipId)) return have;
    const net = { zone: spec.zone, ipId: `ip-${spec.name}`, ip: `51.15.0.${this.networks.size + 1}`, groupId: `sg-${spec.name}` };
    this.networks.set(spec.name, net);
    return net;
  }

  async releaseNetwork(network: DeploymentNetwork): Promise<void> {
    this.releasedNetworks.push(network.ipId);
    for (const [k, v] of this.networks) if (v.ipId === network.ipId) this.networks.delete(k);
  }

  /** Power off: the machine stays listed as `stopped` and stops answering until powered on (boots again). */
  async stopReplica(machine: ReplicaMachine): Promise<void> {
    const fake = this.machines.get(machine.id)!;
    this.stops.push(machine.id);
    fake.machine.state = this.stoppingMs > 0 ? 'stopping' : 'stopped';
    if (this.stoppingMs > 0) this.stopSettlesAt.set(machine.id, Date.now() + this.stoppingMs);
    fake.bootedAt = Infinity;
  }

  async startReplica(machine: ReplicaMachine): Promise<void> {
    const fake = this.machines.get(machine.id)!;
    this.starts.push(machine.id);
    this.stopSettlesAt.delete(machine.id);
    fake.machine.state = 'running';
    fake.bootedAt = Date.now() + this.bootMs;
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
