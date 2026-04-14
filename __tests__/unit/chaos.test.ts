/**
 * Tests for chaos module.
 */

import { describe, it, expect, vi } from 'vitest';
import { chaosMonkey, withChaos, withChaosSync } from '../../src/chaos';

describe('Chaos Monkey', () => {
  it('should be disabled by default', () => {
    expect(chaosMonkey.isActive()).toBe(false);
  });

  it('should activate when configured', () => {
    chaosMonkey.enable({ failureRate: 0 });
    expect(chaosMonkey.isActive()).toBe(true);
    chaosMonkey.disable();
  });

  it('should not inject failures when disabled', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withChaos(fn);
    expect(result).toBe('success');
  });

  it('should pass through sync functions when disabled', () => {
    const fn = vi.fn().mockReturnValue('sync-success');
    const result = withChaosSync(fn);
    expect(result).toBe('sync-success');
  });
});
