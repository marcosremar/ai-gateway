import { describe, it, expect, vi } from 'vitest';
import { mergeHooks } from '../src/observability/merge-hooks';
import { createConsoleHooks } from '../src/observability/console-hooks';
import { createWebhookHooks } from '../src/observability/webhook-hooks';
import type { GatewayHooks, RequestStartEvent } from '../src/hooks';

describe('Observability', () => {
  describe('mergeHooks', () => {
    it('fans out to multiple hook implementations', () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const fn3 = vi.fn();

      const merged = mergeHooks(
        { onRequestStart: fn1 },
        { onRequestStart: fn2, onRequestEnd: fn3 },
      );

      const event: RequestStartEvent = {
        userId: 'u1',
        stage: 'llm',
        provider: 'openai',
        model: 'gpt-4',
        timestamp: Date.now(),
      };

      merged.onRequestStart!(event);
      expect(fn1).toHaveBeenCalledWith(event);
      expect(fn2).toHaveBeenCalledWith(event);
      expect(fn3).not.toHaveBeenCalled();
    });

    it('does not create hook if no implementations', () => {
      const merged = mergeHooks(
        { onRequestStart: vi.fn() },
        {},
      );
      expect(merged.onRequestEnd).toBeUndefined();
    });

    it('swallows errors from hook implementations', () => {
      const failingFn = vi.fn().mockImplementation(() => { throw new Error('boom'); });
      const successFn = vi.fn();

      const merged = mergeHooks(
        { onRequestStart: failingFn },
        { onRequestStart: successFn },
      );

      const event: RequestStartEvent = {
        userId: 'u1', stage: 'llm', provider: 'test', timestamp: Date.now(),
      };

      // Should not throw
      expect(() => merged.onRequestStart!(event)).not.toThrow();
      expect(successFn).toHaveBeenCalled();
    });

    it('swallows async errors', () => {
      const asyncFail = vi.fn().mockRejectedValue(new Error('async boom'));
      const merged = mergeHooks({ onFallback: asyncFail });

      expect(() => merged.onFallback!({
        userId: 'u1', stage: 'llm', fromProvider: 'a', toProvider: 'b',
        reason: 'test', timestamp: Date.now(),
      })).not.toThrow();
    });
  });

  describe('createConsoleHooks', () => {
    it('logs structured JSON', () => {
      const mockLog = vi.fn();
      const hooks = createConsoleHooks({ log: mockLog, warn: vi.fn(), error: vi.fn() });

      hooks.onRequestStart!({
        userId: 'u1', stage: 'llm', provider: 'openai', timestamp: 1234,
      });

      expect(mockLog).toHaveBeenCalledOnce();
      const parsed = JSON.parse(mockLog.mock.calls[0][0]);
      expect(parsed.event).toBe('onRequestStart');
      expect(parsed.provider).toBe('openai');
    });
  });

  describe('createWebhookHooks', () => {
    it('enqueues events and flushes on batch size', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const hooks = createWebhookHooks({
        url: 'https://example.com/hook',
        batchSize: 2,
        flushIntervalMs: 60_000,
      });

      hooks.onRequestStart!({
        userId: 'u1', stage: 'llm', provider: 'openai', timestamp: Date.now(),
      });
      hooks.onRequestEnd!({
        userId: 'u1', stage: 'llm', provider: 'openai',
        latencyMs: 100, success: true, timestamp: Date.now(),
      });

      // Wait for flush
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.events).toHaveLength(2);
    });

    it('filters events by name', () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const hooks = createWebhookHooks({
        url: 'https://example.com/hook',
        events: ['onCostAlert'], // only cost alerts
        batchSize: 1,
      });

      hooks.onRequestStart!({
        userId: 'u1', stage: 'llm', provider: 'openai', timestamp: Date.now(),
      });

      // Should not have flushed since event was filtered
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
