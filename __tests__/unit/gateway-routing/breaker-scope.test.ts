/**
 * Circuit breakers are per stage + target, not per provider.
 *
 * Production stress 2026-10-06 (after PR #35): five 8 s timeouts of OpenRouter's STT model opened the one `openrouter`
 * breaker, and every chat and TTS request routed to OpenRouter answered 503 "openrouter: circuit open after repeated
 * failures" for 30 s. A timeout says something about one upstream model in one stage; only account failures (key
 * rejected 401, no credit 402) are provider-wide.
 */
import { describe, expect, it, vi } from 'vitest';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import type { LLMProvider } from '../../../src/gateway/providers/cloud/types';
import {
  accountBreakerKey, breakerKey, ProviderUnavailableError, resetProviderBreakers, routeRequest, type RouteTarget,
} from '../../../src/gateway/proxy/provider-routing';
import { handleChatCompletions } from '../../../src/gateway/proxy/routes/chat-completions';
import type { ProxyRequest } from '../../../src/gateway/proxy/types';

interface Fake { providerId: string; isConfigured(): boolean }
const openrouter: Fake = { providerId: 'openrouter', isConfigured: () => true };
const target = (model: string): RouteTarget<Fake> => ({ providerId: 'openrouter', provider: openrouter, model });
const hang = () => new Promise<string>(() => {});
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** One request of `stage` on `model`, answered by `call`. */
function route(stage: string, model: string, call: () => Promise<string>, breakers: CircuitBreakerRegistry) {
  return routeRequest([target(model)], () => call(), { stage, timeoutMs: 5, breakers });
}

function chatRequest(model: string, stream = false): ProxyRequest {
  return { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0),
    body: { model, stream, messages: [{ role: 'user', content: 'oi' }] } };
}

const llm = (answer: () => Promise<string>, stream?: () => AsyncGenerator<string>): LLMProvider => ({
  providerId: 'openrouter', isConfigured: () => true,
  chat: vi.fn(async () => ({ content: await answer(), model: 'm' })),
  ...(stream ? { chatStream: stream } : {}),
} as LLMProvider);

describe('breaker scope: stage + provider + model', () => {
  it('five STT timeouts open the STT breaker only: chat and TTS of the same provider keep answering', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 5, resetTimeoutMs: 30_000 });
    for (let i = 0; i < 5; i++) await expect(route('stt', 'stt-model', hang, breakers)).rejects.toBeInstanceOf(ProviderUnavailableError);
    // The STT model itself is now skipped without a call…
    const sttCall = vi.fn(() => Promise.resolve('never'));
    await expect(route('stt', 'stt-model', sttCall, breakers)).rejects.toThrow(/circuit open/);
    expect(sttCall).not.toHaveBeenCalled();

    // …while TTS on the same provider is untouched,
    expect((await route('tts', 'tts-model', () => Promise.resolve('audio'), breakers)).result).toBe('audio');
    // and so is chat, non-stream and stream (the stream path keys its breaker the same way).
    const chatRoutes = { 'parle-llm': [{ providerId: 'openrouter', provider: llm(async () => 'bom dia'), model: 'llm-model' }] };
    const res = await handleChatCompletions(chatRequest('parle-llm'), {}, undefined, undefined, undefined, undefined, undefined,
      { chatRoutes, circuitBreakers: breakers });
    expect(res.status).toBe(200);
    const streamRoutes = { 'parle-llm': [{ providerId: 'openrouter', provider: llm(async () => '', async function* () { yield 'olá'; }), model: 'llm-model' }] };
    const streamed = await handleChatCompletions(chatRequest('parle-llm', true), {}, undefined, undefined, undefined, undefined, undefined,
      { chatRoutes: streamRoutes, circuitBreakers: breakers });
    expect(await new Response(streamed.stream).text()).toContain('olá');

    expect(breakers.get(breakerKey('stt', target('stt-model'))).isOpen()).toBe(true);
    expect(breakers.get(breakerKey('tts', target('tts-model'))).isOpen()).toBe(false);
    expect(breakers.get(breakerKey('llm', target('llm-model'))).isOpen()).toBe(false);
  });

  it('another model of the same provider and stage stays usable after one model timed out five times', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 5, resetTimeoutMs: 30_000 });
    for (let i = 0; i < 5; i++) await expect(route('llm', 'slow-model', hang, breakers)).rejects.toBeInstanceOf(ProviderUnavailableError);
    const other = vi.fn(() => Promise.resolve('ok'));
    expect((await route('llm', 'other-model', other, breakers)).result).toBe('ok');
    expect(other).toHaveBeenCalledTimes(1);
    // A chain slow-model → other-model of one provider falls through at once instead of answering 503.
    const both = await routeRequest([target('slow-model'), target('other-model')], (t) => (t.model === 'slow-model' ? hang() : Promise.resolve('fallback')),
      { stage: 'llm', timeoutMs: 5, breakers });
    expect(both.result).toBe('fallback');
    expect(both.headers['X-Gateway-Fallback']).toBe('circuit_open');
  });

  it('a stream that keeps breaking mid-answer opens the breaker of that chat model only', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 30_000 });
    const breaking = llm(async () => '', async function* () { yield 'Olá'; throw new Error('Provider disconnected'); });
    for (let i = 0; i < 2; i++) {
      const res = await handleChatCompletions(chatRequest('a', true), {}, undefined, undefined, undefined, undefined, undefined,
        { chatRoutes: { a: [{ providerId: 'openrouter', provider: breaking, model: 'model-a' }] }, circuitBreakers: breakers });
      await new Response(res.stream).text();
    }
    expect(breakers.get(breakerKey('chat', target('model-a'))).getStats().state).toBe('open');
    const res = await handleChatCompletions(chatRequest('b'), {}, undefined, undefined, undefined, undefined, undefined,
      { chatRoutes: { b: [{ providerId: 'openrouter', provider: llm(async () => 'fine'), model: 'model-b' }] }, circuitBreakers: breakers });
    expect(res.status).toBe(200);
  });
});

