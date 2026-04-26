/**
 * Bug: ProviderSemaphores.withLimit() builds Semaphore instances per
 * provider, but the Semaphore class doesn't know which provider it
 * belongs to. When the queue fills up, acquire() throws
 * `SemaphoreFullError('unknown')` — losing the actual provider id.
 *
 * Operators see "Provider 'unknown' queue full" in logs/responses and
 * can't tell which upstream is overloaded. Fix: thread providerId from
 * withLimit into the Semaphore constructor so the error names the right
 * provider.
 */
import { describe, it, expect } from 'vitest';
import { ProviderSemaphores, SemaphoreFullError } from '../../src/gateway/proxy/middleware/semaphore';

describe('ProviderSemaphores — queue-full error names the provider', () => {
  it('SemaphoreFullError mentions the actual provider id, not "unknown"', async () => {
    // Force tiny limits so we can fill the queue deterministically.
    const sems = new ProviderSemaphores(1, 1);

    // First task takes the only slot.
    let releaseFirst!: () => void;
    const inflight = sems.withLimit('groq', () => new Promise<void>((res) => { releaseFirst = res; }));

    // Second task fills the queue (slot 1 of maxQueue=1).
    let releaseSecond!: () => void;
    const queued = sems.withLimit('groq', () => new Promise<void>((res) => { releaseSecond = res; }));

    // Third task — should throw SemaphoreFullError.
    let err: unknown;
    try {
      await sems.withLimit('groq', async () => {});
    } catch (e) { err = e; }

    expect(err).toBeInstanceOf(SemaphoreFullError);
    expect((err as Error).message).toContain('groq');
    expect((err as Error).message).not.toContain('unknown');

    // Drain: release the first task; the queued one wakes up and runs.
    releaseFirst();
    await inflight;
    // After inflight finishes, the queued task starts — let it tick then release.
    await new Promise((r) => setTimeout(r, 1));
    if (releaseSecond) releaseSecond();
    await Promise.allSettled([queued]);
  });
});
