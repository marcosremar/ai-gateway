/**
 * Per-app limits on inference requests — what a LEAKED app key can spend (security test 06/10/2026: any key could call
 * any of ~480 OpenRouter models by `org/model` passthrough, with `max_tokens` up to 128 000, 150 parallel streams and
 * no daily cap; the remaining OpenRouter credit would go in minutes and the students' fallback with it).
 *
 * For a non-admin key (admins — DEPLOYMENTS_ADMIN_USERS — are never limited):
 *   - **models**: only the aliases of its own app (`PUT /v1/apps/:app/routes`, the key's userId is the app id), per
 *     stage. No `org/model` passthrough, no gateway-wide model, no embeddings or images → 403.
 *   - **max_tokens** (chat): clamped to APP_MAX_TOKENS (default 1024); a request without one gets the cap.
 *   - **daily budget** per app, UTC day, in memory (a restart starts a new count): APP_DAILY_REQUESTS (default 5000)
 *     requests and APP_DAILY_TOKENS (default 2 000 000) estimated tokens — charged at admission as the prompt
 *     (characters / 4) plus the clamped max_tokens for chat, the input text (characters / 4) for TTS. Over budget →
 *     429 with Retry-After until 00:00 UTC. The gateway has no per-model price table for every route, so the budget
 *     is in requests and tokens, not currency. `0` turns a budget off.
 */

export type InferenceKind = 'chat' | 'stt' | 'tts' | 'embeddings' | 'images';
type Stage = 'chat' | 'stt' | 'tts';

export interface AppLimitsOptions {
  env: Record<string, string | undefined>;
  isAdmin: (userId: string) => boolean;
  /** The app's own aliases for a stage; empty/null when the user is no app (then nothing is allowed). */
  aliasesOf: (userId: string, stage: Stage) => ReadonlySet<string> | null;
  now?: () => number;
}

export interface AppLimitDenial {
  status: number;
  type: string;
  message: string;
  retryAfterSeconds?: number;
}

export const APP_LIMIT_DEFAULTS = { maxTokens: 1024, dailyRequests: 5000, dailyTokens: 2_000_000 } as const;

const DAY_MS = 86_400_000;

