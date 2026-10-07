/**
 * A cloud whose "machines" are local processes laid out like a GPU replica (docs/realtime-edge.md): the nginx front the
 * cloud-init writes (token gate, /__aigw/ready, /__aigw/rt/* → edge), the real aigw-edge sidecar with the replica token
 * the controller generated, and the fake model container (docker/aigw-edge/tests/fake_upstream.py) in place of the GPU.
 */
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { nginxConfig } from '../../src/deployments/cloud-init';
import type { CreateReplicaInput, DeploymentBackend, ReplicaMachine } from '../../src/deployments/types';

const EDGE_DIR = resolve(import.meta.dir, '../../docker/aigw-edge');

export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
  });
}

async function waitHttp(url: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* booting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

function killGroup(p: ChildProcess | undefined): void {
  if (!p?.pid) return;
  try { process.kill(-p.pid, 'SIGKILL'); } catch { p.kill('SIGKILL'); }
}

interface LocalReplica {
  machine: ReplicaMachine;
  dir: string;
  ports: { front: number; up: number; edge: number; udp: [number, number] };
  env: Record<string, string>;
  procs: { up?: ChildProcess; edge?: ChildProcess; nginx?: ChildProcess };
}

export interface LocalCloudOptions {
  python: string;
  gatewayUrl: () => string;
  maxSessions: number;
  modelScript?: string;
  log: (line: string) => void;
}

export class LocalEdgeCloud implements DeploymentBackend {
  readonly provider = 'scaleway' as const;
  readonly replicas = new Map<string, LocalReplica>();
  private seq = 0;
  private udpBase = 50_000;

  constructor(private readonly opts: LocalCloudOptions) {}

  async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    const id = `${input.spec.zone}:local-${++this.seq}`;
    const [front, up, edge] = [await freePort(), await freePort(), await freePort()];
    const udp: [number, number] = [this.udpBase, this.udpBase + 40];
    this.udpBase += 100;
    const dir = mkdtempSync(join(tmpdir(), 'aigw-rt-e2e-'));
    const rep: LocalReplica = {
      machine: {
        id, deployment: input.spec.name, ip: `127.0.0.1:${front}`, state: 'running', createdAt: Date.now(),
        zone: input.spec.zone, machineType: input.spec.machineType, pricePerHour: 0.5,
      },
      dir, ports: { front, up, edge, udp }, procs: {},
      env: {
        RT_PORT: String(edge), EDGE_UPSTREAM: `http://127.0.0.1:${up}`, AIGW_REPLICA_TOKEN: input.replicaToken,
        AIGW_DEPLOYMENT: input.spec.name, AIGW_REPLICA_ID: id, RT_MAX_SESSIONS: String(this.opts.maxSessions),
        RT_UDP_PORTS: `${udp[0]}-${udp[1]}`, GATEWAY_URL: this.opts.gatewayUrl(), EDGE_TELEMETRY_STDOUT: '0',
      },
    };
    this.replicas.set(id, rep);
    rep.procs.up = this.spawn(rep, 'model', this.opts.python, [this.opts.modelScript ?? 'tests/fake_upstream.py', '--port', String(up)]);
    this.startEdge(rep);
    // The cloud-init's own front, served from this replica's directory instead of /srv/aigw.
    const conf = nginxConfig(input.replicaToken, front, up, edge).replace('/srv/aigw/ready.json', join(dir, 'ready.json'));
    writeFileSync(join(dir, 'aigw.conf'), conf);
    writeFileSync(join(dir, 'nginx.conf'),
      `pid ${dir}/nginx.pid; error_log ${dir}/error.log; daemon off; events {}\n`
      + `http { access_log off; client_body_temp_path ${dir}; proxy_temp_path ${dir}; fastcgi_temp_path ${dir}; `
      + `uwsgi_temp_path ${dir}; scgi_temp_path ${dir}; include ${dir}/aigw.conf; }\n`);
    rep.procs.nginx = this.spawn(rep, 'nginx', 'nginx', ['-p', dir, '-c', `${dir}/nginx.conf`]);
    // Boot: the cloud-init writes ready.json once the app's health path answers.
    void waitHttp(`http://127.0.0.1:${up}/health`).then(() => writeFileSync(join(dir, 'ready.json'), '{"ready":true}'))
      .catch((e) => this.opts.log(`${id}: model never came up: ${(e as Error).message}`));
    this.opts.log(`${id}: front :${front} model :${up} edge :${edge} udp ${udp.join('-')}`);
    return { ...rep.machine };
  }

  private spawn(rep: LocalReplica, name: string, cmd: string, args: string[], extraEnv: Record<string, string> = {}): ChildProcess {
    // Own process group: killing it takes the edge's RTC worker processes too, as a container stop would.
    const child = spawn(cmd, args, { cwd: EDGE_DIR, env: { ...process.env, ...rep.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const tag = `[${rep.machine.id} ${name}]`;
    const out = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) this.opts.log(`${tag} ${l}`); };
    child.stdout?.on('data', out);
    child.stderr?.on('data', out);
    return child;
  }

  /** The UDP range the next replica gets (to firewall it before it boots). */
  nextUdpRange(): [number, number] {
    return [this.udpBase, this.udpBase + 40];
  }

  /** The edge's own status, read locally (not through the gateway). */
  async edgeStatus(id: string): Promise<{ transports: string[]; net: { path: string; udpInbound: string; reasons: string[] } }> {
    const rep = this.replicas.get(id)!;
    return await (await fetch(`http://127.0.0.1:${rep.ports.edge}/__aigw/rt/status`)).json() as never;
  }

  /** (Re)starts the edge sidecar of a replica, the way docker's restart policy would. */
  startEdge(rep: LocalReplica): void {
    rep.procs.edge = this.spawn(rep, 'edge', this.opts.python, ['-m', 'aigw_edge']);
  }

  /** Kills the edge sidecar only (the model and the front stay up), as a crashed sidecar would. */
  killEdge(id: string): void {
    killGroup(this.replicas.get(id)?.procs.edge);
  }

  async edgeReady(id: string): Promise<void> {
    const rep = this.replicas.get(id)!;
    await waitHttp(`http://127.0.0.1:${rep.ports.edge}/__aigw/rt/status`);
  }

  async listReplicas(): Promise<ReplicaMachine[]> {
    return [...this.replicas.values()].map(r => ({ ...r.machine }));
  }

  async releaseReplica(machine: ReplicaMachine): Promise<void> {
    const rep = this.replicas.get(machine.id);
    if (!rep) return;
    this.replicas.delete(machine.id);
    for (const p of Object.values(rep.procs)) killGroup(p);
    rmSync(rep.dir, { recursive: true, force: true });
    this.opts.log(`${machine.id}: released`);
  }

  async hourlyPrice(): Promise<number | null> {
    return 0.5;
  }

  async closeAll(): Promise<void> {
    for (const r of [...this.replicas.values()]) await this.releaseReplica(r.machine);
  }
}
