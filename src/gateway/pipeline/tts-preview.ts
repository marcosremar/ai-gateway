// ── BabelCast Gateway — TTS Preview Service ──────────────────────────────────
// Single "generate a preview of this voice" flow:
//   1. GPU pod (preset or clone)
//   2. Local Kokoro TTS (CPU, always available)
//   3. Modal (clone only)
//   4. Cloud TTS chain
// Side effects (state touches, HTTP parsing) stay in the server adapter;
// this module is a pure computation.

import { createLogger } from '../../logger';
import type { AIProfile } from '../../client';
import { validateRemoteEndpoint } from './ssrf-protection';
import { GPU_TTS_TIMEOUT_MS } from './timeouts';

const log = createLogger('tts-preview');

export interface TtsPreviewInput {
  text: string;
  speaker: string;
  language: string;
  referenceAudio: string;
  refText: string;
}

export interface TtsPreviewResult {
  audio: Buffer;
  contentType: string;
  source: 'gpu' | 'local-kokoro' | 'modal-clone' | 'cloud';
  latencyMs: number;
}

export interface TtsPreviewClient {
  synthesize(text: string, profile: AIProfile): Promise<{ audio: Buffer | Uint8Array; contentType: string }>;
}

export interface TtsPreviewModalTTS {
  synthesize(input: {
    input: string;
    model: string;
    voice: string;
    referenceAudio?: string;
    refText?: string;
  }): Promise<{ audio: Buffer | Uint8Array; contentType: string }>;
}

export interface TtsPreviewDeps {
  gpuEndpoint: string | null;
  localKokoroUrl: string | null;
  client: TtsPreviewClient;
  modalTTS: TtsPreviewModalTTS;
  translationProfile: AIProfile;
}

/**
 * Generate a one-off TTS preview for voice selection UIs.
 * Prefers GPU, then Modal (clone only), then cloud fallback.
 */
export async function generateTtsPreview(
  input: TtsPreviewInput,
  deps: TtsPreviewDeps,
): Promise<TtsPreviewResult> {
  const t0 = Date.now();
  const { text, speaker, language, referenceAudio, refText } = input;
  const isCloneRequest = !!(referenceAudio && refText);
  const { gpuEndpoint } = deps;

  // 1) GPU pod — supports both preset and clone
  if (gpuEndpoint) {
    validateRemoteEndpoint(gpuEndpoint);
    const gpuBody: Record<string, string> = { text, speaker, language };
    if (isCloneRequest) { gpuBody.reference_audio = referenceAudio; gpuBody.ref_text = refText; }
    const gpuRes = await fetch(`${gpuEndpoint}/v1/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(gpuBody),
      signal: AbortSignal.timeout(isCloneRequest ? 180_000 : GPU_TTS_TIMEOUT_MS),
    });
    if (gpuRes.ok) {
      const audio = Buffer.from(await gpuRes.arrayBuffer());
      const latencyMs = Date.now() - t0;
      log.log(`preview [gpu${isCloneRequest ? '/clone' : ''}]: speaker=${speaker} lang=${language} ${audio.length}B ${latencyMs}ms`);
      return { audio, contentType: 'audio/wav', source: 'gpu', latencyMs };
    }
    const errText = await gpuRes.text().catch(() => '');
    log.warn(`preview GPU failed (${gpuRes.status}): ${errText.slice(0, 120)}, falling back`);
  }

  // 2) Local Kokoro TTS (CPU, always available, no GPU/cloud needed)
  if (deps.localKokoroUrl && !isCloneRequest) {
    try {
      const localRes = await fetch(`${deps.localKokoroUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'kokoro-82m', input: text, voice: speaker, speed: 1.0, response_format: 'wav' }),
        signal: AbortSignal.timeout(120_000),
      });
      if (localRes.ok) {
        const audio = Buffer.from(await localRes.arrayBuffer());
        const latencyMs = Date.now() - t0;
        log.log(`preview [local-kokoro]: speaker=${speaker} lang=${language} ${audio.length}B ${latencyMs}ms`);
        return { audio, contentType: 'audio/wav', source: 'local-kokoro', latencyMs };
      }
      log.warn(`preview local Kokoro failed (${localRes.status}), falling back`);
    } catch (e) {
      log.warn(`preview local Kokoro error: ${e instanceof Error ? e.message : e}, falling back`);
    }
  }

  // 3) Modal for clone requests (only provider that supports cloning off-GPU)
  if (isCloneRequest) {
    log.log(`voice clone → Modal Qwen3-TTS (ref_text="${refText.slice(0, 40)}...")`);
    const result = await deps.modalTTS.synthesize({
      input: text, model: 'qwen3-tts', voice: speaker,
      referenceAudio, refText,
    });
    const latencyMs = Date.now() - t0;
    log.log(`preview [modal/clone]: speaker=${speaker} lang=${language} ${result.audio.length}B ${latencyMs}ms`);
    return {
      audio: Buffer.isBuffer(result.audio) ? result.audio : Buffer.from(result.audio),
      contentType: result.contentType || 'audio/wav',
      source: 'modal-clone',
      latencyMs,
    };
  }

  // 4) Cloud fallback (Groq Orpheus → Modal Qwen3-TTS → OpenAI)
  log.log('preview: no GPU/local, using cloud fallback');
  const result = await deps.client.synthesize(text, {
    ...deps.translationProfile,
    gpuEndpoint: undefined,
    voice: speaker,
    audioFormat: 'wav',
  });
  const latencyMs = Date.now() - t0;
  log.log(`preview [cloud]: speaker=${speaker} lang=${language} ${result.audio.length}B ${latencyMs}ms`);
  return {
    audio: Buffer.isBuffer(result.audio) ? result.audio : Buffer.from(result.audio),
    contentType: result.contentType || 'audio/wav',
    source: 'cloud',
    latencyMs,
  };
}
