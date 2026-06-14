// ── GPU Destroy Timer ────────────────────────────────────────────────────────
// Schedules deletion of a stopped pod after IDLE_DESTROY_MS if not resumed.
//
// PERSISTED across restarts: the destroy deadline is written to
// ~/.babelcast/destroy_timer.json. On boot, recoverPersistedDestroyTimer()
// re-schedules the timer (or fires immediately if the deadline already passed).
// Without this, a gateway restart orphaned every stopped pod forever,
// leaking storage costs on providers that bill stopped VMs (RunPod does).

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../src/logger';
import { activeProvider, deployState } from './state';
import { broadcastWs } from './ws-state';

const log = createLogger('gpu-deploy');
const DESTROY_TIMER_FILE = join(homedir(), '.babelcast', 'destroy_timer.json');

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

interface PersistedTimer {
  podId: string;
  provider: string;
  deadlineMs: number;   // absolute epoch ms — survives restart
}

let destroyTimer: Timer | null = null;

function persistDeadline(podId: string, provider: string, deadlineMs: number): void {
  try {
    writeFileSync(DESTROY_TIMER_FILE, JSON.stringify({ podId, provider, deadlineMs } satisfies PersistedTimer));
  } catch (err) {
    log.warn(`[gpu] destroy-timer persist failed: ${err instanceof Error ? err.message : err}`);
  }
}

function clearPersistedDeadline(): void {
  try { if (existsSync(DESTROY_TIMER_FILE)) unlinkSync(DESTROY_TIMER_FILE); }
  catch { /* best effort */ }
}

export function scheduleAutoDestroy(delayMs: number) {
  clearAutoDestroyTimer();
  const provider = activeProvider;
  const podId = deployState.podId;
  const deadlineMs = Date.now() + delayMs;
  log.log(`[gpu] Auto-destroy scheduled in ${Math.round(delayMs / 60_000)} min for ${provider} pod ${podId}`);
  persistDeadline(podId, provider, deadlineMs);
  destroyTimer = setTimeout(async () => {
    log.log(`[gpu] Auto-destroy triggered — deleting stopped pod ${podId} (${provider})`);
    broadcastWs({ type: 'gpu:idle', action: 'destroy', deployId: deployState.deployId, provider, podId });
    const { autoTerminateGpu } = await import('./gpu-terminate');
    await autoTerminateGpu('auto_destroy');
    clearPersistedDeadline();
  }, delayMs) as unknown as Timer;
  // unref so an otherwise-idle process is never kept alive purely by the
  // destroy countdown (the deadline is persisted and re-armed on next boot).
  (destroyTimer as unknown as { unref?: () => void }).unref?.();
}

export function clearAutoDestroyTimer() {
  if (destroyTimer) { clearTimeout(destroyTimer as unknown as ReturnType<typeof setTimeout>); destroyTimer = null; }
  clearPersistedDeadline();
}

/**
 * On boot: if there is a persisted deadline that still matches the active
 * stopped pod, re-arm the timer. If the deadline already passed, fire
 * termination immediately. Without this, restarts leak stopped pods forever.
 */
export async function recoverPersistedDestroyTimer(): Promise<void> {
  if (!existsSync(DESTROY_TIMER_FILE)) return;
  let parsed: PersistedTimer;
  try { parsed = JSON.parse(readFileSync(DESTROY_TIMER_FILE, 'utf-8')); }
  catch { clearPersistedDeadline(); return; }

  const stillActive = parsed.podId && deployState.podId === parsed.podId;
  if (!stillActive) {
    // Pod no longer tracked — the sweep will handle it. Just clean the file.
    log.warn(`[gpu] persisted destroy timer for ${parsed.podId} (${parsed.provider}) no longer matches active state — dropping`);
    clearPersistedDeadline();
    return;
  }

  const remaining = parsed.deadlineMs - Date.now();
  if (remaining <= 0) {
    log.log(`[gpu] persisted destroy deadline already passed — terminating pod ${parsed.podId} now`);
    const { autoTerminateGpu } = await import('./gpu-terminate');
    await autoTerminateGpu('auto_destroy');
    clearPersistedDeadline();
    return;
  }

  log.log(`[gpu] restoring destroy timer: pod ${parsed.podId} (${parsed.provider}) in ${Math.round(remaining / 60_000)} min`);
  destroyTimer = setTimeout(async () => {
    const { autoTerminateGpu } = await import('./gpu-terminate');
    await autoTerminateGpu('auto_destroy');
    clearPersistedDeadline();
  }, remaining) as unknown as Timer;
  (destroyTimer as unknown as { unref?: () => void }).unref?.();
}
