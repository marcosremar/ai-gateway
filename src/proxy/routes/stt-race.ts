/**
 * STT Race Mode — send audio to multiple STT providers simultaneously,
 * return whichever responds first.
 *
 * This is a proxy-level wrapper around the existing runVerifiedSTT()
 * ensemble function. The ensemble already uses Promise.any() under the
 * hood — this module makes it accessible as a route option.
 *
 * Usage: POST /v1/audio/transcriptions with header X-Race-Mode: true
 * or query parameter ?race=true.
 *
 * Why race is useful for real-time: STT latency has high variance across
 * providers (Groq Whisper: 200-800ms, GPU Whisper: 300-8000ms depending
 * on warmth). Racing both gives you the p50 of the faster one while
 * paying for both. For real-time translation where every 200ms matters,
 * this is worth the extra cost.
 */

import type { STTProvider, STTResponse } from '../../providers/types';

/**
 * Race multiple STT providers and return the first successful result.
 * Losers are abandoned (their responses are discarded when they arrive).
 *
 * @param audio Raw audio buffer
 * @param model Model ID to use on each provider
 * @param providers Array of providers to race
 * @param opts Optional language/prompt/timeout
 * @returns The fastest successful STT response
 */
export async function raceSTT(
  audio: Buffer,
  model: string,
  providers: STTProvider[],
  opts?: { language?: string; prompt?: string; timeoutMs?: number },
): Promise<{ result: STTResponse; provider: string; latencyMs: number }> {
  if (providers.length === 0) throw new Error('No STT providers to race');
  if (providers.length === 1) {
    // Single provider — no race needed, call directly
    const t0 = Date.now();
    const result = await providers[0].transcribe({
      audio, model,
      language: opts?.language,
      prompt: opts?.prompt,
    });
    return { result, provider: providers[0].providerId, latencyMs: Date.now() - t0 };
  }

  const t0 = Date.now();
  const deadlines: ReturnType<typeof setTimeout>[] = [];

  const races = providers.map((provider) => {
    let p: Promise<{ result: STTResponse; provider: string }> = provider
      .transcribe({ audio, model, language: opts?.language, prompt: opts?.prompt })
      .then((result) => {
        if (!result.text.trim()) throw new Error(`${provider.providerId}: empty`);
        return { result, provider: provider.providerId };
      });

    if (opts?.timeoutMs) {
      const deadline = new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`${provider.providerId}: timeout`)), opts.timeoutMs);
        deadlines.push(t);
      });
      p = Promise.race([p, deadline]);
    }

    return p;
  });

  try {
    const winner = await Promise.any(races);
    return { ...winner, latencyMs: Date.now() - t0 };
  } catch {
    throw new Error(`All ${providers.length} STT providers failed in race mode`);
  } finally {
    for (const t of deadlines) clearTimeout(t);
  }
}
