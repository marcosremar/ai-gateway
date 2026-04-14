// ── BabelCast Gateway — GPU Info Handlers ────────────────────────────────────
// Extracted from gpu-handlers.ts: status, list, health, logs, catalog,
// my-location, latency-probe, reputation, and provider balance cache.

import type { IncomingMessage, ServerResponse } from 'http';
import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import { createLogger } from '../src/logger';

const log = createLogger('gpu-handlers-info');
import {
  deployState, deployApiKey, deployVastApiKey, deployTensordockApiKey, deployTensordockAuthId,
  deployModalApiKey, gpuHealthy, lastRequestTime, latencyRing, startedAt, pendingDbWrites,
  providerMetrics, metricsCounters, activeRequests, isGpuAvailable, prisma, DAILY_BUDGET_USD,
  dailyGpuSpendUsd, deploymentSM, ttsWarmth, getColdStartProfile, gpuModelWarmth, isStageWarm,
  standbyDeployState, standbyReadyForHandover,
  gpuReadinessState, gpuReadyForProduction, gpuShadowMode, getPerStageP95,
} from './state';
import { runpod, vast, tensordock, ollamaAvailable, groqAvailable, openaiAvailable, shouldPreferGpuTts, getStageBreakersSnapshot } from './providers';
import { cooldownTracker, fetchGpuLogs, IDLE_TIMEOUT_MS } from './gpu-deploy';
import { logGpuEvent, computePercentile, getAllReputations } from './metrics';
import { getOrCreateRequestId, setRequestIdHeader } from './http-utils';
import { getImageCatalog, PORT, PROVIDER_CHAIN, LOW_BALANCE_THRESHOLD_USD } from './config';
import { BILLING_URLS } from '../src/providers/errors';
import { fetchIpLocation, extractIp, fetchRunPodDatacenter, parseProviderRegion, fetchMyLocation } from './ip-location';
import { getAllHostLatencies, getLatencyDbStats } from './latency-db';
import { getCloudProbeResults, getCloudProbeAt } from './provider-warmup';
import { getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs, getP95DemotionMultiplier, getRepechageMaxAttempts } from '../src/gpu-providers/deploy-settings';
import { buildProviderQueries } from './gpu-handlers-offers';
import { getDeployTimeoutMin } from '../src/gpu-providers/deploy-settings';
import { runPreFlightChecks } from '../src/preflight-checks';
import { analyzeDockerImage } from '../src/gpu-compat';
import { loadProviderConfig } from './config-persistence';
import { errorSummary } from '../src/error-summary';
import { getMemoryStats, getOperationStats } from '../src/performance-profiler';

// ── Friendly error message cleanup ──────────────────────────────────────────

/** Strip raw JSON from error messages and add billing links for balance errors. */
function friendlyErrorMessage(raw: string): string {
  const balanceMatch = raw.match(/Insufficient balance|balance is too low|balance too low|add funds/i);
  if (balanceMatch) {
    const provider = raw.includes('RunPod') ? 'RunPod' : raw.includes('TensorDock') ? 'TensorDock' : raw.includes('Vast') ? 'Vast.ai' : 'Provider';
    const billingKey = provider === 'RunPod' ? 'runpod' : provider === 'TensorDock' ? 'tensordock' : provider === 'Vast.ai' ? 'vast' : '';
    const billingUrl = billingKey ? BILLING_URLS[billingKey] : '';
    return `${provider} balance too low to start pod` + (billingUrl ? `. Add funds: https://${billingUrl}` : '');
  }
  // Strip embedded JSON objects from error strings (e.g. HTTP 500 {"error":"...", "status":500})
  const jsonStripped = raw.replace(/\s*\{[^{}]*"error"\s*:\s*"([^"]+)"[^{}]*\}/g, ': $1');
  return jsonStripped;
}

// ── Provider balance cache (refreshed every 60s, non-blocking) ──────────────

interface ProviderBalance {
  provider: string;
  apiKeyHint: string;      // masked key, e.g. "rp_...abc"
  balance: number | null;  // null = check failed
  spendPerHr: number;      // current hourly spend (0 if unknown)
  spendPerDay: number;     // spendPerHr * 24
  billingUrl: string;
  low: boolean;            // below threshold
  active: boolean;         // is this provider currently running a pod?
}

let _balanceCache: ProviderBalance[] = [];
let _balanceCacheTime = 0;
const BALANCE_CACHE_TTL_MS = 60_000;

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

