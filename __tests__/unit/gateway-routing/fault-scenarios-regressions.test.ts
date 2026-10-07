/**
 * Regressions of the fault bench round 2 (docs/reports/2026-10-07-fault-scenarios.md, scripts/fault-bench/scenarios.ts).
 * Each test failed on the commit before its fix and passes after it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { DeploymentLLMProvider, DeploymentSTTProvider, DeploymentTTSProvider } from '../../../src/deployments/inference-providers';
import { GatewayClient, type FallbackPlan } from '../../../sdk/node';
import { connectionRefused, fakeFetch, json } from '../_gateway-client-fakes';
import { startFakeUpstream } from '../../../scripts/fault-bench/fake-upstream';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { CooldownTracker } from '../../../src/gateway/providers/cloud/fallback';
import { OpenAICompatLLMProvider } from '../../../src/gateway/providers/cloud/openai-compat/openai-compat-llm';
import { handleChatCompletions } from '../../../src/gateway/proxy/routes/chat-completions';
import { cloudHedgeMs } from '../../../src/gateway/proxy/provider-routing';
import type { LLMProvider } from '../../../src/gateway/providers/cloud/types';
import type { RouteTarget } from '../../../src/gateway/proxy/types';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });

async function replica(app: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { void app(req, res); }); });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Controller double that records every lease and when it was released. */
function leaser(ip: string) {
  const leases: Array<{ done: ReturnType<typeof vi.fn> }> = [];
  return {
    leases,
    get: () => ({}) as never,
    wake: vi.fn(),
    acquire: vi.fn(async () => {
      const lease = { machine: { id: 'm1', ip } as never, token: 't', exposed: false, done: vi.fn() };
      leases.push(lease);
      return lease;
    }),
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('S1 — a replica that dies mid-answer is marked failed, and the lease covers the body', () => {
  it('chat: the body breaks after the headers → lease released ONCE, as failed (the replica is suspect)', async () => {
    const ip = await replica(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":[{"message":{"content":"meia res');
      await sleep(20);
      res.socket?.destroy();
    });
    const ctl = leaser(ip);
    await expect(new DeploymentLLMProvider(ctl, 'd').chat({ model: 'm', messages: [{ role: 'user', content: 'oi' }] })).rejects.toThrow();
    await sleep(10);
    expect(ctl.leases[0].done).toHaveBeenCalledTimes(1);
    expect(ctl.leases[0].done).toHaveBeenCalledWith(true);
  });

  it('chat: a whole answer releases the lease as healthy', async () => {
    const ip = await replica((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'olá' }, finish_reason: 'stop' }] }));
    });
    const ctl = leaser(ip);
    const out = await new DeploymentLLMProvider(ctl, 'd').chat({ model: 'm', messages: [{ role: 'user', content: 'oi' }] });
    expect(out.content).toBe('olá');
    expect(ctl.leases[0].done.mock.calls).toEqual([[false]]);
  });

  it('TTS stream: the lease is held while the audio streams and released as failed when the replica dies', async () => {
    const ip = await replica(async (req, res) => {
      if (req.url?.startsWith('/refs')) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'audio/wav' });
      for (let i = 0; i < 3; i++) { res.write(Buffer.alloc(1000, i)); await sleep(20); }
      res.socket?.destroy();
    });
    const ctl = leaser(ip);
    const out = await new DeploymentTTSProvider(ctl, 'd').synthesize({ model: 'tts', input: 'oi', voice: 'v', responseFormat: 'wav' });
    const speech = ctl.leases[ctl.leases.length - 1];
    expect(speech.done).not.toHaveBeenCalled(); // headers in, audio still coming: still in flight
    const reader = out.stream!.getReader();
    let bytes = 0;
    await expect((async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; bytes += value.length; } })()).rejects.toThrow();
    expect(bytes).toBeGreaterThan(0);
    expect(speech.done.mock.calls).toEqual([[true]]);
    // The catalog probe (404, read) released its own lease as healthy.
    expect(ctl.leases[0].done.mock.calls).toEqual([[false]]);
  });

  it('TTS stream: a listener that cancels, or a caller that gives up, releases the lease as cancelled (neutral)', async () => {
    const ip = await replica(async (req, res) => {
      if (req.url?.startsWith('/refs')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('no catalog here'); return; }
      res.writeHead(200, { 'content-type': 'audio/wav' });
      for (let i = 0; i < 50 && !res.destroyed; i++) { res.write(Buffer.alloc(1000, i)); await sleep(20); }
      res.end();
    });
    const ctl = leaser(ip);
    const tts = new DeploymentTTSProvider(ctl, 'd');
    const a = await tts.synthesize({ model: 'tts', input: 'oi', voice: 'v', responseFormat: 'wav' });
    // The non-JSON catalog answer is not read: its body is cancelled at once (neutral), so it does not hold a lease.
    expect(ctl.leases[0].done.mock.calls).toEqual([['cancelled']]);
    await a.stream!.cancel();
    expect(ctl.leases[1].done.mock.calls).toEqual([['cancelled']]);
    const abort = new AbortController();
    const b = await tts.synthesize({ model: 'tts', input: 'oi', voice: 'v', responseFormat: 'wav', signal: abort.signal });
    const lease = ctl.leases[ctl.leases.length - 1];
    abort.abort();
    await sleep(10);
    expect(lease.done.mock.calls).toEqual([['cancelled']]);
    await b.stream!.cancel().catch(() => {});
  });

  it('a body nobody reads does not hold the lease forever: released (cancelled, neutral) after the call timeout', async () => {
    const ip = await replica(async (req, res) => {
      if (req.url?.startsWith('/refs')) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.write(Buffer.alloc(100));
    });
    const ctl = leaser(ip);
    await new DeploymentTTSProvider(ctl, 'd', { timeoutMs: 150 }).synthesize({ model: 'tts', input: 'oi', voice: 'v', responseFormat: 'wav' });
    const speech = ctl.leases[ctl.leases.length - 1];
    expect(speech.done).not.toHaveBeenCalled();
    await sleep(250);
    expect(speech.done.mock.calls).toEqual([['cancelled']]);
  });

  it('STT: a transcription read whole releases its lease once, healthy', async () => {
    const ip = await replica((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"text":"bom dia"}'); });
    const ctl = leaser(ip);
    const out = await new DeploymentSTTProvider(ctl, 'd').transcribe({ model: 'w', audio: Buffer.from([1, 2, 3]) });
    expect(out.text).toBe('bom dia');
    expect(ctl.leases[0].done.mock.calls).toEqual([[false]]);
  });
});

