// ── DeployExtra — caller-supplied options that flow through the deploy loop ──
// Moved here from `server/gpu-deploy-loop.ts` so the per-provider Strategy
// files in `src/gpu-providers/strategies/` can reference it without crossing
// the `src/ → server/` boundary (CI-enforced).
//
// `server/gpu-deploy-loop.ts` re-exports this type for backward compatibility
// with callers that still import `DeployExtra` from the server module.

export interface DeployExtra {
  region?: string;
  storageGb?: number;
  hfToken?: string;
  env?: Record<string, string>;
  interruptible?: boolean;
  dockerStartCmd?: string;
  onstart?: string;
  containerDiskInGb?: number;
  volumeId?: string;
  autoRecovery?: boolean;
  templateHashId?: string;
  forceSshTunnel?: boolean;
  /** Task identity label — propagated to provider as instance label
   *  so orphans can be reconciled back to their owning task. Required
   *  by handleGpuDeploy unless AIGW_LABEL_OPTIONAL=1. */
  label?: string;
  /** Bump host-quality threshold + suppress SSH-only-host fallback in
   *  Vast offer search. See InstanceSpec.strictFastBoot. */
  strictFastBoot?: boolean;
  snapgpuPreloadApp?: string;
  snapgpuAutoSnapshot?: boolean;
  snapgpuBackend?: 'vast' | 'runpod';
  canary?: boolean;
  canaryInitialTraffic?: number;
  canaryMaxErrorRate?: number;
  canaryTrafficStep?: number;
  /** Explicit race count from caller — when 1, suppress in-loop retry. */
  raceCount?: number;
  /** When true, single-tier deploy: no fallback to next provider. */
  noTierCascade?: boolean;
  /** Vast.ai offer search mode: 'high_quality' (default — reliable, direct-port
   *  hosts) or 'full' (widen the search to all rentable offers). See
   *  InstanceSpec.searchMode. */
  searchMode?: 'high_quality' | 'full';
  /** Require the Vast host to expose at least one direct (non-SSH) port. */
  requireDirectPort?: boolean;
}
