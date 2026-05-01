// ── Reservation factory ──────────────────────────────────────────────────────
// One-stop shop for "create instance + wrap as reservation". The deploy loop
// can call `createReservation(strategy, client, creds, opts)` and get a
// typed `Reservation` back; release is delegated to the strategy.

import type { GpuProviderClient, ProviderCredentials } from '../types';
import type { CreateOptionsBase, ProviderStrategy } from '../strategies/base-strategy';
import type { DeployExtra } from '../deploy-extra';
import { ProviderReservation, type Reservation } from './base-reservation';

export type { Reservation } from './base-reservation';
export { ProviderReservation } from './base-reservation';

export interface CreateReservationOpts {
  base: CreateOptionsBase;
  extra: DeployExtra;
  /** Optional userId forwarded to providers that persist instance metadata. */
  userId?: string;
}

export async function createReservation(
  strategy: ProviderStrategy,
  client: GpuProviderClient,
  creds: ProviderCredentials,
  opts: CreateReservationOpts,
): Promise<Reservation> {
  const spec = strategy.buildCreateOptions(opts.base, opts.extra);
  const instance = await client.createInstance(spec, creds, opts.userId);
  const meta = (instance.providerMeta ?? {}) as Record<string, unknown>;
  const costPerHr =
    (meta.dphTotal as number) ||
    (meta.costPerHr as number) ||
    (meta.pricePerHr as number) ||
    0;
  return new ProviderReservation(
    instance.instanceId,
    strategy.name,
    costPerHr,
    Date.now(),
    instance.endpoint,
    instance.sshHost,
    instance.sshPort,
    meta,
    client,
    creds,
    strategy,
  );
}
