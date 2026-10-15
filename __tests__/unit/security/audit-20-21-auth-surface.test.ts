import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { createTelemetryRoutes } from '../../../src/telemetry/http';
import { TelemetryIngest } from '../../../src/telemetry/ingest';
import { TelemetryStore } from '../../../src/telemetry/store';
import { authenticateTelemetry, isMasterToken } from '../../../src/telemetry/auth';
import { authDeps } from '../telemetry/_helpers';

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => { if (server) server.close(() => r()); else r(); server = null; }));

async function listen(s: Server): Promise<string> {
  server = s;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('audit 2026-10-09 #20: public telemetry is not an oracle for the master token', () => {
  it('the master token gets the very same answer as any wrong key', () => {
    const master = authenticateTelemetry({ authorization: 'Bearer sandbox-master' }, authDeps());
    const wrong = authenticateTelemetry({ authorization: 'Bearer nope' }, authDeps());
    expect(master).toEqual(wrong);
  });

  it('the master token is compared in constant time against every alias', () => {
    const env = { SANDBOX_TOKEN: 'master-token-0123456789', PROXY_TOKEN: 'alias-token-0123456789' };
    expect(isMasterToken('master-token-0123456789', env)).toBe(true);
    expect(isMasterToken('alias-token-0123456789', env)).toBe(true);
    expect(isMasterToken('master-token-012345678', env)).toBe(false);
    expect(isMasterToken('', env)).toBe(false);
    expect(isMasterToken('x', {})).toBe(false);
  });

  it('one IP that keeps failing auth is cut off with 429 before the credential is checked', async () => {
    const store = new TelemetryStore();
    const routes = createTelemetryRoutes({ store, ingest: new TelemetryIngest(store), auth: authDeps(), isAdminToken: () => false });
    const base = await listen(createProxyServer({ apiKeys: ['app-key:parle'], providers: {}, publicRoutes: routes.publicRoutes } as never));
    const post = (key: string) => fetch(`${base}/v1/telemetry/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ events: [] }),
    });
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await post(`guess-${i}`)).status);
    expect(statuses.slice(0, 5).every(s => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await post('app-key')).status).toBe(429);
  });
});

describe('audit 2026-10-09 #21: the key travels as `Authorization: Bearer <key>` only', () => {
  it('a bare key (no scheme) is refused; the Bearer form works', async () => {
    const base = await listen(createProxyServer({ apiKeys: ['app-key-0123456789:parle'], providers: { chat: {}, stt: {}, tts: {} } } as never));
    const models = (authorization: string) => fetch(`${base}/v1/models`, { headers: { authorization } });
    expect((await models('Bearer app-key-0123456789')).status).toBe(200);
    expect((await models('bearer app-key-0123456789')).status).toBe(200);
    expect((await models('app-key-0123456789')).status).toBe(401);
    expect((await models('Basic app-key-0123456789')).status).toBe(401);
  });
});
