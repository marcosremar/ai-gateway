/**
 * readiness-logic.ts — framework-free helpers for the Readiness section's
 * adaptive poll cadence (#948).
 *
 * `ReadinessSection` derived `pollIntervalMs` from polled state and listed it in
 * the polling `useEffect` deps, so the interval was torn down and rebuilt every
 * time a stage flipped phase (10s ↔ 2s). The cadence decision is extracted here
 * as a pure function; the React layer keeps it in a ref and reads it from a
 * single, stable interval so phase changes no longer recreate the timer.
 *
 * Kept React/DOM-free so the cadence logic is unit-testable.
 */

/** Phases that indicate an in-flight readiness transition → poll fast. */
export const ACTIVE_READINESS_PHASES: ReadonlySet<string> = new Set([
  'benchmarking',
  'degraded',
  'repechage',
  'condemned',
]);

/** Fast cadence (ms) while a stage is transitioning or shadow mode is running. */
export const READINESS_FAST_INTERVAL_MS = 2000;
/** Idle cadence (ms) when nothing is transitioning. */
export const READINESS_IDLE_INTERVAL_MS = 10000;

/** Minimal shape of the readiness state needed to pick a cadence. */
export interface ReadinessCadenceState {
  readinessState?: {
    stt?: { phase?: string };
    llm?: { phase?: string };
    tts?: { phase?: string };
    shadowPhase?: unknown;
  } | null;
}

/** True when any of STT/LLM/TTS is in an active (transitioning) phase. Pure. */
export function hasActiveReadinessPhase(state: ReadinessCadenceState | null | undefined): boolean {
  const rs = state?.readinessState;
  if (!rs) return false;
  return (
    ACTIVE_READINESS_PHASES.has(rs.stt?.phase ?? '') ||
    ACTIVE_READINESS_PHASES.has(rs.llm?.phase ?? '') ||
    ACTIVE_READINESS_PHASES.has(rs.tts?.phase ?? '')
  );
}

/**
 * Pick the readiness poll interval: fast while any stage is transitioning or
 * shadow mode is active, otherwise the idle cadence. Pure (#948).
 */
export function readinessPollInterval(
  state: ReadinessCadenceState | null | undefined,
  fastMs = READINESS_FAST_INTERVAL_MS,
  idleMs = READINESS_IDLE_INTERVAL_MS,
): number {
  const shadowActive = Boolean(state?.readinessState?.shadowPhase);
  return hasActiveReadinessPhase(state) || shadowActive ? fastMs : idleMs;
}
