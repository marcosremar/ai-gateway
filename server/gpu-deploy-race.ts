// ── Hedged / Race Deploy — launch N instances, keep the first healthy ────────

import type { GpuProviderClient } from '../src/gpu-providers/types';
import type { GpuTier, ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import { DEFAULT_STORAGE_GB } from '../src/gpu-providers/deploy-orchestrator';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import { createLogger } from '../src/logger';
import {
  deployState, setDeployState, deployCancelled,
  setDeployApiKey, setDeployVastApiKey, setDeployTensordockApiKey,
  setDeployTensordockAuthId, setDeployModalApiKey, setDeployHyperstackApiKey,
  setGpuHealthy, setLastRequestTime,
  deploymentSM, updateGpuModelWarmth,
} from './state';
import { broadcastProviderStatus, broadcastWs } from './ws-state';
import { extractAppHealthError, runGlbSmokeTest, validateEndpointApiContract } from './gpu-poll-health';
import { emitGatewayEvent } from './event-bus';
import { logGpuEvent, upsertHostReputation } from './metrics';
import { getDeployTimeoutMinForProvider } from '../src/gpu-providers/deploy-settings';
import { activeRaceInstanceIds } from './gpu-orphan-cleanup';
import type { DeployExtra } from './gpu-deploy';

const log = createLogger('gpu-deploy');
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
// Kept only as a documented constant for the legacy fallback path. The
// actual per-image script lookup goes through `modalStrategy.resolveImage`
// (see `src/modules/gpu-providers/strategies/modal-strategy.ts`) so the
// trellis2/babelcast/etc Modal apps each get the right `.py` instead of
// every modal slot collapsing onto babelcast.py and crashing.
const MODAL_DEPLOY_SCRIPT_FALLBACK = resolve(SERVER_DIR, '..', 'dockers', 'modal', 'babelcast.py');
import { modalStrategy } from '../src/modules/gpu-providers/strategies';
function modalScriptFor(image: string): string {
  try {
    return modalStrategy.resolveImage(image);
  } catch {
    return MODAL_DEPLOY_SCRIPT_FALLBACK;
  }
}

/** Flat per-instance hourly cost prior used to gate race deploys when no live
 *  offer price is available. Matches the budget-gate estimate ($2/instance). */
export const RACE_EST_PER_INSTANCE_HR = 2;

/**
 * Decide how many race slots fit under a per-deploy cost cap (#105).
 *
 * Race losers all bill during boot, so N simultaneous instances burn
 * `N × estPerInstanceHr` per hour. Given `maxCostUsd` (interpreted as the
 * acceptable simultaneous hourly burn), return the largest `allowedRaceN ≤
 * raceN` whose burn stays at or under the cap. If even one instance exceeds
 * the cap, `rejected` is true.
 */
export function computeRaceBudget(
  raceN: number,
  estPerInstanceHr: number,
  maxCostUsd: number,
): { allowedRaceN: number; estimatedCost: number; rejected: boolean } {
  const per = estPerInstanceHr > 0 ? estPerInstanceHr : RACE_EST_PER_INSTANCE_HR;
  if (per > maxCostUsd) {
    return { allowedRaceN: 0, estimatedCost: per, rejected: true };
  }
  const allowedRaceN = Math.max(1, Math.min(raceN, Math.floor(maxCostUsd / per)));
  return { allowedRaceN, estimatedCost: allowedRaceN * per, rejected: false };
}

/**
 * Resolve the storage (GB) for a provider slot, honoring an explicit override
 * (#156).
 *
 * The previous `DEFAULT_STORAGE_GB[name] || 50` hid two real cases: a provider
 * whose default is 0 ("use provider default", e.g. modal/hyperstack) was
 * silently bumped to 50 GB, and a typo'd/unknown provider also got 50 GB
 * instead of surfacing the gap. This uses `??` so a configured 0 is preserved,
 * and only falls back to 50 GB for a provider with no map entry at all.
 *
 * @param name      Provider name (keys of DEFAULT_STORAGE_GB).
 * @param override  Caller-supplied storageGb (verbatim when > 0).
 */
export function storageGbForProvider(name: ProviderName, override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const dflt = DEFAULT_STORAGE_GB[name];
  return typeof dflt === 'number' ? dflt : 50;
}

/**
 * Build the provider-interleaved (tier, gpuType) pair list for a race deploy,
 * bounded so the loop can't over-generate (#147).
 *
 * Diversity-first: one slot per tier per round before repeating a tier, e.g.
 * `[Vast×4090, TDock×4090, Vast×A6000, TDock×A6000, …]`. We only ever need
 * `raceN` slots filled from the front, so cap generation at `raceN` pairs
 * (plus one spare for modulo wrap) instead of the old `raceN*2+1` that always
 * ran every round regardless of need.
 *
 * @param tiers     Usable provider tiers (already credential-filtered).
 * @param gpuTypes  GPU priority list; `[]`/`[null]` means "provider default".
 * @param raceN     Number of slots to fill.
 */
export function buildRacePairs(
  tiers: GpuTier[],
  gpuTypes: Array<string | null>,
  raceN: number,
): Array<{ tier: GpuTier; gpuType: string | null }> {
  if (tiers.length === 0 || raceN <= 0) return [];
  const gpuList = gpuTypes.length > 0 ? gpuTypes : [null];
  const tierQueues = tiers.map((t) => gpuList.map((g) => ({ tier: t, gpuType: g })));
  const pairs: Array<{ tier: GpuTier; gpuType: string | null }> = [];
  // One spare beyond raceN keeps `pairs[i % pairs.length]` well-distributed
  // when raceN exceeds the distinct (tier,gpu) combos.
  const target = raceN + 1;
  // Hard upper bound on rounds: every distinct combo, never an unbounded spin.
  const maxRounds = gpuList.length + 1;
  for (let round = 0; pairs.length < target && round < maxRounds; round++) {
    for (const q of tierQueues) {
      if (q.length === 0) continue;
      pairs.push(q[round < q.length ? round : round % q.length]);
      if (pairs.length >= target) break;
    }
  }
  return pairs;
}

/**
 * Aggregate wasted race-loser cost by provider for observability (#119).
 *
 * Wasted-USD per loser was logged but never summed per provider/GPU, so
 * operators couldn't see which provider's slow boots cost the most. Pure so it
 * can be unit-tested and fed to a metric. Excludes the winner.
 */
export function summarizeRaceWaste(
  losers: Array<{ provider: string; gpuType?: string; wastedUsd: number }>,
): { byProvider: Record<string, number>; totalUsd: number } {
  const byProvider: Record<string, number> = {};
  let totalUsd = 0;
  for (const l of losers) {
    const usd = Number.isFinite(l.wastedUsd) && l.wastedUsd > 0 ? l.wastedUsd : 0;
    byProvider[l.provider] = (byProvider[l.provider] ?? 0) + usd;
    totalUsd += usd;
  }
  return { byProvider, totalUsd };
}

/**
 * Count the non-winner race slots whose teardown is still outstanding (#150).
 *
 * The winner sets `raceDone`, starts monitoring/canary, and returns while loser
 * cleanup runs in other promise branches; if a loser delete throws, the orphan
 * sweep is the only safety net. This pure count lets the winner path log how many
 * losers are still pending teardown (observability) without changing timing.
 * Pure — `winnerInstanceId` null means no winner yet (all are outstanding).
 */
export function countOutstandingLoserDeletes(
  candidates: ReadonlyArray<{ instanceId: string }>,
  winnerInstanceId: string | null | undefined,
): number {
  return candidates.filter((c) => c.instanceId !== winnerInstanceId).length;
}

/** Number of times to retry a failed race-loser delete before giving up (#153). */
export const LOSER_DELETE_MAX_ATTEMPTS = 3;
/** Base backoff (ms) between race-loser delete retries (#153). */
export const LOSER_DELETE_BACKOFF_MS = 2_000;

/**
 * Backoff schedule for retrying a failed race-loser delete (#153).
 *
 * A failed loser `deleteInstance` previously only logged and waited for the
 * orphan sweep, but the sweep's grace window (45 min) far exceeds its 10-min
 * interval, so a stray loser could bill up to 45 min. This returns the
 * per-attempt delay schedule for an immediate bounded retry. `attempts <= 1`
 * yields a single immediate attempt (historical behavior). Pure.
 */
export function loserDeleteRetryPlan(
  attempts: number = LOSER_DELETE_MAX_ATTEMPTS,
  backoffMs: number = LOSER_DELETE_BACKOFF_MS,
): number[] {
  const n = Math.max(1, Math.floor(attempts));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i === 0 ? 0 : Math.max(0, backoffMs) * i);
  return out;
}

