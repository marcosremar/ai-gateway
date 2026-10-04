/**
 * `DeploymentBackend` over `ScalewayClient`. Every replica carries three tags:
 *   `aigw-deploy` · `aigw-ns-<namespace>` · `aigw-dep-<deployment>`
 * The namespace keeps two gateways sharing one Scaleway project from adopting (or deleting) each other's machines.
 */

import { ScalewayClient } from '../cpu-providers/scaleway-client';
import type { GpuInstance, ProviderCredentials } from '../gpu-providers/types';
import type { CreateReplicaInput, DeploymentBackend, ReplicaMachine } from './types';

export const DEPLOY_TAG = 'aigw-deploy';
export const nsTag = (ns: string) => `aigw-ns-${ns}`;
export const depTag = (name: string) => `aigw-dep-${name}`;

/** Ubuntu Noble GPU OS 12 in fr-par-2 (Docker + NVIDIA container toolkit preinstalled). */
const GPU_OS_IMAGE_FR_PAR_2 = '3307b9e4-3cfa-49b5-896e-ce914e4ef4aa';

type ScalewayLike = Pick<ScalewayClient, 'createInstance' | 'listInstancesByTag' | 'releaseInstance' | 'getHourlyPrice' | 'imageLike'>;

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
  };
}

export class ScalewayDeploymentBackend implements DeploymentBackend {
  readonly provider = 'scaleway' as const;
  private readonly credentials: ProviderCredentials;
  private readonly client: ScalewayLike;

  constructor(secretKey: string, private readonly opts: { projectId?: string; client?: ScalewayLike } = {}) {
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
    const inst = await this.client.createInstance({
      label: `aigw-${spec.name}-${Date.now().toString(36)}`,
      region: spec.zone,
      commercialType: spec.machineType,
      ...(imageId ? { imageId } : {}),
      ...(spec.volumeGb ? { volumeGb: spec.volumeGb } : {}),
      tags: [DEPLOY_TAG, nsTag(input.namespace), depTag(spec.name)],
      cloudInit: input.cloudInit,
      ...(this.opts.projectId ? { projectId: this.opts.projectId } : {}),
    }, this.credentials);
    const machine = toMachine(inst, spec.name);
    if (!machine) throw new Error('scaleway returned an instance without tags');
    return machine;
  }

  async listReplicas(namespace: string): Promise<ReplicaMachine[]> {
    const list = await this.client.listInstancesByTag(nsTag(namespace), this.credentials,
      this.opts.projectId ? { projectId: this.opts.projectId } : {});
    return list.map(inst => toMachine(inst)).filter((m): m is ReplicaMachine => m !== null);
  }

  async releaseReplica(machine: ReplicaMachine): Promise<void> {
    await this.client.releaseInstance(machine.id, this.credentials, { awaitVolumes: false });
  }

  async hourlyPrice(zone: string, machineType: string): Promise<number | null> {
    return this.client.getHourlyPrice(zone, machineType, this.credentials);
  }
}
