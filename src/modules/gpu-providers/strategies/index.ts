// ── Strategy registry ────────────────────────────────────────────────────────
// Per-provider Strategy singletons. The deploy loop calls
// `getStrategy(providerName)` and asks the strategy how to behave — there are
// no `if (providerName === 'tensordock')` switches anywhere else.

import type { ProviderName } from '../deploy-orchestrator';
import type { ProviderStrategy } from './base-strategy';
import { vastStrategy } from './vast-strategy';
import { runpodStrategy } from './runpod-strategy';
import { tensordockStrategy } from './tensordock-strategy';
import { modalStrategy } from './modal-strategy';
import { vastVmStrategy } from './vast-vm-strategy';
import { hyperstackStrategy } from './hyperstack-strategy';
import { snapgpuStrategy } from './snapgpu-strategy';

export * from './base-strategy';
export * from './snapshot-port';

export const strategies: Record<ProviderName, ProviderStrategy> = {
  runpod: runpodStrategy,
  vast: vastStrategy,
  'vast-vm': vastVmStrategy,
  tensordock: tensordockStrategy,
  modal: modalStrategy,
  snapgpu: snapgpuStrategy,
  hyperstack: hyperstackStrategy,
};

export function getStrategy(name: ProviderName): ProviderStrategy {
  const strat = strategies[name];
  if (!strat) {
    throw new Error(`No strategy registered for provider '${name}'`);
  }
  return strat;
}

export {
  vastStrategy,
  runpodStrategy,
  tensordockStrategy,
  modalStrategy,
  vastVmStrategy,
  hyperstackStrategy,
  snapgpuStrategy,
};
