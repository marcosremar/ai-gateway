import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueueDepthTracker, DEFAULT_QUEUE_DEPTH_CONFIG } from '@ai-gateway/autoscaler/queue-depth-tracker';
import type { KvStore, ListStore, HashStore } from '@ai-gateway/deps';

function makeStore(): KvStore & ListStore & HashStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
    del: vi.fn(async (key: string) => { data.delete(key); }),
    scan: vi.fn(async (pattern: string, callback?: (keys: string[]) => boolean | void) => {
      const prefix = pattern.replace('*', '');
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix));
      if (callback) callback(keys);
      return keys.length;
    }),
    rpush: vi.fn(async () => {}),
    ltrim: vi.fn(async () => {}),
    lrange: vi.fn(async () => []),
    hset: vi.fn(async () => {}),
    hdel: vi.fn(async () => {}),
    hgetall: vi.fn(async () => ({})),
  };
}

describe('QueueDepthTracker', () => {
  let store: ReturnType<typeof makeStore>;
  let tracker: QueueDepthTracker;

  beforeEach(() => {
    store = makeStore();
    tracker = new QueueDepthTracker(store);
  });

  it('starts at depth 0', async () => {
    expect(await tracker.getDepth(0)).toBe(0);
  });

  it('increment increases depth', async () => {
    const d1 = await tracker.increment(0);
    expect(d1).toBe(1);
    const d2 = await tracker.increment(0);
    expect(d2).toBe(2);
    expect(await tracker.getDepth(0)).toBe(2);
  });

  it('decrement decreases depth', async () => {
    await tracker.increment(0);
    await tracker.increment(0);
    await tracker.increment(0);
    const d = await tracker.decrement(0);
    expect(d).toBe(2);
  });

  it('decrement floors at 0', async () => {
    const d = await tracker.decrement(0);
    expect(d).toBe(0);
    // Double check
    const d2 = await tracker.decrement(0);
    expect(d2).toBe(0);
  });

  it('tracks tiers independently', async () => {
    await tracker.increment(0);
    await tracker.increment(0);
    await tracker.increment(1);

    expect(await tracker.getDepth(0)).toBe(2);
    expect(await tracker.getDepth(1)).toBe(1);
  });

  it('getTotalDepth sums all tiers', async () => {
    await tracker.increment(0);
    await tracker.increment(0);
    await tracker.increment(1);
    await tracker.increment(2);

    expect(await tracker.getTotalDepth()).toBe(4);
  });

  it('shouldScaleUp returns true when above threshold', async () => {
    for (let i = 0; i < 6; i++) await tracker.increment(0);
    expect(await tracker.shouldScaleUp()).toBe(true);
  });

  it('shouldScaleUp returns false when at or below threshold', async () => {
    for (let i = 0; i < 5; i++) await tracker.increment(0);
    expect(await tracker.shouldScaleUp()).toBe(false);
  });

  it('shouldReject returns true when tier queue exceeds perTierMax', async () => {
    for (let i = 0; i < 21; i++) await tracker.increment(0);
    expect(await tracker.shouldReject(0)).toBe(true);
  });

  it('shouldReject returns false when at or below perTierMax', async () => {
    for (let i = 0; i < 20; i++) await tracker.increment(0);
    expect(await tracker.shouldReject(0)).toBe(false);
  });

  it('accepts custom config for shouldScaleUp', async () => {
    await tracker.increment(0);
    await tracker.increment(0);
    await tracker.increment(0);
    expect(await tracker.shouldScaleUp({ ...DEFAULT_QUEUE_DEPTH_CONFIG, scaleUpThreshold: 2 })).toBe(true);
    expect(await tracker.shouldScaleUp({ ...DEFAULT_QUEUE_DEPTH_CONFIG, scaleUpThreshold: 5 })).toBe(false);
  });

  it('accepts custom config for shouldReject', async () => {
    for (let i = 0; i < 6; i++) await tracker.increment(0);
    expect(await tracker.shouldReject(0, { ...DEFAULT_QUEUE_DEPTH_CONFIG, perTierMax: 5 })).toBe(true);
    expect(await tracker.shouldReject(0, { ...DEFAULT_QUEUE_DEPTH_CONFIG, perTierMax: 10 })).toBe(false);
  });

  it('handles invalid stored values gracefully', async () => {
    store.data.set('queue-depth:0', 'garbage');
    expect(await tracker.getDepth(0)).toBe(0);
  });
});
