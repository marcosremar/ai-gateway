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
 *     429 with Retry-After until 00:00 UTC, `code: daily_budget_exhausted`, which `budget` and `reset_at`. The gateway
 *     has no per-model price table for every route, so the budget is in requests and tokens, not currency. `0` turns
 *     a budget off. Both limits are gateway-wide settings applied to each app (no per-app value). `budgets()` shows
 *     each app's use, rate and projected exhaustion; `onBudgetEvent` fires once per UTC day at 80 % and at exhaustion.
 */

export type InferenceKind = 'chat' | 'stt' | 'tts' | 'embeddings' | 'images';
type Stage = 'chat' | 'stt' | 'tts';

export interface AppLimitsOptions {
  env: Record<string, string | undefined>;
  isAdmin: (userId: string) => boolean;
  /** The app's own aliases for a stage; empty/null when the user is no app (then nothing is allowed). */
  aliasesOf: (userId: string, stage: Stage) => ReadonlySet<string> | null;
  now?: () => number;
  onBudgetEvent?: (event: AppBudgetEvent) => void;
}

type Budget = 'requests' | 'tokens';
const BUDGETS: readonly Budget[] = ['requests', 'tokens'];

export interface AppLimitDenial {
  status: number;
  type: string;
  message: string;
  retryAfterSeconds?: number;
  code?: 'daily_budget_exhausted';
  budget?: Budget;
  resetAt?: string;
}

export interface AppBudgetEvent {
  event: 'app.budget_warning' | 'app.budget_exhausted';
  app: string;
  budget: Budget;
  used: number;
  limit: number;
  resetAt: string;
}

interface BudgetUse { used: number; limit: number; perMinute: number; exhaustedAt: string | null }
export interface AppBudgetView { app: string; resetAt: string; requests: BudgetUse; tokens: BudgetUse }

type Counts = Record<Budget, number>;
interface Usage extends Counts { day: number; chargedAt: number; marks: [Counts & { at: number }, Counts & { at: number }]; flagged: Set<string> }

export const BUDGET_WARNING_RATIO = 0.8;
const RATE_WINDOW_MS = 5 * 60_000;

export function denialError(d: AppLimitDenial): Record<string, unknown> {
  return { message: d.message, type: d.type, ...(d.code ? { code: d.code, budget: d.budget, reset_at: d.resetAt } : {}) };
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
  private readonly usage = new Map<string, Usage>();

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

  /**
   * Charges `requests` to the app's daily request budget without a model check — a realtime session (src/realtime/:
   * `perMinute × ⌈ttl/60⌉` requests at admission, since its audio never crosses the gateway as requests). Admins free.
   */
  chargeRequests(userId: string, requests: number): AppLimitDenial | null {
    if (this.opts.isAdmin(userId)) return null;
    return this.charge(userId, 0, Math.max(1, Math.floor(requests)));
  }

  private get limits(): Counts { return { requests: this.dailyRequests, tokens: this.dailyTokens }; }

  private charge(userId: string, tokens: number, requests = 1): AppLimitDenial | null {
    const now = this.now();
    const day = Math.floor(now / DAY_MS);
    let u = this.usage.get(userId);
    if (!u || u.day !== day) {
      const mark = { at: now, requests: 0, tokens: 0 };
      u = { day, chargedAt: now, requests: 0, tokens: 0, marks: [mark, mark], flagged: new Set() };
      this.usage.set(userId, u);
    }
    const limits = this.limits;
    const add: Counts = { requests, tokens };
    const resetAt = new Date((day + 1) * DAY_MS).toISOString();
    const over = BUDGETS.find(b => limits[b] > 0 && u[b] + add[b] > limits[b]);
    if (over) {
      this.flag(userId, u, 'app.budget_exhausted', over, limits[over], resetAt);
      return {
        status: 429, type: 'budget_exceeded', code: 'daily_budget_exhausted', budget: over, resetAt,
        message: `daily budget of app '${userId}' exhausted (${limits[over]} ${over} per UTC day); it resets at 00:00 UTC`,
        retryAfterSeconds: Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000)),
      };
    }
    if (now - u.marks[1].at >= RATE_WINDOW_MS) u.marks = [u.marks[1], { at: now, requests: u.requests, tokens: u.tokens }];
    u.chargedAt = now;
    u.requests += requests;
    u.tokens += tokens;
    for (const b of BUDGETS) {
      if (limits[b] > 0 && u[b] >= limits[b] * BUDGET_WARNING_RATIO) this.flag(userId, u, 'app.budget_warning', b, limits[b], resetAt);
    }
    return null;
  }

  private flag(app: string, u: Usage, event: AppBudgetEvent['event'], budget: Budget, limit: number, resetAt: string): void {
    const key = `${event}:${budget}`;
    if (u.flagged.has(key)) return;
    u.flagged.add(key);
    this.opts.onBudgetEvent?.({ event, app, budget, used: u[budget], limit, resetAt });
  }

  budgets(userId?: string): AppBudgetView[] {
    const now = this.now();
    const day = Math.floor(now / DAY_MS);
    const reset = (day + 1) * DAY_MS;
    const limits = this.limits;
    return [...this.usage].filter(([app, u]) => u.day === day && (userId === undefined || app === userId)).map(([app, u]) => {
      const [from] = u.marks;
      const minutes = (now - from.at) / 60_000;
      const use = (b: Budget): BudgetUse => {
        const perMinute = minutes >= 1 && now - u.chargedAt < RATE_WINDOW_MS ? (u[b] - from[b]) / minutes : 0;
        const at = perMinute > 0 ? now + ((limits[b] - u[b]) / perMinute) * 60_000 : Infinity;
        return {
          used: u[b], limit: limits[b], perMinute: Math.round(perMinute * 10) / 10,
          exhaustedAt: limits[b] > 0 && at < reset ? new Date(at).toISOString() : null,
        };
      };
      return { app, resetAt: new Date(reset).toISOString(), requests: use('requests'), tokens: use('tokens') };
    });
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
