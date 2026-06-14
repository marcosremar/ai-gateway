/**
 * Optimization tests — Storage, Database, State & Config, WAVE 3 (IDs 701-800).
 *
 * Third batch, disjoint from waves 1-2. Unit-only: no real DB, network, or S3 —
 * Prisma/pg/Bun.S3Client are mocked; all filesystem access is confined to
 * os.tmpdir(). Relative imports throughout.
 *
 * Covered findings:
 *   - db-batch:        #723 buildPruneKeepNewest (single-delete prune)
 *   - prisma-init:     #736 buildPgPoolOptions bounds from env
 *   - object-storage:  #747 getRange ranged GET, #751 copy server-side,
 *                      #753 broadened isS3NotFound, #755 withS3Retry/isRetryableS3Error
 *   - redis adapter:   #762 hgetall via HSCAN+parseHscanReply, #763 hincrby TTL parity
 *   - state deps:      #766 PartialStateStore + hasListOps/hasHashOps,
 *                      #767 lrange maxElements guard (InMemory + Redis)
 *   - in-memory:       #758 periodic timer sweep
 *   - config-persist:  #714 stamp Set of pending app ids, #776 schema version
 *   - app-registry:    #706 atomic seed/save, #707 .bak recovery
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── db-batch #723 — single-delete "keep newest N" prune ───────────────────────

describe('db-batch buildPruneKeepNewest (#723)', () => {
  it('returns a single `id < cutoff` delete clause when over the keep count', async () => {
    const { buildPruneKeepNewest } = await import('../../src/db-batch/index');
    // ids newest→oldest: keep 2 newest (100, 90); cutoff is 90, delete id < 90.
    const out = buildPruneKeepNewest([100, 90, 80, 70], 2);
    expect(out).toEqual({ where: { id: { lt: 90 } } });
  });

  it('returns null (nothing to prune) when rows ≤ keepNewest', async () => {
    const { buildPruneKeepNewest } = await import('../../src/db-batch/index');
    expect(buildPruneKeepNewest([5, 4], 2)).toBeNull();
    expect(buildPruneKeepNewest([], 10)).toBeNull();
  });

  it('honors a custom id field name', async () => {
    const { buildPruneKeepNewest } = await import('../../src/db-batch/index');
    expect(buildPruneKeepNewest([3, 2, 1], 1, 'historyId')).toEqual({ where: { historyId: { lt: 3 } } });
  });
});

// ── prisma-init #736 — pool bounds from env ───────────────────────────────────

describe('prisma-init buildPgPoolOptions (#736)', () => {
  it('applies safe defaults (max/idle/lifetime/connect) with no env', async () => {
    const { buildPgPoolOptions } = await import('../../server/prisma-init');
    const o = buildPgPoolOptions('postgres://x', {});
    expect(o.connectionString).toBe('postgres://x');
    expect(o.max).toBe(10);
    expect(o.idleTimeoutMillis).toBe(30_000);
    expect(o.maxLifetimeSeconds).toBe(1_800);
    expect(o.connectionTimeoutMillis).toBe(10_000);
  });

  it('reads overrides from env and clamps max to 1..100', async () => {
    const { buildPgPoolOptions } = await import('../../server/prisma-init');
    const o = buildPgPoolOptions('c', { DB_POOL_MAX: '999', DB_POOL_IDLE_TIMEOUT_MS: '5000' });
    expect(o.max).toBe(100); // clamped
    expect(o.idleTimeoutMillis).toBe(5000);
  });

  it('falls back to default on a non-numeric / non-positive value (never NaN)', async () => {
    const { buildPgPoolOptions } = await import('../../server/prisma-init');
    const o = buildPgPoolOptions('c', { DB_POOL_MAX: 'abc', DB_POOL_MAX_LIFETIME_S: '-5' });
    expect(o.max).toBe(10);
    expect(o.maxLifetimeSeconds).toBe(1_800);
    expect(Number.isNaN(o.idleTimeoutMillis)).toBe(false);
  });
});

// ── object-storage #753 / #755 — classification + retry (pure) ────────────────

describe('object-storage isS3NotFound / isRetryableS3Error (#753/#755)', () => {
  it('#753 treats 404 and any non-403 4xx + known codes as not-found', async () => {
    const { isS3NotFound } = await import('../../src/storage/s3-store');
    expect(isS3NotFound({ statusCode: 404 })).toBe(true);
    expect(isS3NotFound({ status: 410 })).toBe(true);          // B2-style gone
    expect(isS3NotFound({ code: 'NoSuchKey' })).toBe(true);
    expect(isS3NotFound({ name: 'NoSuchBucket' })).toBe(true);
    // 403 is a real permission error — must NOT be swallowed as missing.
    expect(isS3NotFound({ statusCode: 403 })).toBe(false);
    expect(isS3NotFound({ statusCode: 500 })).toBe(false);
    expect(isS3NotFound(undefined)).toBe(false);
  });

  it('#755 classifies 5xx / 429 / SlowDown as retryable but not 4xx', async () => {
    const { isRetryableS3Error } = await import('../../src/storage/s3-store');
    expect(isRetryableS3Error({ statusCode: 503 })).toBe(true);
    expect(isRetryableS3Error({ statusCode: 429 })).toBe(true);
    expect(isRetryableS3Error({ code: 'SlowDown' })).toBe(true);
    expect(isRetryableS3Error({ statusCode: 404 })).toBe(false);
    expect(isRetryableS3Error({ statusCode: 403 })).toBe(false);
  });

  it('#755 withS3Retry retries a transient error then succeeds (instant sleep)', async () => {
    const { withS3Retry } = await import('../../src/storage/s3-store');
    let calls = 0;
    const out = await withS3Retry(async () => {
      calls++;
      if (calls < 3) throw { statusCode: 503 };
      return 'ok';
    }, { sleep: async () => {}, baseDelayMs: 1 });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('#755 withS3Retry surfaces a non-retryable error immediately (no retries)', async () => {
    const { withS3Retry } = await import('../../src/storage/s3-store');
    let calls = 0;
    await expect(
      withS3Retry(async () => { calls++; throw { statusCode: 404 }; }, { sleep: async () => {} }),
    ).rejects.toEqual({ statusCode: 404 });
    expect(calls).toBe(1);
  });
});

// ── object-storage #747 / #751 — getRange + copy on the S3 store ──────────────

describe('object-storage createS3Store getRange/copy (#747/#751)', () => {
  let savedS3: unknown;
  beforeEach(() => { savedS3 = (globalThis as any).Bun?.S3Client; });
  afterEach(() => { if ((globalThis as any).Bun) (globalThis as any).Bun.S3Client = savedS3; });

  function installFakeBun(impl: Record<string, unknown>) {
    const g = globalThis as any;
    g.Bun = g.Bun ?? {};
    const data = Buffer.from('0123456789');
    const defaults: Record<string, unknown> = {
      file: (_k: string) => ({
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        stream: () => null,
        slice: (s: number, e?: number) => ({
          arrayBuffer: async () => {
            const sub = data.subarray(s, e);
            return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
          },
        }),
      }),
      write: async () => {},
      stat: async () => ({ size: 0 }),
      presign: () => 'x',
      list: async () => ({ contents: [] }),
      delete: async () => {},
    };
    const merged = { ...defaults, ...impl };
    g.Bun.S3Client = class {
      constructor(_cfg: unknown) {
        Object.assign(this, merged);
      }
    };
  }

  function makeStore() {
    return import('../../src/storage/s3-store').then(({ createS3Store }) =>
      createS3Store({ bucket: 'b', endpoint: 'https://e', accessKeyId: 'a', secretAccessKey: 's' }));
  }

  it('#747 getRange returns the inclusive byte range via slice', async () => {
    installFakeBun({});
    const store = await makeStore();
    const bytes = await store.getRange!('k', 2, 5); // inclusive → bytes 2,3,4,5
    expect(new TextDecoder().decode(bytes)).toBe('2345');
  });

  it('#747 getRange with no end reads from start to EOF', async () => {
    installFakeBun({});
    const store = await makeStore();
    const bytes = await store.getRange!('k', 7);
    expect(new TextDecoder().decode(bytes)).toBe('789');
  });

  it('#751 copy uses the native server-side copy when present', async () => {
    const seen: Array<[string, string]> = [];
    installFakeBun({ copy: async (s: string, d: string) => { seen.push([s, d]); } });
    const store = await makeStore();
    await store.copy!('src/a', 'dst/b');
    expect(seen).toEqual([['src/a', 'dst/b']]);
  });

  it('#751 copy falls back to GET+PUT when no native copy exists', async () => {
    const puts: Array<{ key: string; len: number }> = [];
    installFakeBun({ write: async (key: string, body: Uint8Array) => { puts.push({ key, len: body.length }); } });
    const store = await makeStore();
    await store.copy!('src', 'dst');
    expect(puts).toEqual([{ key: 'dst', len: 10 }]); // full object re-uploaded
  });
});

// ── redis adapter #762 — HSCAN-driven hgetall + parseHscanReply ───────────────

describe('RedisStateAdapter hgetall via HSCAN (#762)', () => {
  it('parseHscanReply folds a flat field/value array into an object', async () => {
    const { parseHscanReply } = await import('../../src/platform/adapters/redis-state');
    expect(parseHscanReply(['f1', 'a', 'f2', 'b'])).toEqual({ f1: 'a', f2: 'b' });
    // odd trailing element ignored (malformed reply)
    expect(parseHscanReply(['f1', 'a', 'dangling'])).toEqual({ f1: 'a' });
  });

  it('walks HSCAN across cursors and honors limit, never calling HGETALL', async () => {
    const { RedisStateAdapter } = await import('../../src/platform/adapters/redis-state');
    let hgetallCalls = 0;
    const counts: number[] = [];
    const fakeRedis: any = {
      hgetall: vi.fn(async () => { hgetallCalls++; return {}; }),
      hscan: vi.fn(async (_key: string, cursor: string, _c: string, count: number) => {
        counts.push(count);
        // two pages then cursor returns to 0
        if (cursor === '0') return ['7', ['a', '1', 'b', '2']];
        return ['0', ['c', '3']];
      }),
    };
    const store = new RedisStateAdapter(fakeRedis);
    const out = await store.hgetall('h', 100);
    expect(out).toEqual({ a: '1', b: '2', c: '3' });
    expect(hgetallCalls).toBe(0); // used HSCAN, not the whole-hash fetch
    expect(counts[0]).toBeGreaterThan(0);
  });

  it('falls back to HGETALL+slice when the client has no hscan', async () => {
    const { RedisStateAdapter } = await import('../../src/platform/adapters/redis-state');
    const fakeRedis: any = { hgetall: vi.fn(async () => ({ a: '1', b: '2', c: '3' })) };
    const store = new RedisStateAdapter(fakeRedis);
    const out = await store.hgetall('h', 2);
    expect(Object.keys(out)).toHaveLength(2); // limited
    expect(fakeRedis.hgetall).toHaveBeenCalledOnce();
  });
});

// ── redis adapter #763 — hincrby TTL parity ───────────────────────────────────

describe('RedisStateAdapter hincrby TTL (#763)', () => {
  it('refreshes the hash TTL via EXPIRE when ttlSecs is passed', async () => {
    const { RedisStateAdapter } = await import('../../src/platform/adapters/redis-state');
    const fakeRedis: any = {
      hincrby: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
    };
    const store = new RedisStateAdapter(fakeRedis);
    await store.hincrby('c', 'n', 5, 120);
    expect(fakeRedis.hincrby).toHaveBeenCalledWith('c', 'n', 5);
    expect(fakeRedis.expire).toHaveBeenCalledWith('c', 120);
  });

  it('does NOT call EXPIRE without a TTL (immortal counter)', async () => {
    const { RedisStateAdapter } = await import('../../src/platform/adapters/redis-state');
    const fakeRedis: any = { hincrby: vi.fn(async () => 1), expire: vi.fn(async () => 1) };
    const store = new RedisStateAdapter(fakeRedis);
    await store.hincrby('c', 'n', 1);
    expect(fakeRedis.expire).not.toHaveBeenCalled();
  });
});

// ── state deps #766 — partial-store capability guards ─────────────────────────

describe('deps hasListOps / hasHashOps (#766)', () => {
  it('detects a KV-only store as lacking list + hash ops', async () => {
    const { hasListOps, hasHashOps } = await import('../../src/platform/deps');
    const kvOnly: any = { get: async () => null, set: async () => {}, del: async () => {}, scan: async () => 0 };
    expect(hasListOps(kvOnly)).toBe(false);
    expect(hasHashOps(kvOnly)).toBe(false);
  });

  it('detects a full InMemory adapter as having both list + hash ops', async () => {
    const { InMemoryStateAdapter } = await import('../../src/platform/adapters/in-memory-state');
    const { hasListOps, hasHashOps } = await import('../../src/platform/deps');
    const store = new InMemoryStateAdapter() as any;
    expect(hasListOps(store)).toBe(true);
    expect(hasHashOps(store)).toBe(true);
  });
});

// ── adapters #767 — lrange maxElements guard ──────────────────────────────────

describe('lrange maxElements guard (#767)', () => {
  it('InMemory: throws when the returned range exceeds maxElements', async () => {
    const { InMemoryStateAdapter } = await import('../../src/platform/adapters/in-memory-state');
    const a = new InMemoryStateAdapter();
    for (let i = 0; i < 5; i++) await a.rpush('k', String(i));
    await expect(a.lrange('k', 0, -1, 3)).rejects.toThrow(/maxElements/);
    // Under the cap is fine.
    expect(await a.lrange('k', 0, 1, 3)).toEqual(['0', '1']);
    // No guard passed → unbounded (back-compat).
    expect(await a.lrange('k', 0, -1)).toHaveLength(5);
  });

  it('Redis: throws when the reply exceeds maxElements', async () => {
    const { RedisStateAdapter } = await import('../../src/platform/adapters/redis-state');
    const fakeRedis: any = { lrange: vi.fn(async () => ['a', 'b', 'c', 'd']) };
    const store = new RedisStateAdapter(fakeRedis);
    await expect(store.lrange('k', 0, -1, 2)).rejects.toThrow(/maxElements/);
    expect(await store.lrange('k', 0, -1, 10)).toHaveLength(4);
  });
});

// ── in-memory #758 — periodic timer sweep ─────────────────────────────────────

describe('InMemoryStateAdapter periodic sweep (#758)', () => {
  it('evicts an expired key on a timer even without any read', async () => {
    vi.useFakeTimers();
    try {
      const { InMemoryStateAdapter } = await import('../../src/platform/adapters/in-memory-state');
      const a = new InMemoryStateAdapter() as any;
      await a.set('k', 'v', 1); // 1s TTL
      a.startPeriodicSweep(1000);
      // Advance past TTL + one sweep tick.
      vi.advanceTimersByTime(2000);
      // The key map is private — assert via the public getter (now returns null).
      expect(a.kv.has('k')).toBe(false);
      a.stopPeriodicSweep();
    } finally {
      vi.useRealTimers();
    }
  });

  it('startPeriodicSweep is idempotent and stop clears the timer', async () => {
    const { InMemoryStateAdapter } = await import('../../src/platform/adapters/in-memory-state');
    const a = new InMemoryStateAdapter() as any;
    a.startPeriodicSweep(60_000);
    const first = a._sweepTimer;
    a.startPeriodicSweep(60_000); // no-op
    expect(a._sweepTimer).toBe(first);
    a.stopPeriodicSweep();
    expect(a._sweepTimer).toBeNull();
  });
});

// ── config-persistence #714 / #776 ────────────────────────────────────────────
// Redirect ~/.babelcast writes into a tmp dir BEFORE importing the module.

describe('config-persistence stamp Set + schema version (#714/#776)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opt08w3-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('#714 accumulates EVERY app touched in the debounce window (not just the last)', async () => {
    const mod = await import('../../server/config-persistence');
    mod.stampAppRequest('app-A');
    mod.stampAppRequest('app-B'); // would have clobbered app-A before the fix
    mod.stampAppRequest('app-A'); // dedup
    expect(mod.__getPendingStampIds().sort()).toEqual(['app-A', 'app-B']);
    // Flushing clears the pending set.
    await mod.__flushStampsNow();
    expect(mod.__getPendingStampIds()).toEqual([]);
  });

  it('#776 needsConfigMigration flags legacy + unversioned, passes current version', async () => {
    const mod = await import('../../server/config-persistence');
    expect(mod.CONFIG_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(mod.needsConfigMigration({ profiles: [] })).toBe(true);          // legacy key
    expect(mod.needsConfigMigration({ activeProfileId: 'x' })).toBe(true);  // legacy key
    expect(mod.needsConfigMigration({})).toBe(true);                        // unversioned
    expect(mod.needsConfigMigration({ schemaVersion: mod.CONFIG_SCHEMA_VERSION })).toBe(false);
    expect(mod.needsConfigMigration(null)).toBe(false);
  });

  it('#776 saveProviderConfig stamps the schemaVersion onto disk', async () => {
    const mod = await import('../../server/config-persistence');
    const cfg = await mod.loadProviderConfig();
    await mod.saveProviderConfig(cfg);
    const file = join(home, '.babelcast', 'provider-config.json');
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(onDisk.schemaVersion).toBe(mod.CONFIG_SCHEMA_VERSION);
  });
});

// ── app-registry #706 / #707 — atomic write + .bak recovery ───────────────────
// AI_GATEWAY_HOME redirects the registry file into a tmp dir.

describe('app-registry atomic write + bak recovery (#706/#707)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opt08w3-reg-'));
    process.env.AI_GATEWAY_HOME = home;
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.AI_GATEWAY_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('#706 seeds the file on first load and a save keeps a .bak of the prior good file', async () => {
    const mod = await import('../../server/app-registry');
    const file = join(home, 'apps.json');
    const bak = file + '.bak';
    // First load seeds.
    expect(mod.listImages().length).toBeGreaterThan(0);
    expect(existsSync(file)).toBe(true);
    // A registration triggers saveToDisk → should snapshot the prior file to .bak.
    await mod.registerImage({ name: 'unit-test-app', image: 'acme/unit-test-app' });
    expect(existsSync(bak)).toBe(true);
    expect(mod.getImage('unit-test-app')?.image).toBe('acme/unit-test-app');
  });

  it('#707 recovers from .bak when the primary file is corrupted', async () => {
    const mod = await import('../../server/app-registry');
    const file = join(home, 'apps.json');
    const bak = file + '.bak';
    // Establish a good .bak by writing then registering (which snapshots to .bak).
    mod.listImages();
    await mod.registerImage({ name: 'keepme', image: 'acme/keepme' });
    expect(existsSync(bak)).toBe(true);
    // Corrupt the primary; the .bak still holds a valid registry WITHOUT keepme?
    // The .bak is the file *before* the keepme save, so it holds the seed only.
    // To assert recovery of operator data, write a known-good primary, snapshot
    // it to .bak via another save, then corrupt primary.
    await mod.registerImage({ name: 'survivor', image: 'acme/survivor' }); // .bak now has keepme+seed
    writeFileSync(file, '{ this is not valid json');
    mod.reloadRegistry(); // force re-read from disk
    const names = mod.listImages().map((e) => e.name);
    // Recovered from .bak → keepme present (it was in the file snapshotted to .bak).
    expect(names).toContain('keepme');
  });

  it('#707 falls back to seed when both primary and .bak are corrupt', async () => {
    const mod = await import('../../server/app-registry');
    const file = join(home, 'apps.json');
    mod.listImages(); // seed
    writeFileSync(file, 'garbage');
    writeFileSync(file + '.bak', 'also garbage');
    mod.reloadRegistry();
    const names = mod.listImages().map((e) => e.name);
    expect(names).toContain('babelcast-subtitle'); // seed entry present
  });
});