describe('S2/S3 — SDK with a keyless fallback plan: never skips a gateway that is back, and says why it failed', () => {
  const GW = 'http://gw.test';
  /** The plan the gateway hands out without OPENROUTER_PROVISIONING_KEY (and without APP_FALLBACK_SHARE_KEY). */
  const keyless: FallbackPlan = {
    app: 'parle', issuedAt: '2026-10-07T00:00:00Z', ttlSeconds: 3600, providers: {}, openrouter: null, routes: { stt: {}, chat: {}, tts: {} },
  };
  const minted: FallbackPlan = {
    ...keyless,
    providers: { openrouter: { baseUrl: 'https://or.test/api/v1', apiKey: 'sk-or-minted', keyKind: 'provisioned', expiresAt: null, limitUsd: 5 } },
    routes: { stt: {}, chat: { 'parle-llm': [{ provider: 'openrouter', model: 'qwen/qwen3.5-9b' }] }, tts: {} },
  };
  const completion = json({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'oi' }, finish_reason: 'stop' }] });

  async function client(plan: FallbackPlan) {
    let up = false;
    let t = 1_000_000;
    const f = fakeFetch({
      [`GET ${GW}/v1/apps/parle/fallback`]: () => json(plan),
      [`GET ${GW}/health`]: () => (up ? json({ status: 'ok' }) : connectionRefused()),
      [`POST ${GW}/v1/chat/completions`]: () => (up ? completion.clone() : connectionRefused()),
      [`POST ${GW}/v1/s2s`]: () => (up ? new Response(new Uint8Array(0), { headers: { 'content-type': 'application/x-aigw-s2s' } }) : connectionRefused()),
      'POST https://or.test/api/v1/chat/completions': () => completion.clone(),
    });
    const gw = new GatewayClient({
      baseUrl: GW, apiKey: 'k', fetch: f.fetch, now: () => t, directFallback: { app: 'parle', failureThreshold: 3, cooldownMs: 30_000 },
    });
    await gw.refreshFallbackPlan();
    return { gw, f, setUp: (v: boolean) => { up = v; }, advance: (ms: number) => { t += ms; } };
  }
  const chat = (gw: GatewayClient) => gw.chat({ model: 'parle-llm', messages: [{ role: 'user', content: 'oi' }] });

  it('keyless: the breaker opens while the gateway is down, and the first call after it is back is served (no 30 s skip)', async () => {
    const x = await client(keyless);
    for (let i = 0; i < 4; i++) await expect(chat(x.gw)).rejects.toMatchObject({ unreachable: true });
    expect(x.gw.gatewayState().breaker).toBe('open');
    x.setUp(true);
    x.advance(1_000); // well inside the 30 s cooldown
    const out = await chat(x.gw);
    expect(out.choices[0].message.content).toBe('oi');
    expect(x.gw.gatewayState()).toMatchObject({ breaker: 'closed', route: 'gateway' });
  });

  it('keyless s2s: the same — a gateway that is back serves the turn instead of "skipped (breaker open)"', async () => {
    const x = await client(keyless);
    for (let i = 0; i < 4; i++) await expect(chat(x.gw)).rejects.toMatchObject({ unreachable: true });
    x.setUp(true);
    x.advance(1_000);
    await expect(x.gw.s2s({ file: new Uint8Array([1]), config: { language: 'pt' } })).resolves.toBeDefined();
  });

  it('keyless, gateway still down: fails fast with an error that says there is no direct fallback and why', async () => {
    const x = await client(keyless);
    for (let i = 0; i < 3; i++) await chat(x.gw).catch(() => {});
    const t0 = Date.now();
    const err = await chat(x.gw).catch((e: Error) => e);
    expect(Date.now() - t0).toBeLessThan(500);
    expect((err as Error).message).toMatch(/no direct fallback: the fallback plan has no provider key for chat 'parle-llm'/);
    expect(err).toMatchObject({ code: expect.any(String), unreachable: true });
  });

  it('keyless, gateway still down: a failed probe answers for the next second (a hung gateway does not cost every call a probe)', async () => {
    const x = await client(keyless);
    for (let i = 0; i < 4; i++) await chat(x.gw).catch(() => {});
    const probes = () => x.f.calls.filter(c => c.url === `${GW}/health`).length;
    const before = probes();
    await chat(x.gw).catch(() => {});
    expect(probes()).toBe(before);
    x.advance(1_000);
    await chat(x.gw).catch(() => {});
    expect(probes()).toBe(before + 1);
  });

  it('minted key: an open breaker still goes straight to the provider (the gateway is not probed per call)', async () => {
    const x = await client(minted);
    for (let i = 0; i < 3; i++) await chat(x.gw);
    const before = x.f.calls.filter(c => c.url.startsWith(GW)).length;
    const out = await chat(x.gw);
    expect(out.served.provider).toBe('openrouter-direct:qwen/qwen3.5-9b');
    expect(x.f.calls.filter(c => c.url.startsWith(GW)).length).toBe(before);
  });
});

