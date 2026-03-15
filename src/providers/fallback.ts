/**
 * Provider Fallback Utility
 *
 * Tries providers in order with per-attempt timeouts.
 * Designed for real-time voice pipelines: fail fast, try next.
 *
 * Features:
 *   1. Cooldown: after `allowedFails` failures within a 60s window, a provider
 *      is skipped for `cooldownMs` ms — prevents hammering a dead endpoint.
 *   2. Per-provider retries with exponential backoff: on transient 5xx errors,
 *      retry the same provider N times before moving on. Set retriesPerProvider=0
 *      for real-time routes (default), 1-2 for system/background routes.
 *   3. Context window fallback: 400 context_length_exceeded errors are treated as
 *      retryable. Pass `contextWindowFallbacks` to auto-upgrade to a larger model
 *      on the same provider before falling back to the next one.
 *
 * Retry policy per error type:
 *   - Timeout           → try next provider immediately (no retry)
 *   - 429               → try next provider immediately (no retry — rate limited)
 *   - 5xx               → retry with backoff up to retriesPerProvider, then next
 *   - context_length    → optionally upgrade model, then next provider
 *   - 401/402/403       → try next provider immediately (each provider has its own key)
 *   - 400 (other)       → throw immediately (invalid request, no point retrying)
 */

import { AdaptiveTimeoutCalculator } from './adaptive-timeout';
import { CreditBlockTracker, defaultCreditBlockTracker } from './credit-block';
import { CreditExhaustedError } from './errors';
import { PerformanceRanker } from './performance-ranker';

export interface FallbackEntry {
  provider: string;
  model?: string;
}

export interface FallbackOptions {
  logPrefix?: string;
  /**
   * Max milliseconds to wait for a single provider attempt.
   * On timeout, the next provider is tried immediately — no retry.
   * Recommended values: STT 8_000 | LLM voice 10_000 | TTS 8_000 | system 30_000
   */
  timeoutMs?: number;
  /**
   * Number of retries on transient 5xx errors before moving to the next provider.
   * Default: 0 (no retries — recommended for real-time voice).
   * Use 1-2 for system/background routes where latency is less critical.
   * Note: 429 and timeouts are never retried within the same provider.
   */
  retriesPerProvider?: number;
  /**
   * Base delay in ms for exponential backoff between retries.
   * Actual delay per retry: retryBaseDelayMs * 2^(attempt - 1).
   * Default: 200ms → retries at 200ms, 400ms, 800ms…
   */
  retryBaseDelayMs?: number;
  /**
   * Context window fallbacks: model → larger-context model (same provider).
   * When context_length_exceeded is detected, the upgraded model is inserted
   * as the next chain entry before falling through to a different provider.
   * Example: { 'gpt-4o-mini': 'gpt-4o', 'llama-3.1-8b-instant': 'llama-3.3-70b-versatile' }
   */
  contextWindowFallbacks?: Record<string, string>;
  /**
   * Failures within COOLDOWN_WINDOW_MS before a provider enters cooldown.
   * Default: 3.
   */
  allowedFails?: number;
  /**
   * Duration in ms to skip a provider after it exceeds allowedFails.
   * Default: 60_000 (1 minute).
   */
  cooldownMs?: number;
  /**
   * Inject a CooldownTracker instance for testability.
   * Default: module-level defaultCooldownTracker.
   */
  cooldownTracker?: CooldownTracker;
  /**
   * Credit block tracker for 402 (payment required) errors.
   * Inject for testability. Default: module-level defaultCreditBlockTracker.
   */
  creditBlockTracker?: CreditBlockTracker;
  /**
   * API key hashes per provider, used for credit-block keying.
   * Key: provider id, Value: hashed API key (use hashApiKey()).
   */
  apiKeyHashes?: Record<string, string>;
  /**
   * Adaptive timeout calculator. When provided, per-provider timeouts are
   * computed from observed latency history instead of using the static timeoutMs.
   * After each successful call, the observed latency is recorded automatically.
   */
  adaptiveTimeout?: AdaptiveTimeoutCalculator;
  /** Logger for structured output. Default: console. */
  logger?: import('../deps').Logger;
  /**
   * Performance ranker for reordering fallback chains by observed latency.
   * When provided (along with `stage`), the chain is reordered before iteration
   * and latency samples are recorded after each attempt.
   */
  performanceRanker?: PerformanceRanker;
  /**
   * Pipeline stage name (e.g. 'stt', 'llm', 'tts').
   * Required when performanceRanker is set — used as the key dimension.
   */
  stage?: string;
}

