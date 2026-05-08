// ── BabelCast Gateway — GPU Readiness Benchmark ────────────────────────────
// Per-service benchmark (STT, LLM, TTS) with up to benchmarkMaxRuns attempts.
// Effective target = configuredMax * (1 - benchmarkMarginPct / 100).
// Stops early when a service hits its target. After all services pass → shadow mode.
// Shadow mode: GPU runs in background, cloud serves users; activate after shadowRuns
// consecutive successes → GPU activated for production.
//
// Repechage: if max runs exhausted without hitting target → schedule retry in 2min,
// broadcast 'repechage' status so UI can warn and caller can start a new pod.
//
// WS events:
//   { type: 'gpu:readiness', stage: 'llm'|'stt'|'tts'|'all', phase, run?, totalRuns?, latencyMs?, targetMs, passed?, medianLatencyMs? }

import { createLogger } from '../src/logger';
const log = createLogger('gpu-readiness');

import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  deployState,
  setServiceReadiness, setGpuReadinessState, gpuReadinessState,
  setGpuShadowMode, setGpuReadyForProduction,
  isStageWarm, resetPerStageLatencyRings,
} from './state';
import { broadcastWs } from './ws-state';
import {
  getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs,
  getBenchmarkMaxRuns, getBenchmarkMarginPct, getShadowRuns,
  getRepechageMaxAttempts,
  getAutoRecoveryEnabled, getAutoRecoveryDelaySec, getAutoRecoveryMaxRetries,
} from '../src/gpu-providers/deploy-settings';

// ── Persistent history ────────────────────────────────────────────────────────

const HISTORY_PATH = path.join(os.homedir(), '.babelcast', 'gpu-readiness-history.json');

export interface ReadinessRun {
  ts: number;
  stage: 'stt' | 'llm' | 'tts';
  samples: number[];
  bestLatencyMs: number;
  targetMs: number;
  passed: boolean;
  runsUsed: number;
}

export interface ReadinessRecord {
  runs: ReadinessRun[];          // last 30, all stages
  lastRunAt: number;
  avgPassedMs: Partial<Record<'stt' | 'llm' | 'tts', number>>;
}

export type ReadinessHistory = Record<string, ReadinessRecord>; // key = "dockerImage:gpuType"

function historyKey(): string {
  return `${deployState.dockerImage}:${deployState.gpuType}`;
}

function loadHistory(): ReadinessHistory {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { return {}; }
}

// Async save with debounce — avoids blocking the event loop during benchmark hot path
let _pendingSaveRun: ReturnType<typeof setTimeout> | null = null;
let _pendingSaveData: { hist: ReadinessHistory } | null = null;

function saveRun(stage: 'stt' | 'llm' | 'tts', samples: number[], bestMs: number, targetMs: number, passed: boolean): void {
  try {
    const hist = _pendingSaveData?.hist ?? loadHistory();
    const key = historyKey();
    const rec: ReadinessRecord = hist[key] ?? { runs: [], lastRunAt: 0, avgPassedMs: {} };
    rec.runs = [...rec.runs.slice(-29), { ts: Date.now(), stage, samples, bestLatencyMs: bestMs, targetMs, passed, runsUsed: samples.length }];
    const passedForStage = rec.runs.filter(r => r.stage === stage && r.passed);
    if (passedForStage.length > 0) {
      rec.avgPassedMs[stage] = Math.round(passedForStage.reduce((s, r) => s + r.bestLatencyMs, 0) / passedForStage.length);
    }
    rec.lastRunAt = Date.now();
    hist[key] = rec;
    _pendingSaveData = { hist };

    // Debounce: batch writes over 500ms to reduce disk I/O during rapid benchmark iterations
    if (_pendingSaveRun) clearTimeout(_pendingSaveRun);
    _pendingSaveRun = setTimeout(() => {
      _pendingSaveRun = null;
      if (!_pendingSaveData) return;
      try {
        const dir = path.dirname(HISTORY_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(_pendingSaveData.hist, null, 2));
      } catch { /* ignore */ }
      _pendingSaveData = null;
    }, 500);
  } catch { /* ignore */ }
}

export function getReadinessHistory(): ReadinessHistory { return loadHistory(); }

// ── Shadow mode persistence ───────────────────────────────────────────────────
// Survives gateway restart so shadow progress isn't lost mid-validation.

