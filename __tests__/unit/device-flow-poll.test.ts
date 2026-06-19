import { describe, it, expect, vi, afterEach } from 'vitest';
import { pollDeviceFlow } from '../../src/compute/image-builder/github-auth';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

function mockTokenResponse(body: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('pollDeviceFlow status mapping', () => {
  it('maps authorization_pending → pending', async () => {
    mockTokenResponse({ error: 'authorization_pending' });
    expect(await pollDeviceFlow('cid', 'dcode')).toEqual({ status: 'pending' });
  });

  it('maps slow_down → slow_down (distinct, so the loop can back off)', async () => {
    mockTokenResponse({ error: 'slow_down' });
    expect(await pollDeviceFlow('cid', 'dcode')).toEqual({ status: 'slow_down' });
  });

  it('maps expired_token → expired', async () => {
    mockTokenResponse({ error: 'expired_token' });
    expect(await pollDeviceFlow('cid', 'dcode')).toEqual({ status: 'expired' });
  });

  it('maps an access_token → complete', async () => {
    mockTokenResponse({ access_token: 'tok', token_type: 'bearer', scope: 'repo' });
    const r = await pollDeviceFlow('cid', 'dcode');
    expect(r.status).toBe('complete');
    if (r.status === 'complete') expect(r.accessToken).toBe('tok');
  });

  it('maps an unknown error → error', async () => {
    mockTokenResponse({ error: 'access_denied', error_description: 'user denied' });
    expect(await pollDeviceFlow('cid', 'dcode')).toEqual({ status: 'error', error: 'user denied' });
  });
});
