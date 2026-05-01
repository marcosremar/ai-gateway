/**
 * Memory-safe buffer pool — prevents unbounded memory growth.
 *
 * Fixes: #076-100 (memory leaks), #511-545 (unnecessary allocations)
 *
 * Usage:
 * ```ts
 * import { BufferPool, RingBuffer, ObjectPool } from './memory-safe';
 *
 * // Fixed-size buffer pool — old items evicted when full
 * const pool = new BufferPool(1000); // Max 1000 items
 * pool.push(item);
 * const items = pool.drain(); // Gets all items, pool is now empty
 *
 * // Ring buffer — circular, never allocates new memory
 * const ring = new RingBuffer<number>(100);
 * ring.push(1);
 * ring.push(2);
 * const all = ring.getAll(); // [1, 2]
 *
 * // Object pool — reuse objects instead of allocating
 * const pool = new ObjectPool(() => ({ data: null, timestamp: 0 }), 50);
 * const obj = pool.acquire();
 * // ... use obj ...
 * pool.release(obj);
 * ```
 */

/**
 * Fixed-size buffer — evicts oldest items when full.
 */
export class BufferPool<T> {
  private buffer: T[];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.buffer = [];
  }

  /** Add an item — evicts oldest if full */
  push(item: T): T | undefined {
    let evicted: T | undefined;
    if (this.buffer.length >= this.maxSize) {
      evicted = this.buffer.shift();
    }
    this.buffer.push(item);
    return evicted;
  }

  /** Get all items and clear the buffer */
  drain(): T[] {
    const items = this.buffer;
    this.buffer = [];
    return items;
  }

  /** Peek at items without removing */
  peek(count?: number): T[] {
    return count ? this.buffer.slice(0, count) : [...this.buffer];
  }

  /** Current size */
  get size(): number {
    return this.buffer.length;
  }

  /** Whether buffer is full */
  get isFull(): boolean {
    return this.buffer.length >= this.maxSize;
  }

  /** Clear all items */
  clear(): void {
    this.buffer = [];
  }
}

/**
 * Ring buffer — circular buffer with pre-allocated memory.
 * Never allocates after construction.
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private count = 0;
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /** Add an item — overwrites oldest if full */
  push(item: T): T | undefined {
    let evicted: T | undefined;

    if (this.count === this.capacity) {
      evicted = this.buffer[this.head] as T;
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.count++;
    }

    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    return evicted;
  }

  /** Get all items in order */
  getAll(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      result.push(this.buffer[idx] as T);
    }
    return result;
  }

  /** Current size */
  get size(): number {
    return this.count;
  }

  /** Whether buffer is full */
  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /** Whether buffer is empty */
  get isEmpty(): boolean {
    return this.count === 0;
  }

  /** Clear all items (doesn't deallocate) */
  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}

/**
 * Object pool — reuse objects instead of allocating.
 */
export class ObjectPool<T> {
  private factory: () => T;
  private pool: T[];
  private maxSize: number;

  constructor(factory: () => T, maxSize: number, initialSize = 0) {
    this.factory = factory;
    this.maxSize = maxSize;
    this.pool = [];

    // Pre-allocate initial objects
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(factory());
    }
  }

  /** Acquire an object from the pool (or create new if empty) */
  acquire(): T {
    return this.pool.pop() ?? this.factory();
  }

  /** Release an object back to the pool */
  release(obj: T): void {
    if (this.pool.length < this.maxSize) {
      this.pool.push(obj);
    }
    // Otherwise discard — pool is full
  }

  /** Current pool size (available objects) */
  get size(): number {
    return this.pool.length;
  }

  /** Clear all pooled objects */
  clear(): void {
    this.pool = [];
  }
}

/**
 * Lazy string builder — avoids intermediate string allocations.
 */
export class LazyStringBuilder {
  private parts: string[] = [];

  append(str: string): this {
    this.parts.push(str);
    return this;
  }

  appendLine(str: string): this {
    this.parts.push(str + '\n');
    return this;
  }

  toString(): string {
    return this.parts.join('');
  }

  clear(): void {
    this.parts = [];
  }

  get length(): number {
    return this.parts.reduce((sum, p) => sum + p.length, 0);
  }
}

/**
 * Zero-copy buffer transfer — transfers ownership without copying.
 */
export function transferBuffer(buf: Buffer): { buffer: Buffer; release: () => Buffer } {
  let released = false;

  return {
    buffer: buf,
    release: () => {
      if (released) throw new Error('Buffer already released');
      released = true;
      return buf;
    },
  };
}
