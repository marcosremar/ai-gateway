import { describe, expect, it, vi } from 'vitest';
import { startFakeUpstream } from '../../../scripts/fault-bench/fake-upstream';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { CooldownTracker } from '../../../src/gateway/providers/cloud/fallback';
import { OpenAICompatLLMProvider } from '../../../src/gateway/providers/cloud/openai-compat/openai-compat-llm';
import { HEDGE_CAP_HEADER, hedgeCapOf, SUBREQUEST_HEADER, SUBREQUEST_TOKEN } from '../../../src/gateway/proxy/internal-subrequest';
import { routeRequest, type RouteTarget } from '../../../src/gateway/proxy/provider-routing';
import { handleChatCompletions } from '../../../src/gateway/proxy/routes/chat-completions';
import { loopbackStages } from '../../../src/s2s/loopback-stages';

interface Fake { providerId: string; isConfigured(): boolean; call: ReturnType<typeof vi.fn> }
const fake = (providerId: string, impl: (signal: AbortSignal) => Promise<string>): Fake => ({ providerId, isConfigured: () => true, call: vi.fn(impl) });
const hang = (signal: AbortSignal) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
const after = (ms: number, v: string) => () => new Promise<string>((r) => setTimeout(() => r(v), ms));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function run(targets: Array<RouteTarget<Fake>>, hedgeCapMs?: number) {
  return routeRequest(targets, (t, signal) => t.provider.call(signal), {
    stage: 'test', cooldownTracker: new CooldownTracker(), breakers: new CircuitBreakerRegistry(), timeoutMs: 15_000, budgetMs: 8_000, hedgeCapMs,
  });
}

describe('stage budget of a composed turn (x-gateway-hedge-ms)', () => {
  it('only the gateway\'s own sub-request may set it', () => {
    expect(hedgeCapOf({ [SUBREQUEST_HEADER]: SUBREQUEST_TOKEN, [HEDGE_CAP_HEADER]: '1300' })).toBe(1_300);
    expect(hedgeCapOf({ [HEDGE_CAP_HEADER]: '1300' })).toBe(0);
    expect(hedgeCapOf({ [SUBREQUEST_HEADER]: 'guess', [HEDGE_CAP_HEADER]: '1300' })).toBe(0);
    expect(hedgeCapOf({ [SUBREQUEST_HEADER]: SUBREQUEST_TOKEN })).toBe(0);
  });

  it('a stalled cloud link is hedged at the cap, not after the 4 s cloud hedge', async () => {
    const t0 = Date.now();
    const { result, headers } = await run([
      { providerId: 'openrouter', provider: fake('openrouter', hang), model: 'whisper' },
      { providerId: 'groq', provider: fake('groq', after(20, 'ouvi')), model: 'whisper' },
    ], 120);
    expect(result).toBe('ouvi');
    expect(Date.now() - t0).toBeLessThan(600);
    expect(headers).toMatchObject({ 'X-Gateway-Provider': 'groq:whisper', 'X-Gateway-Fallback': 'slow' });
  });

  it('a deployment link without a hedge of its own gets the cap; a shorter own hedge stays', async () => {
    const t0 = Date.now();
    await run([{ providerId: 'deployment:stt', provider: fake('deployment:stt', hang), timeoutMs: 5_000 }, { providerId: 'groq', provider: fake('groq', after(20, 'ouvi')) }], 120);
    expect(Date.now() - t0).toBeLessThan(600);
    const t1 = Date.now();
    await run([{ providerId: 'deployment:stt', provider: fake('deployment:stt', hang), hedgeAfterMs: 40 }, { providerId: 'groq', provider: fake('groq', after(20, 'ouvi')) }], 2_000);
    expect(Date.now() - t1).toBeLessThan(600);
  });

  it('the first link still wins when it answers inside the cap', async () => {
    const second = fake('groq', after(10, 'segundo'));
    const { result } = await run([{ providerId: 'openrouter', provider: fake('openrouter', after(30, 'primeiro')) }, { providerId: 'groq', provider: second }], 300);
    expect(result).toBe('primeiro');
    expect(second.call).not.toHaveBeenCalled();
  });

  it('the loopback stage client sends the cap on each stage call, and nothing without one', async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen.push(new Headers(init?.headers).get(HEDGE_CAP_HEADER));
      return new Response(JSON.stringify({ text: 'oi' }), { status: 200 });
    }) as typeof fetch;
    const stages = loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: { stt: 's', chat: 'c', tts: 't' } });
    const signal = new AbortController().signal;
    await stages.transcribe(new Uint8Array([1]), 'audio/wav', {}, signal, 1_300.4);
    await stages.chatStream([], {}, signal, 1_000);
    await stages.speak('Oi.', {}, signal, 1_000);
    await stages.transcribe(new Uint8Array([1]), 'audio/wav', {}, signal);
    expect(seen).toEqual(['1300', '1000', '1000', null]);
  });

  it('chat stream: no first token inside the cap → the next link takes over (was the 4 s cloud hedge)', async () => {
    const env = { ...process.env };
    process.env.FAULT_REGRESSION_KEY = 'fake-key-for-the-fake-upstream';
    const upstream = await startFakeUpstream();
    try {
      upstream.setFaults({ a: { kind: 'no-answer' }, b: { kind: 'ok', text: 'resposta do fallback' } });
      const or = new OpenAICompatLLMProvider({ providerId: 'openrouter', baseURL: `${upstream.url}/or`, envKey: 'FAULT_REGRESSION_KEY' });
      const t0 = Date.now();
      const res = await handleChatCompletions(
        {
          method: 'POST', url: '/v1/chat/completions', headers: { [SUBREQUEST_HEADER]: SUBREQUEST_TOKEN, [HEDGE_CAP_HEADER]: '300' }, rawBody: Buffer.alloc(0),
          body: { model: 'm', stream: true, messages: [{ role: 'user', content: 'oi, turno com prazo' }] },
        },
        {}, undefined, undefined, undefined, undefined, undefined,
        { chatRoutes: { m: [{ providerId: 'openrouter', provider: or, model: 'a' }, { providerId: 'openrouter', provider: or, model: 'b' }] }, circuitBreakers: new CircuitBreakerRegistry(), cooldownTracker: new CooldownTracker() },
      );
      const text = await new Response(res.stream!).text();
      expect(text).toContain('"model":"b"');
      expect(text).toContain('fallback');
      expect(Date.now() - t0).toBeLessThan(1_500);
    } finally {
      process.env = { ...env };
      await Promise.race([upstream.close(), sleep(500)]);
    }
  });
});
