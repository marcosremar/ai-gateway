// ── GPU Monitor Loop ─────────────────────────────────────────────────────────
// Periodic health probe: pod status, /health, GPU metrics, budget tracking,
// P95 demotion, idle detection, auto-restart, crash recovery.

import { RunpodClient } from '../src/gpu-providers/runpod-client';
import { probeGpuHealth } from '../src/autoscaler/health';
import { createLogger } from '../src/logger';
import {
  getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs,
  getP95DemotionMultiplier, getP95IdleWindowSec,
  getAutoRecoveryEnabled, getAutoRecoveryMaxRetries,
} from '../src/gpu-providers/deploy-settings';
import { BILLING_URLS } from '../src/providers/errors';
import {
  deployState, setDeployState, deployApiKey, deployVastApiKey,
  deployTensordockApiKey, deployTensordockAuthId,
  activeProvider,
  setGpuHealthy, setLastRequestTime,
  monitorInterval, setMonitorInterval,
  lastRequestTime, lastModelRequestTime, setLastModelRequestTime,
  DAILY_BUDGET_USD, dailyGpuSpendUsd, setDailyGpuSpendUsd, dailySpendResetDate, setDailySpendResetDate,
  updateGpuModelWarmth, isStageWarm,
  isGpuReadyForProduction, getPerStageP95, setGpuReadyForProduction, setServiceReadiness,
  perStageLatencyRing,
} from './state';
import {
  translationDefaults, runpod, vast, tensordock,
  markGpuHealthy, markGpuUnhealthy, _startReadinessCheck,
} from './providers';
import { isReadinessCheckInProgress } from './gpu-readiness';
import { recordHostCrash } from './metrics';
import { broadcastProviderStatus, broadcastWs } from './ws-state';
import { emitGatewayEvent } from './event-bus';
import { GPU_MONITOR_INTERVAL_MS, parseAndStoreGpuMetrics } from './gpu-health-metrics';
import { checkIdleAction, shouldResetIdleFromHealth, adaptiveMonitorDelay, computeAdaptiveIdleTimeout, resolveEffectiveIdleTimeout } from './gpu-idle-logic';
import { stopWarmthMonitor } from './gpu-warmth-monitor';

const log = createLogger('gpu-deploy');

export { GPU_MONITOR_INTERVAL_MS } from './gpu-health-metrics';

/**
 * Poll a pod's GPU utilization over SSH (pull model). Returns the max GPU
 * utilization % across GPUs, or -1 if unreachable/parse-fail. Used to keep a
 * training/job pod (GPU busy, no HTTP requests) from being reaped by the
 * request-based idle logic — works even when the pod can't reach the gateway
 * and when the app /health exposes no GPU metrics.
 */
async function pollGpuUtilViaSsh(host: string, port: number): Promise<number> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require('child_process');
    const args = [
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR', '-p', String(port),
      `root@${host}`, 'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits',
    ];
    let out = ''; let done = false;
    const p = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (v: number) => { if (done) return; done = true; try { p.kill('SIGKILL'); } catch { /* noop */ } resolve(v); };
    const timer = setTimeout(() => finish(-1), 12_000);
    p.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
    p.on('close', () => {
      clearTimeout(timer);
      const utils = out.split('\n').map((s) => parseFloat(s.trim())).filter((n) => !Number.isNaN(n));
      finish(utils.length ? Math.max(...utils) : -1);
    });
    p.on('error', () => { clearTimeout(timer); finish(-1); });
  });
}

/**
 * #202 — resolve the startup idle timeout from the documented env vars.
 *
 * `IDLE_TIMEOUT_MS` was a hardcoded `5*60_000` that only ever changed via the
 * runtime `setIdleTimeoutMs()` API, so the documented `IDLE_TIMEOUT_MIN` /
 * `IDLE_TIMEOUT_MS` knobs were silently ignored at boot. This parses them
 * (minutes preferred, then raw ms) and returns the default when neither is set
 * or the value is non-positive/garbage. Pure + exported for unit testing.
 */
export function resolveIdleTimeoutFromEnv(
  env: { IDLE_TIMEOUT_MIN?: string; IDLE_TIMEOUT_MS?: string } = process.env,
  defaultMs = 5 * 60_000,
): number {
  const min = env.IDLE_TIMEOUT_MIN != null ? Number(env.IDLE_TIMEOUT_MIN) : NaN;
  if (Number.isFinite(min) && min > 0) return Math.round(min * 60_000);
  const ms = env.IDLE_TIMEOUT_MS != null ? Number(env.IDLE_TIMEOUT_MS) : NaN;
  if (Number.isFinite(ms) && ms > 0) return Math.round(ms);
  return defaultMs;
}

// Cold-start plan A3 — 15 → 5 min idle timeout. Resume of a stopped pod is
// ~19s on Vast.ai vs ~288s for a fresh deploy, so pausing aggressively after
// 5 min of no activity costs a few extra resume events but saves ~$32k/yr in
// "just-ready-then-left-running" waste. The pod keeps its disk while stopped
// (no hourly billing), then auto-destroys after IDLE_DESTROY_MS (2h) if not
// resumed — preserving the option for the user to come back without waiting
// for a cold boot.
// #202: seed from the documented env vars at module load so the operator knob
// actually takes effect at startup (still overridable via setIdleTimeoutMs).
export let IDLE_TIMEOUT_MS = resolveIdleTimeoutFromEnv();    // auto-STOP (pause) after idle (configurable via API)
export function setIdleTimeoutMs(ms: number) { IDLE_TIMEOUT_MS = ms; }
export let IDLE_DESTROY_MS = 2 * 60 * 60_000; // auto-DESTROY 2 hours after stop (configurable)
export function setIdleDestroyMs(ms: number) { IDLE_DESTROY_MS = ms; }

// ── Pure budget/cost helpers (exported for unit testing) ────────────────────