async function getCachedProviderBalances(): Promise<ProviderBalance[]> {
  if (Date.now() - _balanceCacheTime < BALANCE_CACHE_TTL_MS) return _balanceCache;

  const providers: ProviderBalance[] = [];
  const threshold = LOW_BALANCE_THRESHOLD_USD;
  const checks: Promise<void>[] = [];
  const currentProvider = deployState.provider;
  const currentCostPerHr = deployState.costPerHr || 0;

  const rpKey = process.env.RUNPOD_API_KEY || '';
  if (rpKey) {
    const entry: ProviderBalance = {
      provider: 'RunPod', apiKeyHint: maskKey(rpKey), balance: null,
      spendPerHr: 0, spendPerDay: 0,
      billingUrl: `https://${BILLING_URLS.runpod}`, low: false,
      active: currentProvider === 'runpod',
    };
    providers.push(entry);
    checks.push(
      runpod.checkBalance({ apiKey: rpKey }).then(bal => {
        if (bal) {
          entry.balance = bal.balance;
          entry.spendPerHr = (bal as { balance: number; spendPerHr?: number }).spendPerHr ?? (currentProvider === 'runpod' ? currentCostPerHr : 0);
          entry.spendPerDay = entry.spendPerHr * 24;
          entry.low = bal.balance < threshold;
        }
      }).catch(err => { log.warn(`RunPod balance check failed: ${err instanceof Error ? err.message : err}`); }),
    );
  }

  const tdKey = process.env.TENSORDOCK_API_KEY || '';
  const tdAuth = process.env.TENSORDOCK_AUTH_ID || '';
  if (tdKey && tdAuth) {
    const entry: ProviderBalance = {
      provider: 'TensorDock', apiKeyHint: maskKey(tdKey), balance: null,
      spendPerHr: 0, spendPerDay: 0,
      billingUrl: `https://${BILLING_URLS.tensordock}`, low: false,
      active: currentProvider === 'tensordock',
    };
    providers.push(entry);
    checks.push(
      tensordock.checkBalance({ apiKey: tdKey, authId: tdAuth }).then(bal => {
        if (bal) {
          entry.balance = bal.balance;
          entry.spendPerHr = bal.hourlyCost ?? (currentProvider === 'tensordock' ? currentCostPerHr : 0);
          entry.spendPerDay = entry.spendPerHr * 24;
          entry.low = bal.balance < threshold;
        }
      }).catch(err => { log.warn(`TensorDock balance check failed: ${err instanceof Error ? err.message : err}`); }),
    );
  }

  const vastKey = process.env.VAST_API_KEY || '';
  if (vastKey) {
    const entry: ProviderBalance = {
      provider: 'Vast.ai', apiKeyHint: maskKey(vastKey), balance: null,
      spendPerHr: 0, spendPerDay: 0,
      billingUrl: `https://${BILLING_URLS.vast}`, low: false,
      active: currentProvider === 'vast',
    };
    providers.push(entry);
    checks.push(
      vast.checkBalance({ apiKey: vastKey }).then(bal => {
        if (bal) {
          entry.balance = bal.balance;
          entry.spendPerHr = (bal as { balance: number; spendPerHr?: number }).spendPerHr ?? (currentProvider === 'vast' ? currentCostPerHr : 0);
          entry.spendPerDay = entry.spendPerHr * 24;
          entry.low = bal.balance < threshold;
        }
      }).catch(err => { log.warn(`Vast.ai balance check failed: ${err instanceof Error ? err.message : err}`); }),
    );
  }

  // ── Cloud providers ──
  // ElevenLabs — GET /v1/user/subscription → character_count / character_limit
  const elKey = process.env.ELEVENLABS_API_KEY || '';
  if (elKey) {
    const entry: ProviderBalance = {
      provider: 'ElevenLabs', apiKeyHint: maskKey(elKey), balance: null,
      spendPerHr: 0, spendPerDay: 0, billingUrl: 'https://elevenlabs.io/subscription', low: false, active: false,
    };
    providers.push(entry);
    checks.push(
      fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': elKey },
        signal: AbortSignal.timeout(3000),
      }).then(async r => {
        if (!r.ok) return;
        const d = await r.json() as { character_count?: number; character_limit?: number };
        if (typeof d.character_limit === 'number' && typeof d.character_count === 'number') {
          const pct = d.character_limit > 0 ? (d.character_limit - d.character_count) / d.character_limit * 100 : 0;
          entry.balance = Math.round(pct); // show as % remaining
          entry.low = pct < 10;
        }
      }).catch(err => { log.warn(`ElevenLabs balance check failed: ${err instanceof Error ? err.message : err}`); }),
    );
  }

  // Deepgram — GET /v1/projects → project_id, then GET /v1/projects/{id}/balances → amount USD
  const dgKey = process.env.DEEPGRAM_API_KEY || '';
  if (dgKey) {
    const entry: ProviderBalance = {
      provider: 'Deepgram', apiKeyHint: maskKey(dgKey), balance: null,
      spendPerHr: 0, spendPerDay: 0, billingUrl: 'https://console.deepgram.com/billing', low: false, active: false,
    };
    providers.push(entry);
    checks.push(
      (async () => {
        try {
          const projRes = await fetch('https://api.deepgram.com/v1/projects', {
            headers: { Authorization: `Token ${dgKey}` },
            signal: AbortSignal.timeout(3000),
          });
          if (!projRes.ok) return;
          const projData = await projRes.json() as { projects?: Array<{ project_id: string }> };
          const projId = projData.projects?.[0]?.project_id;
          if (!projId) return;
          const balRes = await fetch(`https://api.deepgram.com/v1/projects/${projId}/balances`, {
            headers: { Authorization: `Token ${dgKey}` },
            signal: AbortSignal.timeout(3000),
          });
          if (!balRes.ok) return;
          const balData = await balRes.json() as { balances?: Array<{ amount: number }> };
          const totalBal = (balData.balances || []).reduce((s, b) => s + (b.amount || 0), 0);
          entry.balance = totalBal;
          entry.low = totalBal < threshold;
        } catch (err) { log.warn(`Deepgram balance check failed: ${err instanceof Error ? err.message : err}`); }
      })(),
    );
  }

  // Providers without balance APIs — just show as configured
  const staticProviders: Array<{ name: string; envVar: string; billingKey: string }> = [
    { name: 'Groq', envVar: 'GROQ_API_KEY', billingKey: 'groq' },
    { name: 'OpenAI', envVar: 'OPENAI_API_KEY', billingKey: 'openai' },
    { name: 'Fireworks', envVar: 'FIREWORKS_API_KEY', billingKey: 'fireworks' },
    { name: 'Modal', envVar: 'MODAL_TOKEN_ID', billingKey: 'modal' },
    { name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', billingKey: 'openrouter' },
  ];
  for (const cp of staticProviders) {
    const key = process.env[cp.envVar] || '';
    if (!key) continue;
    providers.push({
      provider: cp.name, apiKeyHint: maskKey(key), balance: null,
      spendPerHr: 0, spendPerDay: 0,
      billingUrl: cp.billingKey ? `https://${BILLING_URLS[cp.billingKey] || ''}` : '',
      low: false, active: false,
    });
  }

  // 3s timeout so /health stays fast
  await Promise.race([
    Promise.all(checks),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);

  _balanceCache = providers;
  _balanceCacheTime = Date.now();
  return providers;
}

// ── GPU status endpoint ─────────────────────────────────────────────────────

/**
 * Handle GET /v1/gpu/status — return the current GPU deployment state.
 *
 * Returns comprehensive information including deploy status, elapsed time,
 * provider details, machine specs (RAM, VRAM, disk, CPU), GPU hardware
 * metrics (temperature, utilization, memory), provider cooldowns, balance
 * info, IP geolocation, deployment state machine, model warmth, and
 * pipeline routing configuration.
 *
 * Omits full logs from this endpoint (use `/v1/gpu/logs` for that).
 *
 * @param _req - Incoming HTTP request (no body needed)
 * @param res - Outgoing HTTP response; returns 200 with full deploy state JSON
 * @returns Promise<void>
 *
 * @example
 * ```bash
 * GET /v1/gpu/status
 * # → { status: "ready", provider: "vast", podId: "...", costPerHr: 0.45, ... }
 * ```
 */
export async function handleGpuStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(_req);
  setRequestIdHeader(res, requestId);
  log.log(`GPU status query`);
  const cfg = await loadProviderConfig();
  const elapsed = deployState.startedAt > 0 ? Math.round((Date.now() - deployState.startedAt) / 1000) : 0;
  const activeTier = isGpuAvailable() ? 'gpu' : 'cloud';
  const idleSec = lastRequestTime > 0 ? Math.round((Date.now() - lastRequestTime) / 1000) : 0;

  // Collect active provider cooldowns
  const cooldowns = cooldownTracker.getActiveCooldowns();

  // Fetch TensorDock balance if it's the active provider
  let providerBalance: { balance: number; hourlyCost: number } | undefined;
  if (deployState.provider === 'tensordock' && deployTensordockApiKey && deployTensordockAuthId) {
    const bal = await tensordock.checkBalance({ apiKey: deployTensordockApiKey, authId: deployTensordockAuthId });
    if (bal) providerBalance = bal;
  }

  // IP geolocation — waterfall: real IP → RunPod datacenter GraphQL → provider region string
  const hostIp = extractIp(deployState.providerMeta as Record<string, unknown>, deployState.sshHost);
  let ipLocation = hostIp ? await fetchIpLocation(hostIp) : null;
  if (!ipLocation && deployState.provider === 'runpod' && deployState.podId && deployApiKey) {
    ipLocation = await fetchRunPodDatacenter(deployState.podId, deployApiKey);
  }
  if (!ipLocation) {
    const regionStr = (deployState.providerMeta?.region as string) || '';
    ipLocation = parseProviderRegion(regionStr);
  }

  // Omit lastLogs from status (use /v1/gpu/logs for full logs)
  const { lastLogs, message: rawMessage, ...stateWithoutLogs } = deployState;
  const message = deployState.status === 'error' ? friendlyErrorMessage(rawMessage) : rawMessage;
  // Fall back to providerMeta cost fields if costPerHr wasn't captured at deploy time
  const effectiveCostPerHr = deployState.costPerHr
    || (deployState.providerMeta?.dphTotal as number)
    || (deployState.providerMeta?.costPerHr as number)
    || 0;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ...stateWithoutLogs,
    costPerHr: effectiveCostPerHr,
    message,
    elapsedSec: elapsed,
    deployTimeoutSec: getDeployTimeoutMin() * 60,
    gpuHealthy,
    activeTier,
    idleSec,
    idleTimeoutSec: Math.round(IDLE_TIMEOUT_MS / 1000),
    provider: deployState.provider,
    alert: deployState.alert,
    region: (deployState.providerMeta?.region as string) || '',
    ipLocation: ipLocation ?? undefined,
    machineInfo: {
      instanceId: deployState.podId || null,
      ramGb: (deployState.providerMeta?.ramGb as number) || null,
      gpuVramGb: (deployState.providerMeta?.gpuVramGb as number) || null,
      diskGb: (deployState.providerMeta?.diskGb as number) || null,
      numGpus: (deployState.providerMeta?.numGpus as number) || null,
      inetDownMbps: (deployState.providerMeta?.inetDown as number) || null,
      inetUpMbps: (deployState.providerMeta?.inetUp as number) || null,
      cpuCores: (deployState.providerMeta?.cpuCores as number) || null,
    },
    gpuMetrics: deployState.gpuTemp > 0 || deployState.gpuUtil >= 0 || deployState.gpuMemUsed > 0 ? {
      tempC: deployState.gpuTemp || undefined,
      utilPct: deployState.gpuUtil >= 0 ? deployState.gpuUtil : undefined,
      memUsedGb: deployState.gpuMemUsed || undefined,
      memTotalGb: deployState.gpuMemTotal || undefined,
    } : undefined,
    hasRemoteLogs: !!lastLogs,
    providerCooldowns: Object.keys(cooldowns).length > 0 ? cooldowns : undefined,
    providerBalance,
    deployDurationMs: deployState.deployDurationMs || undefined,
    sm: deploymentSM.toJSON(),
    modelWarmth: gpuModelWarmth,
    pipelineRouting: (() => {
      if (!isGpuAvailable()) return undefined;
      // Check active app to see which stages use GPU — avoids showing 'gpu'
      // routing for stages that the active app routes to cloud only.
      const _cfg = cfg;
      const _activeApp = _cfg.activeAppId
        ? _cfg.apps.find(p => p.id === _cfg.activeAppId)
        : null;
      const appUsesGpu = (stage: 'stt' | 'llm' | 'tts'): boolean => {
        if (!_activeApp) return true;
        const chain = (_activeApp as unknown as Record<string, unknown>)[stage] as Array<{ provider: string }> | undefined;
        return !chain || chain.some(e => e.provider === 'gpu');
      };
      const sttGpu = appUsesGpu('stt') && isStageWarm('stt');
      const llmGpu = appUsesGpu('llm') && isStageWarm('llm');
      const ttsGpu = appUsesGpu('tts') && shouldPreferGpuTts();
      return {
        stt: sttGpu ? 'gpu' : 'cloud',
        llm: llmGpu ? 'gpu' : 'cloud',
        tts: ttsGpu ? 'gpu' : 'cloud',
        mode: (sttGpu && llmGpu && ttsGpu) ? 'atomic-gpu'
          : (sttGpu || llmGpu || ttsGpu) ? 'hybrid'
          : 'cloud',
        activeApp: _cfg.activeAppId || undefined,
      };
    })(),
    ttsColdStartProfile: getColdStartProfile(deployState.gpuType, deployState.dockerImage, deployState.provider) || undefined,
    readinessState: gpuReadinessState,
    bootOnStartup: (() => {
      const _activeApp = cfg.apps?.find(p => p.id === cfg.activeAppId);
      return _activeApp?.gpuDeploy?.bootOnStartup ?? false;
    })(),
    standby: {
      status: standbyDeployState.status,
      endpoint: standbyDeployState.endpoint || null,
      gpuType: standbyDeployState.gpuType || null,
      provider: standbyDeployState.provider || null,
      triggeredReason: standbyDeployState.triggeredReason || null,
      message: standbyDeployState.message || null,
      readyForHandover: standbyReadyForHandover,
      startedAt: standbyDeployState.startedAt || null,
    },
  }));
}

