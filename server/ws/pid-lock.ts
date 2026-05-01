// ── PID lock + orphan deploy detection ──────────────────────────────────────
// Guards against two ws-server instances stomping on the same ~/.babelcast/
// state, and logs a clear warning when a previous run died mid-deploy so the
// operator knows to check providers for orphan pods.
//
// Lifecycle:
//   1. startWsServer() calls acquirePidLock() — exits(1) if another live
//      ws-server already owns the lock, overwrites if lock is stale.
//   2. Same startup calls detectOrphanDeployOnBoot() — if the persisted
//      active_deploy.json shows a non-ready in-flight status, clears it and
//      emits a warning pointing the operator at `ai-gateway gpu list`.
//   3. SIGINT/SIGTERM handlers release the lock on graceful shutdown.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/logger';

const log = createLogger('pid-lock');

const BABELCAST_DIR = join(homedir(), '.babelcast');
const PID_FILE = join(BABELCAST_DIR, 'ws-server.pid');
const ACTIVE_DEPLOY_FILE = join(BABELCAST_DIR, 'active_deploy.json');

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 does not kill — it only checks whether the process exists
    // and is signalable by the current user.
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM = exists but not owned by us → still counts as alive for our purposes
    return code === 'EPERM';
  }
}

/** Acquire the per-user ws-server PID lock. Exits the process with a clear
 * message if another ws-server is already running.
 *
 * When running under `bun --watch` (or any hot-reload runner that sends
 * SIGTERM to the old process and immediately spawns a new one) there is a
 * short race window where the old process hasn't yet deleted the PID file
 * when the new process starts.  We retry up to 10 times × 50 ms = 500 ms
 * before giving up, which is well within the time bun needs to finish its
 * SIGTERM → process.exit round-trip. */
export function acquirePidLock(): void {
  try {
    mkdirSync(BABELCAST_DIR, { recursive: true });
  } catch (err) {
    log.warn(`Could not create ${BABELCAST_DIR}: ${err instanceof Error ? err.message : err}`);
  }

  const MAX_RETRIES = 10;
  const RETRY_MS = 50;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (!existsSync(PID_FILE)) break; // no contention — proceed to write

    try {
      const raw = readFileSync(PID_FILE, 'utf-8').trim();
      const existingPid = Number(raw);

      if (!isProcessAlive(existingPid) || existingPid === process.pid) {
        log.warn(`Stale PID lock found (pid=${raw}) — previous instance did not clean up; taking over.`);
        break; // safe to overwrite
      }

      if (attempt < MAX_RETRIES) {
        // Hot-reload race: old process is still shutting down. Wait a bit.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_MS);
        continue;
      }

      // Exhausted retries — real second instance.
      log.error('='.repeat(70));
      log.error(`Another ai-gateway ws-server is already running (pid=${existingPid}).`);
      log.error(`Lock file: ${PID_FILE}`);
      log.error('Refusing to start a second instance — state files are not safe for concurrent writes.');
      log.error('Stop the other instance first, or remove the lock file if you are sure it is stale.');
      log.error('='.repeat(70));
      process.exit(1);
    } catch (err) {
      log.warn(`Could not read existing PID file, overwriting: ${err instanceof Error ? err.message : err}`);
      break;
    }
  }

  try {
    const tmp = PID_FILE + '.tmp';
    writeFileSync(tmp, String(process.pid));
    renameSync(tmp, PID_FILE);
    log.log(`[startup] PID lock acquired (pid=${process.pid}) at ${PID_FILE}`);
  } catch (err) {
    log.warn(`Could not write PID lock: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const release = () => releasePidLock();
  process.once('SIGINT', () => { release(); process.exit(130); });
  process.once('SIGTERM', () => { release(); process.exit(143); });
  process.once('exit', release);
}

/** Release the PID lock if we own it. Idempotent. */
export function releasePidLock(): void {
  try {
    if (!existsSync(PID_FILE)) return;
    const raw = readFileSync(PID_FILE, 'utf-8').trim();
    if (Number(raw) === process.pid) {
      unlinkSync(PID_FILE);
    }
  } catch {
    // best-effort
  }
}

/** Inspect ~/.babelcast/active_deploy.json. If it shows an in-flight status
 * (booting/installing) the previous ws-server died mid-deploy; clear the file
 * and warn so the operator can sweep providers for orphan pods. A 'ready'
 * entry is left alone — tryRecoverActiveDeploy will health-check and reconnect. */
export function detectOrphanDeployOnBoot(): void {
  if (!existsSync(ACTIVE_DEPLOY_FILE)) return;
  try {
    const raw = readFileSync(ACTIVE_DEPLOY_FILE, 'utf-8');
    const data = JSON.parse(raw) as { status?: string; provider?: string; podId?: string; savedAt?: number };
    const status = data.status || '';
    // status field is not always persisted (only set on some writes) — we also
    // treat a very old record as orphan.
    const ageMs = data.savedAt ? Date.now() - data.savedAt : 0;
    const inFlight = status === 'booting' || status === 'installing' || status === 'creating';
    const veryOld = ageMs > 30 * 60 * 1000; // 30 min
    if (inFlight || veryOld) {
      log.warn('='.repeat(70));
      log.warn(`[startup] Orphan deploy detected in active_deploy.json`);
      log.warn(`  provider=${data.provider || '?'} podId=${data.podId || '?'} status=${status || '?'} age=${Math.round(ageMs / 1000)}s`);
      log.warn(`  Previous ws-server likely died mid-deploy. Clearing local state.`);
      log.warn(`  Run 'ai-gateway gpu list' to check for orphan pods and terminate manually.`);
      log.warn('='.repeat(70));
      try { unlinkSync(ACTIVE_DEPLOY_FILE); } catch {}
    }
  } catch (err) {
    log.warn(`Could not inspect persisted deploy: ${err instanceof Error ? err.message : err}`);
  }
}
