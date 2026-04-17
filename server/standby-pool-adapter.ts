// ── Standby Pool Adapter ─────────────────────────────────────────────────────
//
// Concrete wiring between the standby-pool module (policy) and the GPU
// provider clients (infrastructure). The pool module stays transport-agnostic;
// this adapter is the only place that imports `vastVm` / `hyperstack` /
// env vars for pool deploys.
//
// Safety posture — explicit opt-in, hard caps:
//   1. Pool only activates for profiles registered via setStandbyPoolConfig().
//      No auto-registration.
//   2. Adapter install is idempotent and gated on API-key presence. Tiers
//      without a configured key are rejected at deploy time.
//   3. POOL_GLOBAL_MAX caps total standby pods across ALL profiles to prevent
//      runaway cost from a misconfigured maxStandby. Tune via
//      STANDBY_POOL_GLOBAL_MAX env var.
//
// This file is intentionally conservative — a standby pool that spawns too
// many GPUs is worse than one that spawns none.

import { createLogger } from '../src/logger';
import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import {
  setPoolAdapters,
  getStandbyPoolStatus,
  type StandbyProfileConfig,
  type StandbyPodRecord,
  type StandbyTier,
} from './standby-pool';
import { vastVm, hyperstack } from './providers';
import { emitGatewayEvent } from './event-bus';

const log = createLogger('standby-pool-adapter');

const DEFAULT_POOL_GLOBAL_MAX = 4;
const DEFAULT_POOL_HEALTH_TIMEOUT_MS = 20 * 60_000;
const POOL_HEALTH_POLL_MS = 5_000;

function globalMax(): number {
  const v = process.env.STANDBY_POOL_GLOBAL_MAX;
  return v !== undefined ? Number(v) : DEFAULT_POOL_GLOBAL_MAX;
}

function healthTimeoutMs(): number {
  const v = process.env.STANDBY_POOL_HEALTH_TIMEOUT_MS;
  return v !== undefined ? Number(v) : DEFAULT_POOL_HEALTH_TIMEOUT_MS;
}

interface TierBinding {
  client: GpuProviderClient;
  credentials: ProviderCredentials;
}

function resolveTier(tier: StandbyTier): TierBinding | null {
  if (tier === 'vast-vm') {
    const apiKey = process.env.VAST_API_KEY;
    if (!apiKey) {
      log.warn('VAST_API_KEY not set — vast-vm tier disabled');
      return null;
    }
    return { client: vastVm, credentials: { apiKey } };
  }
  if (tier === 'hyperstack') {
    const apiKey = process.env.HYPERSTACK_API_KEY;
    if (!apiKey) {
      log.warn('HYPERSTACK_API_KEY not set — hyperstack tier disabled');
      return null;
    }
    return { client: hyperstack, credentials: { apiKey } };
  }
  log.warn(`Unknown tier: ${tier}`);
  return null;
}

async function waitForHealthy(endpoint: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return true;
    } catch {
      // swallow — probe failure during boot is expected
    }
    await new Promise((resolve) => setTimeout(resolve, POOL_HEALTH_POLL_MS));
  }
  return false;
}

async function poolDeploy(cfg: StandbyProfileConfig): Promise<StandbyPodRecord | null> {
  const current = getStandbyPoolStatus().pods.length;
  const max = globalMax();
  if (current >= max) {
    log.warn(
      `Global pool cap reached (${current}/${max}) — refusing deploy for ${cfg.profile}`,
    );
    return null;
  }

  const binding = resolveTier(cfg.tier);
  if (!binding) return null;

  const startedAt = Date.now();
  let instance;
  try {
    instance = await binding.client.createInstance(
      {
        gpuTypes: cfg.gpuTypes,
        dockerImage: cfg.dockerImage,
      },
      binding.credentials,
    );
  } catch (err) {
    log.warn(
      `[pool] createInstance failed for ${cfg.profile} on ${cfg.tier}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  if (!instance.endpoint) {
    log.warn(`[pool] createInstance returned no endpoint for ${cfg.profile}, terminating`);
    binding.client.deleteInstance(instance.instanceId, binding.credentials).catch(() => {});
    return null;
  }

  const healthy = await waitForHealthy(instance.endpoint, startedAt + healthTimeoutMs());
  if (!healthy) {
    log.warn(
      `[pool] ${instance.instanceId} never became healthy for ${cfg.profile} — terminating`,
    );
    binding.client.deleteInstance(instance.instanceId, binding.credentials).catch(() => {});
    return null;
  }

  log.log(
    `[pool] ${cfg.profile} deployed ${instance.instanceId} on ${cfg.tier} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  emitGatewayEvent('gpu.deployed', {
    podId: instance.instanceId,
    provider: cfg.tier,
    profile: cfg.profile,
    viaPool: true,
  });

  return {
    podId: instance.instanceId,
    endpoint: instance.endpoint,
    profile: cfg.profile,
    tier: cfg.tier,
    deployedAt: Date.now(),
    inPool: true,
    lastCheckedAt: Date.now(),
  };
}

async function poolTerminate(pod: StandbyPodRecord): Promise<void> {
  const binding = resolveTier(pod.tier);
  if (!binding) return;
  try {
    await binding.client.deleteInstance(pod.podId, binding.credentials);
    log.log(`[pool] terminated ${pod.podId} (${pod.profile})`);
    emitGatewayEvent('gpu.terminated', {
      podId: pod.podId,
      provider: pod.tier,
      profile: pod.profile,
      viaPool: true,
    });
  } catch (err) {
    log.warn(
      `[pool] deleteInstance failed for ${pod.podId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

let _installed = false;

/** Idempotent — safe to call multiple times from startup paths. */
export function installPoolAdaptersIfEnabled(): void {
  if (_installed) return;
  const hasVastVm = !!process.env.VAST_API_KEY;
  const hasHyperstack = !!process.env.HYPERSTACK_API_KEY;
  if (!hasVastVm && !hasHyperstack) {
    log.log(
      'No snapshot-capable provider keys set (VAST_API_KEY, HYPERSTACK_API_KEY) — pool adapters not installed',
    );
    return;
  }
  setPoolAdapters(poolDeploy, poolTerminate);
  _installed = true;
  log.log(
    `Pool adapters installed (tiers: ${[hasVastVm && 'vast-vm', hasHyperstack && 'hyperstack'].filter(Boolean).join(', ')}; global cap: ${globalMax()})`,
  );
}

/** Test hook — reset installed flag so tests can reinstall. */
export function _resetAdapterForTests(): void {
  _installed = false;
}
