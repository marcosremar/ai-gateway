/**
 * GatewayClient against a fake fetch: served headers, typed errors, chat SSE, streamed speech, s2s frames (decoded
 * against the server's own encoder), deployments, idempotent-only retry, X-App, caller abort vs timeout.
 */

import { describe, expect, it } from 'vitest';
import { GatewayClient, GatewayError, S2SFrameDecoder, type S2SFrame } from '../../sdk/node';
import { encodeAudio, encodeEvent } from '../../src/s2s/frames';
// Type-only contract between the client mirrors and the server types (checked by `bun run typecheck`).
import '../../sdk/node/gateway-contract';
import { connectionRefused, fakeFetch, hang, json, sse, streamOf } from './_gateway-client-fakes';

const BASE = 'http://gw.test';
const client = (f: ReturnType<typeof fakeFetch>, extra: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}) =>
  new GatewayClient({ baseUrl: `${BASE}/`, apiKey: 'gw-key', fetch: f.fetch, ...extra });

describe('GatewayClient — OpenAI routes', () => {
  it('transcribe sends multipart and reads text + served headers', async () => {
    const f = fakeFetch({
      [`POST ${BASE}/v1/audio/transcriptions`]: () => json({ text: 'Bom dia' }, 200, {
        'X-Gateway-Provider': 'openrouter:openai/whisper-large-v3-turbo', 'X-Gateway-Fallback': 'cold',
        'X-Gateway-Fallback-From': 'deployment:parle-speech',
      }),
    });
    const out = await client(f).transcribe({ file: new Uint8Array([1, 2, 3]), model: 'parle-stt', language: 'pt' });
    expect(out.text).toBe('Bom dia');
    expect(out.served).toEqual({ provider: 'openrouter:openai/whisper-large-v3-turbo', fallback: 'cold', fallbackFrom: 'deployment:parle-speech' });
    const form = f.calls[0].body as FormData;
    expect(form.get('model')).toBe('parle-stt');
    expect(form.get('language')).toBe('pt');
    expect((form.get('file') as Blob).size).toBe(3);
    expect(f.calls[0].headers.authorization).toBe('Bearer gw-key');
  });

  it('served fields are null when the headers are absent', async () => {
    const f = fakeFetch({ [`POST ${BASE}/v1/chat/completions`]: () => json({ id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [] }) });
    expect((await client(f).chat({ model: 'm', messages: [{ role: 'user', content: 'oi' }] })).served)
      .toEqual({ provider: null, fallback: null, fallbackFrom: null });
  });

  it('a 503 provider_unavailable becomes a typed GatewayError (not unreachable)', async () => {
    const f = fakeFetch({
      [`POST ${BASE}/v1/chat/completions`]: () => json({ error: { message: 'No provider available for chat model "x"', type: 'provider_unavailable', code: 'provider_unavailable', providers: ['a'] } }, 503, { 'Retry-After': '5' }),
    });
    const err = await client(f).chat({ model: 'x', messages: [{ role: 'user', content: 'oi' }] }).catch(e => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ status: 503, code: 'provider_unavailable', path: '/v1/chat/completions', retryAfterSec: 5, unreachable: false });
    expect(err.message).toContain('No provider available');
  });

  it('chat sends extraBody merged and stream:false', async () => {
    const f = fakeFetch({ [`POST ${BASE}/v1/chat/completions`]: () => json({ choices: [] }) });
    await client(f).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.2, extraBody: { reasoning: { enabled: false } } });
    expect(JSON.parse(String(f.calls[0].body))).toEqual({
      model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.2, reasoning: { enabled: false }, stream: false,
    });
  });

  it('chatStream yields SSE content deltas, exposes served before the first delta, finish reason and usage after', async () => {
    const enc = new TextEncoder();
    const body = sse([
      { choices: [{ delta: { role: 'assistant', content: '' } }] },
      { choices: [{ delta: { content: 'Bom' } }] },
      { choices: [{ delta: { content: ' dia' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
      '[DONE]',
    ]);
    // Split mid-line to check the line buffer.
    const f = fakeFetch({
      [`POST ${BASE}/v1/chat/completions`]: () => new Response(streamOf([enc.encode(body.slice(0, 37)), enc.encode(body.slice(37))]), {
        headers: { 'Content-Type': 'text/event-stream', 'X-Gateway-Provider': 'deployment:parle-speech' },
      }),
    });
    const stream = await client(f).chatStream({ model: 'parle-llm', messages: [{ role: 'user', content: 'oi' }] });
    expect(stream.served.provider).toBe('deployment:parle-speech');
    const parts: string[] = [];
    for await (const d of stream) parts.push(d);
    expect(parts).toEqual(['Bom', ' dia']);
    expect(stream.finishReason).toBe('stop');
    expect(stream.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(JSON.parse(String(f.calls[0].body)).stream).toBe(true);
  });

  it('an in-stream error event throws a GatewayError', async () => {
    const f = fakeFetch({
      [`POST ${BASE}/v1/chat/completions`]: () => new Response(sse([{ choices: [{ delta: { content: 'a' } }] }, { error: { message: 'upstream died', type: 'server_error' } }])),
    });
    const stream = await client(f).chatStream({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    const got: string[] = [];
    const err = await (async () => { for await (const d of stream) got.push(d); })().catch(e => e);
    expect(got).toEqual(['a']);
    expect(err).toMatchObject({ name: 'GatewayError', code: 'server_error' });
  });

  it('speech returns the body as a stream without buffering it', async () => {
    const f = fakeFetch({
      [`POST ${BASE}/v1/audio/speech`]: () => new Response(streamOf([new Uint8Array([82, 73, 70, 70])], false), {
        headers: { 'Content-Type': 'audio/wav', 'X-Gateway-Provider': 'deployment:parle-qwen-tts' },
      }),
    });
    const out = await client(f).speech({ model: 'parle-tts', input: 'Olá', voice: 'br-f-01', fallback_voice: 'pf_dora', response_format: 'wav', language: 'pt' });
    expect(out.contentType).toBe('audio/wav');
    expect(out.served.provider).toBe('deployment:parle-qwen-tts');
    // The body never closes: resolving at all proves nothing was buffered; the first chunk is readable.
    const reader = out.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([82, 73, 70, 70]));
    await reader.cancel();
    expect(JSON.parse(String(f.calls[0].body))).toEqual({
      model: 'parle-tts', input: 'Olá', voice: 'br-f-01', fallback_voice: 'pf_dora', response_format: 'wav', language: 'pt',
    });
  });
});

describe('GatewayClient — s2s', () => {
  const frames = () => {
    const parts = [
      encodeEvent({ type: 'route', provider: 'composite', fallback: 'cold', from: 'deployment:parle-speech' }, 'binary'),
      encodeEvent({ type: 'transcript', text: 'bom dia', stt_ms: 300 }, 'binary'),
      encodeEvent({ type: 'audio_format', encoding: 'pcm_s16le', sample_rate: 24000 }, 'binary'),
      encodeAudio(new Uint8Array([1, 2, 3, 4, 5, 6]), 'binary'),
      encodeEvent({ type: 'done', reply: 'Olá!', transcript: 'bom dia', total_ms: 900 }, 'binary'),
    ];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    return all;
  };

  it('decodes the server encoder output, split into 3-byte chunks (headers split too)', async () => {
    const all = frames();
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < all.length; i += 3) chunks.push(all.slice(i, i + 3));
    const f = fakeFetch({ [`POST ${BASE}/v1/s2s`]: () => new Response(streamOf(chunks), { headers: { 'Content-Type': 'application/x-aigw-s2s' } }) });
    const stream = await client(f).s2s({ file: new Uint8Array([9]), config: { system: 's', language: 'pt', models: { stt: 'parle-stt' } } });
    const got: S2SFrame[] = [];
    for await (const fr of stream) got.push(fr);
    expect(got.map(g => (g.kind === 'event' ? g.event.type : 'audio'))).toEqual(['route', 'transcript', 'audio_format', 'audio', 'done']);
    expect(got[3]).toEqual({ kind: 'audio', pcm: new Uint8Array([1, 2, 3, 4, 5, 6]) });
    const form = f.calls[0].body as FormData;
    expect(JSON.parse(String(form.get('config')))).toEqual({ system: 's', language: 'pt', models: { stt: 'parle-stt' } });
  });

  it('the decoder takes one big chunk and byte-by-byte alike', () => {
    const all = frames();
    const whole = new S2SFrameDecoder().push(all);
    const bytewise = new S2SFrameDecoder();
    const out: S2SFrame[] = [];
    for (const b of all) out.push(...bytewise.push(new Uint8Array([b])));
    expect(out).toEqual(whole);
    expect(bytewise.pending).toBe(0);
  });

  it('a 503 before the first frame throws the typed error', async () => {
    const f = fakeFetch({ [`POST ${BASE}/v1/s2s`]: () => json({ error: { message: 'No provider could answer speech-to-speech: x', type: 'provider_unavailable', code: 'provider_unavailable' } }, 503) });
    await expect(client(f).s2s({ file: new Uint8Array([1]), config: {} })).rejects.toMatchObject({ code: 'provider_unavailable', status: 503 });
  });

  it('a stream cut mid-frame throws stream_error', async () => {
    const all = frames();
    const f = fakeFetch({ [`POST ${BASE}/v1/s2s`]: () => new Response(streamOf([all.slice(0, all.length - 2)])) });
    const stream = await client(f).s2s({ file: new Uint8Array([1]), config: {} });
    await expect((async () => { for await (const _ of stream) { /* drain */ } })()).rejects.toMatchObject({ code: 'stream_error' });
  });
});

describe('GatewayClient — deployments, apps, health', () => {
  it('get → null on 404; put / wake / park / pause / resume / delete hit the right routes', async () => {
    const view = { name: 'parle-speech', status: 'ready' };
    const f = fakeFetch({
      [`GET ${BASE}/v1/deployments/missing`]: () => json({ error: "deployment 'missing' not found" }, 404),
      [`GET ${BASE}/v1/deployments/parle-speech`]: () => json(view),
      [`PUT ${BASE}/v1/deployments/parle-speech`]: () => json(view, 201),
      [`PATCH ${BASE}/v1/deployments/parle-speech`]: () => json(view),
      [`POST ${BASE}/v1/deployments/parle-speech/wake`]: () => json(view, 202),
      [`POST ${BASE}/v1/deployments/parle-speech/park`]: () => json(view, 202),
      [`DELETE ${BASE}/v1/deployments/parle-speech`]: () => json({ deleted: 'parle-speech' }),
      [`DELETE ${BASE}/v1/deployments/gone`]: () => json({ error: 'not found' }, 404),
      [`GET ${BASE}/v1/deployments`]: () => json({ namespace: 'default', health: { deployments: 1, replicas: 0, listError: null }, deployments: [view] }),
    });
    const gw = client(f);
    expect(await gw.deployments.get('missing')).toBeNull();
    expect(await gw.deployments.get('parle-speech')).toEqual(view);
    await gw.deployments.put('parle-speech', { appImage: 'speech-stack', minReplicas: 0 });
    await gw.deployments.wake('parle-speech');
    await gw.deployments.park('parle-speech');
    await gw.deployments.pause('parle-speech');
    await gw.deployments.resume('parle-speech');
    expect(await gw.deployments.delete('parle-speech')).toBe(true);
    expect(await gw.deployments.delete('gone')).toBe(false);
    expect((await gw.deployments.list()).deployments).toHaveLength(1);
    const patches = f.calls.filter(c => c.method === 'PATCH').map(c => JSON.parse(String(c.body)));
    expect(patches).toEqual([{ paused: true }, { paused: false }]);
    expect(gw.deployments.invokeUrl('parle-speech')).toBe(`${BASE}/v1/deployments/parle-speech/invoke`);
    expect(gw.invokeUrl('a b')).toBe(`${BASE}/v1/deployments/a%20b/invoke`);
  });

  it('a 403 from deployments keeps the gateway message', async () => {
    const f = fakeFetch({ [`PUT ${BASE}/v1/deployments/x`]: () => json({ error: 'this API key cannot manage deployments' }, 403) });
    await expect(client(f).deployments.put('x', {})).rejects.toMatchObject({ status: 403, code: 'forbidden', message: expect.stringContaining('cannot manage') });
  });

  it('sends X-Gateway-Device for a call that names a device, and keeps it out of the body', async () => {
    const f = fakeFetch({ [`POST ${BASE}/v1/chat/completions`]: () => json({ choices: [] }) });
    const gw = client(f);
    await gw.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], device: 'install-7f3a9c21' });
    await gw.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(f.calls.map(c => c.headers['x-gateway-device'])).toEqual(['install-7f3a9c21', undefined]);
    expect(JSON.parse(String(f.calls[0]!.body))).not.toHaveProperty('device');
  });

  it('sends X-App on every call when `app` is set', async () => {
    const f = fakeFetch({
      [`GET ${BASE}/v1/apps/parle/routes`]: () => json({ app: 'parle', routes: { stt: { 'parle-stt': ['openrouter:x'] } } }),
      [`PUT ${BASE}/v1/apps/parle/routes`]: (c) => json({ app: 'parle', routes: JSON.parse(String(c.body)) }),
      [`POST ${BASE}/v1/chat/completions`]: () => json({ choices: [] }),
    });
    const gw = client(f, { app: 'parle' });
    expect(await gw.appRoutes.get('parle')).toEqual({ stt: { 'parle-stt': ['openrouter:x'] } });
    expect(await gw.appRoutes.put('parle', { chat: { 'parle-llm': [{ provider: 'openrouter', model: 'm' }] } }))
      .toEqual({ chat: { 'parle-llm': [{ provider: 'openrouter', model: 'm' }] } });
    await gw.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(f.calls.map(c => c.headers['x-app'])).toEqual(['parle', 'parle', 'parle']);
    expect(client(fakeFetch({}))).toBeTruthy();
  });

  it('health and deep health', async () => {
    const f = fakeFetch({
      [`GET ${BASE}/health?deep=1`]: () => json({ status: 'degraded', providers: [] }),
      [`GET ${BASE}/health`]: () => json({ status: 'ok' }),
    });
    expect(await client(f).health()).toEqual({ status: 'ok' });
    expect((await client(f).health({ deep: true })).status).toBe('degraded');
  });
});

