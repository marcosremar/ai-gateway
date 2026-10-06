/**
 * Field-run regressions (parle A1 lesson through the gateway, 2026-10-05): a hung deployment made TTS arrive at
 * 14.6–15 s (parle cuts at 15 s) and chat at 11.7 s (cut at 12 s); cold failures opened the circuit; the half-open
 * probe cost the student 10 s every 30 s; an unmapped org/model with a bad key answered 404.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildServeProviders, DEPLOYMENT_FIRST_BYTE_MS, type ServeInstances } from '../../../src/config/serve-providers';
import { DeploymentError } from '../../../src/deployments/controller';
import { DeploymentLLMProvider } from '../../../src/deployments/inference-providers';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { CooldownTracker } from '../../../src/gateway/providers/cloud/fallback';
import type { LLMProvider } from '../../../src/gateway/providers/cloud/types';
import { breakerKey, routeRequest, stageBudgetMs, type RouteTarget } from '../../../src/gateway/proxy/provider-routing';
import { handleChatCompletions } from '../../../src/gateway/proxy/routes/chat-completions';
import type { ProxyRequest } from '../../../src/gateway/proxy/types';
import { parleRoutes } from './_parle-routes';

interface Fake { providerId: string; isConfigured(): boolean; call: ReturnType<typeof vi.fn> }
const fake = (providerId: string, impl: (signal: AbortSignal) => Promise<string>): Fake =>
  ({ providerId, isConfigured: () => true, call: vi.fn(impl) });
const hang = (signal: AbortSignal) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
const after = (ms: number, v: string) => () => new Promise<string>((r) => setTimeout(() => r(v), ms));

function run(targets: Array<RouteTarget<Fake>>, opts: { budgetMs?: number; breakers?: CircuitBreakerRegistry; timeoutMs?: number } = {}) {
  return routeRequest(targets, (t, signal) => t.provider.call(signal), {
    stage: 'test', cooldownTracker: new CooldownTracker(), breakers: opts.breakers ?? new CircuitBreakerRegistry(),
    timeoutMs: opts.timeoutMs ?? 15_000, budgetMs: opts.budgetMs,
  });
}

describe('hung deployment: hedge + first-byte timeout + stage budget', () => {
  it('hedges to the fallback after hedgeAfterMs and aborts the hung replica call', async () => {
    let aborted = false;
    const dep = fake('deployment:tts', (s) => { s.addEventListener('abort', () => { aborted = true; }); return hang(s); });
    const or = fake('openrouter', after(30, 'kokoro'));
    const t0 = Date.now();
    const { result, headers } = await run([{ providerId: dep.providerId, provider: dep, timeoutMs: 3_000, hedgeAfterMs: 50 }, { providerId: 'openrouter', provider: or, model: 'k' }]);
    expect(result).toBe('kokoro');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(headers).toMatchObject({ 'X-Gateway-Provider': 'openrouter:k', 'X-Gateway-Fallback': 'slow', 'X-Gateway-Fallback-From': 'deployment:tts' });
  });

  it('the deployment still wins when it answers before the hedged fallback', async () => {
    const dep = fake('deployment:tts', after(80, 'qwen'));
    const or = fake('openrouter', after(300, 'kokoro'));
    const { result } = await run([{ providerId: dep.providerId, provider: dep, hedgeAfterMs: 50 }, { providerId: 'openrouter', provider: or }]);
    expect(result).toBe('qwen');
  });

  it('everything slow: the 503 comes at the stage budget, not after deployment timeout + fallback timeout', async () => {
    const t0 = Date.now();
    const err = await run([
      { providerId: 'deployment:tts', provider: fake('deployment:tts', hang), timeoutMs: 10_000 },
      { providerId: 'openrouter', provider: fake('openrouter', hang) },
    ], { budgetMs: 300 }).catch(e => e);
    expect(err.name).toBe('ProviderUnavailableError');
    expect(Date.now() - t0).toBeLessThan(700);
  });

  it('defaults: deployment first byte STT/chat 4 s, TTS 3 s, hedge 1.5 s, stage budget 8 s (parle cuts TTS at 15 s, chat at 12 s)', () => {
    expect(DEPLOYMENT_FIRST_BYTE_MS).toEqual({ stt: 4_000, chat: 4_000, tts: 3_000 });
    expect(stageBudgetMs('tts', {})).toBe(8_000);
    expect(stageBudgetMs('chat', { GATEWAY_CHAT_BUDGET_MS: '6000' })).toBe(6_000);
    const p = { providerId: 'x', isConfigured: () => true } as never;
    const instances: ServeInstances = { chat: { openrouter: p }, stt: { openrouter: p }, tts: { openrouter: p } };
    const { providers } = buildServeProviders({ instances, openrouter: { state: 'valid' }, deploymentProvider: () => p, env: { DEPLOYMENT_TTS_TIMEOUT_MS: '2500' }, appRoutes: parleRoutes() });
    expect(providers.tts!['parle-tts'][0]).toMatchObject({ timeoutMs: 2_500, hedgeAfterMs: 1_500 });
    expect(providers.chatRoutes!['parle-llm'][0]).toMatchObject({ timeoutMs: 4_000, hedgeAfterMs: 1_500 });
  });
});

describe('circuit breaker', () => {
  it('the half-open recovery probe does not make the student wait: the fallback is hedged in, and a losing probe keeps the circuit open', async () => {
    let now = 0;
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeoutMs: 1_000, now: () => now });
    breakers.get(breakerKey('test', { providerId: 'deployment:tts' })).recordFailure();
    expect(breakers.get(breakerKey('test', { providerId: 'deployment:tts' })).getStats().state).toBe('open');
    now = 2_000; // cooldown over → next request probes
    const dep = fake('deployment:tts', hang);
    const t0 = Date.now();
    const { result } = await run([{ providerId: dep.providerId, provider: dep, timeoutMs: 10_000, hedgeAfterMs: 50 }, { providerId: 'openrouter', provider: fake('openrouter', after(10, 'ok')) }], { breakers });
    expect(result).toBe('ok');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(dep.call).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 10)); // the aborted probe settles right after the answer
    expect(breakers.get(breakerKey('test', { providerId: 'deployment:tts' })).getStats().state).toBe('open');
  });

  it('cold failures do not open the circuit; when the replica is ready, the very next request uses it', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    let ready = false;
    const lease = { machine: { id: 'm', ip: '10.0.0.1' }, token: 't', done: vi.fn() };
    const ctl = {
      get: vi.fn(() => ({ status: ready ? 'ready' : 'warming' }) as never), wake: vi.fn(),
      acquire: vi.fn(async () => { if (!ready) throw new DeploymentError(503, 'starting', 30); return lease as never; }),
    };
    const fetchImpl = vi.fn(async () => Response.json({ choices: [{ message: { content: 'do deployment' } }] }));
    const dep = new DeploymentLLMProvider(ctl, 'parle-speech', { fetchImpl: fetchImpl as never });
    const or: LLMProvider = { providerId: 'openrouter', isConfigured: () => true, chat: vi.fn(async () => ({ content: 'reserva', model: 'm' })) };
    const cooldownTracker = new CooldownTracker();
    const ask = () => handleChatCompletions(
      { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0), body: { model: 'parle-llm', messages: [{ role: 'user', content: 'oi' }] } },
      {}, undefined, undefined, undefined, undefined, undefined,
      { chatRoutes: { 'parle-llm': [{ providerId: 'deployment:parle-speech', provider: dep, model: 'q' }, { providerId: 'openrouter', provider: or, model: 'm' }] }, circuitBreakers: breakers, cooldownTracker });
    for (let i = 0; i < 6; i++) expect((await ask()).headers?.['X-Gateway-Fallback']).toBe('cold');
    expect(breakers.get(breakerKey('chat', { providerId: 'deployment:parle-speech' })).getStats().state).toBe('closed');
    ready = true;
    const res = await ask();
    expect(res.headers?.['X-Gateway-Provider']).toBe('deployment:parle-speech');
  });
});

describe('unmapped org/model with an unusable OpenRouter key', () => {
  it('answers 503 provider_unavailable naming the key, not 404', async () => {
    const p = { providerId: 'openrouter', isConfigured: () => true, chat: vi.fn() } as never;
    const instances: ServeInstances = { chat: { openrouter: p }, stt: {}, tts: {} };
    const { providers } = buildServeProviders({ instances, openrouter: { state: 'invalid', detail: 'HTTP 401' } });
    const req: ProxyRequest = { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0),
      body: { model: 'google/gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'oi' }] } };
    const res = await handleChatCompletions(req, {}, undefined, undefined, providers.chatFallbackChain, undefined, providers.chatDynamicRoutes,
      { chatRoutes: providers.chatRoutes, unavailable: providers.unavailable?.chat, circuitBreakers: new CircuitBreakerRegistry() });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain('OPENROUTER_API_KEY was rejected by OpenRouter (HTTP 401)');
    expect((p as { chat: ReturnType<typeof vi.fn> }).chat).not.toHaveBeenCalled();
  });
});
