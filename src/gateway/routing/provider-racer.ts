// ── BabelCast Gateway — Request Hedging (Race Providers) ────────────────────
// Races GPU vs cloud requests in parallel, returning whichever responds first.
// The loser is cancelled via AbortController to avoid wasting resources.
//
// This is the single biggest latency improvement for real-time subtitles:
// instead of waiting 5s for a GPU timeout before trying cloud (200ms),
// we fire both simultaneously and take the fastest response.

import { createLogger } from '../../logger';

const log = createLogger('race-providers');

export interface RaceCandidate<T> {
  /** Human label for logging */
  name: string;
  /** The actual request — MUST respect the signal for cancellation */
  run: (signal: AbortSignal) => Promise<T>;
  /** Hard timeout for this candidate (ms). Default: no extra timeout beyond race. */
  timeoutMs?: number;
}

export interface RaceResult<T> {
  result: T;
  provider: string;
  latencyMs: number;
  /** Whether the other candidate was cancelled (true) or also failed (false) */
  otherCancelled: boolean;
  /**
   * #87 — count of losing/speculative candidates that were aborted (i.e. fired
   * but did not produce the returned result). 0 for a single-candidate race.
   * Operators can sum this to estimate the cost of racing vs. its latency win.
   */
  wastedCalls?: number;
}

/**
 * #14 — exponential backoff with full jitter, honoring an optional `Retry-After`.
 *
 * Pure (no `this`, no timers) so it can be unit-tested deterministically by
 * injecting `rand`. When all racers fail with a transient 429, callers can use
 * this to compute a cheap retry delay instead of hard-failing immediately.
 *
 * - `retryAfterMs`, when provided (parsed from a 429 `Retry-After` header), is a
 *   hard floor — we never retry sooner than the server asked.
 * - Otherwise delay = random in [0, min(baseMs * 2^attempt, maxMs)] (full jitter,
 *   AWS-style) which avoids thundering-herd retries across many callers.
 */
export function computeRetryDelayMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; retryAfterMs?: number; rand?: () => number } = {},
): number {
  const { baseMs = 250, maxMs = 8_000, retryAfterMs, rand = Math.random } = opts;
  const a = Math.max(0, Math.floor(attempt));
  const exp = Math.min(maxMs, baseMs * 2 ** a);
  const jittered = Math.floor(exp * Math.max(0, Math.min(1, rand())));
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return Math.max(retryAfterMs, jittered);
  }
  return jittered;
}

/**
 * Race two (or more) provider requests. Returns the first successful result.
 *
 * - Each candidate gets its own AbortController.
 * - When one succeeds, all others are aborted.
 * - If all fail, throws the last error.
 * - Optional `headstartMs`: give primary a head start before launching fallback.
 *   Set to 0 for true parallel racing (recommended for real-time).
 * - Optional `overallDeadlineMs` (#9): a hard ceiling on the whole race so a
 *   single candidate with no `timeoutMs` cannot wedge the pipeline indefinitely.
 */
