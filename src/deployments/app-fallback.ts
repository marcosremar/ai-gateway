/**
 * Direct-fallback plan of an app — `GET /v1/apps/:app/fallback`.
 *
 * When the gateway itself is unreachable (crash, redeploy, edge failure), an app's server-side client calls the SAME
 * models directly on the cloud providers the gateway would have used as fallback. The gateway hands it what it needs:
 *
 *   { app, issuedAt, ttlSeconds,
 *     providers: { openrouter?: credential, groq?: credential },   // only providers with a key AND an entry below
 *     openrouter: credential | null,                               // = providers.openrouter (shortcut)
 *     routes: { stt: { alias: [{ provider, model, voice?, fixedVoice?, extraBody? }, …] }, chat: {…}, tts: {…} } }
 *
 * Routes come from the app's own aliases (`PUT /v1/apps/:app/routes`, AppAccount.routes): per alias, only the entries
 * of a direct-callable provider, in chain order. Deployments and the other providers are dropped (unreachable without
 * the gateway).
 *
 * Keys (owner decision 2026-10-06: the gateway keeps the provider keys and hands them to the app's client):
 *   - OPENROUTER_PROVISIONING_KEY set → a per-app OpenRouter key minted through OpenRouter's provisioning API
 *     (`POST /api/v1/keys`, `DELETE /api/v1/keys/:hash`), USD-limited (APP_FALLBACK_KEY_LIMIT_USD, default 5), rotated
 *     after APP_FALLBACK_KEY_ROTATE_DAYS (default 7). Only its hash is stored in the app account; the key itself lives
 *     in memory, so a restart mints a new one. Replaced keys keep working for a grace day, then are deleted.
 *   - otherwise the gateway's own OPENROUTER_API_KEY (and GROQ_API_KEY) are shared (`keyKind: 'shared'`), unless
 *     APP_FALLBACK_SHARE_KEY=0.
 *   - nothing configured → the provider is absent (`openrouter: null`): the client gets no direct fallback for it.
 * Keys are never logged and never appear in another response.
 */

import type { ModelRoutesSpec, RouteEntrySpec } from '../config/serve-providers';

