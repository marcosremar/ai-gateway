/**
 * `StageClient` over the gateway's own HTTP routes (loopback): the composed s2s pipeline gets exactly the chains,
 * hedges, circuit breakers and budgets of `/v1/audio/transcriptions`, `/v1/chat/completions` and `/v1/audio/speech`
 * (provider-routing.ts) without a second copy of that logic. The caller's own key is forwarded, so rate limits and
 * accounting stay per client.
 */

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

/** OpenAI SSE → content deltas. Ends on `[DONE]` or end of stream. */
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
      try {
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> }).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* keep-alive or partial line: ignore */ }
    }
  }
}

const LANGUAGE_NAMES: Record<string, string> = { pt: 'pt', fr: 'fr', en: 'en', es: 'es' };

export function loopbackStages(opts: LoopbackOptions): StageClient {
  const f = opts.fetchImpl ?? fetch;
  const models = { stt: 'parle-stt', chat: 'parle-llm', tts: 'parle-tts', ...opts.models };
  const auth = { Authorization: opts.authorization };
  return {
    async transcribe(audio, contentType, cfg, signal) {
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
    },

    async chatStream(messages: ChatMessage[], cfg: S2SConfig, signal) {
      const res = await f(`${opts.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: models.chat, messages, stream: true,
          max_tokens: cfg.max_tokens ?? 160, temperature: cfg.temperature ?? 0.6,
        }),
        signal,
      });
      if (!res.ok) throw await failure('llm', res);
      return { ...served(res), deltas: sseDeltas(bodyChunks(res)) };
    },

    async speak(text: string, cfg: S2SConfig, signal): Promise<SpokenAudio> {
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
    },
  };
}
