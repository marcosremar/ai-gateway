import { describe, it, expect } from 'vitest';
import { GpuProviderRegistry } from '@ai-gateway/gpu-providers/registry';
import type { GpuProviderClient } from '@ai-gateway/gpu-providers/types';

function mockClient(providerId: string): GpuProviderClient {
  return {
    providerId,
    bootTimeSecs: 120,
    discoverInstance: async () => null,
    createInstance: async () => ({ instanceId: 'mock', endpoint: 'http://test', status: 'running' }),
    startInstance: async () => {},
    stopInstance: async () => {},
    deleteInstance: async () => {},
    getInstanceStatus: async () => 'running',
    listInstances: async () => [],
    resolveInstanceEndpoint: async () => null,
  };
}

describe('GpuProviderRegistry', () => {
  it('register and get', () => {
    const reg = new GpuProviderRegistry();
    const client = mockClient('runpod');
    reg.register(client);
    expect(reg.get('runpod')).toBe(client);
  });
  it('returns undefined for unregistered provider', () => {
    const reg = new GpuProviderRegistry();
    expect(reg.get('nonexistent')).toBeUndefined();
  });
  it('getOrThrow returns registered client', () => {
    const reg = new GpuProviderRegistry();
    const client = mockClient('runpod');
    reg.register(client);
    expect(reg.getOrThrow('runpod')).toBe(client);
  });
  it('getOrThrow throws for unregistered provider', () => {
    const reg = new GpuProviderRegistry();
    expect(() => reg.getOrThrow('nonexistent')).toThrow('No GPU provider registered');
  });
  it('registers multiple providers independently', () => {
    const reg = new GpuProviderRegistry();
    const rp = mockClient('runpod');
    const vast = mockClient('vast');
    reg.register(rp);
    reg.register(vast);
    expect(reg.get('runpod')).toBe(rp);
    expect(reg.get('vast')).toBe(vast);
  });
  it('last registration wins for same providerId', () => {
    const reg = new GpuProviderRegistry();
    const c1 = mockClient('runpod');
    const c2 = mockClient('runpod');
    reg.register(c1);
    reg.register(c2);
    expect(reg.get('runpod')).toBe(c2);
  });
  it('getMonitorable delegates to get (deprecated)', () => {
    const reg = new GpuProviderRegistry();
    const client = mockClient('runpod');
    reg.register(client);
    expect(reg.getMonitorable('runpod')).toBe(client);
  });
  it('getMonitorable returns undefined for unknown (deprecated)', () => {
    const reg = new GpuProviderRegistry();
    expect(reg.getMonitorable('unknown')).toBeUndefined();
  });

  it('supports railway after register (CPU compute lookup)', () => {
    const reg = new GpuProviderRegistry();
    const railway = mockClient('railway');
    reg.register(railway);
    expect(reg.get('railway')).toBe(railway);
    expect(reg.get('railway')?.providerId).toBe('railway');
  });
});
