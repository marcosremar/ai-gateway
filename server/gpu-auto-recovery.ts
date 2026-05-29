// ── GPU Auto-Recovery — reconnect, recover, fetch logs, verified types ────────

import type { ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import { probeGpuHealth } from '../src/autoscaler/health';
import { getGpuPriorityList, DEFAULT_GPU_PRIORITY } from '../src/gpu-providers/deploy-settings';
import { createLogger } from '../src/logger';
import {
  prisma, deployState, setDeployState,
  deployApiKey, deployVastApiKey, deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey, deployHyperstackApiKey,
  setDeployApiKey, setDeployVastApiKey, setDeployTensordockApiKey, setDeployTensordockAuthId, setDeployModalApiKey, setDeployHyperstackApiKey,
  setActiveProvider, setDeployCancelled, setGpuHealthy,
  deploymentSM,
  loadPersistedDeploy, clearPersistedDeploy, persistDeployState,
  resetDeployState,
  updateGpuModelWarmth,
} from './state';
import { markGpuHealthy, runpod, vast, tensordock, modal, hyperstack } from './providers';
import { broadcastWs } from './ws-state';
import { BLACKWELL_TO_STANDARD, STANDARD_TO_BLACKWELL } from './config';
import { POD_NAME_PREFIX } from './gpu-orphan-cleanup';

const log = createLogger('gpu-deploy');

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
    } catch (e) { log.debug(`[gpu] HTTP /logs not available at ${gpuEndpoint}: ${e instanceof Error ? e.message : e}`); }
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
      } catch (sshErr) { log.debug(`[gpu] SSH log fetch failed (${cmd.split(' ')[0]}): ${sshErr instanceof Error ? sshErr.message : sshErr}`); }
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
    log.log(`[gpu] Verified GPU types from benchmarks (${verified.length}): ${verified.join(', ')}`);
    return verified;
  } catch (err) {
    log.warn(`[gpu] Failed to load verified GPU types from DB, using ai-gateway priority list: ${err instanceof Error ? err.message : err}`);
    return getGpuPriorityList().length > 0 ? getGpuPriorityList() : [...DEFAULT_GPU_PRIORITY];
  }
}

/**
 * Attempt to reconnect to a GPU pod that was running before gateway restart.
 * Loads persisted deploy state from disk, probes health, and restores monitoring if alive.
 * Called once at gateway startup.
 */
/** TCP liveness probe — true if host:port accepts a connection within timeoutMs.
 * Used as an SSH-reachability fallback so a pod running a non-serving job (e.g.
 * training) is re-adopted across a gateway restart instead of being discarded. */