/**
 * GET /v1/gpu/list — list all active GPU instances across all configured providers.
 * Aggregates listInstances() from Vast, RunPod, TensorDock in parallel.
 */
export async function handleGpuList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(_req);
  setRequestIdHeader(res, requestId);

  // Use deploy-time keys first, fall back to env vars (so list works even after gateway restart)
  const vastKey = deployVastApiKey || process.env.VAST_API_KEY || '';
  const rpKey = deployApiKey || process.env.RUNPOD_API_KEY || '';
  const tdKey = deployTensordockApiKey || process.env.TENSORDOCK_API_KEY || '';
  const tdAuth = deployTensordockAuthId || process.env.TENSORDOCK_AUTH_ID || '';
  const providerQueries = buildProviderQueries({
    runpodApiKey: rpKey, vastApiKey: vastKey,
    tensordockApiKey: tdKey, tensordockAuthId: tdAuth,
  });

  const results = await Promise.allSettled(
    providerQueries
      .filter(p => p.credentials)
      .map(async p => {
        const instances = await p.client.listInstances(p.credentials!);
        return instances
          .map(i => ({
            provider: p.name,
            instanceId: i.instanceId,
            instanceName: i.instanceName,
            endpoint: i.endpoint,
            status: i.status,
            gpuType: i.gpuType,
            isActive: i.instanceId === deployState.podId && deployState.status === 'ready',
            sshHost: i.sshHost,
            sshPort: i.sshPort,
          }));
      })
  );

  const instances: unknown[] = [];
  // Always include the currently tracked deployState even if not in provider list (e.g. modal)
  if (deployState.podId && deployState.status !== 'idle') {
    const elapsed = deployState.startedAt > 0 ? Math.round((Date.now() - deployState.startedAt) / 1000) : 0;
    instances.push({
      provider: deployState.provider,
      deployId: deployState.deployId || undefined,
      instanceId: deployState.podId,
      instanceName: deployState.podId,
      endpoint: deployState.endpoint,
      status: deployState.status,
      gpuType: deployState.gpuType,
      costPerHr: deployState.costPerHr,
      elapsedSec: elapsed,
      dockerImage: deployState.dockerImage,
      isActive: deployState.status === 'ready',
    });
  }

  // Add any extra instances found from providers that aren't the current deployState
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const inst of result.value) {
      if (!instances.some((x: unknown) => (x as { instanceId: string }).instanceId === (inst as { instanceId: string }).instanceId)) {
        instances.push(inst);
      }
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ instances }));
}

