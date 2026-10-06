/**
 * Account-policy guard — a target the provider account is not allowed to use (OpenRouter with Zero Data Retention on:
 * a model without a ZDR endpoint answers 404 "No endpoints found matching your data policy" / "ZDR violation") is
 * taken out of its chain for `ACCOUNT_POLICY_BLOCK_MS` after the first refusal, instead of being tried (and failing)
 * on every request. While blocked, `selectTargets` skips it with code `policy` before any call, so the next target
 * starts at once and the stage budget is not spent on it; `/health` shows the reason.
 *
 * The refusal is not a provider-health failure (code `policy`, neutral in `runTargets`): it must not open the circuit
 * breaker that every model of the same provider shares (OpenRouter Kokoro is the next target of the same chain).
 * The block is lifted by time (the account setting may change) and by a key change (`resetProvider`).
 */

import type { TTSProvider, TTSRequest, TTSResponse } from '../providers/cloud/types';

/** 30 min: the account setting changes rarely; one probe per half hour costs one fast 404. */
export const ACCOUNT_POLICY_BLOCK_MS = 30 * 60_000;

const POLICY_REFUSAL = /\bZDR\b|zero[ -]data[ -]retention|data policy/i;

/** True when `err` is the provider refusing the model because of the account's privacy / data policy. */
export function isAccountPolicyRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const body = (err as { error?: unknown } | null)?.error;
  return POLICY_REFUSAL.test(message) || (body !== undefined && POLICY_REFUSAL.test(JSON.stringify(body)));
}

class AccountPolicyError extends Error {
  readonly status = 503;
  readonly gatewayCode = 'policy';
  readonly skipRetry = true;
}

export class AccountPolicyGuard {
  private blockedUntil = 0;
  private reasonText: string | null = null;

  constructor(readonly label: string, private readonly now: () => number = Date.now, private readonly blockMs = ACCOUNT_POLICY_BLOCK_MS) {}

  /** Reason while blocked, null otherwise (`RouteTarget.unavailableNow`). */
  reason(): string | null {
    if (!this.reasonText) return null;
    if (this.now() >= this.blockedUntil) { this.reasonText = null; return null; }
    return this.reasonText;
  }

  blockedUntilIso(): string | null {
    return this.reason() ? new Date(this.blockedUntil).toISOString() : null;
  }

  /** Records a refusal (if `err` is one) and returns the error the chain should see. */
  observe(err: unknown): unknown {
    if (!isAccountPolicyRefusal(err)) return err;
    this.blockedUntil = this.now() + this.blockMs;
    this.reasonText = `${this.label}: refused by the provider account's data policy (ZDR) — skipped until `
      + `${new Date(this.blockedUntil).toISOString()}`;
    return new AccountPolicyError(this.reasonText);
  }

  reset(): void {
    this.blockedUntil = 0;
    this.reasonText = null;
  }

  /** A TTS provider whose refusals feed this guard. Everything else is delegated untouched. */
  wrapTTS(inner: TTSProvider): TTSProvider {
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); } catch (err) { throw this.observe(err); }
    };
    return {
      providerId: inner.providerId,
      getModels: () => inner.getModels(),
      getVoices: () => inner.getVoices(),
      isConfigured: () => inner.isConfigured(),
      synthesize: (request: TTSRequest): Promise<TTSResponse> => call(() => inner.synthesize(request)),
      synthesizeStream: (request: TTSRequest) => call(() => inner.synthesizeStream(request)),
    };
  }
}

/** Guards by `<provider>:<model>`, shared across provider remounts (a key reload must not forget a refusal). */
export class AccountPolicyGuards {
  private readonly guards = new Map<string, AccountPolicyGuard>();
  constructor(private readonly now: () => number = Date.now) {}

  get(provider: string, model: string): AccountPolicyGuard {
    const label = `${provider}:${model}`;
    let guard = this.guards.get(label);
    if (!guard) { guard = new AccountPolicyGuard(label, this.now); this.guards.set(label, guard); }
    return guard;
  }

  /** Lifts every block of `provider` (its key changed: the new account may allow the model). */
  resetProvider(provider: string): void {
    for (const [label, guard] of this.guards) if (label.startsWith(`${provider}:`)) guard.reset();
  }
}

export const accountPolicyGuards = new AccountPolicyGuards();
