/**
 * Cloud provider health probe utility.
 * Encapsulates provider health-check URLs so server code never
 * needs to hardcode provider API endpoints directly.
 */

import type { ProviderId } from './types';

export interface CloudProbeResult {
  provider: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Lightweight health-check endpoints per cloud provider (no credits consumed). */
const HEALTH_ENDPOINTS: Partial<Record<ProviderId, string>> = {
  groq: 'https://api.groq.com/openai/v1/models',
  openai: 'https://api.openai.com/v1/models',
  fireworks: 'https://api.fireworks.ai/inference/v1/models',
  deepgram: 'https://api.deepgram.com/v1/projects',
  openrouter: 'https://openrouter.ai/api/v1/models',
};

/** Auth header format per provider (most use Bearer, Deepgram uses Token). */
function authHeader(provider: ProviderId, apiKey: string): Record<string, string> {
  if (provider === 'deepgram') return { Authorization: `Token ${apiKey}` };
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Probe a single cloud provider's health with a lightweight request.
 * Hits the `/models` endpoint (or equivalent) — no credits consumed.
 */
export async function probeCloudProvider(
  provider: ProviderId,
  apiKey: string,
  timeoutMs = 5_000,
): Promise<CloudProbeResult> {
  const url = HEALTH_ENDPOINTS[provider];
  if (!url) return { provider, ok: false, latencyMs: 0, error: `No health endpoint for ${provider}` };

  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: authHeader(provider, apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { provider, ok: res.ok, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      provider,
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe all configured cloud providers in parallel.
 * Only probes providers with keys present in the `keys` map.
 */
export async function probeAllCloudProviders(
  keys: Partial<Record<string, string>>,
  timeoutMs = 5_000,
): Promise<CloudProbeResult[]> {
  const probes: Promise<CloudProbeResult>[] = [];
  for (const [provider, apiKey] of Object.entries(keys)) {
    if (!apiKey || !HEALTH_ENDPOINTS[provider as ProviderId]) continue;
    probes.push(probeCloudProvider(provider as ProviderId, apiKey, timeoutMs));
  }
  if (probes.length === 0) return [];
  const settled = await Promise.allSettled(probes);
  return settled
    .filter((r): r is PromiseFulfilledResult<CloudProbeResult> => r.status === 'fulfilled')
    .map(r => r.value);
}
