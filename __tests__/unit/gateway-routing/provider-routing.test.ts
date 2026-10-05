import { describe, expect, it, vi } from 'vitest';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { CooldownTracker } from '../../../src/gateway/providers/cloud/fallback';
import {
  errorResponse, ProviderUnavailableError, redactSecrets, routeRequest, selectTargets, type RouteTarget,
} from '../../../src/gateway/proxy/provider-routing';

interface Fake { providerId: string; isConfigured(): boolean; call: ReturnType<typeof vi.fn> }

function fake(providerId: string, impl: () => Promise<string>, configured = true): Fake {
  return { providerId, isConfigured: () => configured, call: vi.fn(impl) };
}

function httpError(status: number, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status });
}

const target = (p: Fake, model?: string): RouteTarget<Fake> => ({ providerId: p.providerId, provider: p, ...(model ? { model } : {}) });
const run = (targets: Array<RouteTarget<Fake>>, breakers = new CircuitBreakerRegistry()) =>
  routeRequest(targets, (t) => t.provider.call(t.model), { stage: 'test', breakers, cooldownTracker: new CooldownTracker() });

describe('routeRequest — fallback across different providers', () => {
  it.each([401, 402, 403, 429, 500, 503])('moves to the next provider on HTTP %i', async (status) => {
    const a = fake('groq', () => Promise.reject(httpError(status)));
    const b = fake('openrouter', () => Promise.resolve('ok'));
    const { result, headers } = await run([target(a, 'm1'), target(b, 'm2')]);
    expect(result).toBe('ok');
    expect(b.call).toHaveBeenCalledWith('m2');
    expect(headers['X-Gateway-Provider']).toBe('openrouter:m2');
    expect(headers['X-Gateway-Fallback-From']).toBe('groq:m1');
  });

  it('skips a provider without key and says so in X-Gateway-Fallback', async () => {
    const a = fake('groq', () => Promise.resolve('never'), false);
    const b = fake('openrouter', () => Promise.resolve('ok'));
    const { headers } = await run([target(a, 'm'), target(b, 'm')]);
    expect(a.call).not.toHaveBeenCalled();
    expect(headers['X-Gateway-Fallback']).toBe('not_configured');
  });

  it('reports auth / rate_limited / 5xx codes of the primary', async () => {
    for (const [status, code] of [[401, 'auth'], [429, 'rate_limited'], [502, '5xx']] as const) {
      const a = fake('deployment:x', () => Promise.reject(httpError(status)));
      const b = fake('openrouter', () => Promise.resolve('ok'));
      const { headers } = await run([target(a), target(b, 'm')]);
      expect(headers['X-Gateway-Fallback']).toBe(code);
      expect(headers['X-Gateway-Fallback-From']).toBe('deployment:x');
    }
  });

  it('passes a real client error (400) through instead of trying other providers', async () => {
    const a = fake('groq', () => Promise.reject(httpError(400, 'invalid role')));
    const b = fake('openrouter', () => Promise.resolve('ok'));
    await expect(run([target(a), target(b)])).rejects.toMatchObject({ status: 400 });
    expect(b.call).not.toHaveBeenCalled();
  });

  it('throws ProviderUnavailableError with one reason per provider when all fail', async () => {
    const a = fake('groq', () => Promise.resolve('x'), false);
    const b = fake('openrouter', () => Promise.reject(httpError(401, 'Invalid API key')));
    const err = await run([target(a), target(b)]).catch(e => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.reasons).toEqual(['groq: GROQ_API_KEY is not set', 'openrouter failed (HTTP 401): Invalid API key']);
  });

  it('skips a provider whose circuit is open, and tries it again after the cooldown', async () => {
    let now = 0;
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 1_000, now: () => now });
    const dep = fake('deployment:x', () => Promise.reject(httpError(503)));
    const or = fake('openrouter', () => Promise.resolve('ok'));
    await run([target(dep), target(or)], breakers);
    await run([target(dep), target(or)], breakers);
    expect(dep.call).toHaveBeenCalledTimes(2);
    const third = await run([target(dep), target(or)], breakers);
    expect(dep.call).toHaveBeenCalledTimes(2);
    expect(third.headers['X-Gateway-Fallback']).toBe('circuit_open');
    now = 1_500;
    dep.call.mockImplementation(() => Promise.resolve('back'));
    expect((await run([target(dep), target(or)], breakers)).result).toBe('back');
  });
});

describe('503 provider_unavailable', () => {
  it('names the missing key and never the key value', () => {
    const env = { OPENROUTER_API_KEY: 'sk-or-v1-supersecretvalue123' };
    const res = errorResponse(
      new ProviderUnavailableError(['openrouter failed (HTTP 401): bad key sk-or-v1-supersecretvalue123', 'groq: GROQ_API_KEY is not set']),
      'chat', 'm',
    );
    expect(res.status).toBe(503);
    const body = JSON.stringify(res.body);
    expect(body).toContain('provider_unavailable');
    expect(body).toContain('GROQ_API_KEY is not set');
    expect(body).not.toContain(env.OPENROUTER_API_KEY);
  });

  it('redactSecrets removes env key values, key shapes and URLs', () => {
    const env = { MY_TOKEN: 'abcdefgh12345678' };
    const out = redactSecrets('t=abcdefgh12345678 gsk_ABCDEFGH1234 sk-proj-xyz12345678 Bearer qwertyuiop https://x.y/z', env);
    expect(out).not.toMatch(/abcdefgh12345678|gsk_ABCD|sk-proj|qwertyuiop|https:/);
  });

  it('selectTargets keeps only configured providers', () => {
    const { usable, skipped } = selectTargets([target(fake('groq', async () => '', false)), target(fake('openrouter', async () => ''))], new CircuitBreakerRegistry());
    expect(usable.map(t => t.providerId)).toEqual(['openrouter']);
    expect(skipped).toEqual(['groq: GROQ_API_KEY is not set']);
  });
});
