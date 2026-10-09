import { describe, expect, it, vi } from 'vitest';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { routeRequest, type RouteTarget } from '../../../src/gateway/proxy/provider-routing';

interface Fake { providerId: string; isConfigured(): boolean }
const deployment: Fake = { providerId: 'deployment', isConfigured: () => true };
const target: RouteTarget<Fake> = { providerId: 'deployment', provider: deployment, model: 'parle-speech' };
const stageOut = () => Promise.reject(Object.assign(new Error("deployment 'parle-speech': stage stt out"), { status: 503, gatewayCode: 'circuit_open' }));

describe('audit 2026-10-09: a replica stage taken out for 30 s does not also open the proxy breaker', () => {
  it('the deployment is tried again once its own stage cooldown is over', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 5, resetTimeoutMs: 30_000 });
    for (let i = 0; i < 5; i++) await expect(routeRequest([target], stageOut, { stage: 'stt', timeoutMs: 50, breakers })).rejects.toThrow();
    const served = vi.fn(() => Promise.resolve('texto'));
    const out = await routeRequest([target], served, { stage: 'stt', timeoutMs: 50, breakers });
    expect(out.result).toBe('texto');
  });
});
