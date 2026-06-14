/**
 * Optimization tests — Storage, Database, State & Config, WAVE 2 (IDs 701-800).
 *
 * Second batch, disjoint from `08-storage.test.ts` (wave 1 covered
 * #701/#702/#705/#711-#713/#717-#719/#721/#770/#771). Unit-only: no real DB or
 * network — Prisma/pg/S3 are never touched; filesystem tests stay in os.tmpdir().
 *
 * Covered findings:
 *   - db-batch: #728 batchUpsert retry, #729 exponential backoff+jitter,
 *               #734 aggregate-side stats, #735 diffState deep-compare
 *   - connection-pool: #738 honest getStats(null), #742 singleton config + reset
 *   - in-memory adapter: #757 rpush cap, #759 hash field cap, #760 hincrby TTL,
 *               #761 scan batched callback
 *   - redis adapter: #765 scan COUNT scales toward limit
 *   - metrics-state: #768 bounded cardinality maps
 *   - object-storage: #749 listAll auto-paginate, #750 deleteMany batching
 *   - backup-scheduler: #800 scheduled vs inProgress
 *   - pg-driver: #733 transient-disconnect classification
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── db-batch #729 — exponential backoff with jitter ──────────────────────────

describe('db-batch backoffDelayMs (#729)', () => {
  it('is bounded by an exponentially growing cap per attempt', async () => {
    const { backoffDelayMs } = await import('../../src/db-batch/index');
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    try {
      // base=100 → caps are 100, 200, 400 for attempts 1,2,3 (full jitter ⇒ < cap)
      expect(backoffDelayMs(1, 100)).toBeLessThan(100);
      expect(backoffDelayMs(2, 100)).toBeLessThan(200);
      expect(backoffDelayMs(2, 100)).toBeGreaterThanOrEqual(100); // doubled vs attempt 1
      expect(backoffDelayMs(3, 100)).toBeLessThan(400);
    } finally {
      spy.mockRestore();
    }
  });

  it('applies full jitter (random=0 → 0 delay) and honors the cap', async () => {
    const { backoffDelayMs } = await import('../../src/db-batch/index');
    const zero = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(backoffDelayMs(5, 100)).toBe(0);
    } finally {
      zero.mockRestore();
    }
    const hi = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    try {
      // attempt 100 would be astronomically large without the cap; capped at 1000.
      expect(backoffDelayMs(100, 100, 1000)).toBeLessThan(1000);
    } finally {
      hi.mockRestore();
    }
  });
});

// ── db-batch #728 — batchUpsert retry/backoff parity with batchInsert ─────────

describe('db-batch batchUpsert retry (#728)', () => {
  it('retries a transient failure and succeeds (retryDelayMs:0 keeps it fast)', async () => {
    const { batchUpsert } = await import('../../src/db-batch/index');
    let calls = 0;
    const upsertFn = vi.fn(async (batch: number[]) => {
      calls++;
      if (calls === 1) throw new Error('transient neon error');
      return batch.map((n) => ({ n }));
    });
    const out = await batchUpsert(upsertFn, [1, 2], { batchSize: 10, retryDelayMs: 0, maxRetries: 3 });
    expect(calls).toBe(2);
    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('throws after exhausting maxRetries', async () => {
    const { batchUpsert } = await import('../../src/db-batch/index');
    const upsertFn = vi.fn(async () => { throw new Error('always fails'); });
    await expect(
      batchUpsert(upsertFn, [1], { batchSize: 10, retryDelayMs: 0, maxRetries: 2 }),
    ).rejects.toThrow('always fails');
    expect(upsertFn).toHaveBeenCalledTimes(2);
  });
});

// ── db-batch #735 — diffState deep / structural compare ───────────────────────

describe('db-batch diffState deep compare (#735)', () => {
  it('does NOT report deep-equal object/array fields as changed', async () => {
    const { diffState } = await import('../../src/db-batch/index');
    const oldS = { a: 1, nested: { x: [1, 2] }, list: [{ k: 'v' }] };
    const newS = { a: 1, nested: { x: [1, 2] }, list: [{ k: 'v' }] };
    expect(diffState(oldS, newS)).toEqual({});
  });

  it('reports only the fields that actually differ', async () => {
    const { diffState } = await import('../../src/db-batch/index');
    const oldS = { a: 1, nested: { x: 1 }, same: 'keep' };
    const newS = { a: 2, nested: { x: 2 }, same: 'keep' };
    expect(diffState(oldS, newS)).toEqual({ a: 2, nested: { x: 2 } });
  });

  it('valuesEqual: scalars via Object.is (NaN-safe), objects structurally', async () => {
    const { valuesEqual } = await import('../../src/db-batch/index');
    expect(valuesEqual(NaN, NaN)).toBe(true);
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual(1, 2)).toBe(false);
    expect(valuesEqual({ a: [1] }, { a: [1] })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(valuesEqual(null, {})).toBe(false);
  });
});

// ── db-batch #734 — aggregate-side stats helper ───────────────────────────────

describe('db-batch computeStatsAggregated (#734)', () => {
  it('runs ONE aggregate call instead of scanning rows', async () => {
    const { computeStatsAggregated } = await import('../../src/db-batch/index');
    const aggregateFn = vi.fn(async () => ({ _count: 42, _avg: { medianMs: 37.5 } }));
    const out = await computeStatsAggregated(aggregateFn, (a) => ({ total: a._count, avg: a._avg.medianMs }));
    expect(aggregateFn).toHaveBeenCalledOnce();
    expect(out).toEqual({ total: 42, avg: 37.5 });
  });
});

// ── connection-pool #738 / #742 ───────────────────────────────────────────────

describe('connection-pool getStats honesty + singleton (#738/#742)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('getStats() returns null instead of fabricated pool numbers (#738)', async () => {
    const { createConnectionPool } = await import('../../src/connection-pool/index');
    const pool = createConnectionPool({ maxConnections: 7 });
    expect(pool.getStats()).toBeNull();
    // The config is still introspectable for diagnostics.
    expect(pool.getConfig().maxConnections).toBe(7);
  });

  it('getGlobalPool keeps the first config; resetGlobalPool rebuilds (#742)', async () => {
    const mod = await import('../../src/connection-pool/index');
    await mod.closeGlobalPool();
    const a = mod.getGlobalPool({ maxConnections: 5 });
    const b = mod.getGlobalPool({ maxConnections: 99 }); // ignored — same singleton
    expect(b).toBe(a);
    expect(b.getConfig().maxConnections).toBe(5);
    const c = await mod.resetGlobalPool({ maxConnections: 99 });
    expect(c).not.toBe(a);
    expect(c.getConfig().maxConnections).toBe(99);
    await mod.closeGlobalPool();
  });
});

// ── in-memory adapter #757 / #759 / #760 / #761 ───────────────────────────────

describe('InMemoryStateAdapter caps & TTL (#757/#759/#760/#761)', () => {
  // Helper to reach into the private cap without depending on the 100k default.
  async function makeAdapter() {
    const { InMemoryStateAdapter } = await import('../../src/platform/adapters/in-memory-state');
    return new InMemoryStateAdapter();
  }

  it('#757 rpush enforces a hard max length (drops oldest, keeps newest)', async () => {
    const a: any = await makeAdapter();
    // Shrink the cap so the test is fast and deterministic.
    a.MAX_LIST_LEN = 3;
    for (let i = 0; i < 6; i++) await a.rpush('k', String(i));
    const all = await a.lrange('k', 0, -1);
    expect(all).toEqual(['3', '4', '5']); // oldest 0,1,2 evicted
  });

  it('#759 hset rejects NEW fields past the cap but allows updates to existing', async () => {
    const a: any = await makeAdapter();
    a.MAX_HASH_FIELDS = 2;
    await a.hset('h', 'f1', 'a');
    await a.hset('h', 'f2', 'b');
    await expect(a.hset('h', 'f3', 'c')).rejects.toThrow(/MAX_HASH_FIELDS/);
    // Updating an existing field is always fine.
    await a.hset('h', 'f1', 'updated');
    const all = await a.hgetall('h');
    expect(all).toEqual({ f1: 'updated', f2: 'b' });
  });

  it('#760 hincrby honors a TTL so counters can expire', async () => {
    const a: any = await makeAdapter();
    await a.hincrby('c', 'n', 5, 100); // 100s TTL
    expect(a.hashExpiry.has('c')).toBe(true);
    const exp = a.hashExpiry.get('c');
    expect(exp).toBeGreaterThan(Date.now());
    // Simulate expiry — hgetall must sweep it.
    a.hashExpiry.set('c', Date.now() - 1);
    expect(await a.hgetall('c')).toEqual({});
  });

  it('#760 hincrby without TTL leaves the counter immortal (no expiry set)', async () => {
    const a: any = await makeAdapter();
    await a.hincrby('c', 'n', 1);
    expect(a.hashExpiry.has('c')).toBe(false);
  });

  it('#761 scan invokes the callback in batches and supports early stop', async () => {
    const a = await makeAdapter();
    for (let i = 0; i < 250; i++) await a.set(`pre:${i}`, 'v');
    const batches: number[] = [];
    const total = await a.scan('pre:*', (keys) => { batches.push(keys.length); }, 1000);
    expect(total).toBe(250);
    // More than one batch (BATCH=100) ⇒ streamed, not one giant array.
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.reduce((s, n) => s + n, 0)).toBe(250);

    // Early termination: returning false after the first batch stops iteration.
    let seen = 0;
    const stopped = await a.scan('pre:*', () => { seen++; return false; }, 1000);
    expect(seen).toBe(1);
    expect(stopped).toBeLessThanOrEqual(250);
  });
});

// ── redis adapter #765 — scan COUNT scales toward limit ───────────────────────

describe('RedisStateAdapter scan COUNT (#765)', () => {
  it('passes a COUNT larger than the old flat 100 cap', async () => {
    const { RedisStateAdapter } = await import('../../src/platform/adapters/redis-state');
    const counts: number[] = [];
    const fakeRedis: any = {
      scan: vi.fn(async (_cursor: string, _m: string, _p: string, _c: string, count: number) => {
        counts.push(count);
        return ['0', ['a', 'b']]; // single page, cursor back to 0
      }),
    };
    const store = new RedisStateAdapter(fakeRedis);
    await store.scan('pre:*', undefined, 5000);
    // Old code clamped to 100; now it should request up to the 1000 cap.
    expect(counts[0]).toBeGreaterThan(100);
    expect(counts[0]).toBeLessThanOrEqual(1000);
  });
});

// ── metrics-state #768 — bounded cardinality maps ─────────────────────────────

describe('metrics-state incrMetricCounter bound (#768)', () => {
  it('increments existing keys and counts normally below the cap', async () => {
    const { incrMetricCounter } = await import('../../src/gateway/state/metrics-state');
    const map: Record<string, number> = {};
    expect(incrMetricCounter(map, 'groq')).toBe('groq');
    incrMetricCounter(map, 'groq', 2);
    expect(map.groq).toBe(3);
  });

  it('folds NEW keys past MAX_METRIC_KEYS into __other__ instead of growing', async () => {
    const mod = await import('../../src/gateway/state/metrics-state');
    const map: Record<string, number> = {};
    for (let i = 0; i < mod.MAX_METRIC_KEYS; i++) mod.incrMetricCounter(map, `p${i}`);
    expect(Object.keys(map).length).toBe(mod.MAX_METRIC_KEYS);
    // One more distinct key must not grow the map — it lands in __other__.
    const bucket = mod.incrMetricCounter(map, 'attacker-supplied-name');
    expect(bucket).toBe('__other__');
    expect(map.__other__).toBe(1);
    expect(Object.keys(map).length).toBe(mod.MAX_METRIC_KEYS + 1); // only the __other__ bucket
    // An already-tracked key still increments even when full.
    mod.incrMetricCounter(map, 'p0', 5);
    expect(map.p0).toBe(6);
  });

  it('maps empty key to a stable __unknown__ bucket', async () => {
    const { incrMetricCounter } = await import('../../src/gateway/state/metrics-state');
    const map: Record<string, number> = {};
    expect(incrMetricCounter(map, '')).toBe('__unknown__');
    expect(map.__unknown__).toBe(1);
  });
});

// ── object-storage #749 — listAll auto-pagination ─────────────────────────────

describe('object-storage listAllVia auto-pagination (#749)', () => {
  it('follows nextContinuationToken across pages and yields every entry', async () => {
    const { listAllVia } = await import('../../src/storage/s3-store');
    const pages = [
      { entries: [{ key: 'a', size: 1 }, { key: 'b', size: 1 }], nextContinuationToken: 't1' },
      { entries: [{ key: 'c', size: 1 }], nextContinuationToken: 't2' },
      { entries: [{ key: 'd', size: 1 }] }, // last page, no token
    ];
    let call = 0;
    const listFn = vi.fn(async () => pages[call++]);
    const keys: string[] = [];
    for await (const e of listAllVia(listFn as any, 'pre/')) keys.push(e.key);
    expect(keys).toEqual(['a', 'b', 'c', 'd']);
    expect(listFn).toHaveBeenCalledTimes(3);
  });

  it('stops if the backend returns the same token forever (no infinite loop)', async () => {
    const { listAllVia } = await import('../../src/storage/s3-store');
    const listFn = vi.fn(async () => ({ entries: [{ key: 'x', size: 1 }], nextContinuationToken: 'stuck' }));
    const keys: string[] = [];
    for await (const e of listAllVia(listFn as any)) keys.push(e.key);
    // First page yields, second sees the repeated token and bails.
    expect(keys).toEqual(['x', 'x']);
    expect(listFn).toHaveBeenCalledTimes(2);
  });
});

// ── object-storage #750 — deleteMany batching ─────────────────────────────────

describe('object-storage createS3Store deleteMany (#750)', () => {
  // Stub Bun.S3Client so no network/SDK is touched.
  let savedS3: unknown;
  beforeEach(() => {
    savedS3 = (globalThis as any).Bun?.S3Client;
  });
  afterEach(() => {
    if ((globalThis as any).Bun) (globalThis as any).Bun.S3Client = savedS3;
  });

  function installFakeBun(deleteImpl: (k: unknown) => Promise<void>) {
    const g = globalThis as any;
    g.Bun = g.Bun ?? {};
    g.Bun.S3Client = class {
      constructor(_cfg: unknown) {}
      delete = deleteImpl;
      write = async () => {};
      file() { return { arrayBuffer: async () => new ArrayBuffer(0), stream: () => null }; }
      stat = async () => ({ size: 0 });
      presign() { return 'x'; }
      list = async () => ({ contents: [] });
    };
  }

  it('uses a single batch delete call per ≤1000-key chunk', async () => {
    const seen: unknown[] = [];
    installFakeBun(async (k) => { seen.push(k); });
    const { createS3Store } = await import('../../src/storage/s3-store');
    const store = createS3Store({
      bucket: 'b', endpoint: 'https://e', accessKeyId: 'a', secretAccessKey: 's',
    });
    await store.deleteMany!(['k1', 'k2', 'k3']);
    // One batch call carrying the whole array (chunk ≤ 1000).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(['k1', 'k2', 'k3']);
  });

  it('is a no-op for an empty key list', async () => {
    const seen: unknown[] = [];
    installFakeBun(async (k) => { seen.push(k); });
    const { createS3Store } = await import('../../src/storage/s3-store');
    const store = createS3Store({
      bucket: 'b', endpoint: 'https://e', accessKeyId: 'a', secretAccessKey: 's',
    });
    await store.deleteMany!([]);
    expect(seen).toHaveLength(0);
  });

  it('splits >1000 keys into multiple batch calls', async () => {
    const calls: number[] = [];
    installFakeBun(async (k) => { calls.push((k as string[]).length); });
    const { createS3Store } = await import('../../src/storage/s3-store');
    const store = createS3Store({
      bucket: 'b', endpoint: 'https://e', accessKeyId: 'a', secretAccessKey: 's',
    });
    const keys = Array.from({ length: 1500 }, (_, i) => `k${i}`);
    await store.deleteMany!(keys);
    expect(calls).toEqual([1000, 500]);
  });
});

// ── backup-scheduler #800 — scheduled vs inProgress ───────────────────────────

describe('backup-scheduler getStatus (#800)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'opt08-bkp-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reports scheduled=false / inProgress=false when idle', async () => {
    const { createBackupScheduler } = await import('../../src/backup-scheduler/index');
    const s = createBackupScheduler({ backupDir: dir, intervalHours: 24 });
    const st = s.getStatus();
    expect(st.scheduled).toBe(false);
    expect(st.inProgress).toBe(false);
    expect(st.running).toBe(false);
  });

  it('reports scheduled=true after start(), and running stays the OR', async () => {
    const { createBackupScheduler } = await import('../../src/backup-scheduler/index');
    // No backupPaths exist under the fresh temp dir, so the initial runBackup
    // finishes immediately with "no files" — inProgress returns to false.
    const s = createBackupScheduler({ backupDir: dir, intervalHours: 24, backupPaths: [join(dir, 'nope')] });
    s.start();
    const st = s.getStatus();
    expect(st.scheduled).toBe(true);
    expect(st.running).toBe(true); // OR(scheduled, inProgress)
    s.stop();
    expect(s.getStatus().scheduled).toBe(false);
  });
});

// ── pg-driver #733 — transient disconnect classification ──────────────────────

describe('pg-driver isTransientDisconnect (#733)', () => {
  it('classifies connection-level errors as transient (recoverable by reconnect)', async () => {
    const { isTransientDisconnect } = await import('../../src/database/pg-driver');
    for (const code of ['ECONNRESET', 'ENOTCONN', 'ECONNREFUSED', 'EPIPE']) {
      expect(isTransientDisconnect(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it('does NOT treat query/syntax errors as transient', async () => {
    const { isTransientDisconnect } = await import('../../src/database/pg-driver');
    expect(isTransientDisconnect(Object.assign(new Error('syntax'), { code: '42601' }))).toBe(false);
    expect(isTransientDisconnect(new Error('plain'))).toBe(false);
    expect(isTransientDisconnect(undefined)).toBe(false);
  });
});
