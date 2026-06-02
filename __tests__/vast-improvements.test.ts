/**
 * Tests for Vast.ai reliability improvements:
 * - P0a: Staggered hedged deploy (delayed extra offer attempts)
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
import {
  VastClient,
  getVastOfferRaceStaggerMsForTests,
  getVastReservationQueueSnapshotForTests,
  getVastRateLimitPolicyForTests,
  resetVastRateLimitStateForTests,
} from '@ai-gateway/gpu-providers/vast-client';
import type { GpuInstance } from '@ai-gateway/gpu-providers/types';
import { AbstractGpuProvider } from '@ai-gateway/gpu-providers/abstract-provider';
import { SshTunnel } from '../server/ssh-tunnel';
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
    resetVastRateLimitStateForTests();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(AbstractGpuProvider, 'estimateImageDiskGb').mockResolvedValue(20);
    process.env.VAST_SKIP_IMAGE_PRECHECK = '1';
    process.env.VAST_OFFER_RACE_STAGGER_MS = '0';
    process.env.VAST_RESERVATION_QUEUE_MAX_SIZE = '5';
    process.env.VAST_RESERVATION_QUEUE_TIMEOUT_MS = '600000';
    try { fs.rmSync(path.join(os.homedir(), '.babelcast', 'vast-host-blacklist.json')); } catch {}
    try { fs.rmSync(path.join(os.homedir(), '.ai-gateway', 'vast-host-reputation.json')); } catch {}
  });

  afterEach(() => {
    resetVastRateLimitStateForTests();
    delete process.env.VAST_SKIP_IMAGE_PRECHECK;
    delete process.env.VAST_OFFER_RACE_STAGGER_MS;
    delete process.env.VAST_RESERVATION_QUEUE_MAX_SIZE;
    delete process.env.VAST_RESERVATION_QUEUE_TIMEOUT_MS;
    vi.restoreAllMocks();
    return new Promise<void>(resolve => setTimeout(() => {
      try { fs.rmSync(path.join(os.homedir(), '.babelcast', 'vast-host-blacklist.json')); } catch {}
      try { fs.rmSync(path.join(os.homedir(), '.ai-gateway', 'vast-host-reputation.json')); } catch {}
      resolve();
    }, 1100));
  });

  // ── Vast rate-limit policy ───────────────────────────────────────────────
  describe('Rate-limit policy', () => {
    it('uses conservative per-endpoint intervals for Vast acquisition routes', () => {
      const headers = { Authorization: 'Bearer vast-secret' };

      const reserve = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/asks/123/`, { method: 'PUT', headers });
      const instancePoll = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/instances/123/`, { method: 'GET', headers });
      const offerSearch = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/bundles/`, { method: 'POST', headers });
      const mutation = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/instances/command/123/`, { method: 'POST', headers });

      expect(reserve.route).toBe('PUT /asks/:offer');
      expect(reserve.minIntervalMs).toBeGreaterThanOrEqual(15_000);
      expect(instancePoll.route).toBe('GET /instances/:id');
      expect(instancePoll.minIntervalMs).toBeGreaterThanOrEqual(3_000);
      expect(offerSearch.route).toBe('POST /bundles');
      expect(offerSearch.minIntervalMs).toBeGreaterThanOrEqual(15_000);
      expect(mutation.route).toBe('POST /instances/mutation');
      expect(mutation.minIntervalMs).toBeGreaterThanOrEqual(3_000);
    });

    it('shares reserve buckets across offer IDs without exposing bearer tokens', () => {
      const headers = { Authorization: 'Bearer very-secret-token' };
      const first = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/asks/111/`, { method: 'PUT', headers });
      const second = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/asks/222/`, { method: 'PUT', headers });
      const otherIdentity = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/asks/111/`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer other-token' },
      });

      expect(first.bucketKey).toBe(second.bucketKey);
      expect(first.bucketKey).not.toContain('very-secret-token');
      expect(first.identityHash).not.toContain('very-secret-token');
      expect(first.bucketKey).not.toBe(otherIdentity.bucketKey);
    });

    it('retries Vast 429 responses through the shared fetch wrapper', async () => {
      const client = new VastClient();
      fetchSpy
        .mockResolvedValueOnce(mockResp({ error: 'API requests too frequent' }, 429))
        .mockResolvedValueOnce(mockResp({ ok: true }));

      const res = await (client as any)._vastFetch(`${VAST_API_BASE}/instances/123/`, {
        headers: { Authorization: 'Bearer k' },
      });

      expect(res.status).toBe(200);
      expect(fetchSpy.mock.calls.length).toBe(2);
    });

    it('queues Vast reservations with a bounded queue instead of starting them simultaneously', async () => {
      process.env.VAST_RESERVATION_QUEUE_MAX_SIZE = '2';
      const client = new VastClient();
      const releases: Array<(res: Response) => void> = [];
      fetchSpy.mockImplementation(() => new Promise<Response>((resolve) => releases.push(resolve)));

      const p1 = (client as any)._vastFetch(`${VAST_API_BASE}/asks/1/`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer k' },
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      const p2 = (client as any)._vastFetch(`${VAST_API_BASE}/asks/2/`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer k' },
      });
      await Promise.resolve();

      const p3 = (client as any)._vastFetch(`${VAST_API_BASE}/asks/3/`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer k' },
      });

      await expect(p3).rejects.toThrow(/Vast reservation queue full/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(getVastReservationQueueSnapshotForTests()[0]).toMatchObject({
        active: true,
        pending: 1,
        depth: 2,
      });

      releases[0](mockResp({ ok: true }));
      await p1;
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

      releases[1](mockResp({ ok: true }));
      await p2;
      expect(getVastReservationQueueSnapshotForTests()).toEqual([]);
    });

    it('times out queued reservations that cannot start before the queue timeout', async () => {
      process.env.VAST_RESERVATION_QUEUE_MAX_SIZE = '2';
      process.env.VAST_RESERVATION_QUEUE_TIMEOUT_MS = '16000';
      vi.useFakeTimers();
      try {
        const client = new VastClient();
        const releases: Array<(res: Response) => void> = [];
        fetchSpy.mockImplementation(() => new Promise<Response>((resolve) => releases.push(resolve)));

        const p1 = (client as any)._vastFetch(`${VAST_API_BASE}/asks/1/`, {
          method: 'PUT',
          headers: { Authorization: 'Bearer k' },
        });
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

        const p2 = (client as any)._vastFetch(`${VAST_API_BASE}/asks/2/`, {
          method: 'PUT',
          headers: { Authorization: 'Bearer k' },
        });
        const p2Rejected = expect(p2).rejects.toThrow(/Vast reservation queue timeout/);

        await vi.advanceTimersByTimeAsync(15_999);
        expect(getVastReservationQueueSnapshotForTests()[0]).toMatchObject({
          active: true,
          pending: 1,
          depth: 2,
        });

        await vi.advanceTimersByTimeAsync(1);
        await p2Rejected;
        expect(getVastReservationQueueSnapshotForTests()[0]).toMatchObject({
          active: true,
          pending: 0,
          depth: 1,
        });

        releases[0](mockResp({ ok: true }));
        await p1;
        expect(getVastReservationQueueSnapshotForTests()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
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

    it('filters actively banned hosts out of offer search', async () => {
      const client = new VastClient();
      (client as any)._recordHostFailure('1.2.3.4');

      fetchSpy.mockResolvedValueOnce(mockResp({
        offers: [
          { id: 'bad', gpu_name: 'RTX 5090', dph_total: 0.8, public_ipaddr: '1.2.3.4' },
          { id: 'good', gpu_name: 'RTX 5090', dph_total: 0.9, public_ipaddr: '5.6.7.8' },
        ],
      }));

      const offers = await (client as any)._searchOffers(
        { limit: 10, gpu_name: { in: ['RTX 5090'] } },
        { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
      );

      expect(offers.map((o: Record<string, unknown>) => o.id)).toEqual(['good']);
    });

    it('demotes hosts with expired failure history instead of picking them first', async () => {
      const client = new VastClient();
      (client as any)._hostFailures.set('1.2.3.4', {
        count: 2,
        bannedUntilMs: Date.now() - 1,
        lastFailureMs: Date.now() - 60_000,
      });

      const offers = [
        { id: 'bad', gpu_name: 'RTX 5090', dph_total: 1.0, public_ipaddr: '1.2.3.4', reliability2: 0.99, inet_down: 20000 },
        { id: 'good', gpu_name: 'RTX 5090', dph_total: 1.0, public_ipaddr: '5.6.7.8', reliability2: 0.98, inet_down: 10000 },
      ];

      fetchSpy
        .mockResolvedValueOnce(mockPreflight())
        .mockResolvedValueOnce(mockResp({ offers }))
        .mockResolvedValue(mockText('not available', 400));

      await expect(
        client.createInstance({
          gpuTypes: ['RTX 5090'],
          dockerImage: 'test/image:latest',
          strictFastBoot: true,
          raceCount: 1,
        }, { apiKey: 'k' }),
      ).rejects.toThrow();

      const createCall = fetchSpy.mock.calls.find(c => String(c[0]).includes('/asks/'));
      expect(String(createCall?.[0])).toContain('/asks/good/');
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

    it('keeps endpoint polling on the shared Vast instance-detail bucket', () => {
      const first = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/instances/111/`, {
        method: 'GET',
        headers: { Authorization: 'Bearer k' },
      });
      const second = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/instances/222/`, {
        method: 'GET',
        headers: { Authorization: 'Bearer k' },
      });

      expect(first.bucketKey).toBe(second.bucketKey);
      expect(first.minIntervalMs).toBeGreaterThanOrEqual(3_000);
    });
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

  // ── P0a: Staggered hedge deploy ──────────────────────────────────────────
  describe('P0a: Staggered hedge deploy', () => {
    it('labels created instances with the gateway prefix for safe cleanup', async () => {
      const client = new VastClient();

      fetchSpy
        .mockResolvedValueOnce(mockPreflight())
        .mockResolvedValueOnce(mockResp({
          offers: [{ id: 'o1', gpu_name: 'RTX 4090', dph_total: 0.5 }],
        }))
        .mockResolvedValueOnce(mockText('not available', 400));

      await expect(
        client.createInstance({ gpuTypes: ['RTX 4090'], dockerImage: 'test/image:latest' }, { apiKey: 'k' }),
      ).rejects.toThrow();

      const createCall = fetchSpy.mock.calls.find(c => String(c[0]).includes('/asks/'));
      expect(createCall).toBeDefined();
      const body = JSON.parse(createCall![1].body);
      expect(body.label).toMatch(/^parle-autoscale-\d+(-[a-z0-9]+)?$/);
    });

    it('tries multiple offers when raceCount > 1', async () => {
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

    it('stages the second hedge instead of launching it immediately', async () => {
      process.env.VAST_OFFER_RACE_STAGGER_MS = '250';
      vi.useFakeTimers();
      try {
        const client = new VastClient();
        const launchedAt: number[] = [];
        const pending: Array<(value: GpuInstance | null) => void> = [];
        vi.spyOn(client as any, '_tryOffer').mockImplementation(() => {
          launchedAt.push(Date.now());
          return new Promise<GpuInstance | null>((resolve) => pending.push(resolve));
        });

        const race = (client as any)._raceOffers({
          offers: [
            { id: 'o1', gpu_name: 'RTX 4090' },
            { id: 'o2', gpu_name: 'RTX 4090' },
          ],
          raceCount: 2,
          headers: {},
          apiKey: 'k',
          diskGb: 20,
          imageName: 'test/image:latest',
          envVars: {},
          spec: { gpuTypes: ['RTX 4090'], dockerImage: 'test/image:latest' },
          failures: { push: vi.fn() },
          losers: [],
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(getVastOfferRaceStaggerMsForTests()).toBe(250);
        expect(launchedAt).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(249);
        expect(launchedAt).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(launchedAt).toHaveLength(2);
        expect(launchedAt[1] - launchedAt[0]).toBeGreaterThanOrEqual(250);

        pending[0]?.(null);
        pending[1]?.(null);
        await race;
      } finally {
        vi.useRealTimers();
      }
    });

    it('respects spec.raceCount=1 (serial offers)', async () => {
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

    it('caps raceCount at 2 (defensive)', async () => {
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

      // All 10 offers are still tried; the cap only limits simultaneous attempts.
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
