import { describe, it, expect, beforeEach } from 'vitest';
import { GpuProviderRegistry } from '@ai-gateway/gpu-providers/registry';
import type { GpuProviderClient } from '@ai-gateway/gpu-providers/types';

function makeMockClient(providerId: string): GpuProviderClient {
  return {
    providerId,
    bootTimeSecs: 120,
    discoverInstance: async () => null,
    createInstance: async () => ({ instanceId: 'i-1', endpoint: 'http://x', status: 'running' }),
    startInstance: async () => {},
    stopInstance: async () => {},
    deleteInstance: async () => {},
    getInstanceStatus: async () => 'running',
    listInstances: async () => [],
    resolveInstanceEndpoint: async () => null,
  };
}

describe('GpuProviderRegistry', () => {
  let registry: GpuProviderRegistry;

  beforeEach(() => {
    registry = new GpuProviderRegistry();
  });

  it('register + get returns the client', () => {
    const client = makeMockClient('runpod');
    registry.register(client);
    expect(registry.get('runpod')).toBe(client);
  });

  it('get unknown → undefined', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('getOrThrow returns registered client', () => {
    const client = makeMockClient('tensordock');
    registry.register(client);
    expect(registry.getOrThrow('tensordock')).toBe(client);
  });

  it('getOrThrow unknown → throws', () => {
    expect(() => registry.getOrThrow('nonexistent')).toThrow('No GPU provider registered for: nonexistent');
  });

  it('getMonitorable (deprecated) returns client', () => {
    const client = makeMockClient('runpod');
    registry.register(client);
    const result = registry.getMonitorable('runpod');
    expect(result).toBeDefined();
    expect(result!.listInstances).toBeDefined();
  });

  it('getMonitorable returns undefined for unknown provider', () => {
    expect(registry.getMonitorable('basic')).toBeUndefined();
  });

  it('overwrite existing registration replaces client', () => {
    const client1 = makeMockClient('runpod');
    const client2 = makeMockClient('runpod');
    registry.register(client1);
    registry.register(client2);
    expect(registry.get('runpod')).toBe(client2);
    expect(registry.get('runpod')).not.toBe(client1);
  });

  it('multiple registrations all retrievable', () => {
    const clients = ['runpod', 'tensordock', 'vast', 'modal'].map(makeMockClient);
    clients.forEach(c => registry.register(c));
    expect(registry.get('runpod')).toBe(clients[0]);
    expect(registry.get('tensordock')).toBe(clients[1]);
    expect(registry.get('vast')).toBe(clients[2]);
    expect(registry.get('modal')).toBe(clients[3]);
  });
});
