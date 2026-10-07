/**
 * Spot/preemptible resume controller — pure decision logic.
 *
 * vast.ai (and other) spot pods get reclaimed mid-run at random. With R2-durable
 * checkpoints (see run.ts r2* opts + pod-agent backup), a fresh pod can resume
 * from the last checkpoint. This module holds the *pure* pieces the CLI loop
 * needs so they can be unit-tested without a real deploy:
 *
 *   - isEvictionError: was the failure a transient pod death (retry) vs a real
 *     training bug (give up)?
 *   - attemptSpendUsd / JobBudget: accumulate spend ACROSS pod restarts so the
 *     budget guard survives a restart (per-pod accounting would reset to $0).
 *   - decideRetry: combine the two into a retry/stop decision.
 *
 * File I/O (loading/saving the budget) lives in the CLI; this module stays pure.
 */

/** Substrings that indicate a transient pod death / preemption / unreachability
 * (as opposed to a deterministic training error we'd just hit again). */
const EVICTION_SIGNATURES = [
  'exit code: 255',
  'ssh proxy',
  'rsync upload failed',
  'connection refused',
  'connection reset',
  'connection timed out',
  'boot timed out',
  'gpu disassociated',
  'stoppeddisassociated',
  'host unreachable',
  'no route to host',
  'broken pipe',
  'instance exited',
  'preempt',          // matches "preempted", "preemption"
  'destroyed',
  'terminated',
];

/** True if the error message looks like a spot eviction / pod death. */
export function isEvictionError(msg: string): boolean {
  const m = (msg || '').toLowerCase();
  return EVICTION_SIGNATURES.some((s) => m.includes(s));
}

export interface SpendAttempt {
  /** $/hour for the pod used in this attempt. */
  pricePerHr: number;
  /** ISO timestamp the pod started billing. */
  startedAt: string;
  /** ISO timestamp the attempt ended (now). */
  endedAt: string;
}

/** USD burned during a single pod attempt = pricePerHr × hours(startedAt→endedAt).
 * Returns 0 for malformed/negative inputs (never invents spend). */
export function attemptSpendUsd(a: SpendAttempt): number {
  const t0 = Date.parse(a.startedAt);
  const t1 = Date.parse(a.endedAt);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return 0;
  if (!(typeof a.pricePerHr === 'number') || !Number.isFinite(a.pricePerHr) || a.pricePerHr < 0) return 0;
  return a.pricePerHr * ((t1 - t0) / 3_600_000);
}

/** Cumulative budget for one logical job (keyed by its stable R2 prefix), so
 * spend persists across pod restarts and even across CLI invocations. */
export interface JobBudget {
  jobId: string;
  totalSpentUsd: number;
  attempts: number;
  updatedAt: string;
}

export function emptyBudget(jobId: string, now: string): JobBudget {
  return { jobId, totalSpentUsd: 0, attempts: 0, updatedAt: now };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Add one attempt's spend to the running total (clamps negatives to 0). */
export function addAttempt(b: JobBudget, spendUsd: number, now: string): JobBudget {
  return {
    jobId: b.jobId,
    totalSpentUsd: round2(b.totalSpentUsd + Math.max(0, spendUsd)),
    attempts: b.attempts + 1,
    updatedAt: now,
  };
}

export interface RetryDecision {
  retry: boolean;
  reason: string;
}

/** Decide whether to resubmit after a failed attempt.
 * Order: non-eviction → stop; budget exhausted → stop; attempts exhausted → stop;
 * otherwise retry. maxSpend <= 0 means "no spend cap" (only the attempts cap applies). */
export function decideRetry(args: {
  isEviction: boolean;
  attempt: number;        // 1-based attempt that just failed
  maxAttempts: number;
  totalSpentUsd: number;
  maxSpend: number;
}): RetryDecision {
  const { isEviction, attempt, maxAttempts, totalSpentUsd, maxSpend } = args;
  if (!isEviction) {
    return { retry: false, reason: 'non-eviction error (looks like a real failure, not a pod death) — not retrying' };
  }
  if (maxSpend > 0 && totalSpentUsd >= maxSpend) {
    return { retry: false, reason: `cumulative spend $${totalSpentUsd.toFixed(2)} reached budget $${maxSpend.toFixed(2)} — stopping` };
  }
  if (attempt >= maxAttempts) {
    return { retry: false, reason: `max attempts (${maxAttempts}) reached after eviction — stopping` };
  }
  return {
    retry: true,
    reason: `eviction — resuming (attempt ${attempt + 1}/${maxAttempts}, spent $${totalSpentUsd.toFixed(2)}${maxSpend > 0 ? `/$${maxSpend.toFixed(2)}` : ''})`,
  };
}

/** Derive the stable job id (= R2 prefix) used to key the budget + storage so a
 * restarted pod shares the same checkpoints. Mirrors run.ts buildR2Config. */
export function deriveJobId(opts: { r2Prefix?: string; project?: string; type?: string }): string {
  const raw = opts.r2Prefix || `jobs/${opts.project || opts.type || 'finetune'}`;
  return raw.replace(/\/+$/, '');
}
