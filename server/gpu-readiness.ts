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

import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  deployState,
  setServiceReadiness, setGpuReadinessState, gpuReadinessState,
  setGpuShadowMode, setGpuReadyForProduction,
  isStageWarm,
} from './state';
import { broadcastWs } from './ws-state';
import {
  getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs,
  getBenchmarkMaxRuns, getBenchmarkMarginPct, getShadowRuns,
  getRepechageMaxAttempts,
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

function saveRun(stage: 'stt' | 'llm' | 'tts', samples: number[], bestMs: number, targetMs: number, passed: boolean): void {
  try {
    const hist = loadHistory();
    const key = historyKey();
    const rec: ReadinessRecord = hist[key] ?? { runs: [], lastRunAt: 0, avgPassedMs: {} };
    rec.runs = [...rec.runs.slice(-29), { ts: Date.now(), stage, samples, bestLatencyMs: bestMs, targetMs, passed, runsUsed: samples.length }];
    // Update avg for this stage from passed runs
    const passedForStage = rec.runs.filter(r => r.stage === stage && r.passed);
    if (passedForStage.length > 0) {
      rec.avgPassedMs[stage] = Math.round(passedForStage.reduce((s, r) => s + r.bestLatencyMs, 0) / passedForStage.length);
    }
    rec.lastRunAt = Date.now();
    hist[key] = rec;
    const dir = path.dirname(HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(hist, null, 2));
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

function saveShadowRuns(completedRuns: number): void {
  try {
    const dir = path.dirname(SHADOW_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SHADOW_STATE_FILE, JSON.stringify({ completedRuns, endpoint: deployState.endpoint, savedAt: Date.now() }));
  } catch { /* ignore */ }
}

function clearShadowRuns(): void {
  try { if (fs.existsSync(SHADOW_STATE_FILE)) fs.unlinkSync(SHADOW_STATE_FILE); } catch { /* ignore */ }
}

// ── State ─────────────────────────────────────────────────────────────────────

let checkInProgress = false;
let repechageTimer: ReturnType<typeof setTimeout> | null = null;
let repechageEndpoint = '';

export function isReadinessCheckInProgress(): boolean { return checkInProgress; }

export function resetReadinessCheck(): void {
  checkInProgress = false;
  if (repechageTimer) { clearTimeout(repechageTimer); repechageTimer = null; }
  repechageEndpoint = '';
  clearShadowRuns();
}

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
        // 1s silence WAV for STT benchmark
        const headerSize = 44, dataSize = 32000; // 1s 16kHz 16-bit mono
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
      console.warn(`[readiness:${stage}] Run ${i + 1} failed: ${err instanceof Error ? err.message : err}`);
    }

    const ms = Date.now() - t0;
    // Only count successful requests for latency — errors don't prove the service is fast
    if (reqOk) {
      samples.push(ms);
      if (ms < bestMs) bestMs = ms;
    }

    setServiceReadiness(stage, { completedRuns: i + 1, latencySamples: [...samples], bestLatencyMs: bestMs === Infinity ? null : bestMs });
    broadcastWs({ type: 'gpu:readiness', stage, phase: 'benchmarking', run: i + 1, totalRuns: maxRuns, latencyMs: ms, bestLatencyMs: bestMs, targetMs });
    console.log(`[readiness:${stage}] Run ${i + 1}/${maxRuns}: ${ms}ms (best: ${bestMs}ms, target: ${targetMs}ms)`);

    if (bestMs <= targetMs) {
      console.log(`[readiness:${stage}] Target hit on run ${i + 1} — PASS ✓`);
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

  console.log(`[readiness] Starting per-service benchmark (max ${maxRuns} runs, ${marginPct}% margin):`,
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

    if (!sttResult.passed) {
      console.warn(`[readiness:stt] FAIL — best=${sttResult.bestMs}ms target=${targets.stt}ms`);
      if (deployState.endpoint === endpoint) {
        scheduleRepechage(endpoint, onPass, onFail);
        onFail('stt', sttResult.bestMs, targets.stt);
      }
      checkInProgress = false;
      return;
    }

    if (!llmResult.passed) {
      console.warn(`[readiness:llm] FAIL — best=${llmResult.bestMs}ms target=${targets.llm}ms`);
      if (deployState.endpoint === endpoint) {
        scheduleRepechage(endpoint, onPass, onFail);
        onFail('llm', llmResult.bestMs, targets.llm);
      }
      checkInProgress = false;
      return;
    }

    // Pre-warm TTS: absorb CUDA graph compilation (~11-30s) before the latency benchmark.
    // Without this, the first TTS inference always misses the target (300ms vs 11s cold start).
    if (!isStageWarm('tts')) {
      console.log('[readiness:tts] Pre-warming TTS (CUDA graph compilation)...');
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
          console.log(`[readiness:tts] TTS pre-warm done in ${Date.now() - warmStart}ms`);
        } else {
          console.warn(`[readiness:tts] TTS pre-warm HTTP ${res.status} — benchmark may fail`);
        }
      } catch (e) {
        console.warn(`[readiness:tts] TTS pre-warm failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Benchmark TTS after STT+LLM pass (non-blocking for production activation — TTS can warm separately)
    const ttsResult = await benchmarkService('tts', endpoint, targets.tts, maxRuns);
    setServiceReadiness('tts', { phase: ttsResult.passed ? 'ready' : 'failed', bestLatencyMs: ttsResult.bestMs });
    saveRun('tts', ttsResult.samples, ttsResult.bestMs, targets.tts, ttsResult.passed);
    broadcastWs({ type: 'gpu:readiness', stage: 'tts', phase: ttsResult.passed ? 'ready' : 'failed', bestLatencyMs: ttsResult.bestMs, targetMs: targets.tts, passed: ttsResult.passed, runsUsed: ttsResult.samples.length });
    // TTS failure doesn't block STT+LLM activation

    // STT + LLM passed — enter shadow mode. Restore persisted shadow progress (survives gateway restart).
    const restoredRuns = loadShadowRuns();
    const initialShadowRuns = restoredRuns > 0 ? restoredRuns : 0;
    if (restoredRuns > 0) {
      console.log(`[readiness] Restored ${restoredRuns}/${getShadowRuns()} shadow runs from disk`);
    }
    console.log(`[readiness] STT + LLM passed → entering shadow mode (${getShadowRuns()} rounds, starting at ${initialShadowRuns})`);
    setGpuShadowMode(true);
    setGpuReadinessState({ shadowPhase: true, shadowCompletedRuns: initialShadowRuns });
    broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'shadow', shadowRuns: getShadowRuns(), shadowCompletedRuns: initialShadowRuns });
    onPass(); // caller (providers.ts) calls markGpuShadowMode()

  } catch (err) {
    console.error('[readiness] Unexpected error:', err instanceof Error ? err.message : err);
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
    console.warn(`[readiness] Repechage exhausted (${attempts}/${max}) — GPU condemned`);
    for (const stage of ['stt', 'llm', 'tts'] as const) {
      if (gpuReadinessState[stage].phase === 'failed' || gpuReadinessState[stage].phase === 'repechage' || gpuReadinessState[stage].phase === 'degraded') {
        setServiceReadiness(stage, { phase: 'condemned' });
      }
    }
    setGpuReadinessState({ condemned: true });
    broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'condemned', attempts });
    // Condemn GPU — route all traffic to cloud
    import('./providers').then(p => p.markGpuCondemned()).catch(e => console.warn('[readiness] markGpuCondemned failed:', e instanceof Error ? e.message : e));
    return; // do NOT schedule retry timer
  }

  for (const stage of ['stt', 'llm', 'tts'] as const) {
    if (gpuReadinessState[stage].phase === 'failed' || gpuReadinessState[stage].phase === 'degraded') {
      setServiceReadiness(stage, { phase: 'repechage' });
    }
  }

  broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'repechage', attempts, retryInMs: 120_000 });
  console.log(`[readiness] Entering repechage (attempt ${attempts}/${max}) — retry in 2min`);

  repechageTimer = setTimeout(() => {
    repechageTimer = null;
    if (deployState.endpoint !== endpoint || deployState.status !== 'ready') return;
    console.log(`[readiness] Repechage retry ${attempts}`);
    runGpuReadinessCheck(endpoint, onPass, onFail).catch(e => console.warn('[readiness] repechage retry failed:', e instanceof Error ? e.message : e));
  }, 120_000);
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

  console.log(`[standby:readiness] Starting benchmark (max ${maxRuns} runs): LLM<${llmTarget}ms STT<${sttTarget}ms`);
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

    console.log('[standby:readiness] LLM + STT passed — standby ready');
    onPass();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[standby:readiness] Error:', msg);
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
      console.warn(`[standby:readiness:${stage}] Run ${i + 1} failed: ${err instanceof Error ? err.message : err}`);
    }

    const ms = Date.now() - t0;
    if (ms < bestMs) bestMs = ms;
    console.log(`[standby:readiness:${stage}] Run ${i + 1}/${maxRuns}: ${ms}ms (best: ${bestMs}ms, target: ${targetMs}ms)`);

    if (bestMs <= targetMs) {
      console.log(`[standby:readiness:${stage}] Target hit on run ${i + 1} — PASS`);
      return true;
    }
  }

  console.warn(`[standby:readiness:${stage}] FAIL — best=${bestMs}ms target=${targetMs}ms`);
  return false;
}

// ── Shadow mode progress ──────────────────────────────────────────────────────

/** Called from ai-handlers when a background GPU request completes during shadow mode. */
export function recordShadowRun(latencyMs: number, targetMs: number, onProductionReady: () => void): void {
  const targetRuns = getShadowRuns();
  const passed = latencyMs <= targetMs;
  const next = passed ? gpuReadinessState.shadowCompletedRuns + 1 : 0; // reset on failure
  setGpuReadinessState({ shadowCompletedRuns: next });
  saveShadowRuns(next); // persist across gateway restarts

  broadcastWs({ type: 'gpu:readiness', stage: 'all', phase: 'shadow', shadowCompletedRuns: next, shadowTotalRuns: targetRuns, latencyMs, passed });
  console.log(`[readiness] Shadow run ${next}/${targetRuns}: ${latencyMs}ms ${passed ? '✓' : '✗ (reset)'}`);

  if (next >= targetRuns) {
    console.log('[readiness] Shadow mode complete — GPU activated for production');
    setGpuShadowMode(false);
    setGpuReadinessState({ shadowPhase: false });
    clearShadowRuns(); // done — clear persisted state
    onProductionReady();
  }
}
