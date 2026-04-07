// ── BabelCast Gateway — GPU Deploy Loop ─────────────────────────────────────
// GPU deploy loop, monitoring, orphan cleanup, tier config, cooldown,
// GPU type cache, health polling, log fetching.

import { homedir } from 'os';
import { join } from 'path';
import type { GpuProviderClient, GpuOffer, ProviderCredentials } from '../src/gpu-providers/types';
import { RunpodClient } from '../src/gpu-providers/runpod-client';
import { ProviderCooldownTracker, cleanupProviderInstances, filterTiers, PROVIDER_LABELS, DEFAULT_STORAGE_GB } from '../src/gpu-providers/deploy-orchestrator';
import type { ProviderName, GpuTier } from '../src/gpu-providers/deploy-orchestrator';
import { probeGpuHealth } from '../src/autoscaler/health';
import {
  prisma,
  deployState, setDeployState, deployCancelled, setDeployApiKey, setDeployVastApiKey,
  setDeployTensordockApiKey, setDeployTensordockAuthId, setDeployModalApiKey,
  activeProvider, setActiveProvider, setGpuHealthy, gpuHealthy, setLastRequestTime,
  monitorInterval, setMonitorInterval, deployApiKey, deployVastApiKey,
  deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey,
  resetDeployState, lastRequestTime, lastModelRequestTime, setLastModelRequestTime,
  DAILY_BUDGET_USD, dailyGpuSpendUsd, setDailyGpuSpendUsd, dailySpendResetDate, setDailySpendResetDate,
  deploymentSM,
  loadPersistedDeploy, clearPersistedDeploy, setDeployCancelled,
  updateGpuModelWarmth, isStageWarm,
  isGpuReadyForProduction, getPerStageP95, setGpuReadyForProduction, setServiceReadiness,
  perStageLatencyRing,
} from './state';
import {
  translationProfile, updateTranslationProfile, runpod, vast, tensordock, modal, markGpuHealthy, markGpuUnhealthy,
  markGpuShadowMode, markGpuWarmupFailed, _startReadinessCheck,
} from './providers';
import { isReadinessCheckInProgress } from './gpu-readiness';
import {
  getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs,
  getP95DemotionMultiplier, getP95IdleWindowSec,
} from '../src/gpu-providers/deploy-settings';
import { logGpuEvent, startDeploySession, updateDeploySession, upsertHostReputation, loadReputations, loadReputationsByGpuType, deriveHostKey, recordHostCrash, updateHostLatency } from './metrics';
import { getBestLatencyByGpuModel } from './latency-db';
import { getGpuSortBy, getDeployTimeoutMin, getGpuPriorityList, DEFAULT_GPU_PRIORITY } from '../src/gpu-providers/deploy-settings';
import {
  BLACKWELL_TO_STANDARD, STANDARD_TO_BLACKWELL,
  PROVIDER_CHAIN,
} from './config';
import { BILLING_URLS } from '../src/providers/errors';
import { broadcastProviderStatus, broadcastWs } from './ws-state';

export const MAX_DEPLOY_RETRIES = 2;
export const HEALTH_POLL_INTERVAL_MS = 10_000;
export const DEPLOY_TIMEOUT_MS = 30 * 60_000; // 30 min total (pods need ~10 min to download models)
export const GPU_MONITOR_INTERVAL_MS = 30_000; // health check every 30s
export let IDLE_TIMEOUT_MS = 15 * 60_000;    // auto-STOP (pause) after 15 min idle (configurable via API)
export function setIdleTimeoutMs(ms: number) { IDLE_TIMEOUT_MS = ms; }
export let IDLE_DESTROY_MS = 2 * 60 * 60_000; // auto-DESTROY 2 hours after stop (configurable)
export function setIdleDestroyMs(ms: number) { IDLE_DESTROY_MS = ms; }

export const GPU_TYPE_CACHE_TTL_MS = 30 * 60_000; // refresh GPU type cache every 30 min
export let gpuTypeCacheRefreshTimer: Timer | null = null;

