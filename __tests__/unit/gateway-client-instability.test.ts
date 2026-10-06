/**
 * GatewayClient instability log + report: while the gateway is unreachable or slow the client buffers what it saw
 * (unreachable, direct fallback, slow, recovered) and POSTs the batch to /v1/apps/:app/stability-report once the
 * gateway answers again.
 */

import { describe, expect, it } from 'vitest';
import { GatewayClient, type FallbackPlan, type InstabilityOptions } from '../../sdk/node';
import { connectionRefused, fakeFetch, json, type FakeHandler } from './_gateway-client-fakes';

const GW = 'http://gw.test';
const OR = 'https://or.test/api/v1';
const OR_KEY = 'sk-or-v1-plan-key-1';

function plan(): FallbackPlan {
  const or = { baseUrl: OR, apiKey: OR_KEY, keyKind: 'shared' as const, expiresAt: null, limitUsd: null };
  return {
    app: 'parle', issuedAt: '2026-10-06T10:00:00Z', ttlSeconds: 3600,
    providers: { openrouter: or }, openrouter: or,
    routes: { stt: {}, chat: { 'parle-llm': [{ provider: 'openrouter', model: 'qwen/qwen3.5-9b' }] }, tts: {} },
  };
}

const completion = (content: string) =>
  json({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const MSG = [{ role: 'user' as const, content: 'oi' }];
const flush = () => new Promise(r => setTimeout(r, 20));

async function setup(routes: Record<string, FakeHandler>, opts: { threshold?: number; instability?: InstabilityOptions; app?: string; slowMs?: number } = {}) {
  let t = 1_000_000;
  const f = fakeFetch({ [`GET ${GW}/v1/apps/parle/fallback`]: () => json(plan()), ...routes });
  const gw = new GatewayClient({
    baseUrl: GW, apiKey: 'gw-key', fetch: f.fetch, now: () => t,
    ...(opts.app ? { app: opts.app } : {}),
    directFallback: { app: 'parle', failureThreshold: opts.threshold ?? 3, cooldownMs: 30_000, ...(opts.slowMs ? { slowMs: opts.slowMs } : {}) },
    instability: { client: 'parle-backend', ...opts.instability },
  });
  await gw.refreshFallbackPlan();
  return { gw, f, advance: (ms: number) => { t += ms; } };
}

const reports = (f: ReturnType<typeof fakeFetch>) =>
  f.calls.filter(c => c.url.endsWith('/stability-report')).map(c => JSON.parse(String(c.body)) as { client: string; events: Array<{ kind: string }> });

describe('instability log + report', () => {
  it('buffers unreachable/direct/recovered and posts them to the gateway once it answers again', async () => {
    let gatewayUp = false;
    const { gw, f, advance } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => (gatewayUp ? completion('gw') : connectionRefused()),
      [`POST ${OR}/chat/completions`]: () => completion('direct'),
      [`GET ${GW}/health`]: () => (gatewayUp ? json({ status: 'ok' }) : connectionRefused()),
      [`POST ${GW}/v1/apps/parle/stability-report`]: () => json({ ok: true, accepted: 3 }),
    }, { threshold: 1 });

    // Gateway down → direct; events buffered, nothing posted yet (the gateway cannot receive it).
    await gw.chat({ model: 'parle-llm', messages: MSG });
    expect(gw.instabilityEvents().map(e => e.kind)).toEqual(['unreachable', 'direct']);
    expect(reports(f)).toHaveLength(0);

    // Cooldown over, gateway back: probe closes the breaker, the next call uses the gateway and reports.
    gatewayUp = true;
    advance(30_001);
    await gw.chat({ model: 'parle-llm', messages: MSG }); // still direct, probe in flight
    await (gw as unknown as { breaker: { probe: Promise<void> | null } }).breaker.probe;
    const back = await gw.chat({ model: 'parle-llm', messages: MSG });
    expect(back.choices[0].message.content).toBe('gw');
    await flush();

    expect(reports(f)).toHaveLength(1);
    const report = reports(f)[0];
    expect(report.client).toBe('parle-backend');
    expect(report.events.map(e => e.kind)).toEqual(['unreachable', 'direct', 'unreachable', 'recovered']);
    expect(report.events[0]).toMatchObject({ path: '/v1/chat/completions', code: 'network', route: 'direct' });
    expect(gw.instabilityEvents()).toHaveLength(0);
  });

  it('a gateway slower than slowMs counts as instability; after the threshold calls go direct', async () => {
    const { gw, f, advance } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => { advance(5_000); return completion('gw-slow'); },
      [`POST ${OR}/chat/completions`]: () => completion('direct'),
    }, { threshold: 1, slowMs: 1_000 });

    // Slow but successful: the answer is used, the slowness is logged and opens the breaker.
    const out = await gw.chat({ model: 'parle-llm', messages: MSG });
    expect(out.choices[0].message.content).toBe('gw-slow');
    expect(gw.instabilityEvents().map(e => e.kind)).toEqual(['slow']);
    expect(gw.instabilityEvents()[0].latencyMs).toBe(5_000);
    expect(gw.gatewayState().breaker).toBe('open');

    const next = await gw.chat({ model: 'parle-llm', messages: MSG });
    expect(next.served.provider).toBe('openrouter-direct:qwen/qwen3.5-9b');
    expect(f.calls.filter(c => c.url === `${GW}/v1/chat/completions`)).toHaveLength(1);
  });

  it('a failed report keeps the events for the next recovery', async () => {
    let gatewayUp = false;
    const { gw, f, advance } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => (gatewayUp ? completion('gw') : connectionRefused()),
      [`POST ${OR}/chat/completions`]: () => completion('direct'),
      [`GET ${GW}/health`]: () => (gatewayUp ? json({ status: 'ok' }) : connectionRefused()),
      [`POST ${GW}/v1/apps/parle/stability-report`]: () => json({ error: 'boom' }, 500),
    }, { threshold: 1 });

    await gw.chat({ model: 'parle-llm', messages: MSG });
    const buffered = gw.instabilityEvents().length;
    gatewayUp = true;
    advance(30_001);
    await gw.chat({ model: 'parle-llm', messages: MSG });
    await (gw as unknown as { breaker: { probe: Promise<void> | null } }).breaker.probe;
    await gw.chat({ model: 'parle-llm', messages: MSG });
    await flush();

    expect(reports(f)).toHaveLength(1);
    expect(gw.instabilityEvents().length).toBe(buffered + 2); // nothing dropped: +probe-skip +recovered
  });

  it('report: false never posts; reportInstabilities() still works by hand', async () => {
    const { gw, f } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => connectionRefused(),
      [`POST ${OR}/chat/completions`]: () => completion('direct'),
      [`POST ${GW}/v1/apps/parle/stability-report`]: () => json({ ok: true, accepted: 1 }),
    }, { threshold: 1, instability: { report: false } });

    await gw.chat({ model: 'parle-llm', messages: MSG });
    await flush();
    expect(reports(f)).toHaveLength(0);
    expect((await gw.reportInstabilities()).sent).toBe(2); // unreachable + direct
    expect(reports(f)).toHaveLength(1);
    expect(gw.instabilityEvents()).toHaveLength(0);
  });

  it('drops the oldest events past bufferSize', async () => {
    const { gw } = await setup({
      [`POST ${GW}/v1/chat/completions`]: () => connectionRefused(),
      [`POST ${OR}/chat/completions`]: () => completion('direct'),
    }, { threshold: 1, instability: { bufferSize: 3, report: false } });
    for (let i = 0; i < 5; i++) await gw.chat({ model: 'parle-llm', messages: MSG });
    expect(gw.instabilityEvents()).toHaveLength(3);
  });
});
