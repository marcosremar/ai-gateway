import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VastClient,
  getVastRateLimitPolicyForTests,
  getVastReservationQueueSnapshotForTests,
  resetVastRateLimitStateForTests,
} from '@ai-gateway/gpu-providers/vast-client';

const VAST_API_BASE = 'https://console.vast.ai/api/v0';

function mockResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Vast reservation rate-limit stress', () => {
  afterEach(() => {
    resetVastRateLimitStateForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.VAST_RESERVATION_QUEUE_MAX_SIZE;
    delete process.env.VAST_RESERVATION_QUEUE_TIMEOUT_MS;
    delete process.env.VAST_OFFER_RACE_STAGGER_MS;
    delete process.env.VAST_RATE_LIMIT_DISABLED;
  });

  it('drains a reservation burst with one active request and reserve-interval spacing', async () => {
    resetVastRateLimitStateForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T00:00:00Z'));
    process.env.VAST_RESERVATION_QUEUE_MAX_SIZE = '12';
    process.env.VAST_RESERVATION_QUEUE_TIMEOUT_MS = '600000';

    const client = new VastClient();
    const fetchStartedAtMs: number[] = [];
    vi.spyOn(client as any, 'fetchRaw').mockImplementation(async () => {
      fetchStartedAtMs.push(Date.now());
      return mockResp({ ok: true });
    });

    const headers = { Authorization: 'Bearer stress-key' };
    const policy = getVastRateLimitPolicyForTests(`${VAST_API_BASE}/asks/0/`, { method: 'PUT', headers });
    const totalReservations = 8;
    const calls = Array.from({ length: totalReservations }, (_, i) => (
      (client as any)._vastFetch(`${VAST_API_BASE}/asks/${i}/`, { method: 'PUT', headers })
    ));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStartedAtMs).toHaveLength(1);
    expect(getVastReservationQueueSnapshotForTests()[0]).toMatchObject({
      active: true,
      pending: totalReservations - 2,
      depth: totalReservations - 1,
    });

    for (let expectedCount = 2; expectedCount <= totalReservations; expectedCount++) {
      await vi.advanceTimersByTimeAsync(policy.minIntervalMs - 1);
      expect(fetchStartedAtMs).toHaveLength(expectedCount - 1);

      await vi.advanceTimersByTimeAsync(1);
      expect(fetchStartedAtMs).toHaveLength(expectedCount);
    }

    await Promise.all(calls);

    for (let i = 1; i < fetchStartedAtMs.length; i++) {
      expect(fetchStartedAtMs[i] - fetchStartedAtMs[i - 1]).toBeGreaterThanOrEqual(policy.minIntervalMs);
    }
    expect(getVastReservationQueueSnapshotForTests()).toEqual([]);
  });

  it('rejects overflow beyond the bounded queue and still drains accepted reservations', async () => {
    resetVastRateLimitStateForTests();
    process.env.VAST_RESERVATION_QUEUE_MAX_SIZE = '5';
    process.env.VAST_RESERVATION_QUEUE_TIMEOUT_MS = '600000';
    process.env.VAST_OFFER_RACE_STAGGER_MS = '0';

    const releases: Array<(res: Response) => void> = [];
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => releases.push(resolve)));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new VastClient();
    const headers = { Authorization: 'Bearer stress-key' };
    const totalReservations = 30;
    const queueCapacity = 5;
    const calls = Array.from({ length: totalReservations }, (_, i) => (
      (client as any)._vastFetch(`${VAST_API_BASE}/asks/${i}/`, { method: 'PUT', headers })
    ));
    const observed = calls.map((p: Promise<Response>) => p.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    ));

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const rejectedOverflow = await Promise.all(observed.slice(queueCapacity));

    expect(rejectedOverflow).toHaveLength(totalReservations - queueCapacity);
    for (const result of rejectedOverflow) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.err).toMatchObject({
          code: 'VAST_RESERVATION_QUEUE_FULL',
          status: 429,
        });
      }
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getVastReservationQueueSnapshotForTests()[0]).toMatchObject({
      active: true,
      pending: queueCapacity - 1,
      depth: queueCapacity,
    });

    for (let i = 0; i < queueCapacity; i++) {
      releases[i](mockResp({ ok: true, i }));
      const accepted = await observed[i];
      expect(accepted.ok).toBe(true);

      if (i < queueCapacity - 1) {
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(i + 2));
      }
    }

    expect(fetchSpy).toHaveBeenCalledTimes(queueCapacity);
    expect(getVastReservationQueueSnapshotForTests()).toEqual([]);
  });
});
