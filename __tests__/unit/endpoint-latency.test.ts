import { describe, it, expect } from 'vitest';
import { probeEndpointLatency, rankEndpointsByLatency, orderChainByLatency } from '../../src/gateway/routing/endpoint-latency';
import { distanceKm, rankScalewayZonesByDistance, SITES } from '../../src/gateway/routing/zone-distance';
import type { FallbackEntry } from '../../src/gateway/providers/cloud/fallback';

/** Fake network with a manual clock: each host answers after its own delay, or fails. */
function network(delays: Record<string, number | 'down'>, coldExtraMs = 0) {
  let clock = 0;
  const seen = new Set<string>();
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    const host = new URL(url).origin;
    const delay = delays[host];
    const cold = seen.has(host) ? 0 : coldExtraMs;
    seen.add(host);
    if (delay === 'down' || delay === undefined) { clock += 5; throw new Error('ECONNREFUSED'); }
    clock += delay + cold;
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, now: () => clock };
}

/** Real (small) delays: probes of different endpoints run in parallel, so a shared fake clock would mix them up. */
function slowNetwork(delays: Record<string, number | 'down'>) {
  const fetchImpl = (async (input: string | URL | Request) => {
    const delay = delays[new URL(String(input)).origin];
    if (delay === 'down' || delay === undefined) throw new Error('ECONNREFUSED');
    await new Promise((resolve) => setTimeout(resolve, delay));
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

const A = 'http://a.example';
const B = 'http://b.example';
const C = 'http://c.example';

describe('endpoint latency probe', () => {
  it('uses the median and drops the first request (TCP/TLS setup) so a cold connection does not look slow', async () => {
    const net = network({ [A]: 20 }, 200);
    const row = await probeEndpointLatency(A, { ...net, samples: 5 });
    expect(row.samplesMs[0]).toBe(220);
    expect(row.medianMs).toBe(20);
    expect(row.failures).toBe(0);
  });

  it('counts failures and a non-2xx answer is a failure, not a fast sample', async () => {
    let calls = 0;
    const fetchImpl = (async () => (++calls % 2 ? new Response('no', { status: 503 }) : new Response('ok'))) as unknown as typeof fetch;
    const row = await probeEndpointLatency(A, { fetchImpl, samples: 4, now: () => 0 });
    expect(row.failures).toBe(2);
    expect(row.samplesMs).toHaveLength(2);
  });

  it('ranks fastest first and puts unreachable replicas last', async () => {
    const net = slowNetwork({ [A]: 80, [B]: 10, [C]: 'down' });
    const ranked = await rankEndpointsByLatency([C, A, B], { ...net, samples: 3 });
    expect(ranked.map((r) => r.endpoint)).toEqual([B, A, C]);
    expect(ranked[2]!.medianMs).toBeNull();
    expect(ranked[2]!.failures).toBe(3);
  });

  it('reorders only the replicas of a chain, in the slots they occupied; cloud entries keep their place', async () => {
    const net = slowNetwork({ [A]: 90, [B]: 10, [C]: 45 });
    const chain: FallbackEntry[] = [
      { provider: 'self-hosted', model: 'qwen', endpoint: A },
      { provider: 'openrouter', model: 'qwen' },
      { provider: 'self-hosted', model: 'qwen', endpoint: B },
      { provider: 'self-hosted', model: 'qwen', endpoint: C },
    ];
    const out = await orderChainByLatency(chain, { ...net, samples: 3 });
    expect(out.map((e) => e.endpoint ?? e.provider)).toEqual([B, 'openrouter', C, A]);
    expect(chain[0]!.endpoint).toBe(A); // input is not mutated
  });

  it('a chain with fewer than two replicas is returned as is', async () => {
    const chain: FallbackEntry[] = [{ provider: 'self-hosted', endpoint: A }, { provider: 'openrouter' }];
    expect(await orderChainByLatency(chain, slowNetwork({ [A]: 5 }))).toEqual(chain);
  });
});

describe('zone distance from Lyon', () => {
  it('great-circle distances are the known ones (Lyon–Paris ≈ 390 km)', () => {
    expect(Math.round(distanceKm(SITES.lyon, SITES.paris))).toBeGreaterThan(380);
    expect(Math.round(distanceKm(SITES.lyon, SITES.paris))).toBeLessThan(400);
  });

  it('ranks Paris zones before Amsterdam before Warsaw and drops unknown regions', () => {
    const ranked = rankScalewayZonesByDistance(SITES.lyon, ['pl-waw-1', 'nl-ams-1', 'fr-par-2', 'fr-par-1', 'xx-nowhere-1']);
    expect(ranked.map((r) => r.zone)).toEqual(['fr-par-1', 'fr-par-2', 'nl-ams-1', 'pl-waw-1']);
    expect(ranked[0]!.bestCaseRttMs).toBeLessThan(5);
    expect(ranked[3]!.bestCaseRttMs).toBeGreaterThan(ranked[2]!.bestCaseRttMs);
  });
});