describe('S5 — a hung cloud link no longer eats the whole stage budget (hedge / first-byte limit)', () => {
  // Stage budget 2 s here (GATEWAY_CHAT_BUDGET_MS) → cloud hedge min(4 s, budget / 2) = 1 s.
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  async function chain(stream: boolean, first: 'hang' | 'deployment-hang') {
    process.env.GATEWAY_CHAT_BUDGET_MS = '2000';
    process.env.FAULT_REGRESSION_KEY = 'fake-key-for-the-fake-upstream';
    const fake = await startFakeUpstream();
    try {
      fake.setFaults({ a: { kind: 'no-answer' }, b: { kind: 'ok', text: 'resposta do fallback' } });
      const or = new OpenAICompatLLMProvider({ providerId: 'openrouter', baseURL: `${fake.url}/or`, envKey: 'FAULT_REGRESSION_KEY' });
      const primary: RouteTarget<LLMProvider> = first === 'hang'
        ? { providerId: 'openrouter', provider: or, model: 'a' }
        // A deployment link keeps its own behaviour: no hedge set → no cloud hedge either.
        : { providerId: 'deployment:parle-speech', provider: or, model: 'a' };
      const t0 = Date.now();
      const res = await handleChatCompletions(
        { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0), body: { model: 'm', stream, messages: [{ role: 'user', content: `oi ${stream} ${first}` }] } },
        {}, undefined, undefined, undefined, undefined, undefined,
        { chatRoutes: { m: [primary, { providerId: 'openrouter', provider: or, model: 'b' }] }, circuitBreakers: new CircuitBreakerRegistry(), cooldownTracker: new CooldownTracker() },
      );
      const text = res.stream ? await new Response(res.stream).text() : JSON.stringify(res.body);
      const ms = Date.now() - t0;
      await sleep(100); // the loser's abort reaches the fake upstream
      return { res, text, ms, log: fake.log() };
    } finally { await Promise.race([fake.close(), sleep(500)]); }
  }

  it('the cloud hedge is min(GATEWAY_CLOUD_HEDGE_MS default 4 s, budget / 2), 0 = off', () => {
    expect(cloudHedgeMs(8_000, {})).toBe(4_000);
    expect(cloudHedgeMs(2_000, {})).toBe(1_000);
    expect(cloudHedgeMs(45_000, {})).toBe(4_000);
    expect(cloudHedgeMs(8_000, { GATEWAY_CLOUD_HEDGE_MS: '0' })).toBe(0);
  });

  it('non-streamed chat: the first link hangs → the next one answers within the budget (was a 503 at the budget)', async () => {
    const x = await chain(false, 'hang');
    expect(x.res.status).toBe(200);
    expect(x.text).toContain('resposta do fallback');
    expect(x.ms).toBeGreaterThanOrEqual(900);
    expect(x.ms).toBeLessThan(1_900);
    // The hung call was aborted once the other one won.
    expect(x.log.find(r => r.model === 'a')?.aborted).toBe(true);
  });

  it('streamed chat: the first link sends no first byte → the next one streams the answer', async () => {
    const x = await chain(true, 'hang');
    expect(x.res.status).toBe(200);
    expect(x.text).toContain('fallback');
    expect(x.text).toContain('[DONE]');
    expect(x.ms).toBeLessThan(1_900);
  });

  it('a deployment link keeps its own behaviour (no cloud hedge when it has none)', async () => {
    const x = await chain(false, 'deployment-hang');
    expect(x.log.filter(r => r.model === 'b')).toHaveLength(0);
    expect(x.res.status).toBe(503);
  });
});

