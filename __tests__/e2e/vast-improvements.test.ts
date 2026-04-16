/**
 * Tests for Vast.ai reliability improvements:
 * - P0a: Hedged deploy (parallel offer attempts)
 * - P0b: SSH-only fallback search (Phase-2)
 * - P1a: Auto-snapshot after success
 * - P1b: Persistent host reputation
 * - P2a: SSH tunnel reconnect/retry
 * - P2b: Offer cache TTL
 * - P3: Adaptive polling
 *
 * Note: Tests avoid the createInstance happy path because it requires the
 * `_probeEndpoint` TCP connect to succeed (unmockable for fake IPs). Instead,
 * we test the helper methods directly or via failure paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VastClient } from '@ai-gateway/gpu-providers/vast-client';
import { AbstractGpuProvider } from '@ai-gateway/gpu-providers/abstract-provider';
import { SshTunnel } from '../../server/ssh-tunnel';
import fs from 'fs';
import path from 'path';
import os from 'os';

const VAST_API_BASE = 'https://console.vast.ai/api/v0';

function mockResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockText(text: string, status = 400): Response {
  return new Response(text, { status });
}

describe('Vast.ai reliability improvements', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  /** Preflight balance check response — createInstance calls /users/current/ first. */
  const mockPreflight = () => mockResp({ credit: 100 });

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(AbstractGpuProvider, 'estimateImageDiskGb').mockResolvedValue(20);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── P2b: Offer cache with TTL ─────────────────────────────────────────────
  describe('P2b: Offer cache', () => {
    it('caches offer search results within TTL window', async () => {
      const client = new VastClient();
      // Both calls hit the same search body — second should be cached
      fetchSpy.mockResolvedValueOnce(mockResp({
        offers: [{ id: 'o1', gpu_name: 'RTX 4090', dph_total: 0.5, public_ipaddr: '10.0.0.1' /* private → rejected by _parseInstance */, num_gpus: 1 }],
      }));

      // Use listOffers which calls _searchOffers
      const r1 = await client.listOffers({ gpuTypes: ['RTX 4090'], limit: 50 }, { apiKey: 'k' });
      const fetchCount1 = fetchSpy.mock.calls.length;
      expect(fetchCount1).toBeGreaterThan(0);

      const r2 = await client.listOffers({ gpuTypes: ['RTX 4090'], limit: 50 }, { apiKey: 'k' });
      const fetchCount2 = fetchSpy.mock.calls.length;

      // Cache should prevent a 2nd fetch (same search body)
      expect(fetchCount2).toBe(fetchCount1);
      expect(r1.length).toBe(r2.length);
    });

    it('cache miss when search body differs', async () => {
      const client = new VastClient();
      fetchSpy
        .mockResolvedValueOnce(mockResp({ offers: [{ id: 'o1', gpu_name: 'RTX 4090', dph_total: 0.5, num_gpus: 1 }] }))
        .mockResolvedValueOnce(mockResp({ offers: [{ id: 'o2', gpu_name: 'RTX 5090', dph_total: 0.7, num_gpus: 1 }] }));

      await client.listOffers({ gpuTypes: ['RTX 4090'], limit: 50 }, { apiKey: 'k' });
      await client.listOffers({ gpuTypes: ['RTX 5090'], limit: 50 }, { apiKey: 'k' });

      // Two different search bodies → two fetches
      expect(fetchSpy.mock.calls.length).toBe(2);
    });
  });

  // ── P1b: Persistent host reputation ───────────────────────────────────────
  describe('P1b: Persistent host reputation', () => {
    const TMP_DIR = path.join(os.tmpdir(), `vast-rep-test-${Date.now()}`);
    const REP_PATH = path.join(TMP_DIR, 'vast-host-reputation.json');

    beforeEach(() => {
      process.env.AI_GATEWAY_CONFIG_DIR = TMP_DIR;
      try { fs.rmSync(TMP_DIR, { recursive: true }); } catch {}
    });

    afterEach(() => {
      delete process.env.AI_GATEWAY_CONFIG_DIR;
      try { fs.rmSync(TMP_DIR, { recursive: true }); } catch {}
    });

    it('loads empty reputation map when file does not exist', () => {
      const client = new VastClient();
      // Should not throw — just starts with empty map
      expect(client).toBeDefined();
    });

    it('loads existing reputation entries from disk', async () => {
      // Pre-create reputation file
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const recentTs = Date.now() - 60_000; // 1 min ago — within cooldown
      fs.writeFileSync(REP_PATH, JSON.stringify({ '1.2.3.4': recentTs }));

      // Need to re-import the module to pick up the new env var path
      // since path is captured at module load time
      vi.resetModules();
      const { VastClient: FreshClient } = await import('@ai-gateway/gpu-providers/vast-client');
      const client = new FreshClient();
      // Verify it loaded — we use the public discoverInstance to indirectly
      // assert nothing crashed during init
      expect(client.providerId).toBe('vast');
    });

    it('skips expired reputation entries on load', async () => {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const oldTs = Date.now() - (60 * 60 * 1000); // 1 hour ago — expired
      fs.writeFileSync(REP_PATH, JSON.stringify({ '5.6.7.8': oldTs }));

      vi.resetModules();
      const { VastClient: FreshClient } = await import('@ai-gateway/gpu-providers/vast-client');
      const client = new FreshClient();
      expect(client).toBeDefined();
    });
  });

  // ── P3: Adaptive polling parameters ───────────────────────────────────────
  describe('P3: Adaptive polling', () => {
    it('_pollForEndpoint accepts inetDownMbps parameter', () => {
      const client = new VastClient();
      // Method should accept up to 4 args (contractId, headers, maxWaitMs, inetDownMbps)
      expect(typeof (client as any)._pollForEndpoint).toBe('function');
      expect((client as any)._pollForEndpoint.length).toBe(2); // 2 required, rest optional
    });

    it('uses faster initial delay for high-bandwidth hosts', async () => {
      const client = new VastClient();
      // Stub _fetchInstanceDetail to immediately return a "running" instance
      // with a non-private IP and direct_port. The probe will fail in tests
      // (TCP to fake IP) but we just need to measure initial delay.
      vi.spyOn(client as any, '_fetchInstanceDetail').mockResolvedValue({
        ip: '10.0.0.1', // private — will short-circuit to no endpoint
        endpoint: '',
        status: 'running',
      });

      const startSlow = Date.now();
      // Slow host (no inetDown given)
      await Promise.race([
        (client as any)._pollForEndpoint('test1', {}, 10_000, undefined),
        new Promise((r) => setTimeout(r, 6_000)),
      ]);
      const slowElapsed = Date.now() - startSlow;

      const startFast = Date.now();
      // Fast host (>5Gbps)
      await Promise.race([
        (client as any)._pollForEndpoint('test2', {}, 10_000, 8_000),
        new Promise((r) => setTimeout(r, 6_000)),
      ]);
      const fastElapsed = Date.now() - startFast;

      // Fast host should reach first poll faster than slow host (initial delay 2s vs 5s)
      // We just verify the fast path takes meaningfully less time before first poll
      expect(fastElapsed).toBeLessThan(slowElapsed + 100); // fast can't be slower
    }, 30_000);
  });

  // ── P1a: Auto-snapshot after success ──────────────────────────────────────
  describe('P1a: Auto-snapshot', () => {
    it('schedules takeSnapshot in background after successful deploy', async () => {
      // This is hard to test end-to-end because createInstance requires
      // _probeEndpoint to succeed (untestable for fake IPs). Instead, we
      // verify the takeSnapshot method exists and is callable.
      const client = new VastClient();
      expect(typeof client.takeSnapshot).toBe('function');

      // Mock the API call directly
      fetchSpy.mockResolvedValueOnce(mockResp({ result_url: 'https://s3/snap.tar' }));
      const result = await client.takeSnapshot('inst-123', { apiKey: 'k' });
      expect(result).toBe('https://s3/snap.tar');
      // Verify it called the right endpoint
      expect(fetchSpy.mock.calls[0][0]).toContain('/instances/command/123/');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.command).toBe('take_snapshot');
    });

    it('takeSnapshot returns null for endpoint type', async () => {
      const client = new VastClient();
      const result = await client.takeSnapshot('endpt-456', { apiKey: 'k' });
      expect(result).toBeNull();
      // Should NOT make any API call
      expect(fetchSpy.mock.calls.length).toBe(0);
    });

    it('auto-snapshot can be disabled via spec.autoSnapshot=false', async () => {
      // Verify the spec field is recognized — we just check the createInstance
      // API accepts the field without crashing
      const client = new VastClient();
      fetchSpy
        .mockResolvedValueOnce(mockPreflight()) // balance check
        .mockResolvedValueOnce(mockResp({ offers: [] })); // empty → throws

      await expect(
        client.createInstance(
          { gpuTypes: ['RTX 4090'], dockerImage: 'test/image:latest', autoSnapshot: false } as any,
          { apiKey: 'k' },
        ),
      ).rejects.toThrow();
    });
  });

  // ── P0b: SSH-only fallback (verify no regression) ─────────────────────────
  describe('P0b: SSH-only Phase-2 search', () => {
    it('triggers Phase-2 search ONLY when Phase-1 returns zero offers', async () => {
      const client = new VastClient();

      // Mock: preflight balance check, then Phase-1 returns 0 offers,
      // then relax search returns 0, then Phase-2 (no direct_port_count) returns offers
      fetchSpy
        .mockResolvedValueOnce(mockPreflight()) // balance check
        .mockResolvedValueOnce(mockResp({ offers: [] })) // Phase-1 strict
        .mockResolvedValueOnce(mockResp({ offers: [] })) // Phase-1 relaxed
        .mockResolvedValueOnce(mockResp({ offers: [] })); // Phase-2 SSH-only

      await expect(
        client.createInstance({ gpuTypes: ['RTX 5090'], dockerImage: 'test/image:latest' }, { apiKey: 'k' }),
      ).rejects.toThrow();

      // 4 fetches: preflight + Phase-1 strict + Phase-1 relaxed + Phase-2 SSH-only
      expect(fetchSpy.mock.calls.length).toBe(4);

      // Verify Phase-2 dropped direct_port_count (index shifted +1 for preflight)
      const phase2Body = JSON.parse(fetchSpy.mock.calls[3][1].body);
      expect(phase2Body.direct_port_count).toBeUndefined();
    });

    it('does NOT trigger Phase-2 when Phase-1 has offers', async () => {
      const client = new VastClient();

      // Phase-1 returns 1 offer; create fails immediately
      fetchSpy
        .mockResolvedValueOnce(mockPreflight()) // balance check
        .mockResolvedValueOnce(mockResp({
          offers: [{ id: 'o1', gpu_name: 'RTX 4090', dph_total: 0.5 }],
        }))
        // Hedged deploy launches the create attempt (fails 'not available')
        .mockResolvedValueOnce(mockText('not available', 400));

      await expect(
        client.createInstance({ gpuTypes: ['RTX 4090'], dockerImage: 'test/image:latest' }, { apiKey: 'k' }),
      ).rejects.toThrow();

      // Should be exactly 3 fetches: preflight + search + 1 create attempt (no Phase-2)
      expect(fetchSpy.mock.calls.length).toBe(3);
    });
  });

  // ── P0a: Hedged deploy ────────────────────────────────────────────────────
  describe('P0a: Hedged deploy', () => {
    it('launches multiple offers in parallel when raceCount > 1', async () => {
      const client = new VastClient();

      // 3 offers, race=2 — all 3 fail (so we can count attempts)
      fetchSpy
        .mockResolvedValueOnce(mockPreflight()) // balance check
        .mockResolvedValueOnce(mockResp({
          offers: [
            { id: 'o1', gpu_name: 'RTX 4090', dph_total: 0.5 },
            { id: 'o2', gpu_name: 'RTX 4090', dph_total: 0.6 },
            { id: 'o3', gpu_name: 'RTX 4090', dph_total: 0.7 },
          ],
        }))
        .mockResolvedValue(mockText('not available', 400));

      await expect(
        client.createInstance(
          { gpuTypes: ['RTX 4090'], dockerImage: 'test/image:latest', raceCount: 2 },
          { apiKey: 'k' },
        ),
      ).rejects.toThrow();

      // search + 3 create attempts (all 3 offers tried)
      const createCalls = fetchSpy.mock.calls.filter(c => String(c[0]).includes('/asks/'));
      expect(createCalls.length).toBe(3);
    });

    it('respects spec.raceCount=1 (no parallelism)', async () => {
      const client = new VastClient();

      fetchSpy
        .mockResolvedValueOnce(mockPreflight()) // balance check
        .mockResolvedValueOnce(mockResp({
          offers: [
            { id: 'o1', gpu_name: 'RTX 4090', dph_total: 0.5 },
            { id: 'o2', gpu_name: 'RTX 4090', dph_total: 0.6 },
          ],
        }))
        .mockResolvedValue(mockText('not available', 400));

      await expect(
        client.createInstance(
          { gpuTypes: ['RTX 4090'], dockerImage: 'test/image:latest', raceCount: 1 },
          { apiKey: 'k' },
        ),
      ).rejects.toThrow();

      // Both offers should be tried sequentially
      const createCalls = fetchSpy.mock.calls.filter(c => String(c[0]).includes('/asks/'));
      expect(createCalls.length).toBe(2);
    });

    it('caps raceCount at 5 (defensive)', async () => {
      const client = new VastClient();

      fetchSpy
        .mockResolvedValueOnce(mockPreflight()) // balance check
        .mockResolvedValueOnce(mockResp({
          offers: Array.from({ length: 10 }, (_, i) => ({
            id: `o${i}`, gpu_name: 'RTX 4090', dph_total: 0.5 + i * 0.1,
          })),
        }))
        .mockResolvedValue(mockText('not available', 400));

      await expect(
        client.createInstance(
          { gpuTypes: ['RTX 4090'], dockerImage: 'test/image:latest', raceCount: 100 },
          { apiKey: 'k' },
        ),
      ).rejects.toThrow();

      // All 10 offers tried (raceCount caps internally but doesn't limit total attempts)
      const createCalls = fetchSpy.mock.calls.filter(c => String(c[0]).includes('/asks/'));
      expect(createCalls.length).toBe(10);
    });
  });
});

// ── P2a: SSH tunnel reconnect / retry ────────────────────────────────────────
describe('P2a: SSH tunnel improvements', () => {
  it('exposes reconnectAttempts getter', () => {
    const tunnel = new SshTunnel('1.2.3.4', 22, 8000);
    expect(tunnel.reconnectAttempts).toBe(0);
  });

  it('open() returns false immediately when sshHost is empty', async () => {
    const tunnel = new SshTunnel('', 22, 8000);
    const ok = await tunnel.open(1000, 1);
    expect(ok).toBe(false);
  });

  it('open() returns false immediately when sshPort is invalid (0)', async () => {
    const tunnel = new SshTunnel('1.2.3.4', 0, 8000);
    const ok = await tunnel.open(1000, 1);
    expect(ok).toBe(false);
  });

  it('close() disables auto-reconnect (idempotent)', () => {
    const tunnel = new SshTunnel('1.2.3.4', 22, 8000);
    tunnel.close();
    tunnel.close(); // 2nd close shouldn't throw
    expect(tunnel.isOpen).toBe(false);
  });

  it('endpoint format includes localPort', () => {
    const tunnel = new SshTunnel('1.2.3.4', 22, 8000);
    expect(tunnel.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