// ─── Cooldown tracking ──────────────────────────────────────────────────────

interface CooldownState {
  failures: number;
  windowStart: number; // when the current failure window started
  coolUntil: number;   // 0 if not cooling down
}

const COOLDOWN_WINDOW_MS = 60_000; // rolling window for counting failures
const DEFAULT_ALLOWED_FAILS = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

function cooldownKey(entry: FallbackEntry): string {
  return `${entry.provider}:${entry.model ?? '*'}`;
}

/**
 * Encapsulates provider cooldown state.
 * Testable: inject a fresh instance per test instead of relying on module-level state.
 */
export class CooldownTracker {
  private map = new Map<string, CooldownState>();

  isCoolingDown(entry: FallbackEntry): boolean {
    const state = this.map.get(cooldownKey(entry));
    if (!state || state.coolUntil === 0) return false;
    if (state.coolUntil > Date.now()) return true;
    this.map.delete(cooldownKey(entry));
    return false;
  }

  recordFailure(entry: FallbackEntry, allowedFails: number, cooldownMs: number): void {
    const key = cooldownKey(entry);
    const now = Date.now();
    const state = this.map.get(key) ?? { failures: 0, windowStart: now, coolUntil: 0 };

    if (now - state.windowStart > COOLDOWN_WINDOW_MS) {
      state.failures = 0;
      state.windowStart = now;
    }

    state.failures += 1;

    if (state.failures >= allowedFails) {
      state.coolUntil = now + cooldownMs;
    }

    this.map.set(key, state);
  }

  recordSuccess(entry: FallbackEntry): void {
    this.map.delete(cooldownKey(entry));
  }

  getState(): Map<string, CooldownState> {
    return this.map;
  }

  /** Serialize active cooldowns to a plain object for persistence. */
  toJSON(): Record<string, CooldownState> {
    const now = Date.now();
    const result: Record<string, CooldownState> = {};
    for (const [key, state] of this.map) {
      // Only persist entries that are still cooling down
      if (state.coolUntil > now) {
        result[key] = state;
      }
    }
    return result;
  }

  /** Restore cooldowns from a previously persisted object. */
  fromJSON(data: Record<string, CooldownState>): void {
    const now = Date.now();
    for (const [key, state] of Object.entries(data)) {
      if (state && typeof state.coolUntil === 'number' && state.coolUntil > now) {
        this.map.set(key, state);
      }
    }
  }
}

/** Default module-level instance for backward compat */
export const defaultCooldownTracker = new CooldownTracker();

/** Export for testing / monitoring */
export function getCooldownState(): Map<string, CooldownState> {
  return defaultCooldownTracker.getState();
}

// ─── Timeout marker ──────────────────────────────────────────────────────────

/** Symbol used to mark timeout errors without mutating arbitrary objects */
const TIMEOUT_MARKER = Symbol.for('__parle_fallback_timeout');

function markAsTimeout(err: Error): Error {
  (err as Error & { [key: symbol]: boolean })[TIMEOUT_MARKER] = true;
  return err;
}

export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as Record<symbol, unknown>)[TIMEOUT_MARKER] === true;
}

// ─── Error classification ─────────────────────────────────────────────────────

/** HTTP status codes that are retryable (transient server errors + rate limit + auth) */
const RETRYABLE_STATUSES = new Set([401, 402, 403, 429, 500, 502, 503, 504]);

/** Error codes that should be treated as retryable even on 400 status (provider-specific issues) */
const RETRYABLE_ERROR_CODES = new Set(['model_terms_required', 'model_not_found', 'model_decommissioned']);

/**
 * HTTP status codes that are retryable by switching provider but not by retrying.
 * 401/402/403: auth/billing errors — each provider has its own API key, so failure
 * on one provider doesn't mean the next will fail too. Move on immediately.
 * 429: rate limited — no point waiting on the same provider.
 */