/**
 * #299 — single source of truth for end-of-day spend forecast.
 *
 * Previously the loop computed two different forecasts in the same tick: one
 * using whole `getUTCHours()` and one using hours + fractional minutes; they
 * could disagree and fire inconsistent alerts. This computes the remaining
 * UTC hours today *with* minute precision and projects spend once.
 *
 * @param currentSpendUsd Spend accumulated so far today.
 * @param costPerHr       Current GPU hourly rate.
 * @param now             Injectable clock (Date) for tests.
 */
export function computeBudgetForecast(
  currentSpendUsd: number,
  costPerHr: number,
  now: Date = new Date(),
): number {
  const hoursRemaining = Math.max(0, 24 - now.getUTCHours() - now.getUTCMinutes() / 60);
  return currentSpendUsd + costPerHr * hoursRemaining;
}

/**
 * #210 — derive the session-cost idle-alert threshold from the *effective*
 * idle timeout instead of a fixed 5-min magic number.
 *
 * If the stop timeout is lowered below 5 min, a fixed 5-min cost-alert
 * threshold would never fire before the pod stops. We alert at 80% of the
 * effective idle timeout (so the user sees the running meter just before
 * auto-stop), clamped to a sane [30s, 5min] band and never above the timeout.
 * Non-finite (disabled) timeouts fall back to the 5-min default.
 */
export function sessionCostAlertThresholdMs(
  effectiveIdleTimeoutMs: number,
  defaultMs = 5 * 60_000,
): number {
  if (!Number.isFinite(effectiveIdleTimeoutMs) || effectiveIdleTimeoutMs <= 0) return defaultMs;
  const at80 = effectiveIdleTimeoutMs * 0.8;
  const floor = Math.min(30_000, effectiveIdleTimeoutMs);
  const ceil = Math.min(defaultMs, effectiveIdleTimeoutMs);
  return Math.max(floor, Math.min(at80, ceil));
}

/**
 * #248 — terminal give-up decision for an unreachable pod.
 *
 * The health probe backs off to a 120s max interval but then keeps probing a
 * dead pod forever (only logs once). This returns true once the probe has sat
 * at the max backoff interval for at least `giveUpAfterMs`, so the caller can
 * terminate/alert and stop paying for an unreachable pod.
 */
export function shouldGiveUpProbing(
  currentDelayMs: number,
  maxDelayMs: number,
  msAtMaxBackoff: number,
  giveUpAfterMs: number = 10 * 60_000,
): boolean {
  return currentDelayMs >= maxDelayMs && msAtMaxBackoff >= giveUpAfterMs;
}

/**
 * #208 — escalating idle-warning level.
 *
 * The old code latched a single warning at 75% of the timeout, so a user away
 * past the timeout got exactly one heads-up. This maps the idle fraction
 * (idleMs / timeoutMs) to a discrete warn level so the caller can re-warn as
 * stop becomes imminent: `none` < 75%, `warn` at ≥75%, `imminent` at ≥90%.
 * Returning distinct levels lets the caller fire one alert per level (instead
 * of one ever).
 */
export function computeIdleWarnLevel(
  idleMs: number,
  idleTimeoutMs: number,
  warnAt = 0.75,
  imminentAt = 0.9,
): 'none' | 'warn' | 'imminent' {
  if (!(idleTimeoutMs > 0) || idleMs <= 0) return 'none';
  const frac = idleMs / idleTimeoutMs;
  if (frac >= imminentAt) return 'imminent';
  if (frac >= warnAt) return 'warn';
  return 'none';
}

/**
 * #242 — crash-loop counter decay after a sustained healthy window.
 *
 * `monitorCrashRecoveryAttempts` only reset on a fresh deploy, so a pod that
 * recovered and ran healthy for hours still had 0 budget for a later genuine
 * crash. This decays the counter by one once the pod has been continuously
 * healthy for `healthyWindowMs`, restoring recovery budget over time without
 * the blanket per-request reset that would reopen the infinite crash→reset
 * loop (#243). Returns the new (never-negative) counter.
 */
export function decayCrashCounter(
  attempts: number,
  healthyForMs: number,
  healthyWindowMs: number = 60 * 60_000,
): number {
  if (attempts <= 0) return 0;
  if (healthyForMs >= healthyWindowMs) return attempts - 1;
  return attempts;
}

/**
 * #255 — map a latency trend slope to an early action.
 *
 * The 20%-slope trend detector only logged/broadcast. This turns a measured
 * slope (fractional change, e.g. 0.25 = +25%) into a discrete recommendation
 * so the caller can act *before* P95 demotion: `warm` (pre-warm standby) at
 * ≥ `warmSlope`, `rebenchmark` at ≥ `rebenchSlope`, else `none`. Negative /
 * flat slopes never act.
 */
export function latencyTrendAction(
  slope: number,
  warmSlope = 0.2,
  rebenchSlope = 0.5,
): 'none' | 'warm' | 'rebenchmark' {
  if (!Number.isFinite(slope) || slope <= 0) return 'none';
  if (slope >= rebenchSlope) return 'rebenchmark';
  if (slope >= warmSlope) return 'warm';
  return 'none';
}

/**
 * #246 — P95 demotion that also evaluates under *active* load.
 *
 * The demotion block previously fired only while idle (`idleSec > p95 window`),
 * so a GPU degrading under traffic was never demoted/re-benchmarked until the
 * traffic stopped. This returns whether a stage's P95 breaches the target,
 * using a *higher* multiplier when the pod is actively serving (so we don't
 * demote a healthy-but-busy pod on transient load) and the normal multiplier
 * when idle. Returns false when no valid P95 or target exists.
 *
 * @param activeMultiplierBoost extra factor applied on top of the idle
 *   multiplier while active (default 1.5×, so a 2× idle threshold becomes 3×).
 */
