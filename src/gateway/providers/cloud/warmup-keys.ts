/**
 * Provider-warmup pure helpers (#382, #383).
 *
 * Extracted from server/provider-warmup.ts so they can be unit-tested without
 * importing the heavy server module graph (GPU clients, state, registries). The
 * server file re-exports these and wires them to its runtime singletons.
 *
 * No I/O, no side effects, no `process.env` reads — all inputs are explicit.
 */

/** Cloud providers eligible for connection warmup. */
export type WarmupProvider = 'groq' | 'openai' | 'fireworks' | 'openrouter' | 'deepgram' | 'elevenlabs';

/** Provider id → env var carrying its API key. */
const WARMUP_PROVIDER_ENV: Record<WarmupProvider, string> = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
};

/**
 * Build the cloud-provider warmup keys map (#382).
 *
 * Warmup previously only probed Groq + OpenAI, so the first request that fell
 * back to Fireworks/OpenRouter/Deepgram/ElevenLabs paid a cold TCP/TLS
 * handshake. This includes every configured cloud provider so all fallbacks
 * stay warm. A provider is included only when it is both marked available and
 * has its key present in the supplied env snapshot.
 */
export function buildWarmupKeys(
  avail: Partial<Record<WarmupProvider, boolean>>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const provider of Object.keys(WARMUP_PROVIDER_ENV) as WarmupProvider[]) {
    const value = env[WARMUP_PROVIDER_ENV[provider]];
    if (avail[provider] && value) keys[provider] = value;
  }
  return keys;
}

/**
 * Decide whether a periodic warmup cycle should run (#383).
 *
 * Firing every 60s regardless of traffic burns outbound bandwidth / rate budget
 * when the gateway is idle for hours. After `idleBackoffMs` with no real
 * requests, cycles are skipped until traffic resumes — but a GPU pod that is
 * deployed is always probed (health monitoring must not stop).
 *
 * @returns true if the cycle should run this tick.
 */
export function shouldRunWarmupCycle(opts: {
  now: number;
  lastRequestTime: number;
  gpuDeployed: boolean;
  idleBackoffMs?: number;
}): boolean {
  if (opts.gpuDeployed) return true; // never stop probing a live pod
  const idleBackoffMs = opts.idleBackoffMs ?? 10 * 60_000; // 10 min
  return opts.now - opts.lastRequestTime < idleBackoffMs;
}
