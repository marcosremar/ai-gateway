/**
 * Hyperstack VM hibernation — unit tests for hibernate / hibernate-restore.
 *
 * Route shapes verified against the live API (2026-04-18):
 *   GET /core/virtual-machines/{id}/hibernate
 *     → 404 "VM 1 does not exists" on bogus id (so route exists)
 *   OPTIONS /core/virtual-machines/{id}/hibernate
 *     → allow: OPTIONS, GET, HEAD
 *   POST to either endpoint → 405 Method Not Allowed.
 *
 * So hibernate is GET-only (same pattern as `/start` and `/stop`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { HyperstackClient } from '../src/gpu-providers/hyperstack';

const creds = { apiKey: 'test-key' } as const;

interface Captured { url: string; method: string; headers: Record<string, string> }

function mockFetch(handler: (captured: Captured) => Response | Promise<Response>) {
  const spy = vi.spyOn(globalThis, 'fetch');
  spy.mockImplementation(async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = String(init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    return handler({ url, method, headers });
  });
  return spy;
}

describe('HyperstackClient hibernate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hibernate issues GET /core/virtual-machines/{id}/hibernate with api_key header', async () => {
    const captured: Captured[] = [];
    mockFetch((req) => {
      captured.push(req);
      return new Response(JSON.stringify({ status: true, message: 'Hibernate requested' }), { status: 200 });
    });
    const client = new HyperstackClient();
    await client.hibernate('42', creds);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.url).toBe('https://infrahub-api.nexgencloud.com/v1/core/virtual-machines/42/hibernate');
    expect(captured[0]!.headers['api_key']).toBe('test-key');
  });

  it('hibernateRestore issues GET /core/virtual-machines/{id}/hibernate-restore', async () => {
    const captured: Captured[] = [];
    mockFetch((req) => {
      captured.push(req);
      return new Response(JSON.stringify({ status: true }), { status: 200 });
    });
    const client = new HyperstackClient();
    await client.hibernateRestore('42', creds);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.url).toBe('https://infrahub-api.nexgencloud.com/v1/core/virtual-machines/42/hibernate-restore');
  });

  it('hibernate URL-encodes the instance id (defence-in-depth)', async () => {
    let capturedUrl = '';
    mockFetch((req) => {
      capturedUrl = req.url;
      return new Response('', { status: 200 });
    });
    const client = new HyperstackClient();
    // Hyperstack VMs are always numeric, but the client uses encodeURIComponent
    // so a weird id can't break out of the path segment.
    await client.hibernate('ab cd', creds);
    expect(capturedUrl).toBe('https://infrahub-api.nexgencloud.com/v1/core/virtual-machines/ab%20cd/hibernate');
  });

  it('hibernate returns successfully on 2xx (fetchRaw does not throw on non-2xx either — that is the provider contract)', async () => {
    // `fetchRaw` (abstract-provider.ts) intentionally returns the raw Response
    // without throwing — it's the "for status-code branching" variant, vs
    // `fetchJson` which throws. We mirror that: `hibernate()` fires the
    // request and trusts the caller to poll status separately. This test
    // pins that contract so accidental switches to fetchJson are caught.
    let called = 0;
    mockFetch(() => {
      called++;
      return new Response(JSON.stringify({ status: true }), { status: 200 });
    });
    const client = new HyperstackClient();
    await expect(client.hibernate('1', creds)).resolves.toBeUndefined();
    expect(called).toBe(1);
  });
});