// ── Granular /health endpoint ───────────────────────────────────────────────

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
  const firstCloudProvider = PROVIDER_CHAIN.find(p => p === 'groq' || p === 'ollama') || 'groq';
  const sttProvider = firstCloudProvider;
  const llmProvider = firstCloudProvider;

  const components: Record<string, Record<string, unknown>> = {
    stt: { status: 'ok', provider: sttProvider },
    llm: { status: 'ok', provider: llmProvider },
  };

  // TTS component — GPU preferred, Modal Qwen3-TTS as primary fallback (multilingual, free),
  // then Groq Orpheus, then OpenAI TTS
  if (isGpuAvailable()) {
    components.tts = { status: 'ok', provider: 'gpu' };
  } else {
    // Modal TTS is always available (no API key, serverless GPU)
    components.tts = { status: 'ok', provider: 'modal', fallback: true };
  }

  // GPU component
  if (deployState.status === 'ready') {
    const idleSec = lastRequestTime > 0 ? Math.round((Date.now() - lastRequestTime) / 1000) : 0;
    components.gpu = {
      status: 'ready',
      deployId: deployState.deployId || undefined,
      endpoint: deployState.endpoint,
      healthy: gpuHealthy,
      idle_sec: idleSec,
    };
  } else if (deployState.status === 'idle') {
    components.gpu = { status: 'idle' };
  } else if (deployState.status === 'stopped') {
    components.gpu = { status: 'stopped', deployId: deployState.deployId || undefined, podId: deployState.podId, provider: deployState.provider };
  } else {
    components.gpu = { status: deployState.status, deployId: deployState.deployId || undefined, step: deployState.step };
  }

  const providersStatus: Record<string, boolean> = {
    groq: groqAvailable,
    openai: openaiAvailable,
  };
  const noApiKeys = !groqAvailable && !ollamaAvailable;

  let overallStatus: string;
  let reason: string | undefined;
  if (noApiKeys) {
    overallStatus = 'degraded';
    reason = 'No AI provider API keys configured';
  } else if (deployState.status === 'error') {
    overallStatus = 'degraded';
    reason = `GPU error: ${friendlyErrorMessage(deployState.message || 'Unknown error')}`;
  } else {
    overallStatus = 'ok';
  }

  // ── Provider balances (cached, refreshed every 60s) ──
  const providerBalances = await getCachedProviderBalances();

  const requestId = getOrCreateRequestId(_req);
  setRequestIdHeader(res, requestId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const sorted = [...latencyRing].sort((a, b) => a - b);
  const body: Record<string, unknown> = {
    status: overallStatus,
    uptime_sec: uptimeSec,
    gpu: deployState.status,
    providers: providersStatus,
    components,
    latency: {
      p50_ms: computePercentile(sorted, 50),
      p95_ms: computePercentile(sorted, 95),
      p99_ms: computePercentile(sorted, 99),
      samples: latencyRing.length,
    },
  };
  if (reason) body.reason = reason;
  if (providerBalances.length > 0) {
    body.providerBalances = providerBalances;
    body.balanceAlerts = providerBalances.filter(p => p.low);
  }
  // Budget tracking
  body.budget = {
    dailySpendUsd: Math.round(dailyGpuSpendUsd * 100) / 100,
    dailyLimitUsd: DAILY_BUDGET_USD || null,
    exceeded: DAILY_BUDGET_USD > 0 && dailyGpuSpendUsd > DAILY_BUDGET_USD,
  };
  // Per-stage circuit breakers (GPU pipeline stages: stt, llm, tts)
  body.circuitBreakers = getStageBreakersSnapshot();
  // Provider performance metrics (with token usage)
  const providerPerfSummary: Record<string, {
    avgLatencyMs: number; requests: number; errorRate: number;
    inputTokens: number; outputTokens: number;
  }> = {};
  for (const [name, m] of Object.entries(providerMetrics)) {
    providerPerfSummary[name] = {
      avgLatencyMs: m.requests > 0 ? Math.round(m.totalLatencyMs / m.requests) : 0,
      requests: m.requests,
      errorRate: m.requests > 0 ? Math.round((m.errors / m.requests) * 10000) / 10000 : 0,
      inputTokens: m.inputTokens || 0,
      outputTokens: m.outputTokens || 0,
    };
  }
  body.providerMetrics = providerPerfSummary;
  body.tokenUsage = {
    totalInputTokens: metricsCounters.totalInputTokens,
    totalOutputTokens: metricsCounters.totalOutputTokens,
    totalTokens: metricsCounters.totalInputTokens + metricsCounters.totalOutputTokens,
  };
  body.pendingDbWrites = pendingDbWrites;
  // Cloud provider probe results (from periodic warmup cycle)
  const cloudProbe = getCloudProbeResults();
  if (cloudProbe.length > 0) {
    body.cloudHealth = cloudProbe.map(r => ({
      provider: r.provider,
      ok: r.ok,
      latencyMs: r.latencyMs,
      ...(r.error ? { error: r.error } : {}),
    }));
    body.cloudHealthAt = getCloudProbeAt();
  }
  res.end(JSON.stringify(body));
}

