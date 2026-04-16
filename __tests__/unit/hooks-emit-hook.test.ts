import { describe, it, expect, vi } from 'vitest';
import { emitHook } from '../src/hooks';
import type { GatewayHooks, RequestStartEvent } from '../src/hooks';

describe('emitHook()', () => {
  it('should do nothing when hooks is undefined', () => {
    expect(() => {
      emitHook(undefined, 'onRequestStart', {
        userId: 'u1', stage: 'llm', provider: 'openai', timestamp: Date.now(),
      });
    }).not.toThrow();
  });

  it('should do nothing when hook function is undefined', () => {
    const hooks: GatewayHooks = {};
    expect(() => {
      emitHook(hooks, 'onRequestStart', {
        userId: 'u1', stage: 'llm', provider: 'openai', timestamp: Date.now(),
      });
    }).not.toThrow();
  });

  it('should call hook function with data', () => {
    const handler = vi.fn();
    const hooks: GatewayHooks = { onRequestStart: handler };
    const event: RequestStartEvent = {
      userId: 'u1', stage: 'llm', provider: 'openai', timestamp: 1000,
    };
    emitHook(hooks, 'onRequestStart', event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('should catch sync errors from hook', () => {
    const hooks: GatewayHooks = {
      onRequestStart: () => { throw new Error('sync boom'); },
    };
    expect(() => {
      emitHook(hooks, 'onRequestStart', {
        userId: 'u1', stage: 'llm', provider: 'openai', timestamp: Date.now(),
      });
    }).not.toThrow();
  });

  it('should catch async errors from hook', async () => {
    const hooks: GatewayHooks = {
      onRequestStart: async () => { throw new Error('async boom'); },
    };
    expect(() => {
      emitHook(hooks, 'onRequestStart', {
        userId: 'u1', stage: 'llm', provider: 'openai', timestamp: Date.now(),
      });
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});
