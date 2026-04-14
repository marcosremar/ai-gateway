/**
 * Tests for di-container module.
 */

import { describe, it, expect, vi } from 'vitest';
import { createContainer } from '../../src/di-container';

describe('DIContainer', () => {
  it('should register and resolve services', () => {
    const container = createContainer();
    container.register('logger', () => ({ log: vi.fn() }));

    const logger = container.get('logger');
    expect(logger).toBeDefined();
    expect(logger.log).toBeDefined();
  });

  it('should return same instance for singletons', () => {
    const container = createContainer();
    container.register('service', () => ({ id: Math.random() }));

    const s1 = container.get('service');
    const s2 = container.get('service');
    expect(s1).toBe(s2);
  });

  it('should detect circular dependencies', () => {
    const container = createContainer();
    container.register('a', (c) => ({ b: c.get('b') }));
    container.register('b', (c) => ({ a: c.get('a') }));

    expect(() => container.get('a')).toThrow('Circular dependency');
  });

  it('should create child containers', () => {
    const parent = createContainer();
    parent.register('shared', () => 'parent-value');

    const child = parent.createChild();
    expect(child.get('shared')).toBe('parent-value');
  });
});
