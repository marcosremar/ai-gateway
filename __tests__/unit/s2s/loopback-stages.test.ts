import { describe, expect, it } from 'vitest';
import { loopbackStages } from '../../../src/s2s/loopback-stages.js';

// Regression: serve.ts passes { stt: undefined } when S2S_STT_MODEL is unset; the composite must still ask the aliases.
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

  it('unset overrides keep the parle aliases (never "undefined")', async () => {
    const { seen, fetchImpl } = capture();
    const stages = loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { stt: undefined, chat: undefined, tts: undefined } });
    await stages.transcribe(new Uint8Array([1]), 'audio/wav', { language: 'pt' } as never, new AbortController().signal);
    expect(seen).toEqual(['parle-stt']);
  });

  it('a set override wins', async () => {
    const { seen, fetchImpl } = capture();
    const stages = loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { stt: 'whisper-x' } });
    await stages.transcribe(new Uint8Array([1]), 'audio/wav', { language: 'pt' } as never, new AbortController().signal);
    expect(seen).toEqual(['whisper-x']);
  });
});
