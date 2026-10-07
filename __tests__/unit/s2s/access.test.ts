/**
 * S1 of the API audit (2026-10-07, verified in production): `POST /v1/s2s` took `config.deployment` from the body with
 * no ownership check — any app key could wake and use another app's GPU — and the primary path skipped AppLimits.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { DeploymentError } from '../../../src/deployments/controller';
import { createS2SRoute } from '../../../src/s2s/route';
import { createS2SAccess, routesReachDeployment } from '../../../src/s2s/access';
import { AppLimits } from '../../../src/gateway/proxy/app-limits';
import { decodeAll, fakeStages, replicaFrames } from './_fakes';
import type { ModelRoutesSpec } from '../../../src/config/serve-providers';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** parle-speech: declared, no app, reached by parle's routes. parle-own: parle's. other-gpu: app `other`'s. */
const DEPLOYMENTS: Record<string, string | null> = { 'parle-speech': null, 'parle-own': 'parle', 'other-gpu': 'other' };
const ROUTES: Record<string, ModelRoutesSpec> = {
  parle: {
    stt: { 'parle-stt': [{ provider: 'deployment', deployment: 'parle-speech', model: 'whisper' } as never] },
    chat: { 'parle-llm': [{ provider: 'openrouter', model: 'qwen/qwen3.5-9b' } as never] },
    tts: { 'parle-tts': [{ provider: 'openrouter', model: 'kokoro' } as never] },
  },
  other: { chat: { 'other-llm': [{ provider: 'openrouter', model: 'x/y' } as never] } },
};
const USERS: Record<string, string> = { 'Bearer parle-key': 'parle', 'Bearer other-key': 'other', 'Bearer admin-key': 'owner' };

async function harness(opts: { state?: 'ready' | 'cold'; defaultDeployment?: string; env?: Record<string, string> } = {}) {
  const acquired: string[] = [];
  const woken: string[] = [];
  const replicaConfigs: unknown[] = [];
  const replicaHost = await listen(async (req, res) => {
    const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': String(req.headers['content-type']) },
      body: await new Promise<Buffer>(r => { const c: Buffer[] = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); }) as never,
      duplex: 'half' } as never).formData();
    replicaConfigs.push(JSON.parse(String(form.get('config'))));
    res.writeHead(200, { 'Content-Type': 'application/x-aigw-s2s' });
    for (const f of replicaFrames('Oi!', ['Bom dia!'])) res.write(f);
    res.end();
  });
  const controller = {
    get: (name: string) => (name in DEPLOYMENTS ? ({ name, app: DEPLOYMENTS[name] ?? undefined } as never) : null),
    wake: (name: string) => { woken.push(name); return null as never; },
    acquire: async (name: string) => {
      acquired.push(name);
      if (opts.state === 'cold') throw new DeploymentError(503, 'starting', 30);
      return { machine: { ip: replicaHost } as never, token: 'tok', done: () => {} } as never;
    },
  };
  const limits = new AppLimits({
    env: opts.env ?? {},
    isAdmin: (u) => u === 'owner',
    aliasesOf: (u, stage) => { const r = ROUTES[u]?.[stage]; return r ? new Set(Object.keys(r)) : null; },
  });
  const admit = createS2SAccess({
    userOf: (req) => USERS[String(req.headers.authorization)] ?? '',
    isAdmin: (u) => u === 'owner',
    deploymentApp: (name) => (name in DEPLOYMENTS ? DEPLOYMENTS[name] : undefined),
    appRoutes: (app) => ROUTES[app],
    limits,
  });
  const fake = fakeStages();
  const route = createS2SRoute({
    controller, deployment: opts.defaultDeployment, admit, stagesFor: () => fake.stages, hedgeMs: 2_000,
  });
  const host = await listen((req, res) => { void route(req, res); });
  async function call(key: string, config: Record<string, unknown>) {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'a.webm');
    form.set('config', JSON.stringify(config));
    const res = await fetch(`http://${host}/v1/s2s`, { method: 'POST', body: form, headers: { authorization: `Bearer ${key}` } });
    return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  return { call, host, acquired, woken, replicaConfigs, calls: fake.calls, limits };
}

const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

