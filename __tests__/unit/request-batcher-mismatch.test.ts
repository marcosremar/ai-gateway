import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestBatcher } from '../../src/autoscaler/request-batcher';

describe('RequestBatcher — flush result mismatch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rejects all items when flushFn returns empty array', async () => {
    const flushFn = vi.fn(async () => []);
    const batcher = new RequestBatcher<number>({ maxBatchSize: 2, maxWaitMs: 5000 }, flushFn);
    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);
    await expect(p1).rejects.toThrow('Batch result missing');
    await expect(p2).rejects.toThrow('Batch result missing');
    batcher.destroy();
  });

  it('rejects only missing items when flushFn returns fewer results', async () => {
    const flushFn = vi.fn(async (batch: number[]) => batch.slice(0, 1).map(n => n * 10));
    const batcher = new RequestBatcher<number>({ maxBatchSize: 3, maxWaitMs: 5000 }, flushFn);
    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);
    const p3 = batcher.submit(3);
    expect(await p1).toBe(10);
    await expect(p2).rejects.toThrow('Batch result missing');
    await expect(p3).rejects.toThrow('Batch result missing');
    batcher.destroy();
  });

  it('handles flushFn returning more results than items gracefully', async () => {
    const flushFn = vi.fn(async (batch: number[]) => [...batch.map(n => n * 2), 999]);
    const batcher = new RequestBatcher<number>({ maxBatchSize: 2, maxWaitMs: 5000 }, flushFn);
    const p1 = batcher.submit(5);
    const p2 = batcher.submit(6);
    expect(await p1).toBe(10);
    expect(await p2).toBe(12);
    batcher.destroy();
  });
});