// ── GPU logs endpoint ────────────────────────────────────────────────────────

export async function handleGpuLogs(req: IncomingMessage, res: ServerResponse) {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const filter = url.searchParams.get('filter') || undefined;

  try {
    let logs = await fetchGpuLogs();
    if (filter && logs) {
      const filtered = logs.split('\n').filter(line => line.includes(filter)).join('\n');
      if (filtered.trim()) logs = filtered;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      logs,
      sshHost: deployState.sshHost,
      sshPort: deployState.sshPort,
      endpoint: deployState.endpoint,
      podId: deployState.podId,
      provider: deployState.provider,
      status: deployState.status,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to fetch logs: ${err}` }));
  }
}

// ── GPU event logs endpoint (persistent file-based) ─────────────────────────

/**
 * GET /v1/gpu/logs/events?lines=100 — Returns recent GPU lifecycle events from file.
 * GET /v1/gpu/logs/server?lines=200 — Returns recent server console logs from file.
 */
export function handleGpuEventLogs(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const lines = parseInt(url.searchParams.get('lines') || '100', 10);
  const type = url.pathname.includes('/server') ? 'server'
    : url.pathname.includes('/gpu') ? 'gpu' : 'events';

  try {
    const { readRecentEvents, readRecentGpuEvents, readRecentServerLogs, LOG_DIR } = require('./file-logger');
    const logLines = type === 'server' ? readRecentServerLogs(lines)
      : type === 'gpu' ? readRecentGpuEvents(lines)
      : readRecentEvents(lines);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type,
      lines: logLines.length,
      logDir: LOG_DIR,
      entries: logLines.map((l: string) => {
        try { return JSON.parse(l); } catch { return { raw: l }; }
      }),
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to read logs: ${err}` }));
  }
}

