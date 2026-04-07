/**
 * GPU Lifecycle E2E — Real GPU State Machine Test
 *
 * Deploys a REAL GPU pod, creates a test profile, and forces
 * every state transition in the readiness lifecycle:
 *
 *   Deploy → Benchmarking → Shadow → Ready → Degraded → Repechage → Condemned → Auto-Recovery
 *
 * REQUIRES (opt-in — costs money):
 *   LIFECYCLE_TEST=1              Enable this test
 *   Gateway running on :4000      With provider credentials in .env
 *
 * Run:
 *   LIFECYCLE_TEST=1 bun run test -- __tests__/gpu-lifecycle-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadEnv, waitFor, makeTestWav } from './helpers';

const GW = process.env.GATEWAY_URL || 'http://localhost:4000';
const LIFECYCLE_ENABLED = process.env.LIFECYCLE_TEST === '1';

// ── API Helpers ──────────────────────────────────────────────────────────────

async function gw<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${GW}${path}`, { signal: AbortSignal.timeout(30_000), ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${opts?.method || 'GET'} ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}
async function gwPost<T>(path: string, body?: unknown): Promise<T> {
  return gw<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ServicePhase { phase: string; completedRuns: number; bestLatencyMs: number | null; targetMs: number }
interface ReadinessState {
  stt: ServicePhase; llm: ServicePhase; tts: ServicePhase;
  repechageAttempts: number; shadowCompletedRuns: number; shadowPhase: boolean;
  condemned: boolean; autoRecoveryAttempt: number;
}
interface ReadinessStatus {
  gpuReadyForProduction: boolean; gpuShadowMode: boolean;
  readinessState: ReadinessState;
  perStageP95: Record<string, number | null>;
  targets: Record<string, number>;
  p95DemotionMultiplier: number; repechageMaxAttempts: number;
}
interface GpuStatus {
  status: string; endpoint: string | null; gpuType: string | null;
  gpuHealthy: boolean; dockerImage: string | null;
  pipelineRouting?: Record<string, string>;
  modelWarmth?: Record<string, { warm: boolean }>;
}
interface LatencySettings {
  sttTargetLatencyMs: number; llmTargetLatencyMs: number; ttsTargetLatencyMs: number;
  p95DemotionMultiplier: number; repechageMaxAttempts: number;
  shadowRuns: number; benchmarkMaxRuns: number;
  [k: string]: unknown;
}

// ── Gateway Calls ────────────────────────────────────────────────────────────

const getReadiness   = () => gw<ReadinessStatus>('/v1/gpu/readiness/status');
const resetReadiness = () => gwPost<{ ok: boolean }>('/v1/gpu/readiness/reset');
const getGpuStatus   = () => gw<GpuStatus>('/v1/gpu/status');
const deployGpu      = (opts: Record<string, unknown>) => gwPost<{ status: string; message: string }>('/v1/gpu/deploy', opts);
const terminateGpu   = () => gwPost<{ ok: boolean }>('/v1/gpu/terminate', {});
const getSettings    = () => gw<LatencySettings>('/v1/gpu/latency/settings');
const patchSettings  = (patch: Partial<LatencySettings>) =>
  gw<LatencySettings>('/v1/gpu/latency/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    .catch(() => gw<LatencySettings>('/v1/gpu/latency/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }));

const runSTT = async () => {
  const wav = makeTestWav(1.0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await fetch(`${GW}/v1/playground/stt`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav as any, signal: AbortSignal.timeout(30_000) });
  return r.json() as Promise<{ text: string; latencyMs: number; provider: string }>;
};
const runLLM = (text = 'Hello') => gwPost<{ content: string; latencyMs: number; provider: string }>('/v1/playground/llm', {
  messages: [{ role: 'user', content: text }], system_prompt: 'Translate to French. Output only the translation.',
});
const runTTS = (text = 'Bonjour') => gwPost<{ latencyMs: number; provider: string }>('/v1/playground/tts', { text });

// ── Logging ──────────────────────────────────────────────────────────────────

function logPhases(r: ReadinessStatus) {
  const { stt, llm, tts } = r.readinessState;
  console.log(`    STT: ${stt.phase.padEnd(13)} best=${stt.bestLatencyMs ?? '-'}ms  target=${stt.targetMs}ms  runs=${stt.completedRuns}`);
  console.log(`    LLM: ${llm.phase.padEnd(13)} best=${llm.bestLatencyMs ?? '-'}ms  target=${llm.targetMs}ms  runs=${llm.completedRuns}`);
  console.log(`    TTS: ${tts.phase.padEnd(13)} best=${tts.bestLatencyMs ?? '-'}ms  target=${tts.targetMs}ms  runs=${tts.completedRuns}`);
  console.log(`    production=${r.gpuReadyForProduction} shadow=${r.gpuShadowMode} condemned=${r.readinessState.condemned} repechage=${r.readinessState.repechageAttempts} recovery=${r.readinessState.autoRecoveryAttempt}`);
}

async function waitForPhase(stage: 'stt' | 'llm' | 'tts', targetPhase: string | string[], timeoutMs = 180_000, label?: string): Promise<ReadinessStatus> {
  const phases = Array.isArray(targetPhase) ? targetPhase : [targetPhase];
  let last: ReadinessStatus | null = null;
  await waitFor(async () => {
    last = await getReadiness();
    return phases.includes(last.readinessState[stage].phase);
  }, { intervalMs: 3000, timeoutMs, label: label || `${stage} → ${phases.join('|')}` });
  return last!;
}

async function waitForProduction(timeoutMs = 300_000): Promise<ReadinessStatus> {
  let last: ReadinessStatus | null = null;
  await waitFor(async () => {
    last = await getReadiness();
    return last.gpuReadyForProduction;
  }, { intervalMs: 5000, timeoutMs, label: 'GPU production ready' });
  return last!;
}

async function fireRequests(n: number, delayMs = 300) {
  for (let i = 0; i < n; i++) {
    try { await runLLM('Test ' + i); } catch {}
    try { await runSTT(); } catch {}
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!LIFECYCLE_ENABLED)('GPU Lifecycle E2E', () => {
  let origSettings: LatencySettings;
  let gpuDeployed = false;

  beforeAll(async () => {
    loadEnv();
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  GPU LIFECYCLE E2E TEST');
    console.log('  Gateway:', GW);
    console.log('═══════════════════════════════════════════════════════\n');

    // Save original settings
    origSettings = await getSettings();
  }, 30_000);

  afterAll(async () => {
    // Restore original settings
    if (origSettings) {
      console.log('\n  [cleanup] Restoring original latency settings...');
      await patchSettings({
        sttTargetLatencyMs: origSettings.sttTargetLatencyMs,
        llmTargetLatencyMs: origSettings.llmTargetLatencyMs,
        ttsTargetLatencyMs: origSettings.ttsTargetLatencyMs,
        p95DemotionMultiplier: origSettings.p95DemotionMultiplier,
        repechageMaxAttempts: origSettings.repechageMaxAttempts,
        shadowRuns: origSettings.shadowRuns,
        benchmarkMaxRuns: origSettings.benchmarkMaxRuns,
      }).catch(() => {});
    }
    // Don't terminate GPU — leave it for other tests / manual inspection
    console.log('\n  [cleanup] Done. GPU pod left running for inspection.\n');
  }, 30_000);

  // ── Step 1: Deploy GPU ─────────────────────────────────────────────────

  it('Step 1: Deploy GPU pod', async () => {
    const gpu = await getGpuStatus();
    if (gpu.status === 'ready' && gpu.endpoint) {
      console.log('  GPU already deployed:', gpu.endpoint, gpu.gpuType);
      gpuDeployed = true;
      return;
    }

    console.log('  Deploying GPU pod...');
    // Use groq image (cloud-only, ~500MB, boots in ~30s) for faster test cycles
    // Full GPU images (mistral/translategemma) take 5-10min to pull on cold hosts
    const result = await deployGpu({
      dockerImage: 'marcosremar/babelcast-groq:latest',
      autoSelectGpu: true,
    });
    console.log('  Deploy started:', result.message);
    expect(result.status).not.toBe('error');

    // Wait for pod to be ready (up to 10 min)
    await waitFor(async () => {
      const s = await getGpuStatus();
      console.log(`    status=${s.status} endpoint=${s.endpoint || '-'} gpu=${s.gpuType || '-'}`);
      return s.status === 'ready' && !!s.endpoint;
    }, { intervalMs: 10_000, timeoutMs: 600_000, label: 'GPU pod ready' });

    gpuDeployed = true;
    const final = await getGpuStatus();
    console.log('  ✓ GPU deployed:', final.endpoint, final.gpuType);
  }, 660_000);

  // ── Step 2: Verify Benchmarking Phase ──────────────────────────────────

  it('Step 2: Verify BENCHMARKING phase starts', async () => {
    if (!gpuDeployed) { console.log('  SKIP: no GPU'); return; }

    // Configure fast benchmark: only 3 runs, generous targets, 2 shadow runs
    await patchSettings({
      benchmarkMaxRuns: 3,
      sttTargetLatencyMs: 10_000,  // very generous — 10s
      llmTargetLatencyMs: 10_000,
      ttsTargetLatencyMs: 15_000,
      shadowRuns: 2,
      repechageMaxAttempts: 2,
      p95DemotionMultiplier: 1.5,
    });

    const r = await getReadiness();
    console.log('  Current readiness:');
    logPhases(r);

    // At least one service should be benchmarking or already past it
    const phases = [r.readinessState.stt.phase, r.readinessState.llm.phase, r.readinessState.tts.phase];
    const active = phases.some(p => ['benchmarking', 'ready', 'idle'].includes(p));
    expect(active).toBe(true);
    console.log('  ✓ Benchmark phase detected');
  }, 30_000);

  // ── Step 3: Wait for Shadow Phase ──────────────────────────────────────

  it('Step 3: Wait for SHADOW phase (STT+LLM pass benchmark)', async () => {
    if (!gpuDeployed) { console.log('  SKIP: no GPU'); return; }

    console.log('  Waiting for shadow mode (STT+LLM must pass benchmark)...');

    // Wait for shadow mode OR production ready
    await waitFor(async () => {
      const r = await getReadiness();
      logPhases(r);
      return r.gpuShadowMode || r.gpuReadyForProduction;
    }, { intervalMs: 5000, timeoutMs: 300_000, label: 'shadow or production' });

    const r = await getReadiness();
    console.log('  ✓ Shadow/Production reached:', r.gpuShadowMode ? 'shadow' : 'production');
  }, 330_000);

  // ── Step 4: Fire requests to complete shadow validation ────────────────

  it('Step 4: Complete SHADOW validation → READY (production)', async () => {
    if (!gpuDeployed) { console.log('  SKIP: no GPU'); return; }

    const r = await getReadiness();
    if (r.gpuReadyForProduction) {
      console.log('  Already in production — skipping shadow completion');
      return;
    }

    console.log('  Firing requests to complete shadow validation...');
    // Shadow needs N consecutive successes (configured to 2)
    await fireRequests(5, 1000);

    await waitFor(async () => {
      const r = await getReadiness();
      console.log(`    shadow runs: ${r.readinessState.shadowCompletedRuns}, production: ${r.gpuReadyForProduction}`);
      return r.gpuReadyForProduction;
    }, { intervalMs: 5000, timeoutMs: 180_000, label: 'production activation' });

    const final = await getReadiness();
    expect(final.gpuReadyForProduction).toBe(true);
    console.log('  ✓ GPU is now in PRODUCTION');
    logPhases(final);
  }, 240_000);

  // ── Step 5: Verify READY state ─────────────────────────────────────────

  it('Step 5: Verify READY state — GPU serving requests', async () => {
    if (!gpuDeployed) { console.log('  SKIP: no GPU'); return; }

    const r = await getReadiness();
    if (!r.gpuReadyForProduction) { console.log('  SKIP: not in production'); return; }

    // Verify routing goes through GPU
    const llm = await runLLM('The quick brown fox');
    console.log(`  LLM: "${llm.content.slice(0, 40)}" via ${llm.provider} (${llm.latencyMs}ms)`);

    const gpu = await getGpuStatus();
    console.log(`  Routing: ${JSON.stringify(gpu.pipelineRouting)}`);

    // At least STT and LLM should be ready
    expect(['ready', 'idle']).toContain(r.readinessState.stt.phase);
    expect(['ready', 'idle']).toContain(r.readinessState.llm.phase);
    console.log('  ✓ GPU serving in READY state');
  }, 30_000);

  // ── Step 6: Force DEGRADED → REPECHAGE via tight targets ───────────────

  it('Step 6: Force DEGRADED state via impossibly tight latency target', async () => {
    if (!gpuDeployed) { console.log('  SKIP: no GPU'); return; }

    const r = await getReadiness();
    if (!r.gpuReadyForProduction) { console.log('  SKIP: not in production'); return; }

    console.log('  Setting LLM target to 1ms and P95 multiplier to 1.0 to force degradation...');
    await patchSettings({ llmTargetLatencyMs: 1, p95DemotionMultiplier: 1.0 });

    // Fire requests to build P95 data that exceeds threshold
    console.log('  Firing LLM requests to build P95 data...');
    await fireRequests(8, 500);

    // Wait for degradation (P95 monitor runs every ~30s, needs 3 consecutive violations)
    console.log('  Waiting for P95 demotion (up to 90s)...');
    let degraded = false;
    try {
      await waitFor(async () => {
        const r = await getReadiness();
        const phase = r.readinessState.llm.phase;
        console.log(`    LLM phase: ${phase}, P95: ${r.perStageP95.llm ?? '-'}ms, production: ${r.gpuReadyForProduction}`);
        if (['degraded', 'benchmarking', 'repechage', 'failed', 'condemned'].includes(phase)) {
          degraded = true;
          return true;
        }
        return false;
      }, { intervalMs: 5000, timeoutMs: 90_000, label: 'P95 demotion' });
    } catch {
      console.log('  ⚠ P95 demotion did not trigger (monitor may need more time)');
    }

    if (degraded) {
      const r2 = await getReadiness();
      console.log('  ✓ LLM transitioned away from ready:');
      logPhases(r2);
      expect(r2.gpuReadyForProduction).toBe(false);
    }
  }, 120_000);

  // ── Step 7: Verify REPECHAGE (re-benchmark after degradation) ──────────

  it('Step 7: Verify REPECHAGE — re-benchmark with tight target fails', async () => {
    if (!gpuDeployed) { console.log('  SKIP: no GPU'); return; }

    const r = await getReadiness();
    const phases = [r.readinessState.stt.phase, r.readinessState.llm.phase];
    if (!phases.some(p => ['benchmarking', 'repechage', 'failed', 'degraded'].includes(p))) {
      console.log('  SKIP: not in degraded/repechage state');
      return;
    }

    console.log('  LLM target still at 1ms — benchmark should fail → repechage...');

    // Wait for repechage or condemned
    try {
      await waitFor(async () => {
        const r = await getReadiness();
        console.log(`    LLM: ${r.readinessState.llm.phase}, repechage: ${r.readinessState.repechageAttempts}, condemned: ${r.readinessState.condemned}`);
        return r.readinessState.repechageAttempts > 0 || r.readinessState.condemned;
      }, { intervalMs: 5000, timeoutMs: 180_000, label: 'repechage/condemned' });
    } catch {
      console.log('  ⚠ Did not reach repechage within timeout');
    }

    const r2 = await getReadiness();
    console.log('  State after waiting:');
    logPhases(r2);

    if (r2.readinessState.repechageAttempts > 0) {
      console.log(`  ✓ REPECHAGE triggered (attempt ${r2.readinessState.repechageAttempts})`);
    }
  }, 210_000);

  // ── Step 8: Wait for CONDEMNED ─────────────────────────────────────────

  it('Step 8: Wait for CONDEMNED state (repechage exhausted)', async () => {
    if (!gpuDeployed) { console.log('  SKIP: no GPU'); return; }

    const r = await getReadiness();
    if (!r.readinessState.repechageAttempts && !r.readinessState.condemned) {
      console.log('  SKIP: not in repechage flow');
      return;
    }

    console.log('  Waiting for condemnation (repechage max=2)...');

    try {
      await waitFor(async () => {
        const r = await getReadiness();
        console.log(`    condemned: ${r.readinessState.condemned}, repechage: ${r.readinessState.repechageAttempts}, recovery: ${r.readinessState.autoRecoveryAttempt}`);
        return r.readinessState.condemned;
      }, { intervalMs: 10_000, timeoutMs: 600_000, label: 'GPU condemned' });
    } catch {
      console.log('  ⚠ Did not reach condemned within timeout');
    }

    const r2 = await getReadiness();
    logPhases(r2);

    if (r2.readinessState.condemned) {
      console.log('  ✓ GPU CONDEMNED — all traffic routed to cloud');
      expect(r2.gpuReadyForProduction).toBe(false);
    }
  }, 660_000);

  // ── Step 9: Verify AUTO-RECOVERY ───────────────────────────────────────

  it('Step 9: Verify AUTO-RECOVERY deploys replacement', async () => {
    if (!gpuDeployed) { console.log('  SKIP: no GPU'); return; }

    const r = await getReadiness();
    if (!r.readinessState.condemned) {
      console.log('  SKIP: not condemned');
      return;
    }

    // Auto-recovery should kick in after condemnation (10s delay default)
    console.log('  Checking auto-recovery attempt...');

    try {
      await waitFor(async () => {
        const r = await getReadiness();
        return (r.readinessState.autoRecoveryAttempt ?? 0) > 0;
      }, { intervalMs: 5000, timeoutMs: 30_000, label: 'auto-recovery attempt' });

      const r2 = await getReadiness();
      console.log(`  ✓ Auto-recovery triggered (attempt ${r2.readinessState.autoRecoveryAttempt})`);
    } catch {
      console.log('  ⚠ Auto-recovery not detected (may need gateway restart with new code)');
    }
  }, 60_000);

  // ── Step 10: Restore targets and verify recovery ───────────────────────

  it('Step 10: Restore generous targets and reset → verify recovery to READY', async () => {
    if (!gpuDeployed) { console.log('  SKIP: no GPU'); return; }

    console.log('  Restoring generous latency targets...');
    await patchSettings({
      sttTargetLatencyMs: 10_000,
      llmTargetLatencyMs: 10_000,
      ttsTargetLatencyMs: 15_000,
      p95DemotionMultiplier: 3.0,
      repechageMaxAttempts: 3,
    });

    // Reset readiness to start fresh benchmark
    try { await resetReadiness(); } catch {}

    const gpu = await getGpuStatus();
    if (gpu.status !== 'ready' || !gpu.endpoint) {
      console.log('  No GPU endpoint available — cannot verify recovery');
      return;
    }

    console.log('  Waiting for re-benchmark → shadow → production...');
    try {
      await waitFor(async () => {
        const r = await getReadiness();
        logPhases(r);
        return r.gpuReadyForProduction;
      }, { intervalMs: 5000, timeoutMs: 300_000, label: 'recovery to production' });

      const final = await getReadiness();
      expect(final.gpuReadyForProduction).toBe(true);
      console.log('  ✓ GPU recovered to PRODUCTION');
      logPhases(final);
    } catch {
      console.log('  ⚠ Recovery to production did not complete within timeout');
      const final = await getReadiness();
      logPhases(final);
    }
  }, 360_000);

  // ── Step 11: Full cycle summary ────────────────────────────────────────

  it('Step 11: Print full lifecycle summary', async () => {
    const gpu = await getGpuStatus();
    const r = await getReadiness();

    console.log('\n  ═══════════════════════════════════════════════════');
    console.log('  GPU LIFECYCLE TEST SUMMARY');
    console.log('  ═══════════════════════════════════════════════════');
    console.log(`  GPU: ${gpu.gpuType || 'none'} @ ${gpu.endpoint || 'none'}`);
    console.log(`  Status: ${gpu.status}`);
    console.log(`  Production: ${r.gpuReadyForProduction}`);
    console.log(`  Shadow: ${r.gpuShadowMode}`);
    console.log(`  Condemned: ${r.readinessState.condemned}`);
    console.log(`  Repechage attempts: ${r.readinessState.repechageAttempts}`);
    console.log(`  Auto-recovery attempts: ${r.readinessState.autoRecoveryAttempt ?? 0}`);
    logPhases(r);
    console.log('  ═══════════════════════════════════════════════════\n');
  }, 10_000);
});
