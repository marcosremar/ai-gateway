/**
 * STT Race — fire all configured providers in parallel, return the FIRST
 * that responds with non-empty text within the timeoutMs budget.
 * Remaining in-flight requests are cancelled once a winner is found.
 */

import type { STTProvider, STTSegment } from './providers/types';
import { defaultLogger as log } from './logger';

export interface STTRaceProvider {
  name: string;
  provider: STTProvider;
}

export interface STTRaceOptions {
  providers: STTRaceProvider[];
  /** Per-provider deadline in ms. Default: no timeout. */
  timeoutMs?: number;
  /** Max audio size in bytes. Default: 100MB */
  maxAudioSizeBytes?: number;
}

export interface STTRaceResult {
  /** Winning transcription text. */
  text: string;
  /** Name of the winning provider. */
  provider: string;
  /** Wall-clock latency in ms. */
  latencyMs: number;
  segments?: STTSegment[];
  avgLogprob?: number;
  compressionRatio?: number;
  noSpeechProb?: number;
}

/**
 * Fan-out to all providers simultaneously. Return the first non-empty result.
 * If all providers fail or time out, throws.
 */
export async function sttRace(
  audio: Buffer,
  language: string,
  prompt: string,
  options: STTRaceOptions,
): Promise<STTRaceResult> {
  if (options.providers.length === 0) {
    throw new Error('[stt-race] No STT providers configured');
  }

  const maxAudioSizeBytes = options.maxAudioSizeBytes ?? 100 * 1024 * 1024;
  if (!Number.isFinite(maxAudioSizeBytes) || maxAudioSizeBytes <= 0) {
    throw new Error(`[stt-race] maxAudioSizeBytes must be positive, got ${maxAudioSizeBytes}`);
  }
  if (audio.byteLength > maxAudioSizeBytes) {
    throw new Error(`[stt-race] Audio too large: ${audio.byteLength} > ${maxAudioSizeBytes}`);
  }

  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error(`[stt-race] timeoutMs must be positive, got ${options.timeoutMs}`);
    }
  }

  const t0 = Date.now();
  const abort = new AbortController();
  const timers: ReturnType<typeof setTimeout>[] = [];

  const races = options.providers.map(({ name, provider }) => {
    const modelId = provider.getModels()[0]?.id;
    if (!modelId) {
      return Promise.reject(new Error(`${name}: no models`));
    }

    let p = provider
      .transcribe({ audio, model: modelId, language, prompt, signal: abort.signal })
      .then((r) => {
        if (!r.text.trim()) throw new Error(`${name}: empty response`);
        return { name, ...r };
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) throw e; // another provider won — not a failure
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`[stt-race] ${name} failed: ${msg}`);
        throw e;
      });

    if (options.timeoutMs) {
      const deadline = new Promise<never>((_, reject) => {
        timers.push(setTimeout(() => reject(new Error(`${name}: timeout`)), options.timeoutMs));
      });
      p = Promise.race([p, deadline]);
    }

    return p;
  });

  let winner: Awaited<ReturnType<STTProvider['transcribe']>> & { name: string };
  try {
    winner = await Promise.any(races);
  } catch {
    throw new Error(
      `[stt-race] All ${options.providers.length} provider(s) failed or timed out`,
    );
  } finally {
    abort.abort();
    for (const t of timers) clearTimeout(t);
  }

  log.log(`[stt-race] ${winner.name} won in ${Date.now() - t0}ms`);

  return {
    text: winner.text,
    provider: winner.name,
    latencyMs: Date.now() - t0,
    ...(winner.segments ? { segments: winner.segments } : {}),
    ...(winner.avg_logprob !== undefined ? { avgLogprob: winner.avg_logprob } : {}),
    ...(winner.compression_ratio !== undefined ? { compressionRatio: winner.compression_ratio } : {}),
    ...(winner.no_speech_prob !== undefined ? { noSpeechProb: winner.no_speech_prob } : {}),
  };
}