describe('POST /v1/s2s: deployment ownership', () => {
  it("another app's deployment named in config → 403, nothing acquired, woken or called", async () => {
    const h = await harness({ state: 'cold' });
    const { res, bytes } = await h.call('parle-key', { deployment: 'other-gpu' });
    expect(res.status).toBe(403);
    expect(json(bytes).error).toMatchObject({ type: 'permission_error' });
    expect(h.acquired).toEqual([]);
    expect(h.woken).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('an unknown deployment named in config is a 403 too (no wake, no name oracle)', async () => {
    const h = await harness();
    expect((await h.call('parle-key', { deployment: 'nope' })).res.status).toBe(403);
    expect(h.acquired).toEqual([]);
  });

  it("the app's own deployment and a declared one its routes reach are used (and woken when cold)", async () => {
    const h = await harness();
    for (const deployment of ['parle-own', 'parle-speech']) {
      const { res, bytes } = await h.call('parle-key', { deployment });
      expect(res.status).toBe(200);
      expect(decodeAll(bytes).events[0]).toEqual({ type: 'route', provider: `deployment:${deployment}` });
    }
    expect(h.acquired).toEqual(['parle-own', 'parle-speech']);
    const cold = await harness({ state: 'cold' });
    await cold.call('parle-key', { deployment: 'parle-speech' });
    expect(cold.woken).toEqual(['parle-speech']);
  });

  it('an admin key may use any deployment', async () => {
    const h = await harness();
    expect((await h.call('admin-key', { deployment: 'other-gpu' })).res.status).toBe(200);
    expect(h.acquired).toEqual(['other-gpu']);
  });

  it("the gateway default deployment of another app is never woken for this key: composed pipeline instead", async () => {
    const h = await harness({ state: 'cold', defaultDeployment: 'parle-speech' });
    const { res, bytes } = await h.call('other-key', {});
    expect(res.status).toBe(200);
    expect(decodeAll(bytes).events[0]).toMatchObject({ type: 'route', provider: 'composite' });
    expect(h.acquired).toEqual([]);
    expect(h.woken).toEqual([]);
  });

  it('routesReachDeployment reads every stage and alias', () => {
    expect(routesReachDeployment(ROUTES.parle, 'parle-speech')).toBe(true);
    expect(routesReachDeployment(ROUTES.parle, 'other-gpu')).toBe(false);
    expect(routesReachDeployment(undefined, 'parle-speech')).toBe(false);
  });
});

describe('POST /v1/s2s: app limits on the primary path', () => {
  it('config.models must be the app\'s own aliases (403 otherwise)', async () => {
    const h = await harness();
    const { res, bytes } = await h.call('parle-key', { deployment: 'parle-speech', models: { chat: 'other-llm' } });
    expect(res.status).toBe(403);
    expect(json(bytes).error.message).toMatch(/config\.models\.chat/);
    expect(h.acquired).toEqual([]);
    expect((await h.call('parle-key', { deployment: 'parle-speech', models: { stt: 'parle-stt', chat: 'parle-llm' } })).res.status).toBe(200);
  });

  it('max_tokens is clamped in the config the replica receives', async () => {
    const h = await harness({ env: { APP_MAX_TOKENS: '256' } });
    await h.call('parle-key', { deployment: 'parle-speech', max_tokens: 100_000, system: 'Seu Jorge' });
    expect(h.replicaConfigs).toEqual([expect.objectContaining({ max_tokens: 256, system: 'Seu Jorge', deployment: 'parle-speech' })]);
  });

  it('the daily budget is charged once per turn; over it → 429 with Retry-After, nothing acquired', async () => {
    const h = await harness({ env: { APP_DAILY_REQUESTS: '1' } });
    expect((await h.call('parle-key', { deployment: 'parle-speech' })).res.status).toBe(200);
    expect(h.limits.usageOf('parle').requests).toBe(1);
    const { res, bytes } = await h.call('parle-key', { deployment: 'parle-speech' });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(json(bytes).error.type).toBe('budget_exceeded');
    expect(h.acquired).toEqual(['parle-speech']);
  });

  it('an admin key is not limited', async () => {
    const h = await harness({ env: { APP_DAILY_REQUESTS: '1' } });
    for (let i = 0; i < 3; i++) expect((await h.call('admin-key', { deployment: 'parle-speech', models: { chat: 'any/model' } })).res.status).toBe(200);
  });

  it('a stage of an admitted turn is checked but not charged again (charge: false)', () => {
    const limits = new AppLimits({ env: {}, isAdmin: () => false, aliasesOf: () => new Set(['parle-llm']) });
    expect(limits.check('parle', 'chat', { model: 'parle-llm', messages: [] }, { charge: false })).toBeNull();
    expect(limits.usageOf('parle').requests).toBe(0);
    expect(limits.check('parle', 'chat', { model: 'other', messages: [] }, { charge: false })).toMatchObject({ status: 403 });
  });
});

describe('POST /v1/s2s: request errors', () => {
  it('400s say invalid_request_error (was invalid_request)', async () => {
    const h = await harness();
    const noFile = new FormData();
    noFile.set('config', '{}');
    const res = await fetch(`http://${h.host}/v1/s2s`, { method: 'POST', body: noFile, headers: { authorization: 'Bearer parle-key' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('invalid_request_error');
    const badConfig = new FormData();
    badConfig.set('file', new Blob([new Uint8Array([1])]), 'a.webm');
    badConfig.set('config', '[1]');
    const bad = await fetch(`http://${h.host}/v1/s2s`, { method: 'POST', body: badConfig, headers: { authorization: 'Bearer parle-key' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { type: string } }).error.type).toBe('invalid_request_error');
  });
});
