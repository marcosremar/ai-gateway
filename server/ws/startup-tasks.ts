// ── Startup tasks (run after WS + HTTP servers are listening) ────────────────
// Order matters: daily spend must load before any budget check, persisted
// config before GPU recovery, pod recovery before auto-boot.

import { createLogger } from '../../src/logger';

const log = createLogger('startup-tasks');

/** Optional Prisma DB init — silently skipped when DATABASE_URL is missing. */
export function initDatabase(): void {
  if (process.env.DATABASE_URL) {
    try {
      const { initPrisma } = require('../prisma-init');
      initPrisma().catch((e: any) => log.warn('DB init failed: %s', e?.message?.slice(0, 80)));
    } catch {
      log.warn('[ws-server] prisma-init not available — running without DB');
    }
  } else {
    log.warn('[ws-server] DATABASE_URL not set — running without DB');
  }
}

/** Fire-and-forget startup sequence (persisted spend, config, recovery, auto-boot). */
export async function runStartupTasks(): Promise<void> {
  // 0. Restore persisted daily spend counter (must run before any budget checks)
  try {
    const { loadPersistedDailySpend } = require('../state');
    loadPersistedDailySpend();
  } catch (e: any) {
    log.warn(`[ws-server] loadPersistedDailySpend failed: ${e.message?.slice(0, 80)}`);
  }

  // 1. Restore persisted config (idle timeout, deploy settings, latency targets)
  try {
    const { applyRuntimeConfig } = require('../config-persistence');
    await applyRuntimeConfig();
  } catch (e: any) {
    log.warn(`[ws-server] applyRuntimeConfig failed: ${e.message?.slice(0, 80)}`);
  }

  // 1b. Restore persisted pull-time-estimator history (adaptive image-pull
  // timeouts survive gateway restarts — without this every first deploy
  // post-restart falls back to the conservative 30-min default).
  try {
    const { initPullHistoryPersistence } = require('../pull-history-persistence');
    initPullHistoryPersistence();
  } catch (e: any) {
    log.warn(`[ws-server] initPullHistoryPersistence failed: ${e.message?.slice(0, 80)}`);
  }

  // 1c. Restore persisted tier-ranking (dynamic provider cascade by observed
  // P50 cold-start latency — cold-start plan A2). Must load before any deploy
  // so the first cascade reflects previous observations.
  try {
    const { loadTierRanking } = require('../tier-ranking');
    loadTierRanking();
  } catch (e: any) {
    log.warn(`[ws-server] loadTierRanking failed: ${e.message?.slice(0, 80)}`);
  }

  // 1d. Hydrate snapshot-store env from the vault so operators can keep
  // Hyperstack/R2 credentials in one place (~/.vault.json) instead of .env.
  // Env values already set take precedence — vault is a fallback.
  try {
    const { initVaultFromEnv } = require('../../src/vault/vault-singleton');
    const vault = initVaultFromEnv();
    if (vault) {
      const mapping: Record<string, string> = {
        'hyperstack:snapshotsBucket':    'HYPERSTACK_SNAPSHOTS_BUCKET',
        'hyperstack:snapshotsEndpoint':  'HYPERSTACK_SNAPSHOTS_ENDPOINT',
        'hyperstack:snapshotsAccessKey': 'HYPERSTACK_SNAPSHOTS_ACCESS_KEY',
        'hyperstack:snapshotsSecretKey': 'HYPERSTACK_SNAPSHOTS_SECRET_KEY',
        'hyperstack:snapshotsRegion':    'HYPERSTACK_SNAPSHOTS_REGION',
        // Pre-baked Custom OS Image id/name (see `gpu hyperstack build-bench-image`).
        // When set, the Hyperstack deploy path boots from this image instead of
        // vanilla Ubuntu — zero tool-install overhead, ~60s boot vs 5-7min.
        'hyperstack:benchImageId':       'HYPERSTACK_BENCH_IMAGE_ID',
        'hyperstack:benchImageName':     'HYPERSTACK_BENCH_IMAGE_NAME',
        // Pod-agent workspace backup creds (provisioned via SSH em cada pod —
        // ver server/pod-agent/). Mapeia pra B2_* (rclone-compatible). Funciona
        // pra qualquer S3: Cloudflare R2, Backblaze B2, AWS S3, MinIO.
        'aigw:agentAccessKey':           'B2_ACCOUNT_ID',
        'aigw:agentSecretKey':           'B2_APPLICATION_KEY',
        'aigw:agentEndpoint':            'B2_ENDPOINT',
        'aigw:agentRegion':              'B2_REGION',
        'aigw:agentBucket':              'B2_BUCKET',
      };
      let hydrated = 0;
      for (const [secretName, envName] of Object.entries(mapping)) {
        if (process.env[envName]) continue;
        try {
          const v = await vault.retrieve(secretName);
          if (v) { process.env[envName] = v; hydrated++; }
        } catch { /* missing → leave env unset */ }
      }
      if (hydrated > 0) log.log(`[startup] hydrated ${hydrated} Hyperstack snapshot env vars from vault`);
    }
  } catch (e: any) {
    log.warn(`[ws-server] vault hydration failed: ${e.message?.slice(0, 80)}`);
  }

  // 1e. Register pod-provisioner handler — runs aigw-agent install via SSH on
  // every transition into 'ready'. Replaces hand-baked backup/restore/heartbeat
  // scripts in each Docker image (see server/pod-agent/). Idempotent: re-running
  // install.sh re-uses existing PID files and just refreshes background loops.
  try {
    const { registerPodProvisioner } = require('../pod-provisioner-hook');
    registerPodProvisioner();
  } catch (e: any) {
    log.warn(`[ws-server] registerPodProvisioner failed: ${e.message?.slice(0, 80)}`);
  }

  // 2. Terminate any stopped pod overdue for auto-destroy (timer lost on restart)
  try {
    const { terminateStaleStoppedPodOnStartup } = require('../gpu-deploy');
    terminateStaleStoppedPodOnStartup().catch((e: any) =>
      log.warn(`[ws-server] terminateStaleStoppedPodOnStartup failed: ${e.message?.slice(0, 80)}`)
    );
  } catch (e: any) {
    log.warn(`[ws-server] terminateStaleStoppedPodOnStartup not loaded: ${e.message?.slice(0, 80)}`);
  }

  // 3. Reconnect to any pod that was healthy before restart
  try {
    const { tryRecoverActiveDeploy } = require('../gpu-deploy');
    tryRecoverActiveDeploy().catch((e: any) =>
      log.warn(`[ws-server] tryRecoverActiveDeploy failed: ${e.message?.slice(0, 80)}`)
    );
  } catch (e: any) {
    log.warn(`[ws-server] tryRecoverActiveDeploy not loaded: ${e.message?.slice(0, 80)}`);
  }

  // 3b. If no active deploy was recovered, scan for orphaned pods (deploy
  // improvement #11) and reconnect to one if found. Must run after
  // tryRecoverActiveDeploy so it only fires when the active-deploy path missed.
  try {
    const { tryReconnectOrphanDeploy } = require('../gpu-deploy');
    tryReconnectOrphanDeploy().catch((e: any) =>
      log.warn(`[ws-server] tryReconnectOrphanDeploy failed: ${e.message?.slice(0, 80)}`)
    );
  } catch (e: any) {
    log.warn(`[ws-server] tryReconnectOrphanDeploy not loaded: ${e.message?.slice(0, 80)}`);
  }

  // 4. Auto-boot GPU if profile has bootOnStartup=true
  try {
    const gh = require('../gpu-handlers');
    if (gh.autoBootFromProfile) {
      gh.autoBootFromProfile().catch((e: any) =>
        log.warn(`[ws-server] autoBootFromProfile failed: ${e.message?.slice(0, 80)}`)
      );
    }
  } catch (e: any) {
    log.warn(`[ws-server] autoBootFromProfile not loaded: ${e.message?.slice(0, 80)}`);
  }

  // 5. Start standby monitor — auto-deploys a warm GPU when session duration or
  // P95 latency thresholds are exceeded (standbyEnabled controls gating inside).
  try {
    const { startStandbyMonitor } = require('../gpu-standby');
    startStandbyMonitor();
  } catch (e: any) {
    log.warn('[ws-server] Standby monitor not started:', e?.message?.slice(0, 80));
  }

  // 5b. Start standby-pool monitor (Phase B4) + install deploy/terminate
  // adapters. Monitor remains a no-op until a profile is registered via
  // setStandbyPoolConfig(); adapter install is skipped if no snapshot-capable
  // provider key is set (VAST_API_KEY, HYPERSTACK_API_KEY). Global pool cap
  // protects against runaway cost — tune via STANDBY_POOL_GLOBAL_MAX.
  try {
    const { startStandbyPoolMonitor } = require('../standby-pool');
    const { installPoolAdaptersIfEnabled } = require('../standby-pool-adapter');
    startStandbyPoolMonitor();
    installPoolAdaptersIfEnabled();
    try {
      const { registerFastServeProfile } = require('../fast-serve-init');
      registerFastServeProfile();
    } catch (e: any) {
      log.warn('[ws-server] fast-serve profile init failed:', e?.message?.slice(0, 80));
    }
  } catch (e: any) {
    log.warn('[ws-server] Standby pool init failed:', e?.message?.slice(0, 80));
  }

  // 5b. Start orphan sweep — periodic destruction of untracked instances.
  // Fires initial sweep after 15s and every 10min thereafter. Critical for
  // gateway-owned accounts (see *_ACCOUNT_OWNED env flags) where any
  // untracked VM is a cost leak.
  try {
    const { startOrphanSweep } = require('../gpu-orphan-cleanup');
    startOrphanSweep();
  } catch (e: any) {
    log.warn(`[startup] startOrphanSweep failed: ${e?.message?.slice(0, 80)}`);
  }

  // 5c. Recover persisted auto-destroy timer for stopped pods.
  // Without this, a gateway restart orphans every stopped pod (they never get
  // destroyed on schedule and quietly accumulate storage costs).
  try {
    const { recoverPersistedDestroyTimer } = require('../gpu-destroy-timer');
    recoverPersistedDestroyTimer().catch((e: any) =>
      log.warn(`[startup] recoverPersistedDestroyTimer: ${e?.message?.slice(0, 80)}`),
    );
  } catch (e: any) {
    log.warn(`[startup] recoverPersistedDestroyTimer load failed: ${e?.message?.slice(0, 80)}`);
  }

  // 6. Start local Kokoro TTS server (CPU-based, always available as fallback)
  try {
    const { startLocalKokoro } = require('../../src/gateway/pipeline/local-kokoro');
    startLocalKokoro().then((url: string | null) => {
      if (url) log.log(`[startup] Local Kokoro TTS running at ${url}`);
      else log.log('[startup] Local Kokoro TTS not available (no venv found, set LOCAL_KOKORO_URL or create .venv-kokoro)');
    }).catch((e: any) => {
      log.warn(`[startup] Local Kokoro TTS failed: ${e?.message?.slice(0, 80)}`);
    });
  } catch (e: any) {
    log.warn(`[startup] Local Kokoro module not loaded: ${e?.message?.slice(0, 80)}`);
  }
}

/** Install persistent file logging — captures all console output + GPU events. */
export function installFileLogger(): void {
  try {
    const { installConsoleCapture } = require('../file-logger');
    installConsoleCapture();
  } catch (err) {
    log.warn('[ws-server] Failed to install file logger:', err);
  }
}
