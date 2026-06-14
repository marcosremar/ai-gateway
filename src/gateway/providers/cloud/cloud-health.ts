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

/**
 * Lightweight health-check endpoints per cloud provider (no credits consumed).
 *
 * - Deepgram uses `/v1/auth/token` (token grant) instead of `/v1/projects`
 *   (full project listing) — a cheaper liveness probe (#388).
 * - elevenlabs/minimax/fal/modal added (#389) so configured providers without
 *   an endpoint no longer show as permanently "unknown" on /health.
 */
const HEALTH_ENDPOINTS: Partial<Record<ProviderId, string>> = {
  groq: 'https://api.groq.com/openai/v1/models',
  openai: 'https://api.openai.com/v1/models',
  fireworks: 'https://api.fireworks.ai/inference/v1/models',
  deepgram: 'https://api.deepgram.com/v1/auth/token',
  openrouter: 'https://openrouter.ai/api/v1/models',
  elevenlabs: 'https://api.elevenlabs.io/v1/models',
  minimax: 'REDACTED_env_75d72190/v1/get_voice',
  fal: 'https://fal.run/health',
};

/** Auth header format per provider (most use Bearer, Deepgram/ElevenLabs/fal differ). */
function authHeader(provider: ProviderId, apiKey: string): Record<string, string> {
  if (provider === 'deepgram') return { Authorization: `Token ${apiKey}` };
  if (provider === 'elevenlabs') return { 'xi-api-key': apiKey };
  if (provider === 'fal') return { Authorization: `Key ${apiKey}` };
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
    // Preserve the original ok semantics but expose the status so callers can
    // distinguish "API down" (5xx/timeout) from "key lacks scope" (401/403).
    return {
      provider,
      ok: res.ok,
      latencyMs: Date.now() - t0,
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
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