/** Refresh GPU type cache from all providers and save to DB. */
export async function refreshGpuTypeCache(): Promise<void> {
  const providerQueries: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }> = [];
  const rpKey = process.env.RUNPOD_API_KEY || '';
  const vastKey = process.env.VAST_API_KEY || '';
  const tdKey = process.env.TENSORDOCK_API_KEY || '';
  const tdAuth = process.env.TENSORDOCK_AUTH_ID || '';
  const modalId = process.env.MODAL_TOKEN_ID || '';
  const modalSecret = process.env.MODAL_TOKEN_SECRET || '';

  if (rpKey) providerQueries.push({ name: 'runpod', client: runpod, credentials: { apiKey: rpKey } });
  if (vastKey) providerQueries.push({ name: 'vast', client: vast, credentials: { apiKey: vastKey } });
  if (tdKey && tdAuth) providerQueries.push({ name: 'tensordock', client: tensordock, credentials: { apiKey: tdKey, authId: tdAuth } });
  if (modalId && modalSecret) providerQueries.push({ name: 'modal', client: modal, credentials: { apiKey: `${modalId}:${modalSecret}` } });

  if (providerQueries.length === 0) {
    console.log('[gpu-cache] No provider API keys configured — skipping GPU type cache refresh');
    return;
  }

  console.log(`[gpu-cache] Refreshing GPU types from ${providerQueries.length} provider(s)...`);
  let totalUpserted = 0;

  const results = await Promise.allSettled(
    providerQueries.map(async ({ name, client, credentials }) => {
      if (!client.listOffers) return { name, offers: [] as GpuOffer[] };
      // Single attempt — cache refresh is a background operation; retrying on timeout
      // just floods logs (especially for consistently slow providers like TensorDock).
      try {
        const offers = await Promise.race([
          client.listOffers({ limit: 200 }, credentials),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${name} listOffers timed out`)), 15_000)),
        ]);
        return { name, offers };
      } catch (err) {
        console.warn(`[gpu-cache] ${name} listOffers failed: ${err instanceof Error ? err.message : err}`);
        return { name, offers: [] as GpuOffer[] };
      }
    }),
  );

  // Collect all upserts across providers before writing to DB
  type UpsertEntry = { name: string; gpuName: string; offer: GpuOffer };
  const allUpserts: UpsertEntry[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { name, offers } = result.value;
    // Deduplicate by gpuName within this provider
    const seen = new Map<string, GpuOffer>();
    for (const offer of offers) {
      const key = offer.gpuName || offer.gpuType;
      if (!seen.has(key) || offer.pricePerHr < (seen.get(key)!.pricePerHr || Infinity)) {
        seen.set(key, offer);
      }
    }
    for (const [gpuName, offer] of seen) {
      allUpserts.push({ name, gpuName, offer });
    }
  }

  // Write all upserts in a single transaction so partial writes don't occur if the process is killed mid-loop
  try {
    await prisma.$transaction(async (tx: any) => {
      for (const { name, gpuName, offer } of allUpserts) {
        await tx.gpuTypeCache.upsert({
          where: { provider_gpuName: { provider: name, gpuName } },
          update: {
            gpuType: offer.gpuType || gpuName,
            vram: offer.vram || 0,
            pricePerHr: offer.pricePerHr || 0,
            available: offer.available ?? -1,
            region: offer.region || '',
          },
          create: {
            provider: name,
            gpuName,
            gpuType: offer.gpuType || gpuName,
            vram: offer.vram || 0,
            pricePerHr: offer.pricePerHr || 0,
            available: offer.available ?? -1,
            region: offer.region || '',
          },
        });
      }
    }, { timeout: 30_000 });
    totalUpserted = allUpserts.length;
  } catch (err) {
    // Transaction failed — log but don't crash the cache refresh
    console.warn(`[gpu-cache] Transaction failed during cache write: ${err instanceof Error ? err.message : err}`);
  }
  console.log(`[gpu-cache] Cached ${totalUpserted} GPU types from ${providerQueries.length} provider(s)`);
}

/** Validate GPU types against the DB cache. Returns null if valid, or a descriptive error string. */
export async function validateGpuTypesFromCache(gpuTypes: string[], provider?: string): Promise<string | null> {
  if (gpuTypes.length === 0) return null; // no filter = any GPU

  // Fetch all cached GPU types (optionally filtered by provider)
  const where = provider ? { provider } : {};
  const cached = await prisma.gpuTypeCache.findMany({ where, orderBy: { pricePerHr: 'asc' } });
  if (cached.length === 0) return null; // no cache yet = skip validation

  // Build lookup sets: full names and short names (case-insensitive)
  const validFullNames = new Set(cached.map((g: any) => g.gpuName.toLowerCase()));
  const validShortNames = new Set(cached.map((g: any) => g.gpuType.toLowerCase()));

  const invalid: string[] = [];
  for (const requested of gpuTypes) {
    const lower = requested.toLowerCase();
    if (!validFullNames.has(lower) && !validShortNames.has(lower)) {
      // Also check with NVIDIA prefix for partial matches
      const withNvidia = `nvidia ${lower}`.toLowerCase();
      const withNvidiaGeforce = `nvidia geforce ${lower}`.toLowerCase();
      if (!validFullNames.has(withNvidia) && !validFullNames.has(withNvidiaGeforce)) {
        invalid.push(requested);
      }
    }
  }

  if (invalid.length === 0) return null;

  // Build descriptive error with valid options
  const providerLabel = provider ? ` on ${provider}` : '';
  const validList = cached
    .filter((g: any, i: number, arr: any[]) => arr.findIndex((x: any) => x.gpuName === g.gpuName) === i) // deduplicate
    .slice(0, 15)
    .map((g: any) => {
      const price = g.pricePerHr > 0 ? ` ($${g.pricePerHr.toFixed(2)}/h)` : '';
      const vram = g.vram > 0 ? ` ${g.vram}GB` : '';
      return `${g.gpuType}${vram}${price}`;
    })
    .join(', ');

  return `GPU type(s) not found${providerLabel}: ${invalid.join(', ')}. Valid options: ${validList}`;
}

export function startGpuTypeCacheRefresh() {
  // Initial refresh (non-blocking)
  refreshGpuTypeCache().catch(err => console.warn(`[gpu-cache] Initial refresh failed: ${err}`));
  // Periodic refresh
  gpuTypeCacheRefreshTimer = setInterval(() => {
    refreshGpuTypeCache().catch(err => console.warn(`[gpu-cache] Periodic refresh failed: ${err}`));
  }, GPU_TYPE_CACHE_TTL_MS);
}

// ── GPU Monitoring ───────────────────────────────────────────────────────────

let monitorRunning = false;
let monitorConsecFails = 0;
let monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
let monitorBackoffMaxAlerted = false;

// P95 demotion: require N consecutive violations before demoting (avoids transient spike false positives)
const P95_DEMOTION_CONSECUTIVE_VIOLATIONS = 3;
let p95ViolationCount: Record<string, number> = { stt: 0, llm: 0, tts: 0 };

// Budget enforcement: soft warn once per day, hard terminate at 100%
let budgetSoftWarned = false;
let lastBudgetCalcTime = 0;

// Idle warning: warn once before auto-terminate, reset on activity
let idleWarned = false;
export function resetIdleState() { idleWarned = false; monitorDelayMs = GPU_MONITOR_INTERVAL_MS; }

// ── Staged Warmth Monitor ────────────────────────────────────────────────────
// After initial deploy, TTS loads first and pod becomes healthy ("degraded").
// STT + LLM load in the background (~2-5min). We activate the full GPU pipeline
// only when both STT + LLM are warm, so cloud fallbacks handle STT/LLM until ready.

let warmthMonitorTimer: ReturnType<typeof setTimeout> | null = null;

function stopWarmthMonitor() {
  if (warmthMonitorTimer) { clearTimeout(warmthMonitorTimer); warmthMonitorTimer = null; }
}

function startBackgroundWarmthMonitor(endpoint: string) {
  stopWarmthMonitor();
  // If already fully warm, run readiness benchmark before activating
  if (isStageWarm('stt') && isStageWarm('llm')) {
    _startReadinessCheck(endpoint);
    return;
  }
  console.log('[gpu] Staged boot: TTS warm — polling until STT + LLM ready before activating full pipeline');

  let warmthPollCount = 0;

  const poll = async () => {
    if (deployState.status !== 'ready' || deployState.endpoint !== endpoint) {
      console.log('[gpu] Warmth monitor: pod changed or offline — stopping');
      stopWarmthMonitor(); // clear timer properly instead of just nulling
      return;
    }
    try {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        updateGpuModelWarmth(data);
        // Populate GPU hardware info from /health if not already known (e.g. Modal)
        if (!deployState.gpuType && data.gpu_type) {
          setDeployState({ gpuType: String(data.gpu_type) });
        }
        if (data.gpu_vram_gb && !deployState.providerMeta?.gpuVramGb) {
          setDeployState({ providerMeta: { ...deployState.providerMeta, gpuVramGb: Number(data.gpu_vram_gb) } });
        }
        const sttWarm = isStageWarm('stt');
        const llmWarm = isStageWarm('llm');
        const svc = (data.services ?? {}) as Record<string, string>;
        console.log(`[gpu] Warmth poll: stt=${svc.whisper ?? '?'} llm=${svc.llama_cpp ?? '?'} tts=${svc.tts ?? '?'} → STT=${sttWarm} LLM=${llmWarm}`);
        if (sttWarm && llmWarm) {
          console.log('[gpu] STT + LLM warm — running readiness benchmark');
          setDeployState({ stepDetail: '' });
          warmthMonitorTimer = null;
          _startReadinessCheck(endpoint);
          return; // done — regular monitoring loop takes over
        }
        const loading = [!sttWarm && 'STT', !llmWarm && 'LLM'].filter(Boolean).join(', ');
        setDeployState({ stepDetail: `Loading: ${loading} — using cloud fallback` });
        broadcastWs({ type: 'gpu:services', loaded: [sttWarm && 'stt', llmWarm && 'llm'].filter(Boolean), loading: [!sttWarm && 'stt', !llmWarm && 'llm'].filter(Boolean) });
      }
    } catch (err) {
      console.debug(`[gpu] Warmth poll failed: ${err instanceof Error ? err.message : err}`);
    }
    warmthPollCount++;
    // Adaptive warmth polling: 10s for first 5 checks, then 20s
    const nextDelayMs = warmthPollCount <= 5 ? 10_000 : 20_000;
    warmthMonitorTimer = setTimeout(poll, nextDelayMs);
  };

  warmthMonitorTimer = setTimeout(poll, 5_000); // first check after 5s (not 20s)
}

export function startGpuMonitoring() {
  stopGpuMonitoring();
  monitorConsecFails = 0;
  monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
  monitorBackoffMaxAlerted = false;
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
      console.warn(`[gpu] Monitor: deploy in error state but pod ${deployState.podId} exists on ${deployState.provider} — cleaning up orphaned pod`);
      try { await autoTerminateGpu(); } catch (e) { console.warn('[gpu] Orphan cleanup failed:', e); }
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
            console.warn(`[gpu] RunPod pod ${deployState.podId} EXITED — attempting auto-restart...`);
            try {
              await runpod.startInstance(deployState.podId, { apiKey: deployApiKey });
              console.log(`[gpu] Pod ${deployState.podId} auto-restart initiated`);
              setDeployState({ alert: `Pod exited unexpectedly — auto-restart initiated` });
              monitorDelayMs = 30_000; // Give it time to boot
            } catch (restartErr) {
              console.error(`[gpu] Auto-restart failed: ${restartErr instanceof Error ? restartErr.message : restartErr}`);
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
        // Activate full GPU pipeline when STT + LLM become warm (staged boot)
        if (isStageWarm('stt') && isStageWarm('llm') && !translationProfile.gpuEndpoint && !isReadinessCheckInProgress() && deployState.endpoint) {
          console.log('[gpu] STT + LLM warm — running readiness benchmark via monitor');
          stopWarmthMonitor();
          const ep = deployState.endpoint;
          _startReadinessCheck(ep);
        }
      }
      if (healthy) {
        markGpuHealthy();
        monitorConsecFails = 0;
        monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
        monitorBackoffMaxAlerted = false;
        // If health data indicates active training/work, treat as "not idle"
        // (prevents idle timeout from killing fine-tuning or long-running jobs)
        if (probeResult.data && (probeResult.data as Record<string, unknown>).training) {
          setLastRequestTime(Date.now());
        }
      } else {
        monitorConsecFails++;
        // Only mark unhealthy after 2+ consecutive failures to tolerate
        // transient timeouts when GPU is under heavy load (e.g. benchmark)
        if (monitorConsecFails >= 2) {
          markGpuUnhealthy('health probe failed');
        } else {
          console.log(`[gpu] Health probe failed (1st), will retry before marking unhealthy`);
        }
        if (monitorConsecFails >= 3) {
          monitorDelayMs = Math.min(monitorDelayMs * 2, 120_000);
          console.log(`[gpu] Health probe failed ${monitorConsecFails}x, backing off to ${monitorDelayMs / 1000}s`);
          if (monitorDelayMs >= 120_000 && !monitorBackoffMaxAlerted) {
            monitorBackoffMaxAlerted = true;
            console.warn('[gpu] WARNING: GPU health probe has backed off to maximum interval (120s). Pod may be unreachable.');
          }
          // Record crash in host reputation at threshold (5 consecutive failures = likely crash)
          if (monitorConsecFails === 5 && deployState.provider) {
            recordHostCrash(deployState.provider, deployState.gpuType, deployState.providerMeta);
          }
          // Auto-restart: attempt to restart the pod before declaring it dead
          if (monitorConsecFails === 5 && deployState.podId) {
            const restartProvider = activeProvider === 'runpod' ? runpod : activeProvider === 'vast' ? vast : null;
            if (restartProvider && (deployApiKey || deployVastApiKey)) {
              const restartKey = activeProvider === 'runpod' ? deployApiKey : deployVastApiKey;
              try {
                console.log(`[gpu] Auto-restart attempt for ${activeProvider} pod ${deployState.podId}...`);
                await restartProvider.startInstance(deployState.podId, { apiKey: restartKey });
                console.log(`[gpu] Auto-restart initiated for pod ${deployState.podId} — resetting health counter`);
                monitorConsecFails = 0;
                monitorDelayMs = 30_000; // Give it time to boot
                setDeployState({ alert: `Pod auto-restarted after 5 health failures` });
              } catch (restartErr) {
                console.error(`[gpu] Auto-restart failed for pod ${deployState.podId}: ${restartErr instanceof Error ? restartErr.message : restartErr}`);
              }
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
                console.warn(`[gpu] ${msg}`);
                setDeployState({ alert: msg });
              }
            }
          } catch { /* balance check is best-effort */ }
        }
        // If TensorDock, check balance — low balance causes VMs to be reclaimed
        if (activeProvider === 'tensordock' && deployTensordockApiKey && deployTensordockAuthId) {
          const bal = await tensordock.checkBalance({ apiKey: deployTensordockApiKey, authId: deployTensordockAuthId });
          if (bal) {
            console.log(`[gpu] TensorDock balance: $${bal.balance.toFixed(2)} (hourly: $${bal.hourlyCost.toFixed(3)})`);
            if (bal.balance < 1.0) {
              const msg = `TensorDock balance low: $${bal.balance.toFixed(2)} — VM may have been reclaimed. Add funds: https://${BILLING_URLS.tensordock}`;
              console.warn(`[gpu] ${msg}`);
              setDeployState({ alert: msg });
            }
          }
        }
      }

      // Budget tracking: accumulate GPU spend with enforcement
      if (deployState.costPerHr > 0) {
        const today = new Date().toISOString().slice(0, 10);
        if (today !== dailySpendResetDate) { setDailyGpuSpendUsd(0); setDailySpendResetDate(today); budgetSoftWarned = false; }
        // Use actual elapsed time since last probe instead of assuming monitorDelayMs
        const actualElapsedMs = lastBudgetCalcTime > 0 ? Date.now() - lastBudgetCalcTime : monitorDelayMs;
        lastBudgetCalcTime = Date.now();
        setDailyGpuSpendUsd(dailyGpuSpendUsd + deployState.costPerHr * (actualElapsedMs / 1000 / 3600));
        if (DAILY_BUDGET_USD > 0) {
          const pct = dailyGpuSpendUsd / DAILY_BUDGET_USD;
          const forecast = dailyGpuSpendUsd + (deployState.costPerHr * ((24 - new Date().getUTCHours()) / 24));
          if (pct >= 1.0) {
            // HARD BUDGET: auto-terminate to prevent overspend
            console.error(`[budget] HARD LIMIT: $${dailyGpuSpendUsd.toFixed(2)} >= $${DAILY_BUDGET_USD.toFixed(2)} — auto-terminating GPU`);
            broadcastWs({ type: 'gpu:budget', action: 'hard-limit', spend: dailyGpuSpendUsd, budget: DAILY_BUDGET_USD });
            await autoTerminateGpu();
            return;
          } else if (pct >= 0.8 && !budgetSoftWarned) {
            // SOFT BUDGET: warn + block new deploys
            budgetSoftWarned = true;
            console.warn(`[budget] SOFT LIMIT: $${dailyGpuSpendUsd.toFixed(2)} (${Math.round(pct * 100)}% of $${DAILY_BUDGET_USD.toFixed(2)}) — new deploys blocked`);
            broadcastWs({ type: 'gpu:budget', action: 'soft-limit', spend: dailyGpuSpendUsd, budget: DAILY_BUDGET_USD, forecast });
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
              console.warn(`[gpu] Latency trend warning: ${stage} increasing ${Math.round(trend * 100)}% (${Math.round(olderAvg)}ms → ${Math.round(recentAvg)}ms)`);
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
                console.warn(`[gpu] P95 degraded: ${stage} ${p95}ms > ${threshold}ms (${p95ViolationCount[stage]} consecutive) — demoting`);
                setServiceReadiness(stage, { phase: 'degraded' });
                broadcastWs({ type: 'gpu:readiness', stage, phase: 'degraded', p95Ms: p95, thresholdMs: threshold });
                broadcastProviderStatus('booting', 'cloud', `GPU ${stage} P95 degraded — re-benchmarking`);
                setGpuReadyForProduction(false);
                p95ViolationCount = { stt: 0, llm: 0, tts: 0 };
                _startReadinessCheck(deployState.endpoint);
                break;
              } else {
                console.log(`[gpu] P95 warning: ${stage} ${p95}ms > ${threshold}ms (${p95ViolationCount[stage]}/${P95_DEMOTION_CONSECUTIVE_VIOLATIONS})`);
              }
            } else {
              // Reset violation counter for this stage when P95 is within threshold
              p95ViolationCount[stage] = 0;
            }
          }
        }
      }

      // Idle check — only model requests (STT/LLM/TTS/pipeline) count, not status polls
      const _idleBase = lastModelRequestTime > 0 ? lastModelRequestTime : lastRequestTime;
      if (_idleBase > 0) {
        const idleMs = Date.now() - _idleBase;
        if (idleMs >= IDLE_TIMEOUT_MS) {
          const idleMin = Math.round(idleMs / 60_000);
          console.log(`[gpu] Idle ${idleMin} min (no model requests) — auto-stopping (pausing) to save costs`);
          broadcastWs({ type: 'gpu:idle', idleMs, timeoutMs: IDLE_TIMEOUT_MS, action: 'stop' });
          await autoStopGpu();
          return;
        }
        // Warn at 75% of idle timeout (gives user chance to send a request)
        if (idleMs >= IDLE_TIMEOUT_MS * 0.75 && !idleWarned) {
          idleWarned = true;
          const remainingSec = Math.round((IDLE_TIMEOUT_MS - idleMs) / 1000);
          console.log(`[gpu] Idle warning: ${remainingSec}s until auto-terminate`);
          broadcastWs({ type: 'gpu:idle', idleMs, timeoutMs: IDLE_TIMEOUT_MS, action: 'warning', remainingSec });
        }
        // Adaptive monitor frequency during idle: slow down polling to save overhead
        if (idleMs > 60_000 && monitorDelayMs < 60_000) {
          monitorDelayMs = 60_000; // idle > 1min → check every 60s instead of 30s
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[gpu] Monitor probe failed (provider=${activeProvider}, pod=${deployState.podId}): ${msg}`);
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

// ── Destroy timer — deletes pod N hours after auto-stop ─────────────────────
let destroyTimer: Timer | null = null;

function scheduleAutoDestroy(delayMs: number) {
  clearAutoDestroyTimer();
  const provider = activeProvider;
  const podId = deployState.podId;
  console.log(`[gpu] Auto-destroy scheduled in ${Math.round(delayMs / 60_000)} min for ${provider} pod ${podId}`);
  destroyTimer = setTimeout(async () => {
    console.log(`[gpu] Auto-destroy triggered — deleting stopped pod ${podId} (${provider})`);
    broadcastWs({ type: 'gpu:idle', action: 'destroy', provider, podId });
    await autoTerminateGpu();
  }, delayMs) as unknown as Timer;
}

export function clearAutoDestroyTimer() {
  if (destroyTimer) { clearTimeout(destroyTimer as unknown as ReturnType<typeof setTimeout>); destroyTimer = null; }
}

/**
 * Auto-stop (pause) GPU when idle — preserves disk, no hourly charges.
 * Schedules auto-destroy after IDLE_DESTROY_MS (default 2h).
 */
export async function autoStopGpu() {
  const provider = activeProvider;
  const podId = deployState.podId;

  if (!podId || !provider) {
    console.warn('[gpu] autoStopGpu: no active pod to stop');
    await autoTerminateGpu();
    return;
  }

  // Resolve credentials (apiKey is overwritten below based on provider)
  const credentials: ProviderCredentials = { apiKey: '' };
  let client: GpuProviderClient | null = null;
  if (provider === 'runpod' && deployApiKey) {
    client = runpod; credentials.apiKey = deployApiKey;
  } else if (provider === 'vast' && deployVastApiKey) {
    client = vast; credentials.apiKey = deployVastApiKey;
  } else if (provider === 'tensordock' && deployTensordockApiKey) {
    client = tensordock; credentials.apiKey = deployTensordockApiKey; credentials.authId = deployTensordockAuthId;
  } else if (provider === 'modal' && deployModalApiKey) {
    client = modal; credentials.apiKey = deployModalApiKey;
  }

  if (!client) {
    console.warn(`[gpu] autoStopGpu: no client for ${provider} — falling back to terminate`);
    await autoTerminateGpu();
    return;
  }

  try {
    await client.stopInstance(podId, credentials);
    console.log(`[gpu] Pod ${podId} stopped (paused) on ${provider} — disk preserved, no charges`);
    logGpuEvent('instance_stopped', provider, true, { metadata: { podId, reason: 'idle_timeout' } });
  } catch (err) {
    console.warn(`[gpu] Stop failed for ${provider} pod ${podId}: ${err instanceof Error ? err.message : err} — falling back to terminate`);
    await autoTerminateGpu();
    return;
  }

  broadcastProviderStatus('offline', 'cloud', `GPU idle → stopped (paused). Auto-destroy in ${Math.round(IDLE_DESTROY_MS / 60_000)} min.`);
  stopGpuMonitoring();
  stopWarmthMonitor();
  updateTranslationProfile({ gpuEndpoint: undefined }, 'idleStop');

  // Keep podId/provider in state so resume can find it
  setDeployState({
    status: 'idle',
    message: `Pod stopped (idle ${Math.round(IDLE_TIMEOUT_MS / 60_000)} min). Will be destroyed in ${Math.round(IDLE_DESTROY_MS / 60_000)} min if not resumed.`,
  });
  deployState.podId = podId;
  deployState.provider = provider;

  // Schedule auto-destroy
  scheduleAutoDestroy(IDLE_DESTROY_MS);
}

export async function autoTerminateGpu() {
  clearAutoDestroyTimer();
  const rpKey = deployApiKey;
  const vastKey = deployVastApiKey;
  const tdKey = deployTensordockApiKey;
  const tdAuthId = deployTensordockAuthId;
  const modalKey = deployModalApiKey;
  const provider = activeProvider;
  const podId = deployState.podId;
  broadcastProviderStatus('offline', 'cloud', 'GPU idle timeout — terminated');
  stopGpuMonitoring();
  // Close all SSH tunnels to prevent orphaned ssh processes
  try { const { closeAllTunnels } = await import('./ssh-tunnel'); closeAllTunnels(); } catch {}
  stopWarmthMonitor();
  resetDeployState();
  updateTranslationProfile({ gpuEndpoint: undefined }, 'idleTimeout');
  if (provider === 'modal' && modalKey && podId) {
    console.log(`[gpu] Modal idle → stopping app ${podId}`);
    try {
      await modal.stopInstance(podId, { apiKey: modalKey });
      console.log(`[gpu] Modal app ${podId} stopped`);
      logGpuEvent('instance_stopped', 'modal', true, { metadata: { podId, reason: 'idle_timeout' } });
    } catch (err) {
      console.warn(`[gpu] Modal stop failed for app ${podId}: ${err instanceof Error ? err.message : err}`);
      await cleanupModalApps(modalKey);
    }
  } else if (provider === 'tensordock' && tdKey && podId) {
    // TensorDock: STOP (pause) instead of delete — preserves disk, fast restart
    console.log(`[gpu] TensorDock idle → stopping (pausing) instance ${podId}`);
    try {
      await tensordock.stopInstance(podId, { apiKey: tdKey, authId: tdAuthId });
      console.log(`[gpu] TensorDock instance ${podId} stopped (paused, disk preserved)`);
      logGpuEvent('instance_stopped', 'tensordock', true, { metadata: { podId, reason: 'idle_timeout' } });
    } catch (err) {
      console.warn(`[gpu] TensorDock stop failed for instance ${podId}: ${err instanceof Error ? err.message : err} — falling back to full cleanup`);
      await cleanupTensordockInstances(tdKey, tdAuthId);
    }
  } else if (provider === 'vast' && vastKey) {
    await cleanupVastInstances(vastKey);
    logGpuEvent('instance_stopped', 'vast', true, { metadata: { reason: 'idle_timeout' } });
  } else if (rpKey) {
    await cleanupAllPods(rpKey);
    logGpuEvent('instance_stopped', 'runpod', true, { metadata: { podId, reason: 'idle_timeout' } });
  }
  updateDeploySession({ status: 'stopped', stoppedAt: new Date() });
}

// ── Orphan pod cleanup ──────────────────────────────────────────────────────

export const POD_NAME_PREFIX = 'parle-autoscale-';

/**
 * Instance IDs that are currently part of an active race deploy.
 * The orphan sweep must not terminate these — they are legitimately booting.
 * Populated by startDeployRace, cleared when race resolves.
 */
export const activeRaceInstanceIds = new Set<string>();

/**
 * Find and terminate ALL pods matching our naming prefix.
 * This prevents orphaned pods from accumulating costs when the gateway restarts
 * or when deploy requests race.
 *
 * @param apiKey RunPod API key
 * @param knownPodIds Pods we already know about (will also be terminated)
 */
export async function cleanupAllPods(apiKey: string, knownPodIds: string[] = []): Promise<void> {
  try {
    const instances = await runpod.listInstances({ apiKey });
    const toTerminate = instances.filter(inst =>
      (inst.instanceName || '').startsWith(POD_NAME_PREFIX) && inst.status !== 'EXITED'
    );

    if (toTerminate.length === 0) return;

    console.log(`[gpu] Cleaning up ${toTerminate.length} existing pod(s)...`);
    await Promise.allSettled(
      toTerminate.map(async (inst) => {
        try {
          await runpod.deleteInstance(inst.instanceId, { apiKey });
          console.log(`[gpu] Terminated orphan pod ${inst.instanceId} (${inst.instanceName})`);
        } catch (err) {
          console.warn(`[gpu] Failed to terminate pod ${inst.instanceId} (${inst.instanceName}): ${err instanceof Error ? err.message : err}`);
        }
      })
    );
  } catch (err) {
    console.warn(`[gpu] Failed to list pods for cleanup: ${err}`);
    // Fall back to terminating only known pods
    for (const podId of knownPodIds) {
      try { await runpod.deleteInstance(podId, { apiKey }); }
      catch (e) { console.warn(`[gpu] Failed to terminate known pod ${podId}: ${e instanceof Error ? e.message : e}`); }
    }
  }
}



export const cleanupVastInstances = (apiKey: string) =>
  cleanupProviderInstances(vast, { apiKey }, ['running', 'active', 'loading', 'creating', 'created'], 'Vast.ai');

export const cleanupTensordockInstances = (apiKey: string, authId?: string) =>
  cleanupProviderInstances(tensordock, { apiKey, authId }, ['running', 'active', 'deploying', 'creating'], 'TensorDock');

export const cleanupModalApps = (apiKey: string) =>
  cleanupProviderInstances(modal, { apiKey }, ['running', 'deployed', 'active'], 'Modal');

// ── Orphan instance sweep ─────────────────────────────────────────────────

let orphanSweepTimer: ReturnType<typeof setInterval> | null = null;
const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000; // every 10 minutes

/**
 * Scan all providers for instances we don't track and terminate them.
 * Safe to call at any time — only kills instances NOT matching the active
 * deploy or standby deploy podId.
 */
export async function sweepOrphanInstances(): Promise<{ found: number; terminated: number }> {
  const tracked = new Set<string>();
  if (deployState.podId) tracked.add(deployState.podId);
  const { standbyDeployState } = await import('./state');
  if (standbyDeployState.podId) tracked.add(standbyDeployState.podId);
  // Include all active race candidates — they are legitimately booting, not orphans
  for (const id of activeRaceInstanceIds) tracked.add(id);

  let found = 0;
  let terminated = 0;

  // ── RunPod ──
  const rpKey = deployApiKey || process.env.RUNPOD_API_KEY || '';
  if (rpKey) {
    try {
      const instances = await runpod.listInstances({ apiKey: rpKey });
      const orphans = instances.filter(i =>
        (i.instanceName || '').startsWith(POD_NAME_PREFIX) &&
        i.status !== 'EXITED' &&
        !tracked.has(i.instanceId),
      );
      found += orphans.length;
      for (const inst of orphans) {
        try {
          await runpod.deleteInstance(inst.instanceId, { apiKey: rpKey });
          terminated++;
          console.log(`[orphan-sweep] RunPod ${inst.instanceId} (${inst.instanceName}) terminated`);
        } catch (err) {
          console.warn(`[orphan-sweep] RunPod ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      console.warn(`[orphan-sweep] RunPod list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Vast.ai ──
  const vastKey = deployVastApiKey || process.env.VAST_API_KEY || '';
  if (vastKey) {
    try {
      const instances = await vast.listInstances({ apiKey: vastKey });
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        return ['running', 'active', 'loading', 'creating', 'created'].includes(st)
          && !tracked.has(i.instanceId);
      });
      found += orphans.length;
      for (const inst of orphans) {
        try {
          await vast.deleteInstance(inst.instanceId, { apiKey: vastKey });
          terminated++;
          console.log(`[orphan-sweep] Vast ${inst.instanceId} (${inst.gpuType}) terminated`);
        } catch (err) {
          console.warn(`[orphan-sweep] Vast ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      console.warn(`[orphan-sweep] Vast list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── TensorDock ──
  const tdKey = deployTensordockApiKey || process.env.TENSORDOCK_API_KEY || '';
  const tdAuth = deployTensordockAuthId || process.env.TENSORDOCK_AUTH_ID || '';
  if (tdKey) {
    try {
      const instances = await tensordock.listInstances({ apiKey: tdKey, authId: tdAuth });
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        return ['running', 'active', 'deploying', 'creating'].includes(st)
          && !tracked.has(i.instanceId);
      });
      found += orphans.length;
      for (const inst of orphans) {
        try {
          await tensordock.deleteInstance(inst.instanceId, { apiKey: tdKey, authId: tdAuth });
          terminated++;
          console.log(`[orphan-sweep] TensorDock ${inst.instanceId} terminated`);
        } catch (err) {
          console.warn(`[orphan-sweep] TensorDock ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      console.warn(`[orphan-sweep] TensorDock list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Modal ──
  const modalKey = deployModalApiKey || process.env.MODAL_TOKEN_ID || '';
  if (modalKey) {
    try {
      const instances = await modal.listInstances({ apiKey: modalKey });
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        return ['running', 'deployed', 'active'].includes(st)
          && !tracked.has(i.instanceId);
      });
      found += orphans.length;
      for (const inst of orphans) {
        try {
          await modal.deleteInstance(inst.instanceId, { apiKey: modalKey });
          terminated++;
          console.log(`[orphan-sweep] Modal ${inst.instanceId} terminated`);
        } catch (err) {
          console.warn(`[orphan-sweep] Modal ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      console.warn(`[orphan-sweep] Modal list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (found > 0) {
    console.log(`[orphan-sweep] Found ${found} orphan(s), terminated ${terminated}`);
  }
  return { found, terminated };
}

let orphanSweepInitialTimer: ReturnType<typeof setTimeout> | null = null;

/** Start periodic orphan sweep. Safe to call multiple times. */
export function startOrphanSweep(): void {
  if (orphanSweepTimer || orphanSweepInitialTimer) return;
  // Run initial sweep after a short delay (let startup finish first)
  orphanSweepInitialTimer = setTimeout(() => {
    orphanSweepInitialTimer = null;
    sweepOrphanInstances().catch(err =>
      console.warn(`[orphan-sweep] Initial sweep failed: ${err instanceof Error ? err.message : err}`),
    );
  }, 15_000);
  // Then every 10 minutes
  orphanSweepTimer = setInterval(() => {
    sweepOrphanInstances().catch(err =>
      console.warn(`[orphan-sweep] Periodic sweep failed: ${err instanceof Error ? err.message : err}`),
    );
  }, ORPHAN_SWEEP_INTERVAL_MS);
  console.log(`[orphan-sweep] Started (interval: ${ORPHAN_SWEEP_INTERVAL_MS / 60_000}min)`);
}

/** Stop periodic orphan sweep. */
export function stopOrphanSweep(): void {
  if (orphanSweepInitialTimer) { clearTimeout(orphanSweepInitialTimer); orphanSweepInitialTimer = null; }
  if (orphanSweepTimer) {
    clearInterval(orphanSweepTimer);
    orphanSweepTimer = null;
  }
}

/**
 * Query available GPU offers from a tier's provider and pick the cheapest with adequate VRAM.
 * Returns an array of unique GPU type strings sorted by price (cheapest first), or empty array if none found.
 */
export async function autoSelectCheapestGpu(
  tiers: GpuTier[],
  opts: { region?: string; minVramGb?: number; preferSsd?: boolean; maxResults?: number; allowedTypes?: Set<string> } = {},
): Promise<string[]> {
  const minVram = opts.minVramGb ?? 16;
  const preferSsd = opts.preferSsd ?? false;
  const maxResults = opts.maxResults ?? 8;
  const allowed = opts.allowedTypes ?? new Set(getGpuPriorityList());
  const allOffers: GpuOffer[] = [];

  await Promise.allSettled(
    tiers.map(async (tier) => {
      if (!tier.client.listOffers) return;
      try {
        const offers = await Promise.race([
          tier.client.listOffers(
            { region: opts.region, limit: 50 },
            { apiKey: tier.apiKey, authId: tier.authId },
          ),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${tier.label} listOffers timed out`)), 15_000)),
        ]);
        allOffers.push(...offers);
      } catch (err) {
        console.warn(`[gpu] autoSelectGpu: failed to query ${tier.label}: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  // Filter by minimum VRAM
  // Note: available === -1 means "unknown" (e.g. RunPod GraphQL doesn't report stock)
  // so we treat -1 as "probably available" and only exclude available === 0
  const base = allOffers.filter((o) => o.vram >= minVram && o.available !== 0 && o.pricePerHr > 0);

  // Internet speed filter: prefer machines with fast download (>500 Mbps) for quick image pulls.
  // Fall back to all offers if none qualify (some providers don't report speed).
  const MIN_INET_MBPS = 500;
  const fastInet = base.filter(o => {
    const dl = (o as unknown as Record<string, unknown>).inetDown as number | undefined;
    return !dl || dl >= MIN_INET_MBPS; // 0/undefined = unknown (allow), >= 500 = fast enough
  });
  const inetFiltered = fastInet.length > 0 ? fastInet : base;
  if (fastInet.length < base.length && fastInet.length > 0) {
    console.log(`[gpu] autoSelectGpu: filtered ${base.length - fastInet.length} slow hosts (<${MIN_INET_MBPS} Mbps), keeping ${fastInet.length}`);
  }

  // SSD preference: keep offers where diskBwReadMbps > 200 MB/s (SSD/NVMe) or unknown.
  // Fall back to all offers if none qualify (provider may not report disk speed).
  const ssdFiltered = preferSsd ? inetFiltered.filter(o => {
    const bw = (o as unknown as Record<string, unknown>).diskBwReadMbps as number | undefined;
    return !bw || bw > 200;
  }) : inetFiltered;
  const suitable = preferSsd && ssdFiltered.length === 0 ? inetFiltered : ssdFiltered;

  // ── Blacklist: hosts with 3+ crashes in 7 days
  let blacklistedHosts: Set<string> | null = null;
  try {
    const rows = await prisma.hostReputation.findMany({
      where: { crashCount: { gte: 3 }, lastDeployAt: { gt: Date.now() - 7 * 24 * 60 * 60 * 1000 } },
      select: { hostKey: true },
    });
    blacklistedHosts = new Set(rows.map((r: { hostKey: string }) => r.hostKey));
    if (blacklistedHosts.size > 0) {
      console.log(`[gpu] autoSelectGpu: ${blacklistedHosts.size} host(s) blacklisted (3+ crashes in 7d)`);
    }
  } catch {}

  // ── Reputation floor: skip hosts with score < 0.3 (proven unreliable)
  let lowRepHosts: Set<string> | null = null;
  try {
    const rows = await prisma.hostReputation.findMany({
      where: { reputationScore: { lt: 0.3 }, deployCount: { gte: 2 } }, // at least 2 deploys to avoid penalizing new hosts
      select: { hostKey: true, reputationScore: true },
    });
    lowRepHosts = new Set(rows.map((r: { hostKey: string }) => r.hostKey));
    if (lowRepHosts.size > 0) {
      console.log(`[gpu] autoSelectGpu: ${lowRepHosts.size} host(s) below reputation floor (<0.3)`);
    }
  } catch {}

  // ── Compatibility filter: skip GPU+image combos that have failed tests
  let incompatibleGpuTypes: Set<string> | null = null;
  try {
    const currentImage = deployState.dockerImage || '';
    if (currentImage) {
      const failedTests = await prisma.gpuCompatibilityTest.findMany({
        where: {
          dockerImage: currentImage,
          passed: false,
          testedAt: { gt: new Date(Date.now() - 14 * 86400_000) }, // last 14 days
        },
        select: { gpuType: true },
      });
      if (failedTests.length > 0) {
        incompatibleGpuTypes = new Set(failedTests.map((t: { gpuType: string }) => t.gpuType));
        console.log(`[gpu] autoSelectGpu: ${incompatibleGpuTypes.size} GPU type(s) incompatible with ${currentImage}: ${[...incompatibleGpuTypes].join(', ')}`);
      }
    }
  } catch {}

  // ── Deploy session history: boost GPU types with recent success on same image
  let sessionSuccessRates: Map<string, number> | null = null;
  try {
    const currentImage = deployState.dockerImage || '';
    if (currentImage) {
      const recentSessions = await prisma.gpuDeploySession.findMany({
        where: {
          dockerImage: currentImage,
          createdAt: { gt: new Date(Date.now() - 7 * 86400_000) },
          status: { in: ['ready', 'failed'] },
        },
        select: { gpuType: true, status: true },
      });
      if (recentSessions.length > 0) {
        const grouped = new Map<string, { success: number; total: number }>();
        for (const s of recentSessions) {
          if (!s.gpuType) continue;
          const g = grouped.get(s.gpuType) || { success: 0, total: 0 };
          g.total++;
          if (s.status === 'ready') g.success++;
          grouped.set(s.gpuType, g);
        }
        sessionSuccessRates = new Map();
        for (const [gpu, { success, total }] of grouped) {
          if (total >= 2) sessionSuccessRates.set(gpu, success / total);
        }
        if (sessionSuccessRates.size > 0) {
          const rates = [...sessionSuccessRates.entries()].map(([g, r]) => `${g}=${(r * 100).toFixed(0)}%`).join(', ');
          console.log(`[gpu] autoSelectGpu: session success rates (7d): ${rates}`);
        }
      }
    }
  } catch {}

  // Apply all filters (blacklist + low reputation + incompatible)
  const filtered = suitable.filter(o => {
    const hostKey = `${o.provider}:${o.hostId || o.offerId || o.gpuName}`;
    if (blacklistedHosts?.has(hostKey)) return false;
    if (lowRepHosts?.has(hostKey)) return false;
    if (incompatibleGpuTypes?.has(o.gpuType) || incompatibleGpuTypes?.has(o.gpuName)) return false;
    return true;
  });
  // Use filtered list (fallback to full list if all filtered out)
  const ranked = filtered.length > 0 ? filtered : suitable;

  if (ranked.length === 0) {
    console.warn(`[gpu] autoSelectGpu: ${allOffers.length} total offers, 0 suitable (minVram=${minVram}GB). Sample: ${allOffers.slice(0, 5).map(o => `${o.gpuName}(${o.vram}GB,$${o.pricePerHr},avail=${o.available})`).join(', ')}`);
    return [];
  }

  // Load reputation data grouped by provider+gpuType.
  // Since offers are grouped (we don't know specific hosts yet), we use aggregate
  // reputation per GPU type to rank. This captures historical latency, reliability,
  // and consistency across all hosts we've used with that GPU type on that provider.
  const gpuTypeReps = await loadReputationsByGpuType();
  const getRepScore = (o: GpuOffer): number => {
    const key = `${o.provider}:${o.gpuName || o.gpuType}`;
    return gpuTypeReps.get(key)?.avgScore ?? 0.5;
  };

  // Sort based on user-configured criteria: price, latency, or balanced (default)
  const sortBy = getGpuSortBy();
  const normalize_name = (s: string) => s.replace(/nvidia|geforce/gi, '').replace(/\s+/g, '').toLowerCase();
  const latencyMap = sortBy !== 'price' ? await getBestLatencyByGpuModel() : {};

  const getLatencyMs = (o: GpuOffer): number | null => {
    const key = normalize_name(o.gpuName || o.gpuType);
    const entry = (latencyMap as Record<string, { bestMs: number; region: string }>)[key];
    return entry?.bestMs ?? null;
  };

  // Unified latency score: normalize TCP RTT (0-1) — <30ms=1.0, 150ms=0.5, 300ms+=0.0
  // This puts TCP latency on the same 0-1 scale as reputationScore (which embeds pipeline latency)
  const tcpLatencyScore = (o: GpuOffer): number => {
    const ms = getLatencyMs(o);
    if (ms == null) return 0.5; // neutral for unknown
    return Math.max(0, Math.min(1, 1 - (ms - 30) / 270));
  };

  if (sortBy === 'price') {
    // Pure price sort — cheapest first
    ranked.sort((a, b) => a.pricePerHr - b.pricePerHr);
  } else if (sortBy === 'latency') {
    // Sort by measured TCP latency (closest datacenter first); unknown latency goes last
    ranked.sort((a, b) => {
      const latA = getLatencyMs(a) ?? Infinity;
      const latB = getLatencyMs(b) ?? Infinity;
      return latA - latB;
    });
  } else {
    // Balanced (default): combine reputation, TCP latency, session history, and price.
    // qualityScore components (all 0-1 scale):
    //   repScore   × 0.50 — host reputation (embeds pipeline latency, reliability)
    //   tcpScore   × 0.30 — network proximity
    //   sessionBonus × 0.20 — recent deploy success rate with same image
    // effectivePrice = price / max(qualityScore, 0.1)
    ranked.sort((a, b) => {
      const repA = getRepScore(a);
      const repB = getRepScore(b);
      const tcpA = tcpLatencyScore(a);
      const tcpB = tcpLatencyScore(b);
      // Session history bonus: prefer GPU types with proven success on this image
      const sessA = sessionSuccessRates?.get(a.gpuType) ?? sessionSuccessRates?.get(a.gpuName) ?? 0.5;
      const sessB = sessionSuccessRates?.get(b.gpuType) ?? sessionSuccessRates?.get(b.gpuName) ?? 0.5;
      const qualityA = Math.max(repA * 0.50 + tcpA * 0.30 + sessA * 0.20, 0.1);
      const qualityB = Math.max(repB * 0.50 + tcpB * 0.30 + sessB * 0.20, 0.1);
      const effectiveA = a.pricePerHr / qualityA;
      const effectiveB = b.pricePerHr / qualityB;
      return effectiveA - effectiveB;
    });
  }

  // Log sort criteria and top offers
  {
    const topOffers = ranked.slice(0, 5).map(o => {
      const key = `${o.provider}:${o.gpuName || o.gpuType}`;
      const rep = gpuTypeReps.get(key);
      const score = rep?.avgScore ?? 0.5;
      const latMs = getLatencyMs(o);
      const latStr = latMs != null ? `,lat=${latMs}ms` : '';
      const hostStr = rep ? `,${rep.hostCount}hosts` : '';
      return `${o.gpuName}($${o.pricePerHr.toFixed(2)},rep=${score.toFixed(2)}${latStr}${hostStr})`;
    });
    console.log(`[gpu] autoSelectGpu: sort=${sortBy}, top 5: ${topOffers.join(', ')}`);
  }

  // Prefer allowlisted GPUs, then fall back to any suitable GPU.
  // Providers use varying naming formats (e.g. "RTX 4090" vs "NVIDIA GeForce RTX 4090")
  // so we normalize names for comparison: strip "NVIDIA", "GeForce", spaces, and lowercase.
  const normalize = (s: string) => s.replace(/nvidia|geforce/gi, '').replace(/\s+/g, '').toLowerCase();
  const allowedNormalized = new Set([...allowed].map(normalize));
  const isAllowed = (o: GpuOffer) =>
    allowed.has(o.gpuType) || allowed.has(o.gpuName) ||
    allowedNormalized.has(normalize(o.gpuType)) || allowedNormalized.has(normalize(o.gpuName));
  const allowedOffers = ranked.filter(isAllowed);
  const prioritized = allowedOffers.length > 0 ? allowedOffers : ranked;
  if (allowedOffers.length === 0) {
    console.warn(`[gpu] autoSelectGpu: no offers match allowlist, using best available. Sample types: ${ranked.slice(0, 5).map(o => `${o.gpuName}(${o.gpuType})`).join(', ')}`);
  }

  // Deduplicate by gpuName (full name), keeping best effective-price offer for each type.
  // Return gpuName (not gpuType) so it matches provider createInstance expectations.
  const seen = new Set<string>();
  const uniqueTypes: string[] = [];
  for (const offer of prioritized) {
    const key = offer.gpuName || offer.gpuType;
    if (!seen.has(key)) {
      seen.add(key);
      // Use gpuName if it's a full name (e.g. "NVIDIA RTX A6000"), otherwise gpuType
      uniqueTypes.push(offer.gpuName || offer.gpuType);
      if (uniqueTypes.length >= maxResults) break;
    }
  }

  console.log(`[gpu] autoSelectGpu: ${ranked.length} suitable offers (${allowedOffers.length} in allowlist, ${gpuTypeReps.size} with reputation) → ${uniqueTypes.length} GPU types: ${uniqueTypes.join(', ')}`);
  return uniqueTypes;
}

// ── Deploy loop ─────────────────────────────────────────────────────────────

export interface DeployExtra { region?: string; storageGb?: number; hfToken?: string; env?: Record<string, string>; interruptible?: boolean; dockerStartCmd?: string; containerDiskInGb?: number; volumeId?: string; autoRecovery?: boolean; }


export async function startDeployLoop(
  providerClient: GpuProviderClient,
  providerName: ProviderName,
  apiKey: string,
  dockerImage: string,
  gpuTypes: string[],
  authId?: string,
  extra: DeployExtra = {},
) {
  setDeployCancelled(false); // reset cancel flag from previous deploy
  setActiveProvider(providerName);
  const credentials: ProviderCredentials = { apiKey, authId };
  const startedAt = Date.now();
  const label = PROVIDER_LABELS[providerName];
  setDeployState({
    status: 'searching', startedAt, retryCount: 0, podId: '', endpoint: '', gpuType: '',
    message: `Searching for GPU on ${label}...`, step: 'searching_offers', stepDetail: gpuTypes.join(', '), provider: providerName,
    dockerImage,
  });
  broadcastWs({ type: 'gpu:deploy', phase: 'searching', provider: providerName, gpuTypes });

  // TensorDock: try to discover and resume a stopped instance first (fast restart)
  if (providerName === 'tensordock') {
    try {
      console.log(`[gpu] TensorDock: checking for existing instances to resume...`);
      const existing = await providerClient.discoverInstance(credentials, gpuTypes);
      if (existing && existing.instanceId) {
        console.log(`[gpu] TensorDock: found instance ${existing.instanceId} (status=${existing.status}, endpoint=${existing.endpoint || 'none'})`);
        const isStopped = ['stopped', 'paused', 'suspended'].includes(existing.status?.toLowerCase() ?? '');
        const isRunning = ['running', 'active'].includes(existing.status?.toLowerCase() ?? '');
        if (isStopped) {
          console.log(`[gpu] TensorDock: found stopped instance ${existing.instanceId} — resuming`);
          setDeployState({ message: `Resuming stopped TensorDock instance...`, step: 'creating_pod' });
          logGpuEvent('instance_resumed', 'tensordock', true, { metadata: { instanceId: existing.instanceId } });
          await providerClient.startInstance(existing.instanceId, credentials);
          // Resolve endpoint after start
          let endpoint = existing.endpoint || '';
          if (!endpoint) {
            const resolved = await providerClient.resolveInstanceEndpoint(existing.instanceId, credentials);
            if (resolved) endpoint = resolved;
          }
          setDeployState({
            status: 'booting', podId: existing.instanceId, endpoint,
            gpuType: existing.gpuType || '', step: 'waiting_health',
            message: `TensorDock instance resumed, waiting for /health...`,
          });
          deploymentSM.startBooting(existing.instanceId);
          const { result: res1, pullTimeS: pt1 } = await pollHealthUntilReady(providerClient, providerName, apiKey, existing.instanceId, endpoint, startedAt, dockerImage, existing.providerMeta as Record<string, unknown>);
          if (res1 === 'ready') {
            const durationMs = Date.now() - deployState.startedAt;
            setGpuHealthy(true);
            setLastRequestTime(Date.now());
            setDeployState({ status: 'ready', message: `GPU ready (${label}): ${deployState.endpoint}`, step: 'ready', stepDetail: '', deployDurationMs: durationMs });
            broadcastProviderStatus('booting', 'cloud', `GPU deployed — warming up models`);
            deploymentSM.markReady(deployState.podId, deployState.endpoint, deployState.gpuType, deployState.costPerHr);
            console.log(`[gpu] Deploy completed in ${(durationMs / 1000).toFixed(1)}s (pull=${pt1 ?? '?'}s, ${label})`);
            if (pt1 != null) {
              const { recordPullTime, deriveHostKey: dk } = await import('../src/gpu-providers/pull-time-estimator');
              dk(providerName, existing.providerMeta as Record<string, unknown>);
              recordPullTime(dockerImage, pt1, undefined, dk(providerName, existing.providerMeta as Record<string, unknown>), Math.round(durationMs / 1000));
            }
            startGpuMonitoring();
            startBackgroundWarmthMonitor(deployState.endpoint);
            return;
          }
          if (res1 === 'cancelled') { setDeployState({ status: 'error', message: 'Deploy cancelled' }); deploymentSM.markError('Deploy cancelled'); return; }
          console.log(`[gpu] Resumed TensorDock instance failed health check — creating new`);
        } else if (isRunning && existing.endpoint) {
          console.log(`[gpu] TensorDock: found running instance ${existing.instanceId} at ${existing.endpoint}`);
          setDeployState({
            status: 'booting', podId: existing.instanceId, endpoint: existing.endpoint,
            gpuType: existing.gpuType || '', step: 'waiting_health',
            message: `TensorDock instance already running, checking health...`,
          });
          deploymentSM.startBooting(existing.instanceId);
          const { result: res2, pullTimeS: pt2 } = await pollHealthUntilReady(providerClient, providerName, apiKey, existing.instanceId, existing.endpoint, startedAt, dockerImage, existing.providerMeta as Record<string, unknown>);
          if (res2 === 'ready') {
            const durationMs = Date.now() - deployState.startedAt;
            setGpuHealthy(true);
            setLastRequestTime(Date.now());
            setDeployState({ status: 'ready', message: `GPU ready (${label}): ${deployState.endpoint}`, step: 'ready', stepDetail: '', deployDurationMs: durationMs });
            broadcastProviderStatus('booting', 'cloud', `GPU deployed — warming up models`);
            deploymentSM.markReady(deployState.podId, deployState.endpoint, deployState.gpuType, deployState.costPerHr);
            console.log(`[gpu] Deploy completed in ${(durationMs / 1000).toFixed(1)}s (pull=${pt2 ?? '?'}s, ${label})`);
            if (pt2 != null) {
              const { recordPullTime, deriveHostKey: dk } = await import('../src/gpu-providers/pull-time-estimator');
              recordPullTime(dockerImage, pt2, undefined, dk(providerName, existing.providerMeta as Record<string, unknown>), Math.round(durationMs / 1000));
            }
            startGpuMonitoring();
            startBackgroundWarmthMonitor(deployState.endpoint);
            return;
          }
          if (res2 === 'cancelled') { setDeployState({ status: 'error', message: 'Deploy cancelled' }); deploymentSM.markError('Deploy cancelled'); return; }
          console.log(`[gpu] Running TensorDock instance not healthy — creating new`);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[gpu] TensorDock discover/resume failed: ${errMsg} (will create new instance)`);
    }
  }

  for (let attempt = 0; attempt <= MAX_DEPLOY_RETRIES; attempt++) {
    if (deployCancelled) return;

    if (attempt > 0) {
      setDeployState({ retryCount: attempt, message: `Retry ${attempt + 1}/${MAX_DEPLOY_RETRIES + 1}: creating new ${label} instance...` });
      await new Promise(r => setTimeout(r, 5_000));
      if (deployCancelled) return;
    }

    try {
      // Transition: searching → creating (found offers, now creating instance)
      setDeployState({ status: 'creating', step: 'creating_pod', message: `Creating ${label} instance...` });
      broadcastWs({ type: 'gpu:deploy', phase: 'creating', provider: providerName });

      const defaultStorage = DEFAULT_STORAGE_GB[providerName];
      const storageGb = Math.max(extra.storageGb || defaultStorage, defaultStorage);
      const instance = await providerClient.createInstance(
        { gpuTypes, dockerImage, storageGb, region: extra.region, hfToken: extra.hfToken, env: extra.env, bareMetal: providerName === 'tensordock', interruptible: extra.interruptible,
          // IMPORTANT: RunPod must ALWAYS use SECURE cloud — NEVER COMMUNITY (unreliable third-party machines)
          ...(providerName === 'runpod' ? { cloudType: 'SECURE' as const } : {}),
          ...(extra.dockerStartCmd ? { dockerStartCmd: extra.dockerStartCmd } : {}),
          ...(extra.containerDiskInGb ? { containerDiskInGb: extra.containerDiskInGb } : {}),
          ...(extra.volumeId ? { volumeId: extra.volumeId } : {}),
        },
        credentials,
      );
      if (deployCancelled) {
        try { await providerClient.deleteInstance(instance.instanceId, credentials); }
        catch (err) { console.warn(`[gpu] Failed to clean up cancelled instance ${instance.instanceId}: ${err}`); }
        return;
      }
      const instanceCostPerHr = (instance.providerMeta?.dphTotal as number)
        || (instance.providerMeta?.costPerHr as number)
        || (instance.providerMeta?.pricePerHr as number)
        || 0;
      setDeployState({
        status: 'booting',
        podId: instance.instanceId,
        endpoint: instance.endpoint,
        gpuType: instance.gpuType || '',
        dockerImage,
        message: `Instance created (${instance.instanceId.slice(0, 8)}), pulling image...`,
        step: 'pulling_image',
        stepDetail: dockerImage,
        sshHost: instance.sshHost || '',
        sshPort: instance.sshPort || 0,
        costPerHr: instanceCostPerHr,
        providerMeta: { ...instance.providerMeta, gpuType: instance.gpuType || '' },
      });
      deploymentSM.startBooting(instance.instanceId);

      const { result, pullTimeS } = await pollHealthUntilReady(providerClient, providerName, apiKey, instance.instanceId, instance.endpoint, startedAt, dockerImage, instance.providerMeta);
      if (result === 'ready') {
        const durationMs = Date.now() - deployState.startedAt;
        setGpuHealthy(true);
        setLastRequestTime(Date.now());
        setDeployState({ status: 'ready', message: `GPU ready (${label}): ${deployState.endpoint}`, step: 'ready', stepDetail: '', deployDurationMs: durationMs });
            broadcastProviderStatus('booting', 'cloud', `GPU deployed — warming up models`);
        deploymentSM.markReady(deployState.podId, deployState.endpoint, deployState.gpuType, deployState.costPerHr);
        console.log(`[gpu] Deploy completed in ${(durationMs / 1000).toFixed(1)}s (pull=${pullTimeS ?? '?'}s, ${label})`);
        // Record pull time for adaptive timeout learning
        if (pullTimeS != null) {
          const { recordPullTime, deriveHostKey: dk } = await import('../src/gpu-providers/pull-time-estimator');
          const inetDown = (instance.providerMeta?.inetDown as number) || (instance.providerMeta?.inet_down as number);
          const hk = dk(providerName, instance.providerMeta);
          const bootTimeS = Math.round(durationMs / 1000);
          recordPullTime(dockerImage, pullTimeS, inetDown, hk, bootTimeS);
        }
        startGpuMonitoring();
        startBackgroundWarmthMonitor(deployState.endpoint);
        return;
      }

      if (result === 'cancelled') { setDeployState({ status: 'error', message: 'Deploy cancelled' }); deploymentSM.markError('Deploy cancelled'); return; }
      // instance crashed or timed out — fetch logs before cleanup
      console.log(`[gpu] Instance ${instance.instanceId} failed (${result}), fetching remote logs before cleanup...`);
      try {
        const remoteLogs = await fetchGpuLogs(instance.sshHost, instance.sshPort, instance.endpoint);
        console.log(`[gpu] ── Remote GPU Logs (${instance.instanceId}) ──\n${remoteLogs}\n── End GPU Logs ──`);
      } catch (logErr) {
        console.warn(`[gpu] Could not fetch remote logs: ${logErr}`);
      }
      console.log(`[gpu] Cleaning up crashed instance ${instance.instanceId}...`);
      try { await providerClient.deleteInstance(instance.instanceId, credentials); }
      catch (cleanupErr) {
        // If cleanup fails, don't continue creating new instances — the orphan will keep billing
        const errMsg = `Failed to clean up crashed instance ${instance.instanceId} on ${providerName}: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`;
        console.error(`[gpu] ${errMsg}`);
        setDeployState({ status: 'error', message: errMsg, podId: instance.instanceId });
        deploymentSM.markError(errMsg);
        return; // Stop deploy — orphan sweep will attempt cleanup later
      }
      continue;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gpu] ${label} create attempt ${attempt + 1}/${MAX_DEPLOY_RETRIES + 1} failed: ${msg}`);
      setDeployState({ message: `${label} create failed (attempt ${attempt + 1}): ${msg}` });

      // Non-retryable errors — fail immediately without wasting retries
      const lowerMsg = msg.toLowerCase();
      const isBilling = lowerMsg.includes('balance') || lowerMsg.includes('funds') || lowerMsg.includes('insufficient');
      const isAuth = lowerMsg.includes('authentication') || lowerMsg.includes('unauthorized')
        || lowerMsg.includes('forbidden') || lowerMsg.includes('api key') || lowerMsg.includes('invalid key');
      const isNoOffers = lowerMsg.includes('no gpus available') || lowerMsg.includes('0 offers') || lowerMsg.includes('no offers');
      if (isNoOffers) {
        setDeployState({ step: 'no_offers', message: `${label}: no GPUs available — trying next provider` });
        broadcastWs({ type: 'gpu:deploy', phase: 'no_offers', provider: providerName, gpuTypes });
      }
      const nonRetryable = isBilling || isAuth || isNoOffers;
      if (nonRetryable || attempt >= MAX_DEPLOY_RETRIES) {
        let errMsg: string;
        if (isBilling) {
          errMsg = `${label}: account balance too low — add funds and retry`;
        } else if (isAuth) {
          errMsg = `${label}: authentication failed — check API key in .env`;
        } else {
          errMsg = `${label} failed after ${MAX_DEPLOY_RETRIES + 1} attempts: ${msg}`;
        }
        console.error(`[gpu] ${label} deploy failed (non_retryable=${nonRetryable}, attempt=${attempt + 1}): ${msg}`);
        setDeployState({ status: 'error', message: errMsg });
        deploymentSM.markError(errMsg);
        return;
      }
    }
  }

  const exhaustedMsg = `${label} deploy failed: max retries exceeded`;
  setDeployState({ status: 'error', message: exhaustedMsg });
  deploymentSM.markError(exhaustedMsg);
}

// ── GPU Tier Configuration ──────────────────────────────────────────────────
// Tiers are tried in order (like ai-gateway autoscaler). If tier 0 fails,
// tier 1 is attempted automatically.

// ── Provider Cooldown (persisted to ~/.babelcast/cooldowns.json) ─────────────
export const cooldownTracker = new ProviderCooldownTracker();
cooldownTracker.loadFromFile(join(homedir(), '.babelcast', 'cooldowns.json'));
{
  const active = cooldownTracker.getActiveCooldowns();
  const names = Object.keys(active);
  if (names.length > 0) {
    console.log(`[gateway] Restored cooldowns: ${names.map(n => `${n} (${active[n].remainSec}s left)`).join(', ')}`);
  }
}

/** Map of provider name → client instance for tier building. */
export const providerClients: Record<ProviderName, GpuProviderClient> = { runpod, vast, tensordock, modal };

export function buildGpuTiers(runpodApiKey: string, vastApiKey?: string, tensordockOpts?: { apiKey: string; authId: string }, modalApiKey?: string): GpuTier[] {
  // Build a map of available providers
  const available: Record<string, GpuTier | null> = {
    runpod: runpodApiKey ? { client: runpod, name: 'runpod', label: PROVIDER_LABELS.runpod, apiKey: runpodApiKey } : null,
    tensordock: tensordockOpts ? { client: tensordock, name: 'tensordock', label: PROVIDER_LABELS.tensordock, apiKey: tensordockOpts.apiKey, authId: tensordockOpts.authId } : null,
    vast: vastApiKey ? { client: vast, name: 'vast', label: PROVIDER_LABELS.vast, apiKey: vastApiKey } : null,
    modal: modalApiKey ? { client: modal, name: 'modal', label: PROVIDER_LABELS.modal, apiKey: modalApiKey } : null,
  };

  // Respect PROVIDER_CHAIN order for GPU providers
  const tiers: GpuTier[] = [];
  const added = new Set<string>();
  const gpuInChain = PROVIDER_CHAIN.filter(p => p === 'runpod' || p === 'tensordock' || p === 'vast' || p === 'modal');

  // If chain has individual GPU providers, use their order
  if (gpuInChain.length > 0) {
    for (const name of gpuInChain) {
      const tier = available[name];
      if (tier && !added.has(name)) {
        tiers.push(tier);
        added.add(name);
      }
    }
  }

  // Add any providers not yet added (legacy "gpu" mode or providers not in chain)
  for (const [name, tier] of Object.entries(available)) {
    if (tier && !added.has(name)) {
      tiers.push(tier);
      added.add(name);
    }
  }

  return tiers;
}

/**
 * Classify a deploy failure into categories.
 *
 * Host-attributable (penalizes reputation):
 *   timeout, crashed, network, unknown
 *
 * Non-host (does NOT penalize reputation):
 *   billing, api_error, docker_image, cancelled
 */
function categorizeDeployFailure(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('balance') || m.includes('funds') || m.includes('insufficient') || m.includes('need at least')) return 'billing';
  if (m.includes('image') && (m.includes('pull') || m.includes('not found') || m.includes('manifest') || m.includes('registry'))) return 'docker_image';
  if (m.includes('docker') && (m.includes('error') || m.includes('failed'))) return 'docker_image';
  if (m.includes('cancelled') || m.includes('canceled')) return 'cancelled';
  if (m.includes('timed out') || m.includes('timeout')) return 'timeout';
  if (m.includes('crashed') || m.includes('exited') || m.includes('terminated')) return 'crashed';
  if (message.includes('API') || message.includes('401') || message.includes('403') || message.includes('500')) return 'api_error';
  if (m.includes('network') || m.includes('econnrefused') || m.includes('etimedout') || m.includes('fetch failed')) return 'network';
  return 'unknown';
}

// ── Hedged / Race Deploy ─────────────────────────────────────────────────────
// Launch raceCount instances in parallel, keep the first one that becomes healthy,
// terminate the rest. Reduces cold-start latency at the cost of wasted instance-minutes
// for the losers (typically <5min of cost during boot).

interface RaceCandidate {
  index: number;
  tier: GpuTier;
  instanceId: string;
  endpoint: string;
  gpuType: string;
  costPerHr: number;
  sshHost: string;
  sshPort: number;
  providerMeta: Record<string, unknown>;
}

export async function startDeployRace(
  tiers: GpuTier[],
  dockerImage: string,
  gpuTypes: string[],
  extra: DeployExtra,
  raceCount: number,
): Promise<void> {
  const deployStartedAt = Date.now();
  const raceN = Math.min(raceCount, 10); // cap at 10

  // Build (tier, gpuType) pair list using provider-interleaved ordering:
  // Prefer diversity across providers before repeating the same provider.
  // e.g. [Vast×4090, TDock×4090, Vast×A6000, TDock×A6000, Vast×4090 ...]
  // rather than [Vast×4090, Vast×A6000, TDock×4090, TDock×A6000 ...]
  const gpuList = gpuTypes.length > 0 ? gpuTypes : [null];
  // Build per-tier queues (ordered by GPU priority)
  const tierQueues: Array<Array<{ tier: GpuTier; gpuType: string | null }>> = tiers.map(t =>
    gpuList.map(g => ({ tier: t, gpuType: g })),
  );
  const pairs: Array<{ tier: GpuTier; gpuType: string | null }> = [];
  let round = 0;
  while (pairs.length < raceN * 2 + 1) { // generate enough to cycle
    let addedThisRound = 0;
    for (const q of tierQueues) {
      const idx = round < q.length ? round : round % q.length;
      pairs.push(q[idx]);
      addedThisRound++;
    }
    if (addedThisRound === 0) break;
    round++;
  }

  if (pairs.length === 0) {
    setDeployState({ status: 'error', message: 'No deployment tiers available for race' });
    deploymentSM.markError('No tiers available');
    return;
  }

  const slots = Array.from({ length: raceN }, (_, i) => {
    const { tier, gpuType } = pairs[i % pairs.length];
    return {
      index: i,
      tier,
      gpuTypes: gpuType ? [gpuType] : gpuTypes,
      tierDockerImage: tier.name === 'modal' ? `${import.meta.dir}/../../docker/modal/babelcast.py` : dockerImage,
    };
  });

  console.log(`[race] Hedged deploy: ${slots.length} slots across ${tiers.map(t => t.label).join(', ')}`);

  // Set credentials for all participating tiers
  for (const tier of tiers) {
    if (tier.name === 'runpod') setDeployApiKey(tier.apiKey);
    else if (tier.name === 'vast') setDeployVastApiKey(tier.apiKey);
    else if (tier.name === 'tensordock') { setDeployTensordockApiKey(tier.apiKey); setDeployTensordockAuthId(tier.authId ?? ''); }
    else if (tier.name === 'modal') setDeployModalApiKey(tier.apiKey);
  }

  setDeployState({
    status: 'creating', startedAt: deployStartedAt, retryCount: 0,
    podId: '', endpoint: '', gpuType: '',
    message: `Launching ${slots.length} instances in parallel...`,
    step: 'creating_pod', stepDetail: '', provider: slots[0].tier.name,
  });

  // Phase 1: Create all instances in parallel
  const createResults = await Promise.allSettled(slots.map(async (slot) => {
    const credentials = { apiKey: slot.tier.apiKey, authId: slot.tier.authId };
    const defaultStorage = DEFAULT_STORAGE_GB[slot.tier.name] || 50;
    const storageGb = Math.max(extra.storageGb || defaultStorage, defaultStorage);
    const instance = await Promise.race([
      slot.tier.client.createInstance(
        {
          gpuTypes: slot.gpuTypes, dockerImage: slot.tierDockerImage, storageGb,
          region: extra.region, hfToken: extra.hfToken, env: extra.env,
          bareMetal: slot.tier.name === 'tensordock', interruptible: extra.interruptible,
          ...(slot.tier.name === 'runpod' ? { cloudType: 'SECURE' as const } : {}),
          ...(extra.dockerStartCmd ? { dockerStartCmd: extra.dockerStartCmd } : {}),
          ...(extra.containerDiskInGb ? { containerDiskInGb: extra.containerDiskInGb } : {}),
          ...(extra.volumeId ? { volumeId: extra.volumeId } : {}),
        },
        credentials,
      ),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${slot.tier.name} createInstance timed out`)), 60_000)),
    ]);
    console.log(`[race] Slot ${slot.index}: created ${instance.instanceId.slice(0, 8)} (gpu=${instance.gpuType}, tier=${slot.tier.label})`);
    return { slot, instance };
  }));

  const candidates: RaceCandidate[] = [];
  for (const r of createResults) {
    if (r.status === 'fulfilled') {
      const { slot, instance } = r.value;
      const costPerHr = (instance.providerMeta?.dphTotal as number)
        || (instance.providerMeta?.costPerHr as number)
        || (instance.providerMeta?.pricePerHr as number) || 0;
      candidates.push({
        index: slot.index, tier: slot.tier,
        instanceId: instance.instanceId, endpoint: instance.endpoint,
        gpuType: instance.gpuType || '', costPerHr,
        sshHost: instance.sshHost || '', sshPort: instance.sshPort || 0,
        providerMeta: (instance.providerMeta as Record<string, unknown>) ?? {},
      });
    } else {
      console.warn(`[race] Slot create failed: ${r.reason}`);
    }
  }

  if (candidates.length === 0) {
    const msg = `All ${slots.length} race slots failed to create instances`;
    setDeployState({ status: 'error', message: msg });
    deploymentSM.markError(msg);
    return;
  }

  console.log(`[race] ${candidates.length}/${slots.length} instances created — racing to first healthy`);
  // Register all race candidates so the orphan sweep doesn't mistake them for orphans
  for (const c of candidates) activeRaceInstanceIds.add(c.instanceId);
  setDeployState({
    status: 'booting', podId: candidates[0].instanceId,
    endpoint: candidates[0].endpoint, gpuType: candidates[0].gpuType,
    costPerHr: candidates[0].costPerHr, provider: candidates[0].tier.name,
    message: `${candidates.length} instances booting — racing to first healthy...`,
    step: 'waiting_health',
  });
  deploymentSM.startBooting(candidates[0].instanceId);

  // Phase 2: Race health polling — first healthy wins, others are terminated
  // AbortController lets the winner signal all losers instantly (no 5s sleep delay).
  const raceAbort = new AbortController();
  let winner: RaceCandidate | null = null;
  let raceDone = false;

  /** Abortable sleep: resolves after `ms` or immediately when raceAbort fires.
   *  Guards against the signal being already aborted before addEventListener is called. */
  const raceSleep = (ms: number) =>
    new Promise<void>(resolve => {
      if (raceAbort.signal.aborted) { resolve(); return; }
      const t = setTimeout(resolve, ms);
      raceAbort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });

  // Wrap in try/finally to guarantee loser cleanup even if Promise.all throws
  try {
  await Promise.all(candidates.map(async (c, idx) => {
    const credentials = { apiKey: c.tier.apiKey, authId: c.tier.authId };
    let localEndpoint = c.endpoint;
    const timeoutMs = getDeployTimeoutMin() * 60_000;

    while (!raceDone && !deployCancelled) {
      if (Date.now() - deployStartedAt > timeoutMs) {
        console.log(`[race] Slot ${idx} timed out`);
        break;
      }

      // Re-resolve endpoint (needed for Vast.ai and others that assign ports mid-boot)
      if (!localEndpoint || c.tier.name === 'vast') {
        try {
          const resolved = await Promise.race([
            c.tier.client.resolveInstanceEndpoint(c.instanceId, credentials),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${c.tier.name} resolveInstanceEndpoint timed out`)), 30_000)),
          ]);
          if (resolved && resolved !== localEndpoint) {
            localEndpoint = resolved;
            if (idx === 0) setDeployState({ endpoint: localEndpoint });
          }
        } catch { /* expected during early boot */ }
      }

      // Probe /health
      if (localEndpoint && !raceDone) {
        try {
          const res = await fetch(`${localEndpoint}/health`, { signal: AbortSignal.timeout(8000) });
          if (res.ok) {
            const data = await res.json() as { status?: string };
            const HEALTHY = new Set(['healthy', 'ok', 'degraded', 'ready']);
            if (HEALTHY.has(data.status ?? '')) {
              if (!raceDone) {
                // Winner — update global state and abort all other slots immediately
                raceDone = true;
                raceAbort.abort(); // wake up sleeping losers right away
                const durationMs = Date.now() - deployStartedAt;
                winner = { ...c, endpoint: localEndpoint };
                setGpuHealthy(true);
                setLastRequestTime(Date.now());
                updateGpuModelWarmth(data as Record<string, unknown>);
                setDeployState({
                  status: 'ready',
                  podId: c.instanceId, endpoint: localEndpoint, gpuType: c.gpuType,
                  costPerHr: c.costPerHr, provider: c.tier.name,
                  sshHost: c.sshHost, sshPort: c.sshPort, providerMeta: c.providerMeta,
                  message: `GPU ready (race ${candidates.length}→1, ${Math.round(durationMs / 1000)}s): ${localEndpoint}`,
                  step: 'ready', stepDetail: '', deployDurationMs: durationMs,
                });
                broadcastProviderStatus('booting', 'cloud', 'GPU deployed — warming up models');
                deploymentSM.markReady(c.instanceId, localEndpoint, c.gpuType, c.costPerHr);
                startGpuMonitoring();
                startBackgroundWarmthMonitor(localEndpoint);
                console.log(`[race] Slot ${idx} won! (${c.tier.label}, gpu=${c.gpuType}, t=${Math.round(durationMs / 1000)}s)`);
                logGpuEvent('deploy_ready', c.tier.name, true, { durationMs, metadata: { endpoint: localEndpoint, gpuType: c.gpuType, raceCount: candidates.length } });
                upsertHostReputation({ provider: c.tier.name, gpuType: c.gpuType, providerMeta: c.providerMeta, success: true, bootTimeS: Math.round(durationMs / 1000), dockerImage });
                if (cooldownTracker.recordSuccess(c.tier.name)) {
                  logGpuEvent('cooldown_cleared', c.tier.name, true, { durationMs });
                }
              }
              return; // exit this slot's polling loop
            }
          }
        } catch { /* health probe failed — keep trying */ }
      }

      if (idx === 0 && !raceDone) {
        const elapsed = Math.round((Date.now() - deployStartedAt) / 1000);
        setDeployState({ message: `${candidates.length} instances booting... [${elapsed}s]` });
      }

      await raceSleep(5000); // aborted immediately when winner is found
    }

    // Loser, timed out, or cancelled — terminate the instance and log wasted cost
    if (!winner || winner.instanceId !== c.instanceId) {
      const reason = raceDone ? 'lost' : deployCancelled ? 'cancelled' : 'timed out';
      const aliveMs = Date.now() - deployStartedAt;
      const wastedUsd = c.costPerHr > 0 ? c.costPerHr * aliveMs / 3_600_000 : 0;
      try {
        await Promise.race([
          c.tier.client.deleteInstance(c.instanceId, credentials),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${c.tier.name} deleteInstance timed out`)), 15_000)),
        ]);
        console.log(
          `[race] Slot ${idx} terminated (${reason}): ${c.instanceId.slice(0, 8)}, ` +
          `alive=${Math.round(aliveMs / 1000)}s` +
          (wastedUsd > 0 ? `, wasted≈$${wastedUsd.toFixed(3)}` : ''),
        );
      } catch (err) {
        console.warn(`[race] Failed to terminate slot ${idx} (${reason}): ${err}`);
      }
    }
  }));
  } catch (raceErr) {
    // Promise.all threw — some slots may not have cleaned up their pods.
    // Force-terminate any non-winner instances that are still alive.
    console.error(`[race] Promise.all exception — force-cleaning ${candidates.length} race instances:`, raceErr);
    // TS narrows `winner` to `never` in this catch block because all assignments
    // live inside Promise callbacks. Re-cast to match the declared type.
    const winnerCandidate = winner as RaceCandidate | null;
    for (const c of candidates) {
      if (winnerCandidate && winnerCandidate.instanceId === c.instanceId) continue;
      try {
        await Promise.race([
          c.tier.client.deleteInstance(c.instanceId, { apiKey: c.tier.apiKey, authId: c.tier.authId }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
        ]);
        console.log(`[race] Force-cleaned ${c.instanceId.slice(0, 8)} on ${c.tier.name}`);
      } catch { /* best effort */ }
    }
  } finally {
    // Always clear race tracking — sweep may now treat any remaining instances as orphans
    for (const c of candidates) activeRaceInstanceIds.delete(c.instanceId);
  }

  // Phase 3: Final state / race summary
  if (winner) {
    const w = winner as RaceCandidate;
    const winnerBootMs = w.costPerHr > 0
      ? candidates.find(c => c.instanceId === w.instanceId)
        ? Date.now() - deployStartedAt : 0
      : 0;
    const loserCount = candidates.length - 1;
    if (loserCount > 0) {
      const w = winner as RaceCandidate;
      const totalWastedUsd = candidates
        .filter(c => c.instanceId !== w.instanceId)
        .reduce((sum, c) => sum + (c.costPerHr > 0 ? c.costPerHr * (Date.now() - deployStartedAt) / 3_600_000 : 0), 0);
      console.log(
        `[race] Summary: ${candidates.length} instances → winner in ${Math.round(winnerBootMs / 1000)}s, ` +
        `${loserCount} loser(s) terminated, total wasted≈$${totalWastedUsd.toFixed(3)}`,
      );
    }
  } else {
    const msg = deployCancelled ? 'Deploy cancelled' : 'All race candidates failed to become healthy';
    setDeployState({ status: 'error', message: msg });
    deploymentSM.markError(msg);
  }
}