// ── GPU catalog endpoint ────────────────────────────────────────────────────

export function handleGpuCatalog(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(getImageCatalog()));
}

// ── GPU my-location endpoint ─────────────────────────────────────────────────

/**
 * GET /v1/gpu/my-location
 * Returns the gateway's own geographic location (lat, lon, country, flag).
 * Since gateway and Python app run on the same machine, this is the user's location.
 */
export async function handleGpuMyLocation(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const loc = await fetchMyLocation();
  if (!loc) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Could not determine location (ipapi.co unreachable)' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(loc));
}

// ── GPU latency DB endpoint ───────────────────────────────────────────────────

/**
 * GET /v1/gpu/latency-probe
 * Returns the latency DB: all known hosts with rolling stats (median, p90, stddev).
 * Sorted by median_ms ASC (nulls last — never probed yet).
 *
 * Query params:
 *   ?region=EU     — filter to EU hosts only
 *   ?gpu=RTX+5090  — filter by GPU name (substring match)
 */
export async function handleGpuLatencyProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url       = new URL(req.url || '/', `http://localhost:${PORT}`);
  const regionEU  = (url.searchParams.get('region') || '').toUpperCase() === 'EU';
  const gpuFilter = (url.searchParams.get('gpu') || '').toLowerCase();

  const EU_CCS = new Set([
    'AL','AT','BA','BE','BG','BY','CH','CY','CZ','DE','DK','EE','ES','FI',
    'FR','GB','GR','HR','HU','IE','IS','IT','LI','LT','LU','LV','MD','ME',
    'MK','MT','NL','NO','PL','PT','RO','RS','SE','SI','SK','UA','XK',
  ]);

  let hosts = await getAllHostLatencies();

  if (regionEU) {
    hosts = hosts.filter(h => {
      const parts = h.geolocation.split(',');
      const cc    = parts[parts.length - 1].trim().toUpperCase();
      return EU_CCS.has(cc);
    });
  }
  if (gpuFilter) {
    hosts = hosts.filter(h => h.gpu_name.toLowerCase().includes(gpuFilter));
  }

  const [stats, loc] = await Promise.all([getLatencyDbStats(), fetchMyLocation()]);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    from:   loc ? { city: loc.city, country: loc.country, flag: loc.flag } : null,
    dbStats: stats,
    hosts,
  }));
}

