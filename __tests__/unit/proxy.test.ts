import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createProxyServer } from '../../src/proxy/server';
import { validateAuth } from '../../src/proxy/middleware/auth';
import { RateLimiter } from '../../src/proxy/middleware/rate-limit';
import type { LLMProvider, ChatResponse } from '../../src/providers/types';
import type { Server } from 'http';

describe('Proxy', () => {
  describe('validateAuth', () => {
    it('allows when no keys configured', () => {
      expect(validateAuth(undefined, [])).toBe(true);
    });

    it('rejects when keys configured but no header', () => {
      expect(validateAuth(undefined, ['key1'])).toBe(false);
    });

    it('accepts valid Bearer token', () => {
      expect(validateAuth('Bearer key1', ['key1', 'key2'])).toBe(true);
    });

    it('rejects invalid token', () => {
      expect(validateAuth('Bearer wrong', ['key1'])).toBe(false);
    });
  });

  describe('RateLimiter', () => {
    it('allows requests within limit', () => {
      const limiter = new RateLimiter(3);
      expect(limiter.check('1.2.3.4').allowed).toBe(true);
      expect(limiter.check('1.2.3.4').allowed).toBe(true);
      expect(limiter.check('1.2.3.4').allowed).toBe(true);
    });

    it('blocks requests over limit', () => {
      const limiter = new RateLimiter(2);
      expect(limiter.check('1.2.3.4').allowed).toBe(true);
      expect(limiter.check('1.2.3.4').allowed).toBe(true);
      expect(limiter.check('1.2.3.4').allowed).toBe(false);
    });

    it('limits are per-IP', () => {
      const limiter = new RateLimiter(1);
      expect(limiter.check('1.1.1.1').allowed).toBe(true);
      expect(limiter.check('2.2.2.2').allowed).toBe(true);
      expect(limiter.check('1.1.1.1').allowed).toBe(false);
    });

    it('allows unlimited when rpm is 0', () => {
      const limiter = new RateLimiter(0);
      for (let i = 0; i < 100; i++) {
        expect(limiter.check('1.1.1.1').allowed).toBe(true);
      }
    });
  });

  describe('createProxyServer', () => {
    let server: Server;
    let port: number;

    const mockProvider: LLMProvider = {
      providerId: 'test',
      isConfigured: () => true,
      chat: vi.fn().mockResolvedValue({
        content: 'Hello!',
        model: 'test-model',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      } as ChatResponse),
    };

    beforeEach(async () => {
      server = createProxyServer({
        port: 0, // random port
        providers: {
          chat: { 'test-model': mockProvider },
        },
      });
      server.keepAliveTimeout = 0;

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      port = (server.address() as { port: number }).port;
    });

    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('GET /health returns ok', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });

    it('GET /v1/models lists models', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<{ id: string }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('test-model');
    });

    it('POST /v1/chat/completions returns completion', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0].message.content).toBe('Hello!');
    });

    it('returns 404 for unknown model', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'unknown-model',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 for unknown route', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe('createProxyServer with auth', () => {
    let server: Server;
    let port: number;

    beforeEach(async () => {
      server = createProxyServer({
        port: 0,
        apiKeys: ['valid-key'],
        providers: { chat: {} },
      });
      server.keepAliveTimeout = 0;
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      port = (server.address() as { port: number }).port;
    });

    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('health endpoint is public (no auth required)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    });

    it('rejects non-health request without auth', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      expect(res.status).toBe(401);
    });

    it('accepts request with valid auth', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { 'Authorization': 'Bearer valid-key' },
      });
      expect(res.status).toBe(200);
    });
  });
});
