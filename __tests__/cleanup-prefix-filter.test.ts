// Regression guard: cleanup routines must only touch VMs created by this
// gateway (name prefix `parle-autoscale-` or `ai-gateway-`). Anything else
// is a third-party instance in the same provider account and MUST be left
// alone.
//
// See gpu-orphan-cleanup.ts + deploy-orchestrator.ts for the fix. This test
// documents the incident where `handleGpuTerminate` nuked a manually-created
// Hyperstack VM (`musetalk-a6000`) because `cleanupProviderInstances` had
// no name filter.

import { describe, expect, it, vi } from 'vitest';
import { cleanupProviderInstances } from '../src/gateway/providers/gpu/deploy-orchestrator';
import type { GpuInstance, GpuProviderClient } from '../src/gateway/providers/gpu/types';

function makeClient(instances: GpuInstance[]): {
  client: GpuProviderClient;
  deleted: string[];
} {
  const deleted: string[] = [];
  const client = {
    listInstances: vi.fn().mockResolvedValue(instances),
    deleteInstance: vi.fn(async (id: string) => {
      deleted.push(id);
    }),
  } as unknown as GpuProviderClient;
  return { client, deleted };
}

describe('cleanupProviderInstances — name prefix filter', () => {
  const THIRD_PARTY: GpuInstance = {
    instanceId: '1001',
    instanceName: 'musetalk-a6000',
    status: 'running',
    provider: 'hyperstack',
  } as GpuInstance;

  const GATEWAY_OLD: GpuInstance = {
    instanceId: '1002',
    instanceName: 'parle-autoscale-1776479929610',
    status: 'running',
    provider: 'hyperstack',
  } as GpuInstance;

  const GATEWAY_NEW: GpuInstance = {
    instanceId: '1003',
    instanceName: 'ai-gateway-1776479929611',
    status: 'running',
    provider: 'hyperstack',
  } as GpuInstance;

  const USER_MANUAL: GpuInstance = {
    instanceId: '1004',
    instanceName: 'my-personal-dev-box',
    status: 'active',
    provider: 'hyperstack',
  } as GpuInstance;

  it('leaves third-party VMs alone when prefixes are provided', async () => {
    const { client, deleted } = makeClient([THIRD_PARTY, USER_MANUAL]);

    await cleanupProviderInstances(
      client,
      { apiKey: 'k' },
      ['running', 'active'],
      'Hyperstack',
      () => {},
      () => {},
      ['parle-autoscale-', 'ai-gateway-'],
    );

    expect(deleted).toEqual([]);
    expect(client.deleteInstance).not.toHaveBeenCalled();
  });

  it('terminates only gateway-owned VMs (both legacy and current prefixes)', async () => {
    const { client, deleted } = makeClient([
      THIRD_PARTY,
      GATEWAY_OLD,
      GATEWAY_NEW,
      USER_MANUAL,
    ]);

    await cleanupProviderInstances(
      client,
      { apiKey: 'k' },
      ['running', 'active'],
      'Hyperstack',
      () => {},
      () => {},
      ['parle-autoscale-', 'ai-gateway-'],
    );

    expect(deleted.sort()).toEqual(['1002', '1003']);
  });

  it('without prefixes (legacy behaviour) still works — used by tests/nuke-all', async () => {
    const { client, deleted } = makeClient([THIRD_PARTY, GATEWAY_OLD]);

    await cleanupProviderInstances(
      client,
      { apiKey: 'k' },
      ['running'],
      'Hyperstack',
      () => {},
      () => {},
      // no namePrefixes → nukes everything matching status
    );

    expect(deleted.sort()).toEqual(['1001', '1002']);
  });

  it('empty prefix array is treated as "no filter" (same as undefined)', async () => {
    const { client, deleted } = makeClient([THIRD_PARTY]);

    await cleanupProviderInstances(
      client,
      { apiKey: 'k' },
      ['running'],
      'Hyperstack',
      () => {},
      () => {},
      [],
    );

    expect(deleted).toEqual(['1001']);
  });
});
