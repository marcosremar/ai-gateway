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

  it('TTS stream: a listener that cancels, or a caller that gives up, releases the lease as healthy', async () => {
    const ip = await replica(async (req, res) => {
      if (req.url?.startsWith('/refs')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('no catalog here'); return; }
      res.writeHead(200, { 'content-type': 'audio/wav' });
      for (let i = 0; i < 50 && !res.destroyed; i++) { res.write(Buffer.alloc(1000, i)); await sleep(20); }
      res.end();
    });
    const ctl = leaser(ip);
    const tts = new DeploymentTTSProvider(ctl, 'd');
    const a = await tts.synthesize({ model: 'tts', input: 'oi', voice: 'v', responseFormat: 'wav' });
    // The non-JSON catalog answer is not read: its body is cancelled at once, so it does not hold a lease.
    expect(ctl.leases[0].done.mock.calls).toEqual([[false]]);
    await a.stream!.cancel();
    expect(ctl.leases[1].done.mock.calls).toEqual([[false]]);
    const abort = new AbortController();
    const b = await tts.synthesize({ model: 'tts', input: 'oi', voice: 'v', responseFormat: 'wav', signal: abort.signal });
    const lease = ctl.leases[ctl.leases.length - 1];
    abort.abort();
    await sleep(10);
    expect(lease.done.mock.calls).toEqual([[false]]);
    await b.stream!.cancel().catch(() => {});
  });

  it('a body nobody reads does not hold the lease forever: released (healthy) after the call timeout', async () => {
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
    expect(speech.done.mock.calls).toEqual([[false]]);
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
