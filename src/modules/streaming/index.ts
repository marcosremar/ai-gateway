/**
 * Streaming with backpressure support for AI Gateway.
 *
 * Provides async iterable streams that properly handle backpressure
 * when streaming LLM responses, TTS audio chunks, or STT partial results.
 *
 * @example
 * ```ts
 * import { createBackpressureStream, mapStream, filterStream } from './streaming';
 *
 * const stream = createBackpressureStream(async function* () {
 *   yield 'chunk1';
 *   yield 'chunk2';
 * }, { highWaterMark: 5 });
 *
 * for await (const chunk of stream) {
 *   await processChunk(chunk);
 * }
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('streaming');

export interface BackpressureConfig {
  /** Max items in buffer before applying backpressure (default: 10) */
  highWaterMark?: number;
  /** Timeout for consumer read in ms (default: 30_000) */
  consumerTimeoutMs?: number;
  /** Called when buffer is full */
  onBackpressure?: () => void;
  /** Called when buffer is empty */
  onDrain?: () => void;
}

const DEFAULT_CONFIG: Required<BackpressureConfig> = {
  highWaterMark: 10,
  consumerTimeoutMs: 30_000,
  onBackpressure: () => {},
  onDrain: () => {},
};

/**
 * A simple async queue with backpressure support.
 */
class AsyncQueue<T> {
  private items: T[] = [];
  private resolveNext: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;

  /** Push an item, waiting if buffer is full */
  async push(item: T, maxBuffer: number): Promise<void> {
    while (this.items.length >= maxBuffer) {
      await new Promise((r) => setTimeout(r, 5));
    }
    this.items.push(item);
    this.wakeConsumer();
  }

  /** Signal completion */
  complete(): void {
    this.done = true;
    this.wakeConsumer();
  }

  /** Get next item (async iterable) */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
      } else if (this.done) {
        return;
      } else {
        const result = await this.waitForItem();
        if (result.done) return;
        yield result.value;
      }
    }
  }

  private wakeConsumer(): void {
    if (this.resolveNext && this.items.length > 0) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: this.items.shift()!, done: false });
    } else if (this.resolveNext && this.done) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  private waitForItem(): Promise<IteratorResult<T>> {
    return new Promise((resolve) => {
      this.resolveNext = resolve;
    });
  }
}

/**
 * Create a backpressure-aware async iterable stream.
 */
export function createBackpressureStream<T>(
  producer: AsyncGenerator<T, void, unknown>,
  config: BackpressureConfig = {},
): AsyncIterable<T> {
  const cfg: Required<BackpressureConfig> = { ...DEFAULT_CONFIG, ...config };
  const queue = new AsyncQueue<T>();

  // Start producer in background
  (async () => {
    try {
      for await (const item of producer) {
        await queue.push(item, cfg.highWaterMark);
      }
      queue.complete();
    } catch (error) {
      log.log({ error: error instanceof Error ? error.message : String(error) }, 'Stream producer error');
      queue.complete();
    }
  })();

  return queue;
}

/**
 * Merge multiple async iterables into one with backpressure.
 */
export async function* mergeStreams<T>(
  streams: AsyncIterable<T>[],
  config: BackpressureConfig = {},
): AsyncIterable<T> {
  const cfg: Required<BackpressureConfig> = { ...DEFAULT_CONFIG, ...config };
  const buffer: T[] = [];
  let activeStreams = streams.length;

  // Start reading from all streams into shared buffer
  const readers = streams.map(async (stream) => {
    try {
      for await (const item of stream) {
        while (buffer.length >= cfg.highWaterMark) {
          await new Promise((r) => setTimeout(r, 10));
        }
        buffer.push(item);
      }
    } catch (error) {
      log.log({ error: error instanceof Error ? error.message : String(error) }, 'Stream error');
    } finally {
      activeStreams--;
    }
  });

  // Yield items as they arrive
  while (activeStreams > 0 || buffer.length > 0) {
    while (buffer.length > 0) {
      yield buffer.shift()!;
    }
    await new Promise((r) => setTimeout(r, 5));
  }

  await Promise.all(readers);
}

/**
 * Transform an async iterable with a mapping function.
 */
export async function* mapStream<T, U>(
  stream: AsyncIterable<T>,
  fn: (item: T, index: number) => Promise<U>,
): AsyncIterable<U> {
  let index = 0;
  for await (const item of stream) {
    yield await fn(item, index++);
  }
}

/**
 * Filter an async iterable with a predicate function.
 */
export async function* filterStream<T>(
  stream: AsyncIterable<T>,
  fn: (item: T, index: number) => Promise<boolean>,
): AsyncIterable<T> {
  let index = 0;
  for await (const item of stream) {
    if (await fn(item, index++)) {
      yield item;
    }
  }
}
