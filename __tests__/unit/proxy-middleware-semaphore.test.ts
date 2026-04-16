import { describe, it, expect } from 'vitest';
import { Semaphore, SemaphoreFullError, ProviderSemaphores } from '../src/proxy/middleware/semaphore';

describe('Semaphore', () => {
  it('allows up to max concurrent', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.active).toBe(2);
    sem.release();
    sem.release();
    expect(sem.active).toBe(0);
  });

  it('queues waiters when at capacity', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let resolved = false;
    const p = sem.acquire().then(() => { resolved = true; });
    expect(resolved).toBe(false);

    sem.release();
    await p;
    expect(resolved).toBe(true);
    sem.release();
  });

  it('throws SemaphoreFullError when queue is full', async () => {
    const sem = new Semaphore(1, 2);
    await sem.acquire();

    const p1 = sem.acquire();
    const p2 = sem.acquire();

    await expect(sem.acquire()).rejects.toThrow(SemaphoreFullError);
    sem.release();
    sem.release();
    sem.release();
  });

  it('tracks waiting count', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    sem.acquire();
    sem.acquire();
    expect(sem.waiting).toBe(2);
    sem.release();
    sem.release();
    sem.release();
  });

  it('processes queue in FIFO order', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => { order.push(1); sem.release(); });
    const p2 = sem.acquire().then(() => { order.push(2); sem.release(); });

    sem.release();
    await p1;
    await p2;
    expect(order).toEqual([1, 2]);
  });
});

describe('ProviderSemaphores', () => {
  it('limits concurrency per provider', async () => {
    const ps = new ProviderSemaphores(1);
    const order: string[] = [];

    const p1 = ps.withLimit('groq', async () => {
      order.push('groq-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('groq-end');
    });

    const p2 = ps.withLimit('groq', async () => {
      order.push('groq-start-2');
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['groq-start', 'groq-end', 'groq-start-2']);
  });

  it('different providers run independently', async () => {
    const ps = new ProviderSemaphores(1);
    const order: string[] = [];

    await Promise.all([
      ps.withLimit('groq', async () => { order.push('groq'); }),
      ps.withLimit('openai', async () => { order.push('openai'); }),
    ]);

    expect(order).toContain('groq');
    expect(order).toContain('openai');
    expect(order).toHaveLength(2);
  });

  it('returns the result from fn', async () => {
    const ps = new ProviderSemaphores(5);
    const result = await ps.withLimit('test', async () => 42);
    expect(result).toBe(42);
  });

  it('releases semaphore on error', async () => {
    const ps = new ProviderSemaphores(1);

    await expect(
      ps.withLimit('test', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    const result = await ps.withLimit('test', async () => 'ok');
    expect(result).toBe('ok');
  });
});