export const FALLBACK_PROVIDER_URLS = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
} as const;
export type FallbackProviderId = keyof typeof FALLBACK_PROVIDER_URLS;
type Stage = 'stt' | 'chat' | 'tts';
const STAGES: Stage[] = ['stt', 'chat', 'tts'];
const SHARED_KEY_ENV: Record<FallbackProviderId, string> = { openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY' };

export interface FallbackCredential {
  baseUrl: string;
  apiKey: string;
  keyKind: 'provisioned' | 'shared';
  /** ISO time after which the key stops working (provisioned keys); null = no expiry. */
  expiresAt: string | null;
  limitUsd: number | null;
}

export interface FallbackEntry {
  provider: FallbackProviderId;
  model: string;
  voice?: string;
  fixedVoice?: boolean;
  extraBody?: Record<string, unknown>;
}

export type FallbackRoutes = Record<Stage, Record<string, FallbackEntry[]>>;

export interface FallbackPlan {
  app: string;
  issuedAt: string;
  ttlSeconds: number;
  providers: Partial<Record<FallbackProviderId, FallbackCredential>>;
  openrouter: FallbackCredential | null;
  routes: FallbackRoutes;
}

/** Per alias, the entries of `providers` only, in chain order (an entry without model calls the alias itself). */
export function fallbackRoutes(routes: ModelRoutesSpec | undefined, providers: ReadonlySet<string>): FallbackRoutes {
  const out: FallbackRoutes = { stt: {}, chat: {}, tts: {} };
  for (const stage of STAGES) {
    for (const [alias, chain] of Object.entries(routes?.[stage] ?? {})) {
      const entries = (chain as RouteEntrySpec[])
        .filter(e => providers.has(e.provider))
        .map((e): FallbackEntry => ({
          provider: e.provider as FallbackProviderId,
          model: e.model ?? alias,
          ...(e.voice ? { voice: e.voice } : {}),
          ...(e.fixedVoice ? { fixedVoice: true } : {}),
          ...(e.extraBody ? { extraBody: e.extraBody } : {}),
        }));
      if (entries.length) out[stage][alias] = entries;
    }
  }
  return out;
}

// ── Key provisioning ────────────────────────────────────────────────────────

export interface KeyProvisioner {
  /** False when no provisioning key is configured (read at call time: keys change at runtime). */
  available(): boolean;
  create(input: { name: string; limitUsd: number; expiresAt: string }): Promise<{ key: string; hash: string }>;
  /** Deletes a key; an already-deleted key (404) is not an error. */
  remove(hash: string): Promise<void>;
}

/**
 * OpenRouter's provisioning API (docs: openrouter.ai/docs/api-reference/api-keys/create-api-key, checked 2026-10-06):
 * `POST /api/v1/keys {name, limit, expires_at}` → `201 {key: "sk-or-v1-…", data: {hash, …}}`; `DELETE /api/v1/keys/:hash`.
 * Authorization: `Bearer <provisioning (management) key>`.
 */
export class OpenRouterKeyProvisioner implements KeyProvisioner {
  constructor(
    private readonly provisioningKey: () => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = FALLBACK_PROVIDER_URLS.openrouter,
  ) {}

  available(): boolean { return Boolean(this.provisioningKey()?.trim()); }

  private headers() { return { Authorization: `Bearer ${this.provisioningKey()?.trim() ?? ''}`, 'Content-Type': 'application/json' }; }

  async create(input: { name: string; limitUsd: number; expiresAt: string }): Promise<{ key: string; hash: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/keys`, {
      method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ name: input.name, limit: input.limitUsd, expires_at: input.expiresAt }),
    });
    // Never echo the body: on success it holds the new key.
    if (!res.ok) throw new Error(`OpenRouter key provisioning failed: HTTP ${res.status}`);
    const body = await res.json() as { key?: unknown; data?: { hash?: unknown } };
    if (typeof body.key !== 'string' || typeof body.data?.hash !== 'string') throw new Error('OpenRouter key provisioning: unexpected answer');
    return { key: body.key, hash: body.data.hash };
  }

  async remove(hash: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/keys/${encodeURIComponent(hash)}`, {
      method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`OpenRouter key deletion failed: HTTP ${res.status}`);
  }
}

/** What the app account keeps of its provisioned key: never the key itself. */
export interface ProvisionedKeyRecord {
  hash: string;
  createdAt: number;
  expiresAt: number;
  limitUsd: number;
  /** Replaced keys still alive for their grace period, deleted after `deleteAfter`. */
  retired?: Array<{ hash: string; deleteAfter: number }>;
}

export interface FallbackKeyStore {
  fallbackKey(app: string): ProvisionedKeyRecord | null;
  setFallbackKey(app: string, record: ProvisionedKeyRecord): Promise<void>;
}

export interface AppFallbackOptions {
  /** Read at call time (the KeyManager updates keys in place). */
  env: Record<string, string | undefined>;
  store: FallbackKeyStore;
  provisioner?: KeyProvisioner | null;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const DAY_MS = 24 * 3600_000;
const num = (raw: string | undefined, dflt: number) => {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export class AppFallbackService {
  /** Minted keys, memory only. */
  private readonly minted = new Map<string, { key: string; hash: string }>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly log: (msg: string, data?: Record<string, unknown>) => void;

  constructor(private readonly opts: AppFallbackOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  private get limitUsd() { return num(this.opts.env.APP_FALLBACK_KEY_LIMIT_USD, 5); }
  private get rotateMs() { return num(this.opts.env.APP_FALLBACK_KEY_ROTATE_DAYS, 7) * DAY_MS; }
  private get planTtlSeconds() { return Math.round(num(this.opts.env.APP_FALLBACK_PLAN_TTL_SECONDS, 3600)); }
  private get shareKeys() { return this.opts.env.APP_FALLBACK_SHARE_KEY?.trim() !== '0'; }

  async plan(app: string, routes: ModelRoutesSpec | undefined): Promise<FallbackPlan> {
    const wanted = fallbackRoutes(routes, new Set(Object.keys(FALLBACK_PROVIDER_URLS)));
    const used = new Set<FallbackProviderId>();
    for (const stage of STAGES) for (const chain of Object.values(wanted[stage])) for (const e of chain) used.add(e.provider);

    const providers: FallbackPlan['providers'] = {};
    for (const provider of used) {
      const credential = provider === 'openrouter' ? await this.openrouter(app) : this.shared(provider);
      if (credential) providers[provider] = credential;
    }
    let ttl = this.planTtlSeconds;
    const record = providers.openrouter?.keyKind === 'provisioned' ? this.opts.store.fallbackKey(app) : null;
    // Ask again before the key rotates (it keeps working for a grace day after that).
    if (record) ttl = Math.max(60, Math.min(ttl, Math.floor((record.createdAt + this.rotateMs - this.now()) / 1000)));
    this.log('app fallback plan', {
      app, providers: Object.fromEntries(Object.entries(providers).map(([p, c]) => [p, c!.keyKind])),
      aliases: STAGES.reduce((n, s) => n + Object.keys(wanted[s]).length, 0),
    });
    return {
      app, issuedAt: new Date(this.now()).toISOString(), ttlSeconds: ttl, providers,
      openrouter: providers.openrouter ?? null,
      routes: fallbackRoutes(routes, new Set(Object.keys(providers))),
    };
  }

  private shared(provider: FallbackProviderId): FallbackCredential | null {
    const key = this.opts.env[SHARED_KEY_ENV[provider]]?.trim();
    if (!key || !this.shareKeys) return null;
    return { baseUrl: FALLBACK_PROVIDER_URLS[provider], apiKey: key, keyKind: 'shared', expiresAt: null, limitUsd: null };
  }

  private async openrouter(app: string): Promise<FallbackCredential | null> {
    const provisioner = this.opts.provisioner;
    if (provisioner?.available()) {
      try {
        return await this.serialized(app, () => this.provisioned(app, provisioner));
      } catch (err) {
        // The message carries an HTTP status only (OpenRouterKeyProvisioner never echoes a body).
        this.log('app fallback: key provisioning failed, using the shared key if allowed', { app, error: String((err as Error).message ?? err).slice(0, 200) });
      }
    }
    return this.shared('openrouter');
  }

  private async serialized<T>(app: string, run: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(app) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    this.locks.set(app, next);
    try { return await next; } finally { if (this.locks.get(app) === next) this.locks.delete(app); }
  }

  private async provisioned(app: string, provisioner: KeyProvisioner): Promise<FallbackCredential> {
    const now = this.now();
    let record = this.opts.store.fallbackKey(app);
    let held = this.minted.get(app);
    const fresh = record && held && held.hash === record.hash && now < record.createdAt + this.rotateMs;
    if (!fresh) {
      const limitUsd = this.limitUsd;
      const expiresAt = now + this.rotateMs + DAY_MS;
      const created = await provisioner.create({ name: `aigw-${app}`, limitUsd, expiresAt: new Date(expiresAt).toISOString() });
      const retired = [...(record?.retired ?? []), ...(record ? [{ hash: record.hash, deleteAfter: now + DAY_MS }] : [])];
      record = { hash: created.hash, createdAt: now, expiresAt, limitUsd, ...(retired.length ? { retired } : {}) };
      held = created;
      this.minted.set(app, created);
      await this.opts.store.setFallbackKey(app, record);
      this.log('app fallback: minted a provisioned OpenRouter key', { app, hash: created.hash.slice(0, 8), limitUsd });
    }
    await this.sweep(app, record!, provisioner);
    return {
      baseUrl: FALLBACK_PROVIDER_URLS.openrouter, apiKey: held!.key, keyKind: 'provisioned',
      expiresAt: new Date(record!.expiresAt).toISOString(), limitUsd: record!.limitUsd,
    };
  }

  /** Deletes replaced keys whose grace period is over (a failed delete is retried on the next plan). */
  private async sweep(app: string, record: ProvisionedKeyRecord, provisioner: KeyProvisioner): Promise<void> {
    const due = (record.retired ?? []).filter(r => r.deleteAfter <= this.now());
    if (!due.length) return;
    const gone = new Set<string>();
    for (const r of due) {
      try { await provisioner.remove(r.hash); gone.add(r.hash); } catch (err) {
        this.log('app fallback: could not delete a replaced key', { app, hash: r.hash.slice(0, 8), error: String((err as Error).message).slice(0, 200) });
      }
    }
    if (!gone.size) return;
    const retired = (record.retired ?? []).filter(r => !gone.has(r.hash));
    const { retired: _old, ...rest } = record;
    await this.opts.store.setFallbackKey(app, { ...rest, ...(retired.length ? { retired } : {}) });
  }
}