// ── GPU host reputation endpoint ─────────────────────────────────────────────

export async function handleGpuReputation(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const providerFilter = url.searchParams.get('provider') || undefined;

  try {
    const all = await getAllReputations() as Array<Record<string, unknown>>;
    const filtered = providerFilter
      ? all.filter(r => r.provider === providerFilter)
      : all;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hosts: filtered, count: filtered.length }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to fetch reputations: ${err}` }));
  }
}

// ── Pre-flight check endpoint ────────────────────────────────────────────────

/**
 * POST /v1/gpu/preflight — run pre-flight checks without starting a deploy.
 * Request body: { image?, provider?, apiKey?, gpuTypes?, quotedPricePerHr?, templateId? }
 */
export async function handlePreflightCheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();

  let config: {
    image?: string;
    provider?: string;
    apiKey?: string;
    gpuTypes?: string[];
    quotedPricePerHr?: number;
    templateId?: string;
  };
  try {
    config = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  if (!config.image) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing "image" field' }));
    return;
  }

  const result = await runPreFlightChecks({
    imageName: config.image,
    provider: config.provider || 'vast',
    apiKey: config.apiKey || process.env.VAST_API_KEY || '',
    gpuTypes: config.gpuTypes || [],
    quotedPricePerHr: config.quotedPricePerHr,
    dockerhubUser: process.env.DOCKERHUB_USERNAME,
    dockerhubToken: process.env.DOCKERHUB_TOKEN,
    templateId: config.templateId,
  });

  res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

// ── Error Summary endpoint ────────────────────────────────────────────────────

/**
 * GET /v1/errors/summary — return error summary statistics.
 * Query param: hours (default 24) — time window for the summary.
 */
export async function handleErrorSummary(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const hours = parseInt(url.searchParams.get('hours') || '24', 10);

  const summary = errorSummary.getSummary(hours);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(summary));
}

/**
 * GET /v1/errors/alerts — return active error alerts.
 * POST /v1/errors/alerts/acknowledge — acknowledge an alert by type.
 */
export async function handleErrorAlerts(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET') {
    const alerts = errorSummary.getAlerts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alerts }));
  } else if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.type) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "type" field' }));
      return;
    }

    errorSummary.acknowledgeAlert(body.type);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ acknowledged: true }));
  }
}

// ── Canary Status endpoint ───────────────────────────────────────────────────

/**
 * GET /v1/canary/status?deployId=xxx — return canary deployment status.
 * Returns current canary stats, traffic percentage, and evaluation decision.
 */
export async function handleCanaryStatus(_req: IncomingMessage, res: ServerResponse) {
  const url = new URL(_req.url || '/', `http://${_req.headers.host || 'localhost'}`);
  const deployId = url.searchParams.get('deployId');

  // If deployId specified, check it matches current deploy
  if (deployId && deployState.deployId && deployState.deployId !== deployId) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No canary deployment found' }));
    return;
  }

  if (!deployState.canary) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No canary deployment found' }));
    return;
  }

  const canary = deployState.canary as {
    getStats: () => unknown;
    evaluate: () => unknown;
    currentVersion?: string;
    canaryVersion?: string;
  };
  const stats = canary.getStats();
  const decision = canary.evaluate();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    deployId: deployState.deployId,
    currentVersion: (canary as Record<string, unknown>).currentVersion,
    canaryVersion: (canary as Record<string, unknown>).canaryVersion,
    trafficPercentage: (stats as Record<string, unknown>).trafficPercentage,
    status: (stats as Record<string, unknown>).status,
    evaluation: decision,
    stats,
  }));
}

