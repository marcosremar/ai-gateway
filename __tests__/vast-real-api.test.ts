/**
 * Vast.ai GPU Provider — Integration Tests (Real API)
 *
 * Tests read-only + search operations against Vast.ai's live API.
 * Does NOT create instances by default (costs money + HTTP unreachable).
 *
 * Requires: VAST_API_KEY
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { VastClient } from '../src/gpu-providers/vast-client';
import type { ProviderCredentials } from '../src/gpu-providers/types';
import { loadEnv, requireEnv, timed } from './helpers';

let creds: ProviderCredentials;
let client: VastClient;

beforeAll(() => {
  loadEnv();
  const apiKey = requireEnv('VAST_API_KEY');
  creds = { apiKey };
  client = new VastClient();
});

describe('VastClient — Read-Only (Real API)', () => {
  it('lists all instances on account (on-demand + serverless)', async () => {
    const { result: instances, ms } = await timed(() => client.listInstances(creds));

    expect(Array.isArray(instances)).toBe(true);
    console.log(`  Vast listInstances: ${instances.length} resource(s) (${ms}ms)`);

    for (const inst of instances) {
      expect(inst.instanceId).toBeTruthy();
      expect(typeof inst.status).toBe('string');
      const prefix = inst.instanceId.startsWith('endpt-') ? 'endpoint' : 'instance';
      console.log(`    ${prefix}: ${inst.instanceId} — ${inst.status} — ${inst.gpuType || 'unknown GPU'} — ${inst.endpoint || '(no endpoint)'}`);
    }
  });

  it('discovers running instance (if any)', async () => {
    const { result: instance, ms } = await timed(() =>
      client.discoverInstance(creds, ['RTX 3090']),
    );

    if (instance) {
      expect(instance.instanceId).toBeTruthy();
      console.log(`  Vast discoverInstance: ${instance.instanceId} → ${instance.endpoint} (${ms}ms)`);
    } else {
      console.log(`  Vast discoverInstance: no running instances (${ms}ms)`);
    }
  });

  it('getInstanceStatus returns null for non-existent instance', async () => {
    const status = await client.getInstanceStatus('inst-9999999', creds);
    expect(status).toBeNull();
  });

  it('resolveInstanceEndpoint returns null for non-existent instance', async () => {
    const endpoint = await client.resolveInstanceEndpoint!('inst-9999999', creds);
    expect(endpoint).toBeNull();
  });
});

describe('VastClient — Offer Search (Real API)', () => {
  it('searches for RTX 4090 GPU offers', async () => {
    // Use the private _searchOffers via a small wrapper to test the API
    const searchBody = {
      limit: 5,
      type: 'on-demand',
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: 1 },
      gpu_name: { in: ['RTX 4090'] },
      order: [['dph_total', 'asc']],
    };

    const { result: res, ms } = await timed(async () => {
      const r = await fetch('https://console.vast.ai/api/v0/bundles/', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${creds.apiKey}`,
        },
        body: JSON.stringify(searchBody),
        signal: AbortSignal.timeout(15_000),
      });
      expect(r.ok).toBe(true);
      return r.json() as Promise<Record<string, unknown>>;
    });

    const offers = (res.offers || []) as Array<Record<string, unknown>>;
    expect(Array.isArray(offers)).toBe(true);
    console.log(`  Vast search RTX 4090: ${offers.length} offer(s) (${ms}ms)`);

    if (offers.length > 0) {
      const cheapest = offers[0];
      expect(cheapest.gpu_name).toBeTruthy();
      expect(cheapest.dph_total).toBeGreaterThan(0);
      console.log(`    Cheapest: ${cheapest.gpu_name} @ $${Number(cheapest.dph_total).toFixed(3)}/h — ${cheapest.num_gpus}x GPU, ${cheapest.gpu_ram}GB VRAM`);
    }
  });

  it('searches for RTX 3090 offers with direct ports', async () => {
    const searchBody = {
      limit: 5,
      type: 'on-demand',
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: 1 },
      gpu_name: { in: ['RTX 3090'] },
      direct_port_count: { gte: 1 },
      order: [['dph_total', 'asc']],
    };

    const res = await fetch('https://console.vast.ai/api/v0/bundles/', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify(searchBody),
      signal: AbortSignal.timeout(15_000),
    });

    expect(res.ok).toBe(true);
    const data = (await res.json()) as Record<string, unknown>;
    const offers = (data.offers || []) as Array<Record<string, unknown>>;

    console.log(`  Vast search RTX 3090 (direct ports): ${offers.length} offer(s)`);
    // NOTE: offers with direct ports are rare — 0 results is valid
    if (offers.length > 0) {
      const cheapest = offers[0];
      console.log(`    Cheapest: $${Number(cheapest.dph_total).toFixed(3)}/h, ${cheapest.direct_port_count} direct port(s)`);
    }
  });

  it('searches across multiple GPU types', async () => {
    const searchBody = {
      limit: 10,
      type: 'on-demand',
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: 1 },
      gpu_name: { in: ['RTX 4090', 'RTX 3090', 'A40', 'RTX A5000'] },
      order: [['dph_total', 'asc']],
    };

    const res = await fetch('https://console.vast.ai/api/v0/bundles/', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify(searchBody),
      signal: AbortSignal.timeout(15_000),
    });

    expect(res.ok).toBe(true);
    const data = (await res.json()) as Record<string, unknown>;
    const offers = (data.offers || []) as Array<Record<string, unknown>>;

    expect(offers.length).toBeGreaterThan(0);
    console.log(`  Vast multi-GPU search: ${offers.length} offer(s)`);

    // Verify offers are sorted by price
    for (let i = 1; i < Math.min(offers.length, 5); i++) {
      const prev = (offers[i - 1].dph_total as number) || 0;
      const curr = (offers[i].dph_total as number) || 0;
      expect(curr).toBeGreaterThanOrEqual(prev);
    }

    // Show top 3
    for (const offer of offers.slice(0, 3)) {
      console.log(`    ${offer.gpu_name} @ $${Number(offer.dph_total).toFixed(3)}/h — ${offer.gpu_ram}GB VRAM, ${offer.direct_port_count || 0} direct ports`);
    }
  });
});

describe('VastClient — API Authentication', () => {
  it('rejects invalid API key', async () => {
    const badClient = new VastClient();
    const badCreds: ProviderCredentials = { apiKey: 'invalid-vast-key-12345' };

    // listInstances should return empty (graceful failure)
    const instances = await badClient.listInstances(badCreds);
    expect(instances).toEqual([]);
  });

  it('search fails with invalid API key', async () => {
    const res = await fetch('https://console.vast.ai/api/v0/bundles/', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid-key-12345',
      },
      body: JSON.stringify({ limit: 1, type: 'on-demand', rentable: { eq: true } }),
      signal: AbortSignal.timeout(10_000),
    });

    // Vast.ai returns 401, 403, or 404 for invalid keys
    expect([401, 403, 404]).toContain(res.status);
  });
});
