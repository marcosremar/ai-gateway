/**
 * Provider routing shared by the chat, STT and TTS proxy routes.
 *
 * A gateway model maps to an ordered list of targets (provider instance + upstream model). Each request:
 *   1. drops targets whose provider is not configured (missing key) or whose circuit breaker is open;
 *   2. walks the rest with `withProviderFallback` (next target on 401/402/403/404/429/5xx/timeout);
 *   3. when nothing answers, returns 503 `provider_unavailable` naming the missing key or the failed provider.
 *
 * Error text that reaches a client goes through `redactSecrets` — a key value never leaves the gateway.
 */

import { CircuitBreakerRegistry } from '../providers/cloud/circuit-breaker';
import { isTimeoutError, type CooldownTracker, type FallbackEntry } from '../providers/cloud/fallback';
import { createLogger } from '../../logger';
import { entryHealthKey } from '../providers/cloud/entry-key';
import type { ProxyResponse } from './types';

const log = createLogger('provider-routing');

/** One provider able to serve a gateway model. */
export interface RouteTarget<P> {
  /** Label used in logs, circuit breakers and error messages (e.g. "groq", "openrouter", "deployment:parle-speech"). */
  providerId: string;
  provider: P;
  /** Upstream model id for this provider. Default: the gateway model requested by the client. */
  model?: string;
  /** TTS only: voice to use with this provider (voices are provider-specific). Default: the requested voice. */
  voice?: string;
  /**
   * Max time for one attempt on this target before moving to the next one (the call is aborted). Default: the
   * route's timeout. Deployments get a short one so a stuck replica does not delay the fallback.
   */
  timeoutMs?: number;
  /** Chat only: provider-specific body fields (e.g. OpenRouter `reasoning: { enabled: false }`). */
  extraBody?: Record<string, unknown>;
  /** Start the next target in parallel when this one has not answered after this many ms (see `runTargets`). */
  hedgeAfterMs?: number;
  /** Known to be unusable (e.g. OpenRouter key rejected): skipped with this reason, never called. */
  unavailableReason?: string;
  /**
   * Checked per request: a reason while the target is temporarily unusable (e.g. refused by the account's data
   * policy, `account-policy-guard.ts`), null otherwise. Skipped with code `policy`, never called.
   */
  unavailableNow?: () => string | null;
  /**
   * TTS only: picks this target's voice from the request (voices are provider-specific). Wins over `voice` and over
   * the request's `fallback_voice`.
   */
  voiceFor?: (request: { voice: string; fallbackVoice?: string }) => string;
}

/** Codes (see `failureCode`) of targets left behind, keyed by the target object (two targets may share a provider). */
export type FailureCodes = Map<object, string>;

/** Gateway model → one provider (legacy shape) or an ordered fallback list. */
export type StageRoutes<P> = Record<string, P | Array<RouteTarget<P>>>;

interface Configurable { readonly providerId: string; isConfigured(): boolean }

/** Env var that holds each cloud provider's key — used to say which key is missing (never its value). */
export const PROVIDER_KEY_ENV: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  zai: 'ZAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
};

/** Why a provider cannot be used right now, in words a client can act on. */
export function notConfiguredReason(providerId: string): string {
  if (providerId.startsWith('deployment:')) return `${providerId}: deployment not found on this gateway`;
  const env = PROVIDER_KEY_ENV[providerId];
  return env ? `${providerId}: ${env} is not set` : `${providerId}: not configured`;
}

/** Circuit breakers of every proxy route (one per provider label). Shared so /health?deep=1 can report them. */
export const proxyCircuitBreakers = new CircuitBreakerRegistry({ failureThreshold: 5, resetTimeoutMs: 30_000 });

export function normalizeTargets<P extends Configurable>(value: P | Array<RouteTarget<P>> | undefined): Array<RouteTarget<P>> {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [{ providerId: value.providerId, provider: value }];
}

