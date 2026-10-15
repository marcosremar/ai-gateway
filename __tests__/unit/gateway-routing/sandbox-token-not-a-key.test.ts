/**
 * Owner decision 06/10/2026: the SANDBOX_TOKEN is the dev API's master key. The gateway uses it only to FETCH its own
 * provider keys from the palco; it is NOT a client key nor an admin. Until then it was accepted as user `sandbox`
 * (admin). `ACCEPT_SANDBOX_TOKEN_AS_KEY=1` keeps the old behaviour for the transition only.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { gatewayClientKeys } from '../../../src/config/sandbox-env';
import { adminUsersFromEnv } from '../../../src/deployments';

const TOKEN = 'sandbox-master-token-0123456789';
const APP_KEY = 'parle-own-key-0123456789';

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => { if (server) server.close(() => r()); else r(); server = null; }));

async function gateway(env: Record<string, string>): Promise<string> {
  const { keys } = gatewayClientKeys(env);
  server = createProxyServer({ apiKeys: keys, providers: { chat: {}, stt: {}, tts: {} } as never });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const models = (base: string, key: string) => fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });

describe('SANDBOX_TOKEN is not a gateway key', () => {
  it('by default the SANDBOX_TOKEN (and each alias) gets 401; the gateway\'s own key works', async () => {
    for (const alias of ['SANDBOX_TOKEN', 'PALCO_PROXY', 'PALCO_PROXY_TOKEN', 'PROXY_TOKEN']) {
      const env = { [alias]: TOKEN, GATEWAY_API_KEYS: `${APP_KEY}:parle` };
      const { keys } = gatewayClientKeys(env);
      expect(keys).toEqual([`${APP_KEY}:parle`]);
      expect(adminUsersFromEnv(env).size).toBe(0);
      const base = await gateway(env);
      expect((await models(base, TOKEN)).status).toBe(401);
      expect((await models(base, APP_KEY)).status).toBe(200);
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  it('ACCEPT_SANDBOX_TOKEN_AS_KEY=1 (transition) accepts it as the client `sandbox`, never an admin, with a warning', async () => {
    const env = { SANDBOX_TOKEN: TOKEN, ACCEPT_SANDBOX_TOKEN_AS_KEY: '1' };
    const { keys, warnings } = gatewayClientKeys(env);
    expect(keys).toEqual([`${TOKEN}:sandbox`]);
    expect(adminUsersFromEnv(env).size).toBe(0);
    expect(adminUsersFromEnv({ ...env, SANDBOX_TOKEN_ADMIN: '1', DEPLOYMENTS_ADMIN_USERS: 'sandbox' }).size).toBe(0);
    expect(warnings.join('\n')).toMatch(/transition only/);
    expect((await models(await gateway(env), TOKEN)).status).toBe(200);
  });

  it('any other flag value keeps it refused; a token with , or : is never a key', () => {
    expect(gatewayClientKeys({ SANDBOX_TOKEN: TOKEN, ACCEPT_SANDBOX_TOKEN_AS_KEY: 'true' }).keys).toEqual([]);
    const bad = gatewayClientKeys({ SANDBOX_TOKEN: 'a:b', ACCEPT_SANDBOX_TOKEN_AS_KEY: '1' });
    expect(bad.keys).toEqual([]);
  });
});