// ── Performance Stats endpoint ───────────────────────────────────────────────

/**
 * GET /v1/performance — return memory and operation performance stats.
 * Useful for monitoring deploy performance and identifying bottlenecks.
 */
export async function handlePerformanceStats(_req: IncomingMessage, res: ServerResponse) {
  const memoryStats = getMemoryStats();
  const operationStats = getOperationStats();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    memory: memoryStats,
    operations: operationStats,
    uptime: process.uptime(),
    nodeVersion: process.version,
  }));
}

// ── GPU Compatibility endpoint ───────────────────────────────────────────────

/**
 * GET /v1/gpu/compatibility?image=...&env=...&cmd=...
 * Analyzes a Docker image and returns compatible GPUs.
 */
export async function handleGpuCompatibility(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const imageName = url.searchParams.get('image') || '';
  const envStr = url.searchParams.get('env') || '{}';
  const cmdStr = url.searchParams.get('cmd') || '';

  if (!imageName) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing "image" parameter' }));
    return;
  }

  let envVars: Record<string, string> = {};
  try { envVars = JSON.parse(envStr); } catch { /* ignore */ }

  const analysis = analyzeDockerImage(imageName, envVars, cmdStr);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    image: imageName,
    cudaVersion: analysis.detectedCudaVersion,
    architecture: analysis.detectedArchitecture,
    estimatedVramGb: analysis.estimatedVramGb,
    modelHint: analysis.modelHint,
    compatibleGpus: analysis.compatibleGpus.map(c => ({
      name: c.gpu.name,
      vramGb: c.gpu.vramGb,
      architecture: c.gpu.architecture,
      confidence: c.confidence,
      reason: c.reason,
    })),
    incompatibleGpus: analysis.incompatibleGpus.map(i => ({
      name: i.gpu.name,
      reason: i.reason,
    })),
    warnings: analysis.warnings,
  }));
}

