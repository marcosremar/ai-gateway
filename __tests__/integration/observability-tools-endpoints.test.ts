/**
 * Integration — exercises the observability + tools/dispatch HTTP endpoints
 * against a running gateway on AIGW_INTEGRATION_URL (default http://localhost:3000).
 *
 * Skipped when AIGW_SKIP_INTEGRATION=1 OR no gateway responds at the URL within
 * 2s, so this stays green in environments where the dev server isn't running.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadEnv } from '../helpers';

const URL_BASE = process.env.AIGW_INTEGRATION_URL ?? 'http://localhost:3000';
const SKIP = process.env.AIGW_SKIP_INTEGRATION === '1';

let API_KEY: string | null = null;
let GATEWAY_LIVE = false;

async function pickApiKey(): Promise<string | null> {
  // GATEWAY_API_KEYS is a comma-separated list of "key:label" pairs. We just
  // need one valid bearer token — the first one parses fine.
  const raw = process.env.GATEWAY_API_KEYS ?? process.env.GATEWAY_API_KEY ?? '';
  if (!raw) return null;
  const first = raw.split(',')[0].trim();
  return first.includes(':') ? first.split(':')[0] : first;
}

async function probeGateway(): Promise<boolean> {
  try {
    const res = await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  await loadEnv();
  API_KEY = await pickApiKey();
  GATEWAY_LIVE = await probeGateway();
});

const guard = (): boolean => SKIP || !GATEWAY_LIVE || !API_KEY;

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
}

describe('integration: observability endpoints', () => {
  it.skipIf(SKIP)('GET /v1/observability/otlp/status returns enabled flag', async () => {
    if (guard()) return;
    const res = await fetch(`${URL_BASE}/v1/observability/otlp/status`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json() as { enabled: boolean };
    expect(typeof data.enabled).toBe('boolean');
  });

  it.skipIf(SKIP)('POST /v1/observability/otlp/flush returns 412 when not configured', async () => {
    if (guard()) return;
    const status = await (await fetch(`${URL_BASE}/v1/observability/otlp/status`, { headers: authHeaders() })).json() as { enabled: boolean };
    if (status.enabled) return; // env-configured environments: skip
    const res = await fetch(`${URL_BASE}/v1/observability/otlp/flush`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(412);
  });

  it.skipIf(SKIP)('GET/POST /v1/observability/mute-state round-trips strategy', async () => {
    if (guard()) return;
    const initial = await (await fetch(`${URL_BASE}/v1/observability/mute-state`, { headers: authHeaders() })).json() as { strategy: string };
    const setRes = await fetch(`${URL_BASE}/v1/observability/mute-state`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ strategy: 'never' }),
    });
    expect(setRes.status).toBe(200);
    const setData = await setRes.json() as { ok: boolean; strategy: string };
    expect(setData.ok).toBe(true);
    expect(setData.strategy).toBe('never');

    const verify = await (await fetch(`${URL_BASE}/v1/observability/mute-state`, { headers: authHeaders() })).json() as { strategy: string };
    expect(verify.strategy).toBe('never');

    // Restore — best-effort, even on assert failure above.
    await fetch(`${URL_BASE}/v1/observability/mute-state`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ strategy: initial.strategy ?? 'always_mute_during_bot_speech' }),
    });
  });

  it.skipIf(SKIP)('rejects invalid mute strategy', async () => {
    if (guard()) return;
    const res = await fetch(`${URL_BASE}/v1/observability/mute-state`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ strategy: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/observability/turn-latency returns array shape', async () => {
    if (guard()) return;
    const res = await fetch(`${URL_BASE}/v1/observability/turn-latency`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json() as { count: number; items: unknown[] };
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.count).toBe('number');
  });
});

describe('integration: POST /v1/tools/dispatch', () => {
  it.skipIf(SKIP)('echo tool returns input verbatim', async () => {
    if (guard()) return;
    const res = await fetch(`${URL_BASE}/v1/tools/dispatch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        assistantMessage: { role: 'assistant', content: [{ type: 'tool_use', id: 'i1', name: 'e', input: { x: 1 } }] },
        tools: [{ name: 'e', kind: 'echo' }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { invoked: number; errors: number; toolMessage: { content: { content: string }[] } };
    expect(data.invoked).toBe(1);
    expect(data.errors).toBe(0);
    expect(data.toolMessage.content[0].content).toContain('"x":1');
  });

  it.skipIf(SKIP)('builtin current_time returns ISO + epoch', async () => {
    if (guard()) return;
    const res = await fetch(`${URL_BASE}/v1/tools/dispatch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        assistantMessage: { role: 'assistant', content: [{ type: 'tool_use', id: 'i2', name: 'now', input: {} }] },
        tools: [{ name: 'now', kind: 'builtin', builtin: 'current_time' }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { toolMessage: { content: { content: string }[] } };
    const inner = JSON.parse(data.toolMessage.content[0].content) as { iso: string; epoch_ms: number };
    expect(inner.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(inner.epoch_ms).toBeGreaterThan(0);
  });

  it.skipIf(SKIP)('builtin json_extract walks nested path', async () => {
    if (guard()) return;
    const res = await fetch(`${URL_BASE}/v1/tools/dispatch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        assistantMessage: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'i3', name: 'x', input: { json: { user: { name: 'alice' } }, path: '$.user.name' } }],
        },
        tools: [{ name: 'x', kind: 'builtin', builtin: 'json_extract' }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { errors: number; toolMessage: { content: { content: string }[] } };
    expect(data.errors).toBe(0);
    expect(JSON.parse(data.toolMessage.content[0].content)).toBe('alice');
  });

  it.skipIf(SKIP)('builtin http_get blocks AWS metadata IP (SSRF)', async () => {
    if (guard()) return;
    const res = await fetch(`${URL_BASE}/v1/tools/dispatch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        assistantMessage: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'i4', name: 'f', input: { url: 'http://169.254.169.254/latest' } }],
        },
        tools: [{ name: 'f', kind: 'builtin', builtin: 'http_get' }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { errors: number; toolMessage: { content: { content: string }[] } };
    expect(data.errors).toBe(1);
    expect(data.toolMessage.content[0].content).toMatch(/SSRF/);
  });

  it.skipIf(SKIP)('builtin read_file refuses when no allowed dirs', async () => {
    if (guard()) return;
    const res = await fetch(`${URL_BASE}/v1/tools/dispatch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        assistantMessage: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'i5', name: 'r', input: { path: '/etc/passwd' } }],
        },
        tools: [{ name: 'r', kind: 'builtin', builtin: 'read_file' }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { errors: number; toolMessage: { content: { content: string }[] } };
    expect(data.errors).toBe(1);
    expect(data.toolMessage.content[0].content).toMatch(/no allowed directories/);
  });

  it.skipIf(SKIP)('unknown builtin reports available list', async () => {
    if (guard()) return;
    const res = await fetch(`${URL_BASE}/v1/tools/dispatch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        assistantMessage: { role: 'assistant', content: [{ type: 'tool_use', id: 'i6', name: 'x', input: {} }] },
        tools: [{ name: 'x', kind: 'builtin', builtin: 'nonexistent' }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { errors: number; toolMessage: { content: { content: string }[] } };
    expect(data.errors).toBe(1);
    expect(data.toolMessage.content[0].content).toMatch(/current_time, http_get/);
  });

  it.skipIf(SKIP)('rejects request without assistantMessage', async () => {
    if (guard()) return;
    const res = await fetch(`${URL_BASE}/v1/tools/dispatch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ tools: [] }),
    });
    expect(res.status).toBe(400);
  });
});
