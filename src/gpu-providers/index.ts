/**
 * @internal GPU Provider implementations — NOT part of the public API.
 *
 * These classes are implementation details used by the Autoscaler and AIClient internally.
 * External consumers should use:
 *   - `AIClient.deploy()` / `destroyInstance()` / `waitForHealth()` for GPU lifecycle
 *   - `AIClient.pipeline()` for transparent GPU-vs-cloud routing
 *
 * If you need direct access (e.g. for a custom autoscaler), import from this subpath,
 * but be aware these are internal and may change without notice.
 */

// ── Types ─────────────────────────────────────────────────────────────────
export type {
  ProviderCredentials,
  GpuInstance,
  InstanceSpec,
  GpuProviderClient,
  MonitorableProvider,
  OnInstancePersist,
  GpuOffer,
  ListOffersOptions,
} from './types';

// ── Abstract Base Class ──────────────────────────────────────────────────
export { AbstractGpuProvider, FetchError, RateLimiter, TIMEOUTS, DEFAULT_RATE_LIMIT_MS } from './abstract-provider';
export type { AbstractGpuProviderOptions } from './abstract-provider';

// ── Registry ──────────────────────────────────────────────────────────────
export { GpuProviderRegistry } from './registry';

// ── RunPod ────────────────────────────────────────────────────────────────
export { RunpodClient, RUNPOD_GPU_FALLBACK, RUNPOD_GPU_TYPE_MAP } from './runpod-client';

// ── TensorDock ────────────────────────────────────────────────────────────
export {
  TensordockClient,
  TENSORDOCK_V2_BASE,
  GPU_ID_MAP,
  findSshKey,
  findCheapestLocations,
  buildCloudInit,
  buildEnvFlags,
  buildExportLines,
  b64,
  buildMonitorScript,
  getDefaultSshPubKey,
} from './tensordock-client';
export type { CloudInitSpec, DockerSetupPhase, GitCloneSetupPhase, TensordockBalance, TensordockInstanceDetail } from './tensordock-client';

// ── Vast.ai ───────────────────────────────────────────────────────────────
export { VastClient } from './vast-client';
export type { VastClientOptions } from './vast-client';

// ── Modal ─────────────────────────────────────────────────────────────────
export { ModalClient } from './modal-client';

// ── Deploy Orchestrator ──────────────────────────────────────────────────
export {
  ProviderCooldownTracker,
  cleanupProviderInstances,
  filterTiers,
  PROVIDER_LABELS,
  DEFAULT_STORAGE_GB,
} from './deploy-orchestrator';
export type { ProviderName, GpuTier, CooldownInfo } from './deploy-orchestrator';
