/**
 * Live QA 2026-10-07: every replica release logged `scaleway HTTP 400 resource_still_in_use, "instance should be powered
 * off"`. An SBS-backed GPU server refuses `terminate`; the fallback powered off, paused 5 s and sent DELETE, which the API
 * refuses until the server is `stopped` (an L40S takes far longer). The release must wait for `stopped` (bounded),
 * retry DELETE while the API says the server is in use, keep deleting the volumes, and not block a gateway caller.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScalewayClient } from '../../src/cpu-providers/scaleway-client';

const creds = { apiKey: 'scw-secret-xxxxxxxxxxxxxxxxxx' };
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function json(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) } as Response;
}

/** A fake Scaleway server: `terminate` refused (SBS), power-off takes `stopAfterGets` reads, DELETE refused until stopped. */
function fakeServer(opts: { stopAfterGets: number; inUseAfterStopped?: number }) {
  const log: string[] = [];
  let state = 'running';
  let gets = 0;
  let poweredOff = false;
  let inUseLeft = opts.inUseAfterStopped ?? 0;
  let deleted = false;
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = String(url);
    if (/volumes\/vol-1$/.test(u) && method === 'DELETE') { log.push('DELETE volume'); return json({}, 204); }
    if (u.endsWith('/servers/srv-1/action')) {
      const action = JSON.parse(String(init?.body)).action as string;
      log.push(`action ${action}`);
      if (action === 'terminate') return json({ type: 'precondition_failed', message: 'terminate is not supported with SBS volumes' }, 400);
      if (action === 'poweroff') { poweredOff = true; state = 'stopping'; }
      return json({ task: {} }, 202);
    }
    if (u.endsWith('/servers/srv-1') && method === 'GET') {
      if (deleted) return json({ message: 'not found' }, 404);
      if (poweredOff && ++gets >= opts.stopAfterGets) state = 'stopped';
      return json({ server: { id: 'srv-1', state, volumes: { 0: { id: 'vol-1' } } } });
    }
    if (u.endsWith('/servers/srv-1') && method === 'DELETE') {
      if (state !== 'stopped' || inUseLeft-- > 0) {
        log.push('DELETE server refused');
        return json({ type: 'resource_still_in_use', message: 'instance should be powered off' }, 400);
      }
      deleted = true;
      log.push('DELETE server');
      return json({}, 204);
    }
    throw new Error(`unexpected ${method} ${u}`);
  });
  return { log, isDeleted: () => deleted };
}

beforeEach(() => {
  mockFetch.mockReset();
  process.env.SCALEWAY_VOLUME_RETRY_MS = '0';
  process.env.SCALEWAY_RELEASE_GET_RETRY_MS = '0';
  process.env.SCALEWAY_POWEROFF_POLL_MS = '1';
  process.env.SCALEWAY_POWEROFF_WAIT_MS = '2000';
});

describe('Scaleway release of an SBS-backed server', () => {
  it('powers off, waits for `stopped`, then deletes once — no resource_still_in_use', async () => {
    const fake = fakeServer({ stopAfterGets: 4 });
    await new ScalewayClient().releaseInstance('fr-par-2:srv-1', creds, { awaitVolumes: true });
    expect(fake.isDeleted()).toBe(true);
    expect(fake.log).not.toContain('DELETE server refused');
    expect(fake.log.filter(l => l === 'DELETE server')).toHaveLength(1);
    expect(fake.log.indexOf('action poweroff')).toBeLessThan(fake.log.indexOf('DELETE server'));
    expect(fake.log).toContain('DELETE volume');
  }, 15_000);

  it('retries the DELETE while the API still says the server is in use after it reads `stopped`', async () => {
    const fake = fakeServer({ stopAfterGets: 1, inUseAfterStopped: 2 });
    await new ScalewayClient().releaseInstance('fr-par-2:srv-1', creds, { awaitVolumes: true });
    expect(fake.isDeleted()).toBe(true);
    expect(fake.log.filter(l => l === 'DELETE server refused')).toHaveLength(2);
  }, 15_000);

  it('gives up after SCALEWAY_POWEROFF_WAIT_MS with the API error (bounded)', async () => {
    process.env.SCALEWAY_POWEROFF_WAIT_MS = '30';
    fakeServer({ stopAfterGets: Number.MAX_SAFE_INTEGER });
    await expect(new ScalewayClient().releaseInstance('fr-par-2:srv-1', creds, { awaitVolumes: true })).rejects.toThrow(/resource_still_in_use|powered off/);
  }, 15_000);

  it('a gateway caller (no awaitVolumes) is not blocked by the power-off; a repeat call joins instead of starting over', async () => {
    const fake = fakeServer({ stopAfterGets: 30 });
    const client = new ScalewayClient();
    await client.releaseInstance('fr-par-2:srv-1', creds, { awaitVolumes: false });
    expect(fake.isDeleted()).toBe(false); // still powering off in the background
    await client.releaseInstance('fr-par-2:srv-1', creds, { awaitVolumes: false }); // the next tick lists it `stopping`
    await vi.waitFor(() => expect(fake.isDeleted()).toBe(true), { timeout: 3000 });
    expect(fake.log.filter(l => l === 'action poweroff')).toHaveLength(1);
    expect(fake.log).not.toContain('DELETE server refused');
    await vi.waitFor(() => expect(fake.log).toContain('DELETE volume'), { timeout: 3000 });
  }, 15_000);
});
