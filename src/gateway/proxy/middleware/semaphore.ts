/**
 * Per-provider concurrency semaphore.
 *
 * Limits how many requests hit a single upstream provider simultaneously.
 * Prevents cascading 429s when 100+ concurrent requests all target Groq.
 *
 * Queue is bounded to prevent memory exhaustion under sustained overload.
 */

export class SemaphoreFullError extends Error {
  constructor(provider: string) {
    super(`Provider "${provider}" queue full — try again later`);
    this.name = 'SemaphoreFullError';
  }
}

export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];
  private readonly maxQueue: number;

  constructor(private readonly max: number, maxQueue = 500) {
    this.maxQueue = maxQueue;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    if (this.queue.length >= this.maxQueue) {
      throw new SemaphoreFullError('unknown');
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.current--;
    }
  }

  get active(): number { return this.current; }
  get waiting(): number { return this.queue.length; }
}

export class ProviderSemaphores {
  private semaphores = new Map<string, Semaphore>();
  private readonly defaultMax: number;
  private readonly defaultMaxQueue: number;

  constructor(defaultMax = 150, defaultMaxQueue = 500) {
    this.defaultMax = defaultMax;
    this.defaultMaxQueue = defaultMaxQueue;
  }

  /** Run fn with concurrency limit for the given provider */
  async withLimit<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    let sem = this.semaphores.get(providerId);
    if (!sem) {
      sem = new Semaphore(this.defaultMax, this.defaultMaxQueue);
      this.semaphores.set(providerId, sem);
    }

    await sem.acquire();
    try {
      return await fn();
    } finally {
      sem.release();
    }
  }
}
