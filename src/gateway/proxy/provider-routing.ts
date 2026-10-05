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
import { isTimeoutError, withProviderFallback, type CooldownTracker, type FallbackEntry } from '../providers/cloud/fallback';
import { entryHealthKey } from '../providers/cloud/entry-key';
import type { ProxyResponse } from './types';

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
 * not_found | not_configured | circuit_open | cooldown | error) and which one that was (`X-Gateway-Fallback-From`).
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
  timeoutMs?: number;
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
 * Runs one attempt with its own timeout: on expiry the call is ABORTED (the signal reaches the provider's fetch, so
 * a replica lease is released at once) and the attempt fails with code `timeout`.
 */
async function attempt<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number | undefined, label: string): Promise<T> {
  const controller = new AbortController();
  if (!timeoutMs) return fn(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AttemptError(504, `${label} timed out after ${timeoutMs}ms`, 'timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls `fn` on each target in order until one succeeds. Throws `ProviderUnavailableError` (one reason per
 * provider tried) when all fail, or the provider's own error when it is a client error (bad request).
 * Targets are tracked by position, so two targets of the same provider (e.g. OpenRouter with two models) stay apart.
 */
export async function runTargets<P, T>(
  targets: Array<RouteTarget<P>>,
  fn: (target: RouteTarget<P>, signal: AbortSignal) => Promise<T>,
  opts: RunTargetsOptions,
): Promise<{ result: T; target: RouteTarget<P>; codes: FailureCodes }> {
  const entries: FallbackEntry[] = targets.map((t) => ({ provider: t.providerId, model: t.model }));
  const indexOf = new Map(entries.map((e, i) => [e, i]));
  const failures = new Map<number, string>();
  const codes: FailureCodes = new Map();
  let winner = -1;
  try {
    const { result } = await withProviderFallback(
      entries,
      async (entry) => {
        const i = indexOf.get(entry)!;
        const target = targets[i];
        try {
          const result = await attempt((signal) => fn(target, signal), target.timeoutMs ?? opts.timeoutMs, target.providerId);
          const invalid = opts.validate?.(result);
          if (invalid) throw new AttemptError(502, invalid, 'empty');
          winner = i;
          return result;
        } catch (err) {
          failures.set(i, describeFailure(target.providerId, err));
          codes.set(target, failureCode(err));
          throw err;
        }
      },
      {
        logPrefix: `[proxy:${opts.stage}]`,
        retriesPerProvider: opts.retriesPerProvider ?? 0,
        retryBaseDelayMs: 200,
        ...(opts.cooldownTracker ? { cooldownTracker: opts.cooldownTracker } : {}),
        circuitBreakers: opts.breakers ?? proxyCircuitBreakers,
      },
    );
    return { result, target: targets[winner], codes };
  } catch (err) {
    if (isClientErrorStatus(statusOf(err))) throw err;
    const reasons = targets.map((t, i) => failures.get(i) ?? `${t.providerId}: skipped (cooling down or circuit open)`);
    if (failures.size === 0 && err instanceof Error && !/fallback chain/.test(err.message)) {
      reasons.push(describeFailure('gateway', err));
    }
    throw new ProviderUnavailableError(reasons, (err as { retryAfterSec?: number })?.retryAfterSec);
  }
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
