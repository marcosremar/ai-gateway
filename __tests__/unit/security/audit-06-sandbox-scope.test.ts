import { describe, expect, it } from 'vitest';
import { gatewayClientKeys, isHostOnly, SANDBOX_USER } from '../../../src/config/sandbox-env';
import { adminUsersFromEnv } from '../../../src/deployments';
import { requestIsNoWake } from '../../../src/gateway/proxy/no-wake';

const TOKEN = 'sandbox-master-token-0123456789';

describe('audit 2026-10-09 #6: the SANDBOX_TOKEN is neither admin nor able to wake machines', () => {
  it('accepted as a key (ACCEPT_SANDBOX_TOKEN_AS_KEY=1) it is a plain, non-waking user', () => {
    const env = { SANDBOX_TOKEN: TOKEN, ACCEPT_SANDBOX_TOKEN_AS_KEY: '1', DEPLOYMENTS_ADMIN_USERS: 'ops' };
    const { keys } = gatewayClientKeys(env);
    expect(keys).toEqual([`${TOKEN}:${SANDBOX_USER}`]);
    expect([...adminUsersFromEnv(env)]).toEqual(['ops']);
    expect(requestIsNoWake(undefined, SANDBOX_USER, env)).toBe(true);
    expect(requestIsNoWake(undefined, 'parle', env)).toBe(false);
  });

  it('listing `sandbox` in DEPLOYMENTS_ADMIN_USERS does not make it admin either', () => {
    expect([...adminUsersFromEnv({ DEPLOYMENTS_ADMIN_USERS: 'ops,sandbox' })]).toEqual(['ops']);
  });

  it('two roles only (owner, 10/10/2026): SANDBOX_TOKEN_ADMIN=1 no longer makes the dev token an admin, and says so', () => {
    const env = { SANDBOX_TOKEN: TOKEN, ACCEPT_SANDBOX_TOKEN_AS_KEY: '1', SANDBOX_TOKEN_ADMIN: '1' };
    const { warnings } = gatewayClientKeys(env);
    expect(adminUsersFromEnv(env).size).toBe(0);
    expect(requestIsNoWake(undefined, SANDBOX_USER, env)).toBe(true);
    expect(warnings.join('\n')).toMatch(/SANDBOX_TOKEN_ADMIN is no longer read/);
  });

  it('the flags that widen it come only from the host, never from the dev API catalog', () => {
    for (const name of ['ACCEPT_SANDBOX_TOKEN_AS_KEY', 'SANDBOX_TOKEN_ADMIN', 'SANDBOX_TOKEN_APP']) expect(isHostOnly(name)).toBe(true);
  });
});
