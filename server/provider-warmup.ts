// ── BabelCast Gateway — Provider Warmup (Periodic Health Checks) ─────────────
// Pings cloud AI providers every 60s with lightweight requests to:
//   1. Keep HTTP connections warm (avoids cold-start TCP/TLS handshake overhead)
//   2. Detect provider issues proactively (before real user requests fail)
//   3. Pre-warm model caches on provider side
//
// Also probes GPU endpoint health when a pod is deployed.

import {
  isGpuAvailable, deployState,
  isTtsWarm, markTtsWarm, recordTtsTtfb, saveColdStartProfile,
  updateGpuModelWarmth, isStageWarm,
  activeRequests, lastRequestTime,
} from './state';
import { groqAvailable, openaiAvailable, markGpuHealthy, markGpuUnhealthy } from './providers';
import { probeAllCloudProviders, probeGpuHealth } from '../src';
import type { CloudProbeResult } from '../src';
import { createLogger } from '../src/logger';
import { safeCatch } from '../src/safe-catch';

const log = createLogger('provider-warmup');

const WARMUP_INTERVAL_MS = 60_000; // 60s between probes
let warmupTimer: ReturnType<typeof setInterval> | null = null;

// ── Cached cloud probe results (used by /health endpoint) ─────────────────────
let lastCloudProbeResults: CloudProbeResult[] = [];
let lastCloudProbeAt = 0;

export function getCloudProbeResults(): CloudProbeResult[] { return lastCloudProbeResults; }
export function getCloudProbeAt(): number { return lastCloudProbeAt; }

// Idle threshold: only run GPU monitoring probes when no active requests and idle for > 15s
const IDLE_THRESHOLD_MS = 15_000;

function isIdleEnoughForProbe(): boolean {
  if (activeRequests > 0) return false;
  const idleMs = Date.now() - lastRequestTime;
  return idleMs > IDLE_THRESHOLD_MS;
}

async function runWarmupCycle(): Promise<void> {
  // Build keys map for configured cloud providers
  const keys: Record<string, string> = {};
  if (groqAvailable && process.env.GROQ_API_KEY) keys.groq = process.env.GROQ_API_KEY;
  if (openaiAvailable && process.env.OPENAI_API_KEY) keys.openai = process.env.OPENAI_API_KEY;

  // Probe cloud providers via ai-gateway (encapsulates URLs + auth)
  const cloudProbe = Object.keys(keys).length > 0
    ? probeAllCloudProviders(keys)
    : Promise.resolve([] as CloudProbeResult[]);

  // GPU pod: health check via ai-gateway + parse model warmth
  // Only probe GPU during idle periods to avoid interfering with active transcription
  const gpuProbe = (deployState.status === 'ready' && deployState.endpoint && isIdleEnoughForProbe())
    ? probeGpuHealth(deployState.endpoint, true)
    : null;

  const [cloudResults, gpuResult] = await Promise.all([
    cloudProbe,
    gpuProbe,
  ]);

  // Store cloud probe results for /health endpoint
  if (cloudResults.length > 0) {
    lastCloudProbeResults = cloudResults;
    lastCloudProbeAt = Date.now();
  }

  const failures: string[] = [];

  // Process cloud results — skip 401/403 (API reachable, key lacks list-models scope)
  for (const { provider, ok, error } of cloudResults) {
    if (!ok && !error?.includes('401') && !error?.includes('403')) {
      failures.push(`${provider}(${error || 'not ok'})`);
    }
  }

  // Process GPU result
  if (gpuResult) {
    const gpuOk = typeof gpuResult === 'boolean' ? gpuResult : gpuResult.ok;
    if (!gpuOk) {
      failures.push('gpu(probe failed)');
      if (isGpuAvailable()) markGpuUnhealthy('warmup probe failed');
    } else {
      // Parse model warmth from health data
      if (typeof gpuResult !== 'boolean' && gpuResult.data) {
        updateGpuModelWarmth(gpuResult.data);
      }
      // GPU recovery: if probe succeeds and GPU was unhealthy, recover
      if (!isGpuAvailable() && deployState.status === 'ready' && deployState.endpoint) {
        markGpuHealthy();
      }
    }
  }

  if (failures.length > 0) {
    log.warn(`Provider issues: ${failures.join(', ')}`);
  }

  // Auto-warmup GPU TTS if pod is ready but TTS is cold
  if (deployState.status === 'ready' && deployState.endpoint && isGpuAvailable() && !isTtsWarm()) {
    warmupGpuTts(deployState.endpoint, deployState.gpuType, deployState.dockerImage, deployState.provider).catch(e => log.warn('GPU TTS warmup failed:', e instanceof Error ? e.message : e));
  }
}

/**
 * Fire a warmup TTS request to the GPU pod to trigger CUDA graph compilation.
 * This runs in the background so the first real user request gets warm TTFB (~230ms)
 * instead of cold TTFB (~11s).
 */
let ttsWarmupInProgress = false;

