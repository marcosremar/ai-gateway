/**
 * Tests for autoscaler/lifecycle-logger.ts
 * - GpuLifecycleLogEntry interface
 * - GpuLifecycleLogger interface
 * - noopLifecycleLogger
 */

import { describe, it, expect } from 'vitest';
import { noopLifecycleLogger, type GpuLifecycleLogEntry, type GpuLifecycleLogger } from '../src/autoscaler/lifecycle-logger';

describe('noopLifecycleLogger', () => {
  it('is defined', () => {
    expect(noopLifecycleLogger).toBeDefined();
  });

  it('has a log method', () => {
    expect(typeof noopLifecycleLogger.log).toBe('function');
  });

  it('log() does not throw', () => {
    const entry: GpuLifecycleLogEntry = {
      userId: 'user-1',
      tierIndex: 0,
      provider: 'runpod',
      eventType: 'boot_started',
      instanceId: 'pod-123',
    };
    expect(() => noopLifecycleLogger.log(entry)).not.toThrow();
  });

  it('log() returns void/undefined (not a Promise that rejects)', async () => {
    const entry: GpuLifecycleLogEntry = {
      userId: 'user-1',
      tierIndex: 0,
      provider: 'tensordock',
      eventType: 'boot_ok',
      durationMs: 30000,
    };
    const result = noopLifecycleLogger.log(entry);
    // noop returns void — could be undefined or a resolved Promise
    if (result instanceof Promise) {
      await expect(result).resolves.toBeUndefined();
    }
  });

  it('accepts all standard event types', () => {
    const eventTypes = [
      'boot_started', 'boot_ok', 'boot_failed', 'boot_timeout',
      'health_ok', 'health_lost', 'scale_down', 'cleanup',
      'cost_alert', 'zombie_deleted', 'tier_stopped', 'tier_started',
      'tier_deleted', 'tier_restarted', 'tier_deployed',
    ] as const;

    for (const eventType of eventTypes) {
      const entry: GpuLifecycleLogEntry = {
        userId: 'user-1',
        tierIndex: 0,
        provider: 'runpod',
        eventType,
      };
      expect(() => noopLifecycleLogger.log(entry)).not.toThrow();
    }
  });

  it('accepts custom event type string', () => {
    const entry: GpuLifecycleLogEntry = {
      userId: 'user-1',
      tierIndex: 0,
      provider: 'runpod',
      eventType: 'custom_event_123',
    };
    expect(() => noopLifecycleLogger.log(entry)).not.toThrow();
  });

  it('accepts all optional fields', () => {
    const entry: GpuLifecycleLogEntry = {
      userId: 'user-1',
      tierIndex: 2,
      provider: 'tensordock',
      eventType: 'boot_ok',
      instanceId: 'td-inst-abc',
      endpoint: 'http://td-inst-abc:8000',
      durationMs: 45000,
      trigger: 'latency',
      oldState: 'booting',
      newState: 'ready',
      error: undefined,
      metadata: { bootTriggeredAt: 1234567890, extraInfo: 'test' },
    };
    expect(() => noopLifecycleLogger.log(entry)).not.toThrow();
  });
});

describe('GpuLifecycleLogger interface (custom implementation)', () => {
  it('custom logger receives correct entry', async () => {
    const received: GpuLifecycleLogEntry[] = [];
    const customLogger: GpuLifecycleLogger = {
      log: (entry) => { received.push(entry); },
    };

    const entry: GpuLifecycleLogEntry = {
      userId: 'user-2',
      tierIndex: 1,
      provider: 'modal',
      eventType: 'scale_down',
      trigger: 'idle',
      oldState: 'ready',
      newState: 'idle',
    };

    customLogger.log(entry);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(entry);
  });

  it('async logger works as well', async () => {
    const received: GpuLifecycleLogEntry[] = [];
    const asyncLogger: GpuLifecycleLogger = {
      log: async (entry) => { received.push(entry); },
    };

    const entry: GpuLifecycleLogEntry = {
      userId: 'user-3',
      tierIndex: 0,
      provider: 'runpod',
      eventType: 'health_lost',
    };

    await asyncLogger.log(entry);
    expect(received).toHaveLength(1);
  });
});
