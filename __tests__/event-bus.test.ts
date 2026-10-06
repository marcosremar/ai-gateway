import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  onGatewayEvent,
  emitGatewayEvent,
  handlerCount,
} from '../server/event-bus';

// Collect all unsubscribe functions so we can clean up after each test
// (module-level handler array persists across tests in the same worker)
const unsubs: Array<() => void> = [];

function subscribe(handler: Parameters<typeof onGatewayEvent>[0]) {
  const unsub = onGatewayEvent(handler);
  unsubs.push(unsub);
  return unsub;
}

beforeEach(() => {
  // Drain all registered handlers from previous tests
  for (const unsub of unsubs.splice(0)) unsub();
});

describe('onGatewayEvent / emitGatewayEvent / handlerCount', () => {
  // ── Registration & counting ────────────────────────────────────────────────

  describe('registration', () => {
    it('handlerCount starts at 0 (after cleanup)', () => {
      expect(handlerCount()).toBe(0);
    });

    it('handlerCount increases when a handler is registered', () => {
      subscribe(() => {});
      expect(handlerCount()).toBe(1);
    });

    it('handlerCount reflects multiple handlers', () => {
      subscribe(() => {});
      subscribe(() => {});
      subscribe(() => {});
      expect(handlerCount()).toBe(3);
    });
  });

  // ── Emit ──────────────────────────────────────────────────────────────────

  describe('emitGatewayEvent', () => {
    it('calls a registered handler', () => {
      const fn = vi.fn();
      subscribe(fn);
      emitGatewayEvent('gpu.deployed', { provider: 'runpod' });
      expect(fn).toHaveBeenCalledOnce();
    });

    it('passes the event name as first argument', () => {
      const calls: Array<[string, unknown]> = [];
      subscribe((evt, data) => calls.push([evt, data]));
      emitGatewayEvent('budget.warning', {});
      expect(calls[0][0]).toBe('budget.warning');
    });

    it('injects a timestamp into the payload', () => {
      let received: Record<string, unknown> = {};
      subscribe((_evt, data) => { received = data as Record<string, unknown>; });
      emitGatewayEvent('gpu.stopped', {});
      expect(typeof received['timestamp']).toBe('string');
      // Should be a valid ISO-8601 string
      expect(new Date(received['timestamp'] as string).toString()).not.toBe('Invalid Date');
    });

    it('includes caller-supplied data in the payload', () => {
      let received: Record<string, unknown> = {};
      subscribe((_evt, data) => { received = data as Record<string, unknown>; });
      emitGatewayEvent('gpu.deployed', { provider: 'vast', podId: 'abc123' });
      expect(received['provider']).toBe('vast');
      expect(received['podId']).toBe('abc123');
    });

    it('includes the event name in the payload', () => {
      let received: Record<string, unknown> = {};
      subscribe((_evt, data) => { received = data as Record<string, unknown>; });
      emitGatewayEvent('budget.critical', {});
      expect(received['event']).toBe('budget.critical');
    });

    it('calls all registered handlers', () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const fn3 = vi.fn();
      subscribe(fn1);
      subscribe(fn2);
      subscribe(fn3);
      emitGatewayEvent('gpu.failed', { reason: 'OOM' });
      expect(fn1).toHaveBeenCalledOnce();
      expect(fn2).toHaveBeenCalledOnce();
      expect(fn3).toHaveBeenCalledOnce();
    });

    it('all handlers receive the same enriched payload', () => {
      const payloads: Record<string, unknown>[] = [];
      subscribe((_evt, data) => payloads.push(data as Record<string, unknown>));
      subscribe((_evt, data) => payloads.push(data as Record<string, unknown>));
      emitGatewayEvent('gpu.terminated', { podId: 'xyz' });
      expect(payloads[0]).toEqual(payloads[1]);
    });

    it('emitting with no handlers is a no-op (does not throw)', () => {
      expect(() => emitGatewayEvent('gpu.deployed', {})).not.toThrow();
    });
  });

  // ── Error isolation ────────────────────────────────────────────────────────

  describe('handler error isolation', () => {
    it('a throwing handler does not propagate to the caller', () => {
      subscribe(() => { throw new Error('boom'); });
      expect(() => emitGatewayEvent('gpu.deployed', {})).not.toThrow();
    });

    it('a throwing handler does not prevent subsequent handlers from running', () => {
      const second = vi.fn();
      subscribe(() => { throw new Error('first handler fails'); });
      subscribe(second);
      emitGatewayEvent('gpu.deployed', {});
      expect(second).toHaveBeenCalledOnce();
    });

    it('all handlers still run even if multiple throw', () => {
      const counts: number[] = [];
      subscribe(() => { counts.push(1); throw new Error('h1'); });
      subscribe(() => { counts.push(2); throw new Error('h2'); });
      subscribe(() => { counts.push(3); });
      emitGatewayEvent('budget.exceeded', {});
      expect(counts).toEqual([1, 2, 3]);
    });
  });

  // ── Unsubscribe ───────────────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('returned function removes the handler', () => {
      const fn = vi.fn();
      const unsub = onGatewayEvent(fn);
      unsubs.push(unsub); // cleanup safety net
      unsub();
      emitGatewayEvent('gpu.deployed', {});
      expect(fn).not.toHaveBeenCalled();
    });

    it('handlerCount decrements after unsubscribe', () => {
      const unsub = subscribe(() => {});
      expect(handlerCount()).toBe(1);
      unsub();
      expect(handlerCount()).toBe(0);
    });

    it('calling unsubscribe twice is a no-op (does not throw)', () => {
      const unsub = subscribe(() => {});
      unsub();
      expect(() => unsub()).not.toThrow();
      expect(handlerCount()).toBe(0);
    });

    it('unsubscribing one handler leaves others intact', () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      subscribe(fn1);
      const unsub2 = onGatewayEvent(fn2);
      unsubs.push(unsub2);
      unsub2();
      emitGatewayEvent('gpu.deployed', {});
      expect(fn1).toHaveBeenCalledOnce();
      expect(fn2).not.toHaveBeenCalled();
    });
  });

  // ── Well-known event names ────────────────────────────────────────────────

  describe('well-known event names', () => {
    const wellKnown = [
      'gpu.deployed',
      'gpu.failed',
      'gpu.stopped',
      'gpu.terminated',
      'budget.warning',
      'budget.critical',
      'budget.exceeded',
    ] as const;

    for (const evt of wellKnown) {
      it(`emits "${evt}" without error`, () => {
        const fn = vi.fn();
        subscribe(fn);
        emitGatewayEvent(evt, {});
        expect(fn).toHaveBeenCalledOnce();
      });
    }
  });

  // ── Custom / arbitrary event names ────────────────────────────────────────

  describe('arbitrary event names', () => {
    it('accepts any string event name', () => {
      const fn = vi.fn();
      subscribe(fn);
      emitGatewayEvent('my.custom.event', { x: 1 });
      expect(fn).toHaveBeenCalledOnce();
    });
  });
});
