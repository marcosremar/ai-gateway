/**
 * One principal token (`SANDBOX_TOKEN`) instead of one secret per provider — the same scheme the parle repo uses.
 *
 *   SANDBOX_TOKEN → GET <hub>/api/sandbox-env (Bearer) → { SCW_SECRET_KEY, SCW_PROJECT_ID, OPENROUTER_API_KEY, … }
 *
 * The palco (dev API) is the single home of the keys: the gateway only needs the token in its environment and gets
 * whatever keys the palco catalog holds (which keys it returns is decided on the palco side — check its catalog
 * rather than assuming a given provider key is there).
 *
 * Priority: the palco value WINS over the process environment (Railway variables) for every key except the few
 * that must stay with the host — `isEnvPinned`: the token and its aliases, PORT, NODE_ENV, GATEWAY_API_KEYS,
 * HOSTNAME and RAILWAY_*; none of them can be written through `PUT /v1/admin/keys` either. DEPLOYMENTS_NAMESPACE /
 * DEPLOYMENTS_STATE_DIR / DEPLOYMENTS_ENABLED and every endpoint override (`isEndpointOverride`: *_URL, *_BASE,
 * *_HOST, *_ENDPOINT) are never taken from the palco at all. So rotating a key on the palco is enough; a stale Railway variable
 * cannot shadow it. Keys are re-read periodically and on demand by `KeyManager` (src/config/key-manager.ts).
 *
 * The same token is also accepted as a Bearer by the gateway itself (see `serve.ts`), so agents call it with the
 * credential they already carry.
 */

/** Aliases that carry the same secret on Railway / Cloud Agent (kept in sync with parle `principalSandboxToken`). */
export const TOKEN_ALIASES = ['SANDBOX_TOKEN', 'PALCO_PROXY_TOKEN', 'PALCO_PROXY', 'VMOS_PROXY_TOKEN', 'VMOS_PROXY', 'PROXY_TOKEN'] as const;

/** Keys the palco never overrides (they configure the host itself, not a provider). */
const ENV_PINNED = new Set<string>([...TOKEN_ALIASES, 'PORT', 'NODE_ENV', 'GATEWAY_API_KEYS', 'HOSTNAME', 'SANDBOX_ENV_URL']);

/**
 * Keys the palco never provides at all, even when the host lacks them: they decide WHICH machines this gateway owns.
 * A local gateway that got the real SCW_SECRET_KEY from the palco plus the production namespace would release the
 * production replicas as orphans (controller reconcile) — the namespace must come from the host only.
 */
const HOST_ONLY = new Set<string>([
  'DEPLOYMENTS_NAMESPACE', 'DEPLOYMENTS_STATE_DIR', 'DEPLOYMENTS_ENABLED', 'ACCEPT_SANDBOX_TOKEN_AS_KEY', 'SANDBOX_TOKEN_ADMIN', 'SANDBOX_TOKEN_APP',
]);

/**
 * Names that point the gateway at a host: `OPENROUTER_API_BASE`, `GROQ_API_BASE`, `WHISPER_SERVER_BASE_URL`,
 * `GATEWAY_HOST`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `SANDBOX_ENV_URL`… A remote value there redirects traffic (with the
 * students' audio and text, and the provider key in the Authorization header) to whatever host it names — QA
 * 06/10/2026: an admin key could write `OPENROUTER_API_BASE` through `PUT /v1/admin/keys` (only `_URL` was protected)
 * and every speech call would go there after the next restart.
 */
export function isEndpointOverride(name: string): boolean {
  return /(^|_)(URL|BASE|HOST|HOSTNAME|ENDPOINT)$/.test(name);
}

/** Provider API bases: code defaults are the real provider; only the host (Railway) may change them. */
function isProviderBase(name: string): boolean {
  return /(^|_)BASE(_URL)?$/.test(name);
}

export function isHostOnly(name: string): boolean {
  // RAILWAY_* tells the gateway it runs on Railway (see deploymentsFromEnv): never inherited from the palco.
  return HOST_ONLY.has(name) || name.startsWith('RAILWAY_') || isProviderBase(name);
}

