/**
 * Per-provider concurrency semaphore.
 *
 * Limits how many requests hit a single upstream provider simultaneously.
 * Prevents cascading 429s when 100+ concurrent requests all target Groq.
 */

export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
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

  constructor(defaultMax = 50) {
    this.defaultMax = defaultMax;
  }

  /** Run fn with concurrency limit for the given provider */
  async withLimit<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    let sem = this.semaphores.get(providerId);
    if (!sem) {
      sem = new Semaphore(this.defaultMax);
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