describe('GatewayClient — retry, abort, timeout', () => {
  it('retries idempotent calls on connection errors (max 2), never a POST', async () => {
    const f = fakeFetch({
      [`GET ${BASE}/v1/deployments/x`]: (_c, n) => (n < 3 ? connectionRefused() : json({ name: 'x' })),
      [`POST ${BASE}/v1/chat/completions`]: () => connectionRefused(),
      [`POST ${BASE}/v1/audio/speech`]: () => connectionRefused(),
      [`POST ${BASE}/v1/audio/transcriptions`]: () => connectionRefused(),
      [`POST ${BASE}/v1/s2s`]: () => connectionRefused(),
    });
    const gw = client(f);
    expect(await gw.deployments.get('x')).toEqual({ name: 'x' });
    expect(f.calls.filter(c => c.method === 'GET')).toHaveLength(3);
    await expect(gw.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'network', unreachable: true });
    await expect(gw.speech({ model: 'm', input: 'x', voice: 'v' })).rejects.toMatchObject({ code: 'network' });
    await expect(gw.transcribe({ file: new Uint8Array([1]), model: 'm' })).rejects.toMatchObject({ code: 'network' });
    await expect(gw.s2s({ file: new Uint8Array([1]), config: {} })).rejects.toMatchObject({ code: 'gateway_unreachable' });
    expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(4);
  });

  it('gives up after 2 retries on a GET', async () => {
    const f = fakeFetch({ [`GET ${BASE}/health`]: () => connectionRefused() });
    await expect(client(f).health()).rejects.toMatchObject({ code: 'network' });
    expect(f.calls).toHaveLength(3);
  });

  it('the caller aborting rejects with the caller\'s reason (AbortError), not a GatewayError', async () => {
    const f = fakeFetch({ [`POST ${BASE}/v1/chat/completions`]: hang, [`GET ${BASE}/v1/deployments/x`]: hang });
    const ctl = new AbortController();
    const p = client(f).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], signal: ctl.signal });
    ctl.abort();
    const err = await p.catch(e => e);
    expect(err).not.toBeInstanceOf(GatewayError);
    expect(err.name).toBe('AbortError');
    // A custom reason is passed through as is, and an aborted GET is not retried
    const ctl2 = new AbortController();
    const reason = new Error('student spoke again');
    const p2 = client(f).deployments.get('x', { signal: ctl2.signal });
    ctl2.abort(reason);
    expect(await p2.catch(e => e)).toBe(reason);
    expect(f.calls.filter(c => c.method === 'GET')).toHaveLength(1);
  });

  it('the call timeout rejects with GatewayError code timeout (unreachable: no header arrived)', async () => {
    const f = fakeFetch({ [`POST ${BASE}/v1/chat/completions`]: hang });
    const err = await client(f).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], timeoutMs: 20 }).catch(e => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ code: 'timeout', unreachable: true, status: 0 });
    // Group default applies too
    const err2 = await client(f, { timeoutMs: { chat: 15 } }).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }).catch(e => e);
    expect(err2).toMatchObject({ code: 'timeout' });
  });

  it('never reads provider keys from the environment', async () => {
    process.env.GROQ_API_KEY = 'gsk_env_should_not_be_used';
    try {
      const f = fakeFetch({ [`POST ${BASE}/v1/audio/transcriptions`]: () => connectionRefused() });
      await expect(client(f).transcribe({ file: new Uint8Array([1]), model: 'whisper-large-v3' })).rejects.toBeInstanceOf(GatewayError);
      expect(f.calls.every(c => new URL(c.url).origin === BASE)).toBe(true);
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });
});
