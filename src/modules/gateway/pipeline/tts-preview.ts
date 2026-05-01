// ── BabelCast Gateway — TTS Preview Service ──────────────────────────────────
// Single "generate a preview of this voice" flow.
// Speaker may be `model/voice` (e.g. "kokoro/am_adam", "qwen3/serena").
// When the model is named, we route directly to the matching backend so
// Kokoro voice IDs don't get silently swallowed by Qwen3 (which falls back
// to its default voice when given an unknown speaker).
// Order without explicit model:
//   1. GPU pod (preset or clone)
//   2. Local Kokoro TTS (CPU, always available)
//   3. Modal (clone only)
//   4. Cloud TTS chain
// Side effects (state touches, HTTP parsing) stay in the server adapter;
// this module is a pure computation.

import { createLogger } from '../../logger';
import type { AIProfile } from '../../client';
import { validateRemoteEndpointResolved } from './ssrf-protection';
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

// `model/voice` parser. A bare voice that matches the Kokoro pattern
// (`xx_yy`) is treated as `kokoro/<voice>` because GPU Qwen3-TTS silently
// swallows unknown voice IDs and returns its default speaker — which is
// exactly the bug this routing was added to fix.
const KOKORO_VOICE_RE = /^[a-z]{2}_[a-z0-9]+$/i;
type Engine = 'kokoro' | 'qwen3' | 'gpu' | 'modal' | 'cloud' | 'auto';
function parseSpeaker(raw: string): { engine: Engine; voice: string } {
  const idx = raw.indexOf('/');
  if (idx > 0) {
    const prefix = raw.slice(0, idx).toLowerCase();
    const voice = raw.slice(idx + 1);
    if (prefix === 'kokoro' || prefix === 'qwen3' || prefix === 'qwen' ||
        prefix === 'gpu' || prefix === 'modal' || prefix === 'cloud') {
      const engine = (prefix === 'qwen' ? 'qwen3' : prefix) as Engine;
      return { engine, voice };
    }
  }
  if (KOKORO_VOICE_RE.test(raw)) return { engine: 'kokoro', voice: raw };
  return { engine: 'auto', voice: raw };
}

/**
 * Generate a one-off TTS preview for voice selection UIs.
 * Honors `model/voice` routing in the speaker field. Otherwise prefers GPU
 * (preset or clone), then local Kokoro, then Modal clone, then cloud.
 */
export async function generateTtsPreview(
  input: TtsPreviewInput,
  deps: TtsPreviewDeps,
): Promise<TtsPreviewResult> {
  const t0 = Date.now();
  const { text, speaker: rawSpeaker, language, referenceAudio, refText } = input;
  const { engine, voice: speaker } = parseSpeaker(rawSpeaker);
  const isCloneRequest = !!(referenceAudio && refText);
  const { gpuEndpoint } = deps;
  const allowGpu    = engine === 'auto' || engine === 'gpu' || engine === 'qwen3';
  const allowKokoro = engine === 'auto' || engine === 'kokoro';
  const allowModal  = engine === 'auto' || engine === 'modal';
  const allowCloud  = engine === 'auto' || engine === 'cloud';
  log.log(`preview routing: engine=${engine} voice=${speaker} (raw="${rawSpeaker}")`);

  // 1) GPU pod — supports both preset and clone
  if (gpuEndpoint && allowGpu) {
    await validateRemoteEndpointResolved(gpuEndpoint);
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
  if (deps.localKokoroUrl && !isCloneRequest && allowKokoro) {
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
  if (isCloneRequest && allowModal) {
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
  if (!allowCloud) {
    throw new Error(`preview: engine='${engine}' requested but no matching backend succeeded`);
  }
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
