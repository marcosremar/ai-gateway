/**
 * One principal token (`SANDBOX_TOKEN`) instead of one secret per provider — the same scheme the parle repo uses.
 *
 *   SANDBOX_TOKEN → GET <hub>/api/sandbox-env (Bearer) → { SCW_SECRET_KEY, SCW_PROJECT_ID, GROQ_API_KEY, … }
 *
 * The gateway only needs the token in its environment; every other key comes from the dev API at boot. Keys
 * already present in the environment win (an operator can still override one). The same token is also accepted as
 * a Bearer by the gateway itself (see `serve.ts`), so agents call it with the credential they already carry.
 */

/** Aliases that carry the same secret on Railway / Cloud Agent (kept in sync with parle `principalSandboxToken`). */
const TOKEN_ALIASES = ['SANDBOX_TOKEN', 'PALCO_PROXY_TOKEN', 'PALCO_PROXY', 'VMOS_PROXY_TOKEN', 'VMOS_PROXY', 'PROXY_TOKEN'] as const;

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
  /** Keys written into env (only the ones that were missing). Values are never logged. */
  applied: string[];
  errors: string[];
}

/**
 * Fills missing keys of `env` from the dev API. Never throws: a gateway without the dev API still boots with
 * whatever its own environment has.
 */
export async function loadSandboxEnv(
  env: Record<string, string | undefined>,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SandboxEnvResult> {
  const token = principalSandboxToken(env);
  const result: SandboxEnvResult = { source: null, applied: [], errors: [] };
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
        if (env[key]?.trim()) continue;
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