function intEnv(raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export class AppLimits {
  private readonly now: () => number;
  private readonly usage = new Map<string, { day: number; requests: number; tokens: number }>();

  constructor(private readonly opts: AppLimitsOptions) {
    this.now = opts.now ?? Date.now;
  }

  get maxTokens(): number { return intEnv(this.opts.env.APP_MAX_TOKENS, APP_LIMIT_DEFAULTS.maxTokens) || APP_LIMIT_DEFAULTS.maxTokens; }
  private get dailyRequests(): number { return intEnv(this.opts.env.APP_DAILY_REQUESTS, APP_LIMIT_DEFAULTS.dailyRequests); }
  private get dailyTokens(): number { return intEnv(this.opts.env.APP_DAILY_TOKENS, APP_LIMIT_DEFAULTS.dailyTokens); }

  /**
   * Admission of one inference request. Returns a denial, or null after clamping `body.max_tokens` (chat) and charging
   * the app's daily budget. `body` is the parsed JSON (or the multipart text fields).
   */
  check(userId: string, kind: InferenceKind, body: Record<string, unknown>, opts: { charge?: boolean } = {}): AppLimitDenial | null {
    if (this.opts.isAdmin(userId)) return null;
    if (kind !== 'chat' && kind !== 'stt' && kind !== 'tts') {
      return { status: 403, type: 'permission_error', message: `this API key cannot use ${kind}: only its app's own model aliases` };
    }
    const model = typeof body.model === 'string' ? body.model : '';
    const aliases = this.opts.aliasesOf(userId, kind);
    if (!model || !aliases?.has(model)) {
      const known = aliases?.size ? `: ${[...aliases].sort().join(', ')}` : ' (the app has no routes for this stage)';
      return {
        status: 403, type: 'permission_error',
        message: `model '${model || '(none)'}' is not an alias of app '${userId}' — an app key may only call its own ${kind} aliases${known}`,
      };
    }
    let tokens = 0;
    if (kind === 'chat') {
      body.max_tokens = this.clampMaxTokens(body.max_tokens);
      tokens = estimateTokens(JSON.stringify(body.messages ?? '')) + (body.max_tokens as number);
    } else if (kind === 'tts') {
      tokens = estimateTokens(typeof body.input === 'string' ? body.input : '');
    }
    // `charge: false` = a stage of a turn already charged as a whole (an s2s loopback stage): limits, no second charge.
    return opts.charge === false ? null : this.charge(userId, tokens);
  }

  /**
   * Admission of one `POST /v1/s2s` turn (API audit 2026-10-07: the primary path called the speech-stack replica with
   * no limit at all). Every stage model the turn names must be an alias of the app; `max_tokens` is clamped (the
   * caller re-sends the clamped config to the replica); the turn is charged once — one request, prompt + max_tokens —
   * and its composed-fallback stages are not charged again (`check(..., { charge: false })`).
   */
  checkS2S(userId: string, config: { max_tokens?: unknown; system?: unknown; messages?: unknown; user_template?: unknown;
    models?: { stt?: unknown; chat?: unknown; tts?: unknown } }): AppLimitDenial | null {
    if (this.opts.isAdmin(userId)) return null;
    for (const stage of ['stt', 'chat', 'tts'] as const) {
      const model = config.models?.[stage];
      if (model === undefined || model === null || model === '') continue;
      const aliases = this.opts.aliasesOf(userId, stage);
      if (typeof model !== 'string' || !aliases?.has(model)) {
        return {
          status: 403, type: 'permission_error',
          message: `config.models.${stage} '${String(model)}' is not an alias of app '${userId}' — an app key may only use its own aliases`,
        };
      }
    }
    config.max_tokens = this.clampMaxTokens(config.max_tokens);
    const prompt = JSON.stringify([config.system ?? '', config.messages ?? '', config.user_template ?? '']);
    return this.charge(userId, estimateTokens(prompt) + (config.max_tokens as number));
  }

  private clampMaxTokens(asked: unknown): number {
    const cap = this.maxTokens;
    return Math.min(typeof asked === 'number' && Number.isFinite(asked) ? asked : cap, cap);
  }

  private charge(userId: string, tokens: number): AppLimitDenial | null {
    const now = this.now();
    const day = Math.floor(now / DAY_MS);
    let u = this.usage.get(userId);
    if (!u || u.day !== day) {
      u = { day, requests: 0, tokens: 0 };
      this.usage.set(userId, u);
    }
    const maxRequests = this.dailyRequests;
    const maxTokens = this.dailyTokens;
    const over = (maxRequests > 0 && u.requests + 1 > maxRequests) ? `${maxRequests} requests`
      : (maxTokens > 0 && u.tokens + tokens > maxTokens) ? `${maxTokens} tokens` : null;
    if (over) {
      return {
        status: 429, type: 'budget_exceeded',
        message: `daily budget of app '${userId}' exhausted (${over} per UTC day); it resets at 00:00 UTC`,
        retryAfterSeconds: Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000)),
      };
    }
    u.requests += 1;
    u.tokens += tokens;
    return null;
  }

  /** Today's usage of an app (tests, diagnostics). */
  usageOf(userId: string): { requests: number; tokens: number } {
    const u = this.usage.get(userId);
    return u && u.day === Math.floor(this.now() / DAY_MS) ? { requests: u.requests, tokens: u.tokens } : { requests: 0, tokens: 0 };
  }
}

/** The inference endpoint a POST path is, or null. */
export function inferenceKindOf(method: string, url: string): InferenceKind | null {
  if (method !== 'POST') return null;
  switch (url) {
    case '/v1/chat/completions': return 'chat';
    case '/v1/audio/transcriptions': return 'stt';
    case '/v1/audio/speech': return 'tts';
    case '/v1/embeddings': return 'embeddings';
    case '/v1/images/generate': case '/v1/images/inpaint': return 'images';
    default: return null;
  }
}