/** Splits targets into the ones worth trying and the reasons the others were skipped. */
export function selectTargets<P extends Configurable>(
  targets: Array<RouteTarget<P>>,
  breakers: CircuitBreakerRegistry = proxyCircuitBreakers,
): { usable: Array<RouteTarget<P>>; skipped: string[]; codes: FailureCodes } {
  const usable: Array<RouteTarget<P>> = [];
  const skipped: string[] = [];
  const codes: FailureCodes = new Map();
  for (const target of targets) {
    if (target.unavailableReason) {
      skipped.push(target.unavailableReason);
      codes.set(target, 'not_configured');
      continue;
    }
    const blocked = target.unavailableNow?.() ?? null;
    if (blocked) {
      skipped.push(blocked);
      codes.set(target, 'policy');
      continue;
    }
    if (!target.provider.isConfigured()) {
      skipped.push(notConfiguredReason(target.providerId));
      codes.set(target, 'not_configured');
      continue;
    }
    if (breakers.get(entryHealthKey({ provider: target.providerId })).isOpen()) {
      skipped.push(`${target.providerId}: circuit open after repeated failures (retrying in <30 s)`);
      codes.set(target, 'circuit_open');
      continue;
    }
    usable.push(target);
  }
  return { usable, skipped, codes };
}

/** Short, secret-free reason a provider was left behind (sent as `X-Gateway-Fallback`). */
export function failureCode(err: unknown): string {
  const code = (err as { gatewayCode?: unknown } | null)?.gatewayCode;
  if (typeof code === 'string') return code;
  if (isTimeoutError(err)) return 'timeout';
  const status = statusOf(err);
  if (status === null) return 'unreachable';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credit';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return '5xx';
  return 'error';
}

/** `X-Gateway-Provider` value: `deployment:<name>` or `<provider>:<upstream model>`. */
export function providerHeader(target: Pick<RouteTarget<unknown>, 'providerId' | 'model'>): string {
  return target.providerId.startsWith('deployment:') || !target.model ? target.providerId : `${target.providerId}:${target.model}`;
}

/**
 * Origin headers for a served request: which provider answered and, when it was not the first candidate, why the
 * earlier ones were left (`X-Gateway-Fallback`: cold | 5xx | timeout | unreachable | auth | rate_limited | credit |
 * not_found | not_configured | policy | circuit_open | cooldown | error) and which one that was (`X-Gateway-Fallback-From`).
 */
export function originHeaders(
  candidates: Array<Pick<RouteTarget<unknown>, 'providerId' | 'model'>>,
  used: Pick<RouteTarget<unknown>, 'providerId' | 'model'>,
  codes: FailureCodes,
): Record<string, string> {
  const headers: Record<string, string> = { 'X-Gateway-Provider': providerHeader(used) };
  const first = candidates[0];
  // Compared by identity: openrouter → openrouter (two models) is a fallback too.
  if (first && first !== used) {
    headers['X-Gateway-Fallback'] = codes.get(first) ?? 'cooldown';
    headers['X-Gateway-Fallback-From'] = providerHeader(first);
  }
  return headers;
}

/** Thrown when no provider could serve the request. Carries one reason per provider. */
export class ProviderUnavailableError extends Error {
  readonly status = 503;
  constructor(readonly reasons: string[], readonly retryAfterSec?: number) {
    super(reasons.length ? `no provider available: ${reasons.join('; ')}` : 'no provider available');
    this.name = 'ProviderUnavailableError';
  }
}

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgsk_[A-Za-z0-9]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /https?:\/\/[^\s"']+/g,
];

/** Removes key values (from the environment and well-known key shapes) and URLs from a message. */
export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_ENV_NAME.test(name)) continue;
    out = out.split(value).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (m) => (m.startsWith('http') ? '[url]' : '[redacted]'));
  return out;
}

function statusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

export function describeFailure(providerId: string, err: unknown): string {
  const status = statusOf(err);
  const message = err instanceof Error ? err.message : String(err);
  return `${providerId} failed${status ? ` (HTTP ${status})` : ''}: ${redactSecrets(message).slice(0, 160)}`;
}