export function shouldDemoteOnP95(
  p95Ms: number | null,
  targetMs: number,
  idleMultiplier: number,
  isActive: boolean,
  activeMultiplierBoost = 1.5,
): boolean {
  if (p95Ms === null || !Number.isFinite(p95Ms) || p95Ms <= 0) return false;
  if (!(targetMs > 0) || !(idleMultiplier > 0)) return false;
  const mult = isActive ? idleMultiplier * Math.max(1, activeMultiplierBoost) : idleMultiplier;
  return p95Ms > targetMs * mult;
}

/**
 * #298 — graded budget action: drain-then-stop instead of a hard kill at 100%.
 *
 * At 100% budget the loop immediately terminated the pod, killing in-flight
 * sessions abruptly and forcing a future cold boot. This maps the spend ratio
 * to a graded action so the caller can: `warn` at the soft limit, `drain-stop`
 * (pause/resumable after active requests finish) at 100%, and only `terminate`
 * once spend blows well past budget (`hardKillRatio`, default 1.25×). Pausing
 * (not terminating) at exactly 100% keeps the disk so the user can resume.
 */
export function budgetActionForSpend(
  spendUsd: number,
  budgetUsd: number,
  opts: { softLimit?: number; hardKillRatio?: number } = {},
): 'none' | 'warn' | 'drain-stop' | 'terminate' {
  if (!(budgetUsd > 0)) return 'none';
  const ratio = spendUsd / budgetUsd;
  const { softLimit = 0.8, hardKillRatio = 1.25 } = opts;
  if (ratio >= hardKillRatio) return 'terminate';
  if (ratio >= 1) return 'drain-stop';
  if (ratio >= softLimit) return 'warn';
  return 'none';
}

// ── GPU Monitoring ───────────────────────────────────────────────────────────

let monitorRunning = false;
let monitorConsecFails = 0;
let monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
let monitorBackoffMaxAlerted = false;
// Track whether the current deploy already had a crash recorded — prevents
// double-recording when monitorConsecFails crosses thresholds repeatedly.
let crashRecordedForCurrentDeploy = false;
// One-shot guards for the failure-threshold actions. Using `>=` + a flag (the
// same pattern as crashRecordedForCurrentDeploy) instead of exact `===` ensures
// each recovery step fires reliably even if monitorConsecFails skips the exact
// threshold value (e.g. a burst of increments), and still fires only once per
// crash. All reset in startGpuMonitoring() on a fresh deploy.
let sshRecoveryAttemptedForCurrentDeploy = false;
let crashRedeployTriggeredForCurrentDeploy = false;

// P95 demotion: require N consecutive violations before demoting (avoids transient spike false positives)
const P95_DEMOTION_CONSECUTIVE_VIOLATIONS = 3;
let p95ViolationCount: Record<string, number> = { stt: 0, llm: 0, tts: 0 };

// Budget enforcement: soft warn once per day, hard terminate at 100%
let budgetSoftWarned = false;
let budgetWarned50 = false;
let lastBudgetCalcTime = 0;

// Crash auto-recovery: redeploy on different provider after crash (max 2 attempts)
let monitorCrashRecoveryAttempts = 0;
const MAX_MONITOR_CRASH_RECOVERY = 2;
// #242: timestamp the current continuous-healthy streak so we can decay the
// crash-recovery counter after a long healthy window (restoring recovery budget
// for a genuinely-later crash) — without the blanket per-request reset that
// would reopen the infinite crash→reset loop (#243). Reset to 0 on any failure.
let monitorHealthySinceMs = 0;
const CRASH_DECAY_HEALTHY_WINDOW_MS = 60 * 60_000; // 1h continuously healthy → -1

// Idle warning: warn once before auto-terminate, reset on activity
let idleWarned = false;

// Session-cost idle alert (#12 — real-time cost alerting)
// Fires periodically when the pod is sitting idle but still billing,
// telling the user exactly how much they've spent and suggesting a stop.
const SESSION_COST_ALERT_IDLE_MIN_MS = 5 * 60_000;   // start nagging after 5 min idle
const SESSION_COST_ALERT_INTERVAL_MS = 5 * 60_000;   // repeat every 5 min while idle
let lastSessionCostAlertAt = 0;
// NOTE: monitorCrashRecoveryAttempts is intentionally NOT reset by resetIdleState —
// resetting it on every model request would bypass the crash-loop protection (max 2
// auto-recovery attempts), allowing infinite crash → request → reset → crash cycles.
// It is only reset when startGpuMonitoring() is called (fresh deploy or recovery).
export function resetIdleState() { idleWarned = false; lastSessionCostAlertAt = 0; monitorDelayMs = GPU_MONITOR_INTERVAL_MS; }

export function startGpuMonitoring() {
  stopGpuMonitoring();
  monitorConsecFails = 0;
  monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
  monitorBackoffMaxAlerted = false;
  monitorCrashRecoveryAttempts = 0;
  monitorHealthySinceMs = 0;
  crashRecordedForCurrentDeploy = false;
  sshRecoveryAttemptedForCurrentDeploy = false;
  crashRedeployTriggeredForCurrentDeploy = false;
  // Reset idle clock so the timer starts fresh from GPU-ready, not from last session's request.
  // Without this, a pod that boots 12 min after the previous session's last request immediately
  // hits the 10-min idle timeout and self-terminates.
  setLastModelRequestTime(Date.now());
  scheduleNextMonitorProbe();
}

