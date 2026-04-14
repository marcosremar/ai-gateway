/**
 * Tests for lazy-provider module.
 */

import { describe, it, expect, vi } from 'vitest';
import { createLazyProviderLoader } from '../../src/lazy-provider';

describe('LazyProviderLoader', () => {
  it('should register and get provider', async () => {
    const loader = createLazyProviderLoader();
    loader.register('test', async () => ({ name: 'test' }));

    const provider = await loader.get('test');
    expect(provider.name).toBe('test');
  });

  it('should cache provider instances', async () => {
    const loader = createLazyProviderLoader();
    const factory = vi.fn().mockResolvedValue({ name: 'cached' });
    loader.register('cached', factory);

    await loader.get('cached');
    await loader.get('cached');

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('should check if loaded', async () => {
    const loader = createLazyProviderLoader();
    loader.register('lazy', async () => ({}));

    expect(loader.isLoaded('lazy')).toBe(false);
    await loader.get('lazy');
    expect(loader.isLoaded('lazy')).toBe(true);
  });

  it('should unload providers', async () => {
    const loader = createLazyProviderLoader();
    loader.register('unloadable', async () => ({}));

    await loader.get('unloadable');
    expect(loader.isLoaded('unloadable')).toBe(true);

    loader.unload('unloadable');
    expect(loader.isLoaded('unloadable')).toBe(false);
  });

  it('should register instances directly', () => {
    const loader = createLazyProviderLoader();
    loader.registerInstance('direct', { name: 'direct' });

    expect(loader.isLoaded('direct')).toBe(true);
  });

  it('should list provider names', () => {
    const loader = createLazyProviderLoader();
    loader.register('a', async () => ({}));
    loader.register('b', async () => ({}));

    const names = loader.names();
    expect(names).toContain('a');
    expect(names).toContain('b');
  });

  it('should report status', async () => {
    const loader = createLazyProviderLoader();
    loader.register('loaded', async () => ({}));
    loader.registerInstance('preloaded', {});

    await loader.get('loaded');

    const status = loader.status();
    expect(status.find((s) => s.name === 'loaded')?.loaded).toBe(true);
    expect(status.find((s) => s.name === 'preloaded')?.loaded).toBe(true);
  });

  it('should unload all providers', async () => {
    const loader = createLazyProviderLoader();
    loader.register('a', async () => ({}));
    loader.register('b', async () => ({}));

    await loader.get('a');
    await loader.get('b');

    loader.unloadAll();
    expect(loader.isLoaded('a')).toBe(false);
    expect(loader.isLoaded('b')).toBe(false);
  });

  it('should throw for unregistered providers', async () => {
    const loader = createLazyProviderLoader();
    await expect(loader.get('nonexistent')).rejects.toThrow('not registered');
  });
});
