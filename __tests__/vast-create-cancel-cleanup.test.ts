/**
 * Vast createInstance — never leave a billing instance behind.
 *
 * Found in a live deploy (Qwen3-TTS near Lyon): a cancel/terminate could not
 * reach createInstance, which kept two instances polling / retrying an SSH
 * tunnel for ~10 minutes; with no `ssh` binary it retried 20× anyway; and an
 * exception after the contract existed returned without destroying it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/gateway/providers/gpu/ssh-tunnel', () => ({
  isSshClientAvailable: vi.fn(async () => true),
  getOrCreateTunnel: vi.fn(),
}));

import { VastClient } from '../src/gpu-providers/vast-client';
import { AbstractGpuProvider } from '../src/gpu-providers/abstract-provider';
import * as sshTunnel from '../src/gateway/providers/gpu/ssh-tunnel';

const creds = { apiKey: 'test-key' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('VastClient.createInstance — cancel & cleanup', () => {
  let client: VastClient;
  let deleted: string[];
  let contract: number;

  beforeEach(() => {
    client = new VastClient();
    deleted = [];
    contract = 500;
    process.env.VAST_SKIP_IMAGE_PRECHECK = '1';
    vi.spyOn(AbstractGpuProvider, 'estimateImageDiskGb').mockResolvedValue(20);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/users/current')) return json({ credit: 100 });
      if (method === 'PUT' && url.includes('/asks/')) return json({ success: true, new_contract: String(++contract) });
      if (method === 'DELETE' && url.includes('/instances/')) {
        deleted.push(url.match(/instances\/(\d+)/)![1]);
        return json({ success: true });
      }
      if (url.includes('/bundles')) {
        return json({ offers: [
          { id: 1, gpu_name: 'RTX 4090', dph_total: 0.40, public_ipaddr: '1.1.1.1', inet_down: 2000, reliability2: 0.99, rentable: true },
          { id: 2, gpu_name: 'RTX 4090', dph_total: 0.45, public_ipaddr: '2.2.2.2', inet_down: 2000, reliability2: 0.99, rentable: true },
          { id: 3, gpu_name: 'RTX 4090', dph_total: 0.50, public_ipaddr: '3.3.3.3', inet_down: 2000, reliability2: 0.99, rentable: true },
        ] });
      }
      return json({});
    }));
  });

  afterEach(() => {
    delete process.env.VAST_SKIP_IMAGE_PRECHECK;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('destroys every raced instance and rejects when the deploy is cancelled mid-boot', async () => {
    // Endpoint polling never finishes on its own — only the abort ends it.
    vi.spyOn(client as any, '_pollForEndpoint').mockImplementation(
      (_cid: unknown, _h: unknown, _max: unknown, _inet: unknown, _cb: unknown, signal?: AbortSignal) =>
        new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Deploy cancelled', 'AbortError')))),
    );
    const ctrl = new AbortController();
    const p = client.createInstance(
      { gpuTypes: ['RTX 4090'], dockerImage: 'test:latest', raceCount: 2, signal: ctrl.signal },
      creds,
    );
    // wait until both raced instances exist (they are now billing)
    for (let i = 0; i < 200 && contract < 502; i++) await new Promise(r => setTimeout(r, 25));
    expect(contract).toBe(502);
    const t0 = Date.now();
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(5_000);
    await vi.waitFor(() => expect(new Set(deleted)).toEqual(new Set(['501', '502'])), { timeout: 10_000 });
  }, 20_000);

  it('does not create anything when already cancelled', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(client.createInstance(
      { gpuTypes: ['RTX 4090'], dockerImage: 'test:latest', raceCount: 2, signal: ctrl.signal },
      creds,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(contract).toBe(500);
  }, 20_000);

  it('destroys the instance when an error happens after it was created', async () => {
    vi.spyOn(client as any, '_pollForEndpoint').mockRejectedValue(new Error('boom'));
    await expect(client.createInstance(
      { gpuTypes: ['RTX 4090'], dockerImage: 'test:latest', raceCount: 1 },
      creds,
    )).rejects.toThrow();
    // every offer attempt created a contract and every one must be destroyed
    expect(deleted.length).toBe(contract - 500);
    expect(deleted.length).toBeGreaterThan(0);
  }, 30_000);

  it('gives up on SSH-only instances immediately when no ssh client exists', async () => {
    vi.mocked(sshTunnel.isSshClientAvailable).mockResolvedValue(false);
    vi.spyOn(client as any, '_pollForEndpoint').mockResolvedValue({
      endpoint: '', ip: '5.5.5.5', sshHost: 'ssh5.vast.ai', sshPort: 28256,
    });
    vi.spyOn(client as any, '_fetchInstanceDetail').mockResolvedValue({
      ip: '5.5.5.5', status: 'running', sshHost: 'ssh5.vast.ai', sshPort: 28256, endpoint: '',
    });
    const t0 = Date.now();
    await expect(client.createInstance(
      { gpuTypes: ['RTX 4090'], dockerImage: 'test:latest', raceCount: 1 },
      creds,
    )).rejects.toThrow(/ssh client not installed/);
    expect(Date.now() - t0).toBeLessThan(8_000); // no 10s key wait, no tunnel retries
    expect(sshTunnel.getOrCreateTunnel).not.toHaveBeenCalled();
    expect(deleted.length).toBe(contract - 500);
  }, 30_000);
  it('never falls back to an SSH tunnel when a direct port is required (real-time)', async () => {
    vi.mocked(sshTunnel.isSshClientAvailable).mockResolvedValue(true);
    vi.spyOn(client as any, '_pollForEndpoint').mockResolvedValue({
      endpoint: '', ip: '5.5.5.5', sshHost: 'ssh5.vast.ai', sshPort: 28256,
    });
    vi.spyOn(client as any, '_fetchInstanceDetail').mockResolvedValue({
      ip: '5.5.5.5', status: 'running', sshHost: 'ssh5.vast.ai', sshPort: 28256, endpoint: '',
    });
    await expect(client.createInstance(
      { gpuTypes: ['RTX 4090'], dockerImage: 'test:latest', raceCount: 1, directPortRequired: 1 },
      creds,
    )).rejects.toThrow(/direct port required/);
    expect(sshTunnel.getOrCreateTunnel).not.toHaveBeenCalled();
    expect(deleted.length).toBe(contract - 500);
  }, 30_000);
});
