import { describe, expect, it } from 'vitest';
import { loopbackStages } from '../../../src/s2s/loopback-stages.js';

// Regression: serve.ts passes { stt: undefined } when S2S_STT_MODEL is unset; the gateway names no app alias, so that must fail loudly.
describe('loopbackStages models', () => {
  function capture() {
    const seen: string[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = init?.body;
      seen.push(body instanceof FormData ? String(body.get('model')) : String((JSON.parse(String(body)) as { model: string }).model));
      return new Response(JSON.stringify({ text: 'oi' }), { status: 200 });
    }) as typeof fetch;
    return { seen, fetchImpl };
  }

  it('an unset model is a loud error, never a model called "undefined"', async () => {
    const { seen, fetchImpl } = capture();
    const stages = loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { stt: undefined, chat: undefined, tts: undefined } });
    await expect(stages.transcribe(new Uint8Array([1]), 'audio/wav', { language: 'pt' } as never, new AbortController().signal))
      .rejects.toThrow(/no stt model/);
    expect(seen).toEqual([]);
  });

  it('a set override wins', async () => {
    const { seen, fetchImpl } = capture();
    const stages = loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { stt: 'whisper-x' } });
    await stages.transcribe(new Uint8Array([1]), 'audio/wav', { language: 'pt' } as never, new AbortController().signal);
    expect(seen).toEqual(['whisper-x']);
  });
});

describe('loopbackStages stage retry', () => {
  const cfg = { language: 'pt' } as never;
  const signal = () => new AbortController().signal;

  it('retries once on a network failure (connection reset, incomplete chunked read)', async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed: incomplete chunked read');
      return new Response(JSON.stringify({ text: 'oi' }), { status: 200 });
    }) as typeof fetch;
    const stages = loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { stt: 'w' } });
    const heard = await stages.transcribe(new Uint8Array([1]), 'audio/wav', cfg, signal());
    expect(heard.text).toBe('oi');
    expect(calls).toBe(2);
  });

  it('retries once on a warming replica (503), not on a semantic error (400)', async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ error: { message: 'warming' } }), { status: 503 })
        : new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    }) as typeof fetch;
    const stages = loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { stt: 'w' } });
    expect((await stages.transcribe(new Uint8Array([1]), 'audio/wav', cfg, signal())).text).toBe('ok');
    expect(calls).toBe(2);

    calls = 0;
    const bad = loopbackStages({
      baseUrl: 'http://gw', authorization: 'Bearer k', models: { stt: 'w' },
      fetchImpl: (async () => { calls++; return new Response('{"error":{"message":"bad audio"}}', { status: 400 }); }) as typeof fetch,
    });
    await expect(bad.transcribe(new Uint8Array([1]), 'audio/wav', cfg, signal())).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it('does not retry when the caller aborted', async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => { calls++; throw new TypeError('fetch failed'); }) as typeof fetch;
    const stages = loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { stt: 'w' } });
    const aborted = AbortSignal.abort();
    await expect(stages.transcribe(new Uint8Array([1]), 'audio/wav', cfg, aborted)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('retries the speak request connect, never the audio stream itself', async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls++;
      if (calls === 1) return new Response('{"error":{"message":"replica unreachable"}}', { status: 502 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/pcm' } });
    }) as typeof fetch;
    const stages = loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { tts: 'v' } });
    const spoken = await stages.speak('oi', cfg, signal());
    expect(spoken.contentType).toBe('audio/pcm');
    expect(calls).toBe(2);
  });
});
