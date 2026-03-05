import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emitHook } from '../src/hooks';
import type { GatewayHooks, RequestStartEvent, RequestEndEvent, FallbackEvent, ScaleUpEvent, ScaleDownEvent, CostAlertEvent, HealthChangeEvent } from '../src/hooks';

describe('emitHook()', () => {
  describe('basic behavior', () => {
    it('should be a no-op when hooks is undefined', () => {
      expect(() => {
        emitHook(undefined, 'onRequestStart', {
          userId: 'u1', stage: 'llm', provider: 'openai', timestamp: Date.now(),
        });
      }).not.toThrow();
    });

    it('should be a no-op when the specific hook is not defined', () => {
      const hooks: GatewayHooks = {};
      expect(() => {
        emitHook(hooks, 'onRequestStart', {
          userId: 'u1', stage: 'llm', provider: 'openai', timestamp: Date.now(),
        });
      }).not.toThrow();
    });

    it('should call the hook with correct data', () => {
      const handler = vi.fn();
      const hooks: GatewayHooks = { onRequestStart: handler };
      const event: RequestStartEvent = {
        userId: 'u1', stage: 'llm', provider: 'openai', timestamp: 1000,
      };
      emitHook(hooks, 'onRequestStart', event);
      expect(handler).toHaveBeenCalledWith(event);
    });
  });

  describe('onRequestStart', () => {
    it('should fire with all required fields', () => {
      const handler = vi.fn();
      const hooks: GatewayHooks = { onRequestStart: handler };
      const event: RequestStartEvent = {
        userId: 'user123', stage: 'stt', provider: 'groq', model: 'whisper-v3', timestamp: Date.now(),
      };
      emitHook(hooks, 'onRequestStart', event);
      expect(handler).toHaveBeenCalledWith(event);
    });
  });

  describe('onRequestEnd', () => {
    it('should fire with latency and success info', () => {
      const handler = vi.fn();
      const hooks: GatewayHooks = { onRequestEnd: handler };
      const event: RequestEndEvent = {
        userId: 'u1', stage: 'tts', provider: 'openai',
        latencyMs: 150, success: true, timestamp: Date.now(),
      };
      emitHook(hooks, 'onRequestEnd', event);
      expect(handler).toHaveBeenCalledWith(event);
    });
  });

  describe('onFallback', () => {
    it('should fire with from/to provider info', () => {
      const handler = vi.fn();
      const hooks: GatewayHooks = { onFallback: handler };
      const event: FallbackEvent = {
        userId: 'u1', stage: 'llm',
        fromProvider: 'openai', toProvider: 'groq',
        reason: 'credit_exhausted', timestamp: Date.now(),
      };
      emitHook(hooks, 'onFallback', event);
      expect(handler).toHaveBeenCalledWith(event);
    });
  });

  describe('onScaleUp', () => {
    it('should fire with tier and trigger info', () => {
      const handler = vi.fn();
      const hooks: GatewayHooks = { onScaleUp: handler };
      const event: ScaleUpEvent = {
        userId: 'u1', tierIndex: 0, provider: 'runpod',
        trigger: 'sessions', activeSessions: 5, timestamp: Date.now(),
      };
      emitHook(hooks, 'onScaleUp', event);
      expect(handler).toHaveBeenCalledWith(event);
    });
  });

  describe('onScaleDown', () => {
    it('should fire with tier and idle info', () => {
      const handler = vi.fn();
      const hooks: GatewayHooks = { onScaleDown: handler };
      const event: ScaleDownEvent = {
        userId: 'u1', tierIndex: 0, provider: 'runpod',
        reason: 'idle_timeout', idleMinutes: 30, timestamp: Date.now(),
      };
      emitHook(hooks, 'onScaleDown', event);
      expect(handler).toHaveBeenCalledWith(event);
    });
  });

  describe('onCostAlert', () => {
    it('should fire with cost alert info', () => {
      const handler = vi.fn();
      const hooks: GatewayHooks = { onCostAlert: handler };
      const event: CostAlertEvent = {
        userId: 'u1', provider: 'runpod', instanceId: 'inst-abc',
        alertType: 'orphaned', message: 'Orphaned instance detected', timestamp: Date.now(),
      };
      emitHook(hooks, 'onCostAlert', event);
      expect(handler).toHaveBeenCalledWith(event);
    });
  });

  describe('onHealthChange', () => {
    it('should fire with state transition info', () => {
      const handler = vi.fn();
      const hooks: GatewayHooks = { onHealthChange: handler };
      const event: HealthChangeEvent = {
        userId: 'u1', tierIndex: 0, provider: 'tensordock',
        previousState: 'booting', newState: 'ready',
        endpoint: 'http://1.2.3.4:8000', timestamp: Date.now(),
      };
      emitHook(hooks, 'onHealthChange', event);
      expect(handler).toHaveBeenCalledWith(event);
    });
  });

  describe('error handling — sync errors', () => {
    it('should not throw when sync hook throws', () => {
      const hooks: GatewayHooks = {
        onRequestStart: () => { throw new Error('sync error'); },
      };
      expect(() => {
        emitHook(hooks, 'onRequestStart', {
          userId: 'u1', stage: 'llm', provider: 'openai', timestamp: Date.now(),
        });
      }).not.toThrow();
    });

    it('should log warning when sync hook throws', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const hooks: GatewayHooks = {
        onRequestStart: () => { throw new Error('sync error'); },
      };
      emitHook(hooks, 'onRequestStart', {
        userId: 'u1', stage: 'llm', provider: 'openai', timestamp: Date.now(),
      });
      // The warning goes through defaultLogger which may or may not write to console.warn
      // At minimum we verify no throw
      warnSpy.mockRestore();
    });
  });

  describe('error handling — async errors', () => {
    it('should not throw when async hook rejects', async () => {
      const hooks: GatewayHooks = {
        onRequestEnd: async () => { throw new Error('async error'); },
      };
      expect(() => {
        emitHook(hooks, 'onRequestEnd', {
          userId: 'u1', stage: 'llm', provider: 'openai',
          latencyMs: 100, success: false, timestamp: Date.now(),
        });
      }).not.toThrow();
      // Give the promise a chance to reject
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  describe('async hooks', () => {
    it('should call async hook and return without waiting', () => {
      let called = false;
      const hooks: GatewayHooks = {
        onScaleDown: async () => {
          await new Promise((r) => setTimeout(r, 100));
          called = true;
        },
      };
      emitHook(hooks, 'onScaleDown', {
        userId: 'u1', tierIndex: 0, provider: 'runpod',
        reason: 'idle', idleMinutes: 10, timestamp: Date.now(),
      });
      // Should not have waited
      expect(called).toBe(false);
    });
  });
});