async function warmupGpuTts(endpoint: string, gpuType: string, dockerImage: string, provider: string): Promise<void> {
  if (ttsWarmupInProgress || isTtsWarm()) return;
  ttsWarmupInProgress = true;

  log.log('Starting GPU TTS warmup (CUDA graph compilation)...');
  const t0 = Date.now();

  try {
    // Send a short TTS request to trigger model load + CUDA graph compilation
    const warmupText = 'Hello, this is a warmup request.';
    const res = await fetch(`${endpoint}/v1/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: warmupText,
        language: 'English',
        speaker: 'Ryan',
      }),
      signal: AbortSignal.timeout(60_000), // CUDA graph compilation can take ~15-30s
    });

    const coldMs = Date.now() - t0;

    if (res.ok) {
      markTtsWarm(coldMs);
      log.log(`GPU TTS warm in ${coldMs}ms (CUDA graphs compiled)`);

      // Save cold start profile for this config (gpu + image + provider)
      saveColdStartProfile({
        gpuType,
        dockerImage,
        provider,
        coldTtfbMs: coldMs,
        warmTtfbAvgMs: 240, // estimated, will be updated with real data
        modelLoadMs: 0,     // not measurable from gateway
        measuredAt: Date.now(),
        sampleCount: 0,
      });
    } else {
      log.warn(`GPU TTS warmup failed: HTTP ${res.status}`);
    }
  } catch (err) {
    log.warn(`GPU TTS warmup failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    ttsWarmupInProgress = false;
  }
}

/**
 * Warmup all GPU models (STT, LLM, TTS) in parallel.
 * Called on meeting start to eliminate cold-start latency on first real request.
 * STT: sends 1s silence WAV. LLM: sends short translation request. TTS: reuses warmupGpuTts.
 */
export async function warmupAllGpuModels(endpoint: string): Promise<void> {
  if (!endpoint) return;
  log.log('Predictive warmup — warming all GPU models...');

  const results = await Promise.allSettled([
    // STT warmup: 1-second silence WAV (16kHz, 16-bit mono)
    (async () => {
      if (isStageWarm('stt')) return 'already-warm';
      const headerSize = 44;
      const dataSize = 16000 * 2 * 1; // 1 second of 16kHz 16-bit mono
      const wav = Buffer.alloc(headerSize + dataSize);
      // WAV header
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataSize, 4);
      wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); // PCM, mono
      wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); // sample rate, byte rate
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); // block align, bits
      wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
      // data is all zeros (silence)
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'warmup.wav');
      const t0 = Date.now();
      const res = await fetch(`${endpoint}/v1/transcribe?language=en`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`STT warmup HTTP ${res.status}`);
      log.log(`STT warm in ${Date.now() - t0}ms`);
      return 'warmed';
    })(),

    // LLM warmup: short translation request
    (async () => {
      if (isStageWarm('llm')) return 'already-warm';
      const t0 = Date.now();
      const res = await fetch(`${endpoint}/v1/translate/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Hello', source_lang: 'en', target_lang: 'fr',
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`LLM warmup HTTP ${res.status}`);
      log.log(`LLM warm in ${Date.now() - t0}ms`);
      return 'warmed';
    })(),

    // TTS warmup: reuse existing function
    (async () => {
      if (isTtsWarm()) return 'already-warm';
      await warmupGpuTts(deployState.endpoint, deployState.gpuType, deployState.dockerImage, deployState.provider);
      return 'warmed';
    })(),
  ]);

  const labels = ['STT', 'LLM', 'TTS'];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      log.warn(`${labels[i]} warmup failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  }
}

// ─── Predictive Stage Warmup ─────────────────────────────────────────────────
// After one pipeline stage completes, pre-warm the NEXT stage's provider.
// Pipeline always goes STT -> LLM -> TTS, so:
//   STT done -> warm LLM provider
//   LLM done -> warm TTS provider
//   TTS done -> no-op (pipeline complete)

const NEXT_STAGE: Record<string, 'llm' | 'tts' | null> = {
  stt: 'llm',
  llm: 'tts',
  tts: null,
};

/**
 * Trigger predictive warmup for the next pipeline stage.
 * Call this after a stage completes to reduce cold-start latency on the next stage.
 * This is a no-op if the GPU endpoint is not available or the next stage is already warm.
 */
export function triggerPredictiveWarmup(completedStage: 'stt' | 'llm' | 'tts'): void {
  const nextStage = NEXT_STAGE[completedStage];
  if (!nextStage) return; // pipeline complete, nothing to warm

  // Only relevant when GPU pod is deployed
  if (deployState.status !== 'ready' || !deployState.endpoint) return;

  // Skip if already warm
  if (isStageWarm(nextStage)) return;

  const endpoint = deployState.endpoint;
  log.log(`Predictive: ${completedStage} done, pre-warming ${nextStage}...`);

  // Fire-and-forget: don't block the pipeline
  if (nextStage === 'llm') {
    // Warm LLM with a short translation request
    fetch(`${endpoint}/v1/translate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'warmup', source_lang: 'en', target_lang: 'fr' }),
      signal: AbortSignal.timeout(15_000),
    }).catch(safeCatch('warmup-gpu-llm'));
  } else if (nextStage === 'tts') {
    warmupGpuTts(endpoint, deployState.gpuType, deployState.dockerImage, deployState.provider)
      .catch(safeCatch('warmup-gpu-tts'));
  }
}

/**
 * Start periodic cloud provider health checks.
 * Call at gateway startup.
 */
export function startProviderWarmup(): void {
  if (warmupTimer) return; // already running

  // Run first cycle immediately (non-blocking)
  runWarmupCycle().catch(err =>
    log.warn('Initial cycle failed:', err instanceof Error ? err.message : err),
  );

  warmupTimer = setInterval(() => {
    runWarmupCycle().catch(err =>
      log.warn('Cycle failed:', err instanceof Error ? err.message : err),
    );
  }, WARMUP_INTERVAL_MS);

  log.log(`Provider health checks started (every ${WARMUP_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop periodic health checks.
 * Call on gateway shutdown.
 */
export function stopProviderWarmup(): void {
  if (warmupTimer) {
    clearInterval(warmupTimer);
    warmupTimer = null;
  }
}