export function isEnvPinned(name: string): boolean {
  return ENV_PINNED.has(name) || isHostOnly(name) || isEndpointOverride(name);
}

export const DEFAULT_SANDBOX_ENV_URLS = [
  'https://parle-palco.up.railway.app/api/sandbox-env',
  'https://ucast.me/api/sandbox-env',
];

export function principalSandboxToken(env: Record<string, string | undefined>): string {
  for (const key of TOKEN_ALIASES) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return '';
}

/** User id of the SANDBOX_TOKEN when `ACCEPT_SANDBOX_TOKEN_AS_KEY=1` (transition only). */
export const SANDBOX_USER = 'sandbox';

/**
 * The gateway's client keys: `GATEWAY_API_KEYS` ("key:user", comma-separated). The SANDBOX_TOKEN (and its aliases)
 * is the dev API's master key — the gateway uses it only to FETCH its own provider keys from the palco — and is NOT a
 * client key nor an admin (owner decision 06/10/2026). `ACCEPT_SANDBOX_TOKEN_AS_KEY=1` accepts it as user `sandbox`
 * for the transition: a client like any other (never an admin, no-wake). Only two roles exist (owner, 10/10/2026):
 * admin manages, a client calls the APIs; a developer is a client.
 */
export function gatewayClientKeys(env: Record<string, string | undefined>): { keys: string[]; warnings: string[] } {
  const keys = (env.GATEWAY_API_KEYS ?? '').split(',').map(k => k.trim()).filter(Boolean);
  const warnings: string[] = env.SANDBOX_TOKEN_ADMIN?.trim()
    ? ['SANDBOX_TOKEN_ADMIN is no longer read: the dev token is a client, never an admin — remove the variable']
    : [];
  const token = principalSandboxToken(env);
  if (env.ACCEPT_SANDBOX_TOKEN_AS_KEY?.trim() !== '1' || !token) return { keys, warnings };
  if (/[,:]/.test(token)) {
    warnings.push('SANDBOX_TOKEN contains , or : — not accepted as an API key');
    return { keys, warnings };
  }
  warnings.push('ACCEPT_SANDBOX_TOKEN_AS_KEY=1: the SANDBOX_TOKEN is accepted as a no-wake client key '
    + '(transition only — give the client its own GATEWAY_API_KEYS entry and remove the flag)');
  return { keys: [...keys, `${token}:${SANDBOX_USER}`], warnings };
}

export function sandboxEnvUrls(env: Record<string, string | undefined>): string[] {
  const custom = env.SANDBOX_ENV_URL?.trim();
  return custom ? [custom] : DEFAULT_SANDBOX_ENV_URLS;
}

export interface SandboxEnvResult {
  /** URL that answered, or null when none did / no token. */
  source: string | null;
  /** Keys written into env (missing before, or with a different value). Values are never logged. */
  applied: string[];
  /** Every key the palco returned (written or already up to date), pinned ones excluded. */
  received: string[];
  errors: string[];
}

/**
 * Writes the palco keys into `env` (palco wins, except `isEnvPinned` keys). Never throws: a gateway without the dev API still boots with
 * whatever its own environment has.
 */
export async function loadSandboxEnv(
  env: Record<string, string | undefined>,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SandboxEnvResult> {
  const token = principalSandboxToken(env);
  const result: SandboxEnvResult = { source: null, applied: [], received: [], errors: [] };
  if (!token) return result;
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (const url of sandboxEnvUrls(env)) {
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      if (!res.ok) { result.errors.push(`${url}: HTTP ${res.status}`); continue; }
      const payload = await res.json() as Record<string, unknown>;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { result.errors.push(`${url}: not an object`); continue; }
      for (const [key, value] of Object.entries(payload)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || !value.trim()) continue;
        if (isHostOnly(key) || isEndpointOverride(key)) continue;
        if (isEnvPinned(key) && env[key]?.trim() && env[key] !== value.trim()) continue;
        result.received.push(key);
        if (env[key] === value.trim()) continue;
        env[key] = value.trim();
        result.applied.push(key);
      }
      result.source = url;
      return result;
    } catch (err) {
      result.errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