export async function startDeployWithTiers(tiers: GpuTier[], dockerImage: string, gpuTypes: string[], extra: DeployExtra = {}, gpuTypesByProvider?: Record<string, string[]>) {
  // Filter out providers in cooldown
  let availableTiers = tiers.filter(t => {
    if (cooldownTracker.isCoolingDown(t.name)) {
      const remainSec = cooldownTracker.getRemainingSeconds(t.name);
      console.log(`[gpu] Skipping ${t.label} (cooldown, ${remainSec}s remaining)`);
      logGpuEvent('cooldown_skip', t.name, false, {
        failCount: cooldownTracker.getFailCount(t.name),
        metadata: { remainSec },
      });
      return false;
    }
    return true;
  });

  if (availableTiers.length === 0 && tiers.length > 0) {
    const earliestName = cooldownTracker.pickEarliestExpiry(tiers.map(t => t.name));
    const earliest = tiers.find(t => t.name === earliestName) ?? tiers[0];
    console.log(`[gpu] All providers in cooldown, trying ${earliest.label} anyway (forced=${tiers.length === 1}, tiers=${tiers.map(t => t.name).join(',')})`);
    availableTiers = [earliest];
  }

  // Probe all providers in parallel (20s timeout) to check availability before committing
  if (availableTiers.length > 1) {
    const probeResults = await Promise.allSettled(
      availableTiers.map(async (tier) => {
        const start = Date.now();
        try {
          if (!tier.client.listOffers) return { tier, available: true, ms: 0, offerCount: 0 };
          const offers = await Promise.race([
            tier.client.listOffers({ limit: 3 }, { apiKey: tier.apiKey, authId: tier.authId }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 20_000)),
          ]);
          return { tier, available: offers.length > 0, offerCount: offers.length, ms: Date.now() - start };
        } catch {
          return { tier, available: false, offerCount: 0, ms: Date.now() - start };
        }
      }),
    );

    // Reorder tiers: available first, then by response time
    const probed = probeResults
      .filter((r): r is PromiseFulfilledResult<{tier: GpuTier; available: boolean; ms: number; offerCount: number}> => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => (b.available ? 1 : 0) - (a.available ? 1 : 0) || a.ms - b.ms);

    const reorderedTiers = probed.map(p => p.tier);
    if (reorderedTiers.length > 0) {
      console.log(`[gpu] Provider probe: ${probed.map(p => `${p.tier.label}(${p.available ? p.offerCount + ' offers' : 'unavailable'}, ${p.ms}ms)`).join(', ')}`);
      availableTiers = reorderedTiers;
    }
  }

  for (let i = 0; i < availableTiers.length; i++) {
    const tier = availableTiers[i];
    if (deployCancelled) return;

    // Track active credentials
    if (tier.name === 'runpod') setDeployApiKey(tier.apiKey);
    else if (tier.name === 'vast') setDeployVastApiKey(tier.apiKey);
    else if (tier.name === 'tensordock') { setDeployTensordockApiKey(tier.apiKey); setDeployTensordockAuthId(tier.authId ?? ''); }
    else if (tier.name === 'modal') setDeployModalApiKey(tier.apiKey);

    const tierStartedAt = Date.now();
    logGpuEvent('deploy_started', tier.name, true);
    startDeploySession(tier.name, dockerImage, gpuTypes[0] ?? '');

    try {
      // Modal uses a deploy script, not a Docker image — resolve to absolute path
      const tierDockerImage = tier.name === 'modal'
        ? `${import.meta.dir}/../../docker/modal/babelcast.py`
        : dockerImage;
      const tierGpuTypes = gpuTypesByProvider?.[tier.name] ?? gpuTypes;
      console.log(`[gpu] Starting ${tier.label} deploy loop (tier ${i + 1}/${availableTiers.length}, GPUs: ${tierGpuTypes.slice(0,3).map(g=>g.replace('NVIDIA ','').replace('GeForce ','')).join(', ')}...)`);
      await startDeployLoop(tier.client, tier.name, tier.apiKey, tierDockerImage, tierGpuTypes, tier.authId, extra);
      const durationMs = Date.now() - tierStartedAt;
      if (deployState.status === 'ready') {
        console.log(`[gpu] ✓ ${tier.label} deploy succeeded in ${Math.round(durationMs / 1000)}s`);
        logGpuEvent('deploy_ready', tier.name, true, { durationMs, metadata: { endpoint: deployState.endpoint, gpuType: deployState.gpuType } });
        updateDeploySession({
          status: 'ready',
          podId: deployState.podId,
          endpoint: deployState.endpoint,
          gpuType: deployState.gpuType,
          region: deployState.sshHost ? 'ssh' : '',
          costPerHr: deployState.costPerHr,
          provisionTimeS: Math.round(durationMs / 1000),
        });
        // Record successful deploy in host reputation
        upsertHostReputation({
          provider: tier.name,
          gpuType: deployState.gpuType,
          providerMeta: deployState.providerMeta,
          success: true,
          bootTimeS: Math.round(durationMs / 1000),
          dockerImage,
          costUsd: deployState.costPerHr > 0 ? deployState.costPerHr * (durationMs / 1000 / 3600) : undefined,
        });
        if (cooldownTracker.recordSuccess(tier.name)) {
          logGpuEvent('cooldown_cleared', tier.name, true, { durationMs });
        }
        return;
      }
      // Deploy loop returned without reaching 'ready' or 'error' — treat as failure
      if (deployState.status !== 'error') {
        const msg = `${tier.label} deploy ended without reaching ready (status=${deployState.status}, elapsed=${Math.round(durationMs / 1000)}s)`;
        console.warn(`[gpu] ${msg}`);
        setDeployState({ status: 'error', message: msg });
      }
    } catch (err) {
      const durationMs = Date.now() - tierStartedAt;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[gpu] ✗ ${tier.label} deploy failed after ${Math.round(durationMs / 1000)}s: ${errMsg}`);
      if (deployState.status !== 'error') {
        setDeployState({ status: 'error', message: `${tier.label} deploy failed: ${errMsg}` });
      }
    }

    // Detect silent failures: deploy returned to idle without error or ready
    if (deployState.status === 'idle') {
      const msg = `${tier.label} deploy returned to idle unexpectedly — possible silent failure`;
      console.error(`[gpu] ${msg}`);
      setDeployState({ status: 'error', message: msg });
    }

    if (deployState.status === 'error') {
      const durationMs = Date.now() - tierStartedAt;
      const failureCategory = categorizeDeployFailure(deployState.message ?? '');
      logGpuEvent('deploy_failed', tier.name, false, { durationMs, error: deployState.message, metadata: { failureCategory } });
      updateDeploySession({ status: 'failed', errorMessage: deployState.message ?? '' });
      // Record failed deploy in host reputation
      // Non-host failures (billing, docker_image, api_error) don't penalize the host's score
      upsertHostReputation({
        provider: tier.name,
        gpuType: deployState.gpuType,
        providerMeta: deployState.providerMeta,
        success: false,
        bootTimeS: Math.round(durationMs / 1000),
        dockerImage,
        failureCategory,
      });
      if (failureCategory === 'billing') {
        cooldownTracker.recordBillingFailure(tier.name);
        console.log(`[gpu] ${tier.name} billing cooldown set: ${cooldownTracker.getRemainingSeconds(tier.name)}s — add funds to resume`);
      } else {
        cooldownTracker.recordFailure(tier.name);
        console.log(`[gpu] ${tier.name} cooldown set: ${cooldownTracker.getRemainingSeconds(tier.name)}s (fail #${cooldownTracker.getFailCount(tier.name)})`);
      }
    }

    // If this tier failed and there's a next tier, set fallback alert
    if (i < availableTiers.length - 1 && deployState.status === 'error') {
      const next = availableTiers[i + 1];
      const alertMsg = `${tier.label} indisponível — usando ${next.label} como fallback.`;
      console.warn(`[gpu] ⚠️ ${alertMsg}`);
      setDeployState({
        status: 'creating', provider: next.name, step: 'creating_pod',
        message: `${tier.label} indisponível. Tentando ${next.label}...`,
        alert: alertMsg,
      });
    }
  }

  // Final guard: if all tiers were tried and deploy isn't ready, ensure error state
  if (deployState.status !== 'ready' && deployState.status !== 'error') {
    const labels = availableTiers.map(t => t.label).join(', ');
    const lastMsg = deployState.message || 'unknown';
    const msg = `All ${availableTiers.length} provider(s) failed (${labels}). Last error: ${lastMsg}`;
    console.error(`[gpu] Deploy exhausted: ${msg}`);
    setDeployState({ status: 'error', message: msg });
    deploymentSM.markError(msg);
  }

  // If deploy failed and only one tier was provided (forced provider), append context
  if (deployState.status === 'error' && tiers.length === 1) {
    const originalMsg = deployState.message || 'unknown error';
    setDeployState({
      message: `${originalMsg} (no fallback — provider was forced)`,
    });
  }
}

