/**
 * Request Batcher — collects requests within a time window and flushes
 * them as a batch for better GPU utilization.
 *
 * Under low load (single request): flushes immediately (0ms wait).
 * Under high load: waits up to maxWaitMs to accumulate a batch.
 * Adaptive: if pending count reaches maxBatchSize, flushes immediately.
 */

export interface BatcherConfig {
  /** Maximum items per batch. Default: 8 */
  maxBatchSize: number;
  /** Maximum time (ms) to wait for a full batch. Default: 50 */
  maxWaitMs: number;
  /** Scale wait time with load (more pending → wait longer, up to maxWaitMs). Default: true */
  adaptiveWindow: boolean;
}

const DEFAULT_CONFIG: BatcherConfig = {
  maxBatchSize: 8,
  maxWaitMs: 50,
  adaptiveWindow: true,
};

interface BatchItem<T> {
  data: T;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

export class RequestBatcher<T> {
  private readonly config: BatcherConfig;
  private pending: BatchItem<T>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    config: Partial<BatcherConfig>,
    private readonly flushFn: (batch: T[]) => Promise<unknown[]>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Submit an item for batching. Returns a Promise that resolves when
   * the batch containing this item is processed.
   */
  async submit(item: T): Promise<unknown> {
    if (this.destroyed) throw new Error('Batcher has been destroyed');

    return new Promise<unknown>((resolve, reject) => {
      this.pending.push({ data: item, resolve, reject, enqueuedAt: Date.now() });

      // If batch is full, flush immediately
      if (this.pending.length >= this.config.maxBatchSize) {
        this.flush();
        return;
      }

      // If this is the first item, schedule a flush
      if (this.pending.length === 1) {
        const waitMs = this.config.adaptiveWindow
          ? Math.min(this.config.maxWaitMs, this.config.maxWaitMs * (this.pending.length / this.config.maxBatchSize))
          : this.config.maxWaitMs;

        // For single items under adaptive mode, flush almost immediately
        if (waitMs <= 0) {
          this.flush();
        } else {
          this.scheduleFlush(waitMs);
        }
      }
    });
  }

  private scheduleFlush(ms: number): void {
    if (this.timer !== null) return; // already scheduled
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, ms);
  }

  /** Force an immediate flush of all pending items. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const batch = this.pending.splice(0);
    if (batch.length === 0) return;

    const data = batch.map((b) => b.data);
    // #270: guard against a flushFn that throws *synchronously* (before
    // returning a promise). Without this, the `.then/.catch` chain never runs,
    // the synchronous throw propagates out of flush() (and out of the submit()
    // executor for the triggering item), and every other pending item in the
    // batch hangs forever. Normalizing to a rejected promise rejects the whole
    // batch deterministically.
    let flushPromise: Promise<unknown[]>;
    try {
      flushPromise = Promise.resolve(this.flushFn(data));
    } catch (err) {
      flushPromise = Promise.reject(err);
    }
    flushPromise
      .then((results) => {
        for (let i = 0; i < batch.length; i++) {
          if (i < results.length) {
            batch[i].resolve(results[i]);
          } else {
            batch[i].reject(new Error('Batch result missing for this item'));
          }
        }
      })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const item of batch) {
          item.reject(error);
        }
      });
  }

  /** Get the number of pending (unbatched) items. */
  getPendingCount(): number {
    return this.pending.length;
  }

  /** Cleanup timers and reject any pending items. */
  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const remaining = this.pending.splice(0);
    for (const item of remaining) {
      item.reject(new Error('Batcher destroyed'));
    }
  }
}
