import { createHash } from 'crypto';
import type { ScalewayClient } from '../cpu-providers/scaleway-client';
import type { ProviderCredentials } from '../gpu-providers/types';
import { createRunpodRest, runpodTime, type RunpodFetch, type RunpodPod, type RunpodRest } from '../gateway/providers/gpu/runpod/rest';
import { EUR_TO_USD, VAST_API, vastState, type VastDeploymentBackend } from '../deployments/vast-backend';
import type { DeploymentSpec, ExposedPort } from '../deployments/types';
import type { CreateMachineInput, MachineBackend, MachineRequest, ProviderMachine } from './types';

export const MACHINE_TAG = 'aigw-machine';
export const machineNsTag = (ns: string) => `aigw-mns-${ns}`;
export const machineIdTag = (id: string) => `aigw-mid-${id}`;
export const machineLabel = (ns: string, id: string) => `aigw-m:${ns}:${id}`;
export const SCALEWAY_EUR_TO_USD = 1.2;
const DEFAULT_ZONE = 'fr-par-2';

export function parseMachineLabel(label: string | null | undefined, ns: string): string | null {
  const prefix = `aigw-m:${ns}:`;
  return label?.startsWith(prefix) ? label.slice(prefix.length) || null : null;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function portsOf(request: Pick<MachineRequest, 'ports' | 'sshPublicKey'>): ExposedPort[] {
  const ssh: ExposedPort[] = request.sshPublicKey && !request.ports.some(p => p.protocol === 'tcp' && p.port === 22 && !p.to)
    ? [{ protocol: 'tcp', port: 22 }] : [];
  return [...ssh, ...request.ports];
}

export function portKeys(request: Pick<MachineRequest, 'ports' | 'sshPublicKey'>): string[] {
  return portsOf(request).flatMap(p => Array.from({ length: (p.to ?? p.port) - p.port + 1 }, (_, i) => `${p.port + i}/${p.protocol}`));
}

export function machineInit(request: MachineRequest): string {
  const lines = ['#!/bin/bash'];
  if (request.sshPublicKey) {
    lines.push('mkdir -p /root/.ssh && chmod 700 /root/.ssh',
      `echo ${quote(request.sshPublicKey)} >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`);
  }
  if (request.onstart) lines.push(request.onstart);
  return `${lines.join('\n')}\n`;
}

type ScalewayLike = Pick<ScalewayClient, 'createInstance' | 'listInstancesByTag' | 'releaseInstance' | 'getHourlyPrice'
  | 'listSecurityGroups' | 'createSecurityGroup' | 'defaultProjectId'>;

export class ScalewayMachineBackend implements MachineBackend {
  readonly provider = 'scaleway' as const;
  constructor(
    private readonly client: ScalewayLike, private readonly secret: () => string, private readonly projectId: () => string | undefined,
    private readonly awaitVolumes = false,
  ) {}

  private credentials(): ProviderCredentials {
    return { apiKey: this.secret() } as ProviderCredentials;
  }

  async quote(request: MachineRequest): Promise<number | null> {
    const eur = await this.client.getHourlyPrice(request.zone ?? DEFAULT_ZONE, request.machineType, this.credentials());
    if (eur == null) return null;
    const usd = Math.round(eur * SCALEWAY_EUR_TO_USD * 1000) / 1000;
    return usd <= request.maxUsdPerHour ? usd : null;
  }

  private async firewall(zone: string, namespace: string, request: MachineRequest): Promise<string> {
    const projectId = this.projectId() ?? await this.client.defaultProjectId(this.credentials());
    const rules = portsOf(request).map(p => ({ protocol: p.protocol === 'udp' ? 'UDP' as const : 'TCP' as const, port: p.port, ...(p.to ? { portTo: p.to } : {}) }));
    const key = createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 10);
    const name = `aigw-${namespace}-machines-${key}`;
    const found = (await this.client.listSecurityGroups(zone, this.credentials(), { projectId, name })).find(g => g.name === name);
    if (found) return found.id;
    return this.client.createSecurityGroup(zone, this.credentials(), {
      projectId, name, rules, tags: [MACHINE_TAG, machineNsTag(namespace)], description: 'ai-gateway machines: only the ports the request opened',
    });
  }

  async create(input: CreateMachineInput): Promise<ProviderMachine> {
    const { request } = input;
    const zone = request.zone ?? DEFAULT_ZONE;
    const usdPerHour = await this.quote(request);
    if (usdPerHour == null) throw new Error(`out_of_stock: no ${request.machineType} in ${zone} under $${request.maxUsdPerHour}/h`);
    const gpu = /^(L4|L40S|H100|H200|GPU|RENDER|B300)/i.test(request.machineType);
    const envFile = Object.entries(request.env).map(([k, v]) => `${k}=${v}`).join('\n');
    const docker = request.image ? [
      'mkdir -p /srv/aigw',
      `echo ${quote(Buffer.from(envFile).toString('base64'))} | base64 -d > /srv/aigw/machine.env && chmod 600 /srv/aigw/machine.env`,
      `docker run -d --restart unless-stopped --network host ${gpu ? '--gpus all ' : ''}--env-file /srv/aigw/machine.env ${quote(request.image)}`,
    ].join('\n') : '';
    const inst = await this.client.createInstance({
      label: `aigw-m-${input.machineId}`,
      region: zone,
      commercialType: request.machineType,
      volumeGb: request.diskGb,
      tags: [MACHINE_TAG, machineNsTag(input.namespace), machineIdTag(input.machineId)],
      cloudInit: `${machineInit(request)}${docker}\n`,
      securityGroupId: await this.firewall(zone, input.namespace, request),
      ...(this.projectId() ? { projectId: this.projectId() } : {}),
    } as Parameters<ScalewayLike['createInstance']>[0], this.credentials());
    return { ...this.toMachine(inst, input.namespace)!, machineId: input.machineId, usdPerHour };
  }

  private toMachine(inst: Awaited<ReturnType<ScalewayLike['createInstance']>>, namespace: string): ProviderMachine | null {
    const meta = (inst.providerMeta ?? {}) as { tags?: string[]; state?: string; createdAt?: string };
    const tags = meta.tags ?? [];
    if (!tags.includes(machineNsTag(namespace))) return null;
    const machineId = tags.find(t => t.startsWith('aigw-mid-'))?.slice('aigw-mid-'.length);
    if (!machineId) return null;
    const ip = inst.ipAddress ?? null;
    const state = meta.state === 'running' ? 'running' : /stopped/.test(meta.state ?? '') ? 'stopped' : 'starting';
    return {
      providerId: inst.instanceId, provider: 'scaleway', machineId, state, ip, usdPerHour: null,
      ports: {}, createdAt: Date.parse(meta.createdAt ?? '') || Date.now(),
    };
  }

  async list(namespace: string): Promise<ProviderMachine[]> {
    const found = await this.client.listInstancesByTag(machineNsTag(namespace), this.credentials(),
      this.projectId() ? { projectId: this.projectId() } : {});
    return found.map(i => this.toMachine(i, namespace)).filter((m): m is ProviderMachine => m !== null);
  }

  async release(providerId: string): Promise<void> {
    await this.client.releaseInstance(providerId, this.credentials(), { awaitVolumes: this.awaitVolumes });
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface VastInstanceRow {
  id: number;
  label?: string | null;
  actual_status?: string | null;
  public_ipaddr?: string | null;
  ports?: Record<string, Array<{ HostPort?: string }> | undefined> | null;
  dph_total?: number;
  start_date?: number | null;
}

export class VastMachineBackend implements MachineBackend {
  readonly provider = 'vast' as const;
  constructor(private readonly market: Pick<VastDeploymentBackend, 'pickOffers' | 'currentKey'>, private readonly fetchImpl: FetchLike = fetch) {}

  private spec(request: MachineRequest): DeploymentSpec {
    return {
      name: 'machine', machineType: request.machineType, volumeGb: request.diskGb, maxEurPerHour: request.maxUsdPerHour / EUR_TO_USD,
      near: request.near, allowFar: true,
    } as DeploymentSpec;
  }

  private async offers(request: MachineRequest) {
    const needed = portKeys(request).length;
    return (await this.market.pickOffers(this.spec(request)))
      .filter(o => o.dph_total <= request.maxUsdPerHour && (o.direct_port_count === undefined || o.direct_port_count >= needed));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${VAST_API}${path}`, {
      method, headers: { Authorization: `Bearer ${this.market.currentKey}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status === 404 && method === 'DELETE') return {} as T;
    if (!res.ok) throw new Error(`vast ${method} ${path}: HTTP ${res.status} ${text.slice(0, 160)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async quote(request: MachineRequest): Promise<number | null> {
    const [best] = await this.offers(request);
    return best ? best.dph_total : null;
  }

  async create(input: CreateMachineInput): Promise<ProviderMachine> {
    const { request } = input;
    const offers = (await this.offers(request)).slice(0, 5);
    if (!offers.length) throw new Error(`out_of_stock: no vast ${request.machineType} under $${request.maxUsdPerHour}/h`);
    const mapped = Object.fromEntries(portKeys(request).map((k) => {
      const [n, protocol] = k.split('/');
      return [`-p ${n}:${n}${protocol === 'udp' ? '/udp' : ''}`, '1'];
    }));
    const misses: string[] = [];
    for (const offer of offers) {
      type Rent = { success?: boolean; new_contract?: number; error?: string; msg?: string };
      const res: Rent = await this.call<Rent>('PUT', `/asks/${offer.id}/`, {
        client_id: 'me', image: request.image, label: machineLabel(input.namespace, input.machineId), disk: request.diskGb,
        runtype: 'ssh_direct',
        onstart: 'V="${AIGW_INIT_B64:-$(sed -n \'s/^AIGW_INIT_B64=//p\' /etc/environment | tr -d \'"\')}"; '
          + 'mkdir -p /srv/aigw && echo "$V" | base64 -d > /srv/aigw/init.sh && nohup bash /srv/aigw/init.sh > /srv/aigw/init.log 2>&1 &',
        env: { ...request.env, AIGW_INIT_B64: Buffer.from(machineInit(request)).toString('base64'), ...mapped },
      }).catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) }));
      if (res.success && res.new_contract != null) {
        return {
          providerId: String(res.new_contract), provider: 'vast', machineId: input.machineId, state: 'starting', ip: null, ports: {},
          usdPerHour: offer.dph_total, createdAt: Date.now(),
        };
      }
      misses.push(`offer ${offer.id}: ${(res.error ?? res.msg ?? 'refused').slice(0, 80)}`);
    }
    throw new Error(`out_of_stock: every vast offer tried was taken (${misses.join('; ')})`);
  }

  async list(namespace: string): Promise<ProviderMachine[]> {
    const { instances = [] } = await this.call<{ instances?: VastInstanceRow[] }>('GET', '/instances/');
    return instances.flatMap((i) => {
      const machineId = parseMachineLabel(i.label, namespace);
      if (!machineId) return [];
      const state = vastState(i.actual_status);
      const ports = Object.fromEntries(Object.entries(i.ports ?? {}).flatMap(([k, v]) => (v?.[0]?.HostPort ? [[k, Number(v[0].HostPort)]] : [])));
      return [{
        providerId: String(i.id), provider: 'vast' as const, machineId, state: state === 'exited' ? 'stopped' as const : state as 'running' | 'starting',
        ip: i.public_ipaddr?.trim() || null, ports, usdPerHour: i.dph_total ?? null,
        createdAt: typeof i.start_date === 'number' ? Math.round(i.start_date * 1000) : Date.now(),
      }];
    });
  }

  async release(providerId: string): Promise<void> {
    await this.call('DELETE', `/instances/${encodeURIComponent(providerId)}/`);
  }
}

export class RunpodMachineBackend implements MachineBackend {
  readonly provider = 'runpod' as const;
  private readonly rest: () => RunpodRest;
  constructor(apiKey: () => string, fetchImpl?: RunpodFetch) {
    this.rest = () => createRunpodRest({ apiKey: apiKey(), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  async quote(request: MachineRequest): Promise<number | null> {
    const type = (await this.rest().gpuTypes()).find(g => g.id === request.machineType || g.displayName === request.machineType);
    return type && type.pricePerHr <= request.maxUsdPerHour && !/unavailable|none/i.test(type.stockStatus) ? type.pricePerHr : null;
  }

  async create(input: CreateMachineInput): Promise<ProviderMachine> {
    const { request } = input;
    const init = Buffer.from(machineInit(request)).toString('base64');
    const res = await this.rest().createPod({
      name: machineLabel(input.namespace, input.machineId), imageName: request.image, gpuTypeIds: [request.machineType], gpuCount: 1,
      containerDiskInGb: request.diskGb, volumeInGb: 0, supportPublicIp: true,
      ports: portKeys(request),
      env: { ...request.env, AIGW_INIT_B64: init, ...(request.sshPublicKey ? { PUBLIC_KEY: request.sshPublicKey } : {}) },
      dockerStartCmd: ['bash', '-c',
        'echo "$AIGW_INIT_B64" | base64 -d > /aigw-init.sh; (bash /aigw-init.sh > /aigw-init.log 2>&1 &); if [ -x /start.sh ]; then exec /start.sh; else sleep infinity; fi'],
    });
    if (!res.ok) throw new Error(`${/no.*(instances|machines).*available/i.test(res.body) ? 'out_of_stock' : 'runpod create failed'}: HTTP ${res.status} ${res.body}`);
    if (typeof res.pod.costPerHr === 'number' && res.pod.costPerHr > request.maxUsdPerHour) {
      await this.release(res.pod.id);
      throw new Error(`runpod priced the pod at $${res.pod.costPerHr}/h, above the cap $${request.maxUsdPerHour}/h`);
    }
    return this.toMachine(res.pod, input.namespace) ?? {
      providerId: res.pod.id, provider: 'runpod', machineId: input.machineId, state: 'starting', ip: null, ports: {},
      usdPerHour: res.pod.costPerHr ?? null, createdAt: Date.now(),
    };
  }

  private toMachine(pod: RunpodPod, namespace: string): ProviderMachine | null {
    const machineId = parseMachineLabel(pod.name, namespace);
    if (!machineId || !pod.id) return null;
    const ports = Object.fromEntries(Object.entries(pod.portMappings ?? {}).map(([k, v]) => [`${k}/tcp`, v]));
    const status = pod.desiredStatus ?? '';
    return {
      providerId: pod.id, provider: 'runpod', machineId, ip: pod.publicIp || null, ports, usdPerHour: pod.costPerHr ?? null,
      state: status === 'RUNNING' ? 'running' : /EXITED|TERMINATED|STOPPED/.test(status) ? 'stopped' : 'starting',
      createdAt: (pod.createdAt ? runpodTime(pod.createdAt) : null) ?? Date.now(),
    };
  }

  async list(namespace: string): Promise<ProviderMachine[]> {
    const pods = await this.rest().listPods();
    if (pods === null) throw new Error('runpod list failed');
    return pods.map(p => this.toMachine(p, namespace)).filter((m): m is ProviderMachine => m !== null);
  }

  async release(providerId: string): Promise<void> {
    await this.rest().deletePod(providerId);
  }
}
