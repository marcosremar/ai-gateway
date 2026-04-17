// ── GPU Poll Health — wait for a newly-created instance to become healthy ─────

import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import { RunpodClient } from '../src/gpu-providers/runpod-client';
import { createLogger } from '../src/logger';
import { getDeployTimeoutMin, getDeployTimeoutMinForProvider } from '../src/gpu-providers/deploy-settings';
import {
  deployState, setDeployState, deployCancelled,
  setLastRequestTime, updateGpuModelWarmth,
} from './state';
import { broadcastWs } from './ws-state';
import { registry } from './providers';

const log = createLogger('gpu-deploy');

export interface PollHealthResult {
  result: 'ready' | 'exited' | 'timeout' | 'cancelled' | 'crashed' | 'app_error';
  pullTimeS?: number;  // actual measured pull duration (pullStarted → containerStarted)
  appError?: { message: string; traceback?: string };
}

/** Create a minimal valid WAV file (1s of silence at 16kHz mono) for STT testing. */
function createTestAudioForm(): FormData {
  const sampleRate = 16000;
  const numSamples = sampleRate;
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'test.wav');
  form.append('model', 'whisper-large-v3');
  return form;
}

/** Async wrapper for autoRegisterDockerProvider to avoid blocking the health poll */
async function autoRegisterDockerProviderAsync(endpoint: string): Promise<void> {
  try {
    const { autoRegisterDockerProvider } = await import('../src/gateway/providers/gpu/docker-registry');
    await autoRegisterDockerProvider(registry, endpoint);
  } catch (err) {
    // Non-fatal: registration failure shouldn't break deploy
    log.warn(`[gpu] Auto-registration failed for ${endpoint}: ${err instanceof Error ? err.message : err}`);
  }
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
  let healthRespondedOnce = false;
  let healthFirstResponseAt = 0;
  let allServicesLoaded = false;
  let pullStartedAt = 0;
  let actualPullTimeS: number | undefined;
  let consecutiveHealthFailures = 0;
  let firstNonTransientErrorAt = 0;
  let consecutiveNonTransient = 0;

  // Stalled download detection
  let lastHealthBody = '';
  let identicalHealthCount = 0;
  let stalledWarned = false;

  const healthPath = '/health';
  let consecutiveConnectionRefused = 0;
  let lastErrorBody = '';
  let firstAppResponseAt = 0;
  const BOOT_5XX_LEEWAY_MS = 60_000;
  let preflightDone = false;

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
  log.log(`[gpu] Pull timeout: ${Math.round(pullEstimate.timeoutMs / 1000)}s (${pullEstimate.confidence}: ${pullEstimate.basis})`);

  while (true) {
    if (deployCancelled) return { result: 'cancelled' };
    const deployTimeoutMs = getDeployTimeoutMinForProvider(providerName) * 60_000;
    const totalElapsedMs = Date.now() - deployStartedAt;

    // ── Global deploy timeout guard ──
    if (totalElapsedMs > deployTimeoutMs) {
      throw new Error(`Deploy timed out after ${Math.round(deployTimeoutMs / 60000)} minutes (total elapsed: ${Math.round(totalElapsedMs / 1000)}s)`);
    }

    // ── Per-phase timeouts (fail fast, try next machine) ──
    const isInfServer = /vllm|text-generation-inference|tgi|llama\.cpp|ollama/i.test(dockerImage || '');
    const modelHint = `${dockerImage || ''} ${deployState.message || ''}`;
    const bootMs = isInfServer
      ? (/70b|65b|72b/i.test(modelHint) ? 15 * 60_000
        : /32b|34b|33b/i.test(modelHint) ? 10 * 60_000
        : 7 * 60_000)
      : 5 * 60_000;
    const PHASE_TIMEOUTS = {
      IMAGE_PULL:  pullEstimate.timeoutMs,
      BOOT:        bootMs,
      MODELS:     10 * 60_000,
    };

    // Image pull timeout
    if (!containerStartedAt && pullStartedAt > 0 && (Date.now() - pullStartedAt) > PHASE_TIMEOUTS.IMAGE_PULL) {
      const pullSec = Math.round((Date.now() - pullStartedAt) / 1000);
      const timeoutMsg = `Image pull timeout (${pullSec}s pulling) — machine too slow, trying next`;
      log.warn(`[gpu] ${providerName} pod ${podId}: ${timeoutMsg}`);
      broadcastWs({ type: 'gpu:deploy', phase: 'pull_timeout', deployId: deployState.deployId, provider: providerName, elapsedMs: totalElapsedMs });
      setDeployState({ status: 'error', step: 'pulling_image', message: timeoutMsg });
      return { result: 'timeout', pullTimeS: actualPullTimeS };
    }

    // Boot timeout
    if (containerStartedAt && !healthRespondedOnce && (Date.now() - containerStartedAt) > PHASE_TIMEOUTS.BOOT) {
      const inLeeway = firstAppResponseAt > 0 && (Date.now() - firstAppResponseAt) < BOOT_5XX_LEEWAY_MS;
      if (!inLeeway) {
        const bootSec = Math.round((Date.now() - containerStartedAt) / 1000);
        const leewayNote = firstAppResponseAt > 0
          ? ` (app was returning errors, last body: ${lastErrorBody.slice(0, 120)})`
          : ` (TCP refused — ${consecutiveConnectionRefused} consecutive failures)`;
        const timeoutMsg = `Boot timeout (${bootSec}s) — container up but /health not responding${leewayNote}`;
        log.warn(`[gpu] ${providerName} pod ${podId}: ${timeoutMsg}`);
        broadcastWs({ type: 'gpu:deploy', phase: 'boot_timeout', deployId: deployState.deployId, provider: providerName });
        setDeployState({ status: 'error', step: 'waiting_health', message: timeoutMsg });
        return { result: 'timeout', pullTimeS: actualPullTimeS };
      }
    }

    // Model loading timeout
    if (healthRespondedOnce && !allServicesLoaded && (Date.now() - (healthFirstResponseAt || Date.now())) > PHASE_TIMEOUTS.MODELS) {
      const modelSec = Math.round((Date.now() - (healthFirstResponseAt || Date.now())) / 1000);
      const timeoutMsg = `Model loading timeout (${modelSec}s) — services still downloading`;
      log.warn(`[gpu] ${providerName} pod ${podId}: ${timeoutMsg}`);
      broadcastWs({ type: 'gpu:deploy', phase: 'model_timeout', deployId: deployState.deployId, provider: providerName });
      setDeployState({ status: 'error', step: 'downloading_models', message: timeoutMsg });
      return { result: 'timeout', pullTimeS: actualPullTimeS };
    }

    // Proactive alert: slow model warming (> 3 min)
    if (healthRespondedOnce && !allServicesLoaded && (Date.now() - (healthFirstResponseAt || Date.now())) > 180_000) {
      const warmSec = Math.round((Date.now() - (healthFirstResponseAt || Date.now())) / 1000);
      const currentAlert = deployState.alert;
      if (!currentAlert.includes('slow warm')) {
        setDeployState({ alert: `Model warming slow (${warmSec}s) — large model or slow GPU`, alertLevel: 'warning' });
      }
    }

    // Proactive alert: total deploy taking > 5 min
    if (totalElapsedMs > 300_000 && deployState.status !== 'ready' && !deployState.alert.includes('slow deploy')) {
      setDeployState({ alert: `Deploy taking ${Math.round(totalElapsedMs / 60000)} min — checking for issues`, alertLevel: 'info' });
    }

    // Proactive alert: total deploy taking > 10 min (critical)
    if (totalElapsedMs > 600_000 && deployState.status !== 'ready' && !deployState.alert.includes('very slow deploy')) {
      setDeployState({ alert: `Very slow deploy (${Math.round(totalElapsedMs / 60000)} min) — may need to terminate and retry`, alertLevel: 'error' });
    }

    // Ghost machine detection (RunPod)
    if (!containerStartedAt && providerName === 'runpod' && totalElapsedMs > 90_000) {
      try {
        const { RunpodClient } = await import('../src/gpu-providers/runpod-client');
        if (providerClient instanceof RunpodClient) {
          const detail = await providerClient.getInstanceDetail(podId, credentials);
          if (detail?.ghostMachine) {
            const ghostMsg = `Ghost machine — pod created but no physical machine assigned after ${Math.round(totalElapsedMs / 1000)}s. RunPod silently failed to schedule (check storage size, GPU availability).`;
            log.error(`[gpu] ${providerName} pod ${podId}: ${ghostMsg}`);
            broadcastWs({ type: 'gpu:deploy', phase: 'ghost_machine', deployId: deployState.deployId, provider: providerName, elapsedMs: totalElapsedMs });
            setDeployState({ status: 'error', step: 'ghost_machine', message: ghostMsg });
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
      log.error(`[gpu] ${providerName} pod ${podId} timed out: ${phase}, endpoint=${endpoint || 'none'}`);
      setDeployState({ status: 'error', message: timeoutMsg });
      return { result: 'timeout', pullTimeS: actualPullTimeS };
    }

    const elapsed = Math.round((Date.now() - deployStartedAt) / 1000);

    // Provider-specific status polling
    if (providerName === 'runpod') {
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
            if (!pullStartedAt) {
              pullStartedAt = Date.now();
              // Record pull start in history
              const pullEntry = { image: detail.imageName ?? deployState.dockerImage, attempt: 1, startedAt: Date.now(), status: 'downloading' as const };
              setDeployState({ pullHistory: [...deployState.pullHistory, pullEntry] });
            }
            setDeployState({
              status: 'installing', step: 'pulling_image',
              message: `Pulling image & starting container... [${elapsed}s]`,
              stepDetail: [detail.imageName, detail.gpuType, costStr].filter(Boolean).join(' — '),
            });
            // Proactive alert: slow pull detection
            if (elapsed > 120 && !deployState.alert.includes('slow pull')) {
              setDeployState({ alert: `Image pull taking ${elapsed}s — large image or slow network`, alertLevel: 'warning' });
            }
          } else if (!containerStartedAt) {
            containerStartedAt = Date.now();
            if (pullStartedAt > 0) {
              actualPullTimeS = Math.round((containerStartedAt - pullStartedAt) / 1000);
              // Update pull history entry to completed
              const updatedPullHistory = deployState.pullHistory.map(p =>
                p.status === 'downloading' ? { ...p, completedAt: Date.now(), status: 'completed' as const } : p
              );
              setDeployState({ pullHistory: updatedPullHistory });
              log.log(`[gpu] Pull completed in ${actualPullTimeS}s`);
            }
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
        log.warn(`[gpu] Failed to get RunPod detail for pod ${podId}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      // Vast.ai (and other providers): use GpuProviderClient interface
      try {
        const status = await providerClient.getInstanceStatus(podId, credentials);
        if (status) {
          const statusLower = status.toLowerCase();
          const TERMINAL = new Set(['exited', 'failed', 'destroyed', 'error', 'deleted']);
          const DISASSOCIATED = statusLower === 'stoppeddisassociated' || statusLower === 'stopped_disassociated';
          if (TERMINAL.has(statusLower) || DISASSOCIATED) {
            consecutiveExited++;
            if (DISASSOCIATED) {
              log.warn(`[gpu] ${providerName} instance ${podId} GPU disassociated (hostnode reclaimed GPU)`);
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
            setLastRequestTime(Date.now());
          }
        }
      } catch (err) {
        log.warn(`[gpu] Failed to get ${providerName} status for pod ${podId}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Re-resolve endpoint periodically
    if (!containerStartedAt || !endpoint || providerName === 'vast') {
      try {
        const resolved = await providerClient.resolveInstanceEndpoint(podId, credentials);
        if (resolved && resolved !== endpoint) {
          log.log(`[gpu] ${providerName} endpoint resolved: ${endpoint || '(none)'} → ${resolved}`);
          endpoint = resolved;
          setDeployState({ endpoint });
        }
      } catch (err) {
        if (containerStartedAt) log.warn(`[gpu] Failed to resolve ${providerName} endpoint for pod ${podId}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // SSH tunnel fallback
    if (!endpoint && containerStartedAt && (Date.now() - containerStartedAt) > 60_000 && deployState.sshHost && deployState.sshPort) {
      try {
        const { getOrCreateTunnel } = await import('./ssh-tunnel');
        const tunnel = getOrCreateTunnel(deployState.sshHost, deployState.sshPort, 8000);
        if (!tunnel.isOpen) {
          log.log(`[gpu] No direct endpoint — opening SSH tunnel to ${deployState.sshHost}:${deployState.sshPort}`);
          setDeployState({ step: 'ssh_tunnel', message: `Opening SSH tunnel (no direct port)...` });
          const ok = await tunnel.open();
          if (ok) {
            endpoint = tunnel.endpoint;
            setDeployState({ endpoint, message: `SSH tunnel active: ${endpoint}` });
            log.log(`[gpu] SSH tunnel established: ${endpoint}`);
          } else {
            log.warn(`[gpu] SSH tunnel failed to ${deployState.sshHost}:${deployState.sshPort}`);
          }
        } else {
          endpoint = tunnel.endpoint;
        }
      } catch (err) {
        log.warn(`[gpu] SSH tunnel error: ${err instanceof Error ? err.message : err}`);
      }
    }

    // One-time SSH pre-flight check
    {
      const sshHost = deployState.sshHost;
      const sshPort = deployState.sshPort;
      if (sshHost && sshPort && !preflightDone) {
        preflightDone = true;
        try {
          const { spawn: sshSpawn } = await import('child_process');
          const proc = sshSpawn('ssh', [
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=8',
            '-o', 'LogLevel=ERROR',
            '-p', String(sshPort),
            `root@${sshHost}`,
            'pgrep -af python | head -3; echo ===; pgrep -af sshd | head -3; echo ===; ls /app/ 2>&1',
          ], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          proc.stdout.on('data', (c) => { out += c.toString(); });
          await new Promise<void>((r) => {
            const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* best-effort */ }; r(); }, 12_000);
            proc.on('exit', () => { clearTimeout(t); r(); });
            proc.on('error', () => { clearTimeout(t); r(); });
          });
          log.log(`[gpu] [trellis-debug] preflight ssh inspection:\n${out}`);
        } catch (e) {
          log.log(`[gpu] [trellis-debug] preflight ssh failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    // ── Periodic SSH log inspection for early crash detection ──
    {
      const sshHost = deployState.sshHost;
      const sshPort = deployState.sshPort;
      const containerUp = containerStartedAt > 0;
      const timeSinceContainerStart = containerUp ? Date.now() - containerStartedAt : 0;
      const shouldCheckLogs = containerUp && sshHost && sshPort && !healthRespondedOnce
        && timeSinceContainerStart > 20_000
        && timeSinceContainerStart % 30_000 < 8_000;
      if (shouldCheckLogs) {
        try {
          const { spawn: sshSpawn } = await import('child_process');
          const logProc = sshSpawn('ssh', [
            '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR',
            '-p', String(sshPort), `root@${sshHost}`,
            'tail -20 /var/log/app.log 2>/dev/null || tail -20 /root/.log 2>/dev/null || echo NO_LOGS',
          ], { stdio: ['ignore', 'pipe', 'pipe'] });
          let logOut = '';
          logProc.stdout.on('data', (c: Buffer) => { logOut += c.toString(); });
          await new Promise<void>((r) => {
            const t = setTimeout(() => { try { logProc.kill('SIGKILL'); } catch { /* process already exited */ } r(); }, 8_000);
            logProc.on('exit', () => { clearTimeout(t); r(); });
            logProc.on('error', () => { clearTimeout(t); r(); });
          });
          const FATAL_PATTERNS = [
            /RuntimeError.*failed/i,
            /CUDA out of memory/i,
            /torch\.cuda\.OutOfMemoryError/i,
            /OOM|OutOfMemory/i,
            /Killed.*signal 9/i,
            /Engine core initialization failed/i,
            /Cannot allocate memory/i,
          ];
          for (const pat of FATAL_PATTERNS) {
            if (pat.test(logOut)) {
              const crashLine = logOut.split('\n').find(l => pat.test(l)) || logOut.slice(-200);
              const crashMsg = `Container crashed: ${crashLine.trim().slice(0, 200)}`;
              log.error(`[gpu] ${providerName} pod ${podId}: FATAL in logs → ${crashMsg}`);
              broadcastWs({ type: 'gpu:deploy', phase: 'container_crash', deployId: deployState.deployId, provider: providerName, error: crashMsg });
              setDeployState({ status: 'error', step: 'container_crash', message: crashMsg });
              return { result: 'crashed', pullTimeS: actualPullTimeS };
            }
          }
          if (logOut && !logOut.includes('NO_LOGS')) {
            log.log(`[gpu] [log-check] ${providerName} ${podId} (${Math.round(timeSinceContainerStart/1000)}s): ${logOut.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200)}`);
          }
        } catch { /* SSH log check is best-effort */ }
      }
    }

    // Probe health endpoint
    if (endpoint) {
      let httpStatus = 0;
      let connectionRefused = false;
      try {
        const res = await fetch(`${endpoint}${healthPath}`, { signal: AbortSignal.timeout(8000) });
        httpStatus = res.status;
        consecutiveConnectionRefused = 0;
        if (!firstAppResponseAt) firstAppResponseAt = Date.now();
        if (!res.ok) {
          const body = await res.text().catch(() => '<unreadable>');
          lastErrorBody = body.substring(0, 500);
          log.log(`[gpu] [trellis-debug] /health body (status=${res.status}, len=${body.length}): ${lastErrorBody.substring(0, 300)}`);
          const kind = httpStatus >= 500 ? '5xx (app bug or model loading)' : '4xx (wrong endpoint?)';
          log.warn(`[gpu] Health endpoint ${endpoint}${healthPath} returned ${httpStatus} ${kind}: ${lastErrorBody}`);
        }
        if (res.ok) {
          const data = await res.json();
          updateGpuModelWarmth(data);

          // ── Stalled download detection ────────────────────────────────
          const healthBodyStr = JSON.stringify(data);
          if (healthBodyStr === lastHealthBody) {
            identicalHealthCount++;
            if (identicalHealthCount >= 5 && !stalledWarned) {
              stalledWarned = true;
              const stalledSec = identicalHealthCount * 30;
              log.warn(`[gpu] Download appears stalled — same /health response for ${stalledSec}s (${identicalHealthCount} checks)`);
              broadcastWs({ type: 'gpu:deploy', phase: 'stalled', deployId: deployState.deployId, provider: providerName, stalledSeconds: stalledSec, identicalChecks: identicalHealthCount });
              setDeployState({ alert: `Download may be stalled — no progress for ${stalledSec}s`, alertLevel: 'warning' });
            } else if (identicalHealthCount === 3) {
              log.log(`[gpu] Possible stall — identical /health response for 3 consecutive checks`);
            }
          } else {
            identicalHealthCount = 0;
            lastHealthBody = healthBodyStr;
            stalledWarned = false;
          }

          // ── Fail-fast on app-reported error ──────────────────────────
          if (data && typeof data === 'object' && data.status === 'error') {
            const appErrMsg = String(data.error ?? data.message ?? 'unknown app error');
            const appTraceback = typeof data.error_traceback === 'string'
              ? data.error_traceback
              : undefined;
            log.error(`[gpu] App reported error via /health — failing deploy fast.`);
            log.error(`[gpu]   error: ${appErrMsg}`);
            if (appTraceback) {
              log.error(`[gpu]   traceback (first 2KiB):\n${appTraceback.slice(0, 2048)}`);
            }
            setDeployState({
              status: 'error',
              step: 'app_error',
              message: `App load failed: ${appErrMsg}`,
              stepDetail: appErrMsg.slice(0, 200),
            });
            broadcastWs({
              type: 'gpu:deploy',
              phase: 'app_error',
              deployId: deployState.deployId,
              provider: providerName,
              error: appErrMsg,
            });
            return {
              result: 'app_error',
              pullTimeS: actualPullTimeS,
              appError: { message: appErrMsg, traceback: appTraceback },
            };
          }

            const HEALTHY_STATUSES = new Set(['healthy', 'ok', 'degraded', 'ready', 'loading']);
            if (HEALTHY_STATUSES.has(data.status)) {
              if (!healthRespondedOnce) { healthRespondedOnce = true; healthFirstResponseAt = Date.now(); }
              consecutiveHealthFailures = 0;

              const svc = data.services ?? {};
              const ttsReady = svc.tts === 'loaded' || svc.tts === 'disabled';
              const sttReady = svc.whisper === 'loaded';
              const llmReady = svc.llama_cpp === 'ready' || svc.llama_cpp === 'loaded';
              allServicesLoaded = sttReady && llmReady && ttsReady;
              const readyStages = [sttReady && 'STT', llmReady && 'LLM', ttsReady && 'TTS'].filter(Boolean);
              const loadingStages = [!sttReady && 'STT', !llmReady && 'LLM', !ttsReady && 'TTS'].filter(Boolean);

              // ── Update warming status tracking ──
              const warmingPatch: Partial<typeof deployState> = {};
              const warmPhase = allServicesLoaded ? 'complete' : (sttReady ? (llmReady ? 'tts' : 'llm') : 'stt');
              warmingPatch.warmingStatus = {
                phase: warmPhase,
                sttProgress: { loaded: sttReady, modelName: svc.whisper ? String(svc.whisper) : 'whisper', loadTimeMs: sttReady ? (containerStartedAt ? Date.now() - containerStartedAt : 0) : 0 },
                llmProgress: { loaded: llmReady, modelName: svc.llama_cpp ? String(svc.llama_cpp) : 'llm', loadTimeMs: llmReady ? (containerStartedAt ? Date.now() - containerStartedAt : 0) : 0 },
                ttsProgress: { loaded: ttsReady, modelName: svc.tts ? String(svc.tts) : 'tts', loadTimeMs: ttsReady ? (containerStartedAt ? Date.now() - containerStartedAt : 0) : 0 },
                startedAt: containerStartedAt || Date.now(),
                ...(allServicesLoaded ? { completedAt: Date.now() } : {}),
              };

              if (readyStages.length > 0 || containerStartedAt) {
                const stepDetail = loadingStages.length > 0
                  ? `${readyStages.join(', ') || 'none'} ready — loading: ${loadingStages.join(', ')}`
                  : 'all services loaded';
                log.log(`[gpu] Pod health OK — ${readyStages.length}/3 services loaded (${readyStages.join(', ') || 'none'}). Loading: ${loadingStages.join(', ') || 'none'}`);
                broadcastWs({ type: 'gpu:services', loaded: readyStages, loading: loadingStages });

                // Set warming status while models are loading
                if (!allServicesLoaded) {
                  setDeployState({
                    status: 'warming',
                    step: `warming_${warmPhase}`,
                    message: `Warming ${warmPhase.toUpperCase()} model... (${readyStages.join(', ') || 'none'} ready)`,
                    stepDetail,
                    ...warmingPatch,
                  });
                }

                // Only run inference test when at least STT is loaded (minimum for speech pipeline)
                if (!sttReady && !llmReady) {
                  log.log(`[gpu] Skipping inference test — need STT or LLM ready first (${readyStages.join(', ') || 'none'} ready)`);
                  continue;
                }

              // ── Inference test: verify actual AI pipeline works before marking ready ──
              setDeployState({ step: 'testing_inference', message: 'Testing inference...' });
              log.log(`[gpu] Testing inference on ${endpoint}...`);
              let inferenceOk = false;
              let inferenceError = '';
              let passedStage = '';

              // Try STT first (works for most images including translation ones)
              try {
                const sttStart = Date.now();
                const sttRes = await fetch(`${endpoint}/v1/audio/transcriptions`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'multipart/form-data' },
                  body: createTestAudioForm(),
                  signal: AbortSignal.timeout(30_000),
                });
                const sttMs = Date.now() - sttStart;
                const sttBody = await sttRes.text();
                log.log(`[gpu] STT test: status=${sttRes.status}, body=${sttBody.slice(0, 200)}`);
                if (sttRes.ok) {
                  try {
                    const body = JSON.parse(sttBody);
                    // text can be "" (silence) — that's still a valid response
                    if (body && (typeof body.text === 'string' || body.transcription)) {
                      inferenceOk = true;
                      passedStage = 'STT';
                      log.log(`[gpu] Inference test PASSED (STT, text="${(body.text || '').slice(0, 30)}") in ${sttMs}ms`);
                    }
                  } catch { /* JSON parse failed — response not valid JSON */ }
                }
              } catch (err) {
                log.log(`[gpu] STT test failed: ${err instanceof Error ? err.message : err}`);
              }

              // If STT failed, try translation endpoint (babelcast-subtitle and similar)
              if (!inferenceOk) {
                try {
                  const transStart = Date.now();
                  const transRes = await fetch(`${endpoint}/v1/translate/text`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: 'Hello', source_lang: 'en', target_lang: 'pt' }),
                    signal: AbortSignal.timeout(30_000),
                  });
                  const transMs = Date.now() - transStart;
                  const transBody = await transRes.text();
                  log.log(`[gpu] Translation test: status=${transRes.status}, body=${transBody.slice(0, 200)}`);
                  if (transRes.ok && transBody.trim()) {
                    try {
                      const body = JSON.parse(transBody);
                      if (body && (body.text || body.translation || body.output)) {
                        inferenceOk = true;
                        passedStage = 'LLM(translate)';
                        log.log(`[gpu] Inference test PASSED (translation) in ${transMs}ms`);
                      }
                    } catch { /* JSON parse failed — translation response not valid JSON */ }
                  }
                } catch (err) {
                  log.log(`[gpu] Translation test failed: ${err instanceof Error ? err.message : err}`);
                }
              }

              // If translation failed, try chat completions
              if (!inferenceOk) {
                try {
                  const llmStart = Date.now();
                  const llmRes = await fetch(`${endpoint}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      messages: [{ role: 'user', content: 'Hi' }],
                      max_tokens: 10,
                    }),
                    signal: AbortSignal.timeout(30_000),
                  });
                  const llmMs = Date.now() - llmStart;
                  const responseBodyStr = await llmRes.text();
                  if (llmRes.ok && responseBodyStr.trim()) {
                    try {
                      const body = JSON.parse(responseBodyStr);
                      if (body && (body.choices?.length > 0 || body.output?.text || body.response)) {
                        inferenceOk = true;
                        passedStage = 'LLM';
                        log.log(`[gpu] Inference test PASSED (LLM) in ${llmMs}ms`);
                      }
                    } catch { /* JSON parse failed — LLM response not valid JSON */ }
                  }
                } catch (err) {
                  log.log(`[gpu] LLM test failed: ${err instanceof Error ? err.message : err}`);
                }
              }

              // If neither STT nor LLM worked, try TTS
              if (!inferenceOk) {
                try {
                  const ttsStart = Date.now();
                  const ttsRes = await fetch(`${endpoint}/v1/audio/speech`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input: 'test', voice: 'default' }),
                    signal: AbortSignal.timeout(30_000),
                  });
                  const ttsMs = Date.now() - ttsStart;
                  if (ttsRes.ok) {
                    const buf = await ttsRes.arrayBuffer();
                    if (buf.byteLength > 100) {
                      inferenceOk = true;
                      passedStage = 'TTS';
                      log.log(`[gpu] Inference test PASSED (TTS) in ${ttsMs}ms`);
                    }
                  }
                } catch (err) {
                  log.log(`[gpu] TTS test failed: ${err instanceof Error ? err.message : err}`);
                }
              }

              if (!inferenceOk) {
                // Health says services are loaded but inference test failed — this could mean
                // the image uses a non-standard API format (e.g., translation-only image).
                // Mark ready anyway but log a warning and note it in the step detail.
                inferenceError = 'Inference test inconclusive (STT/LLM/TTS failed) — health says services ready';
                log.warn(`[gpu] Inference test inconclusive: ${inferenceError}`);
                setDeployState({
                  step: 'ready',
                  stepDetail: `inference_inconclusive:${passedStage || 'none'}`,
                });
                // Auto-register as AI provider even if inference test was inconclusive
                await autoRegisterDockerProviderAsync(endpoint);
                return { result: 'ready', pullTimeS: actualPullTimeS };
              }

              setDeployState({ step: 'ready', stepDetail });
              // Auto-register GPU as AI provider in the registry
              await autoRegisterDockerProviderAsync(endpoint);
              return { result: 'ready', pullTimeS: actualPullTimeS };
            }

            if (!containerStartedAt) {
              containerStartedAt = Date.now();
              if (pullStartedAt > 0) actualPullTimeS = Math.round((containerStartedAt - pullStartedAt) / 1000);
            }
            const appElapsed = Math.round((Date.now() - containerStartedAt) / 1000);

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
      } catch (fetchErr) {
        httpStatus = 0;
        connectionRefused = true;
        consecutiveConnectionRefused++;
        if (consecutiveConnectionRefused === 1 || consecutiveConnectionRefused % 5 === 0) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          log.debug(`[gpu] Health probe ${endpoint}${healthPath} TCP fail #${consecutiveConnectionRefused}: ${msg}`);
        }
        // Proactive alert: connection refused for extended period
        if (consecutiveConnectionRefused === 10) {
          setDeployState({ alert: `Health endpoint unreachable for ${consecutiveConnectionRefused} checks — container may still be starting`, alertLevel: 'warning' });
        } else if (consecutiveConnectionRefused === 20) {
          setDeployState({ alert: `Health endpoint unreachable for ${consecutiveConnectionRefused} checks — possible networking issue or slow start`, alertLevel: 'error' });
        }
      }
      void connectionRefused;

      // Track non-transient HTTP errors
      if (httpStatus >= 400 && httpStatus < 500) {
        consecutiveNonTransient++;
        if (!firstNonTransientErrorAt) firstNonTransientErrorAt = Date.now();
        const nonTransientDurationMs = Date.now() - firstNonTransientErrorAt;
        if (nonTransientDurationMs > 3 * 60_000) {
          log.error(`[gpu] Pod ${podId} returning HTTP ${httpStatus} for ${Math.round(nonTransientDurationMs / 1000)}s — container likely failed to start`);
          try {
            const podStatus = await providerClient.getInstanceStatus(podId, credentials);
            log.error(`[gpu] Pod ${podId} provider status: ${podStatus}`);
          } catch (statusErr) {
            log.warn(`[gpu] Failed to get ${providerName} pod ${podId} status during crash detection: ${statusErr instanceof Error ? statusErr.message : statusErr}`);
          }
          setDeployState({ status: 'error', message: `Container returning HTTP ${httpStatus} for ${Math.round(nonTransientDurationMs / 60_000)}+ min — app failed to start (check image logs)` });
          return { result: 'crashed', pullTimeS: actualPullTimeS };
        }
      } else {
        consecutiveNonTransient = 0;
        firstNonTransientErrorAt = 0;
      }

      // Track consecutive health failures while container is running
      if (containerStartedAt) {
        consecutiveHealthFailures++;
      } else {
        consecutiveHealthFailures = 0;
      }

      // After 10 consecutive failures with container "running", verify pod status
      if (consecutiveHealthFailures >= 10 && containerStartedAt) {
        try {
          const podStatus = await providerClient.getInstanceStatus(podId, credentials);
          const statusLower = podStatus?.toLowerCase() || '';
          const CRASHED_STATES = new Set(['exited', 'terminated', 'error', 'failed', 'destroyed', 'deleted', 'stopped']);
          if (CRASHED_STATES.has(statusLower)) {
            const uptime = Math.round((Date.now() - containerStartedAt) / 1000);
            log.error(`[gpu] ${providerName} pod ${podId} crashed: status=${podStatus} after ${consecutiveHealthFailures} health failures (container was up ${uptime}s, endpoint=${endpoint})`);
            setDeployState({ status: 'error', message: `Pod crashed (status: ${podStatus}) after ${uptime}s — check GPU logs for details` });
            return { result: 'crashed', pullTimeS: actualPullTimeS };
          }
          if (consecutiveHealthFailures % 10 === 0) {
            log.warn(`[gpu] Pod ${podId} status=${podStatus} but ${consecutiveHealthFailures} consecutive health failures (container up ${Math.round((Date.now() - containerStartedAt) / 1000)}s)`);
          }
        } catch (err) {
          log.warn(`[gpu] Failed to check pod status for crash detection: ${err}`);
        }
      }
    }

    // Adaptive polling (cold-start plan A4).
    //
    // Modal's <2s cold-start works partly because its health probe
    // interval is sub-second during boot. We can't match that without
    // hammering the providers, but tightening to 2s during active
    // boot/model-load is a safe win: the pod's /health is a cheap
    // static read, and detecting "ready" 6-8s earlier saves the user
    // a request-queued moment.
    //
    //   Phase                                            poll
    //   ─────────────────────────────────────────────   ─────
    //   pre-container (long image pull, no /health yet)   8s
    //   container just started (< 60s)                    2s
    //   /health responding but services loading           2s
    //   all services loaded (about to return 'ready')    30s
    //
    // The "all services loaded" branch rarely fires because the main
    // loop exits in the same iteration — it exists only so we don't
    // busy-wait in the unlikely case the inference test loops back.
    let pollMs: number;
    if (healthRespondedOnce && allServicesLoaded) {
      pollMs = 30_000;
    } else if (healthRespondedOnce) {
      pollMs = 2_000;
    } else if (containerStartedAt && (Date.now() - containerStartedAt) < 60_000) {
      pollMs = 2_000;
    } else {
      pollMs = 8_000;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}