describe('prod 2026-10-07 — deployment (4 s) → slow OpenRouter link → last OpenRouter link: the last link gets a real chance', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  /** parle-llm shape: deployment:parle-speech (first byte 4 s, hedge 1.5 s) → qwen (hangs) → gemini (answers). */
  async function threeLinks(stream: boolean, deployment: 'hangs' | 'cold') {
    delete process.env.GATEWAY_CHAT_BUDGET_MS; // the real 8 s
    delete process.env.GATEWAY_CLOUD_HEDGE_MS;
    process.env.FAULT_REGRESSION_KEY = 'fake-key-for-the-fake-upstream';
    const fake = await startFakeUpstream();
    try {
      fake.setFaults({ dep: { kind: 'no-answer' }, 'qwen/qwen3.5-9b': { kind: 'no-answer' }, 'google/gemini-2.5-flash-lite': { kind: 'ok', text: 'resposta do gemini' } });
      const or = new OpenAICompatLLMProvider({ providerId: 'openrouter', baseURL: `${fake.url}/or`, envKey: 'FAULT_REGRESSION_KEY' });
      const cold: LLMProvider = {
        providerId: 'self-hosted', isConfigured: () => true,
        chat: async () => { throw Object.assign(new Error("deployment 'parle-speech': replicas are starting"), { status: 503, gatewayCode: 'cold', skipRetry: true }); },
      };
      const chainTargets: Array<RouteTarget<LLMProvider>> = [
        { providerId: 'deployment:parle-speech', provider: deployment === 'cold' ? cold : or, model: 'dep', timeoutMs: 4_000, hedgeAfterMs: 1_500 },
        { providerId: 'openrouter', provider: or, model: 'qwen/qwen3.5-9b' },
        { providerId: 'openrouter', provider: or, model: 'google/gemini-2.5-flash-lite' },
      ];
      const t0 = Date.now();
      const res = await handleChatCompletions(
        { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0), body: { model: 'parle-llm', stream, messages: [{ role: 'user', content: `oi 3 ${stream} ${deployment}` }] } },
        {}, undefined, undefined, undefined, undefined, undefined,
        { chatRoutes: { 'parle-llm': chainTargets }, circuitBreakers: new CircuitBreakerRegistry(), cooldownTracker: new CooldownTracker() },
      );
      const text = res.stream ? await new Response(res.stream).text() : JSON.stringify(res.body);
      return { res, text, ms: Date.now() - t0 };
    } finally { await Promise.race([fake.close(), sleep(500)]); }
  }

  it('non-streamed, deployment hangs: gemini answers within the 8 s budget (was a 503 at ~8.1 s)', async () => {
    const x = await threeLinks(false, 'hangs');
    expect(x.res.status).toBe(200);
    expect(x.text).toContain('resposta do gemini');
    expect(x.ms).toBeLessThan(8_000);
  }, 15_000);

  it('non-streamed, deployment cold: gemini answers (qwen no longer gets the whole 8 s)', async () => {
    const x = await threeLinks(false, 'cold');
    expect(x.res.status).toBe(200);
    expect(x.text).toContain('resposta do gemini');
    expect(x.ms).toBeLessThan(5_000);
  }, 15_000);

  it('streamed, deployment hangs: gemini streams the answer within the budget', async () => {
    const x = await threeLinks(true, 'hangs');
    expect(x.res.status).toBe(200);
    expect(x.text).toContain('gemini');
    expect(x.text).toContain('[DONE]');
    expect(x.ms).toBeLessThan(8_000);
  }, 15_000);
});