describe('breaker scope: account failures are provider-wide', () => {
  it('a rejected key (401) five times in a row skips the provider in every stage until a success', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 5, resetTimeoutMs: 30_000 });
    for (let i = 0; i < 5; i++) await expect(route('stt', 'stt-model', () => Promise.reject(httpError(401)), breakers)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(breakers.get(accountBreakerKey('openrouter')).isOpen()).toBe(true);
    const tts = vi.fn(() => Promise.resolve('audio'));
    await expect(route('tts', 'tts-model', tts, breakers)).rejects.toThrow(/circuit open/);
    expect(tts).not.toHaveBeenCalled();
  });

  it('timeouts and 5xx never feed the account breaker; a key change resets every breaker of the provider', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 30_000 });
    for (let i = 0; i < 3; i++) await expect(route('stt', 'stt-model', () => Promise.reject(httpError(502)), breakers)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(breakers.get(accountBreakerKey('openrouter')).getStats().failures).toBe(0);
    for (let i = 0; i < 2; i++) await expect(route('tts', 'tts-model', () => Promise.reject(httpError(402)), breakers)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(breakers.get(accountBreakerKey('openrouter')).isOpen()).toBe(true);
    breakers.get(breakerKey('stt', { providerId: 'groq', model: 'whisper' })).recordFailure();
    breakers.get(breakerKey('stt', { providerId: 'groq', model: 'whisper' })).recordFailure();

    resetProviderBreakers('openrouter', breakers);
    expect(breakers.get(accountBreakerKey('openrouter')).isOpen()).toBe(false);
    expect(breakers.get(breakerKey('stt', target('stt-model'))).isOpen()).toBe(false);
    expect(breakers.get(breakerKey('tts', target('tts-model'))).isOpen()).toBe(false);
    // Another provider's breakers are left alone.
    expect(breakers.get(breakerKey('stt', { providerId: 'groq', model: 'whisper' })).isOpen()).toBe(true);
  });

  it('deployments keep one breaker per stage and deployment (no account breaker)', () => {
    expect(breakerKey('tts', { providerId: 'deployment:parle-speech', model: 'q' })).toBe('tts:deployment:parle-speech');
    expect(breakerKey('llm', { providerId: 'openrouter', model: 'google/gemma:free' })).toBe('chat:openrouter:google/gemma:free');
  });
});
