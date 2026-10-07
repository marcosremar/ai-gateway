/**
 * `DeploymentBackend` over `ScalewayClient`. Every replica carries three tags:
 *   `aigw-deploy` · `aigw-ns-<namespace>` · `aigw-dep-<deployment>`
 * The namespace keeps two gateways sharing one Scaleway project from adopting (or deleting) each other's machines.
 */

import { ScalewayClient, type ScalewayFirewallRule } from '../cpu-providers/scaleway-client';
import type { GpuInstance, ProviderCredentials } from '../gpu-providers/types';
import { DEFAULT_RT_UDP_PORTS } from './cloud-init';
import { PROBE_PORT } from './spec';
import type { CatalogEntry, CreateReplicaInput, DeploymentBackend, DeploymentNetwork, DeploymentSpec, RegistryAuth, ReplicaMachine } from './types';

export const DEPLOY_TAG = 'aigw-deploy';
export const nsTag = (ns: string) => `aigw-ns-${ns}`;
export const depTag = (name: string) => `aigw-dep-${name}`;

/** Ubuntu Noble GPU OS 12 in fr-par-2 (Docker + NVIDIA container toolkit preinstalled). */
const GPU_OS_IMAGE_FR_PAR_2 = '3307b9e4-3cfa-49b5-896e-ce914e4ef4aa';

type ScalewayLike = Pick<ScalewayClient, 'createInstance' | 'listInstancesByTag' | 'releaseInstance' | 'getHourlyPrice' | 'imageLike'>
  & Partial<Pick<ScalewayClient, 'reserveRoutedIp' | 'listIps' | 'deleteIp' | 'createSecurityGroup' | 'listSecurityGroups'
    | 'deleteSecurityGroup' | 'listSecurityGroupRules' | 'addSecurityGroupRule' | 'deleteSecurityGroupRule' | 'startInstance'
    | 'stopInstance' | 'listGpuOffers' | 'defaultProjectId'>>;

/**
 * The one port a gateway-only replica opens: its token-gated nginx (cloud-init.ts `nginxConfig`, :80). Everything else
 * (SSH 22, the container on 127.0.0.1:8000, metrics) is dropped at the Scaleway edge.
 */
export const GATEWAY_ONLY_PORTS = [80] as const;

/** Name of the shared firewall of a namespace's gateway-only replicas (one per zone; never deleted, it bills nothing). */
export const gatewayOnlyGroupName = (namespace: string) => `aigw-${namespace}-gateway-only`;

/**
 * Realtime replicas (`spec.realtime`) also take WebRTC media straight from the browsers on a UDP range, on each
 * replica's own public IP (no reserved IP: every scaled replica is its own media server, and the gateway's signaling
 * hands the browser that replica's address in the SDP answer). They share one group per namespace, zone and range.
 */
export const realtimeGroupName = (namespace: string, [lo, hi]: [number, number]) => `aigw-${namespace}-gateway-only-rt-${lo}-${hi}`;

/** The UDP rule a realtime spec adds to its firewall, or null. */
export function realtimeRule(spec: Pick<DeploymentSpec, 'realtime'>): { protocol: 'UDP'; port: number; portTo: number } | null {
  if (!spec.realtime) return null;
  const [lo, hi] = spec.realtime.udpPorts ?? DEFAULT_RT_UDP_PORTS;
  return { protocol: 'UDP', port: lo, portTo: hi };
}

function toMachine(inst: GpuInstance, fallbackDeployment?: string): ReplicaMachine | null {
  const meta = (inst.providerMeta ?? {}) as Record<string, unknown>;
  const tags = (meta.tags as string[] | undefined) ?? [];
  const deployment = tags.find(t => t.startsWith('aigw-dep-'))?.slice('aigw-dep-'.length) ?? fallbackDeployment;
  if (!deployment) return null;
  const created = typeof meta.createdAt === 'string' ? Date.parse(meta.createdAt) : NaN;
  return {
    id: inst.instanceId,
    deployment,
    ip: inst.ipAddress ?? null,
    state: typeof meta.state === 'string' ? meta.state : String(inst.status ?? 'starting'),
    createdAt: Number.isFinite(created) ? created : Date.now(),
    zone: String(meta.zone ?? ''),
    machineType: String(meta.commercialType ?? ''),
    pricePerHour: typeof meta.pricePerHr === 'number' && meta.pricePerHr > 0 ? meta.pricePerHr : null,
    provider: 'scaleway',
  };
}

