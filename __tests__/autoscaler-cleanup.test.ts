import { describe, it, expect, vi } from 'vitest';
import { cleanupProviderInstance } from '@ai-gateway/autoscaler/cleanup';
import { GpuProviderRegistry } from '@ai-gateway/gpu-providers/registry';
import type { GpuTierConfig, GpuProviderClient } from '@ai-gateway';

function makeMockClient(overrides?: Partial<GpuProviderClient>): GpuProviderClient {
  return {
    providerId: 'runpod',
    bootTimeSecs: 120,
    discoverInstance: vi.fn(),
    createInstance: vi.fn(),
    startInstance: vi.fn(),
    stopInstance: vi.fn().mockResolvedValue(undefined),
    deleteInstance: vi.fn(),
    getInstanceStatus: vi.fn(),
    listInstances: vi.fn(),
    resolveInstanceEndpoint: vi.fn(),
    ...overrides,
  };
}

const baseTier: GpuTierConfig = {
  provider: 'runpod',
  instanceId: 'pod-123',
  apiKey: 'key-abc',
  authId: 'auth-xyz',
};

describe('cleanupProviderInstance', () => {
  it('calls stopInstance on the provider client', async () => {
    const client = makeMockClient();
    const registry = new GpuProviderRegistry();
    registry.register(client);

    await cleanupProviderInstance(baseTier, registry, 'idle timeout');
    expect(client.stopInstance).toHaveBeenCalledWith('pod-123', { apiKey: 'key-abc', authId: 'auth-xyz' });
  });

  it('returns early when instanceId is missing', async () => {
    const client = makeMockClient();
    const registry = new GpuProviderRegistry();
    registry.register(client);

    await cleanupProviderInstance({ ...baseTier, instanceId: undefined }, registry, 'test');
    expect(client.stopInstance).not.toHaveBeenCalled();
  });

  it('returns early when apiKey is missing', async () => {
    const client = makeMockClient();
    const registry = new GpuProviderRegistry();
    registry.register(client);

    await cleanupProviderInstance({ ...baseTier, apiKey: undefined }, registry, 'test');
    expect(client.stopInstance).not.toHaveBeenCalled();
  });

  it('returns early when no client registered for provider', async () => {
    const registry = new GpuProviderRegistry();
    // no client registered
    await expect(cleanupProviderInstance(baseTier, registry, 'test')).resolves.toBeUndefined();
  });

  it('logs warning but does not throw when stopInstance fails', async () => {
    const client = makeMockClient({
      stopInstance: vi.fn().mockRejectedValue(new Error('API down')),
    });
    const registry = new GpuProviderRegistry();
    registry.register(client);

    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(cleanupProviderInstance(baseTier, registry, 'test', logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
