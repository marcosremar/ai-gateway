import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedEmitter } from '../src/browser/emitter';

interface TestEvents {
  message: string;
  count: number;
  data: { id: number; value: string };
}

describe('TypedEmitter', () => {
  let emitter: TypedEmitter<TestEvents>;

  beforeEach(() => {
    emitter = new TypedEmitter<TestEvents>();
  });

  describe('on()', () => {
    it('should subscribe to events', () => {
      const handler = vi.fn();
      emitter.on('message', handler);
      emitter.emit('message', 'hello');
      expect(handler).toHaveBeenCalledWith('hello');
    });

    it('should return an unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = emitter.on('message', handler);
      expect(typeof unsub).toBe('function');
    });

    it('should call multiple listeners for same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      emitter.on('message', handler1);
      emitter.on('message', handler2);
      emitter.emit('message', 'hello');
      expect(handler1).toHaveBeenCalledWith('hello');
      expect(handler2).toHaveBeenCalledWith('hello');
    });

    it('should handle different event types independently', () => {
      const msgHandler = vi.fn();
      const countHandler = vi.fn();
      emitter.on('message', msgHandler);
      emitter.on('count', countHandler);
      emitter.emit('message', 'hello');
      expect(msgHandler).toHaveBeenCalledWith('hello');
      expect(countHandler).not.toHaveBeenCalled();
    });

    it('should pass correct typed data to listener', () => {
      const handler = vi.fn();
      emitter.on('data', handler);
      const payload = { id: 42, value: 'test' };
      emitter.emit('data', payload);
      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('off()', () => {
    it('should remove a specific listener', () => {
      const handler = vi.fn();
      emitter.on('message', handler);
      emitter.off('message', handler);
      emitter.emit('message', 'hello');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should not throw when removing non-existent listener', () => {
      const handler = vi.fn();
      expect(() => emitter.off('message', handler)).not.toThrow();
    });

    it('should only remove the specified listener, not others', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      emitter.on('message', handler1);
      emitter.on('message', handler2);
      emitter.off('message', handler1);
      emitter.emit('message', 'hello');
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledWith('hello');
    });
  });

  describe('unsubscribe function from on()', () => {
    it('should unsubscribe when called', () => {
      const handler = vi.fn();
      const unsub = emitter.on('message', handler);
      unsub();
      emitter.emit('message', 'hello');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should not affect other listeners when unsubscribed', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const unsub1 = emitter.on('message', handler1);
      emitter.on('message', handler2);
      unsub1();
      emitter.emit('message', 'hello');
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledWith('hello');
    });
  });

  describe('emit()', () => {
    it('should not throw if no listeners for event', () => {
      expect(() => emitter.emit('message', 'hello')).not.toThrow();
    });

    it('should swallow listener errors without breaking caller', () => {
      const badHandler = vi.fn(() => { throw new Error('oops'); });
      const goodHandler = vi.fn();
      emitter.on('message', badHandler);
      emitter.on('message', goodHandler);
      expect(() => emitter.emit('message', 'hello')).not.toThrow();
      expect(goodHandler).toHaveBeenCalledWith('hello');
    });

    it('should log warning when listener throws', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const badHandler = vi.fn(() => { throw new Error('test error'); });
      emitter.on('message', badHandler);
      emitter.emit('message', 'hello');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should include event name in warning when listener throws', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      emitter.on('message', () => { throw new Error('fail'); });
      emitter.emit('message', 'hello');
      const warnArgs = warnSpy.mock.calls[0];
      expect(warnArgs?.[0]).toContain('message');
      warnSpy.mockRestore();
    });
  });

  describe('removeAllListeners()', () => {
    it('should remove all listeners for a specific event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      emitter.on('message', handler1);
      emitter.on('message', handler2);
      emitter.removeAllListeners('message');
      emitter.emit('message', 'hello');
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should remove all listeners for all events when no argument', () => {
      const msgHandler = vi.fn();
      const countHandler = vi.fn();
      emitter.on('message', msgHandler);
      emitter.on('count', countHandler);
      emitter.removeAllListeners();
      emitter.emit('message', 'hello');
      emitter.emit('count', 42);
      expect(msgHandler).not.toHaveBeenCalled();
      expect(countHandler).not.toHaveBeenCalled();
    });

    it('should not affect other events when removing listeners for specific event', () => {
      const msgHandler = vi.fn();
      const countHandler = vi.fn();
      emitter.on('message', msgHandler);
      emitter.on('count', countHandler);
      emitter.removeAllListeners('message');
      emitter.emit('count', 5);
      expect(countHandler).toHaveBeenCalledWith(5);
    });

    it('should not throw when removing all listeners for event with no listeners', () => {
      expect(() => emitter.removeAllListeners('message')).not.toThrow();
    });

    it('should allow re-adding listeners after removeAllListeners', () => {
      const handler = vi.fn();
      emitter.on('message', handler);
      emitter.removeAllListeners('message');
      emitter.on('message', handler);
      emitter.emit('message', 'hello');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('type safety', () => {
    it('should handle numeric event data', () => {
      const handler = vi.fn();
      emitter.on('count', handler);
      emitter.emit('count', 42);
      expect(handler).toHaveBeenCalledWith(42);
    });

    it('should handle object event data', () => {
      const handler = vi.fn();
      emitter.on('data', handler);
      const obj = { id: 1, value: 'test' };
      emitter.emit('data', obj);
      expect(handler).toHaveBeenCalledWith(obj);
    });
  });
});
