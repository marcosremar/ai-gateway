/**
 * `POST /v1/audio/speech/engine`: an app's TTS alias → the engine its GPU deployment keeps loaded (speech-stack
 * `POST /v1/tts/engine`), with the app-key alias rule, a cold GPU as 503, and the replica's 409 / 404 passed on.
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentError } from '../../../src/deployments/controller-state';
import { createTtsEngineRoute, ttsEngineOf } from '../../../src/gateway/proxy/routes/tts-engine';

const servers: Server[] = [];
afterEach(async () => { while (servers.length) await new Promise<void>(r => servers.pop()!.close(() => r())); });

async function gateway(replica: { status: number; body: unknown }, cold = false) {
  const calls: Array<{ url: string; body: unknown; token: string }> = [];
  const done = vi.fn();
  const route = createTtsEngineRoute({
    controller: {
      acquire: vi.fn(async () => {
        if (cold) throw new DeploymentError(503, "deployment 'babelcast-gpu': replicas are starting", 30);
        return { machine: { id: 'r1', ip: '10.0.0.9' }, token: 'tok', exposed: false, done } as never;
      }),
    },
    linksOf: (model) => ({
      'babelcast-tts-pocket': [{ deployment: 'babelcast-gpu', upstreamModel: 'pocket' }],
      'babelcast-tts-kokoro': [{ deployment: 'babelcast-gpu', upstreamModel: 'kokoro' }],
      'babelcast-tts': [{ deployment: 'babelcast-tts-clone', upstreamModel: 'babelcast-tts' }],
    } as Record<string, Array<{ deployment: string; upstreamModel: string }>>)[model] ?? [],
    userOf: (req) => ({ 'Bearer app': 'babelcast', 'Bearer admin': 'ops' } as Record<string, string>)[String(req.headers.authorization)] ?? null,
    isAdmin: (u) => u === 'ops',
    aliasesOf: (u) => (u === 'babelcast' ? new Set(['babelcast-tts', 'babelcast-tts-kokoro', 'babelcast-tts-pocket', 'babelcast-tts-scribe']) : null),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), token: (init.headers as Record<string, string>)['X-Aigw-Token']! });
      return Response.json(replica.body, { status: replica.status });
    }) as never,
  });
  const server = createServer((req, res) => { void route(req, res); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/audio/speech/engine`;
  const post = async (body: unknown, key = 'app') => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), json: await res.json() as Record<string, unknown> };
  };
  return { post, calls, done };
}

describe('TTS engine selection', () => {
  it('names the engine from the deployment link of the alias and forwards force', async () => {
    const replica = { active: 'qwen', switching_to: 'pocket', engines: {} };
    const gw = await gateway({ status: 200, body: { ok: true, ...replica } });
    const r = await gw.post({ model: 'babelcast-tts-pocket' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, deployment: 'babelcast-gpu', engine: 'pocket', selected: true, replica: { switching_to: 'pocket' } });
    expect(gw.calls[0]).toEqual({ url: 'http://10.0.0.9/v1/tts/engine', body: { engine: 'pocket', force: false }, token: 'tok' });
    await gw.post({ model: 'babelcast-tts-kokoro', force: true });
    expect(gw.calls[1]!.body).toEqual({ engine: 'kokoro', force: true });
    expect(gw.done).toHaveBeenCalledWith(false);
  });

  it('refuses a foreign alias, needs a model, and says when there is nothing to choose', async () => {
    const gw = await gateway({ status: 404, body: { detail: 'Not Found' } });
    expect((await gw.post({ model: 'qwen3-tts' })).status).toBe(403);
    expect((await gw.post({})).status).toBe(400);
    expect((await gw.post({ model: 'babelcast-tts-pocket' }, 'nope')).status).toBe(401);
    expect((await gw.post({ model: 'babelcast-tts-scribe' })).json).toMatchObject({ ok: true, selected: false, reason: 'no_gpu_link' });
    expect((await gw.post({ model: 'babelcast-tts' })).json).toMatchObject({ ok: true, selected: false, reason: 'no_engine_choice', engine: 'qwen' });
    expect((await gw.post({ model: 'qwen3-tts' }, 'admin')).json).toMatchObject({ reason: 'no_gpu_link' });
  });

  it('passes the replica 409 (another engine in use) and a cold GPU as 503 with Retry-After', async () => {
    const busy = await gateway({ status: 409, body: { ok: false, code: 'in_use', active: 'qwen' } });
    const r = await busy.post({ model: 'babelcast-tts-pocket' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: { code: 'engine_in_use' }, replica: { active: 'qwen' } });
    const cold = await gateway({ status: 200, body: {} }, true);
    const c = await cold.post({ model: 'babelcast-tts-pocket' });
    expect(c.status).toBe(503);
    expect(c.retryAfter).toBe('30');
    expect(c.json).toMatchObject({ error: { code: 'gpu_not_ready' }, engine: 'pocket' });
  });

  it('reads the engine the way the replica does', () => {
    expect(['kokoro', 'hexgrad/Kokoro-82M', 'pocket', 'kyutai/pocket-tts', 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', 'babelcast-tts'].map(ttsEngineOf))
      .toEqual(['kokoro', 'kokoro', 'pocket', 'pocket', 'qwen', 'qwen']);
  });
});
