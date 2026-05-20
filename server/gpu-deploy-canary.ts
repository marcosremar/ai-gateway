// ── Canary Deployment Helper ────────────────────────────────────────────────
// Evaluates canary health every 60s and promotes/rollbacks based on error rate
// and latency thresholds.

import { createLogger } from '../src/logger';
import { createCanaryDeploy, type CanaryConfig } from '../src/canary';
import { deployState, setDeployState } from './state';

const log = createLogger('gpu-deploy');

/**
 * Start canary deployment cycle after a successful deploy.
 * Called from each deploy success path. Evaluates canary health every 60s
 * and promotes/rollbacks based on error rate and latency thresholds.
 */
export function startCanaryIfEnabled(
  deployConfig: { canary?: boolean; canaryInitialTraffic?: number; canaryMaxErrorRate?: number; canaryTrafficStep?: number },
  dockerImage: string,
  gpuType: string,
): void {
  const canaryEnabled = process.env.CANARY_DEPLOY === '1' || deployConfig.canary === true;
  if (!canaryEnabled) return;

  const canaryConfig: CanaryConfig = {
    currentVersion: `stable-${dockerImage}`,
    canaryVersion: `canary-${dockerImage}`,
    initialTrafficPercentage: deployConfig.canaryInitialTraffic || 5,
    maxErrorRate: deployConfig.canaryMaxErrorRate || 0.05,
    trafficStep: deployConfig.canaryTrafficStep || 10,
  };

  const canary = createCanaryDeploy(canaryConfig);

  // Store canary controller in deploy state for monitoring
  // Clear any prior canary timer before installing a new one. Otherwise
  // every successful deploy with canary enabled spawned a fresh interval
  // while the previous interval kept firing forever (stale-closure
  // promote/rollback decisions + log spam).
  if (deployState.canaryEvalTimer) {
    try { clearInterval(deployState.canaryEvalTimer as ReturnType<typeof setInterval>); } catch { /* no-op */ }
  }
  setDeployState({ canary, canaryEvalTimer: null });

  log.log({ canaryConfig }, 'Canary deployment started');

  // Set up periodic evaluation
  const evalInterval = setInterval(async () => {
    const decision = canary.evaluate();
    if (decision.action === 'promote') {
      await canary.promote();
      log.log('Canary promoted to 100%');
      clearInterval(evalInterval);
      setDeployState({ canaryEvalTimer: null });
    } else if (decision.action === 'rollback') {
      await canary.rollback();
      log.error('Canary rolled back — errors exceeded threshold');
      clearInterval(evalInterval);
      setDeployState({ canaryEvalTimer: null });
    }
  }, 60_000); // Evaluate every minute

  setDeployState({ canaryEvalTimer: evalInterval });
}

/**
 * Clear canary evaluation timer and reset canary state.
 */
export function stopCanary(): void {
  if (deployState.canaryEvalTimer) {
    clearInterval(deployState.canaryEvalTimer as ReturnType<typeof setInterval>);
    setDeployState({ canaryEvalTimer: null });
  }
}