/**
 * When the caller wants a single-provider race (`noTierCascade` or a forced
 * provider), keep all slots on one tier instead of diversifying across
 * providers (#152).
 *
 * The interleaved pair builder always spreads across tiers; single-provider
 * hedging (e.g. `race=N` on Vast) needs every slot on the chosen tier. Returns
 * the tiers to race over: the first tier alone when single-provider, else all.
 * Pure.
 */
export function tiersForRace(tiers: GpuTier[], noTierCascade?: boolean): GpuTier[] {
  if (noTierCascade && tiers.length > 1) return [tiers[0]];
  return tiers;
}

/**
 * Default `interruptible`/spot for cost-sensitive race deploys (#113).
 *
 * A multi-slot race bills `raceN-1` losers for their boot time before discarding
 * them — exactly the throwaway workload that should run on cheap spot instances.
 * When the caller didn't set `interruptible` explicitly, default it to true for
 * a real race (raceN > 1); single-instance deploys keep the on-demand default
 * (the winner is the production pod). An explicit value always wins. Pure.
 */
export function defaultRaceInterruptible(
  explicit: boolean | undefined,
  raceN: number,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return raceN > 1;
}

/**
 * Normalize a provider's `resolveInstanceEndpoint` result to a string|null (#168).
 *
 * Providers inconsistently return either a bare URL string or `{ endpoint }`;
 * the race/resume loops papered over this with `as any`. This pure helper
 * accepts both shapes (and null/undefined) and yields a clean `string | null`.
 */
