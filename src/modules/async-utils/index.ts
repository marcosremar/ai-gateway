/**
 * Async Mutex — proper locking for concurrent state mutations.
 *
 * Fixes: #001-020 (concurrency bugs), #018 (deployLock race conditions)
 *
 * @example
 * ```ts
 * const mutex = new AsyncMutex();
 *
 * await mutex.runExclusive(async () => {
 *   // Only one caller at a time
 *   await mutateSharedState();
 * });
 * ```
 */

export class AsyncMutex {
  private _lock: Promise<void> | null = null;

  /**
   * Run a function exclusively — waits for any previous call to complete.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prevLock = this._lock;
    let release!: () => void;

    this._lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Wait for previous lock holder to finish
    if (prevLock) {
      await prevLock;
    }

    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Try to acquire the lock without waiting.
   * Returns false if already locked.
   */
  async tryRunExclusive<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this._lock) {
      return null;
    }

    return this.runExclusive(fn);
  }

  /**
   * Check if mutex is currently locked.
   */
  get isLocked(): boolean {
    return this._lock !== null;
  }
}

/**
 * Async Semaphore — limits concurrent execution to N slots.
 *
 * @example
 * ```ts
 * const semaphore = new AsyncSemaphore(5); // Max 5 concurrent
 *
 * await semaphore.acquire();
 * try {
 *   await doWork();
 * } finally {
 *   semaphore.release();
 * }
 * ```
 */

export class AsyncSemaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(maxPermits: number) {
    this.permits = maxPermits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const waiter = this.queue.shift();
    if (waiter) {
      waiter();
    } else {
      this.permits++;
    }
  }

  /**
   * Run a function with semaphore acquisition.
   */
  async runWithPermit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Current number of available permits.
   */
  get availablePermits(): number {
    return this.permits;
  }

  /**
   * Number of waiters in queue.
   */
  get waiterCount(): number {
    return this.queue.length;
  }
}