/** Statuses that mean "the request itself is wrong" — another provider would refuse it too, so pass them through. */
export function isClientErrorStatus(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && ![401, 402, 403, 404, 408, 429].includes(status);
}

export interface RunTargetsOptions {
  stage: string;
  /** Per-attempt timeout for targets without their own `timeoutMs`. */
  timeoutMs?: number;
  /**
   * Total time for the whole chain (primary + fallbacks + hedges). Every attempt is capped by what is left, so the
   * answer (or the 503) arrives before the client's own deadline.
   */
  budgetMs?: number;
  retriesPerProvider?: number;
  cooldownTracker?: CooldownTracker;
  breakers?: CircuitBreakerRegistry;
  /**
   * Rejects a result that must count as a provider failure (e.g. an empty chat answer): return an error message
   * and the chain moves on to the next target (code `empty`).
   */
  validate?: (result: unknown) => string | null;
}

class AttemptError extends Error {
  readonly skipRetry = true;
  constructor(readonly status: number, message: string, readonly gatewayCode: string) { super(message); }
}

/**
 * Failures that say nothing about the provider's health: a deployment still booting (`cold`), paused, a request it
 * must not receive (`voice_not_found`, `catalog_unavailable`), or a model the account's data policy refuses (`policy`:
 * one OpenRouter model refused under ZDR must not open the breaker shared by every OpenRouter model). They never open the circuit nor start a cooldown, so
 * traffic goes back to the deployment as soon as its replica is ready.
 */
const NEUTRAL_CODES = new Set(['cold', 'paused', 'voice_not_found', 'catalog_unavailable', 'policy']);

/** Default total time per stage (deployment + fallbacks), under parle's deadlines (TTS 15 s, chat 12 s). */
export const DEFAULT_STAGE_BUDGET_MS = 8_000;

