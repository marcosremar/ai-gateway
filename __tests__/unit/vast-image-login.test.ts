/**
 * Vast.ai — Docker Hub image_login Tests
 *
 * Tests the image_login parameter injection in VastClient.createInstance
 * for Docker Hub authenticated pulls (avoids rate limits).
 *
 * Covers: env var fallback logic, credential combinations, format validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VastClient } from '@ai-gateway/gpu-providers/vast-client';
import { AbstractGpuProvider } from '@ai-gateway/gpu-providers/abstract-provider';
import type { ProviderCredentials, InstanceSpec } from '@ai-gateway/gpu-providers/types';

const creds: ProviderCredentials = { apiKey: 'vast-test-key' };
const baseSpec: InstanceSpec = { gpuTypes: ['RTX 3090'], dockerImage: 'marcosremar/babelcast-subtitle:latest' };

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Extract the create body from the second fetch call (first is search, second is create). */
function getCreateBody(fetchSpy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  // Find the PUT call to /asks/ (the create call)
  for (const call of fetchSpy.mock.calls) {
    const url = call[0] as string;
    const opts = call[1] as RequestInit;
    if (url.includes('/asks/') && opts?.method === 'PUT') {
      return JSON.parse(opts.body as string);
    }
  }
  throw new Error('No create call found in fetch mock');
}

describe('VastClient image_login', () => {
  let client: VastClient;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    client = new VastClient();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(AbstractGpuProvider, 'estimateImageDiskGb').mockResolvedValue(20);
    // Mock the entire poll loop to return immediately. These tests only care
    // about the CREATE body (image_login field), not the poll/probe behavior.
    // Without this, _pollForEndpoint waits 5s initial + does TCP probes on
    // fake IPs that time out, causing 60s test timeouts.
    vi.spyOn(client as any, '_pollForEndpoint').mockResolvedValue({
      endpoint: 'http://1.2.3.4:8000', ip: '1.2.3.4',
    });

    // Backup and clear Docker env vars
    for (const key of ['DOCKERHUB_USERNAME', 'DOCKERHUB_TOKEN', 'DOCKER_HUB_USER', 'DOCKER_HUB_TOKEN']) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore env vars
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  /** Mock the preflight balance check (Vast checkBalance → /users/current/). */
  const mockPreflight = () => mockFetchResponse({ credit: 100 });

  /** Setup fetch mock for a successful create flow (preflight → search → create → poll). */
  function setupSuccessfulCreate() {
    fetchSpy
      .mockResolvedValueOnce(mockPreflight())                                  // preflight balance check
      .mockResolvedValueOnce(mockFetchResponse({                               // search offers
        offers: [{ id: 'offer-1', gpu_name: 'RTX 3090', dph_total: 0.50 }],
      }))
      .mockResolvedValueOnce(mockFetchResponse({ success: true, new_contract: '999' })) // create
      .mockResolvedValueOnce(mockFetchResponse({                                         // poll endpoint
        instances: { id: '999', actual_status: 'running', public_ipaddr: '1.2.3.4', direct_port_start: 8000 },
      }));
  }

  // ── DOCKERHUB_USERNAME / DOCKERHUB_TOKEN (primary env vars) ─────────────

  it('includes image_login when DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are set', async () => {
    process.env.DOCKERHUB_USERNAME = 'myuser';
    process.env.DOCKERHUB_TOKEN = 'dckr_pat_test123';
    setupSuccessfulCreate();

    await client.createInstance(baseSpec, creds);

    const body = getCreateBody(fetchSpy);
    expect(body.image_login).toBe('-u myuser -p dckr_pat_test123 docker.io');
  }, 60000);

  // ── DOCKER_HUB_USER / DOCKER_HUB_TOKEN (fallback env vars) ────────────

  it('falls back to DOCKER_HUB_USER / DOCKER_HUB_TOKEN', async () => {
    process.env.DOCKER_HUB_USER = 'fallbackuser';
    process.env.DOCKER_HUB_TOKEN = 'dckr_pat_fallback';
    setupSuccessfulCreate();

    await client.createInstance(baseSpec, creds);

    const body = getCreateBody(fetchSpy);
    expect(body.image_login).toBe('-u fallbackuser -p dckr_pat_fallback docker.io');
  }, 60000);

  // ── DOCKERHUB_USERNAME takes precedence over DOCKER_HUB_USER ──────────

  it('prefers DOCKERHUB_USERNAME over DOCKER_HUB_USER', async () => {
    process.env.DOCKERHUB_USERNAME = 'preferred';
    process.env.DOCKERHUB_TOKEN = 'dckr_pat_preferred';
    process.env.DOCKER_HUB_USER = 'shouldnotuse';
    process.env.DOCKER_HUB_TOKEN = 'dckr_pat_shouldnotuse';
    setupSuccessfulCreate();

    await client.createInstance(baseSpec, creds);

    const body = getCreateBody(fetchSpy);
    expect(body.image_login).toContain('-u preferred');
    expect(body.image_login).toContain('-p dckr_pat_preferred');
  }, 60000);

  // ── No credentials → no image_login ───────────────────────────────────

  it('omits image_login when no Docker Hub credentials set', async () => {
    setupSuccessfulCreate();

    await client.createInstance(baseSpec, creds);

    const body = getCreateBody(fetchSpy);
    expect(body.image_login).toBeUndefined();
  }, 60000);

  // ── Partial credentials → no image_login ──────────────────────────────

  it('omits image_login when only username is set (no token)', async () => {
    process.env.DOCKERHUB_USERNAME = 'myuser';
    // No DOCKERHUB_TOKEN
    setupSuccessfulCreate();

    await client.createInstance(baseSpec, creds);

    const body = getCreateBody(fetchSpy);
    expect(body.image_login).toBeUndefined();
  }, 60000);

  it('omits image_login when only token is set (no username)', async () => {
    process.env.DOCKERHUB_TOKEN = 'dckr_pat_test';
    // No DOCKERHUB_USERNAME
    setupSuccessfulCreate();

    await client.createInstance(baseSpec, creds);

    const body = getCreateBody(fetchSpy);
    expect(body.image_login).toBeUndefined();
  }, 60000);

  // ── Format validation ─────────────────────────────────────────────────

  it('image_login follows Vast.ai expected format: -u USER -p TOKEN docker.io', async () => {
    process.env.DOCKERHUB_USERNAME = 'testuser';
    process.env.DOCKERHUB_TOKEN = 'tok123';
    setupSuccessfulCreate();

    await client.createInstance(baseSpec, creds);

    const body = getCreateBody(fetchSpy);
    expect(body.image_login).toMatch(/^-u \S+ -p \S+ docker\.io$/);
  }, 60000);

  // ── Mixed fallback: username from one, token from other ───────────────

  it('uses DOCKERHUB_USERNAME with DOCKER_HUB_TOKEN when DOCKERHUB_TOKEN missing', async () => {
    process.env.DOCKERHUB_USERNAME = 'user1';
    process.env.DOCKER_HUB_TOKEN = 'tok_fallback';
    // No DOCKERHUB_TOKEN set
    setupSuccessfulCreate();

    await client.createInstance(baseSpec, creds);

    const body = getCreateBody(fetchSpy);
    expect(body.image_login).toBe('-u user1 -p tok_fallback docker.io');
  }, 60000);
});
