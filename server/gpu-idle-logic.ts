// ── GPU Idle Logic — Pure decision functions for idle auto-stop ──────────────
// Extracted from gpu-monitor-loop.ts for testability.
// These functions are pure: no side effects, no imports of mutable state.
// The monitor loop calls these and applies the results.

/** Result of an idle check — what action (if any) should the monitor take. */
export type IdleCheckResult =
  | { action: 'none' }
  | { action: 'warning'; remainingSec: number; idleMs: number }
  | { action: 'stop'; idleMs: number; idleMin: number };

/**
 * Determine what idle action to take based on timestamps and timeout.
 *
 * @param lastModelRequestTime - Last time an AI model request was received (ms epoch)
 * @param lastRequestTime - Last time any request was received (ms epoch)
 * @param now - Current time (ms epoch) — injectable for testing
 * @param idleTimeoutMs - Idle timeout threshold (ms)
 * @param alreadyWarned - Whether we already emitted an idle warning
 */
export function checkIdleAction(
  lastModelRequestTime: number,
  lastRequestTime: number,
  now: number,
  idleTimeoutMs: number,
  alreadyWarned: boolean,
): IdleCheckResult {
  const idleBase = Math.max(lastModelRequestTime, lastRequestTime) || 0;
  if (idleBase <= 0) return { action: 'none' };

  const idleMs = now - idleBase;

  if (idleMs >= idleTimeoutMs) {
    return { action: 'stop', idleMs, idleMin: Math.round(idleMs / 60_000) };
  }

  // Warn at 75% of idle timeout
  if (idleMs >= idleTimeoutMs * 0.75 && !alreadyWarned) {
    const remainingSec = Math.round((idleTimeoutMs - idleMs) / 1000);
    return { action: 'warning', remainingSec, idleMs };
  }

  return { action: 'none' };
}

/**
 * Should the idle timer be reset based on GPU health probe data?
 *
 * External workloads (e.g. HybrIK calling the GPU directly, not via gateway)
 * don't trigger touchModelRequest(). We detect them via GPU metrics:
 * - training=true → active fine-tuning
 * - model_loaded=false → still initializing (downloading model)
 * - gpuUtil > 0 → GPU actively processing
 * - last_request_at → timestamp of last request handled by the GPU server
 *   (survives the 30s probe gap: even if GPU util is 0 between probes,
 *   the timestamp proves a request was handled recently)
 * - active_requests > 0 → GPU is currently processing requests
 *
 * @param healthData - Parsed /health response
 * @param deployedGpuUtil - Current GPU utilization from deployState (-1 if unknown)
 * @param idleTimeoutMs - Idle timeout in ms (used to determine if last_request_at is "recent")
 * @param now - Current time in ms (injectable for testing)
 */
export function shouldResetIdleFromHealth(
  healthData: Record<string, unknown> | null,
  deployedGpuUtil: number,
  idleTimeoutMs: number = 15 * 60_000,
  now: number = Date.now(),
): boolean {
  if (!healthData) return false;

  // Active training detected
  if (healthData.training === true) return true;

  // Model still loading (e.g. downloading from HuggingFace)
  if (healthData.model_loaded === false) return true;

  // GPU utilization > 0% from health probe data
  // This catches external workloads calling the pod directly
  if (deployedGpuUtil > 0) return true;

  // last_request_at: timestamp (epoch seconds or ms) of last request processed by GPU.
  // This is the primary fix for the "probe gap" bug — even if GPU utilization
  // drops to 0% between health probes, the timestamp proves work was done recently.
  // Accepted field names: last_request_at, lastRequestAt, last_activity_at
  const lastReqRaw = healthData.last_request_at ?? healthData.lastRequestAt ?? healthData.last_activity_at;
  if (typeof lastReqRaw === 'number' && lastReqRaw > 0) {
    // Normalize: if value < 1e12, it's epoch seconds → convert to ms
    const lastReqMs = lastReqRaw < 1e12 ? lastReqRaw * 1000 : lastReqRaw;
    const ageMs = now - lastReqMs;
    // Consider "recent" if within the idle timeout window
    if (ageMs >= 0 && ageMs < idleTimeoutMs) return true;
  }

  // active_requests / active_streams: count of in-flight requests/sessions on the GPU.
  // active_streams is used by streaming workloads (e.g. MuseTalk WS sessions).
  const activeReqs = healthData.active_requests ?? healthData.activeRequests
                  ?? healthData.active_streams ?? healthData.activeStreams;
  if (typeof activeReqs === 'number' && activeReqs > 0) return true;

  return false;
}

// ── Adaptive Idle Timeout — scales with boot cost ──────────────────────────

/**
 * Two distinct phases need different timeout logic:
 *
 * Phase 1: BOOT GRACE — machine is booting, loading models.
 *   Don't kill during init. Timeout = max(bootEstimate * 1.5, MIN_BOOT_GRACE_MS).
 *   Driven by model size and historical boot times.
 *
 * Phase 2: POST-READY IDLE — machine is ready but unused.
 *   Idle timeout proportional to boot cost: killing a machine that takes
 *   20 min to reboot after only 15 min idle is wasteful.
 *   Formula: max(MIN_IDLE_MS, bootDurationMs * BOOT_COST_MULTIPLIER)
 */

/** Minimum idle timeout regardless of model size. */
const MIN_IDLE_TIMEOUT_MS = 5 * 60_000; // 5 min floor — aligns with A3 (docs/compete-with-modal.md)
/** Maximum idle timeout cap. */
const MAX_IDLE_TIMEOUT_MS = 60 * 60_000; // 60 min ceiling
/** Multiplier: idle timeout = boot time * this factor. */
const BOOT_COST_MULTIPLIER = 2.0;
/** Minimum boot grace period (don't kill during init). */
const MIN_BOOT_GRACE_MS = 20 * 60_000; // 20 min

