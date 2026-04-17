// ── GPU Tier Configuration + Cooldown Tracking ──────────────────────────────
// Tiers are tried in order (like ai-gateway autoscaler). If tier 0 fails,
// tier 1 is attempted automatically. Provider cooldowns persisted to disk.

import { homedir } from 'os';
import { join } from 'path';
import type { GpuProviderClient } from '../src/gpu-providers/types';
import { ProviderCooldownTracker, PROVIDER_LABELS } from '../src/gpu-providers/deploy-orchestrator';
import type { ProviderName, GpuTier } from '../src/gpu-providers/deploy-orchestrator';
import { createLogger } from '../src/logger';
import { runpod, vast, vastVm, tensordock, modal, snapgpu, hyperstack } from './providers';
import { PROVIDER_CHAIN } from './config';

const log = createLogger('gpu-deploy');

// ── Provider Cooldown (persisted to ~/.babelcast/cooldowns.json) ─────────────
export const cooldownTracker = new ProviderCooldownTracker();
void cooldownTracker.loadFromFile(join(homedir(), '.babelcast', 'cooldowns.json'));
{
  const active = cooldownTracker.getActiveCooldowns();
  const names = Object.keys(active);
  if (names.length > 0) {
    log.log(`[gateway] Restored cooldowns: ${names.map(n => `${n} (${active[n].remainSec}s left)`).join(', ')}`);
  }
}

/** Map of provider name → client instance for tier building. */
export const providerClients: Record<ProviderName, GpuProviderClient> = {
  runpod,
  vast,
  'vast-vm': vastVm,
  tensordock,
  modal,
  snapgpu,
  hyperstack,
};

export function buildGpuTiers(
  runpodApiKey: string,
  vastApiKey?: string,
  tensordockOpts?: { apiKey: string; authId: string },
  modalApiKey?: string,
  hyperstackApiKey?: string,
): GpuTier[] {
  // Build a map of available providers
  const available: Record<string, GpuTier | null> = {
    runpod: runpodApiKey ? { client: runpod, name: 'runpod', label: PROVIDER_LABELS.runpod, apiKey: runpodApiKey } : null,
    tensordock: tensordockOpts ? { client: tensordock, name: 'tensordock', label: PROVIDER_LABELS.tensordock, apiKey: tensordockOpts.apiKey, authId: tensordockOpts.authId } : null,
    vast: vastApiKey ? { client: vast, name: 'vast', label: PROVIDER_LABELS.vast, apiKey: vastApiKey } : null,
    // Vast.ai VM mode shares the same API key as containers — treated as a
    // distinct tier so the cascade can prefer it (or fall back to it)
    // independently. Only activated when callers opt in via PROVIDER_CHAIN.
    'vast-vm': vastApiKey ? { client: vastVm, name: 'vast-vm', label: PROVIDER_LABELS['vast-vm'], apiKey: vastApiKey } : null,
    modal: modalApiKey ? { client: modal, name: 'modal', label: PROVIDER_LABELS.modal, apiKey: modalApiKey } : null,
    hyperstack: hyperstackApiKey ? { client: hyperstack, name: 'hyperstack', label: PROVIDER_LABELS.hyperstack, apiKey: hyperstackApiKey } : null,
  };

  // GPU provider cascade order: Vast.ai → RunPod → Modal
  // (TensorDock excluded by default due to balance constraints and reliability issues)
  const tiers: GpuTier[] = [];
  const added = new Set<string>();
  const gpuInChain = PROVIDER_CHAIN.filter(p =>
    p === 'runpod' ||
    p === 'tensordock' ||
    p === 'vast' ||
    p === 'vast-vm' ||
    p === 'modal' ||
    p === 'hyperstack',
  );

  // If chain has individual GPU providers, use their order
  if (gpuInChain.length > 0) {
    for (const name of gpuInChain) {
      const tier = available[name];
      if (tier && !added.has(name)) {
        tiers.push(tier);
        added.add(name);
      }
    }
  }

  // Default GPU provider order: Vast.ai → RunPod → Modal (skip TensorDock unless explicitly in chain)
  const defaultGpuOrder = ['vast', 'runpod', 'modal'];
  for (const name of defaultGpuOrder) {
    const tier = available[name];
    if (tier && !added.has(name)) {
      tiers.push(tier);
      added.add(name);
    }
  }

  // Add any providers not yet added (legacy "gpu" mode or providers not in chain)
  for (const [name, tier] of Object.entries(available)) {
    if (tier && !added.has(name)) {
      tiers.push(tier);
      added.add(name);
    }
  }

  return tiers;
}

/**
 * Classify a deploy failure into categories.
 *
 * Host-attributable (penalizes reputation):
 *   timeout, crashed, network, unknown
 *
 * Non-host (does NOT penalize reputation):
 *   billing, api_error, docker_image, cancelled
 */
export function categorizeDeployFailure(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('balance') || m.includes('funds') || m.includes('insufficient') || m.includes('need at least')) return 'billing';
  if (m.includes('image') && (m.includes('pull') || m.includes('not found') || m.includes('manifest') || m.includes('registry'))) return 'docker_image';
  if (m.includes('docker') && (m.includes('error') || m.includes('failed'))) return 'docker_image';
  if (m.includes('cancelled') || m.includes('canceled')) return 'cancelled';
  if (m.includes('timed out') || m.includes('timeout')) return 'timeout';
  if (m.includes('crashed') || m.includes('exited') || m.includes('terminated')) return 'crashed';
  if (message.includes('API') || message.includes('401') || message.includes('403') || message.includes('500')) return 'api_error';
  if (m.includes('network') || m.includes('econnrefused') || m.includes('etimedout') || m.includes('fetch failed')) return 'network';
  return 'unknown';
}