/** Stage budget: `GATEWAY_<STAGE>_BUDGET_MS` (STT, CHAT, TTS), default 8 s. */
export function stageBudgetMs(stage: 'stt' | 'chat' | 'tts', env: Record<string, string | undefined> = process.env): number {
  const n = Number(env[`GATEWAY_${stage.toUpperCase()}_BUDGET_MS`]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STAGE_BUDGET_MS;
}

/** True for failure codes that must not open a circuit or start a cooldown (see NEUTRAL_CODES). */
export function isNeutralFailure(code: string): boolean {
  return NEUTRAL_CODES.has(code);
}

const COOLDOWN_ALLOWED_FAILS = 3;
const COOLDOWN_MS = 15_000;

/**
 * Runs one attempt with its own timeout: on expiry the call is ABORTED (the signal reaches the provider's fetch, so
 * a replica lease is released at once) and the attempt fails with code `timeout`.
 */
async function attempt<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number | undefined, label: string, controller: AbortController): Promise<T> {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) return fn(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AttemptError(504, `${label} timed out after ${Math.round(timeoutMs)}ms`, 'timeout'));
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([fn(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterOf(err: unknown): number | undefined {
  const headers = (err as { headers?: Record<string, string> } | null)?.headers;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Calls `fn` on the targets in order until one succeeds. Throws `ProviderUnavailableError` (one reason per target)
 * when all fail, or the provider's own error when it is a client error (bad request).
 *
 * - Targets are tracked by position (two targets of the same provider stay apart).
 * - Each attempt has a timeout (target's own, else `timeoutMs`), capped by the stage budget, and is aborted on expiry.
 * - **Hedging:** a target with `hedgeAfterMs` that has not answered by then starts the next target in parallel; the
 *   first success wins and the other call is aborted. A slow or half-open (recovering) deployment therefore costs
 *   the client at most `hedgeAfterMs` before the fallback is on its way.
 * - Circuit breakers and cooldowns are fed by real failures only (`NEUTRAL_CODES` excluded).
 */
export function runTargets<P, T>(
  targets: Array<RouteTarget<P>>,
  fn: (target: RouteTarget<P>, signal: AbortSignal) => Promise<T>,
  opts: RunTargetsOptions,
): Promise<{ result: T; target: RouteTarget<P>; codes: FailureCodes }> {
  const breakers = opts.breakers ?? proxyCircuitBreakers;
  const cooldown = opts.cooldownTracker;
  const retries = opts.retriesPerProvider ?? 0;
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity;
  const entryOf = (t: RouteTarget<P>): FallbackEntry => ({ provider: t.providerId, model: t.model });
  const failures = new Map<number, string>();
  const codes: FailureCodes = new Map();
  const controllers = new Set<AbortController>();
  const inFlight = new Map<AbortController, RouteTarget<P>>();
  const ignoreCooldown = !!cooldown && targets.every((t) => cooldown.isCoolingDown(entryOf(t)));

  return new Promise((resolve, reject) => {
    let next = 0;
    let running = 0;
    let done = false;
    let retryAfterSec: number | undefined;

    const fail = (clientError?: unknown) => {
      if (done) return;
      done = true;
      for (const c of controllers) c.abort();
      if (clientError) { reject(clientError); return; }
      const reasons = targets.map((t, i) => failures.get(i) ?? `${t.providerId}: not tried (stage time budget used up)`);
      reject(new ProviderUnavailableError(reasons, retryAfterSec));
    };

    /** Starts the next eligible target; false when none is left. */
    const launchNext = (): boolean => {
      while (next < targets.length) {
        const i = next++;
        const t = targets[i];
        if (Date.now() >= deadline) { failures.set(i, `${t.providerId}: not tried (stage time budget used up)`); codes.set(t, 'timeout'); continue; }
        if (cooldown && !ignoreCooldown && cooldown.isCoolingDown(entryOf(t))) {
          failures.set(i, `${t.providerId}: cooling down after repeated failures`);
          codes.set(t, 'cooldown');
          continue;
        }
        if (!breakers.get(entryHealthKey({ provider: t.providerId })).allowRequest()) {
          failures.set(i, `${t.providerId}: circuit open after repeated failures (retrying in <30 s)`);
          codes.set(t, 'circuit_open');
          continue;
        }
        run(i, t, 0);
        return true;
      }
      return false;
    };

    const run = (i: number, t: RouteTarget<P>, retry: number) => {
      running++;
      const controller = new AbortController();
      controllers.add(controller);
      inFlight.set(controller, t);
      const breaker = breakers.get(entryHealthKey({ provider: t.providerId }));
      let successorLaunched = false;
      const hedge = t.hedgeAfterMs && i + 1 < targets.length
        ? setTimeout(() => { if (!done && !successorLaunched) { successorLaunched = true; launchNext(); } }, t.hedgeAfterMs)
        : null;
      const timeout = Math.min(t.timeoutMs ?? opts.timeoutMs ?? Infinity, deadline - Date.now());

      attempt((signal) => fn(t, signal), timeout, t.providerId, controller)
        .then((result) => {
          const invalid = opts.validate?.(result);
          if (invalid) throw new AttemptError(502, invalid, 'empty');
          return result;
        })
        .then((result) => {
          if (hedge) clearTimeout(hedge);
          running--;
          controllers.delete(controller);
          inFlight.delete(controller);
          if (done) return;
          done = true;
          // Targets still running lost a hedge race: they were slower than this one.
          for (const other of inFlight.values()) if (!codes.has(other)) codes.set(other, 'slow');
          breaker.recordSuccess();
          cooldown?.recordSuccess(entryOf(t));
          // The other in-flight call lost the race: abort it (releases its replica lease / upstream request).
          for (const c of controllers) c.abort();
          resolve({ result, target: t, codes });
        })
        .catch((err: unknown) => {
          if (hedge) clearTimeout(hedge);
          running--;
          controllers.delete(controller);
          inFlight.delete(controller);
          if (done) {
            // Aborted because another target won. A recovery probe that lost is a failed probe (keeps the circuit
            // open); otherwise a hedged loser says nothing about health.
            if (breaker.getStats().state === 'half_open') breaker.recordFailure();
            return;
          }
          const status = statusOf(err);
          if (isClientErrorStatus(status)) { fail(err); return; }
          const code = failureCode(err);
          if (NEUTRAL_CODES.has(code)) breaker.releaseProbe();
          else {
            breaker.recordFailure();
            if (cooldown && !ignoreCooldown) cooldown.recordFailure(entryOf(t), COOLDOWN_ALLOWED_FAILS, COOLDOWN_MS);
          }
          if (status === 429) retryAfterSec = retryAfterOf(err) ?? retryAfterSec;
          const retryable = status !== null && status >= 500 && !(err as { skipRetry?: boolean }).skipRetry;
          if (retryable && retry < retries && deadline - Date.now() > 300) {
            setTimeout(() => { if (!done) run(i, t, retry + 1); }, 200);
            return;
          }
          failures.set(i, describeFailure(t.providerId, err));
          codes.set(t, code);
          log.warn(`[proxy:${opts.stage}] ${describeFailure(t.providerId, err)}`);
          if (!successorLaunched) {
            successorLaunched = true;
            if (launchNext()) return;
          }
          if (running === 0 && !launchNext()) fail();
        });
    };

    if (!launchNext()) fail();
  });
}

/**
 * Full routing of one request: skip unconfigured / open-circuit targets, try the rest in order, and return the
 * result with its origin headers. Throws `ProviderUnavailableError` when nothing could serve it.
 */
export async function routeRequest<P extends Configurable, T>(
  candidates: Array<RouteTarget<P>>,
  fn: (target: RouteTarget<P>, signal: AbortSignal) => Promise<T>,
  opts: RunTargetsOptions & { notMounted?: string[] },
): Promise<{ result: T; target: RouteTarget<P>; headers: Record<string, string> }> {
  const { usable, skipped: skippedNow, codes: skippedCodes } = selectTargets(candidates, opts.breakers);
  // Entries that were never mounted (missing key, deployments off) are part of the explanation too.
  const skipped = [...skippedNow, ...(opts.notMounted ?? []).filter(r => !skippedNow.includes(r))];
  if (usable.length === 0) throw new ProviderUnavailableError(skipped);
  try {
    const { result, target, codes } = await runTargets(usable, fn, opts);
    return { result, target, headers: originHeaders(candidates, target, new Map([...skippedCodes, ...codes])) };
  } catch (err) {
    if (err instanceof ProviderUnavailableError) throw new ProviderUnavailableError([...err.reasons, ...skipped], err.retryAfterSec);
    throw err;
  }
}

/** 503 body for "no provider could serve this model". */
export function providerUnavailableResponse(stage: string, model: string, reasons: string[], retryAfterSec?: number): ProxyResponse {
  const detail = reasons.map((r) => redactSecrets(r));
  return {
    status: 503,
    ...(retryAfterSec ? { headers: { 'Retry-After': String(retryAfterSec) } } : {}),
    body: {
      error: {
        message: `No provider available for ${stage} model "${model}"${detail.length ? `: ${detail.join('; ')}` : ''}`,
        type: 'provider_unavailable',
        code: 'provider_unavailable',
        providers: detail,
      },
    },
  };
}

/** Maps any error from `runTargets` to a client response (503 provider_unavailable, or the provider's 4xx). */
export function errorResponse(err: unknown, stage: string, model: string): ProxyResponse {
  if (err instanceof ProviderUnavailableError) return providerUnavailableResponse(stage, model, err.reasons, err.retryAfterSec);
  const status = statusOf(err);
  if (isClientErrorStatus(status)) {
    const message = err instanceof Error ? redactSecrets(err.message).slice(0, 200) : 'Bad request';
    return { status: status!, body: { error: { message, type: 'invalid_request_error' } } };
  }
  return providerUnavailableResponse(stage, model, [describeFailure('gateway', err)]);
}