/**
 * Docker image size estimates for boot time prediction when no history exists.
 * Maps keywords in image names to expected boot time ranges (seconds).
 */
const IMAGE_BOOT_ESTIMATES: { pattern: RegExp; estimateS: number }[] = [
  // Large models (70B+): ~600-900s boot
  { pattern: /70[bB]|200[bB]|llama.*70|mixtral/i, estimateS: 600 },
  // Medium models (13-32B): ~300-500s
  { pattern: /32[bB]|13[bB]|gemma.*27|qwen.*32/i, estimateS: 400 },
  // Small models (3-7B): ~120-250s
  { pattern: /7[bB]|4[bB]|3[bB]|gemma.*4|phi/i, estimateS: 180 },
  // HybrIK / vision / specialized: typically medium boot
  { pattern: /hybrik|wilor|wan-i2v|ultravox/i, estimateS: 300 },
  // Default: assume medium
  { pattern: /.*/, estimateS: 250 },
];

/**
 * Estimate boot time from docker image name when no historical data exists.
 *
 * Resolution order:
 *  1. App registry (`server/app-registry.ts`) — operator-declared per image.
 *     This is the canonical source after the registry refactor.
 *  2. Regex heuristics in IMAGE_BOOT_ESTIMATES — covers generic model-size
 *     patterns (70B / 32B / 7B / etc.) when the image isn't registered.
 *  3. 250s fallback.
 */
export function estimateBootTimeFromImage(imageName: string): number {
  // 1) Registry (dynamic, per-operator).
  try {
    // Lazy import so this pure-logic module stays importable from tests
    // without pulling the file-backed registry + prisma state.
    const { bootEstimateForImage, getImage } = require('./app-registry') as typeof import('./app-registry');
    const base = imageName.includes(':') ? imageName.split(':')[0]! : imageName;
    if (getImage(base) || getImage(base.split('/').pop() || '')) {
      return bootEstimateForImage(base);
    }
  } catch {
    // registry import failure shouldn't break idle logic — fall through
  }

  // 2) Regex heuristics.
  for (const entry of IMAGE_BOOT_ESTIMATES) {
    if (entry.pattern.test(imageName)) return entry.estimateS;
  }
  return 250; // fallback
}

export interface IdleTimeoutContext {
  /** Last known boot duration in ms (from deployState.deployDurationMs or resume time). */
  lastBootDurationMs: number;
  /** Historical average boot time in seconds (from host reputation avgBootTimeS). 0 = unknown. */
  avgBootTimeS: number;
  /** Docker image name (for size-based estimation when no history). */
  dockerImage: string;
  /** Whether the pod is still in boot/init phase (not yet ready). */
  isBooting: boolean;
}

/**
 * Compute the adaptive idle timeout based on boot cost and history.
 *
 * Logic:
 * - Use the best available boot time estimate:
 *   1. Last actual boot duration (most accurate)
 *   2. Historical average from host reputation (EMA)
 *   3. Image-based estimate (heuristic fallback)
 * - Idle timeout = max(MIN_IDLE_TIMEOUT, bootTime * BOOT_COST_MULTIPLIER)
 * - Capped at MAX_IDLE_TIMEOUT
 *
 * During boot phase: returns boot grace period (longer, to protect initialization).
 *
 * @returns Idle timeout in milliseconds.
 */
export function computeAdaptiveIdleTimeout(ctx: IdleTimeoutContext): number {
  // Best available boot time estimate (in ms)
  let bootEstimateMs: number;

  if (ctx.lastBootDurationMs > 0) {
    // Most accurate: actual boot time of this specific deployment
    bootEstimateMs = ctx.lastBootDurationMs;
  } else if (ctx.avgBootTimeS > 0) {
    // Second best: historical average from host reputation
    bootEstimateMs = ctx.avgBootTimeS * 1000;
  } else {
    // Fallback: estimate from docker image name
    bootEstimateMs = estimateBootTimeFromImage(ctx.dockerImage) * 1000;
  }

  if (ctx.isBooting) {
    // Boot grace: don't kill during initialization.
    // Use 1.5x estimated boot time or MIN_BOOT_GRACE, whichever is larger.
    return Math.max(MIN_BOOT_GRACE_MS, bootEstimateMs * 1.5);
  }

  // Post-ready idle timeout: proportional to boot cost.
  // The more expensive the reboot, the longer we wait before killing.
  const adaptiveTimeout = bootEstimateMs * BOOT_COST_MULTIPLIER;
  return Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(MIN_IDLE_TIMEOUT_MS, adaptiveTimeout));
}

/**
 * Compute the adaptive monitor delay based on idle duration.
 * When idle > 1min, slow polling from 30s to 60s to reduce overhead.
 */
export function adaptiveMonitorDelay(
  idleMs: number,
  currentDelayMs: number,
  baseDelayMs: number,
): number {
  if (idleMs > 60_000 && currentDelayMs < 60_000) {
    return 60_000;
  }
  return currentDelayMs;
}

/**
 * Compute idle duration from timestamps.
 * Returns 0 if no baseline timestamp exists.
 */
export function computeIdleMs(
  lastModelRequestTime: number,
  lastRequestTime: number,
  now: number,
): number {
  const idleBase = Math.max(lastModelRequestTime, lastRequestTime) || 0;
  if (idleBase <= 0) return 0;
  return now - idleBase;
}