export function normalizeResolvedEndpoint(
  resolved: string | { endpoint?: string | null } | null | undefined,
): string | null {
  if (!resolved) return null;
  if (typeof resolved === 'string') return resolved || null;
  return resolved.endpoint || null;
}

/**
 * Estimate the per-instance hourly race cost from real offer prices instead of
 * the flat $2 prior (#151).
 *
 * A flat estimate both over-rejects cheap 4090s and under-protects expensive
 * A100s. Given the cheapest matching offer price, use it; fall back to the flat
 * prior when no price is known. Pure.
 */
export function estimateRaceCostPerInstance(
  cheapestOfferPricePerHr: number | undefined,
): number {
  return typeof cheapestOfferPricePerHr === 'number' && cheapestOfferPricePerHr > 0
    ? cheapestOfferPricePerHr
    : RACE_EST_PER_INSTANCE_HR;
}

/**
 * Whether the total elapsed resolution time has exceeded its hard deadline
 * (#149).
 *
 * Vast endpoint re-resolution runs every 5s for the whole timeout window with a
 * 30s per-call timeout; a hung resolver could let a slot overrun. This pure
 * predicate lets the loop bound the cumulative resolution budget.
 */
export function resolutionDeadlineExceeded(
  startedAt: number,
  now: number,
  budgetMs: number,
): boolean {
  return now - startedAt >= budgetMs;
}

/**
 * Combine the race-abort signal with a per-fetch timeout so a loser's hung
 * `/health` always has its own deadline (#155).
 *
 * `AbortSignal.any` (Node 20.3+/Bun) merges both. When unavailable, the
 * previous code fell back to ONLY the race signal — a hung fetch on a loser
 * could then block until the whole race timed out. This fallback wires a
 * standalone timeout that aborts a local controller, guaranteeing the per-fetch
 * deadline either way.
 *
 * @param raceSignal  Winner-decided abort signal.
 * @param timeoutMs   Per-fetch timeout.
 * @param deps        Injectable AbortSignal-likes (for tests).
 */
export function combineHealthSignal(
  raceSignal: AbortSignal,
  timeoutMs: number,
  deps: {
    any?: (sigs: AbortSignal[]) => AbortSignal;
    timeout?: (ms: number) => AbortSignal;
  } = {},
): AbortSignal {
  const anyFn = deps.any ?? (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  const timeoutFn = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  if (typeof anyFn === 'function') {
    return anyFn([raceSignal, timeoutFn(timeoutMs)]);
  }
  // Manual fallback: a fresh controller aborted by either the race signal or
  // the timeout — never just the race signal alone.
  const ctrl = new AbortController();
  const onAbort = () => { try { ctrl.abort(); } catch { /* already aborted */ } };
  if (raceSignal.aborted) onAbort();
  else raceSignal.addEventListener('abort', onAbort, { once: true });
  const t = setTimeout(onAbort, timeoutMs);
  if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
    (t as unknown as { unref: () => void }).unref();
  }
  ctrl.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  return ctrl.signal;
}

interface RaceCandidate {
  index: number;
  tier: GpuTier;
  instanceId: string;
  endpoint: string;
  gpuType: string;
  costPerHr: number;
  sshHost: string;
  sshPort: number;
  providerMeta: Record<string, unknown>;
}

