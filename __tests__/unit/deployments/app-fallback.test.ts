/**
 * Direct-fallback plan (`GET /v1/apps/:app/fallback`): routes kept, key choice (provisioned / shared / none), key
 * rotation, auth, and no key in logs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { DeploymentController } from '../../../src/deployments/controller';
import { createDeploymentRoutes, HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { AppRegistry, MemoryAppStore } from '../../../src/deployments/apps';
import {
  AppFallbackService, fallbackRoutes, OpenRouterKeyProvisioner, type FallbackPlan, type KeyProvisioner,
} from '../../../src/deployments/app-fallback';
import type { ModelRoutesSpec } from '../../../src/config/serve-providers';
import { FakeCloud } from './_fake-cloud';

const ROUTES: ModelRoutesSpec = {
  stt: { 'parle-stt': [
    { provider: 'deployment', deployment: 'parle-speech', model: 'whisper' },
    { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' },
    { provider: 'groq', model: 'whisper-large-v3-turbo' },
  ] },
  chat: { 'parle-llm': [
    { provider: 'deployment', deployment: 'parle-speech' },
    { provider: 'openrouter', model: 'qwen/qwen3.5-9b', extraBody: { reasoning: { enabled: false } } },
    { provider: 'zai', model: 'glm-4.6' },
    { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' },
  ] },
  tts: {
    'parle-tts': [
      { provider: 'deployment', deployment: 'parle-qwen-tts' },
      { provider: 'openrouter', model: 'microsoft/mai-voice-2.1-flash', voice: 'pt-BR-Luana' },
      { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'pf_dora', fixedVoice: true },
    ],
    'only-gpu': [{ provider: 'deployment', deployment: 'x' }],
  },
};

const SHARED = 'sk-or-v1-shared-0123456789abcdef';
const GROQ = 'gsk_groq0123456789abcdef';

class FakeProvisioner implements KeyProvisioner {
  enabled = true;
  created: Array<{ name: string; limitUsd: number; expiresAt: string; key: string; hash: string }> = [];
  removed: string[] = [];
  fail = false;
  available() { return this.enabled; }
  async create(input: { name: string; limitUsd: number; expiresAt: string }) {
    if (this.fail) throw new Error('OpenRouter key provisioning failed: HTTP 500');
    const n = this.created.length + 1;
    const made = { ...input, key: `sk-or-v1-minted-${n}-secretsecret`, hash: `hash${n}`.padEnd(64, '0') };
    this.created.push(made);
    return { key: made.key, hash: made.hash };
  }
  async remove(hash: string) { this.removed.push(hash); }
}

async function service(env: Record<string, string | undefined>, provisioner: KeyProvisioner | null = null) {
  let t = Date.parse('2026-10-06T10:00:00Z');
  const apps = new AppRegistry(new MemoryAppStore(), () => t);
  await apps.init();
  const logs: string[] = [];
  const svc = new AppFallbackService({
    env, store: apps, provisioner, now: () => t, log: (msg, data) => logs.push(`${msg} ${JSON.stringify(data ?? {})}`),
  });
  return { svc, apps, logs, advance: (ms: number) => { t += ms; } };
}

describe('fallbackRoutes', () => {
  it('keeps only the direct-callable entries, in chain order, with voice / fixedVoice / extraBody', () => {
    const routes = fallbackRoutes(ROUTES, new Set(['openrouter']));
    expect(routes.stt).toEqual({ 'parle-stt': [{ provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' }] });
    expect(routes.chat['parle-llm']).toEqual([
      { provider: 'openrouter', model: 'qwen/qwen3.5-9b', extraBody: { reasoning: { enabled: false } } },
      { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' },
    ]);
    expect(routes.tts['parle-tts']).toEqual([
      { provider: 'openrouter', model: 'microsoft/mai-voice-2.1-flash', voice: 'pt-BR-Luana' },
      { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'pf_dora', fixedVoice: true },
    ]);
    expect(routes.tts['only-gpu']).toBeUndefined();
    expect(fallbackRoutes(ROUTES, new Set(['openrouter', 'groq'])).stt['parle-stt'].map(e => e.provider)).toEqual(['openrouter', 'groq']);
  });

  it('an entry without model calls the alias itself', () => {
    expect(fallbackRoutes({ chat: { 'org/model': [{ provider: 'openrouter' }] } }, new Set(['openrouter'])).chat['org/model'])
      .toEqual([{ provider: 'openrouter', model: 'org/model' }]);
  });
});

describe('AppFallbackService', () => {
  // Regression (QA 06/10/2026, critical): with no provisioning key, GET /v1/apps/parle/fallback handed out the
  // gateway's master OPENROUTER_API_KEY (keyKind shared, no limit, no expiry) because sharing was on by default.
  it('never hands out the gateway master keys by default: routes are listed, no credential', async () => {
    const { svc } = await service({ OPENROUTER_API_KEY: SHARED, GROQ_API_KEY: GROQ });
    const plan = await svc.plan('parle', ROUTES);
    expect(plan.openrouter).toBeNull();
    expect(plan.providers).toEqual({});
    expect(JSON.stringify(plan)).not.toContain(SHARED);
    expect(JSON.stringify(plan)).not.toContain(GROQ);
    expect(plan.routes.stt['parle-stt'].map(e => e.provider)).toEqual(['openrouter', 'groq']);
  });

  it('shares the gateway keys only with APP_FALLBACK_SHARE_KEY=1 (openrouter and groq), for providers the routes use', async () => {
    const { svc } = await service({ OPENROUTER_API_KEY: SHARED, GROQ_API_KEY: GROQ, APP_FALLBACK_SHARE_KEY: '1' });
    const plan = await svc.plan('parle', ROUTES);
    expect(plan.openrouter).toEqual({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: SHARED, keyKind: 'shared', expiresAt: null, limitUsd: null });
    expect(plan.providers.groq).toMatchObject({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ, keyKind: 'shared' });
    expect(plan.routes.stt['parle-stt'].map(e => e.provider)).toEqual(['openrouter', 'groq']);
    expect(plan.ttlSeconds).toBe(3600);
    // No groq entry in the routes → the groq key is not handed out
    const noGroq = await svc.plan('parle', { chat: ROUTES.chat });
    expect(noGroq.providers.groq).toBeUndefined();
  });

  it('APP_FALLBACK_SHARE_KEY=0, any other value, or no key → openrouter: null', async () => {
    for (const env of [{ OPENROUTER_API_KEY: SHARED, APP_FALLBACK_SHARE_KEY: '0' }, { OPENROUTER_API_KEY: SHARED, APP_FALLBACK_SHARE_KEY: 'yes' },
      { APP_FALLBACK_SHARE_KEY: '1' }, {}]) {
      const { svc } = await service(env);
      const plan = await svc.plan('parle', ROUTES);
      expect(plan.openrouter).toBeNull();
      expect(plan.providers).toEqual({});
    }
  });

  it('mints a limited per-app key, reuses it, rotates it and deletes the old one after the grace day', async () => {
    const prov = new FakeProvisioner();
    const { svc, apps, advance, logs } = await service({ OPENROUTER_API_KEY: SHARED, APP_FALLBACK_KEY_LIMIT_USD: '3' }, prov);
    const first = await svc.plan('parle', ROUTES);
    expect(first.openrouter).toMatchObject({ keyKind: 'provisioned', apiKey: prov.created[0].key, limitUsd: 3 });
    expect(prov.created[0]).toMatchObject({ name: 'aigw-parle', limitUsd: 3 });
    expect(apps.fallbackKey('parle')).toMatchObject({ hash: prov.created[0].hash, limitUsd: 3 });
    expect(JSON.stringify(apps.get('parle'))).not.toContain(prov.created[0].key);
    expect((await svc.plan('parle', ROUTES)).openrouter!.apiKey).toBe(prov.created[0].key);
    expect(prov.created).toHaveLength(1);

    advance(7 * 24 * 3600_000 + 1); // rotation
    const rotated = await svc.plan('parle', ROUTES);
    expect(rotated.openrouter!.apiKey).toBe(prov.created[1].key);
    expect(prov.removed).toEqual([]); // old key still alive for its grace day
    advance(24 * 3600_000 + 1);
    await svc.plan('parle', ROUTES);
    expect(prov.removed).toEqual([prov.created[0].hash]);
    expect(apps.fallbackKey('parle')!.retired).toBeUndefined();

    const all = logs.join('\n');
    for (const k of [SHARED, ...prov.created.map(c => c.key)]) expect(all).not.toContain(k);
  });

  it('a restarted gateway (key not in memory) mints a new key and retires the stored one', async () => {
    const prov = new FakeProvisioner();
    const { svc, apps } = await service({}, prov);
    await svc.plan('parle', ROUTES);
    const restarted = new AppFallbackService({ env: {}, store: apps, provisioner: prov, now: () => Date.parse('2026-10-06T11:00:00Z') });
    const plan = await restarted.plan('parle', ROUTES);
    expect(plan.openrouter!.apiKey).toBe(prov.created[1].key);
    expect(apps.fallbackKey('parle')!.retired).toEqual([{ hash: prov.created[0].hash, deleteAfter: expect.any(Number) }]);
  });

  it('provisioning failure hands out no key unless sharing is opted in, and the log names no key', async () => {
    const prov = new FakeProvisioner();
    prov.fail = true;
    const off = await service({ OPENROUTER_API_KEY: SHARED, OPENROUTER_PROVISIONING_KEY: 'sk-or-v1-mgmt-secret' }, prov);
    expect((await off.svc.plan('parle', ROUTES)).openrouter).toBeNull();
    const { svc, logs } = await service({ OPENROUTER_API_KEY: SHARED, OPENROUTER_PROVISIONING_KEY: 'sk-or-v1-mgmt-secret', APP_FALLBACK_SHARE_KEY: '1' }, prov);
    const plan = await svc.plan('parle', ROUTES);
    expect(plan.openrouter).toMatchObject({ keyKind: 'shared', apiKey: SHARED });
    expect(logs.join('\n')).toContain('provisioning failed');
    expect(logs.join('\n')).not.toContain(SHARED);
  });
});

describe('OpenRouterKeyProvisioner', () => {
  it('POST /keys with name, limit and expires_at; reads key and data.hash; DELETE /keys/:hash (404 ok)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === 'POST') return new Response(JSON.stringify({ key: 'sk-or-v1-new', data: { hash: 'h1' } }), { status: 201 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const p = new OpenRouterKeyProvisioner(() => 'mgmt', fake);
    expect(await p.create({ name: 'aigw-parle', limitUsd: 5, expiresAt: '2026-10-14T10:00:00.000Z' })).toEqual({ key: 'sk-or-v1-new', hash: 'h1' });
    await p.remove('h1');
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/keys');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'aigw-parle', limit: 5, expires_at: '2026-10-14T10:00:00.000Z' });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer mgmt');
    expect(calls[1]).toMatchObject({ url: 'https://openrouter.ai/api/v1/keys/h1', init: { method: 'DELETE' } });
    expect(new OpenRouterKeyProvisioner(() => undefined, fake).available()).toBe(false);
  });
});

// ── HTTP: who may read the plan ────────────────────────────────────────────

const ADMIN = 'admin-key-0123456789';
const PARLE = 'parle-key-0123456789';
const OTHER = 'other-key-0123456789';

describe('GET /v1/apps/:app/fallback', () => {
  let server: Server;
  let base: string;
  let controller: DeploymentController;
  let logs: string[];

  beforeEach(async () => {
    controller = new DeploymentController({
      backend: new FakeCloud(), store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test',
    });
    await controller.init();
    const apps = new AppRegistry(new MemoryAppStore());
    await apps.init();
    await apps.putRoutes('parle', ROUTES);
    logs = [];
    const users: Record<string, string> = { [`Bearer ${ADMIN}`]: 'owner', [`Bearer ${PARLE}`]: 'parle', [`Bearer ${OTHER}`]: 'other' };
    const handler = createDeploymentRoutes({
      controller, apps,
      isAdmin: (req) => req.headers.authorization === `Bearer ${ADMIN}`,
      userOf: (req) => users[String(req.headers.authorization)] ?? null,
      fallback: new AppFallbackService({ env: { OPENROUTER_API_KEY: SHARED, APP_FALLBACK_SHARE_KEY: '1' }, store: apps, log: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`) }),
    });
    server = createProxyServer({
      apiKeys: [`${ADMIN}:owner`, `${PARLE}:parle`, `${OTHER}:other`],
      providers: { stt: {}, chat: {}, tts: {} } as never,
      prefixRoutes: [{ prefix: '/v1/apps', handler }],
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    controller.stop();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  });

  const get = (key: string | null, headers: Record<string, string> = {}, method = 'GET') => fetch(`${base}/v1/apps/parle/fallback`, {
    method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
  });

  it('the app key gets the plan (no-store), with the shared key', async () => {
    const res = await get(PARLE);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const plan = await res.json() as FallbackPlan;
    expect(plan).toMatchObject({ app: 'parle', openrouter: { apiKey: SHARED, keyKind: 'shared' } });
    expect(plan.routes.chat['parle-llm'].map(e => e.model)).toEqual(['qwen/qwen3.5-9b', 'meta-llama/llama-3.3-70b-instruct']);
    expect(logs.join('\n')).not.toContain(SHARED);
  });

  it('an admin key gets it only with X-App naming the app', async () => {
    expect((await get(ADMIN, { 'X-App': 'parle' })).status).toBe(200);
    expect((await get(ADMIN)).status).toBe(403);
    expect((await get(ADMIN, { 'X-App': 'other' })).status).toBe(403);
  });

  it('refuses another app (403), no key (401) and other methods (405), without leaking the key', async () => {
    const other = await get(OTHER);
    expect(other.status).toBe(403);
    expect(await other.text()).not.toContain(SHARED);
    expect((await get(OTHER, { 'X-App': 'parle' })).status).toBe(403);
    expect((await get(null)).status).toBe(401);
    expect((await get(PARLE, { 'content-type': 'application/json' }, 'DELETE')).status).toBe(405);
  });

  it('no other app route carries the key', async () => {
    for (const path of ['/v1/apps/parle', '/v1/apps/parle/routes', '/v1/apps']) {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${PARLE}` } });
      expect(await res.text()).not.toContain(SHARED);
    }
  });
});
