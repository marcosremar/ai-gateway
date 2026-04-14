// ── BabelCast Gateway — Shadow Mode Runner ───────────────────────────────────
// Fire-and-forget GPU shadow runs. The cloud path serves the real response
// while the GPU call executes in the background so we can collect latency data
// and potentially mark the GPU production-ready once its P95 beats the target.

import { createLogger } from '../../logger';

const log = createLogger('shadow-mode');

export interface ShadowRunDeps {
  /** Record latency into the GPU P95 ring buffer. */
  recordGpuLatency: (ms: number) => void;
  /** Record per-stage latency average. */
  recordPerStageLatency: (stage: 'stt' | 'llm' | 'tts', ms: number) => void;
  /** Track the shadow run against the ready-for-production benchmark. */
  recordShadowRun: (ms: number, targetMs: number, onPromote: () => void) => void;
  /** Marks the GPU endpoint as production-ready after enough good shadow runs. */
  markGpuProductionReady: (endpoint: string) => void;
}

/**
 * Execute a fire-and-forget shadow run. Used by STT/LLM handlers to sample
 * GPU performance while cloud serves the actual response. Errors are silently
 * logged so shadow failures never leak into the real response path.
 */
export function runShadowStage<T>(
  stage: 'stt' | 'llm' | 'tts',
  endpoint: string,
  targetMs: number,
  call: () => Promise<T>,
  deps: ShadowRunDeps,
): void {
  const t0 = Date.now();
  call()
    .then(() => {
      const ms = Date.now() - t0;
      deps.recordGpuLatency(ms);
      deps.recordPerStageLatency(stage, ms);
      deps.recordShadowRun(ms, targetMs, () => deps.markGpuProductionReady(endpoint));
    })
    .catch((e) => {
      log.warn(`shadow ${stage} run failed:`, e instanceof Error ? e.message : e);
    });
}
