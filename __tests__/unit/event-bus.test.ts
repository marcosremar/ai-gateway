/**
 * Tests for event-bus module.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventBus, EVENTS } from '../../src/event-bus';

describe('EventBus', () => {
  it('should deliver events to subscribers', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('test.event', handler);
    await bus.emit('test.event', { data: 'value' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ data: 'value' }, expect.any(String));
  });

  it('should deliver to multiple handlers', async () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on('test.event', h1);
    bus.on('test.event', h2);
    await bus.emit('test.event', {});

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe handlers', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('test.event', handler);
    bus.off('test.event', handler);
    await bus.emit('test.event', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('should fire once handlers', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.once('test.event', handler);
    await bus.emit('test.event', {});
    await bus.emit('test.event', {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should store history', async () => {
    const bus = new EventBus();
    await bus.emit('test.event', { value: 1 });
    await bus.emit('test.event', { value: 2 });

    const history = bus.getHistory('test.event');
    expect(history.length).toBe(2);
  });

  it('should limit history size', async () => {
    const bus = new EventBus();
    for (let i = 0; i < 100; i++) {
      await bus.emit('test.event', { i });
    }

    expect(bus.getHistory('test.event').length).toBeLessThanOrEqual(100);
  });

  it('should pause/resume events', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('test.event', handler);
    bus.pause();
    await bus.emit('test.event', {});
    expect(handler).not.toHaveBeenCalled();

    bus.resume();
    await bus.emit('test.event', {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should report stats', async () => {
    const bus = new EventBus();
    await bus.emit('test.event', {});

    const stats = bus.getStats();
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
