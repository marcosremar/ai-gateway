/**
 * Retry helper for proxy routes.
 *
 * Wraps withProviderFallback() for single-provider proxy calls,
 * giving us exponential backoff on 5xx errors, cooldown tracking,
 * and consistent error classification — all managed server-side.
 */

import {
  withProviderFallback,
  type FallbackEntry,
  type FallbackOptions,
  CooldownTracker,
} from '../../providers/cloud/fallback';

/** Shared cooldown tracker across all proxy routes */
const proxyCooldownTracker = new CooldownTracker();

/** Default retry settings for proxy routes (real-time voice pipeline) */
const PROXY_DEFAULTS: FallbackOptions = {
  retriesPerProvider: 2,
  retryBaseDelayMs: 200,
  timeoutMs: 15_000,
  cooldownTracker: proxyCooldownTracker,
};

/**
 * Execute a provider call with retry + exponential backoff.
 *
 * @param providerId - The provider identifier (e.g. "groq")
 * @param model - The model name (e.g. "llama-3.3-70b-versatile")
 * @param fn - The async provider call to execute
 * @param stage - Label for logging (e.g. "LLM", "STT", "TTS")
 */
export async function withProxyRetry<T>(
  providerId: string,
  model: string,
  fn: () => Promise<T>,
  stage: string = 'proxy',
): Promise<T> {
  const chain: FallbackEntry[] = [{ provider: providerId, model }];
  const opts: FallbackOptions = {
    ...PROXY_DEFAULTS,
    logPrefix: `[proxy:${stage}]`,
  };

  const { result } = await withProviderFallback(
    chain,
    () => fn(),
    opts,
  );

  return result;
}