export class ScalewayDeploymentBackend implements DeploymentBackend {
  readonly provider = 'scaleway' as const;
  private readonly credentials: ProviderCredentials;
  private readonly client: ScalewayLike;

  /**
   * `awaitVolumes`: a release waits until the server's SBS volumes are deleted too. The gateway does not (a request must
   * not wait minutes for a detach; its process lives on to finish them); the reaper, a cron process that exits right
   * after, must — or its volumes would keep billing (scripts/reap-orphans.ts).
   */
  constructor(secretKey: string, private readonly opts: { projectId?: string; client?: ScalewayLike; awaitVolumes?: boolean } = {}) {
    this.credentials = { apiKey: secretKey } as ProviderCredentials;
    this.client = opts.client ?? new ScalewayClient();
  }

  private async osImage(input: CreateReplicaInput): Promise<string | undefined> {
    const { spec } = input;
    if (spec.osImageId) return spec.osImageId;
    if (!spec.gpu) return undefined; // CPU: the client looks up Ubuntu in the zone
    if (spec.zone === 'fr-par-2') return GPU_OS_IMAGE_FR_PAR_2;
    const like = await this.client.imageLike(GPU_OS_IMAGE_FR_PAR_2, spec.zone, spec.machineType, this.credentials);
    if (!like) throw new Error(`no GPU OS image for ${spec.machineType} in ${spec.zone}; pass osImageId`);
    return like;
  }

