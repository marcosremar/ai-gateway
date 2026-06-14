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
}

/**
 * Race two (or more) provider requests. Returns the first successful result.
 *
 * - Each candidate gets its own AbortController.
 * - When one succeeds, all others are aborted.
 * - If all fail, throws the last error.
 * - Optional `headstartMs`: give primary a head start before launching fallback.
 *   Set to 0 for true parallel racing (recommended for real-time).
 */
export async function raceProviders<T>(
  candidates: RaceCandidate<T>[],
  opts: { headstartMs?: number; logPrefix?: string } = {},
): Promise<RaceResult<T>> {
  if (candidates.length === 0) throw new Error('raceProviders: no candidates');
  if (candidates.length === 1) {
    const c = candidates[0];
    const ac = new AbortController();
    const t0 = Date.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (c.timeoutMs) {
      timeoutHandle = setTimeout(() => ac.abort(), c.timeoutMs);
    }
    try {
      const result = await c.run(ac.signal);
      return { result, provider: c.name, latencyMs: Date.now() - t0, otherCancelled: false };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  const { headstartMs = 0, logPrefix = '[race]' } = opts;
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

    // Cancel all losers
    const winnerIdx = (winner as RaceResult<T> & { _idx?: number })._idx ?? -1;
    for (let i = 0; i < controllers.length; i++) {
      if (i !== winnerIdx) controllers[i].abort();
    }

    log.log(`${logPrefix} winner: ${winner.provider} (${winner.latencyMs}ms)`);
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
  }
}
