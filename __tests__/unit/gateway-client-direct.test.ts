/**
 * GatewayClient direct fallback: when the gateway itself is unreachable, the same aliases go straight to the
 * providers of the app's fallback plan. Fake fetch for both hosts (gateway + providers).
 */

import { describe, expect, it } from 'vitest';
import { GatewayClient, GatewayError, type FallbackPlan, type RouteChange } from '../../sdk/node';
import { connectionRefused, fakeFetch, hang, json, sse, type FakeHandler } from './_gateway-client-fakes';

const GW = 'http://gw.test';
const OR = 'https://or.test/api/v1';
const GROQ = 'https://groq.test/openai/v1';
const OR_KEY = 'sk-or-v1-plan-key-1';
const GROQ_KEY = 'gsk_plan_key';

function plan(orKey = OR_KEY, ttlSeconds = 3600): FallbackPlan {
  const or = { baseUrl: OR, apiKey: orKey, keyKind: 'shared' as const, expiresAt: null, limitUsd: null };
  return {
    app: 'parle', issuedAt: '2026-10-06T10:00:00Z', ttlSeconds,
    providers: { openrouter: or, groq: { baseUrl: GROQ, apiKey: GROQ_KEY, keyKind: 'shared', expiresAt: null, limitUsd: null } },
    openrouter: or,
    routes: {
      stt: { 'parle-stt': [{ provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' }, { provider: 'groq', model: 'whisper-large-v3-turbo' }] },
      chat: { 'parle-llm': [
        { provider: 'openrouter', model: 'qwen/qwen3.5-9b', extraBody: { reasoning: { enabled: false } } },
        { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' },
      ] },
      tts: { 'parle-tts': [
        { provider: 'openrouter', model: 'microsoft/mai-voice-2.1-flash', voice: 'pt-BR-Luana' },
        { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'pf_dora', fixedVoice: true },
      ] },
    },
  };
}

const completion = (content: string) => json({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const MSG = [{ role: 'user' as const, content: 'oi' }];

async function setup(routes: Record<string, FakeHandler>, opts: { threshold?: number; plan?: () => FallbackPlan } = {}) {
  let t = 1_000_000;
  const changes: RouteChange[] = [];
  const f = fakeFetch({ [`GET ${GW}/v1/apps/parle/fallback`]: () => json((opts.plan ?? plan)()), ...routes });
  const gw = new GatewayClient({
    baseUrl: GW, apiKey: 'gw-key', fetch: f.fetch, now: () => t,
    directFallback: { app: 'parle', failureThreshold: opts.threshold ?? 3, cooldownMs: 30_000 },
    onRouteChange: c => changes.push(c),
  });
  await gw.refreshFallbackPlan();
  return { gw, f, changes, advance: (ms: number) => { t += ms; } };
}

const toProviders = (f: ReturnType<typeof fakeFetch>) => f.calls.filter(c => new URL(c.url).origin !== GW);

describe('direct fallback — when to go direct', () => {
  it('connection error → direct, with the plan key, served label and route change', async () => {
    const { gw, f, changes } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => connectionRefused(),
      [`POST ${OR}/chat/completions`]: () => completion('Olá'),
    });
    const out = await gw.chat({ model: 'parle-llm', messages: MSG, temperature: 0.3, extraBody: { top_k: 5 } });
    expect(out.choices[0].message.content).toBe('Olá');
    expect(out.served).toEqual({ provider: 'openrouter-direct:qwen/qwen3.5-9b', fallback: 'gateway_unreachable', fallbackFrom: 'gateway' });
    const direct = toProviders(f)[0];
    expect(direct.headers.authorization).toBe(`Bearer ${OR_KEY}`);
    // extraBody of the request and of the entry merged; the entry's model replaces the alias
    expect(JSON.parse(String(direct.body))).toEqual({
      messages: MSG, temperature: 0.3, top_k: 5, reasoning: { enabled: false }, model: 'qwen/qwen3.5-9b', stream: false,
    });
    expect(changes).toEqual([{ route: 'direct', reason: 'network' }]);
  });

  it('timeout before the first byte → direct', async () => {
    const { gw } = await setup({
      [`POST ${GW}/v1/audio/transcriptions`]: hang,
      [`POST ${OR}/audio/transcriptions`]: () => json({ text: 'bom dia' }),
    });
    const out = await gw.transcribe({ file: new Uint8Array([1, 2]), model: 'parle-stt', language: 'pt', timeoutMs: 20 });
    expect(out).toMatchObject({ text: 'bom dia', served: { provider: 'openrouter-direct:openai/whisper-large-v3-turbo' } });
  });

  it.each([
    [502, '<html>Bad Gateway</html>'],
    [503, '{"status":"error","code":503,"message":"Application failed to respond"}'],
    [504, ''],
  ])('edge %i without the gateway JSON error → direct', async (status, body) => {
    const { gw } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => new Response(body, { status }),
      [`POST ${OR}/chat/completions`]: () => completion('ok'),
    });
    expect((await gw.chat({ model: 'parle-llm', messages: MSG })).served.provider).toBe('openrouter-direct:qwen/qwen3.5-9b');
  });

  it('the gateway\'s own 503 provider_unavailable, a 4xx or a 500 JSON error → no direct call', async () => {
    for (const res of [
      () => json({ error: { message: 'No provider available', type: 'provider_unavailable', code: 'provider_unavailable' } }, 503),
      () => json({ error: { message: 'model is required', type: 'invalid_request_error' } }, 400),
      () => json({ error: { message: 'Invalid or missing API key', type: 'server_error' } }, 401),
      () => new Response('nope', { status: 404 }),
    ]) {
      const { gw, f } = await setup({ [`POST ${GW}/v1/chat/completions`]: res, [`POST ${OR}/chat/completions`]: () => completion('x') });
      await expect(gw.chat({ model: 'parle-llm', messages: MSG })).rejects.toBeInstanceOf(GatewayError);
      expect(toProviders(f)).toHaveLength(0);
    }
  });

  it('the caller aborting never goes direct', async () => {
    const { gw, f } = await setup({ [`POST ${GW}/v1/chat/completions`]: hang, [`POST ${OR}/chat/completions`]: () => completion('x') });
    const ctl = new AbortController();
    const p = gw.chat({ model: 'parle-llm', messages: MSG, signal: ctl.signal });
    ctl.abort();
    expect((await p.catch(e => e)).name).toBe('AbortError');
    expect(toProviders(f)).toHaveLength(0);
  });

  it('an alias without a plan entry, or no plan at all, rethrows the gateway failure', async () => {
    const { gw } = await setup({ [`POST ${GW}/v1/chat/completions`]: () => connectionRefused() });
    await expect(gw.chat({ model: 'unknown-alias', messages: MSG })).rejects.toMatchObject({ code: 'network' });
    const f = fakeFetch({ [`POST ${GW}/v1/chat/completions`]: () => connectionRefused() });
    const cold = new GatewayClient({ baseUrl: GW, fetch: f.fetch, directFallback: { app: 'parle' } });
    await expect(cold.chat({ model: 'parle-llm', messages: MSG })).rejects.toMatchObject({ code: 'network' });
    expect(f.calls.every(c => new URL(c.url).origin === GW)).toBe(true);
  });
});

describe('direct fallback — how it calls', () => {
  it('tries the entries in chain order on 5xx / timeout, across providers', async () => {
    const { gw, f } = await setup({
      [`POST ${GW}/v1/audio/transcriptions`]: () => connectionRefused(),
      [`POST ${OR}/audio/transcriptions`]: () => json({ error: { message: 'boom', code: 502 } }, 502),
      [`POST ${GROQ}/audio/transcriptions`]: () => json({ text: 'via groq' }),
    });
    const out = await gw.transcribe({ file: new Uint8Array([1]), model: 'parle-stt' });
    expect(out.text).toBe('via groq');
    expect(out.served.provider).toBe('groq-direct:whisper-large-v3-turbo');
    const calls = toProviders(f);
    expect(calls.map(c => [c.url, (c.body as FormData).get('model'), c.headers.authorization])).toEqual([
      [`${OR}/audio/transcriptions`, 'openai/whisper-large-v3-turbo', `Bearer ${OR_KEY}`],
      [`${GROQ}/audio/transcriptions`, 'whisper-large-v3-turbo', `Bearer ${GROQ_KEY}`],
    ]);
  });

  it('a provider 400 stops there (not retried on the next entry)', async () => {
    const { gw, f } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => connectionRefused(),
      [`POST ${OR}/chat/completions`]: () => json({ error: { message: 'bad', code: 400 } }, 400),
    });
    await expect(gw.chat({ model: 'parle-llm', messages: MSG })).rejects.toMatchObject({ status: 400, origin: 'openrouter' });
    expect(toProviders(f)).toHaveLength(1);
  });

  it('TTS voice: fallback_voice for a normal entry, the entry voice when fixed; wav → mp3 on OpenRouter', async () => {
    const { gw, f } = await setup({
      [`POST ${GW}/v1/audio/speech`]: () => connectionRefused(),
      [`POST ${OR}/audio/speech`]: (_c, n) => (n === 1 ? new Response('x', { status: 503 }) : new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/mpeg' } })),
    });
    const out = await gw.speech({ model: 'parle-tts', input: 'Olá', voice: 'br-f-01', fallback_voice: 'pf_custom', response_format: 'wav', ref_audio: 'x' });
    expect(out.contentType).toBe('audio/mpeg');
    expect(out.served.provider).toBe('openrouter-direct:hexgrad/kokoro-82m');
    const bodies = toProviders(f).map(c => JSON.parse(String(c.body)));
    expect(bodies).toEqual([
      { model: 'microsoft/mai-voice-2.1-flash', input: 'Olá', voice: 'pf_custom', response_format: 'mp3' },
      { model: 'hexgrad/kokoro-82m', input: 'Olá', voice: 'pf_dora', response_format: 'mp3' },
    ]);
  });

  it('TTS without fallback_voice uses the entry voice', async () => {
    const { gw, f } = await setup({
      [`POST ${GW}/v1/audio/speech`]: () => connectionRefused(),
      [`POST ${OR}/audio/speech`]: () => new Response(new Uint8Array([1])),
    });
    await gw.speech({ model: 'parle-tts', input: 'Olá', voice: 'br-f-01', response_format: 'pcm' });
    expect(JSON.parse(String(toProviders(f)[0].body))).toMatchObject({ voice: 'pt-BR-Luana', response_format: 'pcm' });
  });

  it('chatStream goes direct and streams the provider SSE (comments ignored)', async () => {
    const { gw } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => connectionRefused(),
      [`POST ${OR}/chat/completions`]: () => new Response(`: OPENROUTER PROCESSING\n\n${sse([{ choices: [{ delta: { content: 'Oi' } }] }, '[DONE]'])}`),
    });
    const stream = await gw.chatStream({ model: 'parle-llm', messages: MSG });
    expect(stream.served.provider).toBe('openrouter-direct:qwen/qwen3.5-9b');
    const got: string[] = [];
    for await (const d of stream) got.push(d);
    expect(got).toEqual(['Oi']);
  });

  it('the plan key goes only to the provider baseUrl; the gateway only ever sees the gateway key', async () => {
    const { gw, f } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => connectionRefused(),
      [`POST ${OR}/chat/completions`]: () => completion('x'),
    });
    await gw.chat({ model: 'parle-llm', messages: MSG });
    for (const c of f.calls) {
      const sent = JSON.stringify([c.headers, typeof c.body === 'string' ? c.body : '']);
      if (new URL(c.url).origin === GW) {
        expect(sent).not.toContain(OR_KEY);
        expect(sent).not.toContain(GROQ_KEY);
        expect(c.headers.authorization).toBe('Bearer gw-key');
      } else {
        expect(c.url.startsWith(OR)).toBe(true);
        expect(sent).not.toContain('gw-key');
      }
    }
  });
});