  async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    const { spec } = input;
    const imageId = await this.osImage(input);
    // Every replica gets a firewall: an exposed one its deployment's (declared ports + probe), any other the
    // namespace's gateway-only group. Without one Scaleway attaches the project's "Default security group", whose
    // inbound policy is ACCEPT (QA 06/10/2026: SSH 22 of a speech replica reachable from the internet).
    const securityGroupId = input.network?.groupId ?? await this.gatewayOnlyGroup(spec.zone, input.namespace, realtimeRule(spec));
    const inst = await this.client.createInstance({
      label: `aigw-${spec.name}-${Date.now().toString(36)}`,
      region: spec.zone,
      commercialType: spec.machineType,
      ...(imageId ? { imageId } : {}),
      ...(spec.volumeGb ? { volumeGb: spec.volumeGb } : {}),
      tags: [DEPLOY_TAG, nsTag(input.namespace), depTag(spec.name)],
      cloudInit: input.cloudInit,
      securityGroupId,
      ...(input.network ? { publicIpIds: [input.network.ipId] } : {}),
      ...(input.files && Object.keys(input.files).length ? { userDataFiles: input.files } : {}),
      ...(this.opts.projectId ? { projectId: this.opts.projectId } : {}),
      ...(input.onCreated ? { onServerCreated: input.onCreated } : {}),
    }, this.credentials);
    const machine = toMachine(inst, spec.name);
    if (!machine) throw new Error('scaleway returned an instance without tags');
    return machine;
  }

  async listReplicas(namespace: string): Promise<ReplicaMachine[]> {
    const list = await this.client.listInstancesByTag(nsTag(namespace), this.credentials,
      this.opts.projectId ? { projectId: this.opts.projectId } : {});
    const machines = list.map(inst => toMachine(inst)).filter((m): m is ReplicaMachine => m !== null);
    // The list does not carry the price (a replica adopted after a restart showed `null`): the catalog has it.
    return Promise.all(machines.map(async m => (m.pricePerHour == null ? { ...m, pricePerHour: await this.priceOrNull(m) } : m)));
  }

  /** Catalog price of a listed machine, looked up once an hour per zone+type (the list runs every 20 s). */
  private readonly listedPrices = new Map<string, { at: number; price: number | null }>();

  private async priceOrNull(m: ReplicaMachine): Promise<number | null> {
    if (!m.zone || !m.machineType) return null;
    const key = `${m.zone}|${m.machineType}`;
    const hit = this.listedPrices.get(key);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.price;
    try {
      const price = await this.hourlyPrice(m.zone, m.machineType);
      this.listedPrices.set(key, { at: Date.now(), price });
      return price;
    } catch {
      return null;
    }
  }

  async releaseReplica(machine: ReplicaMachine): Promise<void> {
    await this.client.releaseInstance(machine.id, this.credentials, { awaitVolumes: this.opts.awaitVolumes === true });
  }

  private need<K extends keyof ScalewayLike>(key: K): NonNullable<ScalewayLike[K]> {
    const fn = this.client[key];
    if (!fn) throw new Error(`scaleway client has no ${String(key)}`);
    return (fn as (...a: unknown[]) => unknown).bind(this.client) as NonNullable<ScalewayLike[K]>;
  }

  private projectOr(): string {
    if (!this.opts.projectId) throw new Error('exposed deployments need SCW_PROJECT_ID (reserved IP and firewall belong to a project)');
    return this.opts.projectId;
  }

  /** Group id per zone, resolved once per process (concurrent creates share the same lookup). */
  private readonly gatewayOnlyGroups = new Map<string, Promise<string>>();

  /**
   * The namespace's gateway-only firewall in `zone`: stateful, inbound DROP by default, only `GATEWAY_ONLY_PORTS`
   * accepted, outbound ACCEPT. Found by name (a restart or another replica already made it) or created once. Shared by
   * every gateway-only deployment of the namespace, so a deployment delete leaves it (no per-deployment leak to clean,
   * and the janitor never touches security groups). Fails closed: no group → no machine.
   */
  private gatewayOnlyGroup(zone: string, namespace: string, rt: ReturnType<typeof realtimeRule> = null): Promise<string> {
    const key = `${zone}|${namespace}|${rt ? `${rt.port}-${rt.portTo}` : ''}`;
    let pending = this.gatewayOnlyGroups.get(key);
    if (!pending) {
      pending = this.findOrCreateGatewayOnlyGroup(zone, namespace, rt);
      pending.catch(() => this.gatewayOnlyGroups.delete(key)); // a failed lookup is retried by the next create
      this.gatewayOnlyGroups.set(key, pending);
    }
    return pending;
  }

  private async findOrCreateGatewayOnlyGroup(zone: string, namespace: string, rt: ReturnType<typeof realtimeRule>): Promise<string> {
    const projectId = this.opts.projectId ?? await this.need('defaultProjectId')(this.credentials);
    const name = rt ? realtimeGroupName(namespace, [rt.port, rt.portTo]) : gatewayOnlyGroupName(namespace);
    const groups = await this.need('listSecurityGroups')(zone, this.credentials, { projectId, name });
    const existing = groups.find(g => g.name === name);
    if (existing) return existing.id;
    return this.need('createSecurityGroup')(zone, this.credentials, {
      projectId, name, tags: [DEPLOY_TAG, nsTag(namespace)],
      description: rt ? `ai-gateway realtime replicas: token-gated nginx :80 + WebRTC UDP ${rt.port}-${rt.portTo}`
        : 'ai-gateway replicas reached only through the gateway (token-gated nginx :80)',
      rules: [...GATEWAY_ONLY_PORTS.map(port => ({ protocol: 'TCP' as const, port })), ...(rt ? [rt] : [])],
    });
  }

  /**
   * Reserved IP + firewall of an exposed deployment, tagged like its replicas. `known` (from the deployment record) is
   * reused while it still exists; otherwise any IP/firewall already tagged for this deployment is (a create that died
   * after reserving must not leak a second IP — the 06/10/2026 LiveKit leak). A reused firewall gets its rules brought
   * to what the spec asks for now (`reconcileRules`).
   */
  async ensureNetwork(spec: DeploymentSpec, namespace: string, known?: DeploymentNetwork): Promise<DeploymentNetwork> {
    if (!spec.exposure) throw new Error(`deployment '${spec.name}' has no exposure`);
    const projectId = this.projectOr();
    const zone = spec.zone;
    const tags = [DEPLOY_TAG, nsTag(namespace), depTag(spec.name)];
    const ips = await this.need('listIps')(zone, this.credentials, { projectId, tag: depTag(spec.name) });
    const ip = (known?.zone === zone ? ips.find(i => i.id === known.ipId) : undefined) ?? ips[0]
      ?? await this.need('reserveRoutedIp')(zone, this.credentials, { projectId, tags });
    const groupName = `aigw-${namespace}-${spec.name}`;
    const groups = (await this.need('listSecurityGroups')(zone, this.credentials, { projectId, name: groupName })).filter(g => g.name === groupName);
    const rt = realtimeRule(spec);
    const rules: ScalewayFirewallRule[] = [
      ...[...spec.exposure.ports, { protocol: 'tcp' as const, port: PROBE_PORT, to: undefined }]
        .map(r => ({ protocol: r.protocol === 'udp' ? 'UDP' as const : 'TCP' as const, port: r.port, ...(r.to ? { portTo: r.to } : {}) })),
      ...(rt ? [rt] : []),
    ];
    const existing = (known?.zone === zone ? groups.find(g => g.id === known.groupId)?.id : undefined) ?? groups[0]?.id;
    if (existing) await this.reconcileRules(zone, existing, rules);
    const groupId = existing ?? await this.need('createSecurityGroup')(zone, this.credentials, {
      projectId, name: groupName, tags, description: `ai-gateway exposed deployment ${spec.name}`, rules,
    });
    return { zone, ipId: ip.id, ip: ip.address, groupId };
  }

  private async reconcileRules(zone: string, groupId: string, wanted: ScalewayFirewallRule[]): Promise<void> {
    const keyOf = (r: { protocol: string; port: number | null; portTo?: number | null }) => `${r.protocol}:${r.port}-${r.portTo || r.port}`;
    const missing = new Map(wanted.map(r => [keyOf(r), r]));
    for (const rule of await this.need('listSecurityGroupRules')(zone, groupId, this.credentials)) {
      const ours = rule.editable && rule.direction === 'inbound' && rule.action === 'accept' && rule.ipRange === '0.0.0.0/0'
        && (rule.protocol === 'TCP' || rule.protocol === 'UDP') && rule.port !== null;
      if (!ours) continue;
      if (!missing.delete(keyOf(rule))) await this.need('deleteSecurityGroupRule')(zone, groupId, rule.id, this.credentials);
    }
    for (const rule of missing.values()) await this.need('addSecurityGroupRule')(zone, groupId, rule, this.credentials);
  }

  /**
   * Each piece on its own, and an already-deleted one (404) counts as done: a retry after the IP went must still reach
   * the firewall (a live test on 06/10/2026 left the security group behind because every retry stopped at the IP's 404).
   */
  async releaseNetwork(network: DeploymentNetwork): Promise<void> {
    const gone = (err: unknown) => (err as { status?: number })?.status === 404 || /HTTP 404/.test(String(err));
    const errors: unknown[] = [];
    for (const del of [
      () => this.need('deleteIp')(network.zone, network.ipId, this.credentials),
      () => this.need('deleteSecurityGroup')(network.zone, network.groupId, this.credentials),
    ]) {
      try { await del(); } catch (err) { if (!gone(err)) errors.push(err); }
    }
    if (errors.length) throw errors[0];
  }

  async stopReplica(machine: ReplicaMachine): Promise<void> {
    await this.need('stopInstance')(machine.id, this.credentials);
  }

  async startReplica(machine: ReplicaMachine): Promise<void> {
    await this.need('startInstance')(machine.id, this.credentials);
  }

  async hourlyPrice(zone: string, machineType: string): Promise<number | null> {
    return this.client.getHourlyPrice(zone, machineType, this.credentials);
  }

  /** GPU types' price and stock per zone (`products/servers` + availability), for ranking `candidates`. */
  async catalog(zones: string[]): Promise<CatalogEntry[]> {
    if (!this.client.listGpuOffers) return [];
    const offers = await this.client.listGpuOffers(zones, this.credentials);
    return offers.map(o => ({ zone: o.zone, machineType: o.commercialType, hourlyPrice: o.hourlyPrice, availability: o.availability }));
  }

  /** Scaleway Container Registry (`rg.<region>.scw.cloud/<namespace>/…`) logs in with user `nologin` and the API secret. */
  registryAuthFor(image: string): RegistryAuth | null {
    const server = /^(rg\.[a-z]{2}-[a-z]{3}\.scw\.cloud)\//.exec(image)?.[1];
    return server ? { server, username: 'nologin', password: this.credentials.apiKey as string } : null;
  }
}
