/**
 * Lightning AI studio lifecycle handlers + idle session tracker.
 *
 * Idle policy:
 *   - POST /v1/lightning/session/start  — mark SSH session open
 *   - POST /v1/lightning/session/end    — mark SSH session closed; start idle countdown
 *   - After IDLE_TIMEOUT_MS (15 min) with no active sessions → auto-stop studio
 *
 * Used by `ai-gateway lightning ssh` to notify server when SSH starts/ends.
 */

import { LightningAIClient, loadLightningConfig } from '../src/cpu-providers/lightning-client';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

let activeSessions = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let client: LightningAIClient | null = null;

function getClient(): LightningAIClient {
  if (!client) {
    const cfg = loadLightningConfig();
    if (!cfg) throw new Error('Lightning AI not configured — set LIGHTNING_API_KEY, LIGHTNING_PROJECT_ID, LIGHTNING_CLOUDSPACE_ID, LIGHTNING_SSH_USER');
    client = new LightningAIClient(cfg);
  }
  return client;
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleStop() {
  clearIdleTimer();
  idleTimer = setTimeout(async () => {
    if (activeSessions > 0) return; // session opened before timer fired
    try {
      const c = getClient();
      const status = await c.getStatus();
      if (status.phase === 'CLOUD_SPACE_INSTANCE_STATE_RUNNING') {
        await c.stop();
        console.log('[lightning] idle timeout — studio stopped');
      }
    } catch (err: any) {
      console.error('[lightning] idle stop error:', err.message);
    }
  }, IDLE_TIMEOUT_MS);
}

export async function handleLightningStatus(_req: Request): Promise<Response> {
  try {
    const status = await getClient().getStatus();
    return Response.json({ ...status, activeSessions });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function handleLightningStart(_req: Request): Promise<Response> {
  try {
    const c = getClient();
    await c.start();
    const status = await c.waitForRunning();
    return Response.json({ ok: true, ...status });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function handleLightningStop(_req: Request): Promise<Response> {
  try {
    clearIdleTimer();
    await getClient().stop();
    return Response.json({ ok: true });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function handleLightningSessionStart(_req: Request): Promise<Response> {
  activeSessions++;
  clearIdleTimer(); // cancel any pending stop
  console.log(`[lightning] session opened (active=${activeSessions})`);
  return Response.json({ ok: true, activeSessions });
}

export async function handleLightningSessionEnd(_req: Request): Promise<Response> {
  activeSessions = Math.max(0, activeSessions - 1);
  console.log(`[lightning] session closed (active=${activeSessions})`);
  if (activeSessions === 0) {
    scheduleIdleStop();
    console.log(`[lightning] idle timer set — stopping in ${IDLE_TIMEOUT_MS / 60000} min if no new sessions`);
  }
  return Response.json({ ok: true, activeSessions, idleTimeoutMs: IDLE_TIMEOUT_MS });
}
