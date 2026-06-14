/**
 * Degradation Manager — determines system degradation level based on load signals.
 *
 * Pure function, no side effects. The gateway interprets the level to decide
 * which pipeline stages to run.
 */

import type { CircuitState } from './circuit-breaker';

export type DegradationLevel = 'full' | 'reduced' | 'cloud' | 'minimal';

export interface DegradationPolicy {
  /** Queue depth threshold to enter 'reduced' mode. Default: 8 */
  reducedWhenQueueDepth?: number;
  /** P95 latency threshold (ms) to enter 'reduced' mode. Default: 2000 */
  reducedWhenP95Ms?: number;
  /** Queue depth threshold to enter 'cloud' mode. Default: 15 */
  cloudWhenQueueDepth?: number;
  /** P95 latency threshold (ms) to enter 'cloud' mode. Default: 4000 */
  cloudWhenP95Ms?: number;
  /** Enter 'cloud' when all circuits are open. Default: true */
  cloudWhenAllCircuitsOpen?: boolean;
  /** Enter 'minimal' when no providers are available. Default: true */
  minimalWhenNoProviders?: boolean;
}

const DEFAULT_POLICY: Required<DegradationPolicy> = {
  reducedWhenQueueDepth: 8,
  reducedWhenP95Ms: 2000,
  cloudWhenQueueDepth: 15,
  cloudWhenP95Ms: 4000,
  cloudWhenAllCircuitsOpen: true,
  minimalWhenNoProviders: true,
};

export interface DegradationSignals {
  queueDepth: number;
  p95LatencyMs: number | null;
  circuitStates: Map<number, CircuitState>;
  readyTiers: number;
  activeSessions: number;
  /**
   * #289 — number of tiers actively booting (not yet ready). Optional for
   * back-compat. When > 0 and no tier is ready yet, the system reports
   * `cloud` (a GPU is imminent) instead of `minimal` (text-only), so callers
   * don't tear down audio output for a pipeline that's seconds from ready.
   */
  bootingTiers?: number;
}

/**
 * Determine the system degradation level from current load signals.
 * Checks thresholds from worst to best — the first match wins.
 *
 * Levels (for the gateway to interpret):
 * - full:    GPU pipeline — STT + LLM + TTS + voice clone
 * - reduced: GPU pipeline — STT + LLM + TTS, no voice clone (faster)
 * - cloud:   Cloud APIs only — Groq STT, cloud LLM, OpenAI TTS
 * - minimal: Text subtitles only, no audio output
 */
export function determineDegradation(
  signals: DegradationSignals,
  policy?: DegradationPolicy,
): DegradationLevel {
  const p = { ...DEFAULT_POLICY, ...policy };

  // Check minimal first (worst case). Cover BOTH shapes of "no providers":
  //   (a) tiers were tracked and every circuit is open (post-failure state)
  //   (b) no tiers/circuits at all (cold start, all deploys failed) — the
  //       previous code skipped this case because it required size > 0,
  //       letting the function return 'full' which advertises a GPU
  //       pipeline that doesn't exist.
  if (p.minimalWhenNoProviders && signals.readyTiers === 0) {
    // #289: a tier is actively booting — a GPU is imminent. Degrade to
    // `cloud` (serve via cloud APIs while the GPU finishes booting) rather
    // than `minimal` (text-only), which would needlessly drop audio output.
    const booting = signals.bootingTiers ?? 0;
    if (signals.circuitStates.size === 0) {
      return booting > 0 ? 'cloud' : 'minimal';
    }
    const allOpen = [...signals.circuitStates.values()].every((s) => s === 'open');
    if (allOpen) {
      return booting > 0 ? 'cloud' : 'minimal';
    }
  }

  // Check cloud level
  if (p.cloudWhenAllCircuitsOpen && signals.circuitStates.size > 0) {
    const allOpen = [...signals.circuitStates.values()].every((s) => s === 'open');
    if (allOpen) return 'cloud';
  }

  if (signals.queueDepth >= p.cloudWhenQueueDepth) return 'cloud';

  if (signals.p95LatencyMs !== null && signals.p95LatencyMs >= p.cloudWhenP95Ms) return 'cloud';

  // Check reduced level
  if (signals.queueDepth >= p.reducedWhenQueueDepth) return 'reduced';

  if (signals.p95LatencyMs !== null && signals.p95LatencyMs >= p.reducedWhenP95Ms) return 'reduced';

  return 'full';
}
