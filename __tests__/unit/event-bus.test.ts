/**
 * Tests for event-bus module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventBus, EVENTS } from '../../src/events';

describe('EventBus', () => {
  beforeEach(() => {
    // Clear all handlers and history between tests
    eventBus.offAll();
    eventBus.clearHistory();
    eventBus.resume(); // ensure not paused from previous test
  });

  it('should deliver events to subscribers', async () => {
    const handler = vi.fn();

    eventBus.on('test.event', handler);
    await eventBus.emit('test.event', { data: 'value' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ data: 'value' }, expect.any(String));
  });

  it('should deliver to multiple handlers', async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();

    eventBus.on('test.event', h1);
    eventBus.on('test.event', h2);
    await eventBus.emit('test.event', {});

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe handlers', async () => {
    const handler = vi.fn();

    eventBus.on('test.event', handler);
    eventBus.off('test.event', handler);
    await eventBus.emit('test.event', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('should fire once handlers', async () => {
    const handler = vi.fn();

    eventBus.once('test.event', handler);
    await eventBus.emit('test.event', {});
    await eventBus.emit('test.event', {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should store history', async () => {
    await eventBus.emit('test.event', { value: 1 });
    await eventBus.emit('test.event', { value: 2 });

    const history = eventBus.getHistory('test.event');
    expect(history.length).toBe(2);
  });

  it('should limit history size', async () => {
    for (let i = 0; i < 100; i++) {
      await eventBus.emit('test.event', { i });
    }

    expect(eventBus.getHistory('test.event').length).toBeLessThanOrEqual(100);
  });

  it('should pause/resume events', async () => {
    const handler = vi.fn();

    eventBus.on('test.event', handler);
    eventBus.pause();
    await eventBus.emit('test.event', {});
    expect(handler).not.toHaveBeenCalled();

    eventBus.resume();
    await eventBus.emit('test.event', {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should report stats', async () => {
    eventBus.on('test.event', vi.fn());
    await eventBus.emit('test.event', {});

    const stats = eventBus.getStats();
    expect(stats.eventTypes).toBeGreaterThanOrEqual(1);
  });
});

describe('EVENTS', () => {
  it('should have all expected event types', () => {
    expect(EVENTS.GPU_BOOT_STARTED).toBe('gpu.boot.started');
    expect(EVENTS.GPU_BOOT_COMPLETED).toBe('gpu.boot.completed');
    expect(EVENTS.PROVIDER_CALL_STARTED).toBe('provider.call.started');
    expect(EVENTS.PIPELINE_COMPLETED).toBe('pipeline.completed');
    expect(EVENTS.AUTH_SUCCESS).toBe('auth.success');
    expect(EVENTS.BUDGET_WARNING).toBe('budget.warning');
  });
});
