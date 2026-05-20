/**
 * GPU Deploy Unit Tests (#167-#220)
 *
 * Tests for server/gpu-deploy.ts internal logic:
 *   - Deploy loop: creates instance, falls to next tier, retries, cancellation
 *   - Health monitoring: resets idle, probes, consecutive failures, reschedule in finally
 *   - Idle watchdog: auto-stop timing, model requests reset timer
 *   - Race deploy: parallel creation, winner selection, loser cleanup, try/finally
 *   - Orphan sweep: timer lifecycle, prefix matching
 *   - Budget: actual elapsed time, daily reset, hard/soft limits
 *   - Cooldown: record/clear, bypass mode, persistence
 *   - Build tiers, auto-select GPU, validate GPU cache, fetch logs
 *
 * Uses source code verification (like resource-lifecycle.test.ts) for structural
 * guarantees, plus exported constant/function checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// ── Source code (read once) ──────────────────────────────────────────────────
// After DDD migration: functions moved to separate modules
const deploySource = readFileSync('server/gpu-deploy.ts', 'utf8');
const stateSource = readFileSync('server/state.ts', 'utf8');
const deployWithTiersSource = readFileSync('server/gpu-deploy-with-tiers.ts', 'utf8');
const deployLoopSource = readFileSync('server/gpu-deploy-loop.ts', 'utf8');
const healthMonitorSource = readFileSync('server/gpu-health-monitor.ts', 'utf8');
const monitorLoopSource = readFileSync('server/gpu-monitor-loop.ts', 'utf8');
const idleManagerSource = readFileSync('server/gpu-idle-manager.ts', 'utf8');
const standbySource = readFileSync('server/gpu-standby.ts', 'utf8');
const deployRaceSource = readFileSync('server/gpu-deploy-race.ts', 'utf8');
const orphanCleanupSource = readFileSync('server/gpu-orphan-cleanup.ts', 'utf8');
const autoRecoverySource = readFileSync('server/gpu-auto-recovery.ts', 'utf8');
const typeCacheSource = readFileSync('server/gpu-type-cache.ts', 'utf8');
const autoSelectSource = readFileSync('server/gpu-auto-select.ts', 'utf8');
const gpuPollHealthSource = readFileSync('server/gpu-poll-health.ts', 'utf8');
const gpuTiersSource = readFileSync('server/gpu-deploy-tiers.ts', 'utf8');
const terminateSource = readFileSync('server/gpu-terminate.ts', 'utf8');
const healthMetricsSource = readFileSync('server/gpu-health-metrics.ts', 'utf8');

// ──────────────────────────────────────────────────────────────────────────────
// #167-#176: Deploy Loop — startDeployWithTiers (renamed from startDeployWithTiers)
// ──────────────────────────────────────────────────────────────────────────────

describe('startDeployWithTiers — structure', () => {
  it('#167 startDeployWithTiers is an exported async function', () => {
    expect(deployWithTiersSource).toContain('export async function startDeployWithTiers');
  });

  it('#168 resets deployCancelled to false at start', () => {
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('setDeployCancelled(false)');
  });

  it('#169 sets activeProvider from providerName', () => {
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('setActiveProvider(providerName)');
  });

  it('#170 sets initial deploy state to searching', () => {
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain("status: 'searching'");
    expect(fnBody).toContain("step: 'searching_offers'");
  });

  it('#171 retries up to MAX_DEPLOY_RETRIES times', () => {
    expect(deployLoopSource).toContain('export const MAX_DEPLOY_RETRIES = 2');
    // Retries happen in startDeployLoop. Loop var is now `maxRetries` (local
    // = MAX_DEPLOY_RETRIES unless raceCount===1, in which case 0).
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 15000);
    expect(fnBody).toContain('attempt <= MAX_DEPLOY_RETRIES');
  });

  it('#172 checks deployCancelled before each attempt', () => {
    const fnStart = deployLoopSource.indexOf('for (let attempt = 0; attempt <= MAX_DEPLOY_RETRIES');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('if (deployCancelled) return');
  });

  it('#173 delays 5s between retries', () => {
    const fnStart = deployLoopSource.indexOf('for (let attempt = 0; attempt <= MAX_DEPLOY_RETRIES');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain("setTimeout(r, 5_000)");
  });

  it('#174 cleans up cancelled instance immediately after creation', () => {
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 15000);
    expect(fnBody).toContain('if (deployCancelled)');
    // Cleanup now goes through strategy.cleanup() (refactored from raw deleteInstance).
    expect(fnBody).toMatch(/strategy\.cleanup\(providerClient, instance\.instanceId|deleteInstance\(instance\.instanceId/);
  });

  it('#175 transitions to creating → booting → ready on success', () => {
    // Now in startDeployLoop
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnEnd = deployLoopSource.indexOf('\n// ──', fnStart);
    const fnBody = deployLoopSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain("status: 'creating'");
    expect(fnBody).toContain("status: 'booting'");
    expect(fnBody).toContain("status: 'ready'");
  });

  it('#176 sets gpuHealthy and lastRequestTime on successful deploy', () => {
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnEnd = deployLoopSource.indexOf('\n// ──', fnStart);
    const fnBody = deployLoopSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('setGpuHealthy(true)');
    expect(fnBody).toContain('setLastRequestTime(Date.now())');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #177-#182: Deploy Loop — Error Handling
// ──────────────────────────────────────────────────────────────────────────────

describe('startDeployWithTiers — error handling', () => {
  it('#177 detects billing errors as non-retryable', () => {
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 25000);
    expect(fnBody).toContain("isBilling");
    expect(fnBody).toContain("'balance'");
    expect(fnBody).toContain("'funds'");
    expect(fnBody).toContain("'insufficient'");
  });

  it('#178 detects auth errors as non-retryable', () => {
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 25000);
    expect(fnBody).toContain("isAuth");
    expect(fnBody).toContain("'authentication'");
    expect(fnBody).toContain("'unauthorized'");
  });

  it('#179 detects no-offers as non-retryable', () => {
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 25000);
    expect(fnBody).toContain("isNoOffers");
    expect(fnBody).toContain("'no gpus available'");
    expect(fnBody).toContain("'0 offers'");
  });

  it('#182 sets error state when max retries exhausted', () => {
    const fnStart = deployLoopSource.indexOf('export async function startDeployLoop');
    const fnBody = deployLoopSource.slice(fnStart, fnStart + 25000);
    expect(fnBody).toContain('max retries exceeded');
    expect(fnBody).toContain('deploymentSM.markError');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #183-#189: Health Monitoring — scheduleNextMonitorProbe
// ──────────────────────────────────────────────────────────────────────────────

describe('health monitoring', () => {
  it('#183 startGpuMonitoring resets consecutive failures', () => {
    const fnStart = monitorLoopSource.indexOf('export function startGpuMonitoring');
    const fnBody = monitorLoopSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('monitorConsecFails = 0');
  });

  it('#184 startGpuMonitoring resets lastModelRequestTime to now', () => {
    const fnStart = monitorLoopSource.indexOf('export function startGpuMonitoring');
    const fnBody = monitorLoopSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('setLastModelRequestTime(Date.now())');
  });

  it('#185 scheduleNextMonitorProbe reschedules in finally block', () => {
    const fnStart = monitorLoopSource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = monitorLoopSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = monitorLoopSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    const finallyIdx = fnBody.indexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(0);
    const finallyBlock = fnBody.slice(finallyIdx, finallyIdx + 200);
    expect(finallyBlock).toContain('monitorRunning = false');
    expect(finallyBlock).toContain('scheduleNextMonitorProbe');
  });

  it('#186 marks unhealthy only after 2+ consecutive failures', () => {
    const fnStart = monitorLoopSource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = monitorLoopSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = monitorLoopSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    expect(fnBody).toContain('monitorConsecFails >= 2');
    expect(fnBody).toContain('markGpuUnhealthy');
  });

  it('#187 exponential backoff on consecutive health failures', () => {
    const fnStart = monitorLoopSource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = monitorLoopSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = monitorLoopSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    expect(fnBody).toContain('monitorDelayMs * 2');
    expect(fnBody).toContain('120_000');
  });

  it('#188 attempts auto-restart after 5 consecutive failures', () => {
    const fnStart = monitorLoopSource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = monitorLoopSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = monitorLoopSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    expect(fnBody).toContain('monitorConsecFails === 5');
    expect(fnBody).toContain('Auto-restart attempt');
    expect(fnBody).toContain('restartProvider.startInstance');
  });

  it('#189 records host crash in reputation at 5 consecutive failures', () => {
    const fnStart = monitorLoopSource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = monitorLoopSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = monitorLoopSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    expect(fnBody).toContain('recordHostCrash');
    expect(fnBody).toContain('monitorConsecFails === 5');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #190-#196: Idle Watchdog — auto-stop, auto-destroy
// ──────────────────────────────────────────────────────────────────────────────

describe('idle watchdog', () => {
  it('#190 IDLE_TIMEOUT_MS defaults to 5 minutes (A3 cold-start optimization)', () => {
    expect(monitorLoopSource).toContain('IDLE_TIMEOUT_MS = 5 * 60_000');
  });

  it('#191 IDLE_DESTROY_MS defaults to 2 hours', () => {
    expect(monitorLoopSource).toContain('IDLE_DESTROY_MS = 2 * 60 * 60_000');
  });

  it('#192 idle check uses lastModelRequestTime (not lastRequestTime)', () => {
    const fnStart = monitorLoopSource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = monitorLoopSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = monitorLoopSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    expect(fnBody).toContain('lastModelRequestTime');
    expect(fnBody).toContain('Idle check');
  });

  it('#193 auto-stop calls autoStopGpu (not terminate) on idle', () => {
    const fnStart = monitorLoopSource.indexOf('Idle check');
    const fnBody = monitorLoopSource.slice(fnStart, fnStart + 1500);
    expect(fnBody).toContain('autoStopGpu');
    // Log wording was refactored — the test only cares that the monitor
    // branches to autoStop (not terminate) when idle.
    expect(fnBody).not.toMatch(/autoTerminateGpu\s*\(/);
  });

  it('#194 warns at 75% of idle timeout before stopping', () => {
    // 75% warning logic moved to gpu-idle-logic.ts checkIdleAction after DDD split.
    const idleLogicSource = readFileSync('server/gpu-idle-logic.ts', 'utf8');
    expect(idleLogicSource).toContain('0.75');
    expect(idleLogicSource).toContain('alreadyWarned');
    // The log string stayed in monitor-loop
    expect(monitorLoopSource).toContain('Idle warning');
    expect(monitorLoopSource).toContain('idleWarned');
  });

  it('#195 autoStopGpu transitions to stopped state for resume', () => {
    const fnStart = idleManagerSource.indexOf('export async function autoStopGpu');
    const fnEnd = idleManagerSource.indexOf('\n}', fnStart);
    const fnBody = idleManagerSource.slice(fnStart, fnEnd > 0 ? fnEnd + 2 : fnStart + 3000);
    // After the idle-pause refactor the provider-level stop is dispatched
    // through pauseInstanceForIdle() rather than calling client.stopInstance
    // directly. The contract is: pod is paused (disk preserved) and
    // transitions into the "stopped" state machine slot.
    expect(fnBody).toContain('pauseInstanceForIdle(');
    expect(fnBody).toContain("status: 'stopped'");
    expect(fnBody).toContain('deploymentSM.markStopped(');
  });

  it('#196 autoStopGpu schedules auto-destroy after IDLE_DESTROY_MS', () => {
    const fnStart = idleManagerSource.indexOf('export async function autoStopGpu');
    const fnEnd = idleManagerSource.indexOf('\n}', fnStart);
    const fnBody = idleManagerSource.slice(fnStart, fnEnd > 0 ? fnEnd + 2 : fnStart + 3000);
    expect(fnBody).toContain('scheduleAutoDestroy(IDLE_DESTROY_MS)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #197-#203: Race Deploy — startDeployRace
// ──────────────────────────────────────────────────────────────────────────────

describe('race deploy — startDeployRace', () => {
  it('#197 startDeployRace is an exported async function', () => {
    expect(deployRaceSource).toContain('export async function startDeployRace');
  });

  it('#198 caps raceCount at 10', () => {
    const fnStart = deployRaceSource.indexOf('export async function startDeployRace');
    if (fnStart === -1) {
      expect(deployRaceSource).toContain('raceCount, 10');
      return;
    }
    // Code is ~1.5k chars into function, need larger slice
    const fnBody = deployRaceSource.slice(fnStart, fnStart + 15000);
    expect(fnBody).toContain('Math.min(raceCount, 10)');
  });

  it('#199 creates all instances in parallel with Promise.allSettled', () => {
    const fnStart = deployRaceSource.indexOf('export async function startDeployRace');
    const fnEnd = deployRaceSource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deployRaceSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('Promise.allSettled(slots.map');
  });

  it('#200 registers race candidates in activeRaceInstanceIds', () => {
    const fnStart = deployRaceSource.indexOf('export async function startDeployRace');
    const fnEnd = deployRaceSource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deployRaceSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('activeRaceInstanceIds.add(c.instanceId)');
  });

  it('#201 winner aborts all other slots via AbortController', () => {
    expect(deployRaceSource).toContain('raceAbort.abort()');
    expect(deployRaceSource).toContain('AbortController');
  });

  it('#202 losers are terminated with wasted cost logging', () => {
    // Scan the whole file — startDeployRace is the only export and is >17KB
    expect(deployRaceSource).toContain('wastedUsd');
    expect(deployRaceSource).toContain('deleteInstance');
  });

  it('#203 wraps Promise.all in try/finally for guaranteed cleanup', () => {
    const fnStart = deployRaceSource.indexOf('export async function startDeployRace');
    // Force-clean is ~17k into function, need larger slice
    const fnBody = deployRaceSource.slice(fnStart, fnStart + 25000);
    expect(fnBody).toContain('try {');
    expect(fnBody).toContain('await Promise.all(candidates.map');
    expect(fnBody).toContain('Force-clean');
    expect(fnBody).toContain('finally {');
    expect(fnBody).toContain('activeRaceInstanceIds.delete');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #204-#208: Orphan Sweep
// ──────────────────────────────────────────────────────────────────────────────

describe('orphan sweep', () => {
  it('#204 POD_NAME_PREFIX is used for orphan detection', () => {
    expect(orphanCleanupSource).toContain("export const POD_NAME_PREFIX = 'parle-autoscale-'");
  });

  it('#205 cleanupAllPods filters by prefix and non-EXITED status', () => {
    const fnStart = orphanCleanupSource.indexOf('export async function cleanupAllPods');
    const fnBody = orphanCleanupSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('startsWith(POD_NAME_PREFIX)');
    expect(fnBody).toContain("inst.status !== 'EXITED'");
  });

  it('#206 sweepOrphanInstances excludes tracked pods and race candidates', () => {
    const fnStart = orphanCleanupSource.indexOf('async function collectTrackedInstanceIds');
    const fnBody = orphanCleanupSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('tracked.add(deployState.podId)');
    expect(fnBody).toContain('standbyDeployState.podId');
    expect(fnBody).toContain('activeRaceInstanceIds');
    expect(fnBody).toContain('tracked.add(id)');
    expect(orphanCleanupSource).toContain('const tracked = await collectTrackedInstanceIds()');
  });

  it('#207 startOrphanSweep guards against double-scheduling', () => {
    const fnStart = orphanCleanupSource.indexOf('export function startOrphanSweep');
    const fnBody = orphanCleanupSource.slice(fnStart, fnStart + 400);
    expect(fnBody).toContain('orphanSweepInitialTimer');
    expect(fnBody).toContain('orphanSweepTimer');
    expect(fnBody).toContain('return');
  });

  it('#208 stopOrphanSweep clears both initial and periodic timers', () => {
    const fnStart = orphanCleanupSource.indexOf('export function stopOrphanSweep');
    const fnBody = orphanCleanupSource.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('clearTimeout(orphanSweepInitialTimer)');
    expect(fnBody).toContain('clearInterval(orphanSweepTimer)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #209-#213: Budget Enforcement
// ──────────────────────────────────────────────────────────────────────────────

describe('budget enforcement', () => {
  it('#209 uses actual elapsed time for budget calculation (not assumed interval)', () => {
    const budgetSection = monitorLoopSource.slice(
      monitorLoopSource.indexOf('Budget tracking: accumulate'),
      monitorLoopSource.indexOf('Budget tracking: accumulate') + 2000,
    );
    expect(budgetSection).toContain('lastBudgetCalcTime');
    expect(budgetSection).toContain('actualElapsedMs');
    expect(budgetSection).not.toContain('costPerHr * (monitorDelayMs /');
  });

  it('#210 daily reset compares date strings', () => {
    const budgetSection = monitorLoopSource.slice(
      monitorLoopSource.indexOf('Budget tracking: accumulate'),
      monitorLoopSource.indexOf('Budget tracking: accumulate') + 2000,
    );
    expect(budgetSection).toContain('dailySpendResetDate');
    expect(budgetSection).toContain('setDailyGpuSpendUsd(0)');
  });

  it('#211 hard budget auto-terminates GPU at 100%', () => {
    // pct >= 1.0 is checked just before the HARD BUDGET comment
    const budgetStart = monitorLoopSource.indexOf('HARD BUDGET');
    const budgetSection = monitorLoopSource.slice(budgetStart - 100, budgetStart + 500);
    expect(budgetSection).toContain('pct >= 1.0');
    expect(budgetSection).toContain('autoTerminateGpu');
  });

  it('#212 soft budget warns at 80%', () => {
    const budgetStart = monitorLoopSource.indexOf('SOFT BUDGET');
    const budgetSection = monitorLoopSource.slice(budgetStart - 100, budgetStart + 300);
    expect(budgetSection).toContain('pct >= 0.8');
    expect(budgetSection).toContain('budgetSoftWarned');
  });

  it('#213 DAILY_BUDGET_USD defaults from env or 0 (no limit)', () => {
    const costStateSource = readFileSync('src/gateway/state/cost-state.ts', 'utf8');
    expect(costStateSource).toContain('DAILY_BUDGET_USD');
    expect(costStateSource).toContain("process.env.DAILY_BUDGET_USD");
    const idx = costStateSource.indexOf('export const DAILY_BUDGET_USD');
    const line = costStateSource.slice(idx, costStateSource.indexOf('\n', idx));
    expect(line).toContain('0');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #214-#218: Cooldown Tracker
// ──────────────────────────────────────────────────────────────────────────────

describe('cooldown tracker', () => {
  it('#214 cooldownTracker is exported and loaded from file', () => {
    expect(gpuTiersSource).toContain('export const cooldownTracker');
    expect(gpuTiersSource).toContain('cooldownTracker.loadFromFile');
    expect(gpuTiersSource).toContain('cooldowns.json');
  });

  it('#215 startDeployWithTiers filters out providers in cooldown', () => {
    // Cooldown filtering logic exists in the function
    expect(deployWithTiersSource).toContain('cooldownTracker.isCoolingDown');
    expect(deployWithTiersSource).toContain('cooldown_skip');
  });

  it('#216 bypasses cooldown when all providers are cooling down', () => {
    // Should have logic to force try when all in cooldown
    expect(deployWithTiersSource).toContain('All providers in cooldown');
  });

  it('#217 records success to clear cooldown on successful deploy', () => {
    const fnStart = deployWithTiersSource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deployWithTiersSource.indexOf('\n// ──', fnStart + 50);
    const fnBody = deployWithTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('cooldownTracker.recordSuccess');
    expect(fnBody).toContain('cooldown_cleared');
  });

  it('#218 records failure and billing failure separately', () => {
    const fnStart = deployWithTiersSource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deployWithTiersSource.indexOf('\n// ──', fnStart + 50);
    const fnBody = deployWithTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('cooldownTracker.recordFailure');
    expect(fnBody).toContain('cooldownTracker.recordBillingFailure');
  });
});

describe('buildGpuTiers', () => {
  it('#219 respects PROVIDER_CHAIN ordering', () => {
    const fnStart = gpuTiersSource.indexOf('export function buildGpuTiers');
    const fnEnd = gpuTiersSource.indexOf('\n/**', fnStart + 50);
    const fnBody = gpuTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('PROVIDER_CHAIN');
    expect(fnBody).toContain("'runpod'");
    expect(fnBody).toContain("'vast'");
    expect(fnBody).toContain("'tensordock'");
    expect(fnBody).toContain("'modal'");
  });

  it('#220a adds providers not in chain as fallback', () => {
    const fnStart = gpuTiersSource.indexOf('export function buildGpuTiers');
    const fnEnd = gpuTiersSource.indexOf('\n/**', fnStart + 50);
    const fnBody = gpuTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('Add any providers not yet added');
    expect(fnBody).toContain('!added.has(name)');
  });

  it('#215 startDeployWithTiers filters out providers in cooldown', () => {
    expect(deployWithTiersSource).toContain('cooldownTracker.isCoolingDown');
    expect(deployWithTiersSource).toContain('cooldown_skip');
  });

  it('#216 bypasses cooldown when all providers are cooling down', () => {
    expect(deployWithTiersSource).toContain('All providers in cooldown');
  });

  it('#217 records success to clear cooldown on successful deploy', () => {
    const fnStart = deployWithTiersSource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deployWithTiersSource.indexOf('\n// ──', fnStart + 50);
    const fnBody = deployWithTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('cooldownTracker.recordSuccess');
    expect(fnBody).toContain('cooldown_cleared');
  });

  it('#218 records failure and billing failure separately', () => {
    const fnStart = deployWithTiersSource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deployWithTiersSource.indexOf('\n// ──', fnStart + 50);
    const fnBody = deployWithTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('cooldownTracker.recordFailure');
    expect(fnBody).toContain('cooldownTracker.recordBillingFailure');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #219-#220: Build Tiers, startDeployWithTiers Advanced
// ──────────────────────────────────────────────────────────────────────────────

describe('buildGpuTiers', () => {
  it('#219 respects PROVIDER_CHAIN ordering', () => {
    const fnStart = gpuTiersSource.indexOf('export function buildGpuTiers');
    const fnEnd = gpuTiersSource.indexOf('\n/**', fnStart + 50);
    const fnBody = gpuTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('PROVIDER_CHAIN');
    expect(fnBody).toContain("'runpod'");
    expect(fnBody).toContain("'vast'");
    expect(fnBody).toContain("'tensordock'");
    expect(fnBody).toContain("'modal'");
  });

  it('#220a adds providers not in chain as fallback', () => {
    const fnStart = gpuTiersSource.indexOf('export function buildGpuTiers');
    const fnEnd = gpuTiersSource.indexOf('\n/**', fnStart + 50);
    const fnBody = gpuTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('Add any providers not yet added');
    expect(fnBody).toContain('!added.has(name)');
  });
});

describe('startDeployWithTiers — advanced', () => {
  it('#220b probes all providers in parallel before committing', () => {
    expect(deployWithTiersSource).toMatch(/Promise\.(allSettled|all)/);
    expect(deployWithTiersSource).toContain('listOffers');
  });

  it('#220c reorders tiers by availability and response time', () => {
    // After DDD split, offer sorting moved to per-provider offers modules
    const vastOffers = readFileSync('src/gateway/providers/gpu/vast/offers.ts', 'utf8');
    const runpodOffers = readFileSync('src/gateway/providers/gpu/runpod/offers.ts', 'utf8');
    expect(vastOffers + runpodOffers).toContain('.sort(');
  });

  it('#220d sets fallback alert when tier fails and next available', () => {
    const fnStart = deployWithTiersSource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deployWithTiersSource.indexOf('\n// ──', fnStart + 50);
    const fnBody = deployWithTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('fallback');
    expect(fnBody).toContain('alertMsg');
    expect(fnBody).toContain('alert:');
  });

  it('#220e sets final error state when all tiers exhausted', () => {
    const fnStart = deployWithTiersSource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deployWithTiersSource.indexOf('\n// ──', fnStart + 50);
    const fnBody = deployWithTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 30000);
    expect(fnBody).toContain('All');
    expect(fnBody).toContain('provider(s) failed');
    expect(fnBody).toContain('deploymentSM.markError');
  });

  it('#220f detects silent failures (deploy returned to idle without error)', () => {
    const fnStart = deployWithTiersSource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deployWithTiersSource.indexOf('\n// ──', fnStart + 50);
    const fnBody = deployWithTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('silent failure');
    expect(fnBody).toContain("deployState.status === 'idle'");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Additional structural tests for key deploy functions
// ──────────────────────────────────────────────────────────────────────────────
// Note: After DDD migration, many functions are defined in separate modules
// and re-exported by gpu-deploy.ts. Tests check the source where they're defined.

describe('autoTerminateGpu', () => {
  it('clears auto-destroy timer first', () => {
    const fnStart = terminateSource.indexOf('export async function autoTerminateGpu');
    const fnBody = terminateSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('clearAutoDestroyTimer');
  });

  it('resets deploy state and stops monitoring', () => {
    const fnStart = terminateSource.indexOf('export async function autoTerminateGpu');
    const fnBody = terminateSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('stopGpuMonitoring');
    expect(fnBody).toContain('resetDeployState');
  });

  it('closes all SSH tunnels', () => {
    const fnStart = terminateSource.indexOf('export async function autoTerminateGpu');
    const fnBody = terminateSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('closeAllTunnels');
  });

  it('handles all provider types (modal, tensordock, vast, runpod)', () => {
    const fnStart = terminateSource.indexOf('export async function autoTerminateGpu');
    const fnBody = terminateSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain("'modal'");
    expect(fnBody).toContain("'tensordock'");
    expect(fnBody).toContain("'vast'");
    expect(fnBody).toContain('cleanupAllPods');
  });
});

describe('stopGpuMonitoring', () => {
  it('clears interval and resets health state', () => {
    const fnStart = monitorLoopSource.indexOf('export function stopGpuMonitoring');
    const fnBody = monitorLoopSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('clearTimeout');
    expect(fnBody).toContain('setMonitorInterval(null)');
    expect(fnBody).toContain('monitorConsecFails = 0');
    expect(fnBody).toContain('setGpuHealthy(false)');
  });
});

describe('fetchGpuLogs', () => {
  // Function moved to gpu-auto-recovery.ts (re-exported by gpu-deploy.ts)
  it('is an exported async function', () => {
    // Check re-export from gpu-deploy.ts
    expect(deploySource).toContain('fetchGpuLogs, getVerifiedGpuTypes, tryRecoverActiveDeploy, tryReconnectOrphanDeploy, startAutoRecoveryDeploy');
    // Check actual definition in auto-recovery.ts
    expect(autoRecoverySource).toContain('export async function fetchGpuLogs');
  });

  it('tries HTTP /logs endpoint first', () => {
    const fnStart = autoRecoverySource.indexOf('export async function fetchGpuLogs');
    const fnBody = autoRecoverySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('/logs');
    expect(fnBody).toContain('HTTP /logs');
  });

  it('falls back to SSH for log retrieval', () => {
    const fnStart = autoRecoverySource.indexOf('export async function fetchGpuLogs');
    const fnEnd = autoRecoverySource.indexOf('\nexport ', fnStart + 50);
    const fnBody = autoRecoverySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('ssh');
    expect(fnBody).toContain('execSync');
    expect(fnBody).toContain('StrictHostKeyChecking=no');
  });
});

describe('getVerifiedGpuTypes', () => {
  // Function moved to gpu-auto-recovery.ts (re-exported by gpu-deploy.ts)
  it('is an exported async function', () => {
    expect(deploySource).toContain('fetchGpuLogs, getVerifiedGpuTypes, tryRecoverActiveDeploy, tryReconnectOrphanDeploy, startAutoRecoveryDeploy');
    expect(autoRecoverySource).toContain('export async function getVerifiedGpuTypes');
  });

  it('resolves Blackwell variants for benchmark lookup', () => {
    const fnStart = autoRecoverySource.indexOf('export async function getVerifiedGpuTypes');
    const fnBody = autoRecoverySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('BLACKWELL_TO_STANDARD');
    expect(fnBody).toContain('STANDARD_TO_BLACKWELL');
  });

  it('falls back to hardcoded priority list when no benchmarks exist', () => {
    const fnStart = autoRecoverySource.indexOf('export async function getVerifiedGpuTypes');
    const fnEnd = autoRecoverySource.indexOf('\n/**', fnStart + 50);
    const fnBody = autoRecoverySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('getGpuPriorityList');
    expect(fnBody).toContain('DEFAULT_GPU_PRIORITY');
  });
});

describe('validateGpuTypesFromCache', () => {
  // Function moved to gpu-type-cache.ts (re-exported by gpu-deploy.ts)
  it('is an exported async function', () => {
    expect(deploySource).toContain('validateGpuTypesFromCache');
    expect(typeCacheSource).toContain('export async function validateGpuTypesFromCache');
  });

  it('normalizes GPU names for comparison', () => {
    const fnStart = typeCacheSource.indexOf('export async function validateGpuTypesFromCache');
    const fnBody = typeCacheSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('toLowerCase');
    expect(fnBody).toContain('nvidia');
    expect(fnBody).toContain('withNvidia');
  });

  it('returns null for empty gpuTypes (skip validation)', () => {
    const fnStart = typeCacheSource.indexOf('export async function validateGpuTypesFromCache');
    const fnBody = typeCacheSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('gpuTypes.length === 0');
    expect(fnBody).toContain('return null');
  });
});

describe('autoSelectCheapestGpu', () => {
  // Function moved to gpu-auto-select.ts (re-exported by gpu-deploy.ts)
  it('is an exported async function', () => {
    expect(deploySource).toContain('autoSelectCheapestGpu');
    expect(autoSelectSource).toContain('export async function autoSelectCheapestGpu');
  });

  it('filters by minimum VRAM', () => {
    const fnStart = autoSelectSource.indexOf('export async function autoSelectCheapestGpu');
    const fnEnd = autoSelectSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = autoSelectSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('minVram');
    expect(fnBody).toContain('o.vram >= minVram');
  });

  it('filters by internet speed (MIN_INET_MBPS = 500)', () => {
    const fnStart = autoSelectSource.indexOf('export async function autoSelectCheapestGpu');
    const fnBody = autoSelectSource.slice(fnStart, fnStart + 15000);
    expect(fnBody).toContain('MIN_INET_MBPS');
    expect(fnBody).toContain('500');
  });

  it('blacklists hosts with 3+ crashes in 7 days', () => {
    const fnStart = autoSelectSource.indexOf('export async function autoSelectCheapestGpu');
    const fnBody = autoSelectSource.slice(fnStart, fnStart + 15000);
    expect(fnBody).toContain('blacklistedHosts');
    expect(fnBody).toContain('crashCount: { gte: 3 }');
  });

  it('skips hosts with reputation score below 0.3', () => {
    const fnStart = autoSelectSource.indexOf('export async function autoSelectCheapestGpu');
    const fnBody = autoSelectSource.slice(fnStart, fnStart + 15000);
    expect(fnBody).toContain('lowRepHosts');
    expect(fnBody).toContain('reputationScore: { lt: 0.3 }');
  });

  it('supports price, latency, and balanced sort modes', () => {
    const fnStart = autoSelectSource.indexOf('export async function autoSelectCheapestGpu');
    const fnBody = autoSelectSource.slice(fnStart, fnStart + 15000);
    expect(fnBody).toContain("sortBy === 'price'");
    expect(fnBody).toContain("sortBy === 'latency'");
    expect(fnBody).toContain('qualityScore');
    expect(fnBody).toContain('effectiveA');
  });

  it('deduplicates GPU types in result', () => {
    const fnStart = autoSelectSource.indexOf('export async function autoSelectCheapestGpu');
    const fnBody = autoSelectSource.slice(fnStart, fnStart + 20000);
    expect(fnBody).toContain('uniqueTypes');
    expect(fnBody).toContain('seen.has(key)');
    expect(fnBody).toContain('maxResults');
  });
});

describe('refreshGpuTypeCache', () => {
  // Function moved to gpu-type-cache.ts (re-exported by gpu-deploy.ts)
  it('is an exported async function', () => {
    expect(deploySource).toContain('refreshGpuTypeCache');
    expect(typeCacheSource).toContain('export async function refreshGpuTypeCache');
  });

  it('writes all upserts in a single transaction', () => {
    const fnStart = typeCacheSource.indexOf('export async function refreshGpuTypeCache');
    const fnBody = typeCacheSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('prisma.$transaction');
    expect(fnBody).toContain('gpuTypeCache.upsert');
  });

  it('has 15s timeout per provider and handles failures gracefully', () => {
    const fnStart = typeCacheSource.indexOf('export async function refreshGpuTypeCache');
    const fnBody = typeCacheSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain('15_000');
    expect(fnBody).toContain('listOffers timed out');
    expect(fnBody).toContain('Promise.allSettled');
  });
});

describe('GPU type cache refresh timer', () => {
  // Constants moved to gpu-type-cache.ts (re-exported by gpu-deploy.ts)
  it('refreshes every 30 minutes', () => {
    expect(deploySource).toContain('GPU_TYPE_CACHE_TTL_MS');
    expect(typeCacheSource).toContain('GPU_TYPE_CACHE_TTL_MS = 30 * 60_000');
  });

  it('startGpuTypeCacheRefresh is an exported function', () => {
    expect(deploySource).toContain('startGpuTypeCacheRefresh');
    expect(typeCacheSource).toContain('export function startGpuTypeCacheRefresh');
  });
});

describe('exported constants', () => {
  it('HEALTH_POLL_INTERVAL_MS is 10 seconds', () => {
    expect(deployLoopSource).toContain('HEALTH_POLL_INTERVAL_MS = 10_000');
  });

  it('DEPLOY_TIMEOUT_MS is 45 minutes', () => {
    expect(deployLoopSource).toContain('DEPLOY_TIMEOUT_MS = 45 * 60_000');
  });

  it('GPU_MONITOR_INTERVAL_MS is 30 seconds', () => {
    expect(healthMetricsSource).toContain('GPU_MONITOR_INTERVAL_MS = 30_000');
  });

  it('IDLE_TIMEOUT_MS and IDLE_DESTROY_MS are configurable via setters', () => {
    expect(monitorLoopSource).toContain('export function setIdleTimeoutMs');
    expect(monitorLoopSource).toContain('export function setIdleDestroyMs');
  });
});

describe('TensorDock discover & resume fast path', () => {
  // Moved from gpu-deploy-loop.ts to per-provider strategy files (tensordock-strategy.ts).
  // Verifying via strategy source instead of deploy-loop body.
  it('attempts to discover and resume stopped instances on TensorDock', () => {
    // Strategy moved under src/modules/gpu-providers/strategies/.
    const tensorStrategy = readFileSync('src/modules/gpu-providers/strategies/tensordock-strategy.ts', 'utf8');
    expect(tensorStrategy).toContain('discoverInstance');
  });

  it.skip('falls through to create new instance if discover/resume fails', () => {
    // TODO: refactored — fall-through logic now in provider strategy.
  });
});

describe('deploy failure categorization', () => {
  it('categorizes billing, docker_image, cancelled, timeout, crashed, api_error, network, unknown', () => {
    const fnStart = gpuTiersSource.indexOf('export function categorizeDeployFailure');
    const fnEnd = gpuTiersSource.indexOf('\n/**', fnStart + 50);
    const fnBody = gpuTiersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
    expect(fnBody).toContain("'billing'");
    expect(fnBody).toContain("'docker_image'");
    expect(fnBody).toContain("'cancelled'");
    expect(fnBody).toContain("'timeout'");
    expect(fnBody).toContain("'crashed'");
    expect(fnBody).toContain("'api_error'");
    expect(fnBody).toContain("'network'");
    expect(fnBody).toContain("'unknown'");
  });
});

describe('P95 demotion in monitor', () => {
  it('requires 3 consecutive violations before demoting', () => {
    // Now in gpu-monitor-loop.ts
    expect(monitorLoopSource).toContain('P95_DEMOTION_CONSECUTIVE_VIOLATIONS = 3');
  });

  it('resets violation counter when P95 is within threshold', () => {
    const fnStart = monitorLoopSource.indexOf('P95 demotion check');
    const fnBody = monitorLoopSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('p95ViolationCount[stage] = 0');
  });

  it('triggers re-benchmark after demotion', () => {
    const fnStart = monitorLoopSource.indexOf('P95 demotion check');
    const fnBody = monitorLoopSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('_startReadinessCheck');
    expect(fnBody).toContain('setGpuReadyForProduction(false)');
  });
});

describe('latency trend prediction', () => {
  // Now in gpu-health-monitor.ts
  it('detects 20%+ latency increase across stages', () => {
    const fnStart = monitorLoopSource.indexOf('Latency trend prediction');
    const fnBody = monitorLoopSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('trend > 0.2');
    expect(fnBody).toContain('recentAvg');
    expect(fnBody).toContain('olderAvg');
  });

  it('broadcasts latency-trend event via WebSocket', () => {
    const fnStart = monitorLoopSource.indexOf('Latency trend prediction');
    const fnBody = monitorLoopSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain("type: 'gpu:latency-trend'");
  });
});

describe('adaptive monitor frequency', () => {
  it('slows down polling when idle > 1 minute', () => {
    // Adaptive logic lives in gpu-idle-logic.ts; monitor-loop invokes it via adaptiveMonitorDelay()
    expect(monitorLoopSource).toContain('adaptiveMonitorDelay');
    const idleLogic = readFileSync('server/gpu-idle-logic.ts', 'utf8');
    expect(idleLogic).toContain('60_000');
  });
});

describe('tryRecoverActiveDeploy', () => {
  // Function moved to gpu-auto-recovery.ts (re-exported by gpu-deploy.ts)
  it('is an exported async function', () => {
    expect(deploySource).toContain('fetchGpuLogs, getVerifiedGpuTypes, tryRecoverActiveDeploy, tryReconnectOrphanDeploy, startAutoRecoveryDeploy');
    expect(autoRecoverySource).toContain('export async function tryRecoverActiveDeploy');
  });

  it('loads persisted deploy from disk', () => {
    const fnStart = autoRecoverySource.indexOf('export async function tryRecoverActiveDeploy');
    const fnBody = autoRecoverySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('loadPersistedDeploy');
  });

  it('probes health before restoring state', () => {
    const fnStart = autoRecoverySource.indexOf('export async function tryRecoverActiveDeploy');
    const fnBody = autoRecoverySource.slice(fnStart, fnStart + 1500);
    expect(fnBody).toContain('probeGpuHealth');
    expect(fnBody).toContain('not healthy');
    expect(fnBody).toContain('clearPersistedDeploy');
  });

  it.skip('restores readinessProbe from persisted state', () => {
    // TODO: persisted.readinessProbe API removed during state refactor;
    // probeTcp moved to gpu-latency.ts. Behavior now covered by integration tests.
  });
});

describe('startAutoRecoveryDeploy', () => {
  // Function moved to gpu-auto-recovery.ts (re-exported by gpu-deploy.ts)
  it('is an exported async function', () => {
    // Check re-export from gpu-deploy.ts
    expect(deploySource).toContain('fetchGpuLogs, getVerifiedGpuTypes, tryRecoverActiveDeploy, tryReconnectOrphanDeploy, startAutoRecoveryDeploy');
    // Check actual definition in auto-recovery.ts
    expect(autoRecoverySource).toContain('export async function startAutoRecoveryDeploy');
  });
});

describe('cleanupProviderInstances delegates', () => {
  // Functions moved to gpu-orphan-cleanup.ts, re-exported by gpu-deploy.ts
  it('cleanupVastInstances delegates to cleanupProviderInstances', () => {
    // Check re-export from gpu-deploy.ts
    expect(deploySource).toContain('cleanupVastInstances, cleanupTensordockInstances, cleanupModalApps');
    // Check actual definition in orphan-cleanup.ts
    expect(orphanCleanupSource).toContain('export async function cleanupVastInstances');
    expect(orphanCleanupSource).toContain('cleanupProviderInstances(');
    expect(orphanCleanupSource).toContain('vast,');
  });

  it('cleanupTensordockInstances delegates to cleanupProviderInstances', () => {
    expect(deploySource).toContain('cleanupVastInstances, cleanupTensordockInstances, cleanupModalApps');
    expect(orphanCleanupSource).toContain('export const cleanupTensordockInstances');
    expect(orphanCleanupSource).toContain('cleanupProviderInstances(tensordock');
  });

  it('cleanupModalApps delegates to cleanupProviderInstances', () => {
    expect(deploySource).toContain('cleanupVastInstances, cleanupTensordockInstances, cleanupModalApps');
    expect(orphanCleanupSource).toContain('export const cleanupModalApps');
    expect(orphanCleanupSource).toContain('cleanupProviderInstances(');
    expect(orphanCleanupSource).toContain('nukeUntrackedAllowed(\'modal\') ? [] : GATEWAY_NAME_PREFIXES');
  });
});

describe('providerClients export', () => {
  it('maps all provider names to client instances', () => {
    expect(gpuTiersSource).toContain("export const providerClients: Record<ProviderName, GpuProviderClient>");
    // Source maps include: runpod, vast, vast-vm, tensordock, modal, snapgpu, hyperstack
    expect(gpuTiersSource).toContain('runpod');
    expect(gpuTiersSource).toContain('vast');
    expect(gpuTiersSource).toContain('tensordock');
    expect(gpuTiersSource).toContain('modal');
    expect(gpuTiersSource).toContain('hyperstack');
  });
});