const SHADOW_STATE_FILE = path.join(os.homedir(), '.babelcast', 'shadow-state.json');

interface PersistedShadowState {
  completedRuns: number;
  endpoint: string;
  savedAt: number;
}

function loadShadowRuns(): number {
  try {
    if (!fs.existsSync(SHADOW_STATE_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(SHADOW_STATE_FILE, 'utf8')) as PersistedShadowState;
    // Only restore if saved within the last 10 minutes and same endpoint
    if (Date.now() - data.savedAt > 10 * 60 * 1000) return 0;
    if (data.endpoint !== deployState.endpoint) return 0;
    return data.completedRuns ?? 0;
  } catch { return 0; }
}

let _shadowSaveTimer: ReturnType<typeof setTimeout> | null = null;

function saveShadowRuns(completedRuns: number): void {
  // Debounce: write at most once per second to reduce disk I/O
  if (_shadowSaveTimer) clearTimeout(_shadowSaveTimer);
  _shadowSaveTimer = setTimeout(() => {
    _shadowSaveTimer = null;
    try {
      const dir = path.dirname(SHADOW_STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SHADOW_STATE_FILE, JSON.stringify({ completedRuns, endpoint: deployState.endpoint, savedAt: Date.now() }));
    } catch { /* ignore */ }
  }, 1000);
}

function clearShadowRuns(): void {
  try { if (fs.existsSync(SHADOW_STATE_FILE)) fs.unlinkSync(SHADOW_STATE_FILE); } catch { /* ignore */ }
}

// ── State ─────────────────────────────────────────────────────────────────────

let checkInProgress = false;
let repechageTimer: ReturnType<typeof setTimeout> | null = null;
let autoRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let repechageEndpoint = '';

export function isReadinessCheckInProgress(): boolean { return checkInProgress; }
/** True when an auto-recovery deploy is scheduled or in progress */
export function isAutoRecoveryPending(): boolean { return autoRecoveryTimer !== null; }

export function resetReadinessCheck(): void {
  checkInProgress = false;
  if (repechageTimer) { clearTimeout(repechageTimer); repechageTimer = null; }
  if (autoRecoveryTimer) { clearTimeout(autoRecoveryTimer); autoRecoveryTimer = null; }
  repechageEndpoint = '';
  clearShadowRuns();
  shadowStartedAt = 0;
  setGpuReadinessState({ autoRecoveryAttempt: 0 });
}

function hasSpeechPipelineHealth(data: Record<string, unknown>): boolean {
  const services = data.services;
  if (services && typeof services === 'object') {
    const svc = services as Record<string, unknown>;
    return ['whisper', 'llama_cpp', 'tts', 'stt', 'llm'].some((key) => key in svc);
  }
  return ['stt_ready', 'llm_ready', 'tts_ready', 'whisper_ready', 'llama_ready'].some((key) => key in data);
}

function hasSpeechPipelinePaths(paths: string[]): boolean {
  // The readiness check benchmarks STT + LLM + TTS in series, so it is only
  // meaningful for a *full* speech pipeline pod. Single-stage pods (TTS-only,
  // STT-only, LLM-only) would never satisfy the warmth gate and the monitor
  // would orphan-terminate them after ~4 minutes — confirmed in production
  // with the canal-dark qwen3-tts pod (only exposes /v1/audio/speech and
  // /v1/audio/speech/clone). Require evidence of all three stages before
  // claiming the pipeline is present.
  const hasStt = paths.some((path) =>
    path === '/v1/transcribe' || path === '/v1/audio/transcriptions'
  );
  const hasLlm = paths.some((path) =>
    path === '/v1/translate/text' || path === '/v1/chat/completions'
  );
  const hasTts = paths.some((path) =>
    path === '/v1/tts' || path === '/v1/audio/speech'
  );
  return hasStt && hasLlm && hasTts;
}

function hasGenericGpuAppPaths(paths: string[]): boolean {
  return paths.some((path) =>
    path === '/generate' ||
    path === '/generate-from-text' ||
    path === '/generate-from-url'
  );
}

export async function shouldRunGpuReadinessCheck(endpoint: string): Promise<boolean> {
  try {
    const health = await fetch(`${endpoint.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3_000) });
    if (health.ok) {
      const data = await health.json().catch(() => null) as Record<string, unknown> | null;
      if (data && hasSpeechPipelineHealth(data)) return true;
    }
  } catch {
    return true;
  }

  try {
    const openapi = await fetch(`${endpoint.replace(/\/$/, '')}/openapi.json`, { signal: AbortSignal.timeout(3_000) });
    if (!openapi.ok) return true;
    const doc = await openapi.json().catch(() => null) as { paths?: Record<string, unknown> } | null;
    const paths = Object.keys(doc?.paths ?? {});
    if (hasSpeechPipelinePaths(paths)) return true;
    if (hasGenericGpuAppPaths(paths)) return false;
    // Pod served openapi.json but neither full speech pipeline nor a known
    // generic-app shape matched — that means it is a single-stage pod
    // (TTS-only, STT-only, image-gen, alignment, etc). The readiness
    // benchmark would orphan-terminate it after ~4 min waiting for stages
    // it never has, so treat it like a generic GPU app and skip warmth.
    return false;
  } catch {
    return true;
  }

  return true;
}

// ── Pre-built silence WAV for STT benchmarks (reused across all runs) ────────

const STT_BENCH_WAV = (() => {
  const headerSize = 44, dataSize = 32000; // 1s 16kHz 16-bit mono silence
  const wav = Buffer.alloc(headerSize + dataSize);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
  return new Blob([wav], { type: 'audio/wav' });
})();

// ── Benchmark one service ─────────────────────────────────────────────────────

async function benchmarkService(
  stage: 'stt' | 'llm' | 'tts',
  endpoint: string,
  targetMs: number,
  maxRuns: number,
): Promise<{ passed: boolean; bestMs: number; samples: number[] }> {
  const samples: number[] = [];
  let bestMs = Infinity;

  for (let i = 0; i < maxRuns; i++) {
    if (deployState.endpoint !== endpoint || deployState.status !== 'ready') {
      return { passed: false, bestMs: bestMs === Infinity ? 0 : bestMs, samples };
    }

    const t0 = Date.now();
    let reqOk = false;
    try {
      if (stage === 'llm') {
        const res = await fetch(`${endpoint}/v1/translate/text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'The quick brown fox jumps over the lazy dog.', source_lang: 'en', target_lang: 'fr' }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.json();
      } else if (stage === 'stt') {
        const form = new FormData();
        form.append('file', STT_BENCH_WAV, 'bench.wav');
        const res = await fetch(`${endpoint}/v1/transcribe?language=en`, {
          method: 'POST', body: form, signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.json();
      } else { // tts
        const res = await fetch(`${endpoint}/v1/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'Hello world.', language: 'English', speaker: 'Ryan' }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.arrayBuffer();
      }
      reqOk = true;
    } catch (err) {
      log.warn(`[readiness:${stage}] Run ${i + 1} failed: ${err instanceof Error ? err.message : err}`);
    }

    const ms = Date.now() - t0;
    // Only count successful requests for latency — errors don't prove the service is fast
    if (reqOk) {
      samples.push(ms);
      if (ms < bestMs) bestMs = ms;
    }

    setServiceReadiness(stage, { completedRuns: i + 1, latencySamples: [...samples], bestLatencyMs: bestMs === Infinity ? null : bestMs });
    // Batch broadcasts: send every 3rd run or on first/last to reduce WS traffic
    if (i === 0 || (i + 1) % 3 === 0 || i === maxRuns - 1) {
      broadcastWs({ type: 'gpu:readiness', stage, phase: 'benchmarking', run: i + 1, totalRuns: maxRuns, latencyMs: ms, bestLatencyMs: bestMs, targetMs });
    }
    log.log(`[readiness:${stage}] Run ${i + 1}/${maxRuns}: ${ms}ms (best: ${bestMs}ms, target: ${targetMs}ms)`);

    if (bestMs <= targetMs) {
      log.log(`[readiness:${stage}] Target hit on run ${i + 1} — PASS ✓`);
      return { passed: true, bestMs, samples };
    }
  }

  return { passed: false, bestMs: bestMs === Infinity ? 0 : bestMs, samples };
}

// ── Main readiness check ──────────────────────────────────────────────────────

export async function runGpuReadinessCheck(
  endpoint: string,
  onPass: () => void,
  onFail: (stage: string, bestMs: number, targetMs: number) => void,
): Promise<void> {
  if (checkInProgress) return;
  checkInProgress = true;

  const maxRuns = getBenchmarkMaxRuns();
  const marginPct = getBenchmarkMarginPct();
  const margin = 1 - marginPct / 100;

  const targets = {
    stt: Math.round(getSttTargetLatencyMs() * margin),
    llm: Math.round(getLlmTargetLatencyMs() * margin),
    tts: Math.round(getTtsTargetLatencyMs() * margin),
  };

  // Fast-track: skip benchmark for known-reliable hosts
  try {
    const { deriveHostKey } = await import('./metrics');
    const hostKey = deriveHostKey(deployState.provider, deployState.providerMeta);
    if (hostKey) {
      const { prisma } = await import('./state');
      const rep = await prisma.hostReputation.findUnique({ where: { hostKey } });
      if (rep && rep.successCount >= 5 && rep.reputationScore >= 0.8 && rep.crashCount === 0) {
        log.log(`[readiness] Fast-track: host ${hostKey} has ${rep.successCount} successes, score=${rep.reputationScore.toFixed(2)} — skipping benchmark, entering shadow mode`);
        for (const stage of ['stt', 'llm', 'tts'] as const) {
          setServiceReadiness(stage, { phase: 'ready', bestLatencyMs: rep.avgLatencyMs, targetMs: targets[stage] });
        }
        broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'fast-tracked', hostKey, reputationScore: rep.reputationScore });
        checkInProgress = false;
        onPass();
        return;
      }
    }
  } catch (e) { log.warn('[readiness] Fast-track check failed:', e instanceof Error ? e.message : e); }

  log.log(`[readiness] Starting per-service benchmark (max ${maxRuns} runs, ${marginPct}% margin):`,
    `STT<${targets.stt}ms LLM<${targets.llm}ms TTS<${targets.tts}ms`);

  broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'benchmarking', targets, maxRuns });

  // Initialize state for all services
  for (const stage of ['stt', 'llm', 'tts'] as const) {
    setServiceReadiness(stage, { phase: 'benchmarking', completedRuns: 0, latencySamples: [], targetMs: targets[stage], bestLatencyMs: null });
  }

  try {
    // Benchmark STT and LLM in parallel (they hit independent endpoints on the GPU)
    const [sttResult, llmResult] = await Promise.all([
      benchmarkService('stt', endpoint, targets.stt, maxRuns),
      benchmarkService('llm', endpoint, targets.llm, maxRuns),
    ]);

    // Process STT result
    setServiceReadiness('stt', { phase: sttResult.passed ? 'ready' : 'failed', bestLatencyMs: sttResult.bestMs });
    saveRun('stt', sttResult.samples, sttResult.bestMs, targets.stt, sttResult.passed);
    broadcastWs({ type: 'gpu:readiness', stage: 'stt', phase: sttResult.passed ? 'ready' : 'failed', bestLatencyMs: sttResult.bestMs, targetMs: targets.stt, passed: sttResult.passed, runsUsed: sttResult.samples.length });

    // Process LLM result
    setServiceReadiness('llm', { phase: llmResult.passed ? 'ready' : 'failed', bestLatencyMs: llmResult.bestMs });
    saveRun('llm', llmResult.samples, llmResult.bestMs, targets.llm, llmResult.passed);
    broadcastWs({ type: 'gpu:readiness', stage: 'llm', phase: llmResult.passed ? 'ready' : 'failed', bestLatencyMs: llmResult.bestMs, targetMs: targets.llm, passed: llmResult.passed, runsUsed: llmResult.samples.length });

    // Feed benchmark results into host reputation (seeds initial per-stage latency data)
    if (deployState.provider && deployState.gpuType) {
      try {
        const { updateHostLatency } = await import('./metrics');
        if (sttResult.passed && sttResult.bestMs < Infinity) {
          await updateHostLatency(deployState.provider, deployState.gpuType, sttResult.bestMs, 'stt', deployState.providerMeta);
        }
        if (llmResult.passed && llmResult.bestMs < Infinity) {
          await updateHostLatency(deployState.provider, deployState.gpuType, llmResult.bestMs, 'llm', deployState.providerMeta);
        }
        log.log(`[readiness] Fed benchmark results into reputation: STT=${sttResult.bestMs}ms LLM=${llmResult.bestMs}ms`);
      } catch (e) { log.warn('[readiness] Reputation update failed:', e instanceof Error ? e.message : e); }
    }

    // Progressive relaxation: try 15% more lenient target before repechage
    if (!sttResult.passed && sttResult.bestMs <= targets.stt * 1.15) {
      const relaxedTarget = Math.round(targets.stt * 1.15);
      log.log(`[readiness:stt] Relaxing target ${targets.stt}ms → ${relaxedTarget}ms (best was ${sttResult.bestMs}ms)`);
      setServiceReadiness('stt', { phase: 'ready', bestLatencyMs: sttResult.bestMs });
      broadcastWs({ type: 'gpu:readiness', stage: 'stt', phase: 'ready', bestLatencyMs: sttResult.bestMs, targetMs: relaxedTarget, passed: true, runsUsed: sttResult.samples.length });
      // Continue to LLM check instead of repechage
    } else if (!sttResult.passed) {
      log.warn(`[readiness:stt] FAIL — best=${sttResult.bestMs}ms target=${targets.stt}ms`);
      if (deployState.endpoint === endpoint) {
        scheduleRepechage(endpoint, onPass, onFail);
        onFail('stt', sttResult.bestMs, targets.stt);
      }
      checkInProgress = false;
      return;
    }

    // Progressive relaxation: try 15% more lenient target before repechage
    if (!llmResult.passed && llmResult.bestMs <= targets.llm * 1.15) {
      const relaxedTarget = Math.round(targets.llm * 1.15);
      log.log(`[readiness:llm] Relaxing target ${targets.llm}ms → ${relaxedTarget}ms (best was ${llmResult.bestMs}ms)`);
      setServiceReadiness('llm', { phase: 'ready', bestLatencyMs: llmResult.bestMs });
      broadcastWs({ type: 'gpu:readiness', stage: 'llm', phase: 'ready', bestLatencyMs: llmResult.bestMs, targetMs: relaxedTarget, passed: true, runsUsed: llmResult.samples.length });
      // Continue to TTS check instead of repechage
    } else if (!llmResult.passed) {
      log.warn(`[readiness:llm] FAIL — best=${llmResult.bestMs}ms target=${targets.llm}ms`);
      if (deployState.endpoint === endpoint) {
        scheduleRepechage(endpoint, onPass, onFail);
        onFail('llm', llmResult.bestMs, targets.llm);
      }
      checkInProgress = false;
      return;
    }

    // Start TTS benchmark in background (non-blocking — TTS failure doesn't stop activation)
    const ttsBenchmarkPromise = (async () => {
      // Pre-warm TTS: absorb CUDA graph compilation (~11-30s) before the latency benchmark.
      // Without this, the first TTS inference always misses the target (300ms vs 11s cold start).
      if (!isStageWarm('tts')) {
        log.log('[readiness:tts] Pre-warming TTS (CUDA graph compilation)...');
        broadcastWs({ type: 'gpu:readiness', stage: 'tts', phase: 'warming' });
        const warmStart = Date.now();
        try {
          const res = await fetch(`${endpoint}/v1/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Hello world.', language: 'English', speaker: 'Ryan' }),
            signal: AbortSignal.timeout(60_000),
          });
          if (res.ok) {
            log.log(`[readiness:tts] TTS pre-warm done in ${Date.now() - warmStart}ms`);
          } else {
            log.warn(`[readiness:tts] TTS pre-warm HTTP ${res.status} — benchmark may fail`);
          }
        } catch (e) {
          log.warn(`[readiness:tts] TTS pre-warm failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      // Benchmark TTS after STT+LLM pass
      const ttsResult = await benchmarkService('tts', endpoint, targets.tts, maxRuns);
      setServiceReadiness('tts', { phase: ttsResult.passed ? 'ready' : 'failed', bestLatencyMs: ttsResult.bestMs });
      saveRun('tts', ttsResult.samples, ttsResult.bestMs, targets.tts, ttsResult.passed);
      broadcastWs({ type: 'gpu:readiness', stage: 'tts', phase: ttsResult.passed ? 'ready' : 'failed', bestLatencyMs: ttsResult.bestMs, targetMs: targets.tts, passed: ttsResult.passed, runsUsed: ttsResult.samples.length });

      // Feed TTS benchmark result into reputation
      if (ttsResult.passed && ttsResult.bestMs < Infinity && deployState.provider && deployState.gpuType) {
        try {
          const { updateHostLatency } = await import('./metrics');
          await updateHostLatency(deployState.provider, deployState.gpuType, ttsResult.bestMs, 'tts', deployState.providerMeta);
          log.log(`[readiness] Fed TTS benchmark into reputation: ${ttsResult.bestMs}ms`);
        } catch { /* best-effort: cleanup or optional side-effect */ }
      }
    })().catch(e => log.warn('[readiness:tts] Background benchmark failed:', e instanceof Error ? e.message : e));

    // Don't await ttsBenchmarkPromise — proceed to shadow mode immediately
    // STT + LLM passed — enter shadow mode. Restore persisted shadow progress (survives gateway restart).
    const restoredRuns = loadShadowRuns();
    const initialShadowRuns = restoredRuns > 0 ? restoredRuns : 0;
    if (restoredRuns > 0) {
      log.log(`[readiness] Restored ${restoredRuns}/${getShadowRuns()} shadow runs from disk`);
    }
    log.log(`[readiness] STT + LLM passed → entering shadow mode (${getShadowRuns()} rounds, starting at ${initialShadowRuns})`);
    setGpuShadowMode(true);
    setGpuReadinessState({ shadowPhase: true, shadowCompletedRuns: initialShadowRuns });
    broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'shadow', shadowRuns: getShadowRuns(), shadowCompletedRuns: initialShadowRuns });
    onPass(); // caller (providers.ts) calls markGpuShadowMode()

  } catch (err) {
    log.error('[readiness] Unexpected error:', err instanceof Error ? err.message : err);
    broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'failed', error: err instanceof Error ? err.message : String(err) });
  } finally {
    checkInProgress = false;
  }
}

// ── Repechage ─────────────────────────────────────────────────────────────────

function scheduleRepechage(
  endpoint: string,
  onPass: () => void,
  onFail: (stage: string, bestMs: number, targetMs: number) => void,
): void {
  const attempts = gpuReadinessState.repechageAttempts + 1;
  setGpuReadinessState({ repechageAttempts: attempts });
  repechageEndpoint = endpoint;

  // Check max repechage attempts — condemn GPU if exhausted
  const max = getRepechageMaxAttempts();
  if (attempts >= max) {
    log.warn(`[readiness] Repechage exhausted (${attempts}/${max}) — GPU condemned`);
    for (const stage of ['stt', 'llm', 'tts'] as const) {
      if (gpuReadinessState[stage].phase === 'failed' || gpuReadinessState[stage].phase === 'repechage' || gpuReadinessState[stage].phase === 'degraded') {
        setServiceReadiness(stage, { phase: 'condemned' });
      }
    }
    setGpuReadinessState({ condemned: true });
    broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'condemned', attempts });
    // Condemn GPU — route all traffic to cloud
    import('./providers').then(p => p.markGpuCondemned()).catch(e => log.warn('[readiness] markGpuCondemned failed:', e instanceof Error ? e.message : e));

    // Auto-recovery: deploy a replacement machine if enabled
    if (getAutoRecoveryEnabled()) {
      const recoveryAttempt = gpuReadinessState.autoRecoveryAttempt || 0;
      const maxRecovery = getAutoRecoveryMaxRetries();
      if (recoveryAttempt < maxRecovery) {
        const delaySec = getAutoRecoveryDelaySec();
        setGpuReadinessState({ autoRecoveryAttempt: recoveryAttempt + 1 });
        broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'auto-recovery', attempt: recoveryAttempt + 1, maxAttempts: maxRecovery, retryInMs: delaySec * 1000 });
        log.log(`[readiness] Auto-recovery: deploying replacement in ${delaySec}s (attempt ${recoveryAttempt + 1}/${maxRecovery})`);
        autoRecoveryTimer = setTimeout(async () => {
          autoRecoveryTimer = null;
          try {
            const { startAutoRecoveryDeploy } = await import('./gpu-deploy');
            await startAutoRecoveryDeploy();
          } catch (e) {
            log.error('[readiness] Auto-recovery deploy failed:', e instanceof Error ? e.message : e);
            broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'auto-recovery-failed', error: e instanceof Error ? e.message : 'unknown' });
          }
        }, delaySec * 1000);
      } else {
        log.warn(`[readiness] Auto-recovery exhausted (${recoveryAttempt}/${maxRecovery}) — staying on cloud`);
        broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'auto-recovery-exhausted', attempts: recoveryAttempt });
      }
    }

    return; // do NOT schedule retry timer
  }

  for (const stage of ['stt', 'llm', 'tts'] as const) {
    if (gpuReadinessState[stage].phase === 'failed' || gpuReadinessState[stage].phase === 'degraded') {
      setServiceReadiness(stage, { phase: 'repechage' });
    }
  }

  // Clear stale latency samples so P95 demotion doesn't use old data during repechage
  resetPerStageLatencyRings();

  const REPECHAGE_DELAY_MS = 120_000; // 2 minutes between retries
  broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'repechage', attempts, retryInMs: REPECHAGE_DELAY_MS });
  log.log(`[readiness] Entering repechage (attempt ${attempts}/${max}) — retry in ${REPECHAGE_DELAY_MS / 1000}s`);

  // Capture pod identity at scheduling time to detect pod replacement
  const podId = deployState.podId;

  repechageTimer = setTimeout(() => {
    repechageTimer = null;
    // Validate both endpoint AND podId to avoid retrying on a different pod
    if (deployState.endpoint !== endpoint || deployState.status !== 'ready' || deployState.podId !== podId) {
      log.log('[readiness] Repechage cancelled — pod changed');
      return;
    }
    log.log(`[readiness] Repechage retry ${attempts}`);
    runGpuReadinessCheck(endpoint, onPass, onFail).catch(e => log.warn('[readiness] repechage retry failed:', e instanceof Error ? e.message : e));
  }, REPECHAGE_DELAY_MS);
}

// ── Standby readiness check ───────────────────────────────────────────────────
// Separate from the primary readiness check — uses its own in-progress flag and
// does NOT validate deployState.endpoint (standby has a different endpoint).

let standbyCheckInProgress = false;

export function isStandbyReadinessCheckInProgress(): boolean { return standbyCheckInProgress; }

/**
 * Runs a simplified readiness benchmark on a standby GPU endpoint.
 * Unlike runGpuReadinessCheck, it:
 *   - Uses a separate in-progress flag (won't block primary checks)
 *   - Does NOT validate deployState.endpoint == endpoint
 *   - Only benchmarks LLM (the critical latency target) for speed
 *   - Calls onPass/onFail when done
 */
export async function runStandbyReadinessCheck(
  endpoint: string,
  onPass: () => void,
  onFail: (stage: string, bestMs: number, targetMs: number) => void,
): Promise<void> {
  if (standbyCheckInProgress) return;
  standbyCheckInProgress = true;

  const maxRuns = getBenchmarkMaxRuns();
  const marginPct = getBenchmarkMarginPct();
  const margin = 1 - marginPct / 100;

  const llmTarget = Math.round(getLlmTargetLatencyMs() * margin);
  const sttTarget = Math.round(getSttTargetLatencyMs() * margin);

  log.log(`[standby:readiness] Starting benchmark (max ${maxRuns} runs): LLM<${llmTarget}ms STT<${sttTarget}ms`);
  broadcastWs({ type: 'gpu:standby', status: 'benchmarking', llmTarget, sttTarget });

  try {
    // Benchmark STT and LLM in parallel (independent endpoints)
    const [sttPassed, llmPassed] = await Promise.all([
      benchmarkStandbyService('stt', endpoint, sttTarget, maxRuns),
      benchmarkStandbyService('llm', endpoint, llmTarget, maxRuns),
    ]);

    if (!sttPassed) {
      onFail('stt', sttTarget + 1, sttTarget);
      return;
    }

    if (!llmPassed) {
      onFail('llm', llmTarget + 1, llmTarget);
      return;
    }

    log.log('[standby:readiness] LLM + STT passed — standby ready');
    onPass();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('[standby:readiness] Error:', msg);
    onFail('internal', 0, 0);
  } finally {
    standbyCheckInProgress = false;
  }
}

async function benchmarkStandbyService(
  stage: 'stt' | 'llm' | 'tts',
  endpoint: string,
  targetMs: number,
  maxRuns: number,
): Promise<boolean> {
  let bestMs = Infinity;

  for (let i = 0; i < maxRuns; i++) {
    const t0 = Date.now();
    try {
      if (stage === 'llm') {
        const res = await fetch(`${endpoint}/v1/translate/text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'The quick brown fox jumps over the lazy dog.', source_lang: 'en', target_lang: 'fr' }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.json();
      } else if (stage === 'stt') {
        const headerSize = 44, dataSize = 32000;
        const wav = Buffer.alloc(headerSize + dataSize);
        wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataSize, 4);
        wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
        wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
        wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
        const form = new FormData();
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'bench.wav');
        const res = await fetch(`${endpoint}/v1/transcribe?language=en`, {
          method: 'POST', body: form, signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.json();
      }
    } catch (err) {
      log.warn(`[standby:readiness:${stage}] Run ${i + 1} failed: ${err instanceof Error ? err.message : err}`);
    }

    const ms = Date.now() - t0;
    if (ms < bestMs) bestMs = ms;
    log.log(`[standby:readiness:${stage}] Run ${i + 1}/${maxRuns}: ${ms}ms (best: ${bestMs}ms, target: ${targetMs}ms)`);

    if (bestMs <= targetMs) {
      log.log(`[standby:readiness:${stage}] Target hit on run ${i + 1} — PASS`);
      return true;
    }
  }

  log.warn(`[standby:readiness:${stage}] FAIL — best=${bestMs}ms target=${targetMs}ms`);
  return false;
}

