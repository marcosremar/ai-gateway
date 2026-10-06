/**
 * POST/GET /v1/apps/:app/stability-report — instability events buffered by SDK clients while the gateway was down,
 * posted back once it recovers. Same callers as the app's other paths (own key, or admin with X-App).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { DeploymentController } from '../../../src/deployments/controller';
import { createDeploymentRoutes, HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { AppRegistry, MemoryAppStore } from '../../../src/deployments/apps';
import { ClientStabilityLog } from '../../../src/deployments/stability';
import { FakeCloud } from './_fake-cloud';

const ADMIN = 'admin-key-0123456789';
const APP = 'app-key-0123456789';
const OTHER = 'other-key-0123456789';

let server: Server;
let base: string;
let stability: ClientStabilityLog;

beforeEach(async () => {
  const controller = new DeploymentController({
    backend: new FakeCloud(), store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test',
  });
  await controller.init();
  const apps = new AppRegistry(new MemoryAppStore());
  await apps.init();
  stability = new ClientStabilityLog();
  const handler = createDeploymentRoutes({
    controller,
    apps,
    stability,
    isAdmin: (req) => req.headers.authorization === `Bearer ${ADMIN}`,
    userOf: (req) =>
      req.headers.authorization === `Bearer ${ADMIN}` ? 'owner'
        : req.headers.authorization === `Bearer ${APP}` ? 'parle'
          : req.headers.authorization === `Bearer ${OTHER}` ? 'other' : null,
  });
  server = createProxyServer({
    apiKeys: [`${ADMIN}:owner`, `${APP}:parle`, `${OTHER}:other`],
    providers: { stt: {}, chat: {}, tts: {} } as never,
    prefixRoutes: [{ prefix: '/v1/apps', handler }],
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise(r => server.close(() => r(null))));

const post = (path: string, body: unknown, key = APP, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, key = APP, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}`, ...headers } });

const EVENTS = [
  { at: 1_000, kind: 'unreachable', path: '/v1/chat/completions', code: 'network', latencyMs: 40 },
  { at: 1_100, kind: 'direct', route: 'direct', detail: 'network' },
];

describe('POST /v1/apps/:app/stability-report', () => {
  it('stores a sanitized report and GET returns it back', async () => {
    const res = await post('/v1/apps/parle/stability-report', { client: 'parle-backend', events: EVENTS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 2 });

    const got = await (await get('/v1/apps/parle/stability-report')).json();
    expect(got.app).toBe('parle');
    expect(got.reports).toHaveLength(1);
    expect(got.reports[0].client).toBe('parle-backend');
    expect(got.reports[0].events).toEqual(EVENTS);
  });

  it("the app's own key and an admin naming the app may post; another app's key may not", async () => {
    expect((await post('/v1/apps/parle/stability-report', { events: EVENTS }, APP)).status).toBe(200);
    expect((await post('/v1/apps/parle/stability-report', { events: EVENTS }, ADMIN, { 'x-app': 'parle' })).status).toBe(200);
    expect((await post('/v1/apps/parle/stability-report', { events: EVENTS }, OTHER)).status).toBe(403);
  });

  it('drops malformed events and answers the accepted count', async () => {
    const res = await post('/v1/apps/parle/stability-report', {
      client: 'x',
      events: [
        ...EVENTS,
        { kind: 'unreachable' },                    // no at
        { at: 'later', kind: 'slow' },              // bad at
        'garbage',
        { at: 2_000, kind: 'slow', detail: 'd'.repeat(400) }, // detail capped at 300
      ],
    });
    expect((await res.json()).accepted).toBe(3);
    const events = stability.recent('parle')[0].events;
    expect(events.map(e => e.kind)).toEqual(['unreachable', 'direct', 'slow']);
    expect(events[2].detail).toHaveLength(300);
  });

  it('an empty or eventless report is accepted but stores nothing', async () => {
    expect((await post('/v1/apps/parle/stability-report', { client: 'x', events: [] })).status).toBe(200);
    expect(stability.recent('parle')).toHaveLength(0);
  });

  it('GET needs the app (or an admin naming it); limit truncates to the newest', async () => {
    for (let i = 0; i < 3; i++) await post('/v1/apps/parle/stability-report', { client: `c${i}`, events: EVENTS });
    const res = await get('/v1/apps/parle/stability-report?limit=2');
    expect((await res.json()).reports.map((r: { client: string }) => r.client)).toEqual(['c1', 'c2']);
    expect((await get('/v1/apps/parle/stability-report', OTHER)).status).toBe(403);
  });
});