const MOVE_ON_STATUSES = new Set([401, 402, 403, 429]);

function extractStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  if (typeof e.status === 'number') return e.status;
  if (e.response && typeof (e.response as Record<string, unknown>).status === 'number') {
    return (e.response as Record<string, unknown>).status as number;
  }
  const msg = typeof e.message === 'string' ? e.message : '';
  const match = msg.match(/\b([45]\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/** Returns true if this error warrants a fallback to the next provider */
export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true; // network / unknown — try next
  const e = err as Record<string, unknown>;
  if (isTimeoutError(err)) return true;
  if (isContextWindowError(err)) return true; // context errors are retryable (next provider)
  // Provider-specific 400 errors that should trigger fallback (e.g. model terms not accepted)
  const code = typeof e.code === 'string' ? e.code : '';
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true;
  const status = extractStatus(err);
  if (status === null) return true;
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Returns true if this is a 5xx transient error worth retrying with backoff.
 * 429 (rate limited) and timeouts are NOT retried — we move to next provider fast.
 */
function is5xxError(err: unknown): boolean {
  const status = extractStatus(err);
  return status !== null && status >= 500 && status < 600;
}

const CONTEXT_WINDOW_PATTERNS = [
  'context_length_exceeded',
  'context window',
  'maximum context',
  'context too long',
  'tokens exceed',
  'prompt is too long',
  'input too long',
  'too many tokens',
];

/** Returns true if the error is specifically a context window / prompt too long error */
export function isContextWindowError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const msg = (typeof e.message === 'string' ? e.message : '').toLowerCase();
  const code = typeof e.code === 'string' ? e.code.toLowerCase() : '';
  return CONTEXT_WINDOW_PATTERNS.some((p) => msg.includes(p) || code.includes(p));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main fallback executor ───────────────────────────────────────────────────

/**
 * Executes `fn` with each entry in `chain` until one succeeds.
 *
 * - Each attempt is bounded by `options.timeoutMs` (real-time safety net).
 * - 5xx errors are retried up to `retriesPerProvider` times with exponential backoff.
 * - Providers that fail repeatedly are cooled down and skipped automatically.
 * - Context window errors are treated as retryable (moves to next provider,
 *   optionally upgrading to a larger model first via `contextWindowFallbacks`).
 */
export async function withProviderFallback<T>(
  chain: FallbackEntry[],
  fn: (entry: FallbackEntry, attempt: number) => Promise<T>,
  options: FallbackOptions | string = {},
): Promise<{ result: T; usedProvider: string; usedModel?: string; attempts: number }> {
  const opts: FallbackOptions =
    typeof options === 'string' ? { logPrefix: options } : options;

  const {
    logPrefix = '[Fallback]',
    timeoutMs,
    retriesPerProvider = 0,
    retryBaseDelayMs = 200,
    contextWindowFallbacks,
    allowedFails = DEFAULT_ALLOWED_FAILS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    cooldownTracker: tracker = defaultCooldownTracker,
    creditBlockTracker: creditTracker = defaultCreditBlockTracker,
    apiKeyHashes = {},
    adaptiveTimeout,
    logger: log = { log: console.log, warn: console.warn, error: console.error },
    performanceRanker,
    stage: perfStage,
  } = opts;

  // Clone so we can splice in context-window upgrades without mutating the caller's array
  const workChain = [...chain];

  if (workChain.length === 0) throw new Error('Empty provider fallback chain');

  // ── Pre-flight: skip credit-blocked providers ─────────────────────────────
  const creditBlockedProviders: string[] = [];
  const availableChain = workChain.filter((entry) => {
    const keyHash = apiKeyHashes[entry.provider];
    if (keyHash && creditTracker.isBlocked(entry.provider, keyHash)) {
      creditBlockedProviders.push(entry.provider);
      log.log(
        `${logPrefix} skipping ${entry.provider}/${entry.model ?? 'default'} (credit-blocked)`,
      );
      return false;
    }
    return true;
  });

  if (availableChain.length === 0 && creditBlockedProviders.length > 0) {
    throw new CreditExhaustedError([...new Set(creditBlockedProviders)]);
  }

  // Use the filtered chain for iteration, but keep workChain for context-window splicing
  // Optionally reorder by observed performance before iterating
  const iterChain =
    performanceRanker && perfStage
      ? performanceRanker.rankChain(perfStage, availableChain)
      : availableChain;

  let lastError: unknown;
  const got402From: string[] = [];

  for (let i = 0; i < iterChain.length; i++) {
    const entry = iterChain[i];

    // ── Cooldown check ────────────────────────────────────────────────────────
    if (tracker.isCoolingDown(entry)) {
      const state = tracker.getState().get(cooldownKey(entry));
      const remainingSecs = state ? Math.ceil((state.coolUntil - Date.now()) / 1000) : 0;
      log.log(
        `${logPrefix} skipping ${entry.provider}/${entry.model ?? 'default'} ` +
        `(cooling down, ${remainingSecs}s remaining)`,
      );
      continue;
    }

    // ── Per-provider retry loop ───────────────────────────────────────────────
    const maxAttempts = 1 + retriesPerProvider;

    for (let retryNum = 0; retryNum < maxAttempts; retryNum++) {
      // Exponential backoff before each retry (not before the first attempt)
      if (retryNum > 0) {
        const delay = retryBaseDelayMs * Math.pow(2, retryNum - 1);
        log.log(
          `${logPrefix} ${entry.provider}/${entry.model ?? 'default'} ` +
          `retry ${retryNum}/${retriesPerProvider} in ${delay}ms`,
        );
        await sleep(delay);
      }

      const t0 = Date.now();

      try {
        // ── Resolve effective timeout ─────────────────────────────────────────
        const effectiveTimeout = adaptiveTimeout
          ? adaptiveTimeout.getTimeout(entry.provider, entry.model ?? '*', timeoutMs ?? 0)
          : timeoutMs;

        // ── Execute with optional timeout ─────────────────────────────────────
        let call = fn(entry, i);

        if (effectiveTimeout) {
          let timeoutHandle: ReturnType<typeof setTimeout>;
          const timeoutRace = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              const err = new Error(
                `${entry.provider}/${entry.model ?? 'default'} timeout after ${effectiveTimeout}ms`,
              );
              reject(markAsTimeout(err));
            }, effectiveTimeout);
          });
          call = Promise.race([call, timeoutRace]).finally(() =>
            clearTimeout(timeoutHandle!),
          );
        }

        const result = await call;
        const elapsed = Date.now() - t0;

        tracker.recordSuccess(entry);

        // ── Record latency for adaptive timeout ──────────────────────────────
        if (adaptiveTimeout) {
          adaptiveTimeout.record(entry.provider, entry.model ?? '*', elapsed);
        }

        // Record successful latency sample
        if (performanceRanker && perfStage) {
          performanceRanker.record(
            perfStage, entry.provider, entry.model ?? '*', elapsed, true,
          );
        }

        if (i > 0 || retryNum > 0) {
          log.log(
            `${logPrefix} ok — ${entry.provider}/${entry.model ?? 'default'} ` +
            `(${elapsed}ms${retryNum > 0 ? `, retry ${retryNum}` : ''})`,
          );
        }

        return {
          result,
          usedProvider: entry.provider,
          usedModel: entry.model,
          attempts: i + 1,
        };
      } catch (err: unknown) {
        lastError = err;
        const elapsed = Date.now() - t0;
        const isTimeout = isTimeoutError(err);
        const isContext = isContextWindowError(err);
        const retryable = isRetryableError(err);

        // Record failed latency sample
        if (performanceRanker && perfStage) {
          performanceRanker.record(
            perfStage, entry.provider, entry.model ?? '*', elapsed, false,
          );
        }

        // ── Non-retryable: abort everything ──────────────────────────────────
        if (!retryable && !isContext) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const status = extractStatus(err);
          log.warn(
            `${logPrefix} ${entry.provider}/${entry.model ?? 'default'} ` +
            `non-retryable error${status ? ` (HTTP ${status})` : ''} (${elapsed}ms) — abort: ${errMsg}`,
          );
          throw err;
        }

        // ── Context window error ──────────────────────────────────────────────
        if (isContext) {
          log.warn(
            `${logPrefix} ${entry.provider}/${entry.model ?? 'default'} ` +
            `context window exceeded (${elapsed}ms) → next`,
          );
          tracker.recordFailure(entry, allowedFails, cooldownMs);

          // Optionally insert a larger-context model upgrade into the chain
          if (contextWindowFallbacks && entry.model) {
            const upgradedModel = contextWindowFallbacks[entry.model];
            if (upgradedModel) {
              const upgradeEntry: FallbackEntry = {
                provider: entry.provider,
                model: upgradedModel,
              };
              log.log(
                `${logPrefix} inserting context upgrade: ` +
                `${entry.provider}/${upgradedModel}`,
              );
              iterChain.splice(i + 1, 0, upgradeEntry);
            }
          }
          break; // stop retrying this entry, move to next in iterChain
        }

        // ── Timeout or auth/rate-limit: move on immediately, no retry ─────────
        const moveOnStatus = extractStatus(err);
        if (isTimeout || MOVE_ON_STATUSES.has(moveOnStatus ?? 0)) {
          tracker.recordFailure(entry, allowedFails, cooldownMs);

          // ── Record 402 in credit block tracker ──────────────────────────────
          if (moveOnStatus === 402) {
            const keyHash = apiKeyHashes[entry.provider];
            if (keyHash) {
              creditTracker.recordBlock(entry.provider, keyHash);
              got402From.push(entry.provider);
              log.warn(
                `${logPrefix} ${entry.provider} credit-blocked (402) for 5min`,
              );
            }
          }

          const reason = isTimeout
            ? `timeout ${elapsed}ms`
            : `${moveOnStatus} ${moveOnStatus === 429 ? 'rate-limited' : 'auth/billing error'} ${elapsed}ms`;
          const hasNext = i < iterChain.length - 1;
          log.warn(
            `${logPrefix} ${entry.provider}/${entry.model ?? 'default'} ` +
            `${reason}` +
            (hasNext ? ' → next provider' : ' → no fallback left'),
          );
          break; // no retry, try next provider
        }

        // ── 5xx transient error ───────────────────────────────────────────────
        tracker.recordFailure(entry, allowedFails, cooldownMs);

        const isLastRetry = retryNum >= maxAttempts - 1;
        const hasNextProvider = iterChain.slice(i + 1).some((e) => !tracker.isCoolingDown(e));

        if (!isLastRetry && is5xxError(err)) {
          // Will retry this provider after backoff (handled at top of loop)
          log.warn(
            `${logPrefix} ${entry.provider}/${entry.model ?? 'default'} ` +
            `5xx error (${elapsed}ms) — will retry`,
          );
          // continue inner retry loop
        } else {
          log.warn(
            `${logPrefix} ${entry.provider}/${entry.model ?? 'default'} ` +
            `failed (${elapsed}ms)` +
            (hasNextProvider ? ' → next provider' : ' → no fallback left'),
          );
          break; // exhausted retries for this provider, try next
        }
      }
    }
  }

  // Log which providers were tried vs skipped for debugging
  const tried: string[] = [];
  const skipped: string[] = [];
  for (const entry of chain) {
    if (tracker.isCoolingDown(entry)) {
      skipped.push(`${entry.provider}/${entry.model ?? 'default'} (cooldown)`);
    } else {
      tried.push(`${entry.provider}/${entry.model ?? 'default'}`);
    }
  }
  if (skipped.length > 0) {
    log.warn(
      `${typeof options === 'string' ? options : (options as FallbackOptions).logPrefix ?? '[Fallback]'} ` +
      `all providers failed — tried: [${tried.join(', ')}], skipped: [${skipped.join(', ')}]`,
    );
  }

  // If any provider returned 402, throw a descriptive CreditExhaustedError
  if (got402From.length > 0) {
    throw new CreditExhaustedError([...new Set([...creditBlockedProviders, ...got402From])]);
  }

  throw lastError ?? new Error('All providers in fallback chain failed');
}
