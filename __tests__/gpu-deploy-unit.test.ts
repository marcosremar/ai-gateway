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
const deploySource = readFileSync('server/gpu-deploy.ts', 'utf8');
const stateSource = readFileSync('server/state.ts', 'utf8');

// ──────────────────────────────────────────────────────────────────────────────
// #167-#176: Deploy Loop — startDeployLoop
// ──────────────────────────────────────────────────────────────────────────────

describe('startDeployLoop — structure', () => {
  it('#167 startDeployLoop is an exported async function', () => {
    expect(deploySource).toContain('export async function startDeployLoop');
  });

  it('#168 resets deployCancelled to false at start', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('setDeployCancelled(false)');
  });

  it('#169 sets activeProvider from providerName', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('setActiveProvider(providerName)');
  });

  it('#170 sets initial deploy state to searching', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnBody = deploySource.slice(fnStart, fnStart + 800);
    expect(fnBody).toContain("status: 'searching'");
    expect(fnBody).toContain("step: 'searching_offers'");
  });

  it('#171 retries up to MAX_DEPLOY_RETRIES times', () => {
    expect(deploySource).toContain('export const MAX_DEPLOY_RETRIES = 2');
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnEnd = deploySource.indexOf('\n// ── GPU Tier', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('attempt <= MAX_DEPLOY_RETRIES');
  });

  it('#172 checks deployCancelled before each attempt', () => {
    const fnStart = deploySource.indexOf('for (let attempt = 0; attempt <= MAX_DEPLOY_RETRIES');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('if (deployCancelled) return');
  });

  it('#173 delays 5s between retries', () => {
    const fnStart = deploySource.indexOf('for (let attempt = 0; attempt <= MAX_DEPLOY_RETRIES');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain("setTimeout(r, 5_000)");
  });

  it('#174 cleans up cancelled instance immediately after creation', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnEnd = deploySource.indexOf('\n// ── GPU Tier', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    // After createInstance, if deployCancelled, deletes the instance
    expect(fnBody).toContain('if (deployCancelled)');
    expect(fnBody).toContain('deleteInstance(instance.instanceId');
  });

  it('#175 transitions to creating → booting → ready on success', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnEnd = deploySource.indexOf('\n// ── GPU Tier', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain("status: 'creating'");
    expect(fnBody).toContain("status: 'booting'");
    expect(fnBody).toContain("status: 'ready'");
  });

  it('#176 sets gpuHealthy and lastRequestTime on successful deploy', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnEnd = deploySource.indexOf('\n// ── GPU Tier', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('setGpuHealthy(true)');
    expect(fnBody).toContain('setLastRequestTime(Date.now())');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #177-#182: Deploy Loop — Error Handling
// ──────────────────────────────────────────────────────────────────────────────

describe('startDeployLoop — error handling', () => {
  it('#177 detects billing errors as non-retryable', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnEnd = deploySource.indexOf('\n// ── GPU Tier', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain("isBilling");
    expect(fnBody).toContain("'balance'");
    expect(fnBody).toContain("'funds'");
    expect(fnBody).toContain("'insufficient'");
  });

  it('#178 detects auth errors as non-retryable', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnEnd = deploySource.indexOf('\n// ── GPU Tier', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain("isAuth");
    expect(fnBody).toContain("'authentication'");
    expect(fnBody).toContain("'unauthorized'");
  });

  it('#179 detects no-offers as non-retryable', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnEnd = deploySource.indexOf('\n// ── GPU Tier', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain("isNoOffers");
    expect(fnBody).toContain("'no gpus available'");
    expect(fnBody).toContain("'0 offers'");
  });

  it('#180 stops retrying on cleanup failure (orphan prevention)', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnEnd = deploySource.indexOf('\n// ── GPU Tier', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('Failed to clean up crashed instance');
    expect(fnBody).toContain('return; // Stop deploy');
  });

  it('#181 fetches remote logs before cleaning up failed instance', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnEnd = deploySource.indexOf('\n// ── GPU Tier', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('fetchGpuLogs');
    expect(fnBody).toContain('Remote GPU Logs');
  });

  it('#182 sets error state when max retries exhausted', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnEnd = deploySource.indexOf('\n// ── GPU Tier', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('max retries exceeded');
    expect(fnBody).toContain('deploymentSM.markError');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #183-#189: Health Monitoring — scheduleNextMonitorProbe
// ──────────────────────────────────────────────────────────────────────────────

describe('health monitoring', () => {
  it('#183 startGpuMonitoring resets consecutive failures', () => {
    const fnStart = deploySource.indexOf('export function startGpuMonitoring');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('monitorConsecFails = 0');
  });

  it('#184 startGpuMonitoring resets lastModelRequestTime to now', () => {
    const fnStart = deploySource.indexOf('export function startGpuMonitoring');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('setLastModelRequestTime(Date.now())');
  });

  it('#185 scheduleNextMonitorProbe reschedules in finally block', () => {
    const fnStart = deploySource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    const finallyIdx = fnBody.indexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(0);
    const finallyBlock = fnBody.slice(finallyIdx, finallyIdx + 200);
    expect(finallyBlock).toContain('monitorRunning = false');
    expect(finallyBlock).toContain('scheduleNextMonitorProbe');
  });

  it('#186 marks unhealthy only after 2+ consecutive failures', () => {
    const fnStart = deploySource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    expect(fnBody).toContain('monitorConsecFails >= 2');
    expect(fnBody).toContain('markGpuUnhealthy');
  });

  it('#187 exponential backoff on consecutive health failures', () => {
    const fnStart = deploySource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    expect(fnBody).toContain('monitorDelayMs * 2');
    expect(fnBody).toContain('120_000');
  });

  it('#188 attempts auto-restart after 5 consecutive failures', () => {
    const fnStart = deploySource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    expect(fnBody).toContain('monitorConsecFails === 5');
    expect(fnBody).toContain('Auto-restart attempt');
    expect(fnBody).toContain('restartProvider.startInstance');
  });

  it('#189 records host crash in reputation at 5 consecutive failures', () => {
    const fnStart = deploySource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    expect(fnBody).toContain('recordHostCrash');
    expect(fnBody).toContain('monitorConsecFails === 5');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #190-#196: Idle Watchdog — auto-stop, auto-destroy
// ──────────────────────────────────────────────────────────────────────────────

describe('idle watchdog', () => {
  it('#190 IDLE_TIMEOUT_MS defaults to 15 minutes', () => {
    expect(deploySource).toContain('IDLE_TIMEOUT_MS = 15 * 60_000');
  });

  it('#191 IDLE_DESTROY_MS defaults to 2 hours', () => {
    expect(deploySource).toContain('IDLE_DESTROY_MS = 2 * 60 * 60_000');
  });

  it('#192 idle check uses lastModelRequestTime (not lastRequestTime)', () => {
    const fnStart = deploySource.indexOf('export function scheduleNextMonitorProbe');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 20000);
    expect(fnBody).toContain('lastModelRequestTime');
    expect(fnBody).toContain('Idle check');
  });

  it('#193 auto-stop calls autoStopGpu (not terminate) on idle', () => {
    const fnStart = deploySource.indexOf('Idle check');
    const fnBody = deploySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('autoStopGpu');
    expect(fnBody).toContain('auto-stopping (pausing)');
  });

  it('#194 warns at 75% of idle timeout before stopping', () => {
    const fnStart = deploySource.indexOf('Warn at 75% of idle');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('IDLE_TIMEOUT_MS * 0.75');
    expect(fnBody).toContain('idleWarned');
    expect(fnBody).toContain('Idle warning');
  });

  it('#195 autoStopGpu transitions to stopped state for resume', () => {
    const fnStart = deploySource.indexOf('export async function autoStopGpu');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('client.stopInstance');
    // After stop, transitions to 'stopped' state with podId preserved via setDeployState
    expect(fnBody).toContain("status: 'stopped'");
    expect(fnBody).toContain('deploymentSM.markStopped(');
  });

  it('#196 autoStopGpu schedules auto-destroy after IDLE_DESTROY_MS', () => {
    const fnStart = deploySource.indexOf('export async function autoStopGpu');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('scheduleAutoDestroy(IDLE_DESTROY_MS)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #197-#203: Race Deploy — startDeployRace
// ──────────────────────────────────────────────────────────────────────────────

describe('race deploy — startDeployRace', () => {
  it('#197 startDeployRace is an exported async function', () => {
    expect(deploySource).toContain('export async function startDeployRace');
  });

  it('#198 caps raceCount at 10', () => {
    const fnStart = deploySource.indexOf('export async function startDeployRace');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('Math.min(raceCount, 10)');
  });

  it('#199 creates all instances in parallel with Promise.allSettled', () => {
    const fnStart = deploySource.indexOf('export async function startDeployRace');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('Promise.allSettled(slots.map');
  });

  it('#200 registers race candidates in activeRaceInstanceIds', () => {
    const fnStart = deploySource.indexOf('export async function startDeployRace');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('activeRaceInstanceIds.add(c.instanceId)');
  });

  it('#201 winner aborts all other slots via AbortController', () => {
    const fnStart = deploySource.indexOf('export async function startDeployRace');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('raceAbort.abort()');
    expect(fnBody).toContain('AbortController');
  });

  it('#202 losers are terminated with wasted cost logging', () => {
    const fnStart = deploySource.indexOf('export async function startDeployRace');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('wastedUsd');
    expect(fnBody).toContain('deleteInstance');
  });

  it('#203 wraps Promise.all in try/finally for guaranteed cleanup', () => {
    const fnStart = deploySource.indexOf('export async function startDeployRace');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
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
    expect(deploySource).toContain("export const POD_NAME_PREFIX = 'parle-autoscale-'");
  });

  it('#205 cleanupAllPods filters by prefix and non-EXITED status', () => {
    const fnStart = deploySource.indexOf('export async function cleanupAllPods');
    const fnBody = deploySource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('startsWith(POD_NAME_PREFIX)');
    expect(fnBody).toContain("inst.status !== 'EXITED'");
  });

  it('#206 sweepOrphanInstances excludes tracked pods and race candidates', () => {
    const fnStart = deploySource.indexOf('export async function sweepOrphanInstances');
    const fnBody = deploySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('tracked.add(deployState.podId)');
    expect(fnBody).toContain('standbyDeployState.podId');
    expect(fnBody).toContain('activeRaceInstanceIds');
    expect(fnBody).toContain('tracked.add(id)');
  });

  it('#207 startOrphanSweep guards against double-scheduling', () => {
    const fnStart = deploySource.indexOf('export function startOrphanSweep');
    const fnBody = deploySource.slice(fnStart, fnStart + 400);
    expect(fnBody).toContain('orphanSweepInitialTimer');
    expect(fnBody).toContain('orphanSweepTimer');
    expect(fnBody).toContain('return');
  });

  it('#208 stopOrphanSweep clears both initial and periodic timers', () => {
    const fnStart = deploySource.indexOf('export function stopOrphanSweep');
    const fnBody = deploySource.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('clearTimeout(orphanSweepInitialTimer)');
    expect(fnBody).toContain('clearInterval(orphanSweepTimer)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #209-#213: Budget Enforcement
// ──────────────────────────────────────────────────────────────────────────────

describe('budget enforcement', () => {
  it('#209 uses actual elapsed time for budget calculation (not assumed interval)', () => {
    const budgetSection = deploySource.slice(
      deploySource.indexOf('Budget tracking: accumulate'),
      deploySource.indexOf('Budget tracking: accumulate') + 500,
    );
    expect(budgetSection).toContain('lastBudgetCalcTime');
    expect(budgetSection).toContain('actualElapsedMs');
    expect(budgetSection).not.toContain('costPerHr * (monitorDelayMs /');
  });

  it('#210 daily reset compares date strings', () => {
    const budgetSection = deploySource.slice(
      deploySource.indexOf('Budget tracking: accumulate'),
      deploySource.indexOf('Budget tracking: accumulate') + 500,
    );
    expect(budgetSection).toContain('dailySpendResetDate');
    expect(budgetSection).toContain('setDailyGpuSpendUsd(0)');
  });

  it('#211 hard budget auto-terminates GPU at 100%', () => {
    // pct >= 1.0 is checked just before the HARD BUDGET comment
    const budgetStart = deploySource.indexOf('HARD BUDGET');
    const budgetSection = deploySource.slice(budgetStart - 100, budgetStart + 500);
    expect(budgetSection).toContain('pct >= 1.0');
    expect(budgetSection).toContain('autoTerminateGpu');
  });

  it('#212 soft budget warns at 80%', () => {
    // pct >= 0.8 is checked just before the SOFT BUDGET comment
    const budgetStart = deploySource.indexOf('SOFT BUDGET');
    const budgetSection = deploySource.slice(budgetStart - 100, budgetStart + 300);
    expect(budgetSection).toContain('pct >= 0.8');
    expect(budgetSection).toContain('budgetSoftWarned');
  });

  it('#213 DAILY_BUDGET_USD defaults from env or 0 (no limit)', () => {
    expect(stateSource).toContain('DAILY_BUDGET_USD');
    expect(stateSource).toContain("process.env.DAILY_BUDGET_USD");
    // 0 means no limit
    const idx = stateSource.indexOf('export const DAILY_BUDGET_USD');
    const line = stateSource.slice(idx, stateSource.indexOf('\n', idx));
    expect(line).toContain('0');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #214-#218: Cooldown Tracker
// ──────────────────────────────────────────────────────────────────────────────

describe('cooldown tracker', () => {
  it('#214 cooldownTracker is exported and loaded from file', () => {
    expect(deploySource).toContain('export const cooldownTracker');
    expect(deploySource).toContain('cooldownTracker.loadFromFile');
    expect(deploySource).toContain('cooldowns.json');
  });

  it('#215 startDeployWithTiers filters out providers in cooldown', () => {
    // Cooldown filtering logic exists in the function
    expect(deploySource).toContain('cooldownTracker.isCoolingDown');
    expect(deploySource).toContain('cooldown_skip');
  });

  it('#216 bypasses cooldown when all providers are cooling down', () => {
    // Should have logic to force try when all in cooldown
    expect(deploySource).toContain('All providers in cooldown');
  });

  it('#217 records success to clear cooldown on successful deploy', () => {
    const fnStart = deploySource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('cooldownTracker.recordSuccess');
    expect(fnBody).toContain('cooldown_cleared');
  });

  it('#218 records failure and billing failure separately', () => {
    const fnStart = deploySource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('cooldownTracker.recordFailure');
    expect(fnBody).toContain('cooldownTracker.recordBillingFailure');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #219-#220: Build Tiers, startDeployWithTiers Advanced
// ──────────────────────────────────────────────────────────────────────────────

describe('buildGpuTiers', () => {
  it('#219 respects PROVIDER_CHAIN ordering', () => {
    const fnStart = deploySource.indexOf('export function buildGpuTiers');
    const fnEnd = deploySource.indexOf('\n/**', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('PROVIDER_CHAIN');
    expect(fnBody).toContain("'runpod'");
    expect(fnBody).toContain("'vast'");
    expect(fnBody).toContain("'tensordock'");
    expect(fnBody).toContain("'modal'");
  });

  it('#220a adds providers not in chain as fallback', () => {
    const fnStart = deploySource.indexOf('export function buildGpuTiers');
    const fnEnd = deploySource.indexOf('\n/**', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('Add any providers not yet added');
    expect(fnBody).toContain('!added.has(name)');
  });
});

describe('startDeployWithTiers — advanced', () => {
  it('#220b probes all providers in parallel before committing', () => {
    // Provider probing exists using Promise.allSettled or similar
    expect(deploySource).toMatch(/Promise\.(allSettled|all)/);
    expect(deploySource).toContain('listOffers');
  });

  it('#220c reorders tiers by availability and response time', () => {
    // Sorting/reordering logic exists
    expect(deploySource).toContain('.sort(');
  });

  it('#220d sets fallback alert when tier fails and next available', () => {
    const fnStart = deploySource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('fallback');
    expect(fnBody).toContain('alertMsg');
    expect(fnBody).toContain('alert:');
  });

  it('#220e sets final error state when all tiers exhausted', () => {
    const fnStart = deploySource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('All');
    expect(fnBody).toContain('provider(s) failed');
    expect(fnBody).toContain('deploymentSM.markError');
  });

  it('#220f detects silent failures (deploy returned to idle without error)', () => {
    const fnStart = deploySource.indexOf('export async function startDeployWithTiers');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 15000);
    expect(fnBody).toContain('silent failure');
    expect(fnBody).toContain("deployState.status === 'idle'");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Additional structural tests for key deploy functions
// ──────────────────────────────────────────────────────────────────────────────

describe('autoTerminateGpu', () => {
  it('clears auto-destroy timer first', () => {
    const fnStart = deploySource.indexOf('export async function autoTerminateGpu');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('clearAutoDestroyTimer');
  });

  it('resets deploy state and stops monitoring', () => {
    const fnStart = deploySource.indexOf('export async function autoTerminateGpu');
    const fnBody = deploySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('stopGpuMonitoring');
    expect(fnBody).toContain('resetDeployState');
  });

  it('closes all SSH tunnels', () => {
    const fnStart = deploySource.indexOf('export async function autoTerminateGpu');
    const fnBody = deploySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('closeAllTunnels');
  });

  it('handles all provider types (modal, tensordock, vast, runpod)', () => {
    const fnStart = deploySource.indexOf('export async function autoTerminateGpu');
    const fnEnd = deploySource.indexOf('\n// ──', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain("'modal'");
    expect(fnBody).toContain("'tensordock'");
    expect(fnBody).toContain("'vast'");
    expect(fnBody).toContain('cleanupAllPods');
  });
});

describe('stopGpuMonitoring', () => {
  it('clears interval and resets health state', () => {
    const fnStart = deploySource.indexOf('export function stopGpuMonitoring');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('clearTimeout');
    expect(fnBody).toContain('setMonitorInterval(null)');
    expect(fnBody).toContain('monitorConsecFails = 0');
    expect(fnBody).toContain('setGpuHealthy(false)');
  });
});

describe('fetchGpuLogs', () => {
  it('is an exported async function', () => {
    expect(deploySource).toContain('export async function fetchGpuLogs');
  });

  it('tries HTTP /logs endpoint first', () => {
    const fnStart = deploySource.indexOf('export async function fetchGpuLogs');
    const fnBody = deploySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('/logs');
    expect(fnBody).toContain('HTTP /logs');
  });

  it('falls back to SSH for log retrieval', () => {
    const fnStart = deploySource.indexOf('export async function fetchGpuLogs');
    const fnEnd = deploySource.indexOf('\nexport ', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('ssh');
    expect(fnBody).toContain('execSync');
    expect(fnBody).toContain('StrictHostKeyChecking=no');
  });
});

describe('getVerifiedGpuTypes', () => {
  it('is an exported async function', () => {
    expect(deploySource).toContain('export async function getVerifiedGpuTypes');
  });

  it('resolves Blackwell variants for benchmark lookup', () => {
    const fnStart = deploySource.indexOf('export async function getVerifiedGpuTypes');
    const fnBody = deploySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('BLACKWELL_TO_STANDARD');
    expect(fnBody).toContain('STANDARD_TO_BLACKWELL');
  });

  it('falls back to hardcoded priority list when no benchmarks exist', () => {
    const fnStart = deploySource.indexOf('export async function getVerifiedGpuTypes');
    const fnEnd = deploySource.indexOf('\n/**', fnStart + 50);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('getGpuPriorityList');
    expect(fnBody).toContain('DEFAULT_GPU_PRIORITY');
  });
});

describe('validateGpuTypesFromCache', () => {
  it('is an exported async function', () => {
    expect(deploySource).toContain('export async function validateGpuTypesFromCache');
  });

  it('normalizes GPU names for comparison', () => {
    const fnStart = deploySource.indexOf('export async function validateGpuTypesFromCache');
    const fnBody = deploySource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('toLowerCase');
    expect(fnBody).toContain('nvidia');
    expect(fnBody).toContain('withNvidia');
  });

  it('returns null for empty gpuTypes (skip validation)', () => {
    const fnStart = deploySource.indexOf('export async function validateGpuTypesFromCache');
    const fnBody = deploySource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('gpuTypes.length === 0');
    expect(fnBody).toContain('return null');
  });
});

describe('autoSelectCheapestGpu', () => {
  it('is an exported async function', () => {
    expect(deploySource).toContain('export async function autoSelectCheapestGpu');
  });

  it('filters by minimum VRAM', () => {
    const fnStart = deploySource.indexOf('export async function autoSelectCheapestGpu');
    const fnEnd = deploySource.indexOf('\n// ──', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('minVram');
    expect(fnBody).toContain('o.vram >= minVram');
  });

  it('filters by internet speed (MIN_INET_MBPS = 500)', () => {
    const fnStart = deploySource.indexOf('export async function autoSelectCheapestGpu');
    const fnEnd = deploySource.indexOf('\n// ──', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('MIN_INET_MBPS');
    expect(fnBody).toContain('500');
  });

  it('blacklists hosts with 3+ crashes in 7 days', () => {
    const fnStart = deploySource.indexOf('export async function autoSelectCheapestGpu');
    const fnEnd = deploySource.indexOf('\n// ──', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('blacklistedHosts');
    expect(fnBody).toContain('crashCount: { gte: 3 }');
  });

  it('skips hosts with reputation score below 0.3', () => {
    const fnStart = deploySource.indexOf('export async function autoSelectCheapestGpu');
    const fnEnd = deploySource.indexOf('\n// ──', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('lowRepHosts');
    expect(fnBody).toContain('reputationScore: { lt: 0.3 }');
  });

  it('supports price, latency, and balanced sort modes', () => {
    const fnStart = deploySource.indexOf('export async function autoSelectCheapestGpu');
    const fnEnd = deploySource.indexOf('\n// ──', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain("sortBy === 'price'");
    expect(fnBody).toContain("sortBy === 'latency'");
    // balanced is the default, uses qualityScore
    expect(fnBody).toContain('qualityScore');
    expect(fnBody).toContain('effectiveA');
  });

  it('deduplicates GPU types in result', () => {
    const fnStart = deploySource.indexOf('export async function autoSelectCheapestGpu');
    const fnEnd = deploySource.indexOf('\n// ──', fnStart + 100);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 10000);
    expect(fnBody).toContain('uniqueTypes');
    expect(fnBody).toContain('seen.has(key)');
    expect(fnBody).toContain('maxResults');
  });
});

describe('refreshGpuTypeCache', () => {
  it('is an exported async function', () => {
    expect(deploySource).toContain('export async function refreshGpuTypeCache');
  });

  it('writes all upserts in a single transaction', () => {
    const fnStart = deploySource.indexOf('export async function refreshGpuTypeCache');
    const fnBody = deploySource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('prisma.$transaction');
    expect(fnBody).toContain('gpuTypeCache.upsert');
  });

  it('has 15s timeout per provider and handles failures gracefully', () => {
    const fnStart = deploySource.indexOf('export async function refreshGpuTypeCache');
    const fnBody = deploySource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain('15_000');
    expect(fnBody).toContain('listOffers timed out');
    expect(fnBody).toContain('Promise.allSettled');
  });
});

describe('GPU type cache refresh timer', () => {
  it('refreshes every 30 minutes', () => {
    expect(deploySource).toContain('GPU_TYPE_CACHE_TTL_MS = 30 * 60_000');
  });

  it('startGpuTypeCacheRefresh is an exported function', () => {
    expect(deploySource).toContain('export function startGpuTypeCacheRefresh');
  });
});

describe('exported constants', () => {
  it('HEALTH_POLL_INTERVAL_MS is 10 seconds', () => {
    expect(deploySource).toContain('HEALTH_POLL_INTERVAL_MS = 10_000');
  });

  it('DEPLOY_TIMEOUT_MS is 45 minutes', () => {
    expect(deploySource).toContain('DEPLOY_TIMEOUT_MS = 45 * 60_000');
  });

  it('GPU_MONITOR_INTERVAL_MS is 30 seconds', () => {
    expect(deploySource).toContain('GPU_MONITOR_INTERVAL_MS = 30_000');
  });

  it('IDLE_TIMEOUT_MS and IDLE_DESTROY_MS are configurable via setters', () => {
    expect(deploySource).toContain('export function setIdleTimeoutMs');
    expect(deploySource).toContain('export function setIdleDestroyMs');
  });
});

describe('TensorDock discover & resume fast path', () => {
  it('attempts to discover and resume stopped instances on TensorDock', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnBody = deploySource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain("providerName === 'tensordock'");
    expect(fnBody).toContain('discoverInstance');
    expect(fnBody).toContain('Resuming stopped TensorDock');
  });

  it('falls through to create new instance if discover/resume fails', () => {
    const fnStart = deploySource.indexOf('export async function startDeployLoop');
    const fnBody = deploySource.slice(fnStart, fnStart + 7000);
    expect(fnBody).toContain('will create new instance');
    expect(fnBody).toContain('creating new');
  });
});

describe('deploy failure categorization', () => {
  it('categorizes billing, docker_image, cancelled, timeout, crashed, api_error, network, unknown', () => {
    const fnStart = deploySource.indexOf('function categorizeDeployFailure');
    const fnEnd = deploySource.indexOf('\n// ── Hedged', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
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
    expect(deploySource).toContain('P95_DEMOTION_CONSECUTIVE_VIOLATIONS = 3');
  });

  it('resets violation counter when P95 is within threshold', () => {
    const fnStart = deploySource.indexOf('P95 demotion check');
    const fnBody = deploySource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('p95ViolationCount[stage] = 0');
  });

  it('triggers re-benchmark after demotion', () => {
    const fnStart = deploySource.indexOf('P95 demotion check');
    const fnBody = deploySource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('_startReadinessCheck');
    expect(fnBody).toContain('setGpuReadyForProduction(false)');
  });
});

describe('latency trend prediction', () => {
  it('detects 20%+ latency increase across stages', () => {
    const fnStart = deploySource.indexOf('Latency trend prediction');
    const fnBody = deploySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('trend > 0.2');
    expect(fnBody).toContain('recentAvg');
    expect(fnBody).toContain('olderAvg');
  });

  it('broadcasts latency-trend event via WebSocket', () => {
    const fnStart = deploySource.indexOf('Latency trend prediction');
    const fnBody = deploySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain("type: 'gpu:latency-trend'");
  });
});

describe('adaptive monitor frequency', () => {
  it('slows down polling when idle > 1 minute', () => {
    const fnStart = deploySource.indexOf('Adaptive monitor frequency');
    const fnBody = deploySource.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('60_000');
    expect(fnBody).toContain('monitorDelayMs');
  });
});

describe('tryRecoverActiveDeploy', () => {
  it('is an exported async function', () => {
    expect(deploySource).toContain('export async function tryRecoverActiveDeploy');
  });

  it('loads persisted deploy from disk', () => {
    const fnStart = deploySource.indexOf('export async function tryRecoverActiveDeploy');
    const fnBody = deploySource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('loadPersistedDeploy');
  });

  it('probes health before restoring state', () => {
    const fnStart = deploySource.indexOf('export async function tryRecoverActiveDeploy');
    const fnBody = deploySource.slice(fnStart, fnStart + 1500);
    expect(fnBody).toContain('probeGpuHealth');
    expect(fnBody).toContain('not healthy');
    expect(fnBody).toContain('clearPersistedDeploy');
  });
});

describe('startAutoRecoveryDeploy', () => {
  it('is an exported async function', () => {
    expect(deploySource).toContain('export async function startAutoRecoveryDeploy');
  });
});

describe('cleanupProviderInstances delegates', () => {
  it('cleanupVastInstances delegates to cleanupProviderInstances', () => {
    expect(deploySource).toContain('export const cleanupVastInstances');
    expect(deploySource).toContain("cleanupProviderInstances(vast, { apiKey }");
  });

  it('cleanupTensordockInstances delegates to cleanupProviderInstances', () => {
    expect(deploySource).toContain('export const cleanupTensordockInstances');
    expect(deploySource).toContain("cleanupProviderInstances(tensordock");
  });

  it('cleanupModalApps delegates to cleanupProviderInstances', () => {
    expect(deploySource).toContain('export const cleanupModalApps');
    expect(deploySource).toContain("cleanupProviderInstances(modal");
  });
});

describe('providerClients export', () => {
  it('maps all four provider names to client instances', () => {
    expect(deploySource).toContain("export const providerClients: Record<ProviderName, GpuProviderClient>");
    expect(deploySource).toContain('runpod, vast, tensordock, modal');
  });
});
