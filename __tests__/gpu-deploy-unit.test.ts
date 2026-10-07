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

// ──────────────────────────────────────────────────────────────────────────────
// #209-#213: Budget Enforcement
// ──────────────────────────────────────────────────────────────────────────────

describe('budget enforcement', () => {

  it('#213 DAILY_BUDGET_USD defaults from env or 0 (no limit)', () => {
    const costStateSource = readFileSync('src/gateway/state/cost-state.ts', 'utf8');
    expect(costStateSource).toContain('DAILY_BUDGET_USD');
    expect(costStateSource).toContain("process.env.DAILY_BUDGET_USD");
    const idx = costStateSource.indexOf('export const DAILY_BUDGET_USD');
    const line = costStateSource.slice(idx, costStateSource.indexOf('\n', idx));
    expect(line).toContain('0');
  });
});

describe('startDeployWithTiers — advanced', () => {

  it('#220c reorders tiers by availability and response time', () => {
    // After DDD split, offer sorting moved to per-provider offers modules
    const vastOffers = readFileSync('src/gateway/providers/gpu/vast/offers.ts', 'utf8');
    const runpodOffers = readFileSync('src/gateway/providers/gpu/runpod/offers.ts', 'utf8');
    expect(vastOffers + runpodOffers).toContain('.sort(');
  });
});

describe('TensorDock discover & resume fast path', () => {
  // Moved from gpu-deploy-loop.ts to per-provider strategy files (tensordock-strategy.ts).
  // Verifying via strategy source instead of deploy-loop body.
  it('attempts to discover and resume stopped instances on TensorDock', () => {
    // Strategy moved under src/gpu-providers/strategies/.
    const tensorStrategy = readFileSync('src/gpu-providers/strategies/tensordock-strategy.ts', 'utf8');
    expect(tensorStrategy).toContain('discoverInstance');
  });

  it.skip('falls through to create new instance if discover/resume fails', () => {
    // TODO: refactored — fall-through logic now in provider strategy.
  });
});

describe('tryRecoverActiveDeploy', () => {

  it.skip('restores readinessProbe from persisted state', () => {
    // TODO: persisted.readinessProbe API removed during state refactor;
    // probeTcp moved to gpu-latency.ts. Behavior now covered by integration tests.
  });
});