describe('direct fallback — breaker and plan', () => {
  it('opens after K failures (gateway skipped), probes /health after the cooldown, closes when it answers', async () => {
    let healthy = false;
    let gatewayUp = false;
    const { gw, f, changes, advance } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => (gatewayUp ? completion('gw') : connectionRefused()),
      [`GET ${GW}/health`]: () => (healthy ? json({ status: 'ok' }) : connectionRefused()),
      [`POST ${OR}/chat/completions`]: () => completion('direct'),
    }, { threshold: 2 });
    const gwChats = () => f.calls.filter(c => c.url === `${GW}/v1/chat/completions`).length;
    await gw.chat({ model: 'parle-llm', messages: MSG });
    await gw.chat({ model: 'parle-llm', messages: MSG });
    expect(gw.gatewayState()).toMatchObject({ breaker: 'open', consecutiveFailures: 2, route: 'direct', lastError: 'network', planLoaded: true });
    // Open: the gateway is not called at all
    await gw.chat({ model: 'parle-llm', messages: MSG });
    expect(gwChats()).toBe(2);
    // Cooldown over, gateway still down: the probe fails, the call went direct, the breaker re-opens
    advance(30_001);
    expect((await gw.chat({ model: 'parle-llm', messages: MSG })).served.fallback).toBe('gateway_unreachable');
    await (gw as unknown as { breaker: { probe: Promise<void> | null } }).breaker.probe;
    expect(f.calls.filter(c => c.url === `${GW}/health`)).toHaveLength(1);
    expect(gw.gatewayState().breaker).toBe('open');
    expect(gwChats()).toBe(2);
    // Gateway back: the next probe closes the breaker, the following call uses the gateway again
    healthy = true;
    gatewayUp = true;
    advance(30_001);
    await gw.chat({ model: 'parle-llm', messages: MSG });
    await (gw as unknown as { breaker: { probe: Promise<void> | null } }).breaker.probe;
    expect(gw.gatewayState()).toMatchObject({ breaker: 'closed', consecutiveFailures: 0 });
    const back = await gw.chat({ model: 'parle-llm', messages: MSG });
    expect(back.choices[0].message.content).toBe('gw');
    expect(gw.gatewayState().route).toBe('gateway');
    expect(changes).toEqual([{ route: 'direct', reason: 'network' }, { route: 'gateway', reason: 'recovered' }]);
  });

  it('s2s: no direct fallback — gateway_unreachable on failure and while the breaker is open', async () => {
    const { gw, f } = await setup({ [`POST ${GW}/v1/s2s`]: () => connectionRefused() }, { threshold: 1 });
    await expect(gw.s2s({ file: new Uint8Array([1]), config: {} })).rejects.toMatchObject({ code: 'gateway_unreachable', unreachable: true });
    const before = f.calls.length;
    await expect(gw.s2s({ file: new Uint8Array([1]), config: {} })).rejects.toMatchObject({ code: 'gateway_unreachable' });
    expect(f.calls.length).toBe(before); // skipped
    expect(toProviders(f)).toHaveLength(0);
  });

  it('deployments, app routes and health are never direct', async () => {
    const { gw, f } = await setup({
      [`GET ${GW}/v1/deployments/x`]: () => connectionRefused(),
      [`GET ${GW}/v1/apps/parle/routes`]: () => connectionRefused(),
    });
    await expect(gw.deployments.get('x')).rejects.toMatchObject({ code: 'network' });
    await expect(gw.appRoutes.get('parle')).rejects.toMatchObject({ code: 'network' });
    expect(toProviders(f)).toHaveLength(0);
  });

  it('refreshes the plan before its TTL runs out (in the background, on a gateway call)', async () => {
    let n = 0;
    const { gw, f, advance } = await setup({ [`POST ${GW}/v1/chat/completions`]: () => completion('gw') }, { plan: () => plan(`key-${++n}`, 100) });
    const planFetches = () => f.calls.filter(c => c.url.endsWith('/fallback')).length;
    await gw.chat({ model: 'parle-llm', messages: MSG });
    expect(planFetches()).toBe(1);
    advance(81_000); // past 80 % of 100 s
    await gw.chat({ model: 'parle-llm', messages: MSG });
    await new Promise(r => setTimeout(r, 0));
    expect(planFetches()).toBe(2);
  });

  it('a 401 from the provider asks the gateway for a new plan and retries with the new key; the stale plan keeps working', async () => {
    let n = 0;
    let planUp = true;
    const { gw, f } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => connectionRefused(),
      [`POST ${OR}/chat/completions`]: (c) => (c.headers.authorization === 'Bearer key-1' ? json({ error: { message: 'User not found.', code: 401 } }, 401) : completion('ok')),
    }, { plan: () => { if (!planUp) connectionRefused(); return plan(`key-${++n}`); } });
    const out = await gw.chat({ model: 'parle-llm', messages: MSG });
    expect(out.choices[0].message.content).toBe('ok');
    expect(toProviders(f).map(c => c.headers.authorization)).toEqual(['Bearer key-1', 'Bearer key-2']);
    // Gateway (and its plan endpoint) down: the last good plan still serves
    planUp = false;
    expect((await gw.chat({ model: 'parle-llm', messages: MSG })).served.provider).toBe('openrouter-direct:qwen/qwen3.5-9b');
    expect(toProviders(f).at(-1)!.headers.authorization).toBe('Bearer key-2');
  });

  it('directFallback.enabled=false: no plan fetch, no breaker', async () => {
    const f = fakeFetch({ [`POST ${GW}/v1/chat/completions`]: () => connectionRefused() });
    const gw = new GatewayClient({ baseUrl: GW, fetch: f.fetch, directFallback: { app: 'parle', enabled: false } });
    await expect(gw.chat({ model: 'parle-llm', messages: MSG })).rejects.toMatchObject({ code: 'network' });
    expect(await gw.refreshFallbackPlan()).toBeNull();
    expect(gw.gatewayState().breaker).toBe('closed');
    expect(f.calls).toHaveLength(1);
  });
});
