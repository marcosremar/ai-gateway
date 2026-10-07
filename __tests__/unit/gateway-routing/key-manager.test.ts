import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeyAdminRoutes, KeyManager } from '../../../src/config/key-manager';
import { OpenAICompatLLMProvider } from '../../../src/gateway/providers/cloud/openai-compat/openai-compat-llm';
import { createProxyServer } from '../../../src/gateway/proxy/server';

const PALCO = 'https://parle-palco.up.railway.app/api/sandbox-env';
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Fake palco: GET returns `store`, PUT merges into it. */
function fakePalco(store: Record<string, string>, opts: { down?: boolean } = {}) {
  return vi.fn<FetchImpl>(async (_url, init) => {
    if (opts.down) throw new Error('ECONNREFUSED');
    if (init?.method === 'PUT') { Object.assign(store, JSON.parse(String(init.body))); return Response.json({ ok: true }); }
    return Response.json({ ...store });
  });
}

describe('KeyManager — keys change at runtime', () => {
  it('a reload swaps the key the next request uses (providers read the env per call)', async () => {
    const env: Record<string, string | undefined> = { SANDBOX_TOKEN: 'tok', ROTATE_TEST_KEY: 'old-key-value' };
    const provider = new OpenAICompatLLMProvider({ providerId: 'groq', baseURL: 'https://example.invalid/v1', envKey: 'ROTATE_TEST_KEY' });
    const store = { ROTATE_TEST_KEY: 'new-key-value' };
    const manager = new KeyManager(env, { fetchImpl: fakePalco(store) as never });
    const saved = process.env.ROTATE_TEST_KEY;
    try {
      process.env.ROTATE_TEST_KEY = env.ROTATE_TEST_KEY;
      expect((provider as unknown as { getClient(): { apiKey: string } }).getClient().apiKey).toBe('old-key-value');
      const r = await manager.reload();
      process.env.ROTATE_TEST_KEY = env.ROTATE_TEST_KEY; // serve.ts passes process.env itself
      expect(r).toMatchObject({ ok: true, changed: ['ROTATE_TEST_KEY'], removed: [] });
      expect((provider as unknown as { getClient(): { apiKey: string } }).getClient().apiKey).toBe('new-key-value');
    } finally {
      if (saved === undefined) delete process.env.ROTATE_TEST_KEY; else process.env.ROTATE_TEST_KEY = saved;
    }
  });

  it('keys the palco stops returning are removed; onChange gets the names', async () => {
    const env: Record<string, string | undefined> = { SANDBOX_TOKEN: 'tok' };
    const store: Record<string, string> = { GROQ_API_KEY: 'g1', OPENROUTER_API_KEY: 'o1' };
    const onChange = vi.fn();
    const manager = new KeyManager(env, { fetchImpl: fakePalco(store) as never, onChange });
    await manager.reload();
    delete store.GROQ_API_KEY;
    store.OPENROUTER_API_KEY = 'o2';
    const r = await manager.reload();
    expect(r).toMatchObject({ changed: ['OPENROUTER_API_KEY'], removed: ['GROQ_API_KEY'] });
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBe('o2');
    expect(onChange).toHaveBeenLastCalledWith(['OPENROUTER_API_KEY', 'GROQ_API_KEY']);
  });

  it('a failed reload keeps the current keys and calls nobody', async () => {
    const env: Record<string, string | undefined> = { SANDBOX_TOKEN: 'tok', GROQ_API_KEY: 'keep-me' };
    const onChange = vi.fn();
    const log = vi.fn();
    const manager = new KeyManager(env, { fetchImpl: fakePalco({}, { down: true }) as never, onChange, log });
    manager.adopt(['GROQ_API_KEY']);
    const r = await manager.reload();
    expect(r.ok).toBe(false);
    expect(env.GROQ_API_KEY).toBe('keep-me');
    expect(onChange).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('keep-me');
  });

  it('write() PUTs to the palco with the token, then reloads; only names come back', async () => {
    const env: Record<string, string | undefined> = { SANDBOX_TOKEN: 'tok' };
    const store: Record<string, string> = {};
    const fetchImpl = fakePalco(store);
    const log = vi.fn();
    const manager = new KeyManager(env, { fetchImpl: fetchImpl as never, log });
    const out = await manager.write({ OPENROUTER_API_KEY: ' sk-or-v1-newvalue ' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(PALCO);
    expect(init?.method).toBe('PUT');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(store.OPENROUTER_API_KEY).toBe('sk-or-v1-newvalue');
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-v1-newvalue');
    expect(out.written).toEqual(['OPENROUTER_API_KEY']);
    expect(JSON.stringify(out)).not.toContain('newvalue');
    expect(JSON.stringify(log.mock.calls)).not.toContain('newvalue');
  });

  it.each(['SANDBOX_TOKEN', 'PALCO_PROXY', 'PROXY_TOKEN', 'PORT', 'DATABASE_URL', 'lower_case'])('refuses to write %s', async (name) => {
    const fetchImpl = fakePalco({});
    const manager = new KeyManager({ SANDBOX_TOKEN: 'tok' }, { fetchImpl: fetchImpl as never });
    await expect(manager.write({ [name]: 'x' })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Regression (QA 06/10/2026): only `_URL` was protected, so an admin key could write OPENROUTER_API_BASE /
  // GROQ_API_BASE and redirect every STT/LLM/TTS call (students' audio and text) after the next restart.
  it.each(['OPENROUTER_API_BASE', 'GROQ_API_BASE', 'WHISPER_SERVER_BASE_URL', 'GATEWAY_HOST', 'OTEL_EXPORTER_OTLP_ENDPOINT',
    'SNAPGPU_S3_ENDPOINT'])('refuses to write the endpoint override %s', async (name) => {
    const fetchImpl = fakePalco({});
    const manager = new KeyManager({ SANDBOX_TOKEN: 'tok' }, { fetchImpl: fetchImpl as never });
    await expect(manager.write({ [name]: 'https://evil.example' })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a provider API base on the palco is never adopted, and the host value always wins for endpoints', async () => {
    const store = { OPENROUTER_API_BASE: 'https://evil.example/v1', GROQ_API_BASE: 'https://evil.example', GATEWAY_HOST: 'evil', GROQ_API_KEY: 'k' };
    const env: Record<string, string | undefined> = { SANDBOX_TOKEN: 'tok', GATEWAY_HOST: '0.0.0.0' };
    const manager = new KeyManager(env, { fetchImpl: fakePalco(store) as never });
    const r = await manager.reload();
    expect(r.changed).toEqual(['GROQ_API_KEY']);
    expect(env.OPENROUTER_API_BASE).toBeUndefined();
    expect(env.GROQ_API_BASE).toBeUndefined();
    expect(env.GATEWAY_HOST).toBe('0.0.0.0');
  });

  it('palco refusing the write is a 502, not a silent success', async () => {
    const manager = new KeyManager({ SANDBOX_TOKEN: 'tok' }, { fetchImpl: vi.fn(async () => new Response('', { status: 403 })) as never });
    await expect(manager.write({ GROQ_API_KEY: 'v' })).rejects.toMatchObject({ status: 502, message: 'palco refused the write: HTTP 403' });
  });
});

describe('admin routes through the proxy', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); server = null; }));

  async function start(manager: KeyManager): Promise<string> {
    server = createProxyServer({
      apiKeys: ['admin-key:sandbox', 'user-key:alice'],
      providers: {},
      customRoutes: createKeyAdminRoutes(manager, (t) => t === 'admin-key'),
      deepHealth: { authorize: (t) => t === 'admin-key', report: async () => ({ status: 200, body: { status: 'ok' } }) },
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('reload and write need the admin key and answer names only', async () => {
    const store: Record<string, string> = { GROQ_API_KEY: 'gsk_fromPalco0001' };
    const manager = new KeyManager({ SANDBOX_TOKEN: 'tok' }, { fetchImpl: fakePalco(store) as never });
    const base = await start(manager);
    const denied = await fetch(`${base}/v1/admin/keys/reload`, { method: 'POST', headers: { Authorization: 'Bearer user-key' } });
    expect(denied.status).toBe(403);
    const reload = await fetch(`${base}/v1/admin/keys/reload`, { method: 'POST', headers: { Authorization: 'Bearer admin-key' } });
    const reloadText = await reload.text();
    expect(reload.status).toBe(200);
    expect(JSON.parse(reloadText)).toMatchObject({ ok: true, changed: ['GROQ_API_KEY'] });
    expect(reloadText).not.toContain('gsk_fromPalco0001');
    const put = await fetch(`${base}/v1/admin/keys`, {
      method: 'PUT', headers: { Authorization: 'Bearer admin-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ OPENROUTER_API_KEY: 'sk-or-v1-written0001' }),
    });
    const putText = await put.text();
    expect(put.status).toBe(200);
    expect(JSON.parse(putText)).toMatchObject({ written: ['OPENROUTER_API_KEY'], reloaded: true, changed: ['OPENROUTER_API_KEY'] });
    expect(putText).not.toContain('written0001');
    const protectedName = await fetch(`${base}/v1/admin/keys`, {
      method: 'PUT', headers: { Authorization: 'Bearer admin-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ SANDBOX_TOKEN: 'x' }),
    });
    expect(protectedName.status).toBe(400);
  });

  it('GET /health stays open; /health?deep=1 needs the admin key (no key 401, another valid key 403)', async () => {
    const base = await start(new KeyManager({}));
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/health?deep=1`)).status).toBe(401);
    expect((await fetch(`${base}/health?deep=1`, { headers: { Authorization: 'Bearer user-key' } })).status).toBe(403);
    const ok = await fetch(`${base}/health?deep=1`, { headers: { Authorization: 'Bearer admin-key' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'ok' });
  });
});

