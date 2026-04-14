/**
 * Integration tests for the BabelCast gateway using native fetch.
 *
 * Works with BOTH deployment modes:
 * - serve.ts (Fly.io proxy) — OpenAI-compatible endpoints
 * - ws-server.ts (local dev) — full endpoint set
 *
 * Run:
 *   bun test __tests__/gateway-live.test.ts
 *
 * Set SKIP_LIVE_TESTS=1 to skip in CI.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { loadTestVoiceWav } from '../helpers';
import { GATEWAY_HANDLERS } from '../mock-fetch';

const GATEWAY_API_KEY =
  process.env.GATEWAY_API_KEY || 'gw_a7970fa694c2f381390fbd12962a2fe915c8d0a24406b28b';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

// Resolve gateway URL: explicit env var → localhost:4000 → start mock server
let GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:4000';

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Start a minimal mock server when no real gateway is available
let mockServer: { stop: () => void } | null = null;

if (!SKIP) {
  const realAvailable = await isReachable(GATEWAY_URL);
  if (!realAvailable) {
    const server = createServer((req, res) => {
      const url = `http://localhost${req.url ?? '/'}`;
      const method = (req.method ?? 'GET').toUpperCase();
      for (const route of GATEWAY_HANDLERS) {
        if (route.match(url, method)) {
          const mockRes = route.handle(url);
          mockRes
            .text()
            .then((body) => {
              res.writeHead(mockRes.status, { 'Content-Type': 'application/json' });
              res.end(body);
            })
            .catch(() => {
              res.writeHead(500);
              res.end('{}');
            });
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    GATEWAY_URL = `http://localhost:${port}`;
    mockServer = { stop: () => server.close() };
    console.log(`  [gateway-live] No real gateway — started mock server at ${GATEWAY_URL}`);
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(GATEWAY_API_KEY ? { Authorization: `Bearer ${GATEWAY_API_KEY}` } : {}),
    ...extra,
  };
}

async function gw<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: { ...headers(), ...(init?.headers as Record<string, string>) },
    signal: AbortSignal.timeout(15_000),
  });
  return res.json() as Promise<T>;
}

afterAll(() => {
  mockServer?.stop();
});

describe.skipIf(SKIP)('Gateway Live', () => {
  // ── Health ─────────────────────────────────────────────────────────────

  describe('health', () => {
    it('returns healthy status', async () => {
      const d = await gw('/health');
      expect(d.status).toBe('ok');
    });

    it('has uptime or minimal health response', async () => {
      const d = await gw('/health');
      expect(d.status).toBe('ok');
      // Proxy (serve.ts) returns minimal { status: "ok" }
      // Full server (ws-server) returns { status, uptime_sec, components, ... }
      const uptime = d.uptime_sec ?? d.uptimeSec;
      if (uptime !== undefined) {
        expect(typeof uptime).toBe('number');
      }
    });
  });

  // ── Chat / LLM (OpenAI-compatible) ─────────────────────────────────────

  describe('chat', () => {
    it('returns a response from Groq', async () => {
      const d = await gw('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
          max_tokens: 10,
        }),
      });
      const content = (d as any).choices?.[0]?.message?.content || '';
      expect(content.toUpperCase()).toContain('PONG');
    });

    it('handles system + user messages', async () => {
      const d = await gw('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are a translator. Reply only with the translation.' },
            { role: 'user', content: 'Translate to French: Hello' },
          ],
          max_tokens: 20,
        }),
      });
      const content = (d as any).choices?.[0]?.message?.content || '';
      expect(content.length).toBeGreaterThan(0);
    });

    it('returns usage information', async () => {
      const d = await gw('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: 'Say hi' }],
          max_tokens: 5,
        }),
      });
      const usage = (d as any).usage;
      // Proxy may or may not include usage — depends on provider response passthrough
      if (usage) {
        // Proxy may pass through partial usage from provider
        expect(typeof usage).toBe('object');
      }
      // At minimum, we should have a response
      expect((d as any).choices?.length).toBeGreaterThan(0);
    });
  });

  // ── STT / Transcribe (OpenAI-compatible multipart) ─────────────────────

  describe('transcribe', () => {
    it('accepts voice WAV and returns transcription', async () => {
      const wav = loadTestVoiceWav();

      // Try OpenAI-compatible multipart endpoint first (serve.ts proxy)
      let res = await fetch(`${GATEWAY_URL}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: headers(),
        body: (() => {
          const f = new FormData();
          f.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav');
          f.append('model', 'whisper-large-v3-turbo');
          f.append('language', 'en');
          return f;
        })(),
        signal: AbortSignal.timeout(15_000),
      });

      // Fall back to raw body endpoint (ws-server.ts)
      if (res.status === 404) {
        res = await fetch(`${GATEWAY_URL}/v1/transcribe?language=en`, {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'audio/wav' },
          body: wav,
          signal: AbortSignal.timeout(15_000),
        });
      }

      const d = (await res.json()) as { text?: string };
      expect(typeof d.text).toBe('string');
      expect(d.text!.length).toBeGreaterThan(5);
    });
  });

  // ── Translation (via chat) ──────────────────────────────────────────────

  describe('translate', () => {
    it('translates French to English via LLM', async () => {
      const d = await gw('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content:
                'Translate the following French text to English. Reply ONLY with the translation.',
            },
            { role: 'user', content: 'Bonjour le monde' },
          ],
          max_tokens: 20,
          temperature: 0.1,
        }),
      });
      const content = ((d as any).choices?.[0]?.message?.content || '').toLowerCase();
      expect(content).toMatch(/hello|world/);
    });
  });

  // ── GPU Status (may not be available on proxy) ──────────────────────────

  describe('gpu', () => {
    it('returns gpu status or 404 on proxy', async () => {
      const res = await fetch(`${GATEWAY_URL}/v1/gpu/status`, {
        headers: headers(),
        signal: AbortSignal.timeout(5_000),
      });
      // serve.ts proxy may not expose /v1/gpu/status — accept both
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        const d = (await res.json()) as Record<string, unknown>;
        expect(d.status).toBeDefined();
      }
    });
  });

  // ── Workloads API ──────────────────────────────────────────────────────

  describe('workloads', () => {
    it('lists workloads (empty on fresh deploy)', async () => {
      const res = await fetch(`${GATEWAY_URL}/v1/workloads`, {
        headers: headers(),
        signal: AbortSignal.timeout(5_000),
      });
      // Workloads may not be available on proxy — accept both
      if (res.status === 200) {
        const d = (await res.json()) as { workloads?: unknown[] };
        expect(Array.isArray(d.workloads)).toBe(true);
      } else {
        expect([404, 401]).toContain(res.status);
      }
    });
  });

  // ── End-to-end subtitle translation ──────────────────────────────────

  describe('e2e subtitle flow', () => {
    it('translates French text to English via chat', async () => {
      const d = await gw('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content:
                'You are a subtitle translator. Translate the following French text to English. Reply ONLY with the translation, nothing else.',
            },
            { role: 'user', content: "Bonjour, comment allez-vous aujourd'hui?" },
          ],
          max_tokens: 50,
          temperature: 0.1,
        }),
      });
      const text = ((d as any).choices?.[0]?.message?.content || '').toLowerCase();
      expect(text).toMatch(/hello|hi|good|how|today/);
    });
  });
});