export async function startDeployRace(
  tiers: GpuTier[],
  dockerImage: string,
  gpuTypes: string[],
  extra: DeployExtra,
  raceCount: number,
): Promise<void> {
  // Import these lazily to avoid circular dependency at module load time
  const { startGpuMonitoring } = await import('./gpu-health-monitor');
  const { startCanaryIfEnabled } = await import('./gpu-deploy');
  const { cooldownTracker } = await import('./gpu-deploy');

  const deployStartedAt = Date.now();
  let raceN = Math.min(raceCount, 10); // cap at 10

  // ── Provider readiness pre-filter ───────────────────────────────────────
  // Don't waste race slots on providers with no credentials (e.g. Modal with no
  // token, RunPod with no key) — they fail every slot instantly and can mask the
  // configured providers behind a misleading "all slots failed". Safe fallback:
  // if everything looks unconfigured, race the original set untouched.
  {
    const { filterUsableTiers } = await import('../src/modules/gpu-providers/provider-readiness');
    const r = filterUsableTiers(tiers);
    if (r.skipped.length > 0) {
      log.log(`[race] skipping ${r.skipped.length} unconfigured provider(s): ${r.skipped.map(t => t.name).join(', ')} — racing: ${r.usable.map(t => t.name).join(', ')}`);
    } else if (r.fellBack) {
      log.warn('[race] all providers look unconfigured (no creds detected) — racing original set as-is; check provider API keys');
    }
    tiers = r.usable;
  }

  // Single-provider hedging: when noTierCascade is set, keep every slot on the
  // first tier instead of interleaving across providers (#152).
  {
    const single = tiersForRace(tiers, extra.noTierCascade);
    if (single.length !== tiers.length) {
      log.log(`[race] noTierCascade — racing single provider ${single[0]?.name} (${tiers.length}→${single.length} tier)`);
      tiers = single;
    }
  }

  // ── Per-deploy cost cap on race losers (#105) ───────────────────────────
  // Race fires N instances that all bill during boot. When the caller set a
  // maxCostUsd, trim raceN so the simultaneous hourly burn stays under the cap
  // (or reject if even a single instance exceeds it). Uses the same flat
  // $2/instance/hr prior as the budget gate below.
  {
    const cap = extra.maxCostUsd;
    if (cap !== undefined) {
      const plan = computeRaceBudget(raceN, RACE_EST_PER_INSTANCE_HR, cap);
      if (plan.rejected) {
        const msg = `[budget] Race deploy refused: estimated per-instance cost ($${RACE_EST_PER_INSTANCE_HR.toFixed(2)}/hr) exceeds maxCostUsd ($${cap.toFixed(2)})`;
        log.error(msg);
        logGpuEvent('deploy_rejected', tiers[0]?.name ?? 'unknown', false, { metadata: { reason: 'maxCostUsd', maxCostUsd: cap, raceN } });
        setDeployState({ status: 'error', message: msg });
        deploymentSM.markError(msg);
        return;
      }
      if (plan.allowedRaceN < raceN) {
        log.warn(`[race] Trimming raceN ${raceN}→${plan.allowedRaceN} to honor maxCostUsd=$${cap.toFixed(2)} (est $${RACE_EST_PER_INSTANCE_HR.toFixed(2)}/instance/hr)`);
        raceN = plan.allowedRaceN;
      }
    }
  }

  // ── Budget gate (same as startDeployWithTiers) ──────────────────────────
  // Race deploys bypass startDeployWithTiers, so we must guard here too.
  // Estimate: $2 per instance (N instances run simultaneously during boot).
  {
    const { canAffordDeploy } = await import('./state');
    const estimatedCost = Math.max(2, raceN * RACE_EST_PER_INSTANCE_HR);
    const decision = canAffordDeploy(estimatedCost);
    if (!decision.allowed) {
      const msg = `[budget] Race deploy refused: ${decision.reason} (spend=$${decision.currentSpend.toFixed(2)}, projected=$${decision.projected.toFixed(2)}, cap=$${decision.cap.toFixed(2)}, raceN=${raceN})`;
      log.error(msg);
      logGpuEvent('deploy_rejected', tiers[0]?.name ?? 'unknown', false, {
        metadata: { reason: decision.reason, currentSpend: decision.currentSpend, projected: decision.projected, cap: decision.cap, raceN },
      });
      broadcastWs({ type: 'gpu:budget', action: 'deploy-refused', spend: decision.currentSpend, projected: decision.projected, budget: decision.cap, reason: decision.reason });
      setDeployState({ status: 'error', message: msg });
      deploymentSM.markError(msg);
      return;
    }
  }

  // ── Runaway detector (same as startDeployWithTiers) ─────────────────────
  {
    const { getGlobalRunawayDetector } = await import('../src/autoscaler/runaway-detector');
    const detector = getGlobalRunawayDetector();
    const providerName = tiers[0]?.name ?? 'unknown';
    const allowed = detector.recordDeployStart(providerName);
    if (!allowed) {
      const stats = detector.stats(providerName);
      const msg = `[runaway] Race deploy refused: ${providerName} has ${stats.recentStarts} recent starts`;
      log.error(msg);
      logGpuEvent('runaway_pause', providerName, false, { metadata: { recentStarts: stats.recentStarts, raceN } });
      broadcastWs({ type: 'gpu:runaway', action: 'deploy-refused', provider: providerName, recentStarts: stats.recentStarts });
      setDeployState({ status: 'error', message: msg });
      deploymentSM.markError(msg);
      return;
    }
  }

  if (raceN > 1) {
    log.log(`[race] WARNING: race deploy with ${raceN} parallel instances — ${raceN - 1} loser(s) will be billed for boot time (~${getDeployTimeoutMinForProvider('vast')} min max). Cost = (raceCount-1) × costPerHr × boot_min/60.`);
  }

  // Build (tier, gpuType) pair list using provider-interleaved ordering:
  // Prefer diversity across providers before repeating the same provider.
  // e.g. [Vast×4090, TDock×4090, Vast×A6000, TDock×A6000, Vast×4090 ...]
  // rather than [Vast×4090, Vast×A6000, TDock×4090, TDock×A6000 ...]
  const gpuList = gpuTypes.length > 0 ? gpuTypes : [null];
  // Provider-interleaved, bounded pair generation (#147).
  const pairs = buildRacePairs(tiers, gpuList, raceN);

  if (pairs.length === 0) {
    setDeployState({ status: 'error', message: 'No deployment tiers available for race' });
    deploymentSM.markError('No tiers available');
    return;
  }

  const slots = Array.from({ length: raceN }, (_, i) => {
    const { tier, gpuType } = pairs[i % pairs.length];
    return {
      index: i,
      tier,
      gpuTypes: gpuType ? [gpuType] : gpuTypes,
      tierDockerImage: tier.name === 'modal' ? modalScriptFor(dockerImage) : dockerImage,
    };
  });

  log.log(`[race] Hedged deploy: ${slots.length} slots across ${tiers.map(t => t.label).join(', ')}`);

  // Set credentials for all participating tiers
  for (const tier of tiers) {
    if (tier.name === 'runpod') setDeployApiKey(tier.apiKey);
    else if (tier.name === 'vast') setDeployVastApiKey(tier.apiKey);
    else if (tier.name === 'tensordock') { setDeployTensordockApiKey(tier.apiKey); setDeployTensordockAuthId(tier.authId ?? ''); }
    else if (tier.name === 'modal') setDeployModalApiKey(tier.apiKey);
    else if (tier.name === 'hyperstack') setDeployHyperstackApiKey(tier.apiKey);
  }

  setDeployState({
    status: 'creating', startedAt: deployStartedAt, retryCount: 0,
    podId: '', endpoint: '', gpuType: '',
    message: `Launching ${slots.length} instances in parallel...`,
    step: 'creating_pod', stepDetail: '', provider: slots[0].tier.name,
  });

  // Phase 1: Create all instances in parallel
  const createResults = await Promise.allSettled(slots.map(async (slot) => {
    const credentials = { apiKey: slot.tier.apiKey, authId: slot.tier.authId };
    // Honour explicit body.storageGb verbatim — the previous
    // Math.max(extra.storageGb||defaultStorage, defaultStorage) clamp
    // forced every Vast deploy to 100 GB and excluded most A100 PCIe
    // offers (48-94 GB disk). storageGbForProvider preserves a configured 0
    // ("use provider default") instead of the old `|| 50` mask (#156).
    const storageGb = storageGbForProvider(slot.tier.name, extra.storageGb);

    // Progress callback: update deploy state during image pull so the UI
    // shows "pulling_image" instead of being stuck at "creating_pod".
    const onPollProgress = (info: { elapsedS: number; status: string; instanceId: string; ip: string }) => {
      const vastStatus = info.status?.toLowerCase();
      if (vastStatus === 'loading' || vastStatus === 'pulling') {
        setDeployState({
          step: 'pulling_image',
          stepDetail: `${info.instanceId.slice(0, 12)} pulling image (${info.elapsedS}s)`,
          message: `Pulling Docker image on ${slot.tier.label}... (${info.elapsedS}s)`,
          podId: info.instanceId,
        });
      } else if (vastStatus === 'running') {
        setDeployState({
          step: 'waiting_health',
          stepDetail: `${info.instanceId.slice(0, 12)} running, waiting for endpoint`,
          message: `Instance running, resolving endpoint... (${info.elapsedS}s)`,
          podId: info.instanceId,
        });
      }
    };

    const instance = await Promise.race([
      slot.tier.client.createInstance(
        {
          gpuTypes: slot.gpuTypes, dockerImage: slot.tierDockerImage, storageGb,
          region: extra.region, hfToken: extra.hfToken, env: extra.env,
          bareMetal: slot.tier.name === 'tensordock', interruptible: defaultRaceInterruptible(extra.interruptible, raceN),
          ...(slot.tier.name === 'runpod' ? { cloudType: 'SECURE' as const } : {}),
          // Vast-only flags that opt the offer search out of the verified-host
          // filter / the strict-fast-boot reliability tier. The handler already
          // copies them into `extra`; we just need to forward them to the
          // provider client so they reach the search payload.
          ...(extra.allowUnverified ? { allowUnverified: extra.allowUnverified } : {}),
          // Deploy-level race already creates N instances; pin the internal Vast
          // offer-hedge to 1 so each slot spawns exactly one instance (no 2N blow-up).
          raceCount: 1,
          ...(extra.requireDirectPort ? { directPortRequired: 1 } : {}),
          ...(extra.searchMode ? { searchMode: extra.searchMode } : {}),
          ...(extra.strictFastBoot ? { strictFastBoot: extra.strictFastBoot } : {}),
          ...(extra.label ? { label: extra.label } : {}),
          ...(extra.dockerStartCmd ? { dockerStartCmd: extra.dockerStartCmd } : {}),
          ...(extra.containerDiskInGb ? { containerDiskInGb: extra.containerDiskInGb } : {}),
          ...(extra.volumeId ? { volumeId: extra.volumeId } : {}),
          ...(extra.onstart ? { onstart: extra.onstart } : {}),
          ...(extra.templateHashId ? { templateHashId: extra.templateHashId } : {}),
          ...(extra.forceSshTunnel ? { forceSshTunnel: extra.forceSshTunnel } : {}),
          ...(extra.snapgpuPreloadApp ? { snapgpuPreloadApp: extra.snapgpuPreloadApp } : {}),
          ...(extra.snapgpuAutoSnapshot !== undefined ? { autoSnapshot: extra.snapgpuAutoSnapshot } : {}),
          ...(extra.snapgpuBackend ? { snapgpuBackend: extra.snapgpuBackend } : {}),
          onPollProgress,
        },
        credentials,
      ),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${slot.tier.name} createInstance timed out`)), getDeployTimeoutMinForProvider(slot.tier.name) * 60_000)),
    ]);
    log.log(`[race] Slot ${slot.index}: created ${instance.instanceId.slice(0, 8)} (gpu=${instance.gpuType}, tier=${slot.tier.label})`);
    return { slot, instance };
  }));

  const candidates: RaceCandidate[] = [];
  for (const r of createResults) {
    if (r.status === 'fulfilled') {
      const { slot, instance } = r.value;
      const costPerHr = (instance.providerMeta?.dphTotal as number)
        || (instance.providerMeta?.costPerHr as number)
        || (instance.providerMeta?.pricePerHr as number) || 0;
      candidates.push({
        index: slot.index, tier: slot.tier,
        instanceId: instance.instanceId, endpoint: instance.endpoint,
        gpuType: instance.gpuType || '', costPerHr,
        sshHost: instance.sshHost || '', sshPort: instance.sshPort || 0,
        providerMeta: (instance.providerMeta as Record<string, unknown>) ?? {},
      });
    } else {
      log.warn(`[race] Slot create failed: ${r.reason}`);
    }
  }

  if (candidates.length === 0) {
    const msg = `All ${slots.length} race slots failed to create instances`;
    setDeployState({ status: 'error', message: msg });
    deploymentSM.markError(msg);
    return;
  }

  log.log(`[race] ${candidates.length}/${slots.length} instances created — racing to first healthy`);
  // Register all race candidates so the orphan sweep doesn't mistake them for orphans
  for (const c of candidates) activeRaceInstanceIds.add(c.instanceId);
  setDeployState({
    status: 'booting', podId: candidates[0].instanceId,
    endpoint: candidates[0].endpoint, gpuType: candidates[0].gpuType,
    costPerHr: candidates[0].costPerHr, provider: candidates[0].tier.name,
    message: `${candidates.length} instances booting — racing to first healthy...`,
    step: 'waiting_health',
  });
  deploymentSM.startBooting(candidates[0].instanceId);

  // Phase 2: Race health polling — first healthy wins, others are terminated
  // AbortController lets the winner signal all losers instantly (no 5s sleep delay).
  const raceAbort = new AbortController();
  let winner: RaceCandidate | null = null;
  let raceDone = false;
  let lastRaceHealthError = '';

  /** Abortable sleep: resolves after `ms` or immediately when raceAbort fires.
   *  Guards against the signal being already aborted before addEventListener is called. */
  const raceSleep = (ms: number) =>
    new Promise<void>(resolve => {
      if (raceAbort.signal.aborted) { resolve(); return; }
      const t = setTimeout(resolve, ms);
      raceAbort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });

  // Wrap in try/finally to guarantee loser cleanup even if Promise.all throws
  try {
  await Promise.all(candidates.map(async (c, idx) => {
    const credentials = { apiKey: c.tier.apiKey, authId: c.tier.authId };
    let localEndpoint = c.endpoint;
    const timeoutMs = getDeployTimeoutMinForProvider(c.tier.name) * 60_000;
    // Cumulative endpoint-resolution budget for this slot (#149). Vast re-resolves
    // every 5s for the whole window; if the resolver hangs, bound total resolution
    // time to the slot deadline so one stuck slot can't overrun the race.
    const resolutionStartedAt = Date.now();

    while (!raceDone && !deployCancelled) {
      if (Date.now() - deployStartedAt > timeoutMs) {
        log.log(`[race] Slot ${idx} timed out`);
        break;
      }

      // Re-resolve endpoint (needed for Vast.ai and others that assign ports mid-boot)
      if ((!localEndpoint || c.tier.name === 'vast')
        && !resolutionDeadlineExceeded(resolutionStartedAt, Date.now(), timeoutMs)) {
        try {
          const rawResolved = await Promise.race([
            c.tier.client.resolveInstanceEndpoint(c.instanceId, credentials),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${c.tier.name} resolveInstanceEndpoint timed out`)), 30_000)),
          ]);
          // Providers return string | { endpoint } inconsistently (#168).
          const resolved = normalizeResolvedEndpoint(rawResolved as string | { endpoint?: string | null } | null);
          if (resolved && resolved !== localEndpoint) {
            localEndpoint = resolved;
            if (idx === 0) setDeployState({ endpoint: localEndpoint });
          }
        } catch { /* expected during early boot */ }
      }

      // Probe /health
      if (localEndpoint && !raceDone) {
        try {
          // Wire raceAbort.signal so winner-decided losers cancel in-flight
          // /health fetches immediately, AND always pair it with a per-fetch 8s
          // timeout so a hung /health on a loser never blocks until the whole
          // race times out — even on runtimes lacking AbortSignal.any (#155).
          const healthSignal = combineHealthSignal(raceAbort.signal, 8000);
          const res = await fetch(`${localEndpoint}/health`, { signal: healthSignal });
          if (res.ok) {
            const data = await res.json() as { status?: string };
            const HEALTHY = new Set(['healthy', 'ok', 'degraded', 'ready']);
            if (HEALTHY.has(data.status ?? '')) {
              const appHealthError = extractAppHealthError(data);
              if (appHealthError) {
                lastRaceHealthError = `App load failed on ${c.tier.name}: ${appHealthError.message}`;
                log.warn(`[race] Slot ${idx} rejected: ${lastRaceHealthError}`);
                break;
              }
              // Bail out if winner already declared between fetches — avoids
              // wasted contract validation / smoke tests on losing slots.
              if (raceDone) break;
              const apiContract = await validateEndpointApiContract(localEndpoint, extra.expectedApiPaths, extra.expectedCapabilities, extra.requireDockerManifest);
              if (!apiContract.ok) {
                lastRaceHealthError = apiContract.error;
                log.warn(`[race] Slot ${idx} rejected: ${apiContract.error}`);
                break;
              }
              if (raceDone) break;
              if (extra.runSmokeTests !== false && (extra.expectedCapabilities?.includes('glb_generation') || extra.expectedApiPaths?.some(path => /generate(?:-from-text)?|glb/i.test(path)))) {
                const smoke = await runGlbSmokeTest(localEndpoint, extra.expectedApiPaths);
                if (!smoke.ok) {
                  lastRaceHealthError = smoke.error;
                  log.warn(`[race] Slot ${idx} rejected: ${smoke.error}`);
                  break;
                }
              }
              if (raceDone) break;
              if (!raceDone) {
                // Winner — update global state and abort all other slots immediately
                raceDone = true;
                raceAbort.abort(); // wake up sleeping losers right away
                const durationMs = Date.now() - deployStartedAt;
                winner = { ...c, endpoint: localEndpoint };
                setGpuHealthy(true);
                setLastRequestTime(Date.now());
                updateGpuModelWarmth(data as Record<string, unknown>);
                setDeployState({
                  status: 'ready',
                  podId: c.instanceId, endpoint: localEndpoint, gpuType: c.gpuType,
                  costPerHr: c.costPerHr, provider: c.tier.name,
                  sshHost: c.sshHost, sshPort: c.sshPort, providerMeta: c.providerMeta,
                  message: `GPU ready (race ${candidates.length}→1, ${Math.round(durationMs / 1000)}s): ${localEndpoint}`,
                  step: 'ready', stepDetail: '', deployDurationMs: durationMs,
                  alert: '', alertLevel: 'info',
                });
                broadcastProviderStatus('booting', 'cloud', 'GPU deployed — warming up models');
                deploymentSM.markReady(c.instanceId, localEndpoint, c.gpuType, c.costPerHr);
                startGpuMonitoring();
                // startBackgroundWarmthMonitor is internal to gpu-health-monitor
                const { startBackgroundWarmthMonitor } = await import('./gpu-health-monitor');
                startBackgroundWarmthMonitor(localEndpoint);
                startCanaryIfEnabled(extra, dockerImage, c.gpuType);
                const outstandingLosers = countOutstandingLoserDeletes(candidates, c.instanceId);
                log.log(`[race] Winner: deployId=${deployState.deployId || '-'} instanceId=${c.instanceId.slice(0, 12)} provider=${c.tier.name} gpu=${c.gpuType} t=${Math.round(durationMs / 1000)}s (losers pending teardown=${outstandingLosers})`);
                logGpuEvent('deploy_ready', c.tier.name, true, { durationMs, metadata: { endpoint: localEndpoint, gpuType: c.gpuType, raceCount: candidates.length } });
                upsertHostReputation({ provider: c.tier.name, gpuType: c.gpuType, providerMeta: c.providerMeta, success: true, bootTimeS: Math.round(durationMs / 1000), dockerImage });
                if (await cooldownTracker.recordSuccess(c.tier.name)) {
                  logGpuEvent('cooldown_cleared', c.tier.name, true, { durationMs });
                }
                emitGatewayEvent('gpu.deployed', {
                  deployId: deployState.deployId,
                  provider: c.tier.name,
                  gpuType: c.gpuType,
                  endpoint: localEndpoint,
                  costPerHr: c.costPerHr,
                  durationMs,
                  raceCount: candidates.length,
                  // Propagate autoSnapshot opt-out for the capture hook (#172).
                  autoSnapshot: extra.snapgpuAutoSnapshot,
                });
                return; // winner exits cleanly — no cleanup needed
              }
              // Another slot already won while this fetch was in flight.
              // Break to loser-cleanup code below so this instance gets terminated.
              break;
            }
          }
        } catch { /* health probe failed — keep trying */ }
      }

      if (idx === 0 && !raceDone) {
        const elapsed = Math.round((Date.now() - deployStartedAt) / 1000);
        setDeployState({ message: `${candidates.length} instances booting... [${elapsed}s]` });
      }

      await raceSleep(5000); // aborted immediately when winner is found
    }

    // Loser, timed out, or cancelled — terminate the instance and log wasted cost
    if (!winner || winner.instanceId !== c.instanceId) {
      const reason = raceDone ? 'lost' : deployCancelled ? 'cancelled' : 'timed out';
      const aliveMs = Date.now() - deployStartedAt;
      const wastedUsd = c.costPerHr > 0 ? c.costPerHr * aliveMs / 3_600_000 : 0;
      // Retry the delete a few times immediately instead of relying solely on the
      // orphan sweep (#153) — a transient API 5xx otherwise leaves a billable
      // loser running for up to the sweep's 45-min grace window.
      let deleted = false;
      let lastErr: unknown;
      for (const delay of loserDeleteRetryPlan()) {
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        try {
          await Promise.race([
            c.tier.client.deleteInstance(c.instanceId, credentials),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${c.tier.name} deleteInstance timed out`)), 15_000)),
          ]);
          deleted = true;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (deleted) {
        log.log(
          `[race] Loser destroyed: deployId=${deployState.deployId || '-'} instanceId=${c.instanceId.slice(0, 12)} ` +
          `provider=${c.tier.name} gpu=${c.gpuType || '-'} reason=${reason} ` +
          `alive=${Math.round(aliveMs / 1000)}s` +
          (wastedUsd > 0 ? ` wasted≈$${wastedUsd.toFixed(3)}` : ''),
        );
        logGpuEvent('race_loser_destroyed', c.tier.name, true, {
          durationMs: aliveMs,
          metadata: { instanceId: c.instanceId, gpuType: c.gpuType, reason, wastedUsd: +wastedUsd.toFixed(4), raceCount: candidates.length },
        });
      } else {
        // Orphan sweep will eventually terminate this stray instance when race completes
        log.warn(`[race] Failed to terminate slot ${idx} (${reason}) after ${LOSER_DELETE_MAX_ATTEMPTS} attempts: ${lastErr}`);
      }
    }
  }));
  } catch (raceErr) {
    // Promise.all threw — some slots may not have cleaned up their pods.
    // Force-terminate any non-winner instances that are still alive.
    const deployErr = categorizeDeployError(raceErr, {
      deployId: deployState.deployId,
      provider: 'race',
      gpuType: deployState.gpuType,
      imageName: deployState.dockerImage,
    });
    errorSummary.record(deployErr, deployState.deployId);
    const remediation = await tryAutoRemediation(deployErr);
    if (remediation) {
      log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
    }
    log.error({ code: deployErr.code, category: deployErr.category }, `Race deploy exception: ${deployErr.message}`);
    // TS narrows `winner` to `never` in this catch block because all assignments
    // live inside Promise callbacks. Re-cast to match the declared type.
    const winnerCandidate = winner as RaceCandidate | null;
    for (const c of candidates) {
      if (winnerCandidate && winnerCandidate.instanceId === c.instanceId) continue;
      try {
        await Promise.race([
          c.tier.client.deleteInstance(c.instanceId, { apiKey: c.tier.apiKey, authId: c.tier.authId }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
        ]);
        log.log(`[race] Force-cleaned ${c.instanceId.slice(0, 8)} on ${c.tier.name}`);
      } catch { /* best effort */ }
    }
  } finally {
    // Always clear race tracking — sweep may now treat any remaining instances as orphans
    for (const c of candidates) activeRaceInstanceIds.delete(c.instanceId);
  }

  // Phase 3: Final state / race summary
  if (winner) {
    const w = winner as RaceCandidate;
    // Wall-clock since deploy started — independent of costPerHr (some price
    // probes return 0 for free/credit-funded offers, but the actual boot time
    // still matters for observability). Previous gating on costPerHr made the
    // summary log report 0ms boot for legitimate free-tier deploys.
    const winnerBootMs = Date.now() - deployStartedAt;
    const loserCount = candidates.length - 1;
    if (loserCount > 0) {
      // w is already declared above — no need to redeclare
      const totalWastedUsd = candidates
        .filter(c => c.instanceId !== w.instanceId)
        .reduce((sum, c) => sum + (c.costPerHr > 0 ? c.costPerHr * (Date.now() - deployStartedAt) / 3_600_000 : 0), 0);
      log.log(
        `[race] Summary: ${candidates.length} instances → winner in ${Math.round(winnerBootMs / 1000)}s, ` +
        `${loserCount} loser(s) terminated, total wasted≈$${totalWastedUsd.toFixed(3)}`,
      );
    }
  } else {
    const msg = deployCancelled ? 'Deploy cancelled' : (lastRaceHealthError || 'All race candidates failed to become healthy');
    setDeployState({ status: 'error', message: msg });
    deploymentSM.markError(msg);
    emitGatewayEvent('gpu.failed', {
      deployId: deployState.deployId,
      error: msg,
      durationMs: Date.now() - deployStartedAt,
      raceCount: candidates.length,
    });
  }
}
