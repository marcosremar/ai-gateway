import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { machineLimitsFromEnv } from '../../../src/machines';
import { createMachineRoutes } from '../../../src/machines/http';
import { clock, FakeMachineCloud, HOUR, LIMITS, makeController } from './_fake-machines';

const KEYS: Record<string, string> = { 'k-admin': 'admin', 'k-palco': 'palco', 'k-school': 'school' };
const userOf = (req: IncomingMessage) => KEYS[(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')] ?? null;

let server: Server | null = null;
afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));

async function serve(ctl: ReturnType<typeof makeController>) {
  const handle = createMachineRoutes({ controller: ctl, userOf, isAdmin: req => userOf(req) === 'admin', allowedUsers: new Set(['palco', 'school']) });
  server = createServer((req, res) => {
    if (!handle(req, res, new URL(req.url ?? '/', 'http://x').pathname, req.method ?? 'GET')) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return async (method: string, path: string, key: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
}

const body = { provider: 'vast', machineType: 'RTX A4000', maxUsdPerHour: 0.16, image: 'ghcr.io/me/app:1', maxHours: 4, ports: [{ protocol: 'tcp', port: 9223 }] };

describe('machines HTTP: palco cap, minGpuFrac, pause and resume', () => {
  it('the default limits refuse palco above US$ 0.16/h and leave other apps alone', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    vast.price = 0.1;
    const call = await serve(makeController({ backends: { vast }, now: c.now, limits: { ownerMaxUsdPerHour: machineLimitsFromEnv({}).ownerMaxUsdPerHour } }));
    expect((await call('POST', '/v1/machines', 'k-palco', { ...body, maxUsdPerHour: 0.2 })).status).toBe(403);
    expect((await call('POST', '/v1/machines', 'k-palco', body)).status).toBe(201);
    expect((await call('POST', '/v1/machines', 'k-school', { ...body, maxUsdPerHour: 0.2 })).status).toBe(201);
    expect((await call('POST', '/v1/machines', 'k-palco', { ...body, minGpuFrac: 2 })).status).toBe(400);
    expect((await call('POST', '/v1/machines', 'k-palco', { ...body, provider: 'runpod', minGpuFrac: 1 })).json.error).toMatch(/vast/);
  });

  it('pause by low credit, resume over HTTP (402 then 200), other owners get 404, DELETE works on a paused machine', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    vast.price = 0.1;
    const ctl = makeController({ backends: { vast }, now: c.now, limits: LIMITS });
    const call = await serve(ctl);
    const id = (await call('POST', '/v1/machines', 'k-palco', body)).json.id as string;
    expect((await call('POST', `/v1/machines/${id}/resume`, 'k-palco')).status).toBe(409);
    vast.creditUsd = 0.4;
    c.advance(HOUR / 2);
    await ctl.reconcile();
    const paused = await call('GET', `/v1/machines/${id}`, 'k-palco');
    expect(paused.json).toMatchObject({ status: 'paused' });
    expect(paused.json.lastError).toMatch(/below \$1/);
    expect((await call('POST', `/v1/machines/${id}/resume`, 'k-school')).status).toBe(404);
    expect((await call('POST', `/v1/machines/${id}/resume`, 'k-palco')).status).toBe(402);
    vast.creditUsd = 12;
    const resumed = await call('POST', `/v1/machines/${id}/resume`, 'k-palco');
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({ status: 'running', lastError: null });
    vast.creditUsd = 0.4;
    await ctl.reconcile();
    expect((await call('GET', `/v1/machines/${id}`, 'k-palco')).json.status).toBe('paused');
    expect((await call('DELETE', `/v1/machines/${id}`, 'k-palco')).json.status).toBe('released');
    expect(vast.released).toHaveLength(1);
  });
});

describe('paused machines and the app limits', () => {
  it('a paused GPU keeps the app\'s only GPU slot, and its cost stops growing while paused', async () => {
    const c = clock();
    const vast = new FakeMachineCloud('vast', c.now);
    vast.price = 0.1;
    const ctl = makeController({ backends: { vast }, now: c.now, limits: LIMITS });
    const m = await ctl.create('palco', { request: { provider: 'vast', machineType: 'RTX A4000', maxUsdPerHour: 0.16, image: 'x/y:1', diskGb: 40, ports: [], env: {} }, maxHours: 4, idleMinutes: 0, holder: null });
    vast.creditUsd = 0.2;
    c.advance(HOUR);
    await ctl.reconcile();
    expect(ctl.get(m.id)?.status).toBe('paused');
    const frozen = ctl.costUsd(ctl.get(m.id)!);
    c.advance(HOUR);
    expect(ctl.costUsd(ctl.get(m.id)!)).toBeCloseTo(frozen, 6);
    await expect(ctl.create('palco', { request: { provider: 'vast', machineType: 'RTX A4000', maxUsdPerHour: 0.16, image: 'x/y:1', diskGb: 40, ports: [], env: {} }, maxHours: 1, idleMinutes: 0, holder: null }))
      .rejects.toMatchObject({ status: 409 });
  });
});
