/**
 * Design decisions left open by the fault bench (docs/reports/2026-10-06-fault-bench.md), each failing before its
 * change: (a) same-target retry only for deployments, (b) a 429 pauses that model, not the provider's breaker,
 * (c) an STT answer served after a primary failure is not cached, (d) the upstream finish_reason reaches the SSE,
 * (e) an oversized STT upload is 413, plus the per-user concurrency limit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeUpstream, type FakeUpstream } from '../../../scripts/fault-bench/fake-upstream';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { clearClientCache } from '../../../src/gateway/providers/cloud/openai-compat/client-cache';
import { OpenAICompatLLMProvider } from '../../../src/gateway/providers/cloud/openai-compat/openai-compat-llm';
import { finishReasonOf, isStreamMarker } from '../../../src/gateway/providers/cloud/openai-compat/stream-markers';
import type { ChatRequest, STTProvider } from '../../../src/gateway/providers/cloud/types';
import { isRateLimited, routeRequest, type RouteTarget } from '../../../src/gateway/proxy/provider-routing';
import { handleAudioTranscriptions, _resetSttCache } from '../../../src/gateway/proxy/routes/audio-transcriptions';
import { handleChatCompletions } from '../../../src/gateway/proxy/routes/chat-completions';
import { concurrencyLimits, DEFAULT_MAX_CONCURRENT_PER_USER } from '../../../src/gateway/proxy/server';
import type { ProxyRequest } from '../../../src/gateway/proxy/types';

interface Fake { providerId: string; isConfigured(): boolean; call: ReturnType<typeof vi.fn> }
const fake = (providerId: string, impl: () => Promise<string>): Fake => ({ providerId, isConfigured: () => true, call: vi.fn(impl) });
const httpError = (status: number, headers?: Record<string, string>) =>
  Object.assign(new Error(`HTTP ${status}`), { status, ...(headers ? { headers } : {}) });
const target = (p: Fake, model?: string): RouteTarget<Fake> => ({ providerId: p.providerId, provider: p, ...(model ? { model } : {}) });
const route = (targets: Array<RouteTarget<Fake>>, breakers = new CircuitBreakerRegistry()) =>
  routeRequest(targets, (t) => t.provider.call(t.model), { stage: 'test', breakers, retriesPerProvider: 1 });

describe('a) same-target retry on 5xx only for deployments', () => {
  it('a cloud 502 goes straight to the next target (one call)', async () => {
    const a = fake('openrouter', () => Promise.reject(httpError(502)));
    const b = fake('groq', () => Promise.resolve('ok'));
    await route([target(a, 'm'), target(b, 'm')]);
    expect(a.call).toHaveBeenCalledTimes(1);
  });

  it('a deployment 502 is retried once (a replica restarting)', async () => {
    const a = fake('deployment:x', () => Promise.reject(httpError(502)));
    const b = fake('openrouter', () => Promise.resolve('ok'));
    await route([target(a), target(b, 'm')]);
    expect(a.call).toHaveBeenCalledTimes(2);
  });
});

describe('b) a 429 pauses that model, not the provider', () => {
  it('does not open the provider breaker: the provider\'s other model stays usable', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 30_000 });
    const or = fake('openrouter', () => Promise.reject(httpError(429)));
    const groq = fake('groq', () => Promise.resolve('ok'));
    for (let i = 0; i < 3; i++) await route([target(or, `busy-${i}`), target(groq, 'g')], breakers);
    expect(breakers.get('openrouter').isOpen()).toBe(false);
    const other = fake('openrouter', () => Promise.resolve('fine'));
    expect((await route([target(other, 'other-model')], breakers)).result).toBe('fine');
  });

  it('the throttled model is skipped while its Retry-After runs, then tried again', async () => {
    const breakers = new CircuitBreakerRegistry();
    const or = fake('openrouter', () => Promise.reject(httpError(429, { 'retry-after': '1' })));
    const groq = fake('groq', () => Promise.resolve('ok'));
    await route([target(or, 'm'), target(groq, 'g')], breakers);
    const second = await route([target(or, 'm'), target(groq, 'g')], breakers);
    expect(or.call).toHaveBeenCalledTimes(1);
    expect(second.headers['X-Gateway-Fallback']).toBe('rate_limited');
    expect(isRateLimited({ providerId: 'openrouter', model: 'm' }, breakers, Date.now() + 1100)).toBe(false);
  });

  it('every target throttled: they are still tried (a pause is a hint, not a 503)', async () => {
    const breakers = new CircuitBreakerRegistry();
    let n = 0;
    const or = fake('openrouter', () => (n++ === 0 ? Promise.reject(httpError(429)) : Promise.resolve('ok')));
    await expect(route([target(or, 'm')], breakers)).rejects.toThrow();
    expect((await route([target(or, 'm')], breakers)).result).toBe('ok');
  });
});

describe('c) STT cache and fallback', () => {
  beforeEach(() => _resetSttCache());
  const sttReq = (): ProxyRequest => ({
    method: 'POST', path: '/v1/audio/transcriptions', headers: {}, rawBody: Buffer.from('same-audio'), body: { model: 'stt' },
  } as unknown as ProxyRequest);
  const stt = (providerId: string, impl: () => Promise<{ text: string }>) =>
    ({ providerId, isConfigured: () => true, transcribe: vi.fn(impl) }) as unknown as STTProvider & { transcribe: ReturnType<typeof vi.fn> };

  it('an answer served after the primary failed (5xx) is not cached: the retry reaches the primary again', async () => {
    let primaryUp = false;
    const primary = stt('deployment:s', () => (primaryUp ? Promise.resolve({ text: 'primary' }) : Promise.reject(httpError(500))));
    const backup = stt('openrouter', () => Promise.resolve({ text: 'backup' }));
    const routes = { stt: [{ providerId: 'deployment:s', provider: primary }, { providerId: 'openrouter', provider: backup, model: 'w' }] };
    const breakers = new CircuitBreakerRegistry();
    expect((await handleAudioTranscriptions(sttReq(), routes, undefined, breakers)).body).toEqual({ text: 'backup' });
    primaryUp = true;
    const again = await handleAudioTranscriptions(sttReq(), routes, undefined, breakers);
    expect(again.body).toEqual({ text: 'primary' });
    expect(again.headers?.['X-Cache']).toBe('MISS');
  });
});

describe('d) finish_reason survives the stream', () => {
  let up: FakeUpstream;
  const KEY_ENV = 'BENCH_DECISIONS_TEST_KEY';
  beforeAll(async () => { process.env[KEY_ENV] = 'unit-test-provider-key'; up = await startFakeUpstream(); });
  afterAll(async () => { await up.close(); delete process.env[KEY_ENV]; });
  beforeEach(() => { up.reset(); clearClientCache(); });

  const llm = () => new OpenAICompatLLMProvider({ providerId: 'openrouter', baseURL: `${up.url}/or`, envKey: KEY_ENV });
  const ask = (model: string): ChatRequest => ({ model, messages: [{ role: 'user', content: 'oi' }] });

  it('chatStream yields a __finish__ marker with the upstream reason', async () => {
    up.setFaults({ m: { kind: 'ok', finishReason: 'length' } });
    const tokens: string[] = [];
    for await (const t of llm().chatStream!(ask('m'))) tokens.push(t);
    expect(tokens.map(finishReasonOf).filter(Boolean)).toEqual(['length']);
    expect(tokens.filter(t => !isStreamMarker(t)).join('')).not.toContain('__');
  });

  it('the proxy SSE ends with finish_reason "length", not "stop"', async () => {
    up.setFaults({ m: { kind: 'ok', finishReason: 'length' } });
    const res = await handleChatCompletions(
      { method: 'POST', path: '/v1/chat/completions', headers: {}, body: { model: 'chat', stream: true, messages: [{ role: 'user', content: 'oi' }] } } as unknown as ProxyRequest,
      {}, undefined, undefined, undefined, undefined, undefined,
      { chatRoutes: { chat: [{ providerId: 'openrouter', provider: llm(), model: 'm' }] }, circuitBreakers: new CircuitBreakerRegistry() },
    );
    const text = await new Response(res.stream as ReadableStream).text();
    const reasons = [...text.matchAll(/"finish_reason":"(\w+)"/g)].map(m => m[1]);
    expect(reasons).toEqual(['length']);
    expect(text).not.toContain('__finish__');
  });
});

describe('e) oversized STT upload', () => {
  it('answers 413, like the body-size guard', async () => {
    const res = await handleAudioTranscriptions(
      { method: 'POST', path: '/v1/audio/transcriptions', headers: {}, rawBody: Buffer.alloc(25 * 1024 * 1024 + 1), body: { model: 'stt' } } as unknown as ProxyRequest,
      { stt: { providerId: 'x', isConfigured: () => true, transcribe: vi.fn() } as unknown as STTProvider },
    );
    expect(res.status).toBe(413);
  });
});

describe('per-user concurrency limit', () => {
  it('defaults high enough for one key serving a class, with per-user overrides', () => {
    expect(DEFAULT_MAX_CONCURRENT_PER_USER).toBeGreaterThanOrEqual(100);
    expect(concurrencyLimits({}).fallback).toBe(DEFAULT_MAX_CONCURRENT_PER_USER);
    const limits = concurrencyLimits({ MAX_CONCURRENT_PER_USER: '40', MAX_CONCURRENT_PER_USER_OVERRIDES: 'parle:300, bad, x:-1,other:10' });
    expect(limits.fallback).toBe(40);
    expect([...limits.perUser]).toEqual([['parle', 300], ['other', 10]]);
  });
});
