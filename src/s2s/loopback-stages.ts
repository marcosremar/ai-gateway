/**
 * `StageClient` over the gateway's own HTTP routes (loopback): the composed s2s pipeline gets exactly the chains,
 * hedges, circuit breakers and budgets of `/v1/audio/transcriptions`, `/v1/chat/completions` and `/v1/audio/speech`
 * (provider-routing.ts) without a second copy of that logic. The caller's own key is forwarded, so rate limits and
 * accounting stay per client.
 */

import { SUBREQUEST_HEADER, SUBREQUEST_TOKEN } from '../gateway/proxy/internal-subrequest';
import type { ChatMessage, S2SConfig, SpokenAudio, StageAnswer, StageClient } from './composite';

export interface LoopbackOptions {
  baseUrl: string;
  authorization: string;
  models?: { stt?: string; chat?: string; tts?: string };
  fetchImpl?: typeof fetch;
}

class StageError extends Error {
  constructor(readonly stage: string, readonly status: number, message: string) { super(message); }
}

const served = (res: Response): StageAnswer => ({
  provider: res.headers.get('x-gateway-provider'),
  fallback: res.headers.get('x-gateway-fallback'),
});

/** A replica mid cold-start answers 502/503; a dropped loopback socket is a TypeError. Both are worth one retry —
 * the retry is idempotent because it only re-runs a stage that failed before returning (no bytes streamed yet). */
const RETRYABLE_STAGE_STATUS = new Set([502, 503]);

export function isRetryableStageError(err: unknown): boolean {
  if (err instanceof StageError) return RETRYABLE_STAGE_STATUS.has(err.status);
  return err instanceof TypeError; // fetch network failure (connection reset, DNS, incomplete chunked read)
}

async function retryStage<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (signal.aborted || !isRetryableStageError(err)) throw err;
    return fn();
  }
}

async function failure(stage: string, res: Response): Promise<StageError> {
  const text = await res.text().catch(() => '');
  let message = text.slice(0, 300);
  try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message; } catch { /* not JSON */ }
  return new StageError(stage, res.status, `${stage} HTTP ${res.status}: ${message}`);
}

async function* bodyChunks(res: Response): AsyncIterable<Uint8Array> {
  if (!res.body) return;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value?.length) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * OpenAI SSE → content deltas. Ends on `[DONE]`. An in-band error (the chat route's `{"error":…}` event after a provider
 * broke mid-answer) or a body that stops before `[DONE]` throws: the composed pipeline then reports a partial answer
 * instead of voicing a cut reply as if it were complete (fault bench 2026-10-06, items 1 and 6).
 */
export async function* sseDeltas(body: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let payload: { error?: { message?: string }; choices?: Array<{ delta?: { content?: string | null } }> };
      try { payload = JSON.parse(data); } catch { continue; /* keep-alive or partial line: ignore */ }
      if (payload.error) throw new Error(`llm stream broke: ${payload.error.message ?? 'error'}`);
      const delta = payload.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
  throw new Error('llm stream ended before [DONE] (truncated)');
}

const LANGUAGE_NAMES: Record<string, string> = { pt: 'pt', fr: 'fr', en: 'en', es: 'es' };

export function loopbackStages(opts: LoopbackOptions): StageClient {
  const f = opts.fetchImpl ?? fetch;
  // The app names its own aliases (config.models, or S2S_<STAGE>_MODEL); the gateway names no app. An unset one is a
  // loud error, never a model called "undefined".
  const pick = (stage: 'stt' | 'chat' | 'tts'): string => {
    const model = opts.models?.[stage];
    if (!model) throw new Error(`no ${stage} model for the composed fallback: send config.models.${stage} or set S2S_${stage.toUpperCase()}_MODEL`);
    return model;
  };
  const models = { get stt() { return pick('stt'); }, get chat() { return pick('chat'); }, get tts() { return pick('tts'); } };
  const auth = { Authorization: opts.authorization, [SUBREQUEST_HEADER]: SUBREQUEST_TOKEN };
  return {
    async transcribe(audio, contentType, cfg, signal) {
      return retryStage(async () => {
        const form = new FormData();
        const ext = /wav/.test(contentType) ? 'wav' : /ogg/.test(contentType) ? 'ogg' : /mp4|m4a|aac/.test(contentType) ? 'm4a' : /mpeg|mp3/.test(contentType) ? 'mp3' : 'webm';
        form.set('file', new Blob([new Uint8Array(audio)], { type: contentType || 'application/octet-stream' }), `turn.${ext}`);
        form.set('model', models.stt);
        if (cfg.language) form.set('language', LANGUAGE_NAMES[cfg.language.slice(0, 2)] ?? cfg.language.slice(0, 2));
        if (cfg.stt_prompt) form.set('prompt', cfg.stt_prompt);
        const res = await f(`${opts.baseUrl}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: form, signal });
        if (!res.ok) throw await failure('stt', res);
        const payload = await res.json() as { text?: string };
        return { ...served(res), text: payload.text ?? '' };
      }, signal);
    },

    async chatStream(messages: ChatMessage[], cfg: S2SConfig, signal) {
      return retryStage(async () => {
        const res = await f(`${opts.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: models.chat, messages, stream: true,
            max_tokens: cfg.max_tokens ?? 160, temperature: cfg.temperature ?? 0.6,
            ...(cfg.response_format ? { response_format: cfg.response_format } : {}),
          }),
          signal,
        });
        if (!res.ok) throw await failure('llm', res);
        return { ...served(res), deltas: sseDeltas(bodyChunks(res)) };
      }, signal);
    },

    async speak(text: string, cfg: S2SConfig, signal): Promise<SpokenAudio> {
      return retryStage(async () => {
        const res = await f(`${opts.baseUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: models.tts, input: text, response_format: 'wav',
            ...(cfg.voice ? { voice: cfg.voice } : {}),
            ...(cfg.fallback_voice ? { fallback_voice: cfg.fallback_voice } : {}),
            ...(cfg.language ? { language: cfg.language.slice(0, 2) } : {}),
          }),
          signal,
        });
        if (!res.ok) throw await failure('tts', res);
        return { ...served(res), body: bodyChunks(res), contentType: res.headers.get('content-type') ?? '' };
      }, signal);
    },
  };
}
