/**
 * Tests for feature-flags module.
 */

import { describe, it, expect, vi } from 'vitest';
import { featureFlags, defineStandardFlags } from '../../src/feature-flags';
import { EVENTS } from '../../src/events';

describe('Feature Flags', () => {
  it('should define and check flags', () => {
    defineStandardFlags();
    expect(featureFlags.getNames().length).toBeGreaterThan(0);
  });

  it('should set and get flag values', () => {
    featureFlags.set('gpu-threshold', 0.9);
    expect(featureFlags.get('gpu-threshold', 0.5)).toBe(0.9);
  });

  it('should notify listeners on change', () => {
    const listener = vi.fn();
    featureFlags.onChange('test-flag', listener);
    featureFlags.set('test-flag', true);
    expect(listener).toHaveBeenCalled();
  });
});

describe('EVENTS', () => {
  it('should have all event types', () => {
    expect(EVENTS.GPU_BOOT_STARTED).toBeDefined();
    expect(EVENTS.PIPELINE_COMPLETED).toBeDefined();
    expect(EVENTS.AUTH_SUCCESS).toBeDefined();
  });
});
