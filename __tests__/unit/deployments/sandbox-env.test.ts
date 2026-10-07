import { describe, expect, it, vi } from 'vitest';
import { isEnvPinned, loadSandboxEnv, principalSandboxToken } from '../../../src/config/sandbox-env';
import { proxyIdleTimeoutMs } from '../../../src/deployments';

describe('SANDBOX_TOKEN → dev API', () => {
  it('applies the palco keys (palco wins over the env, pinned keys excepted) from the first URL that answers', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ SCW_SECRET_KEY: 'scw', SCW_PROJECT_ID: 'proj', GROQ_API_KEY: 'from-api', bad: 'x' }));
    const env: Record<string, string | undefined> = { SANDBOX_TOKEN: 'tok', GROQ_API_KEY: 'mine', SCW_PROJECT_ID: 'proj' };
    const r = await loadSandboxEnv(env, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(r.source).toBe('https://ucast.me/api/sandbox-env');
    expect(r.applied.sort()).toEqual(['GROQ_API_KEY', 'SCW_SECRET_KEY']);
    expect(r.received.sort()).toEqual(['GROQ_API_KEY', 'SCW_PROJECT_ID', 'SCW_SECRET_KEY']);
    expect(env).toMatchObject({ SCW_SECRET_KEY: 'scw', GROQ_API_KEY: 'from-api' });
    expect(env.bad).toBeUndefined();
  });

  it('never lets the palco override the token, its aliases, PORT or infra URLs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ SANDBOX_TOKEN: 'other', PORT: '1', DATABASE_URL: 'x', OPENROUTER_API_KEY: 'or' }));
    const env: Record<string, string | undefined> = { SANDBOX_TOKEN: 'tok', PORT: '4000', DATABASE_URL: 'pg' };
    const r = await loadSandboxEnv(env, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(env).toMatchObject({ SANDBOX_TOKEN: 'tok', PORT: '4000', DATABASE_URL: 'pg', OPENROUTER_API_KEY: 'or' });
    expect(r.applied).toEqual(['OPENROUTER_API_KEY']);
    expect(isEnvPinned('PALCO_PROXY_TOKEN')).toBe(true);
    expect(isEnvPinned('GROQ_API_KEY')).toBe(false);
    for (const name of ['OPENROUTER_API_BASE', 'GROQ_API_BASE', 'MLX_QWEN3_ASR_BASE_URL', 'GATEWAY_HOST', 'B2_ENDPOINT', 'APP_URL']) {
      expect(isEnvPinned(name)).toBe(true);
    }
    for (const name of ['OPENROUTER_API_KEY', 'HF_TOKEN', 'SCW_PROJECT_ID', 'DATABASE_KEY', 'BASELINE_MS']) expect(isEnvPinned(name)).toBe(false);
  });

  it('does nothing without a token and never throws when the API is down', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    expect((await loadSandboxEnv({}, { fetchImpl: fetchImpl as unknown as typeof fetch })).source).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    const r = await loadSandboxEnv({ PALCO_PROXY: 't' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.source).toBeNull();
    expect(r.errors).toHaveLength(2);
  });

  it('reads the token from its Railway aliases', () => {
    expect(principalSandboxToken({ PALCO_PROXY_TOKEN: ' a ' })).toBe('a');
    expect(principalSandboxToken({ SANDBOX_TOKEN: 'b', PROXY_TOKEN: 'c' })).toBe('b');
  });
});

describe('proxy idle limit with deployments (regression: Bun cut a real cold start at 60 s)', () => {
  it('raises it to 15 min unless PROXY_TOTAL_TIMEOUT_MS is set', () => {
    expect(proxyIdleTimeoutMs({}, true)).toBe('900000');
    expect(proxyIdleTimeoutMs({}, false)).toBeNull();
    expect(proxyIdleTimeoutMs({ PROXY_TOTAL_TIMEOUT_MS: '120000' }, true)).toBe('120000');
  });
});
