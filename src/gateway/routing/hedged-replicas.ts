/**
 * Hedged calls over replicas of one service (e.g. three Qwen3-TTS servers).
 *
 * `withProviderFallback` is sequential: the next replica is tried only after the current one FAILED or hit its timeout, so
 * a slow-but-alive replica costs the whole per-attempt timeout (seconds, in a voice pipeline) before anyone else is asked.
 * Hedging fixes exactly that: when the current attempt has not answered after `hedgeAfterMs`, the next replica is asked too,
 * the first success wins and the other attempts are aborted. A replica that FAILS (retryable error) hands over to the next one
 * at once, without waiting for the hedge timer.
 *
 * Health is the same as the sequential chain's (`entryHealthKey`, `CooldownTracker`): each replica cools down on its own,
 * cooling replicas are skipped, and a replica that lost a race by being slow is NOT counted as failed.
 *
 * `onOutcome` reports every attempt, including the ones aborted because a sibling won (`censored: true`: the real latency is
 * at least `latencyMs`), so a caller that ranks replicas by observed latency does not only see the winners' good numbers.
 */
import { CooldownTracker, defaultCooldownTracker, isRetryableError, type FallbackEntry } from '../providers/cloud/fallback';

export interface HedgedOptions {
  /** Ask the next replica when the in-flight attempt has not answered after this many ms. Default 1500. */
  hedgeAfterMs?: number;
  /** Most attempts in flight at once. Default 2: slow requests cost at most twice the work, never more. */
  maxParallel?: number;
  /** Per-attempt timeout in ms (a timed-out attempt counts as a failure). Default: none. */
  timeoutMs?: number;
  cooldownTracker?: CooldownTracker;
  /** Failures inside the cooldown window that take a replica out of rotation. Default 2. */
  allowedFails?: number;
  /** How long a replica stays out of rotation. Default 20 000 ms. */
  cooldownMs?: number;
  onOutcome?: (entry: FallbackEntry, outcome: { ok: boolean; latencyMs: number; censored: boolean }) => void;
}

export interface HedgedResult<T> {
  result: T;
  usedEndpoint?: string;
  /** Attempts started (including aborted ones). */
  attempts: number;
  /** True when a second replica was asked while the first was still pending. */
  hedged: boolean;
  latencyMs: number;
}

const TIMEOUT = Symbol('attempt-timeout');

export function withHedgedReplicas<T>(
  chain: FallbackEntry[],
  fn: (entry: FallbackEntry, signal: AbortSignal) => Promise<T>,
  options: HedgedOptions = {},
): Promise<HedgedResult<T>> {
  const {
    hedgeAfterMs = 1500, maxParallel = 2, timeoutMs, allowedFails = 2, cooldownMs = 20_000, onOutcome,
  } = options;
  const tracker = options.cooldownTracker ?? defaultCooldownTracker;
  if (chain.length === 0) return Promise.reject(new Error('withHedgedReplicas: no replicas'));
  // Cooling replicas are skipped; if every one is cooling, trying them all beats failing without a call.
  const live = chain.filter((entry) => !tracker.isCoolingDown(entry));
  const queue = live.length > 0 ? live : chain;

  return new Promise<HedgedResult<T>>((resolve, reject) => {
    const started = Date.now();
    const inFlight = new Map<number, { entry: FallbackEntry; ctrl: AbortController; at: number; timer?: ReturnType<typeof setTimeout> }>();
    let next = 0;
    let launched = 0;
    let hedged = false;
    let done = false;
    let lastError: unknown;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      done = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      for (const attempt of inFlight.values()) if (attempt.timer) clearTimeout(attempt.timer);
    };

    const abortLosers = (winner: number): void => {
      for (const [index, attempt] of inFlight) {
        if (index === winner) continue;
        attempt.ctrl.abort();
        // Aborted by a winner, not failed: only a lower bound on how slow it was.
        onOutcome?.(attempt.entry, { ok: true, latencyMs: Date.now() - attempt.at, censored: true });
      }
    };

    const scheduleHedge = (): void => {
      if (done || next >= queue.length) return;
      hedgeTimer = setTimeout(() => {
        if (done || inFlight.size >= maxParallel || next >= queue.length) return;
        hedged = true;
        launch();
      }, hedgeAfterMs);
    };

    const failed = (index: number, error: unknown): void => {
      const attempt = inFlight.get(index);
      if (done || !attempt) return; // aborted loser, or already settled
      inFlight.delete(index);
      if (attempt.timer) clearTimeout(attempt.timer);
      lastError = error;
      if (!isRetryableError(error)) {
        // A bad request is bad on every replica: stop, and do not blame this one for it.
        abortLosers(-1);
        finish();
        reject(error);
        return;
      }
      tracker.recordFailure(attempt.entry, allowedFails, cooldownMs);
      onOutcome?.(attempt.entry, { ok: false, latencyMs: Date.now() - attempt.at, censored: false });
      if (next < queue.length && inFlight.size < maxParallel) {
        if (hedgeTimer) clearTimeout(hedgeTimer);
        launch(); // hand over at once, no waiting for the hedge timer
      } else if (inFlight.size === 0) {
        finish();
        reject(lastError);
      }
    };

    const launch = (): void => {
      const index = next++;
      const entry = queue[index]!;
      const ctrl = new AbortController();
      const attempt: { entry: FallbackEntry; ctrl: AbortController; at: number; timer?: ReturnType<typeof setTimeout> } = { entry, ctrl, at: Date.now() };
      inFlight.set(index, attempt);
      launched++;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      scheduleHedge();

      const timeout = timeoutMs === undefined
        ? undefined
        : new Promise<typeof TIMEOUT>((resolveTimeout) => {
          attempt.timer = setTimeout(() => resolveTimeout(TIMEOUT), timeoutMs);
        });
      const call = fn(entry, ctrl.signal);
      const settled = timeout ? Promise.race([call, timeout]) : call;
      settled.then(
        (value) => {
          if (value === TIMEOUT) {
            ctrl.abort();
            failed(index, Object.assign(new Error(`replica attempt timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
            return;
          }
          if (done) return;
          const winner = value as T;
          abortLosers(index);
          if (attempt.timer) clearTimeout(attempt.timer);
          tracker.recordSuccess(entry);
          const latencyMs = Date.now() - attempt.at;
          onOutcome?.(entry, { ok: true, latencyMs, censored: false });
          finish();
          resolve({ result: winner, ...(entry.endpoint ? { usedEndpoint: entry.endpoint } : {}), attempts: launched, hedged, latencyMs: Date.now() - started });
        },
        (error: unknown) => failed(index, error),
      );
    };

    launch();
  });
}