export function scheduleNextMonitorProbe() {
  setMonitorInterval(setTimeout(async () => {
    if (monitorRunning) { scheduleNextMonitorProbe(); return; }
    // If status is 'error' but a pod exists, clean up the orphaned pod
    if (deployState.status === 'error' && deployState.podId) {
      log.warn(`[gpu] Monitor: deploy in error state but pod ${deployState.podId} exists on ${deployState.provider} — cleaning up orphaned pod`);
      try {
        const { autoTerminateGpu } = await import('./gpu-terminate');
        await autoTerminateGpu('orphan_cleanup');
      } catch (e) { log.warn('[gpu] Orphan cleanup failed:', e); }
      return; // Don't reschedule — pod is gone
    }
    if (deployState.status !== 'ready' || !deployState.endpoint) { scheduleNextMonitorProbe(); return; }
    monitorRunning = true;
    try {
      // Pod status check — detect EXITED pods proactively (RunPod spending limits, crashes, etc.)
      if (activeProvider === 'runpod' && deployApiKey && deployState.podId) {
        try {
          const detail = await (runpod as RunpodClient).getInstanceDetail(deployState.podId, { apiKey: deployApiKey });
          if (detail?.desiredStatus === 'EXITED') {
            log.warn(`[gpu] RunPod pod ${deployState.podId} EXITED — attempting auto-restart...`);
            try {
              await runpod.startInstance(deployState.podId, { apiKey: deployApiKey });
              log.log(`[gpu] Pod ${deployState.podId} auto-restart initiated`);
              setDeployState({ alert: `Pod exited unexpectedly — auto-restart initiated` });
              monitorDelayMs = 30_000; // Give it time to boot
            } catch (restartErr) {
              log.error(`[gpu] Auto-restart failed: ${restartErr instanceof Error ? restartErr.message : restartErr}`);
              setDeployState({ status: 'error', message: `Pod exited and auto-restart failed: ${restartErr instanceof Error ? restartErr.message : restartErr}` });
            }
            monitorRunning = false;
            scheduleNextMonitorProbe();
            return;
          }
        } catch { /* best-effort pod status check */ }
      }

      // Health probe — returnData: true to also extract warmth info
      const probeResult = await probeGpuHealth(deployState.endpoint, true);
      const healthy = probeResult.ok;
      if (healthy && probeResult.data) {
        updateGpuModelWarmth(probeResult.data);
        // Populate GPU hardware info from /health if not already known (e.g. Modal)
        if (!deployState.gpuType && probeResult.data.gpu_type) {
          setDeployState({ gpuType: String(probeResult.data.gpu_type) });
        }
        if (probeResult.data.gpu_vram_gb && !deployState.providerMeta?.gpuVramGb) {
          setDeployState({ providerMeta: { ...deployState.providerMeta, gpuVramGb: Number(probeResult.data.gpu_vram_gb) } });
        }

        // ── GPU hardware metrics parsing (temperature, utilization, memory) ──
        parseAndStoreGpuMetrics(probeResult.data);

        // Activate full GPU pipeline when STT + LLM become warm (staged boot)
        if (isStageWarm('stt') && isStageWarm('llm') && !translationDefaults.gpuEndpoint && !isReadinessCheckInProgress() && deployState.endpoint) {
          log.log('[gpu] STT + LLM warm — running readiness benchmark via monitor');
          stopWarmthMonitor();
          const ep = deployState.endpoint;
          _startReadinessCheck(ep);
        }
      }
      if (healthy) {
        markGpuHealthy();
        monitorConsecFails = 0;
        crashRecordedForCurrentDeploy = false;
        monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
        monitorBackoffMaxAlerted = false;
        // #242: start/continue the healthy streak and decay the crash counter
        // once the pod has been continuously healthy long enough.
        const nowMs = Date.now();
        if (monitorHealthySinceMs === 0) monitorHealthySinceMs = nowMs;
        const decayed = decayCrashCounter(
          monitorCrashRecoveryAttempts,
          nowMs - monitorHealthySinceMs,
          CRASH_DECAY_HEALTHY_WINDOW_MS,
        );
        if (decayed < monitorCrashRecoveryAttempts) {
          monitorCrashRecoveryAttempts = decayed;
          monitorHealthySinceMs = nowMs; // reset window so each decay needs a fresh healthy hour
          log.log(`[gpu] Crash-recovery budget restored after sustained health — attempts now ${monitorCrashRecoveryAttempts}/${MAX_MONITOR_CRASH_RECOVERY}`);
        }
        // If health data indicates active training/work, treat as "not idle"
        // (prevents idle timeout from killing fine-tuning or long-running jobs)
        // Compute effective timeout for health-based idle check (same context as idle check below)
        const adaptiveHealthTimeout = computeAdaptiveIdleTimeout({
          lastBootDurationMs: deployState.deployDurationMs || 0,
          avgBootTimeS: (deployState.providerMeta as Record<string, unknown>)?.avgBootTimeS as number || 0,
          dockerImage: deployState.dockerImage || '',
          isBooting: false,
        });
        const healthCheckTimeout = resolveEffectiveIdleTimeout(adaptiveHealthTimeout, IDLE_TIMEOUT_MS);
        if (shouldResetIdleFromHealth(probeResult.data as Record<string, unknown>, deployState.gpuUtil, healthCheckTimeout)) {
          setLastModelRequestTime(Date.now());
        }
      } else {
        monitorConsecFails++;
        monitorHealthySinceMs = 0; // #242: a failed probe breaks the healthy streak
        // Only mark unhealthy after 2+ consecutive failures to tolerate
        // transient timeouts when GPU is under heavy load (e.g. benchmark)
        if (monitorConsecFails >= 2) {
          markGpuUnhealthy('health probe failed');
        } else {
          log.log(`[gpu] Health probe failed (1st), will retry before marking unhealthy`);
        }
        if (monitorConsecFails >= 3) {
          monitorDelayMs = Math.min(monitorDelayMs * 2, 120_000);
          log.log(`[gpu] Health probe failed ${monitorConsecFails}x, backing off to ${monitorDelayMs / 1000}s`);
          if (monitorDelayMs >= 120_000 && !monitorBackoffMaxAlerted) {
            monitorBackoffMaxAlerted = true;
            log.warn('[gpu] WARNING: GPU health probe has backed off to maximum interval (120s). Pod may be unreachable.');
          }
          // Record crash in host reputation at threshold (>=5 consecutive
          // failures = likely crash). Equality `=== 5` would silently miss
          // the threshold if `monitorConsecFails` skipped 5 (e.g. burst
          // increments) — track via flag to fire exactly once per crash.
          if (monitorConsecFails >= 5 && !crashRecordedForCurrentDeploy && deployState.provider) {
            crashRecordedForCurrentDeploy = true;
            recordHostCrash(deployState.provider, deployState.gpuType, deployState.providerMeta);
          }
          // App-level recovery first: at 3 consecutive failures, try to
          // restart the in-container app via SSH (cheap, ~5s) before the
          // expensive pod-level restart at 5. Common on Vast where the
          // container's idle_watchdog kills /app/server.py while the host
          // and SSH proxy stay up — SSH-exec `bash /app/start.sh` is
          // enough to bring the FastAPI server back without rebooting the
          // pod and re-paying the image-pull tax.
          if (
            monitorConsecFails >= 3 &&
            !sshRecoveryAttemptedForCurrentDeploy &&
            activeProvider === 'vast' &&
            deployState.sshHost &&
            deployState.sshPort
          ) {
            sshRecoveryAttemptedForCurrentDeploy = true;
            try {
              log.log(`[gpu] App-level recovery: SSH-restart /app/start.sh on ${deployState.sshHost}:${deployState.sshPort}...`);
              const { spawn } = await import('child_process');
              const cmd = `pgrep -f "python.*server" >/dev/null || (cd /app && nohup bash /app/start.sh > /tmp/recover.log 2>&1 &) ; sleep 2; pgrep -f "python.*server" >/dev/null && echo OK || echo FAIL`;
              const out = await new Promise<string>((resolve) => {
                const p = spawn('ssh', [
                  '-o', 'StrictHostKeyChecking=no',
                  '-o', 'UserKnownHostsFile=/dev/null',
                  '-o', 'BatchMode=yes',
                  '-o', 'ConnectTimeout=5',
                  '-o', 'LogLevel=ERROR',
                  '-p', String(deployState.sshPort),
                  `root@${deployState.sshHost}`,
                  cmd,
                ], { stdio: ['ignore', 'pipe', 'ignore'] });
                let buf = '';
                const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(''); }, 15_000);
                p.stdout?.on('data', (c) => { buf += c.toString('utf8'); });
                p.on('close', () => { clearTimeout(timer); resolve(buf); });
                p.on('error', () => { clearTimeout(timer); resolve(''); });
              });
              if (out.includes('OK')) {
                log.log(`[gpu] App-level recovery succeeded — server.py back up. Resetting health counter.`);
                monitorConsecFails = 0;
                monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
                // Allow another cheap SSH recovery on a fresh failure climb.
                sshRecoveryAttemptedForCurrentDeploy = false;
                setDeployState({ alert: `App auto-restarted via SSH after 3 health failures` });
              } else {
                log.warn(`[gpu] App-level recovery did not confirm server up — falling through to pod restart at 5.`);
              }
            } catch (sshErr) {
              log.warn(`[gpu] App-level SSH recovery failed: ${sshErr instanceof Error ? sshErr.message : sshErr}`);
            }
          }
          // Auto-restart: attempt to restart the pod before declaring it dead.
          // Kept as exact `=== 5` (after a restart monitorConsecFails resets to
          // 0, so the next attempt naturally re-arms when it climbs back to 5).
          if (monitorConsecFails === 5 && deployState.podId) {
            const restartProvider = activeProvider === 'runpod' ? runpod : activeProvider === 'vast' ? vast : null;
            if (restartProvider && (deployApiKey || deployVastApiKey)) {
              const restartKey = activeProvider === 'runpod' ? deployApiKey : deployVastApiKey;
              try {
                log.log(`[gpu] Auto-restart attempt for ${activeProvider} pod ${deployState.podId}...`);
                await restartProvider.startInstance(deployState.podId, { apiKey: restartKey });
                log.log(`[gpu] Auto-restart initiated for pod ${deployState.podId} — resetting health counter`);
                monitorConsecFails = 0;
                monitorDelayMs = 30_000; // Give it time to boot
                setDeployState({ alert: `Pod auto-restarted after 5 health failures` });
              } catch (restartErr) {
                log.error(`[gpu] Auto-restart failed for pod ${deployState.podId}: ${restartErr instanceof Error ? restartErr.message : restartErr}`);
              }
            }
          }

          // Auto-redeploy on crash with different provider: after 10 consecutive failures
          // (restart at 5 didn't help), try redeploying on a different provider.
          // `>=` + a one-shot flag avoids silently skipping recovery if the
          // counter jumps past 10.
          if (monitorConsecFails >= 10 && !crashRedeployTriggeredForCurrentDeploy && getAutoRecoveryEnabled()) {
            const maxRetries = getAutoRecoveryMaxRetries() || MAX_MONITOR_CRASH_RECOVERY;
            if (monitorCrashRecoveryAttempts < maxRetries) {
              crashRedeployTriggeredForCurrentDeploy = true;
              const crashedProvider = deployState.provider;
              monitorCrashRecoveryAttempts++;
              log.warn(`[gpu] Auto-recovery: redeploying on different provider after crash on ${crashedProvider} (attempt ${monitorCrashRecoveryAttempts}/${maxRetries})`);
              broadcastWs({
                type: 'gpu:deploy', phase: 'crash_recovery',
                deployId: deployState.deployId,
                crashedProvider,
                attempt: monitorCrashRecoveryAttempts,
                maxAttempts: maxRetries,
              });

              // Terminate the crashed pod and redeploy via the existing auto-recovery flow
              try {
                const { autoTerminateGpu } = await import('./gpu-terminate');
                await autoTerminateGpu('crash_recovery');
                const { startAutoRecoveryDeploy } = await import('./gpu-auto-recovery');
                await startAutoRecoveryDeploy();
                log.log(`[gpu] Auto-recovery deploy initiated (attempt ${monitorCrashRecoveryAttempts}) — crashed provider: ${crashedProvider}`);
              } catch (recoveryErr) {
                log.error(`[gpu] Auto-recovery deploy failed: ${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr}`);
                broadcastWs({ type: 'gpu:deploy', phase: 'crash_recovery_failed', deployId: deployState.deployId, error: recoveryErr instanceof Error ? recoveryErr.message : 'unknown' });
              }
              monitorRunning = false;
              return; // Stop monitoring — the new deploy will start its own monitor
            } else {
              log.error(`[gpu] Auto-recovery exhausted (${monitorCrashRecoveryAttempts}/${maxRetries} attempts) — giving up`);
              broadcastWs({ type: 'gpu:deploy', phase: 'crash_recovery_exhausted', deployId: deployState.deployId, attempts: monitorCrashRecoveryAttempts });
            }
          }
        }
        // Balance check for RunPod — low balance causes pods to be auto-terminated
        if (activeProvider === 'runpod' && deployApiKey && monitorConsecFails >= 2) {
          try {
            const bal = await runpod.checkBalance({ apiKey: deployApiKey });
            if (bal) {
              const hoursLeft = deployState.costPerHr > 0 ? bal.balance / deployState.costPerHr : 999;
              if (bal.balance < 2.0 || hoursLeft < 2) {
                const msg = `RunPod balance low: $${bal.balance.toFixed(2)} (~${hoursLeft.toFixed(1)}h left) — pod may be auto-stopped. Add funds: https://${BILLING_URLS.runpod}`;
                log.warn(`[gpu] ${msg}`);
                setDeployState({ alert: msg });
              }
            }
          } catch { /* balance check is best-effort */ }
        }
        // If TensorDock, check balance — low balance causes VMs to be reclaimed
        if (activeProvider === 'tensordock' && deployTensordockApiKey && deployTensordockAuthId) {
          try {
            const bal = await tensordock.checkBalance({ apiKey: deployTensordockApiKey, authId: deployTensordockAuthId });
            if (bal) {
              log.log(`[gpu] TensorDock balance: $${bal.balance.toFixed(2)} (hourly: $${bal.hourlyCost.toFixed(3)})`);
              if (bal.balance < 1.0) {
                const msg = `TensorDock balance low: $${bal.balance.toFixed(2)} — VM may have been reclaimed. Add funds: https://${BILLING_URLS.tensordock}`;
                log.warn(`[gpu] ${msg}`);
                setDeployState({ alert: msg });
              }
            }
          } catch { /* balance check is best-effort */ }
        }
      }

      // Budget tracking: accumulate GPU spend with enforcement
      if (deployState.costPerHr > 0) {
        const today = new Date().toISOString().slice(0, 10);
        if (today !== dailySpendResetDate) { setDailyGpuSpendUsd(0); setDailySpendResetDate(today); budgetSoftWarned = false; budgetWarned50 = false; }
        // First probe after restart: charge for elapsed time since deploy
        // started (clamped to today midnight UTC so we don't backdate spend
        // across calendar boundaries). Previously fell back to monitorDelayMs
        // (10s), under-counting hours of spend across gateway restarts and
        // letting the budget gate fail to trip when it should.
        let actualElapsedMs: number;
        if (lastBudgetCalcTime > 0) {
          actualElapsedMs = Date.now() - lastBudgetCalcTime;
        } else if (deployState.startedAt > 0) {
          const todayMidnightUtc = Date.UTC(
            new Date().getUTCFullYear(),
            new Date().getUTCMonth(),
            new Date().getUTCDate(),
          );
          const since = Math.max(deployState.startedAt, todayMidnightUtc);
          actualElapsedMs = Math.max(0, Date.now() - since);
        } else {
          actualElapsedMs = monitorDelayMs;
        }
        lastBudgetCalcTime = Date.now();
        setDailyGpuSpendUsd(dailyGpuSpendUsd + deployState.costPerHr * (actualElapsedMs / 1000 / 3600));
        if (DAILY_BUDGET_USD > 0) {
          const pct = dailyGpuSpendUsd / DAILY_BUDGET_USD;
          // #299: single forecast helper (minute precision) — used for both the
          // soft-limit broadcast and the EOD forecast warning below.
          const forecast = computeBudgetForecast(dailyGpuSpendUsd, deployState.costPerHr);
          if (pct >= 1.0) {
            // HARD BUDGET: auto-terminate to prevent overspend
            log.error(`[budget] HARD LIMIT: $${dailyGpuSpendUsd.toFixed(2)} >= $${DAILY_BUDGET_USD.toFixed(2)} — auto-terminating GPU`);
            broadcastWs({ type: 'gpu:budget', action: 'hard-limit', spend: dailyGpuSpendUsd, budget: DAILY_BUDGET_USD });
            emitGatewayEvent('budget.exceeded', { spend: +dailyGpuSpendUsd.toFixed(2), budget: DAILY_BUDGET_USD });
            const { autoTerminateGpu } = await import('./gpu-terminate');
            await autoTerminateGpu('budget_exceeded');
            return;
          } else if (pct >= 0.8 && !budgetSoftWarned) {
            // SOFT BUDGET: warn + block new deploys
            budgetSoftWarned = true;
            log.warn(`[budget] SOFT LIMIT: $${dailyGpuSpendUsd.toFixed(2)} (${Math.round(pct * 100)}% of $${DAILY_BUDGET_USD.toFixed(2)}) — new deploys blocked`);
            broadcastWs({ type: 'gpu:budget', action: 'soft-limit', spend: dailyGpuSpendUsd, budget: DAILY_BUDGET_USD, forecast });
            emitGatewayEvent('budget.critical', { pct: 80, spend: +dailyGpuSpendUsd.toFixed(2), budget: DAILY_BUDGET_USD });
          } else if (pct >= 0.5 && !budgetWarned50) {
            // 50% warning: informational alert
            budgetWarned50 = true;
            emitGatewayEvent('budget.warning', { pct: 50, spend: +dailyGpuSpendUsd.toFixed(2), budget: DAILY_BUDGET_USD });
          }

          // Continuous spend forecast: warn early when projected EOD spend will exceed budget.
          // #299: reuse the same forecast helper so the two paths can never disagree.
          const forecastEod = forecast;
          const forecastPct = forecastEod / DAILY_BUDGET_USD;
          if (forecastPct > 0.8 && pct < 0.5) {
            log.warn(`[budget] Forecast: $${forecastEod.toFixed(2)} by EOD (budget: $${DAILY_BUDGET_USD.toFixed(2)}) — current spend only ${Math.round(pct * 100)}%`);
            broadcastWs({
              type: 'gpu:budget_forecast',
              forecastEod: Math.round(forecastEod * 100) / 100,
              budget: DAILY_BUDGET_USD,
              pct: Math.round(forecastPct * 100),
              currentSpend: Math.round(dailyGpuSpendUsd * 100) / 100,
            });
          }
        }
      }

      // Latency trend prediction: detect degradation slope before P95 threshold is hit
      const TREND_WINDOW = 5;
      for (const stage of ['stt', 'llm', 'tts'] as const) {
        const ring = perStageLatencyRing[stage];
        if (ring.length >= TREND_WINDOW) {
          const recent = ring.slice(-TREND_WINDOW);
          const older = ring.slice(-TREND_WINDOW * 2, -TREND_WINDOW);
          if (older.length >= TREND_WINDOW) {
            const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
            const olderAvg = older.reduce((s, v) => s + v, 0) / older.length;
            const trend = (recentAvg - olderAvg) / olderAvg;
            if (trend > 0.2) { // 20%+ increase
              log.warn(`[gpu] Latency trend warning: ${stage} increasing ${Math.round(trend * 100)}% (${Math.round(olderAvg)}ms → ${Math.round(recentAvg)}ms)`);
              broadcastWs({ type: 'gpu:latency-trend', stage, trend: Math.round(trend * 100), oldAvg: Math.round(olderAvg), newAvg: Math.round(recentAvg) });
            }
          }
        }
      }

      // P95 demotion check — only when GPU is in production and recently idle
      // Requires 3 consecutive violations before demoting (avoids false positives from transient spikes)
      if (isGpuReadyForProduction() && !isReadinessCheckInProgress()) {
        const idleSec = lastModelRequestTime > 0 ? (Date.now() - lastModelRequestTime) / 1000 : 0;
        if (lastModelRequestTime > 0 && idleSec > getP95IdleWindowSec()) {
          const targets = { stt: getSttTargetLatencyMs(), llm: getLlmTargetLatencyMs(), tts: getTtsTargetLatencyMs() };
          const multiplier = getP95DemotionMultiplier();
          for (const stage of ['stt', 'llm', 'tts'] as const) {
            const p95 = getPerStageP95(stage);
            const threshold = targets[stage] * multiplier;
            if (p95 !== null && p95 > threshold) {
              p95ViolationCount[stage] = (p95ViolationCount[stage] || 0) + 1;
              if (p95ViolationCount[stage] >= P95_DEMOTION_CONSECUTIVE_VIOLATIONS) {
                log.warn(`[gpu] P95 degraded: ${stage} ${p95}ms > ${threshold}ms (${p95ViolationCount[stage]} consecutive) — demoting`);
                setServiceReadiness(stage, { phase: 'degraded' });
                broadcastWs({ type: 'gpu:readiness', stage, phase: 'degraded', p95Ms: p95, thresholdMs: threshold });
                broadcastProviderStatus('booting', 'cloud', `GPU ${stage} P95 degraded — re-benchmarking`);
                setGpuReadyForProduction(false);
                p95ViolationCount = { stt: 0, llm: 0, tts: 0 };
                _startReadinessCheck(deployState.endpoint);
                break;
              } else {
                log.log(`[gpu] P95 warning: ${stage} ${p95}ms > ${threshold}ms (${p95ViolationCount[stage]}/${P95_DEMOTION_CONSECUTIVE_VIOLATIONS})`);
              }
            } else {
              // Reset violation counter for this stage when P95 is within threshold
              p95ViolationCount[stage] = 0;
            }
          }
        }
      }

      // ── Session-cost idle alert (#12) ──
      // Fire when the pod is still billing but has been idle for a while, so the user
      // sees the running meter and gets a clear "stop?" suggestion before auto-stop.
      if (deployState.costPerHr > 0 && deployState.startedAt > 0) {
        const lastActivity = Math.max(lastModelRequestTime, lastRequestTime);
        const idleMs = lastActivity > 0 ? Date.now() - lastActivity : 0;
        // #210: derive the idle-alert threshold from the *effective* idle
        // timeout so it always fires before auto-stop, even if the stop
        // timeout was lowered below the old fixed 5-min constant.
        const sessionAdaptiveTimeout = computeAdaptiveIdleTimeout({
          lastBootDurationMs: deployState.deployDurationMs || 0,
          avgBootTimeS: (deployState.providerMeta as Record<string, unknown>)?.avgBootTimeS as number || 0,
          dockerImage: deployState.dockerImage || '',
          isBooting: false,
        });
        const sessionEffectiveTimeout = resolveEffectiveIdleTimeout(sessionAdaptiveTimeout, IDLE_TIMEOUT_MS);
        const costAlertThresholdMs = sessionCostAlertThresholdMs(sessionEffectiveTimeout, SESSION_COST_ALERT_IDLE_MIN_MS);
        const shouldAlert = idleMs >= costAlertThresholdMs
          && (Date.now() - lastSessionCostAlertAt) >= SESSION_COST_ALERT_INTERVAL_MS;
        if (shouldAlert) {
          const sessionHours = (Date.now() - deployState.startedAt) / 3_600_000;
          const sessionSpend = deployState.costPerHr * sessionHours;
          const idleMin = Math.round(idleMs / 60_000);
          const hoursStr = sessionHours < 1
            ? `${Math.round(sessionHours * 60)} min`
            : `${sessionHours.toFixed(1)}h`;
          const alertMsg = `Spending $${deployState.costPerHr.toFixed(3)}/hr for ${hoursStr} ($${sessionSpend.toFixed(2)} total). GPU idle ${idleMin} min — stop?`;
          log.log(`[gpu] session-cost-alert: ${alertMsg}`);
          setDeployState({ alert: alertMsg, alertLevel: 'warning' });
          broadcastWs({
            type: 'gpu:cost_idle',
            deployId: deployState.deployId,
            provider: deployState.provider,
            costPerHr: deployState.costPerHr,
            sessionSpend: Math.round(sessionSpend * 100) / 100,
            sessionHours: Math.round(sessionHours * 100) / 100,
            idleMin,
            suggestion: 'stop',
            message: alertMsg,
          });
          emitGatewayEvent('gpu.cost_idle', {
            spend: +sessionSpend.toFixed(2),
            hours: +sessionHours.toFixed(2),
            idleMin,
            costPerHr: deployState.costPerHr,
          });
          lastSessionCostAlertAt = Date.now();
        } else if (idleMs < costAlertThresholdMs && lastSessionCostAlertAt > 0) {
          // Activity resumed — reset so next idle period triggers a fresh alert
          lastSessionCostAlertAt = 0;
        }
      }

      // ── Job-vs-inference auto-differentiation (GPU-util pull) ──────────────
      // A training/job pod keeps the GPU busy but serves no HTTP requests, so the
      // request-based idle logic would reap it. Poll GPU utilization over SSH
      // (pull) and, if the GPU is working, reset the idle timer. Works even when
      // the pod can't reach the gateway (local gateway) and when the app /health
      // doesn't expose GPU metrics. An idle inference pod (util≈0, no requests)
      // still gets reaped — cost control preserved. AIGW_GPU_BUSY_PCT tunable.
      if (deployState.sshHost && deployState.sshPort) {
        try {
          const util = await pollGpuUtilViaSsh(deployState.sshHost, deployState.sshPort);
          if (util >= 0) {
            setDeployState({ gpuUtil: util });
            const busyPct = parseFloat(process.env.AIGW_GPU_BUSY_PCT || '5') || 5;
            if (util > busyPct) {
              setLastModelRequestTime(Date.now());
              log.debug(`[gpu] GPU util ${util}% > ${busyPct}% (job busy) — idle timer reset`);
            }
          }
        } catch { /* best-effort — never let util poll break the monitor */ }
      }

      // Idle check — compute adaptive timeout based on boot cost + history
      const adaptiveTimeout = computeAdaptiveIdleTimeout({
        lastBootDurationMs: deployState.deployDurationMs || 0,
        avgBootTimeS: (deployState.providerMeta as Record<string, unknown>)?.avgBootTimeS as number || 0,
        dockerImage: deployState.dockerImage || '',
        isBooting: false, // we're in ready state here
      });
      const effectiveTimeout = resolveEffectiveIdleTimeout(adaptiveTimeout, IDLE_TIMEOUT_MS);
      const idleResult = checkIdleAction(lastModelRequestTime, lastRequestTime, Date.now(), effectiveTimeout, idleWarned);
      if (idleResult.action === 'stop') {
        // Read the active app's `gpuDeploy.hibernateOnIdle` flag and thread it
        // through to autoStopGpu. When true AND provider supports hibernation
        // (Hyperstack today), the VM is hibernated instead of shut off — cuts
        // idle billing to ~10-15% (IP + storage only).
        let allowHibernate = false;
        try {
          const { getActiveApp } = await import('./config-persistence');
          const activeApp = await getActiveApp();
          allowHibernate = activeApp?.gpuDeploy?.hibernateOnIdle === true;
        } catch { /* default to stop on config error */ }
        const label = allowHibernate ? 'hibernating' : 'pausing';
        log.log(`[gpu] Idle ${idleResult.idleMin} min (timeout=${Math.round(effectiveTimeout / 60_000)}min, boot=${Math.round((deployState.deployDurationMs || 0) / 1000)}s) — auto-stopping (${label})`);
        broadcastWs({ type: 'gpu:idle', deployId: deployState.deployId, idleMs: idleResult.idleMs, timeoutMs: effectiveTimeout, action: 'stop', mode: allowHibernate ? 'hibernate' : 'stop' });
        const { autoStopGpu } = await import('./gpu-idle-manager');
        await autoStopGpu(undefined, { allowHibernate });
        return;
      } else if (idleResult.action === 'warning') {
        idleWarned = true;
        log.log(`[gpu] Idle warning: ${idleResult.remainingSec}s until auto-terminate`);
        broadcastWs({ type: 'gpu:idle', deployId: deployState.deployId, idleMs: idleResult.idleMs, timeoutMs: effectiveTimeout, action: 'warning', remainingSec: idleResult.remainingSec });
      }
      // Adaptive monitor frequency during idle
      const idleMs = idleResult.action !== 'none' ? idleResult.idleMs : (Math.max(lastModelRequestTime, lastRequestTime) > 0 ? Date.now() - Math.max(lastModelRequestTime, lastRequestTime) : 0);
      monitorDelayMs = adaptiveMonitorDelay(idleMs, monitorDelayMs, GPU_MONITOR_INTERVAL_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[gpu] Monitor probe failed (provider=${activeProvider}, pod=${deployState.podId}): ${msg}`);
    } finally {
      monitorRunning = false;
      scheduleNextMonitorProbe(); // always reschedule, even after errors
    }
  }, monitorDelayMs) as unknown as Timer);
}

export function stopGpuMonitoring() {
  if (monitorInterval) { clearTimeout(monitorInterval as unknown as ReturnType<typeof setTimeout>); setMonitorInterval(null); }
  monitorConsecFails = 0;
  monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
  setGpuHealthy(false);
}
