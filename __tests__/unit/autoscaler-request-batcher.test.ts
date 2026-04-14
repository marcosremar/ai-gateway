import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestBatcher } from '@ai-gateway/autoscaler/request-batcher';

describe('RequestBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes immediately when batch is full', async () => {
    const flushFn = vi.fn(async (batch: number[]) => batch.map((n) => n * 2));
    const batcher = new RequestBatcher<number>({ maxBatchSize: 2, maxWaitMs: 1000 }, flushFn);

    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(2);
    expect(r2).toBe(4);
    expect(flushFn).toHaveBeenCalledOnce();
    expect(flushFn).toHaveBeenCalledWith([1, 2]);

    batcher.destroy();
  });

  it('flushes after maxWaitMs when batch is not full', async () => {
    const flushFn = vi.fn(async (batch: string[]) => batch.map((s) => s.toUpperCase()));
    const batcher = new RequestBatcher<string>({ maxBatchSize: 10, maxWaitMs: 50, adaptiveWindow: false }, flushFn);

    const p1 = batcher.submit('hello');
    expect(flushFn).not.toHaveBeenCalled();
    expect(batcher.getPendingCount()).toBe(1);

    vi.advanceTimersByTime(50);

    const result = await p1;
    expect(result).toBe('HELLO');
    expect(flushFn).toHaveBeenCalledOnce();

    batcher.destroy();
  });

  it('manual flush() sends pending items immediately', async () => {
    const flushFn = vi.fn(async (batch: number[]) => batch.map((n) => n + 10));
    const batcher = new RequestBatcher<number>({ maxBatchSize: 100, maxWaitMs: 5000 }, flushFn);

    const p = batcher.submit(5);
    batcher.flush();

    const result = await p;
    expect(result).toBe(15);

    batcher.destroy();
  });

  it('getPendingCount returns correct count', async () => {
    const flushFn = vi.fn(async (batch: number[]) => batch);
    const batcher = new RequestBatcher<number>({ maxBatchSize: 10, maxWaitMs: 5000, adaptiveWindow: false }, flushFn);

    expect(batcher.getPendingCount()).toBe(0);
    batcher.submit(1);
    expect(batcher.getPendingCount()).toBe(1);
    batcher.submit(2);
    expect(batcher.getPendingCount()).toBe(2);

    batcher.flush();
    expect(batcher.getPendingCount()).toBe(0);

    batcher.destroy();
  });

  it('rejects all items on flushFn error', async () => {
    const flushFn = vi.fn(async () => { throw new Error('GPU error'); });
    const batcher = new RequestBatcher<number>({ maxBatchSize: 3, maxWaitMs: 5000 }, flushFn);

    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);
    const p3 = batcher.submit(3); // triggers flush

    await expect(p1).rejects.toThrow('GPU error');
    await expect(p2).rejects.toThrow('GPU error');
    await expect(p3).rejects.toThrow('GPU error');

    batcher.destroy();
  });

  it('destroy rejects pending items', async () => {
    const flushFn = vi.fn(async (batch: number[]) => batch);
    const batcher = new RequestBatcher<number>({ maxBatchSize: 100, maxWaitMs: 5000, adaptiveWindow: false }, flushFn);

    const p = batcher.submit(42);
    batcher.destroy();

    await expect(p).rejects.toThrow('Batcher destroyed');
  });

  it('throws on submit after destroy', async () => {
    const flushFn = vi.fn(async (batch: number[]) => batch);
    const batcher = new RequestBatcher<number>({ maxBatchSize: 10, maxWaitMs: 50 }, flushFn);
    batcher.destroy();

    await expect(batcher.submit(1)).rejects.toThrow('Batcher has been destroyed');
  });

  it('handles multiple batches sequentially', async () => {
    const calls: number[][] = [];
    const flushFn = vi.fn(async (batch: number[]) => {
      calls.push([...batch]);
      return batch.map((n) => n * 10);
    });
    const batcher = new RequestBatcher<number>({ maxBatchSize: 2, maxWaitMs: 1000 }, flushFn);

    // First batch
    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(10);
    expect(r2).toBe(20);

    // Second batch
    const p3 = batcher.submit(3);
    const p4 = batcher.submit(4);
    const [r3, r4] = await Promise.all([p3, p4]);
    expect(r3).toBe(30);
    expect(r4).toBe(40);

    expect(calls).toEqual([[1, 2], [3, 4]]);

    batcher.destroy();
  });

  it('flush is a no-op when pending is empty', () => {
    const flushFn = vi.fn(async (batch: number[]) => batch);
    const batcher = new RequestBatcher<number>({ maxBatchSize: 10, maxWaitMs: 50 }, flushFn);
    batcher.flush();
    expect(flushFn).not.toHaveBeenCalled();
    batcher.destroy();
  });

  it('adaptive window: single item triggers immediate flush when adaptiveWindow=true and computed wait is 0', async () => {
    const flushFn = vi.fn(async (batch: number[]) => batch.map((n) => n));
    // With adaptiveWindow=true, 1 item out of maxBatchSize=8 → wait = 50 * (1/8) = 6.25ms
    const batcher = new RequestBatcher<number>({ maxBatchSize: 8, maxWaitMs: 50, adaptiveWindow: true }, flushFn);

    const p = batcher.submit(1);
    // Should have scheduled a timer for ~6ms
    expect(flushFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);

    const result = await p;
    expect(result).toBe(1);
    expect(flushFn).toHaveBeenCalledOnce();

    batcher.destroy();
  });
});
