// ── Staged Warmth Monitor ─────────────────────────────────────────────────────
// After initial deploy, TTS loads first and pod becomes healthy ("degraded").
// STT + LLM load in the background (~2-5min). We activate the full GPU pipeline
// only when both STT + LLM are warm, so cloud fallbacks handle STT/LLM until ready.

import { createLogger } from '../src/logger';
import { deployState, setDeployState, updateGpuModelWarmth, isStageWarm } from './state';
import { _startReadinessCheck } from './providers';
import { shouldRunGpuReadinessCheck } from './gpu-readiness';
import { broadcastWs } from './ws-state';

const log = createLogger('gpu-deploy');

let warmthMonitorTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * #256 — escalation decision for sustained warmth-probe failure.
 *
 * The monitor marked `stt_ready:false` at exactly 10 consecutive failures but
 * then kept the same cadence forever and never escalated to terminate/redeploy
 * a pod that was clearly not coming up. This maps the consecutive-failure count
 * to a staged action: `none` below the warn threshold, `mark-unhealthy` at
 * `markThreshold` (so the existing behaviour is preserved), and `escalate`
 * once failures reach `escalateThreshold` so the caller can terminate/redeploy.
 * Uses `>=` so the action still fires even if the counter skips the exact
 * threshold.
 */
export function warmthFailureAction(
  consecutiveFailures: number,
  markThreshold = 10,
  escalateThreshold = 20,
): 'none' | 'mark-unhealthy' | 'escalate' {
  if (consecutiveFailures >= escalateThreshold) return 'escalate';
  if (consecutiveFailures >= markThreshold) return 'mark-unhealthy';
  return 'none';
}

export function stopWarmthMonitor() {
  if (warmthMonitorTimer) { clearTimeout(warmthMonitorTimer); warmthMonitorTimer = null; }
}

export function startBackgroundWarmthMonitor(endpoint: string) {
  stopWarmthMonitor();
  void (async () => {
    const shouldRun = await shouldRunGpuReadinessCheck(endpoint);
    if (!shouldRun) {
      log.log('[gpu] Generic GPU app detected — skipping speech warmth monitor');
      setDeployState({ stepDetail: '' });
      return;
    }

  // If already fully warm, run readiness benchmark before activating
  if (isStageWarm('stt') && isStageWarm('llm')) {
    _startReadinessCheck(endpoint);
    return;
  }
  log.log('[gpu] Staged boot: TTS warm — polling until STT + LLM ready before activating full pipeline');

  let warmthPollCount = 0;
  let consecutiveFailures = 0;

  const poll = async () => {
    if (deployState.status !== 'ready' || deployState.endpoint !== endpoint) {
      log.log('[gpu] Warmth monitor: pod changed or offline — stopping');
      stopWarmthMonitor(); // clear timer properly instead of just nulling
      return;
    }
    try {
      // FIX #10: Increased health probe timeout from 6s to 60s
      // Large models (70B+) can take minutes to load, and /health may be unresponsive
      // during model initialization. 60s gives enough time for model loading.
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        updateGpuModelWarmth(data);
        consecutiveFailures = 0; // reset on success
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
        log.log(`[gpu] Warmth poll: stt=${svc.whisper ?? '?'} llm=${svc.llama_cpp ?? '?'} tts=${svc.tts ?? '?'} → STT=${sttWarm} LLM=${llmWarm}`);
        if (sttWarm && llmWarm) {
          log.log('[gpu] STT + LLM warm — running readiness benchmark');
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
      log.debug(`[gpu] Warmth poll failed: ${err instanceof Error ? err.message : err}`);
      consecutiveFailures++;
      // #256: staged escalation instead of a one-time mark-unhealthy that then
      // polls forever at the same cadence.
      const action = warmthFailureAction(consecutiveFailures);
      if (action === 'mark-unhealthy') {
        log.warn(`Health check failed ${consecutiveFailures} consecutive times — marking unhealthy`);
        updateGpuModelWarmth({ stt_ready: false, llm_ready: false });
      } else if (action === 'escalate') {
        log.warn(`Warmth probe failed ${consecutiveFailures} consecutive times during warmup — pod not coming up; stopping warmth monitor for recovery`);
        updateGpuModelWarmth({ stt_ready: false, llm_ready: false });
        stopWarmthMonitor();
        return;
      }
    }
    warmthPollCount++;
    // Adaptive warmth polling: 10s for first 5 checks, then 20s
    const nextDelayMs = warmthPollCount <= 5 ? 10_000 : 20_000;
    warmthMonitorTimer = setTimeout(poll, nextDelayMs);
  };

  warmthMonitorTimer = setTimeout(poll, 5_000); // first check after 5s (not 20s)
  })().catch((err) => log.debug(`[gpu] Warmth monitor capability check failed: ${err instanceof Error ? err.message : err}`));
}
