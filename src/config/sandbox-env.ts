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
 * HOSTNAME, RAILWAY_* and infra URLs (*_URL); DEPLOYMENTS_NAMESPACE / DEPLOYMENTS_STATE_DIR / DEPLOYMENTS_ENABLED are
 * never taken from the palco at all. So rotating a key on the palco is enough; a stale Railway variable
 * cannot shadow it. Keys are re-read periodically and on demand by `KeyManager` (src/config/key-manager.ts).
 *
 * The same token is also accepted as a Bearer by the gateway itself (see `serve.ts`), so agents call it with the
 * credential they already carry.
 */

/** Aliases that carry the same secret on Railway / Cloud Agent (kept in sync with parle `principalSandboxToken`). */
const TOKEN_ALIASES = ['SANDBOX_TOKEN', 'PALCO_PROXY_TOKEN', 'PALCO_PROXY', 'VMOS_PROXY_TOKEN', 'VMOS_PROXY', 'PROXY_TOKEN'] as const;

/** Keys the palco never overrides (they configure the host itself, not a provider). */
const ENV_PINNED = new Set<string>([...TOKEN_ALIASES, 'PORT', 'NODE_ENV', 'GATEWAY_API_KEYS', 'HOSTNAME', 'SANDBOX_ENV_URL']);

/**
 * Keys the palco never provides at all, even when the host lacks them: they decide WHICH machines this gateway owns.
 * A local gateway that got the real SCW_SECRET_KEY from the palco plus the production namespace would release the
 * production replicas as orphans (controller reconcile) — the namespace must come from the host only.
 */
const HOST_ONLY = new Set<string>(['DEPLOYMENTS_NAMESPACE', 'DEPLOYMENTS_STATE_DIR', 'DEPLOYMENTS_ENABLED']);

export function isHostOnly(name: string): boolean {
  // RAILWAY_* tells the gateway it runs on Railway (see deploymentsFromEnv): never inherited from the palco.
  return HOST_ONLY.has(name) || name.startsWith('RAILWAY_');
}

export function isEnvPinned(name: string): boolean {
  return ENV_PINNED.has(name) || HOST_ONLY.has(name) || name.startsWith('RAILWAY_') || name.endsWith('_URL');
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
        // Pinned keys stay with the host when it has them; everything else follows the palco.
        if (isHostOnly(key) || (isEnvPinned(key) && env[key]?.trim())) continue;
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
