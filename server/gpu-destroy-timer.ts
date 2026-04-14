// ── GPU Destroy Timer ────────────────────────────────────────────────────────
// Schedules deletion of a stopped pod after IDLE_DESTROY_MS if not resumed.

import { createLogger } from '../src/logger';
import { activeProvider, deployState } from './state';
import { broadcastWs } from './ws-state';

const log = createLogger('gpu-deploy');

/** Reason why a GPU instance was stopped or terminated. */
export type DeleteReason =
  | 'idle_timeout'
  | 'manual_stop'
  | 'manual_terminate'
  | 'health_failed'
  | 'budget_exceeded'
  | 'crash_recovery'
  | 'race_loser'
  | 'deploy_cancelled'
  | 'orphan_cleanup'
  | 'auto_destroy';

let destroyTimer: Timer | null = null;

export function scheduleAutoDestroy(delayMs: number) {
  clearAutoDestroyTimer();
  const provider = activeProvider;
  const podId = deployState.podId;
  log.log(`[gpu] Auto-destroy scheduled in ${Math.round(delayMs / 60_000)} min for ${provider} pod ${podId}`);
  destroyTimer = setTimeout(async () => {
    log.log(`[gpu] Auto-destroy triggered — deleting stopped pod ${podId} (${provider})`);
    broadcastWs({ type: 'gpu:idle', action: 'destroy', deployId: deployState.deployId, provider, podId });
    const { autoTerminateGpu } = await import('./gpu-terminate');
    await autoTerminateGpu('auto_destroy');
  }, delayMs) as unknown as Timer;
}

export function clearAutoDestroyTimer() {
  if (destroyTimer) { clearTimeout(destroyTimer as unknown as ReturnType<typeof setTimeout>); destroyTimer = null; }
}