// ── Shadow mode progress ──────────────────────────────────────────────────────

/** Called from ai-handlers when a background GPU request completes during shadow mode. */
const SHADOW_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour max in shadow mode
let shadowStartedAt = 0;

export function recordShadowRun(latencyMs: number, targetMs: number, onProductionReady: () => void): void {
  // Guard: don't mutate shadow state while a readiness check is re-running (race condition fix)
  if (checkInProgress) {
    log.warn('[readiness] Shadow run skipped: readiness check in progress');
    return;
  }

  // Track when shadow mode started
  if (shadowStartedAt === 0) shadowStartedAt = Date.now();

  // Timeout: if shadow mode has been running > 1 hour, reset and re-benchmark
  if (Date.now() - shadowStartedAt > SHADOW_TIMEOUT_MS) {
    log.warn('[readiness] Shadow mode timeout (>1h) — resetting, will re-benchmark');
    setGpuShadowMode(false);
    setGpuReadinessState({ shadowPhase: false, shadowCompletedRuns: 0 });
    clearShadowRuns();
    resetPerStageLatencyRings();
    shadowStartedAt = 0;
    import('./providers').then(p => p._startReadinessCheck(deployState.endpoint)).catch(e => log.error('[readiness] Shadow timeout re-benchmark failed:', e instanceof Error ? e.message : e));
    return;
  }

  const configuredRuns = getShadowRuns();
  // Early activation: if latency is significantly better than target (30%+ margin), trust it faster
  const earlyActivationThreshold = targetMs * 0.7;
  const targetRuns = (gpuReadinessState.shadowCompletedRuns >= 2 && latencyMs < earlyActivationThreshold)
    ? Math.min(configuredRuns, 2) // proven fast GPU → accept after 2 consecutive
    : configuredRuns;
  const passed = latencyMs <= targetMs;
  const next = passed ? gpuReadinessState.shadowCompletedRuns + 1 : 0; // reset on failure
  setGpuReadinessState({ shadowCompletedRuns: next });
  saveShadowRuns(next); // persist across gateway restarts

  broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'shadow', shadowCompletedRuns: next, shadowTotalRuns: targetRuns, latencyMs, passed });
  log.log(`[readiness] Shadow run ${next}/${targetRuns}: ${latencyMs}ms ${passed ? '✓' : '✗ (reset)'}`);

  if (next >= targetRuns) {
    log.log('[readiness] Shadow mode complete — GPU activated for production');
    setGpuShadowMode(false);
    setGpuReadinessState({ shadowPhase: false });
    clearShadowRuns(); // done — clear persisted state
    shadowStartedAt = 0;
    onProductionReady();
  }
}
