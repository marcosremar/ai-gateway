/**
 * In-memory Vast hot/warm pool — claim/release without Turso.
 *
 * Warm instances are single-use: `release` destroys the instance, then
 * `refill` best-effort restores `minWarm` idle slots.
 */

import type { GpuInstance, InstanceSpec, ProviderCredentials } from '../gateway/providers/gpu/types';

export type VastHotPoolClient = {
  createInstance: (spec: InstanceSpec, credentials: ProviderCredentials) => Promise<GpuInstance>;
  deleteInstance: (instanceId: string, credentials: ProviderCredentials) => Promise<void>;
  listInstances?: (credentials: ProviderCredentials) => Promise<GpuInstance[]>;
  getInstanceStatus?: (instanceId: string, credentials: ProviderCredentials) => Promise<string | null>;
};

export type VastHotPoolOpts = {
  client: VastHotPoolClient;
  credentials: ProviderCredentials;
  /** Desired warm idle instances. Default: env VAST_MIN_WARM or 0. */
  minWarm?: number;
  /** Hard cap on idle + claimed. Default: max(minWarm, 1). */
  maxSize?: number;
  /** Spec used for provisioning — should include `offerPolicy: 'desktop'`. */
  createSpec: InstanceSpec;
};

function resolveMinWarm(opts: VastHotPoolOpts): number {
  if (opts.minWarm != null) return Math.max(0, opts.minWarm);
  const fromEnv = parseInt(process.env.VAST_MIN_WARM ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 0;
}

export class VastHotPool {
  private idle: GpuInstance[] = [];
  private claimed = new Set<string>();
  private refillInFlight: Promise<void> | null = null;

  constructor(private readonly opts: VastHotPoolOpts) {}

  /** Claim a warm instance or provision one. */
  async acquire(): Promise<GpuInstance> {
    const warm = this.idle.shift();
    if (warm) {
      this.claimed.add(warm.instanceId);
      void this.refill().catch(() => {});
      return warm;
    }
    const inst = await this.opts.client.createInstance(this.opts.createSpec, this.opts.credentials);
    this.claimed.add(inst.instanceId);
    return inst;
  }

  /** Destroy the instance (hot pool = single-use warm; release destroys). */
  async release(instanceId: string): Promise<void> {
    this.claimed.delete(instanceId);
    this.idle = this.idle.filter((i) => i.instanceId !== instanceId);
    await this.opts.client.deleteInstance(instanceId, this.opts.credentials);
    void this.refill().catch(() => {});
  }

  /** Ensure minWarm idle instances exist (best-effort, serialized). */
  async refill(): Promise<void> {
    if (this.refillInFlight) return this.refillInFlight;
    this.refillInFlight = this.doRefill().finally(() => {
      this.refillInFlight = null;
    });
    return this.refillInFlight;
  }

  /** Idle count (for tests / diagnostics). */
  get idleCount(): number {
    return this.idle.length;
  }

  /** Claimed count (for tests / diagnostics). */
  get claimedCount(): number {
    return this.claimed.size;
  }

  private async doRefill(): Promise<void> {
    const minWarm = resolveMinWarm(this.opts);
    const maxSize = this.opts.maxSize ?? Math.max(minWarm, 1);
    while (this.idle.length < minWarm && this.idle.length + this.claimed.size < maxSize) {
      const inst = await this.opts.client.createInstance(this.opts.createSpec, this.opts.credentials);
      this.idle.push(inst);
    }
  }
}
