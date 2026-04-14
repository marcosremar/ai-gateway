/**
 * Tests for memory-safe module.
 */

import { describe, it, expect } from 'vitest';
import { BufferPool, RingBuffer, ObjectPool, LazyStringBuilder } from '../../src/memory-safe';

describe('BufferPool', () => {
  it('should store items up to max size', () => {
    const pool = new BufferPool<number>(3);
    pool.push(1);
    pool.push(2);
    pool.push(3);

    expect(pool.size).toBe(3);
    expect(pool.isFull).toBe(true);
  });

  it('should evict oldest when full', () => {
    const pool = new BufferPool<number>(2);
    pool.push(1);
    pool.push(2);
    const evicted = pool.push(3);

    expect(evicted).toBe(1);
    expect(pool.size).toBe(2);
  });

  it('should drain all items', () => {
    const pool = new BufferPool<number>(5);
    pool.push(1);
    pool.push(2);
    pool.push(3);

    const items = pool.drain();
    expect(items).toEqual([1, 2, 3]);
    expect(pool.size).toBe(0);
  });
});

describe('RingBuffer', () => {
  it('should store items in circular fashion', () => {
    const ring = new RingBuffer<number>(3);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    ring.push(4); // Overwrites 1

    const items = ring.getAll();
    expect(items).toEqual([2, 3, 4]);
  });

  it('should never exceed capacity', () => {
    const ring = new RingBuffer<number>(2);
    for (let i = 0; i < 10; i++) {
      ring.push(i);
    }

    expect(ring.size).toBeLessThanOrEqual(2);
  });
});

describe('ObjectPool', () => {
  it('should reuse objects', () => {
    let createCount = 0;
    const pool = new ObjectPool(() => {
      createCount++;
      return { value: createCount };
    }, 5, 1);

    const obj1 = pool.acquire();
    pool.release(obj1);
    const obj2 = pool.acquire();

    // Should reuse the same object
    expect(obj1).toBe(obj2);
    expect(createCount).toBe(1);
  });
});

describe('LazyStringBuilder', () => {
  it('should build strings efficiently', () => {
    const builder = new LazyStringBuilder();
    builder.append('Hello');
    builder.append(' ');
    builder.append('World');

    expect(builder.toString()).toBe('Hello World');
  });

  it('should append lines with newline', () => {
    const builder = new LazyStringBuilder();
    builder.appendLine('Line 1');
    builder.appendLine('Line 2');

    expect(builder.toString()).toBe('Line 1\nLine 2\n');
  });
});
