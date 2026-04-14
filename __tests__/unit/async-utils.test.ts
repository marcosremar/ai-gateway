/**
 * Tests for async-utils module.
 */

import { describe, it, expect, vi } from 'vitest';
import { AsyncMutex, AsyncSemaphore } from '../../src/async-utils';

describe('AsyncMutex', () => {
  it('should allow exclusive access', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const p1 = mutex.runExclusive(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 50));
      order.push(2);
      return 'done1';
    });

    const p2 = mutex.runExclusive(async () => {
      order.push(3);
      await new Promise((r) => setTimeout(r, 10));
      order.push(4);
      return 'done2';
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('done1');
    expect(r2).toBe('done2');
    // Should be sequential: 1, 2, 3, 4
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('should tryRunExclusive without waiting', async () => {
    const mutex = new AsyncMutex();

    const result = await mutex.tryRunExclusive(async () => 'first');
    expect(result).toBe('first');
  });

  it('should return null if already locked', async () => {
    const mutex = new AsyncMutex();

    const p1 = mutex.runExclusive(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return 'done';
    });

    const result = await mutex.tryRunExclusive(async () => 'second');
    expect(result).toBeNull();

    await p1;
  });
});

describe('AsyncSemaphore', () => {
  it('should limit concurrency', async () => {
    const sem = new AsyncSemaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 5 }, async () => {
      await sem.acquire();
      try {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
      } finally {
        sem.release();
      }
    });

    await Promise.all(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('should runWithPermit', async () => {
    const sem = new AsyncSemaphore(1);
    const result = await sem.runWithPermit(async () => 'success');
    expect(result).toBe('success');
  });
});
