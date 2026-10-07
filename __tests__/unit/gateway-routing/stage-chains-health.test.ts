/**
 * /health shows the effective chain of every app alias (here the parle's, as it PUTs them) and the state of each link, so a primary deployment that
 * never serves (the old silent `X-Gateway-Fallback: not_configured`) is visible.
 */

import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import { buildServeProviders, deepHealthReport, type ServeInstances } from '../../../src/config/serve-providers';
import { stageChainsReport } from '../../../src/config/stage-chains';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { accountBreakerKey, breakerKey } from '../../../src/gateway/proxy/provider-routing';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { parleRoutes } from './_parle-routes';

const on = (providerId: string) => ({ providerId, isConfigured: () => true }) as never;
const off = (providerId: string) => ({ providerId, isConfigured: () => false }) as never;

function build(opts: { deployments: boolean; openrouter?: 'valid' | 'missing' }) {
  const instances: ServeInstances = {
    chat: { openrouter: on('openrouter'), groq: off('groq') },
    stt: { openrouter: on('openrouter'), groq: off('groq') },
    tts: { openrouter: on('openrouter') },
  };
  return buildServeProviders({
    instances, openrouter: { state: opts.openrouter ?? 'valid' }, env: {}, appRoutes: parleRoutes(),
    ...(opts.deployments ? { deploymentProvider: () => on('self-hosted') } : {}),
  });
}

describe('stageChainsReport', () => {
  it('deployment never created: primary "missing", stage served by OpenRouter, one warning per stage', () => {
    const { chains } = build({ deployments: true });
    const { stages, warnings } = stageChainsReport(chains, { deploymentStatus: () => null });
    expect(stages.stt['parle-stt'].links[0]).toMatchObject({ target: 'deployment:parle-speech', state: 'missing' });
    expect(stages.stt['parle-stt'].links[0].reason).toMatch(/not_configured/);
    expect(stages.stt['parle-stt']).toMatchObject({ serving: 'openrouter:openai/whisper-large-v3-turbo', onFallback: true });
    expect(stages.stt['parle-stt'].links[2]).toMatchObject({ target: 'groq:whisper-large-v3-turbo', state: 'no_key' });
    expect(stages.chat['parle-llm'].serving).toBe('openrouter:qwen/qwen3.5-9b');
    expect(warnings.some(w => w.startsWith('stt parle-stt: primary deployment:parle-speech is missing'))).toBe(true);
    expect(warnings.some(w => w.startsWith('chat parle-llm'))).toBe(true);
  });

  it('declared but pending: the reason (missing credential) is shown', () => {
    const { chains } = build({ deployments: true });
    const { stages, warnings } = stageChainsReport(chains, {
      deploymentStatus: () => null, declaredPending: (n) => (n === 'parle-speech' ? 'GHCR_READ_TOKEN is not set' : null),
    });
    expect(stages.chat['parle-llm'].links[0]).toEqual({ target: 'deployment:parle-speech', state: 'pending', reason: 'GHCR_READ_TOKEN is not set' });
    expect(warnings.join('\n')).toMatch(/pending \(GHCR_READ_TOKEN is not set\)/);
  });

  it('scaled to zero is "cold" and not a warning; ready is the one serving', () => {
    const { chains } = build({ deployments: true });
    const cold = stageChainsReport(chains, { deploymentStatus: () => 'scaled-to-zero' });
    expect(cold.stages.stt['parle-stt'].links[0].state).toBe('cold');
    expect(cold.warnings).toEqual([]);
    const ready = stageChainsReport(chains, { deploymentStatus: () => 'ready' });
    expect(ready.stages.tts['parle-tts']).toMatchObject({ serving: 'deployment:parle-qwen-tts', onFallback: false });
  });

  it('deployments off: "disabled"; OpenRouter without key: "no_key" and nothing serving', () => {
    const { chains } = build({ deployments: false, openrouter: 'missing' });
    const { stages, warnings } = stageChainsReport(chains, {});
    expect(stages.stt['parle-stt'].links[0].state).toBe('disabled');
    expect(stages.stt['parle-stt'].links[1]).toMatchObject({ state: 'no_key', reason: expect.stringMatching(/OPENROUTER_API_KEY/) });
    expect(stages.stt['parle-stt'].serving).toBeNull();
    expect(warnings.join('\n')).toMatch(/no link can serve/);
  });

  it('an open breaker is reported on its own stage and model only', () => {
    const { chains } = build({ deployments: true });
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeoutMs: 30_000 });
    const sttLink = chains.stt['parle-stt'][1];
    expect(sttLink.providerId).toBe('openrouter');
    breakers.get(breakerKey('stt', sttLink)).recordFailure();
    const { stages } = stageChainsReport(chains, { deploymentStatus: () => 'ready', breakers });
    expect(stages.stt['parle-stt'].links[1].state).toBe('circuit_open');
    // The same provider in the other stages is not affected (production stress 2026-10-06).
    for (const stage of ['chat', 'tts'] as const) {
      for (const report of Object.values(stages[stage])) {
        for (const l of report.links) if (l.target.startsWith('openrouter:')) expect(l.state).not.toBe('circuit_open');
      }
    }
  });

  it('an open account breaker (401/402) is reported on every link of that provider', () => {
    const { chains } = build({ deployments: true });
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeoutMs: 30_000 });
    breakers.get(accountBreakerKey('openrouter')).recordFailure();
    const { stages } = stageChainsReport(chains, { deploymentStatus: () => 'ready', breakers });
    expect(stages.stt['parle-stt'].links[1].state).toBe('circuit_open');
    expect(stages.stt['parle-stt'].links[0].state).toBe('ready');
  });
});

describe('/health', () => {
  it('/health?details=1 (admin key) carries the chains; plain /health does not; deep health too', async () => {
    const built = build({ deployments: true });
    const details = () => stageChainsReport(built.chains, { deploymentStatus: () => null });
    const server = createProxyServer({
      apiKeys: ['admin-key-0123456789:owner'], providers: { stt: {}, chat: {}, tts: {} } as never, healthDetails: details,
      deepHealth: { authorize: (t) => t === 'admin-key-0123456789', report: async () => ({ status: 200, body: {} }) },
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const plain = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
      expect(plain.stages).toBeUndefined();
      expect(plain.warnings).toBeUndefined();
      const res = await fetch(`${base}/health?details=1`, { headers: { Authorization: 'Bearer admin-key-0123456789' } });
      const body = await res.json() as { status: string; stages: Record<string, unknown>; warnings: string[] };
      expect(res.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(Object.keys(body.stages).sort()).toEqual(['chat', 'stt', 'tts']);
      expect(body.warnings.length).toBeGreaterThan(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    }

    const deep = await deepHealthReport({
      env: {}, breakers: new CircuitBreakerRegistry(), providers: built.providers, chains: details,
      declared: () => [{ name: 'parle-speech', state: 'pending', reason: 'GHCR_READ_TOKEN is not set' }],
      fetchImpl: (async () => new Response('{}')) as never,
    });
    expect(deep.body).toMatchObject({ stages: expect.any(Object), declared: [{ name: 'parle-speech', state: 'pending' }] });
  });
});
