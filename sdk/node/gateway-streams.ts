/**
 * Streamed bodies of GatewayClient: chat SSE (`data: {chunk}` … `data: [DONE]`) and speech-to-speech frames.
 * Breaking out of a `for await` (or `cancel()`) cancels the body, which closes the connection upstream.
 */

import { GatewayError, streamError } from './gateway-http';
import { S2SFrameDecoder } from './s2s-frames';
import type { ChatStream, ChatUsage, S2SFrame, S2SStream, Served } from './gateway-types';

/** SSE `data:` payloads of a body, one per event (comments `:` and other fields ignored). */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const text = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? text.decode() : text.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) {
        if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''));
        if (data.length) yield data.join('\n');
        return;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ } finally { reader.releaseLock(); }
  }
}

interface StreamContext { path: string; signal?: AbortSignal; origin?: string }

export function chatStreamOf(res: Response, served: Served, ctx: StreamContext): ChatStream {
  const body = res.body;
  if (!body) throw new GatewayError({ message: `empty stream on ${ctx.path}`, code: 'bad_response', path: ctx.path, origin: ctx.origin });
  let finishReason: string | null = null;
  let usage: ChatUsage | null = null;
  let started = false;
  async function* deltas(): AsyncGenerator<string> {
    try {
      for await (const data of sseData(body!)) {
        if (data === '[DONE]') return;
        let chunk: {
          error?: { message?: string; type?: string; code?: string | number };
          choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
          usage?: ChatUsage;
        };
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) {
          const code = typeof chunk.error.code === 'string' ? chunk.error.code : chunk.error.type ?? 'stream_error';
          throw new GatewayError({
            message: `stream error on ${ctx.path}: ${chunk.error.message ?? 'error'}`, status: 200, code, path: ctx.path,
            served, origin: ctx.origin, details: chunk,
          });
        }
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (choice.delta?.content) yield choice.delta.content;
        }
      }
    } catch (err) {
      throw streamError(err, ctx.path, ctx.signal, ctx.origin);
    }
  }
  const gen = deltas();
  return {
    served,
    get finishReason() { return finishReason; },
    get usage() { return usage; },
    [Symbol.asyncIterator]() {
      if (started) throw new Error('a ChatStream can be iterated once');
      started = true;
      return gen;
    },
    async cancel() {
      if (started) await gen.return(undefined);
      else await body.cancel().catch(() => {});
    },
  };
}

export function s2sStreamOf(res: Response, ctx: StreamContext): S2SStream {
  const body = res.body;
  if (!body) throw new GatewayError({ message: `empty stream on ${ctx.path}`, code: 'bad_response', path: ctx.path });
  let started = false;
  async function* frames(): AsyncGenerator<S2SFrame> {
    const reader = body!.getReader();
    const decoder = new S2SFrameDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of decoder.push(value)) yield frame;
      }
      if (decoder.pending) {
        throw new GatewayError({ message: `s2s stream cut mid-frame (${decoder.pending} bytes left)`, code: 'stream_error', path: ctx.path });
      }
    } catch (err) {
      throw streamError(err, ctx.path, ctx.signal);
    } finally {
      try { await reader.cancel(); } catch { /* closed */ } finally { reader.releaseLock(); }
    }
  }
  const gen = frames();
  return {
    [Symbol.asyncIterator]() {
      if (started) throw new Error('an S2SStream can be iterated once');
      started = true;
      return gen;
    },
    async cancel() {
      if (started) await gen.return(undefined);
      else await body.cancel().catch(() => {});
    },
  };
}