export interface PollHealthResult {
  result: 'ready' | 'exited' | 'timeout' | 'cancelled' | 'crashed';
  pullTimeS?: number;  // actual measured pull duration (pullStarted → containerStarted)
}

export async function pollHealthUntilReady(
  providerClient: GpuProviderClient,
  providerName: string,
  apiKey: string,
  podId: string,
  endpoint: string,
  deployStartedAt: number,
  dockerImage?: string,
  providerMeta?: Record<string, unknown>,
): Promise<PollHealthResult> {
  const credentials: ProviderCredentials = { apiKey };
  let consecutiveExited = 0;
  let containerStartedAt = 0;
  let healthRespondedOnce = false;   // true after first /health 200
  let healthFirstResponseAt = 0;     // timestamp of first /health response
  let allServicesLoaded = false;     // true when all STT+LLM+TTS report loaded
  let pullStartedAt = 0;             // timestamp when image pull phase began
  let actualPullTimeS: number | undefined;  // measured pull duration
  let consecutiveHealthFailures = 0;       // health failures while container is supposedly running
  let firstNonTransientErrorAt = 0;        // timestamp when non-transient HTTP errors started
  let consecutiveNonTransient = 0;         // consecutive 4xx responses from /health

  // ── Adaptive pull timeout ──────────────────────────────────────────────
  const { estimatePullTimeout, deriveHostKey: deriveKey } = await import('../src/gpu-providers/pull-time-estimator');
  const inetDown = (providerMeta?.inetDown as number) || (providerMeta?.inet_down as number) || 500;
  const diskGb = (providerMeta?.diskGb as number) || 20;
  const hostKey = deriveKey(providerName, providerMeta);
  const pullEstimate = await estimatePullTimeout({
    dockerImage: dockerImage || 'unknown',
    inetDownMbps: inetDown,
    diskGb,
    hostKey,
  });
  console.log(`[gpu] Pull timeout: ${Math.round(pullEstimate.timeoutMs / 1000)}s (${pullEstimate.confidence}: ${pullEstimate.basis})`);

  while (true) {
    if (deployCancelled) return { result: 'cancelled' };
    const deployTimeoutMs = getDeployTimeoutMin() * 60_000;
    const totalElapsedMs = Date.now() - deployStartedAt;

    // ── Per-phase timeouts (fail fast, try next machine) ──
    const PHASE_TIMEOUTS = {
      IMAGE_PULL:  pullEstimate.timeoutMs,  // ADAPTIVE — based on image size + host speed
      BOOT:        5 * 60_000,   // 5 min — models download before uvicorn starts on some images
      MODELS:     10 * 60_000,   // 10 min — HuggingFace model download + load after /health
    };

    // Image pull timeout — track from when pull actually started, not deploy start
    if (!containerStartedAt && pullStartedAt > 0 && (Date.now() - pullStartedAt) > PHASE_TIMEOUTS.IMAGE_PULL) {
      const pullSec = Math.round((Date.now() - pullStartedAt) / 1000);
      const timeoutMsg = `Image pull timeout (${pullSec}s pulling) — machine too slow, trying next`;
      console.warn(`[gpu] ${providerName} pod ${podId}: ${timeoutMsg}`);
      broadcastWs({ type: 'gpu:deploy', phase: 'pull_timeout', provider: providerName, elapsedMs: totalElapsedMs });
      setDeployState({ status: 'error', step: 'pulling_image', message: timeoutMsg });
      return { result: 'timeout', pullTimeS: actualPullTimeS };
    }

    // Boot timeout — container started but /health never responded
    if (containerStartedAt && !healthRespondedOnce && (Date.now() - containerStartedAt) > PHASE_TIMEOUTS.BOOT) {
      const bootSec = Math.round((Date.now() - containerStartedAt) / 1000);
      const timeoutMsg = `Boot timeout (${bootSec}s) — container up but /health not responding`;
      console.warn(`[gpu] ${providerName} pod ${podId}: ${timeoutMsg}`);
      broadcastWs({ type: 'gpu:deploy', phase: 'boot_timeout', provider: providerName });
      setDeployState({ status: 'error', step: 'waiting_health', message: timeoutMsg });
      return { result: 'timeout', pullTimeS: actualPullTimeS };
    }

    // Model loading timeout — /health responds but services still downloading
    if (healthRespondedOnce && !allServicesLoaded && (Date.now() - (healthFirstResponseAt || Date.now())) > PHASE_TIMEOUTS.MODELS) {
      const modelSec = Math.round((Date.now() - (healthFirstResponseAt || Date.now())) / 1000);
      const timeoutMsg = `Model loading timeout (${modelSec}s) — services still downloading`;
      console.warn(`[gpu] ${providerName} pod ${podId}: ${timeoutMsg}`);
      broadcastWs({ type: 'gpu:deploy', phase: 'model_timeout', provider: providerName });
      setDeployState({ status: 'error', step: 'downloading_models', message: timeoutMsg });
      return { result: 'timeout', pullTimeS: actualPullTimeS };
    }

    // Ghost machine detection (RunPod) — pod created but machine silently unassigned.
    // RunPod may return 200 on create but then fail to schedule the pod onto a physical
    // machine (e.g. insufficient local disk, GPU type temporarily unavailable). The pod
    // stays in desiredStatus=RUNNING but machine={} and runtime=null indefinitely.
    // Check after 90s of no container start — enough for image pull to begin on a real machine.
    if (!containerStartedAt && providerName === 'runpod' && totalElapsedMs > 90_000) {
      try {
        const { RunpodClient } = await import('../src/gpu-providers/runpod-client');
        if (providerClient instanceof RunpodClient) {
          const detail = await providerClient.getInstanceDetail(podId, credentials);
          if (detail?.ghostMachine) {
            const ghostMsg = `Ghost machine — pod created but no physical machine assigned after ${Math.round(totalElapsedMs / 1000)}s. RunPod silently failed to schedule (check storage size, GPU availability).`;
            console.error(`[gpu] ${providerName} pod ${podId}: ${ghostMsg}`);
            broadcastWs({ type: 'gpu:deploy', phase: 'ghost_machine', provider: providerName, elapsedMs: totalElapsedMs });
            setDeployState({ status: 'error', step: 'ghost_machine', message: ghostMsg });
            // Clean up the ghost pod
            try { await providerClient.deleteInstance(podId, credentials); } catch { /* best effort */ }
            return { result: 'crashed', pullTimeS: actualPullTimeS };
          }
        }
      } catch { /* best-effort ghost detection */ }
    }

    // Overall deploy timeout (safety net)
    if (totalElapsedMs > deployTimeoutMs) {
      const phase = containerStartedAt ? 'waiting for /health' : 'pulling image';
      const timeoutMsg = `Overall timeout after ${getDeployTimeoutMin()} min (stuck ${phase})`;
      console.error(`[gpu] ${providerName} pod ${podId} timed out: ${phase}, endpoint=${endpoint || 'none'}`);
      setDeployState({ status: 'error', message: timeoutMsg });
      return { result: 'timeout', pullTimeS: actualPullTimeS };
    }

    const elapsed = Math.round((Date.now() - deployStartedAt) / 1000);

    // Provider-specific status polling
    if (providerName === 'runpod') {
      // RunPod: rich detail via getInstanceDetail()
      try {
        const detail = await (providerClient as RunpodClient).getInstanceDetail(podId, credentials);
        if (detail) {
          if (detail.desiredStatus === 'EXITED') {
            consecutiveExited++;
            if (consecutiveExited >= 2) return { result: 'exited', pullTimeS: actualPullTimeS };
          } else {
            consecutiveExited = 0;
          }

          if (detail.gpuType) setDeployState({ gpuType: detail.gpuType });
          if (detail.costPerHr) setDeployState({ costPerHr: detail.costPerHr });
          const costStr = detail.costPerHr ? `$${detail.costPerHr.toFixed(3)}/h` : '';

          if (!detail.runtime) {
            if (!pullStartedAt) pullStartedAt = Date.now();
            setDeployState({
              status: 'installing', step: 'pulling_image',
              message: `Pulling image & starting container... [${elapsed}s]`,
              stepDetail: [detail.imageName, detail.gpuType, costStr].filter(Boolean).join(' — '),
            });
          } else if (!containerStartedAt) {
            containerStartedAt = Date.now();
            if (pullStartedAt > 0) actualPullTimeS = Math.round((containerStartedAt - pullStartedAt) / 1000);
            const newEndpoint = await providerClient.resolveInstanceEndpoint(podId, credentials);
            if (newEndpoint && newEndpoint !== endpoint) {
              endpoint = newEndpoint;
              setDeployState({ endpoint });
            }
            setDeployState({
              status: 'booting', step: 'starting_container',
              message: `Container running, loading models... [${elapsed}s]`,
              stepDetail: [detail.gpuType, costStr].filter(Boolean).join(' — '),
            });
          } else {
            const appElapsed = Math.round((Date.now() - containerStartedAt) / 1000);
            setDeployState({
              status: 'booting', step: 'waiting_health',
              message: `App starting, waiting for /health... [${elapsed}s, container up ${appElapsed}s]`,
              stepDetail: [detail.gpuType, costStr].filter(Boolean).join(' — '),
            });
          }
        }
      } catch (err) {
        console.warn(`[gpu] Failed to get RunPod detail for pod ${podId}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      // Vast.ai (and other providers): use GpuProviderClient interface
      try {
        const status = await providerClient.getInstanceStatus(podId, credentials);
        if (status) {
          const statusLower = status.toLowerCase();
          const TERMINAL = new Set(['exited', 'failed', 'destroyed', 'error', 'deleted']);
          // TensorDock: stoppeddisassociated = GPU reclaimed by hostnode (unstable host)
          const DISASSOCIATED = statusLower === 'stoppeddisassociated' || statusLower === 'stopped_disassociated';
          if (TERMINAL.has(statusLower) || DISASSOCIATED) {
            consecutiveExited++;
            if (DISASSOCIATED) {
              console.warn(`[gpu] ${providerName} instance ${podId} GPU disassociated (hostnode reclaimed GPU)`);
              setDeployState({ alert: `GPU disassociated — hostnode reclaimed the GPU. Will retry on a more stable host.` });
            }
            if (consecutiveExited >= 2) return { result: 'exited', pullTimeS: actualPullTimeS };
          } else {
            consecutiveExited = 0;
          }

          const isRunning = ['running', 'active'].includes(statusLower);
          if (isRunning && !containerStartedAt) {
            containerStartedAt = Date.now();
            if (pullStartedAt > 0) actualPullTimeS = Math.round((containerStartedAt - pullStartedAt) / 1000);
          }

          if (!containerStartedAt) {
            // Distinguish queued (allocated, waiting for slot) vs pulling image
            // Vast.ai: 'created' = allocated waiting, 'loading' = pulling Docker image
            const isQueued = ['created', 'pending', 'queued', 'provisioning'].includes(statusLower);
            const isPulling = ['loading', 'pulling', 'starting', 'initializing'].includes(statusLower) || (!isQueued && !isRunning);
            if (isQueued) {
              setDeployState({
                status: 'queued', step: 'queued',
                message: `GPU allocated, waiting in queue... [${elapsed}s]`,
                stepDetail: deployState.gpuType || '',
              });
            } else {
              if (!pullStartedAt) pullStartedAt = Date.now();
              setDeployState({
                status: 'installing', step: 'pulling_image',
                message: `Pulling Docker image... [${elapsed}s]`,
                stepDetail: deployState.gpuType || '',
              });
            }
          } else {
            const appElapsed = Math.round((Date.now() - containerStartedAt) / 1000);
            setDeployState({
              status: 'booting', step: 'waiting_health',
              message: `Container running, waiting for /health... [${elapsed}s, up ${appElapsed}s]`,
              stepDetail: deployState.gpuType || '',
            });
          }
        }
      } catch (err) {
        console.warn(`[gpu] Failed to get ${providerName} status for pod ${podId}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Re-resolve endpoint periodically (provider may assign IP mid-boot)
    // For Vast.ai, always re-resolve since port mapping arrives after container starts
    if (!containerStartedAt || !endpoint || providerName === 'vast') {
      try {
        const resolved = await providerClient.resolveInstanceEndpoint(podId, credentials);
        if (resolved && resolved !== endpoint) {
          console.log(`[gpu] ${providerName} endpoint resolved: ${endpoint || '(none)'} → ${resolved}`);
          endpoint = resolved;
          setDeployState({ endpoint });
        }
      } catch (err) {
        if (containerStartedAt) console.warn(`[gpu] Failed to resolve ${providerName} endpoint for pod ${podId}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // SSH tunnel fallback: if container is running but no direct endpoint after 60s, open SSH tunnel
    if (!endpoint && containerStartedAt && (Date.now() - containerStartedAt) > 60_000 && deployState.sshHost && deployState.sshPort) {
      try {
        const { getOrCreateTunnel } = await import('./ssh-tunnel');
        const tunnel = getOrCreateTunnel(deployState.sshHost, deployState.sshPort, 8000);
        if (!tunnel.isOpen) {
          console.log(`[gpu] No direct endpoint — opening SSH tunnel to ${deployState.sshHost}:${deployState.sshPort}`);
          setDeployState({ step: 'ssh_tunnel', message: `Opening SSH tunnel (no direct port)...` });
          const ok = await tunnel.open();
          if (ok) {
            endpoint = tunnel.endpoint;
            setDeployState({ endpoint, message: `SSH tunnel active: ${endpoint}` });
            console.log(`[gpu] SSH tunnel established: ${endpoint}`);
          } else {
            console.warn(`[gpu] SSH tunnel failed to ${deployState.sshHost}:${deployState.sshPort}`);
          }
        } else {
          endpoint = tunnel.endpoint;
        }
      } catch (err) {
        console.warn(`[gpu] SSH tunnel error: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Probe /health (with HTTP status tracking for crash detection)
    if (endpoint) {
      let httpStatus = 0;
      try {
        const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(8000) });
        httpStatus = res.status;
        if (res.ok) {
          const data = await res.json();
          // Update per-stage warmth from health response (services.tts/whisper/llama_cpp)
          updateGpuModelWarmth(data);
          const HEALTHY_STATUSES = new Set(['healthy', 'ok', 'degraded', 'ready']);
          if (HEALTHY_STATUSES.has(data.status)) {
            // Track health response milestones for per-phase timeouts
            if (!healthRespondedOnce) { healthRespondedOnce = true; healthFirstResponseAt = Date.now(); }
            consecutiveHealthFailures = 0;

            const svc = data.services ?? {};
            const ttsReady = svc.tts === 'loaded' || svc.tts === 'disabled';
            const sttReady = svc.whisper === 'loaded';
            const llmReady = svc.llama_cpp === 'ready' || svc.llama_cpp === 'loaded';
            allServicesLoaded = sttReady && llmReady && ttsReady;
            const readyStages = [sttReady && 'STT', llmReady && 'LLM', ttsReady && 'TTS'].filter(Boolean);
            const loadingStages = [!sttReady && 'STT', !llmReady && 'LLM', !ttsReady && 'TTS'].filter(Boolean);

            // Mark as ready as soon as /health responds OK — even if some models are still downloading.
            // Per-service routing handles this: cloud serves stages that aren't loaded yet.
            // The warmth monitor will activate each service as it becomes ready.
            if (readyStages.length > 0 || containerStartedAt) {
              const stepDetail = loadingStages.length > 0
                ? `${readyStages.join(', ') || 'none'} ready — loading: ${loadingStages.join(', ')}`
                : 'all services loaded';
              console.log(`[gpu] Pod health OK — ${readyStages.length}/3 services loaded (${readyStages.join(', ') || 'none'}). Loading: ${loadingStages.join(', ') || 'none'}`);
              broadcastWs({ type: 'gpu:services', loaded: readyStages, loading: loadingStages });
              setDeployState({ step: 'ready', stepDetail });
              return { result: 'ready', pullTimeS: actualPullTimeS };
            }

            // /health OK but no services loaded yet — show granular model download status
            if (!containerStartedAt) {
              containerStartedAt = Date.now();
              if (pullStartedAt > 0) actualPullTimeS = Math.round((containerStartedAt - pullStartedAt) / 1000);
            }
            const appElapsed = Math.round((Date.now() - containerStartedAt) / 1000);

            // Determine most specific loading step
            const whisperStatus = svc.whisper || svc.stt || '';
            const llamaStatus = svc.llama_cpp || svc.llm || '';
            const ttsStatus = svc.tts || '';
            let modelStep = 'downloading_models';
            let modelDetail = '';

            if (whisperStatus === 'downloading') {
              modelStep = 'loading_stt';
              modelDetail = 'Downloading Whisper STT model...';
            } else if (whisperStatus === 'loading') {
              modelStep = 'loading_stt';
              modelDetail = 'Loading Whisper into memory...';
            } else if (llamaStatus === 'downloading') {
              modelStep = 'loading_llm';
              modelDetail = 'Downloading LLM model...';
            } else if (llamaStatus === 'loading' || llamaStatus === 'starting') {
              modelStep = 'loading_llm';
              modelDetail = 'Loading LLM into GPU VRAM...';
            } else if (ttsStatus === 'downloading') {
              modelStep = 'loading_tts';
              modelDetail = 'Downloading TTS model...';
            } else if (ttsStatus === 'loading' || ttsStatus === 'compiling') {
              modelStep = 'compiling_tts';
              modelDetail = 'Compiling TTS CUDA graphs...';
            } else {
              modelDetail = `Services: ${Object.entries(svc).map(([k, v]) => `${k}=${v}`).join(', ')}`;
            }

            setDeployState({
              status: 'booting', step: modelStep,
              message: `${modelDetail} [${elapsed}s, up ${appElapsed}s]`,
              stepDetail: `${Object.entries(svc).map(([k, v]) => `${k}=${v}`).join(', ')}`,
            });
            broadcastWs({ type: 'gpu:services', step: modelStep, services: svc });
          }
        }
      } catch {
        // Network error / timeout — transient, don't count as non-transient
        httpStatus = 0;
      }

      // Track non-transient HTTP errors (4xx = container responded but app is broken)
      if (httpStatus >= 400 && httpStatus < 500) {
        consecutiveNonTransient++;
        if (!firstNonTransientErrorAt) firstNonTransientErrorAt = Date.now();
        const nonTransientDurationMs = Date.now() - firstNonTransientErrorAt;
        if (nonTransientDurationMs > 3 * 60_000) {
          console.error(`[gpu] Pod ${podId} returning HTTP ${httpStatus} for ${Math.round(nonTransientDurationMs / 1000)}s — container likely failed to start`);
          // Fetch and log pod status for debugging
          try {
            const podStatus = await providerClient.getInstanceStatus(podId, credentials);
            console.error(`[gpu] Pod ${podId} provider status: ${podStatus}`);
          } catch (statusErr) {
            console.warn(`[gpu] Failed to get ${providerName} pod ${podId} status during crash detection: ${statusErr instanceof Error ? statusErr.message : statusErr}`);
          }
          setDeployState({ status: 'error', message: `Container returning HTTP ${httpStatus} for ${Math.round(nonTransientDurationMs / 60_000)}+ min — app failed to start (check image logs)` });
          return { result: 'crashed', pullTimeS: actualPullTimeS };
        }
      } else {
        consecutiveNonTransient = 0;
        firstNonTransientErrorAt = 0;
      }

      // Track consecutive health failures while container is supposedly running
      if (containerStartedAt) {
        consecutiveHealthFailures++;
      } else {
        consecutiveHealthFailures = 0;
      }

      // After 10 consecutive failures with container "running", verify pod status directly
      if (consecutiveHealthFailures >= 10 && containerStartedAt) {
        try {
          const podStatus = await providerClient.getInstanceStatus(podId, credentials);
          const statusLower = podStatus?.toLowerCase() || '';
          const CRASHED_STATES = new Set(['exited', 'terminated', 'error', 'failed', 'destroyed', 'deleted', 'stopped']);
          if (CRASHED_STATES.has(statusLower)) {
            const uptime = Math.round((Date.now() - containerStartedAt) / 1000);
            console.error(`[gpu] ${providerName} pod ${podId} crashed: status=${podStatus} after ${consecutiveHealthFailures} health failures (container was up ${uptime}s, endpoint=${endpoint})`);
            setDeployState({ status: 'error', message: `Pod crashed (status: ${podStatus}) after ${uptime}s — check GPU logs for details` });
            return { result: 'crashed', pullTimeS: actualPullTimeS };
          }
          // Pod still running but health failing — log for debugging
          if (consecutiveHealthFailures % 10 === 0) {
            console.warn(`[gpu] Pod ${podId} status=${podStatus} but ${consecutiveHealthFailures} consecutive health failures (container up ${Math.round((Date.now() - containerStartedAt) / 1000)}s)`);
          }
        } catch (err) {
          console.warn(`[gpu] Failed to check pod status for crash detection: ${err}`);
        }
      }
    }

    // Adaptive polling: fast (3s) during first 60s after container up, then slower (8s)
    const pollMs = containerStartedAt && (Date.now() - containerStartedAt) < 60_000
      ? 3_000   // container just booted — poll aggressively to catch readiness ASAP
      : 8_000;  // still pulling image or slow boot — ease off
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// ── Remote GPU log fetching ──────────────────────────────────────────────────

export async function fetchGpuLogs(sshHost?: string, sshPort?: number, endpoint?: string): Promise<string> {
  const host = sshHost || deployState.sshHost;
  const port = sshPort || deployState.sshPort;
  const gpuEndpoint = endpoint || deployState.endpoint;
  const lines: string[] = [];

  // Method 1: Try HTTP /logs endpoint on the GPU (if start.sh exposes one)
  if (gpuEndpoint) {
    try {
      const logsUrl = `${gpuEndpoint.replace(/\/$/, '')}/logs`;
      const resp = await fetch(logsUrl, { signal: AbortSignal.timeout(5_000) });
      if (resp.ok) {
        const text = await resp.text();
        lines.push('── HTTP /logs ──', text.slice(-8000));
      }
    } catch (e) { console.debug(`[gpu] HTTP /logs not available at ${gpuEndpoint}: ${e instanceof Error ? e.message : e}`); }
  }

  // Method 2: SSH into the machine and grab logs
  if (host && port) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return lines.join('\n') || '(no logs)';
    const { execSync } = await import('child_process');
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o UserKnownHostsFile=/dev/null -p ${port} root@${host}`;
    const logCommands = [
      'tail -200 /var/log/babelcast.log 2>/dev/null || tail -200 /app/logs/*.log 2>/dev/null || echo "(no app log found)"',
      'tail -50 /var/log/start.log 2>/dev/null || echo "(no start.log)"',
      'docker logs --tail 100 babelcast 2>/dev/null || echo "(no docker container)"',
      'nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || echo "(no GPU info)"',
      'ps aux | grep -E "uvicorn|python|llama" | grep -v grep || echo "(no processes)"',
    ];
    for (const cmd of logCommands) {
      try {
        const out = execSync(`${sshCmd} '${cmd}'`, { timeout: 10_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        if (out.trim() && !out.includes('(no ')) {
          lines.push(`── ${cmd.split(' ')[0]} ──`, out.trim().slice(-4000));
        }
      } catch (sshErr) { console.debug(`[gpu] SSH log fetch failed (${cmd.split(' ')[0]}): ${sshErr instanceof Error ? sshErr.message : sshErr}`); }
    }
  }

  if (lines.length === 0) {
    return '(no logs available — no SSH or HTTP access to GPU)';
  }
  const result = lines.join('\n');
  deployState.lastLogs = result;
  return result;
}

/**
 * Return GPU types ordered by benchmark results (best median latency first).
 * Only includes GPU types that have at least one passing test for any image
 * compatible with `dockerImage` (after Blackwell auto-swap).
 * Falls back to the AI Gateway priority list (deploy-settings.ts)
 * if no benchmark data exists yet.
 */
export async function getVerifiedGpuTypes(dockerImage: string): Promise<string[]> {
  try {
    // Resolve the canonical standard image name for comparison
    const canonicalImage = BLACKWELL_TO_STANDARD[dockerImage] ?? dockerImage;

    // Get all passing tests for this image (or its Blackwell variant)
    const rows = await prisma.gpuCompatibilityTest.findMany({
      where: {
        passed: true,
        dockerImage: { in: [canonicalImage, STANDARD_TO_BLACKWELL[canonicalImage] ?? canonicalImage, dockerImage] },
      },
      select: { gpuType: true, translateMedianMs: true },
      orderBy: [{ translateMedianMs: 'asc' }, { testedAt: 'desc' }],
    });

    if (rows.length === 0) {
      // No benchmark data yet — use hardcoded allowlist
      return getGpuPriorityList().length > 0 ? getGpuPriorityList() : [...DEFAULT_GPU_PRIORITY];
    }

    // Deduplicate, preserving latency order (lowest median first, nulls last)
    const seen = new Set<string>();
    const sorted: string[] = [];
    const nullLatency: string[] = [];
    for (const r of rows) {
      if (seen.has(r.gpuType)) continue;
      seen.add(r.gpuType);
      if (r.translateMedianMs != null) sorted.push(r.gpuType);
      else nullLatency.push(r.gpuType);
    }
    const verified = [...sorted, ...nullLatency];
    console.log(`[gpu] Verified GPU types from benchmarks (${verified.length}): ${verified.join(', ')}`);
    return verified;
  } catch (err) {
    console.warn(`[gpu] Failed to load verified GPU types from DB, using ai-gateway priority list: ${err instanceof Error ? err.message : err}`);
    return getGpuPriorityList().length > 0 ? getGpuPriorityList() : [...DEFAULT_GPU_PRIORITY];
  }
}

/**
 * Attempt to reconnect to a GPU pod that was running before gateway restart.
 * Loads persisted deploy state from disk, probes health, and restores monitoring if alive.
 * Called once at gateway startup.
 */
export async function tryRecoverActiveDeploy(): Promise<boolean> {
  const persisted = loadPersistedDeploy();
  if (!persisted) return false;

  console.log(`[gpu] Found persisted deploy: ${persisted.provider}/${persisted.gpuType} pod=${persisted.podId} endpoint=${persisted.endpoint}`);
  console.log(`[gpu] Probing health to check if pod is still alive...`);

  try {
    const probeResult = await probeGpuHealth(persisted.endpoint, true);
    const healthy = probeResult.ok;
    if (probeResult.data) updateGpuModelWarmth(probeResult.data);
    if (!healthy) {
      console.log(`[gpu] Persisted pod is not healthy — discarding`);
      clearPersistedDeploy();
      return false;
    }

    // Pod is alive! Restore state
    console.log(`[gpu] Pod is still healthy! Reconnecting...`);
    setDeployCancelled(false);
    setDeployState({
      status: 'ready',
      podId: persisted.podId,
      endpoint: persisted.endpoint,
      gpuType: persisted.gpuType,
      dockerImage: persisted.dockerImage || '',
      provider: persisted.provider as ProviderName,
      costPerHr: persisted.costPerHr,
      startedAt: persisted.startedAt,
      sshHost: persisted.sshHost,
      sshPort: persisted.sshPort,
      providerMeta: persisted.providerMeta,
      message: `Reconnected after restart (${persisted.provider}/${persisted.gpuType})`,
      step: 'ready',
      stepDetail: '',
    });

    // Restore provider credentials from env (needed for terminate)
    if (persisted.provider === 'vast') {
      setDeployVastApiKey(process.env.VAST_API_KEY || '');
    } else if (persisted.provider === 'tensordock') {
      setDeployTensordockApiKey(process.env.TENSORDOCK_API_KEY || '');
      setDeployTensordockAuthId(process.env.TENSORDOCK_AUTH_ID || '');
    } else if (persisted.provider === 'runpod') {
      setDeployApiKey(process.env.RUNPOD_API_KEY || '');
    } else if (persisted.provider === 'modal') {
      const modalId = process.env.MODAL_TOKEN_ID || '';
      const modalSecret = process.env.MODAL_TOKEN_SECRET || '';
      setDeployModalApiKey(modalId && modalSecret ? `${modalId}:${modalSecret}` : '');
    }
    setActiveProvider(persisted.provider as ProviderName);

    // Mark GPU healthy and set up translation routing
    markGpuHealthy();
    deploymentSM.markReady(persisted.podId, persisted.endpoint, persisted.gpuType, persisted.costPerHr);

    // Start monitoring
    startGpuMonitoring();

    console.log(`[gpu] Successfully reconnected to ${persisted.provider} pod ${persisted.podId} (${persisted.gpuType} @ $${persisted.costPerHr}/hr)`);
    return true;
  } catch (err) {
    console.warn(`[gpu] Recovery probe failed: ${err instanceof Error ? err.message : err}`);
    clearPersistedDeploy();
    return false;
  }
}

// ── Auto-Recovery Deploy ──────────────────────────────────────────────────────
// Called when GPU is condemned — deploys a replacement with the same config.
// If the current machine has some services working, the new machine gets
// the full config so all services are tested. Once the replacement passes
// readiness, it becomes the active machine (handled by the normal deploy flow).

export async function startAutoRecoveryDeploy(): Promise<void> {
  // Prevent concurrent deploys — bail if another deploy is in progress
  if (deployState.status === 'creating' || deployState.status === 'booting' || deployState.step === 'waiting_health') {
    console.warn('[gpu] Auto-recovery: deploy already in progress — skipping');
    return;
  }

  const lastImage = deployState.dockerImage;
  const lastGpuType = deployState.gpuType;
  const lastProvider = deployState.provider;

  if (!lastImage) {
    console.warn('[gpu] Auto-recovery: no Docker image from last deploy — skipping');
    return;
  }

  // Save API keys BEFORE reset (resetDeployState clears them)
  const savedKeys = {
    runpod: deployApiKey,
    vast: deployVastApiKey,
    tensordock: deployTensordockApiKey ? { apiKey: deployTensordockApiKey, authId: deployTensordockAuthId } : undefined,
    modal: deployModalApiKey,
  };

  console.log(`[gpu] Auto-recovery: deploying replacement (image=${lastImage}, lastGpu=${lastGpuType}, lastProvider=${lastProvider})`);
  broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'auto-recovery', message: `Deploying replacement (${lastImage})...` });

  // Reset deploy state for a fresh deploy
  resetDeployState();

  // Restore API keys after reset
  if (savedKeys.runpod) setDeployApiKey(savedKeys.runpod);
  if (savedKeys.vast) setDeployVastApiKey(savedKeys.vast);
  if (savedKeys.tensordock) {
    setDeployTensordockApiKey(savedKeys.tensordock.apiKey);
    setDeployTensordockAuthId(savedKeys.tensordock.authId);
  }
  if (savedKeys.modal) setDeployModalApiKey(savedKeys.modal);

  // Build tiers from saved credentials
  const tiers = buildGpuTiers(
    savedKeys.runpod,
    savedKeys.vast || undefined,
    savedKeys.tensordock,
    savedKeys.modal || undefined,
  );

  if (tiers.length === 0) {
    console.error('[gpu] Auto-recovery: no provider tiers available — staying on cloud');
    broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'auto-recovery-failed', error: 'No provider credentials' });
    return;
  }

  // Use the same GPU types from the priority list, or fallback to the last used type
  const gpuTypes = lastGpuType ? [lastGpuType] : getGpuPriorityList();

  try {
    await startDeployWithTiers(tiers, lastImage, gpuTypes, { autoRecovery: true });
    console.log('[gpu] Auto-recovery: deploy started — readiness check will run automatically');
  } catch (err) {
    console.error(`[gpu] Auto-recovery deploy failed: ${err instanceof Error ? err.message : err}`);
    broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'auto-recovery-failed', error: err instanceof Error ? err.message : 'Deploy failed' });
  }
}
