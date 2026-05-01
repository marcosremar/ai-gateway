// ── Reservation port ─────────────────────────────────────────────────────────
// A `Reservation` is the durable handle for a GPU instance the deploy loop
// has secured. Owners hold one until they're done with it and call
// `release()`; the underlying strategy decides what release means
// (`deleteInstance` for most providers, but Modal/SnapGPU may need extras).

import type { GpuProviderClient, ProviderCredentials } from '../types';
import type { ProviderName } from '../deploy-orchestrator';
import type { ProviderStrategy } from '../strategies/base-strategy';

export interface Reservation {
  readonly id: string;
  readonly provider: ProviderName;
  readonly costPerHr: number;
  readonly createdAt: number;
  readonly endpoint: string;
  readonly sshHost?: string;
  readonly sshPort?: number;
  readonly providerMeta?: Record<string, unknown>;
  /** Tear down the reservation (delete pod). Idempotent — calling release
   *  twice is a no-op for any sensible provider client. */
  release(): Promise<void>;
}

export class ProviderReservation implements Reservation {
  constructor(
    public readonly id: string,
    public readonly provider: ProviderName,
    public readonly costPerHr: number,
    public readonly createdAt: number,
    public readonly endpoint: string,
    public readonly sshHost: string | undefined,
    public readonly sshPort: number | undefined,
    public readonly providerMeta: Record<string, unknown> | undefined,
    private readonly client: GpuProviderClient,
    private readonly creds: ProviderCredentials,
    private readonly strategy: ProviderStrategy,
  ) {}

  async release(): Promise<void> {
    await this.strategy.cleanup(this.client, this.id, this.creds);
  }
}
