/**
 * Tests for streaming module.
 */

import { describe, it, expect, vi } from 'vitest';
import { createBackpressureStream, mapStream, filterStream } from '../../src/streaming';

describe('createBackpressureStream', () => {
  it('should stream all items', async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }

    const stream = createBackpressureStream(gen(), { highWaterMark: 10 });
    const results: number[] = [];
    for await (const item of stream) {
      results.push(item);
    }

    expect(results).toEqual([1, 2, 3]);
  });

  it('should apply backpressure', async () => {
    let produced = 0;
    let consumed = 0;

    async function* gen() {
      for (let i = 0; i < 20; i++) {
        produced++;
        yield i;
      }
    }

    const stream = createBackpressureStream(gen(), { highWaterMark: 5 });
    for await (const item of stream) {
      consumed++;
      expect(produced - consumed).toBeLessThanOrEqual(6); // Allow some buffer
    }
  });
});

describe('mapStream', () => {
  it('should transform items', async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }

    const results: number[] = [];
    for await (const item of mapStream(gen(), async (x) => x * 2)) {
      results.push(item);
    }

    expect(results).toEqual([2, 4, 6]);
  });
});

describe('filterStream', () => {
  it('should filter items', async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
      yield 4;
      yield 5;
    }

    const results: number[] = [];
    for await (const item of filterStream(gen(), async (x) => x % 2 === 0)) {
      results.push(item);
    }

    expect(results).toEqual([2, 4]);
  });
});