function tcpReachable(host: string, port: number, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const net = require('net');
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; try { sock.destroy(); } catch { /* noop */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}
export async function tryRecoverActiveDeploy(): Promise<boolean> {
  const persisted = loadPersistedDeploy();
  if (!persisted) return false;

  log.log(`[gpu] Found persisted deploy: ${persisted.provider}/${persisted.gpuType} pod=${persisted.podId} endpoint=${persisted.endpoint}`);
  log.log(`[gpu] Probing health to check if pod is still alive...`);

  try {
    const probeResult = await probeGpuHealth(persisted.endpoint, true);
    let healthy = probeResult.ok;
    if (probeResult.data) updateGpuModelWarmth(probeResult.data);
    if (!healthy) {
      // /health can be down because the pod is busy with a NON-serving workload
      // (e.g. a training job that doesn't expose the app port) rather than dead.
      // Fall back to an SSH/TCP liveness probe: if the pod answers, the GPU is
      // still alive — re-adopt it instead of orphaning a running job. This is
      // what keeps a training run alive across a gateway restart.
      const sshAlive = persisted.sshHost && persisted.sshPort
        ? await tcpReachable(persisted.sshHost, persisted.sshPort, 6000)
        : false;
      if (!sshAlive) {
        log.log(`[gpu] Persisted pod not health-serving AND SSH unreachable — discarding`);
        clearPersistedDeploy();
        return false;
      }
      log.log(`[gpu] /health down but SSH alive (${persisted.sshHost}:${persisted.sshPort}) — re-adopting running pod (likely an active job)`);
    }

    // Pod is alive (health-serving or SSH-reachable)! Restore state
    log.log(`[gpu] Pod still alive — reconnecting${healthy ? '' : ' (SSH-only, job in progress)'}...`);
    setDeployCancelled(false);
    setDeployState({
      status: 'ready',
      deployId: persisted.deployId || '',
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
      ...(persisted.devMode ? { devMode: true } : {}),
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
    } else if (persisted.provider === 'hyperstack') {
      setDeployHyperstackApiKey(process.env.HYPERSTACK_API_KEY || '');
    }
    setActiveProvider(persisted.provider as ProviderName);

    // Mark GPU healthy and set up translation routing
    markGpuHealthy();
    setGpuHealthy(true);
    deploymentSM.markReady(persisted.podId, persisted.endpoint, persisted.gpuType, persisted.costPerHr);

    // Start monitoring
    const { startGpuMonitoring } = await import('./gpu-health-monitor');
    startGpuMonitoring();

    log.log(`[gpu] Successfully reconnected to ${persisted.provider} pod ${persisted.podId} (${persisted.gpuType} @ $${persisted.costPerHr}/hr)`);
    return true;
  } catch (err) {
    log.warn(`[gpu] Recovery probe failed: ${err instanceof Error ? err.message : err}`);
    clearPersistedDeploy();
    return false;
  }
}

/**
 * Scan all configured providers for running pods matching our naming prefix
 * that we have NOT recovered from `active_deploy.json`, probe their /health,
 * and reconnect to the first healthy one instead of letting orphan-sweep
 * terminate it.
 *
 * Called at startup AFTER tryRecoverActiveDeploy returns false, so it acts as
 * a fallback for cases where active_deploy.json is missing/stale but a pod is
 * still running (e.g. hard crash before persistDeployState, or file was hand-deleted).
 */
export async function tryReconnectOrphanDeploy(): Promise<boolean> {
  if (deployState.status === 'ready' || deployState.status === 'booting' || deployState.status === 'installing') {
    return false; // already active or reconnecting
  }

  type Candidate = {
    provider: ProviderName;
    instanceId: string;
    endpoint: string;
    gpuType: string;
    sshHost: string;
    sshPort: number;
    providerMeta: Record<string, unknown>;
    apiKey: string;
    authId?: string;
    costPerHr?: number;
  };
  const candidates: Candidate[] = [];

  const rpKey = process.env.RUNPOD_API_KEY || deployApiKey;
  if (rpKey) {
    try {
      const instances = await runpod.listInstances({ apiKey: rpKey });
      for (const i of instances) {
        if (!(i.instanceName || '').startsWith(POD_NAME_PREFIX)) continue;
        if (!['RUNNING', 'running', 'active'].includes(i.status)) continue;
        if (!i.endpoint) continue;
        candidates.push({
          provider: 'runpod', instanceId: i.instanceId, endpoint: i.endpoint,
          gpuType: i.gpuType ?? '', sshHost: i.sshHost ?? '', sshPort: i.sshPort ?? 0,
          providerMeta: (i.providerMeta as Record<string, unknown>) ?? {}, apiKey: rpKey,
        });
      }
    } catch (err) {
      log.warn(`[gpu] orphan-reconnect: RunPod list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const vastKey = process.env.VAST_API_KEY || deployVastApiKey;
  if (vastKey) {
    try {
      const instances = await vast.listInstances({ apiKey: vastKey });
      for (const i of instances) {
        const st = (i.status ?? '').toLowerCase();
        if (!['running', 'active'].includes(st)) continue;
        if (!i.endpoint) continue;
        candidates.push({
          provider: 'vast', instanceId: i.instanceId, endpoint: i.endpoint,
          gpuType: i.gpuType ?? '', sshHost: i.sshHost ?? '', sshPort: i.sshPort ?? 0,
          providerMeta: (i.providerMeta as Record<string, unknown>) ?? {}, apiKey: vastKey,
        });
      }
    } catch (err) {
      log.warn(`[gpu] orphan-reconnect: Vast list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const tdKey = process.env.TENSORDOCK_API_KEY || deployTensordockApiKey;
  const tdAuth = process.env.TENSORDOCK_AUTH_ID || deployTensordockAuthId;
  if (tdKey) {
    try {
      const instances = await tensordock.listInstances({ apiKey: tdKey, authId: tdAuth });
      for (const i of instances) {
        const st = (i.status ?? '').toLowerCase();
        if (!['running', 'active'].includes(st)) continue;
        if (!i.endpoint) continue;
        candidates.push({
          provider: 'tensordock', instanceId: i.instanceId, endpoint: i.endpoint,
          gpuType: i.gpuType ?? '', sshHost: i.sshHost ?? '', sshPort: i.sshPort ?? 0,
          providerMeta: (i.providerMeta as Record<string, unknown>) ?? {}, apiKey: tdKey, authId: tdAuth,
        });
      }
    } catch (err) {
      log.warn(`[gpu] orphan-reconnect: TensorDock list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const modalKey = process.env.MODAL_TOKEN_ID || deployModalApiKey;
  if (modalKey) {
    try {
      const instances = await modal.listInstances({ apiKey: modalKey });
      for (const i of instances) {
        const st = (i.status ?? '').toLowerCase();
        if (!['running', 'deployed', 'active'].includes(st)) continue;
        if (!i.endpoint) continue;
        candidates.push({
          provider: 'modal', instanceId: i.instanceId, endpoint: i.endpoint,
          gpuType: i.gpuType ?? '', sshHost: i.sshHost ?? '', sshPort: i.sshPort ?? 0,
          providerMeta: (i.providerMeta as Record<string, unknown>) ?? {}, apiKey: modalKey,
        });
      }
    } catch (err) {
      log.warn(`[gpu] orphan-reconnect: Modal list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const hyperstackKey = process.env.HYPERSTACK_API_KEY || deployHyperstackApiKey;
  if (hyperstackKey) {
    try {
      const instances = await hyperstack.listInstances({ apiKey: hyperstackKey });
      for (const i of instances) {
        const st = (i.status ?? '').toLowerCase();
        if (!['running', 'active'].includes(st)) continue;
        if (!i.endpoint) continue;
        candidates.push({
          provider: 'hyperstack', instanceId: i.instanceId, endpoint: i.endpoint,
          gpuType: i.gpuType ?? '', sshHost: i.sshHost ?? '', sshPort: i.sshPort ?? 0,
          providerMeta: (i.providerMeta as Record<string, unknown>) ?? {}, apiKey: hyperstackKey,
        });
      }
    } catch (err) {
      log.warn(`[gpu] orphan-reconnect: Hyperstack list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (candidates.length === 0) return false;

  log.log(`[gpu] orphan-reconnect: found ${candidates.length} running pod(s) — probing health to reconnect`);

  for (const c of candidates) {
    try {
      const probe = await probeGpuHealth(c.endpoint, true);
      if (!probe.ok) {
        log.log(`[gpu] orphan-reconnect: ${c.provider}/${c.instanceId} not healthy — skipping`);
        continue;
      }
      log.log(`[gpu] orphan-reconnect: reconnecting to ${c.provider}/${c.instanceId} @ ${c.endpoint}`);

      setDeployCancelled(false);
      if (c.provider === 'runpod') setDeployApiKey(c.apiKey);
      else if (c.provider === 'vast') setDeployVastApiKey(c.apiKey);
      else if (c.provider === 'tensordock') {
        setDeployTensordockApiKey(c.apiKey);
        if (c.authId) setDeployTensordockAuthId(c.authId);
      } else if (c.provider === 'modal') setDeployModalApiKey(c.apiKey);
      else if (c.provider === 'hyperstack') setDeployHyperstackApiKey(c.apiKey);
      setActiveProvider(c.provider as ProviderName);

      if (probe.data) updateGpuModelWarmth(probe.data);
      setDeployState({
        status: 'ready',
        podId: c.instanceId,
        endpoint: c.endpoint,
        gpuType: c.gpuType,
        provider: c.provider as ProviderName,
        sshHost: c.sshHost,
        sshPort: c.sshPort,
        providerMeta: c.providerMeta,
        costPerHr: c.costPerHr ?? 0,
        startedAt: Date.now(),
        message: `Reconnected to orphan pod after restart (${c.provider}/${c.gpuType})`,
        step: 'ready',
        stepDetail: '',
        alert: 'Reconnected to running pod discovered via provider scan',
        alertLevel: 'info',
      });
      persistDeployState();
      markGpuHealthy();
      setGpuHealthy(true);
      deploymentSM.markReady(c.instanceId, c.endpoint, c.gpuType, c.costPerHr ?? 0);

      const { startGpuMonitoring } = await import('./gpu-health-monitor');
      startGpuMonitoring();
      broadcastWs({ type: 'gpu:orphan_reconnect', provider: c.provider, podId: c.instanceId, endpoint: c.endpoint });
      return true;
    } catch (err) {
      log.warn(`[gpu] orphan-reconnect: ${c.provider}/${c.instanceId} probe failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return false;
}

// ── Auto-Recovery Deploy ──────────────────────────────────────────────────────
// Called when GPU is condemned — deploys a replacement with the same config.
// If the current machine has some services working, the new machine gets
// the full config so all services are tested. Once the replacement passes
// readiness, it becomes the active machine (handled by the normal deploy flow).

export async function startAutoRecoveryDeploy(): Promise<void> {
  // Prevent concurrent deploys — bail if another deploy is in progress.
  // Only status indicates an active deploy; step can be stale from a
  // previous failure (e.g. pollHealthUntilReady sets step='waiting_health'
  // on boot timeout, and the step is never reset when the error propagates).
  if (deployState.status === 'creating' || deployState.status === 'booting') {
    log.warn('[gpu] Auto-recovery: deploy already in progress — skipping');
    return;
  }

  const lastImage = deployState.dockerImage;
  const lastGpuType = deployState.gpuType;
  const lastProvider = deployState.provider;

  if (!lastImage) {
    log.warn('[gpu] Auto-recovery: no Docker image from last deploy — skipping');
    return;
  }

  // Save API keys BEFORE reset (resetDeployState clears them)
  const savedKeys = {
    runpod: deployApiKey,
    vast: deployVastApiKey,
    tensordock: deployTensordockApiKey ? { apiKey: deployTensordockApiKey, authId: deployTensordockAuthId } : undefined,
    modal: deployModalApiKey,
    hyperstack: deployHyperstackApiKey,
  };

  log.log(`[gpu] Auto-recovery: deploying replacement (image=${lastImage}, lastGpu=${lastGpuType}, lastProvider=${lastProvider})`);
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
  if (savedKeys.hyperstack) setDeployHyperstackApiKey(savedKeys.hyperstack);

  // Build tiers from saved credentials
  const { buildGpuTiers, startDeployWithTiers } = await import('./gpu-deploy');
  const tiers = buildGpuTiers(
    savedKeys.runpod,
    savedKeys.vast || undefined,
    savedKeys.tensordock,
    savedKeys.modal || undefined,
    savedKeys.hyperstack || undefined,
  );

  if (tiers.length === 0) {
    log.error('[gpu] Auto-recovery: no provider tiers available — staying on cloud');
    broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'auto-recovery-failed', error: 'No provider credentials' });
    return;
  }

  // Use the same GPU types from the priority list, or fallback to the last used type
  const gpuTypes = lastGpuType ? [lastGpuType] : getGpuPriorityList();

  try {
    await startDeployWithTiers(tiers, lastImage, gpuTypes, { autoRecovery: true });
    log.log('[gpu] Auto-recovery: deploy started — readiness check will run automatically');
  } catch (err) {
    log.error(`[gpu] Auto-recovery deploy failed: ${err instanceof Error ? err.message : err}`);
    broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'auto-recovery-failed', error: err instanceof Error ? err.message : 'Deploy failed' });
  }
}
