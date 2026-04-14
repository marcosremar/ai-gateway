import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequestCoalescer } from '../src/proxy/middleware/request-coalescer';

describe('RequestCoalescer', () => {
  let coalescer: RequestCoalescer;

  beforeEach(() => {
    coalescer = new RequestCoalescer();
  });

  describe('buildKey', () => {
    it('returns key for temperature=0', () => {
      const key = coalescer.buildKey({
        provider: 'groq',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      });
      expect(key).toBeTruthy();
      expect(key).toHaveLength(32);
    });

    it('returns key for temperature undefined', () => {
      const key = coalescer.buildKey({
        provider: 'groq',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(key).toBeTruthy();
    });

    it('returns null for temperature > 0', () => {
      const key = coalescer.buildKey({
        provider: 'groq',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
      });
      expect(key).toBeNull();
    });

    it('same params produce same key', () => {
      const params = {
        provider: 'groq',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      };
      const key1 = coalescer.buildKey(params);
      const key2 = coalescer.buildKey(params);
      expect(key1).toBe(key2);
    });

    it('different params produce different keys', () => {
      const key1 = coalescer.buildKey({
        provider: 'groq',
        model: 'llama3',
        messages: [{ role: 'user', content: 'a' }],
        temperature: 0,
      });
      const key2 = coalescer.buildKey({
        provider: 'groq',
        model: 'llama3',
        messages: [{ role: 'user', content: 'b' }],
        temperature: 0,
      });
      expect(key1).not.toBe(key2);
    });
  });

  describe('execute', () => {
    it('calls fn directly when key is null', async () => {
      const fn = vi.fn().mockResolvedValue('result');
      const result = await coalescer.execute(null, fn);
      expect(result).toBe('result');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('coalesces identical in-flight requests', async () => {
      let resolveFirst: (v: string) => void;
      const firstPromise = new Promise<string>((r) => { resolveFirst = r; });

      const fn = vi.fn()
        .mockReturnValueOnce(firstPromise)
        .mockResolvedValueOnce('second');

      const key = coalescer.buildKey({
        provider: 'groq',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      });

      const p1 = coalescer.execute(key, fn);
      const p2 = coalescer.execute(key, fn);

      resolveFirst!('first');
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe('first');
      expect(r2).toBe('first');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not coalesce after completion', async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce('first')
        .mockResolvedValueOnce('second');

      const key = coalescer.buildKey({
        provider: 'groq',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      });

      const r1 = await coalescer.execute(key, fn);
      const r2 = await coalescer.execute(key, fn);

      expect(r1).toBe('first');
      expect(r2).toBe('second');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('removes entry on error so next call retries', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('ok');

      const key = coalescer.buildKey({
        provider: 'groq',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      });

      await expect(coalescer.execute(key, fn)).rejects.toThrow('fail');
      const result = await coalescer.execute(key, fn);
      expect(result).toBe('ok');
    });

    it('tracks inflight size', async () => {
      let resolve: () => void;
      const p = new Promise<void>((r) => { resolve = r; });

      const key = coalescer.buildKey({
        provider: 'groq',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      });

      coalescer.execute(key, () => p.then(() => 'result'));
      expect(coalescer.size).toBe(1);

      resolve!();
      await new Promise((r) => setTimeout(r, 10));
      expect(coalescer.size).toBe(0);
    });
  });
});