export async function raceProviders<T>(
  candidates: RaceCandidate<T>[],
  opts: { headstartMs?: number; logPrefix?: string; overallDeadlineMs?: number; onWaste?: (n: number) => void } = {},
): Promise<RaceResult<T>> {
  if (candidates.length === 0) throw new Error('raceProviders: no candidates');
  if (candidates.length === 1) {
    const c = candidates[0];
    const ac = new AbortController();
    const t0 = Date.now();
    // #9: an effective per-candidate timeout is the smaller of the candidate's
    // own timeoutMs and the overall deadline, so the single-candidate path also
    // respects the race-wide ceiling.
    const effTimeout = minDefined(c.timeoutMs, opts.overallDeadlineMs);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (effTimeout) {
      timeoutHandle = setTimeout(() => ac.abort(), effTimeout);
    }
    try {
      const result = await c.run(ac.signal);
      return { result, provider: c.name, latencyMs: Date.now() - t0, otherCancelled: false, wastedCalls: 0 };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  const { headstartMs = 0, logPrefix = '[race]', overallDeadlineMs, onWaste } = opts;
  const t0 = Date.now();

  // Each candidate gets its own AbortController
  const controllers = candidates.map(() => new AbortController());
  const timeoutHandles: (ReturnType<typeof setTimeout> | undefined)[] = [];

  // Set up per-candidate timeouts
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.timeoutMs) {
      timeoutHandles[i] = setTimeout(() => controllers[i].abort(), c.timeoutMs);
    }
  }

  // #9: overall race deadline — a single candidate with no per-candidate
  // timeout cannot wedge the pipeline. When it fires we abort *all* controllers,
  // which causes every in-flight candidate to reject with AbortError and the
  // race to surface the all-failed path below.
  let overallHandle: ReturnType<typeof setTimeout> | undefined;
  if (overallDeadlineMs && overallDeadlineMs > 0) {
    overallHandle = setTimeout(() => {
      for (const ctrl of controllers) ctrl.abort();
    }, overallDeadlineMs);
  }

  // Wrap each candidate to identify the winner
  const makeRacer = (c: RaceCandidate<T>, idx: number): Promise<RaceResult<T>> =>
    c.run(controllers[idx].signal).then(result => ({
      result,
      provider: c.name,
      latencyMs: Date.now() - t0,
      otherCancelled: true,
      _idx: idx,
    } as RaceResult<T> & { _idx: number }));

  try {
    let winner: RaceResult<T>;

    if (headstartMs > 0 && candidates.length >= 2) {
      // Give the primary candidate a head start
      const primary = makeRacer(candidates[0], 0);
      // Attach a no-op catch so a primary rejection that happens before the
      // head start expires does not surface as an unhandled rejection while we
      // wait. The original `primary` promise is still consumed by Promise.any
      // below, so its error is preserved for the all-failed aggregation.
      primary.catch(() => {});
      // The head-start race must NOT reject when the primary fast-fails: a
      // rejected primary should fall through to "launch the remaining
      // candidates", not abort the whole race. Map both fulfilment and
      // rejection of the primary to a discriminated sentinel so Promise.race
      // only ever resolves.
      const headstartResult = await Promise.race([
        primary.then(
          (w) => ({ kind: 'primary' as const, winner: w }),
          () => ({ kind: 'primary-failed' as const }),
        ),
        new Promise<{ kind: 'timeout' }>(r =>
          setTimeout(() => r({ kind: 'timeout' as const }), headstartMs),
        ),
      ]);

      if (headstartResult.kind === 'primary') {
        // Primary won during head start
        winner = headstartResult.winner;
      } else {
        // Head start expired OR primary fast-failed — launch remaining
        // candidates. Promise.any over [primary, ...remaining] still observes
        // the primary's eventual error if every candidate fails.
        const remaining = candidates.slice(1).map((c, i) => makeRacer(c, i + 1));
        winner = await Promise.any([primary, ...remaining]);
      }
    } else {
      // True parallel race
      winner = await Promise.any(candidates.map((c, i) => makeRacer(c, i)));
    }

    // Cancel all losers and tally them. #10: `otherCancelled` now reflects
    // reality (were there other candidates to cancel?) instead of the old
    // hard-coded `true`. #87: `wastedCalls` records how many speculative/loser
    // calls were fired so operators can weigh racing cost against its win.
    const winnerIdx = (winner as RaceResult<T> & { _idx?: number })._idx ?? -1;
    let wastedCalls = 0;
    for (let i = 0; i < controllers.length; i++) {
      if (i === winnerIdx) continue;
      // It was a real speculative/loser call regardless of whether it had
      // already failed on its own — count it for cost telemetry, then ensure
      // it is aborted to release upstream resources.
      controllers[i].abort();
      wastedCalls++;
    }
    // otherCancelled reflects whether at least one loser was actively cancelled
    // by us (true) vs. there being no other candidates to cancel (false).
    winner.otherCancelled = controllers.length > 1;
    winner.wastedCalls = wastedCalls;
    if (wastedCalls > 0) onWaste?.(wastedCalls);

    log.log(`${logPrefix} winner: ${winner.provider} (${winner.latencyMs}ms, ${wastedCalls} wasted)`);
    return winner;
  } catch (err) {
    // All candidates failed (AggregateError from Promise.any)
    if (err instanceof AggregateError) {
      // Log all failures
      for (let i = 0; i < err.errors.length; i++) {
        const e = err.errors[i];
        const name = candidates[i]?.name ?? `candidate-${i}`;
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`${logPrefix} ${name} failed: ${msg}`);
      }
      // Throw the last non-abort error, or the first error
      const realErrors = err.errors.filter(
        (e: unknown) => !(e instanceof DOMException && (e as DOMException).name === 'AbortError'),
      );
      throw realErrors[realErrors.length - 1] ?? err.errors[0];
    }
    throw err;
  } finally {
    // Clean up all timeouts
    for (const h of timeoutHandles) {
      if (h) clearTimeout(h);
    }
    if (overallHandle) clearTimeout(overallHandle);
  }
}

/** Smallest of two optional positive numbers; undefined when both are undefined. */
function minDefined(a?: number, b?: number): number | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}
