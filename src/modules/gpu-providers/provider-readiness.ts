/**
 * Provider readiness pre-filter for the deploy race.
 *
 * Observed pain: a deploy races N slots across providers, but providers with no
 * credentials (e.g. Modal with no token, RunPod with no key) fail EVERY slot
 * instantly — wasting race capacity and, when they crowd out the configured
 * providers, producing a misleading "All slots failed to create instances".
 *
 * This module decides, from credentials alone, which providers are even worth
 * racing. Pure (no I/O): the caller passes an env snapshot; we return the
 * usable subset. SAFE FALLBACK: if filtering would remove everything (e.g. an
 * env snapshot we can't read), we keep the original list — the filter can only
 * help, never make a deploy worse.
 */

import type { ProviderName } from '../gateway/providers/gpu/deploy-orchestrator';

/** Env var(s) that must be present (non-empty) for a provider to be usable.
 * A provider with an empty list is always considered ready (e.g. local/in-proc
 * providers we can't gate on a key). Modal accepts either token var. */
export const PROVIDER_REQUIRED_ENV: Record<ProviderName, string[][]> = {
  // Inner arrays are AND-groups; outer array is OR (any group satisfied = ready).
  vast: [['VAST_API_KEY']],
  'vast-vm': [['VAST_API_KEY']],
  runpod: [['RUNPOD_API_KEY']],
  tensordock: [['TENSORDOCK_API_KEY']],
  hyperstack: [['HYPERSTACK_API_KEY']],
  modal: [['MODAL_TOKEN_ID'], ['MODAL_API_KEY']],
  snapgpu: [], // local/in-process — no external creds to gate on
};

type EnvSnapshot = Record<string, string | undefined>;

function hasEnv(env: EnvSnapshot, name: string): boolean {
  const v = env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

/** True if `provider` has the credentials it needs (or needs none). Unknown
 * providers default to ready (don't filter what we don't understand). */
export function isProviderConfigured(provider: ProviderName, env: EnvSnapshot): boolean {
  const groups = PROVIDER_REQUIRED_ENV[provider];
  if (!groups || groups.length === 0) return true; // no creds required / unknown → ready
  return groups.some((group) => group.every((k) => hasEnv(env, k)));
}

/** Readiness map for every known provider given an env snapshot. */
export function computeProviderReadiness(env: EnvSnapshot): Record<ProviderName, boolean> {
  const out = {} as Record<ProviderName, boolean>;
  (Object.keys(PROVIDER_REQUIRED_ENV) as ProviderName[]).forEach((p) => {
    out[p] = isProviderConfigured(p, env);
  });
  return out;
}

export interface TierFilterResult<T> {
  usable: T[];
  skipped: T[];
  /** True when the safe fallback kicked in (filter would have emptied the race). */
  fellBack: boolean;
}

/** Drop tiers whose provider is not configured. NEVER returns an empty `usable`:
 * if every tier would be dropped, returns the original list untouched (fellBack). */
export function filterUsableTiers<T extends { name: ProviderName }>(
  tiers: T[],
  env: EnvSnapshot = (typeof process !== 'undefined' ? process.env : {}) as EnvSnapshot,
): TierFilterResult<T> {
  const usable: T[] = [];
  const skipped: T[] = [];
  for (const t of tiers) {
    if (isProviderConfigured(t.name, env)) usable.push(t);
    else skipped.push(t);
  }
  if (usable.length === 0) {
    // Everything looked unconfigured — don't sabotage the deploy; race as-is.
    return { usable: tiers, skipped: [], fellBack: true };
  }
  return { usable, skipped, fellBack: false };
}
