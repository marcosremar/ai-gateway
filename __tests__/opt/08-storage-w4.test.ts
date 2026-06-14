/**
 * Optimization tests — Storage, Database, State & Config, WAVE 4 (IDs 701-800).
 *
 * Fourth batch, disjoint from waves 1-3. Unit-only: no real DB, network, or S3 —
 * Prisma/pg/Bun.S3Client/Neon-management are mocked; no filesystem writes outside
 * what the modules already do under a redirected HOME (none of these tests touch
 * the real FS). Relative imports throughout.
 *
 * Covered findings:
 *   - latency-db:        #722 partitionGpuTypesByLatency (single query),
 *                        #724 mapHostStatsFromRows (one scan, no 6 counts)
 *   - latency-db-migrate:#725 buildHistoryCreateManyData, #726 buildHostUpsertArgs,
 *                        #798 historyRowDeterministicId
 *   - cost-state:        #716 spendPersistDecision (max-staleness cap)
 *   - pg-driver:         #732 nameStatement (named prepared statements)
 *   - object-storage:    #748 getStreamChecked 404 signal,
 *                        #754 mergePutOptions + R2/B2 defaultPut passthrough
 *   - database/backup:   #793 selectBranchesToPrune, #795 checksum verify,
 *                        #796 buildPsqlRestoreArgs (--single-transaction)
 *   - backup-scheduler:  #789 finalBackupName honest naming,
 *                        #790 isFinalBackup excludes in-progress builds
 *   - config-persistence:#775 mergeMissingDefaultApps single-pass
 */
import { describe, it, expect } from 'vitest';

// ── latency-db #722 — partition GPU types from ONE host query ──────────────────

describe('latency-db partitionGpuTypesByLatency (#722)', () => {
  it('groups good / unknown / bad from a single pre-fetched host list', async () => {
    const { partitionGpuTypesByLatency } = await import('../../server/latency-db');
    const hosts = [
      { gpuName: 'NVIDIA GeForce RTX 4090', medianMs: 120 },
      { gpuName: 'NVIDIA GeForce RTX 4090', medianMs: 90 },  // best for 4090
      { gpuName: 'NVIDIA RTX A6000', medianMs: 800 },         // bad
      { gpuName: 'NVIDIA GeForce RTX 5090', medianMs: null }, // ignored
    ];
    const out = partitionGpuTypesByLatency(
      ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'NVIDIA L40S'],
      hosts,
      200,
    );
    expect(out.good).toEqual(['NVIDIA GeForce RTX 4090']); // best 90 ≤ 200
    expect(out.bad).toEqual(['NVIDIA RTX A6000']);          // best 800 > 200
    expect(out.unknown).toEqual(['NVIDIA L40S']);           // no host data
    expect(out.sorted).toEqual(['NVIDIA GeForce RTX 4090', 'NVIDIA L40S', 'NVIDIA RTX A6000']);
  });

  it('normalizeGpuModel strips vendor/brand prefixes', async () => {
    const { normalizeGpuModel } = await import('../../server/latency-db');
    expect(normalizeGpuModel('NVIDIA GeForce RTX 4090')).toBe('RTX 4090');
    expect(normalizeGpuModel('NVIDIA RTX A6000')).toBe('RTX A6000');
  });

  it('sortGpuTypesByLatency issues exactly ONE findMany (not one per type)', async () => {
    const mod = await import('../../server/latency-db');
    const state = await import('../../server/state');
    let findManyCalls = 0;
    const fake = {
      hostLatency: {
        findMany: async () => {
          findManyCalls++;
          return [
            { gpuName: 'NVIDIA GeForce RTX 4090', medianMs: 100 },
            { gpuName: 'NVIDIA RTX A6000', medianMs: 50 },
          ];
        },
      },
    };
    const orig = state.prisma;
    state.setPrisma(fake);
    try {
      const out = await mod.sortGpuTypesByLatency(
        ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'NVIDIA A40'],
        200,
      );
      expect(findManyCalls).toBe(1); // #722: collapsed N→1
      // A40 has no data → unknown bucket, ordered after the two good ones.
      expect(out).toContain('NVIDIA A40');
      expect(out.indexOf('NVIDIA GeForce RTX 4090')).toBeLessThan(out.indexOf('NVIDIA A40'));
    } finally {
      state.setPrisma(orig);
    }
  });
});

// ── latency-db #724 — one host scan instead of six count() queries ────────────

describe('latency-db mapHostStatsFromRows (#724)', () => {
  it('derives all six counters from a single row scan', async () => {
    const { mapHostStatsFromRows } = await import('../../server/latency-db');
    const now = 1_000_000;
    const rows = [
      { monitored: true, lastProbedAt: now - 10, stddevMs: 5, consecutiveFailures: 0 },     // recent, stable
      { monitored: true, lastProbedAt: now - 10_000_000, stddevMs: 50, consecutiveFailures: 1 }, // old, unstable
      { monitored: false, lastProbedAt: now - 5, stddevMs: null, consecutiveFailures: 5 },  // failing
    ];
    const stats = mapHostStatsFromRows(rows, 42, now - 100);
    expect(stats.totalHosts).toBe(3);
    expect(stats.monitoredHosts).toBe(2);
    expect(stats.probedInLast2h).toBe(2); // rows[0] and rows[2] within cutoff
    expect(stats.unstable).toBe(1);       // rows[1] (stddev 50 > 20, failures < 3)
    expect(stats.failing).toBe(1);        // rows[2] (failures >= 3)
    expect(stats.historyRows).toBe(42);
  });

  it('getLatencyDbStats does ONE findMany + ONE count (not 6 counts)', async () => {
    const mod = await import('../../server/latency-db');
    const state = await import('../../server/state');
    let counts = 0;
    let finds = 0;
    const fake = {
      hostLatency: {
        findMany: async () => { finds++; return []; },
        count: async () => { counts++; return 0; },
      },
      hostLatencyHistory: { count: async () => { counts++; return 7; } },
    };
    const orig = state.prisma;
    state.setPrisma(fake);
    try {
      const stats = await mod.getLatencyDbStats();
      expect(finds).toBe(1);
      expect(counts).toBe(1); // only the history count remains
      expect(stats.historyRows).toBe(7);
    } finally {
      state.setPrisma(orig);
    }
  });
});

// ── latency-db-migrate #725/#726/#798 — pure batch builders ───────────────────

describe('latency-db-migrate batch builders (#725/#726/#798)', () => {
  const hostRow = {
    host_id: 'h1', host_ip: '1.2.3.4', provider: 'vast', gpu_name: 'RTX 4090',
    geolocation: 'EU', price_usd: 0.3, direct_port: 8000, median_ms: 100, p90_ms: 150,
    stddev_ms: 10, success_rate: 0.99, last_probed_at: 1700, probe_count: 5,
    consecutive_failures: 0, monitored: 1,
  };

  it('#726 buildHostUpsertArgs builds where/update/create with bigint timestamp', async () => {
    const { buildHostUpsertArgs } = await import('../../server/latency-db-migrate');
    const args = buildHostUpsertArgs(hostRow as any);
    expect(args.where).toEqual({ hostId: 'h1' });
    expect((args.create as any).hostId).toBe('h1');
    expect((args.update as any).monitored).toBe(true);
    expect(typeof (args.create as any).lastProbedAt).toBe('bigint');
    expect((args.create as any).lastProbedAt).toBe(BigInt(1700));
    // create and update share the same field values (minus the hostId key on update)
    expect((args.update as any).gpuName).toBe('RTX 4090');
  });

  it('#798 historyRowDeterministicId combines host + probe time', async () => {
    const { historyRowDeterministicId } = await import('../../server/latency-db-migrate');
    expect(historyRowDeterministicId({ host_id: 'h1', probed_at: 1700 })).toBe('h1:1700');
    // deterministic — same input, same id (idempotent re-runs)
    expect(historyRowDeterministicId({ host_id: 'h1', probed_at: 1700 }))
      .toBe(historyRowDeterministicId({ host_id: 'h1', probed_at: 1700 }));
  });

  it('#725 buildHistoryCreateManyData skips unmigrated hosts and tags a dedupe id', async () => {
    const { buildHistoryCreateManyData } = await import('../../server/latency-db-migrate');
    const history = [
      { id: 1, host_id: 'h1', probed_at: 1700, median_ms: 100, p90_ms: 150, samples: 3 },
      { id: 2, host_id: 'ghost', probed_at: 1701, median_ms: 90, p90_ms: 140, samples: 2 },
    ];
    const out = buildHistoryCreateManyData(history as any, new Set(['h1']));
    expect(out).toHaveLength(1); // ghost host filtered out
    expect(out[0].hostId).toBe('h1');
    expect(out[0].probedAt).toBe(BigInt(1700));
    expect(out[0].dedupeId).toBe('h1:1700');
  });
});

// ── cost-state #716 — max-staleness cap on the spend persist debounce ─────────

describe('cost-state spendPersistDecision (#716)', () => {
  it('flushes immediately when the on-disk value is older than the cap', async () => {
    const { spendPersistDecision, MAX_SPEND_STALENESS_MS } = await import('../../src/gateway/state/cost-state');
    const now = 1_000_000;
    // last persisted MAX+1 ms ago → must flush now even though a timer is pending.
    expect(spendPersistDecision(now, now - (MAX_SPEND_STALENESS_MS + 1), true)).toBe('flush-now');
    expect(spendPersistDecision(now, now - (MAX_SPEND_STALENESS_MS + 1), false)).toBe('flush-now');
  });

  it('coalesces into the existing timer when fresh and one is pending', async () => {
    const { spendPersistDecision } = await import('../../src/gateway/state/cost-state');
    const now = 1_000_000;
    expect(spendPersistDecision(now, now - 1000, true)).toBe('already-scheduled');
  });

  it('arms a fresh trailing debounce when fresh and none pending', async () => {
    const { spendPersistDecision } = await import('../../src/gateway/state/cost-state');
    const now = 1_000_000;
    expect(spendPersistDecision(now, now - 1000, false)).toBe('scheduled');
  });
});

// ── pg-driver #732 — named (prepared) statement derivation ────────────────────

describe('pg-driver nameStatement (#732)', () => {
  it('is deterministic for identical SQL and a valid short pg identifier', async () => {
    const { nameStatement } = await import('../../src/database/pg-driver');
    const a = nameStatement('SELECT 1 FROM t WHERE id = $1');
    const b = nameStatement('SELECT 1 FROM t WHERE id = $1');
    expect(a).toBe(b);
    expect(a!.length).toBeLessThanOrEqual(63); // pg identifier limit
    expect(a).toMatch(/^s_[0-9a-f]+$/);
  });

  it('differs for different SQL and returns undefined for empty SQL', async () => {
    const { nameStatement } = await import('../../src/database/pg-driver');
    expect(nameStatement('SELECT 1')).not.toBe(nameStatement('SELECT 2'));
    expect(nameStatement('')).toBeUndefined();
    expect(nameStatement('   ')).toBeUndefined();
  });
});

// ── object-storage #748 — getStreamChecked signals 404 up front ───────────────

describe('object-storage getStreamChecked (#748)', () => {
  function installFakeBun(statImpl: () => Promise<unknown>) {
    const g = globalThis as any;
    g.Bun = g.Bun ?? {};
    const prev = g.Bun.S3Client;
    g.Bun.S3Client = class {
      constructor(_cfg: unknown) {}
      stat = statImpl;
      file(_k: string) { return { stream: () => 'STREAM' as unknown as ReadableStream<Uint8Array> }; }
      write = async () => {};
      list = async () => ({ contents: [] });
      delete = async () => {};
      presign = () => 'x';
    };
    return () => { g.Bun.S3Client = prev; };
  }

  async function makeStore() {
    const { createS3Store } = await import('../../src/storage/s3-store');
    return createS3Store({ bucket: 'b', endpoint: 'https://e', accessKeyId: 'a', secretAccessKey: 's' });
  }

  it('returns null when the object is missing (404)', async () => {
    const restore = installFakeBun(async () => { throw { statusCode: 404 }; });
    try {
      const store = await makeStore();
      const out = await store.getStreamChecked!('missing');
      expect(out).toBeNull();
    } finally { restore(); }
  });

  it('returns the stream when the object exists', async () => {
    const restore = installFakeBun(async () => ({ size: 10 }));
    try {
      const store = await makeStore();
      const out = await store.getStreamChecked!('present');
      expect(out).toBe('STREAM');
    } finally { restore(); }
  });

  it('rethrows a non-404 (e.g. 403) instead of masking it as absence', async () => {
    const restore = installFakeBun(async () => { throw { statusCode: 403 }; });
    try {
      const store = await makeStore();
      await expect(store.getStreamChecked!('forbidden')).rejects.toEqual({ statusCode: 403 });
    } finally { restore(); }
  });
});

// ── object-storage #754 — default PUT options (cache/ACL) ─────────────────────

describe('object-storage default PUT options (#754)', () => {
  it('mergePutOptions: per-call wins over store defaults', async () => {
    const { mergePutOptions } = await import('../../src/storage/s3-store');
    const merged = mergePutOptions(
      { acl: 'public-read', cacheControl: 'public, max-age=31536000' },
      { contentType: 'text/plain', cacheControl: 'no-store' },
    );
    expect(merged).toEqual({
      acl: 'public-read',
      cacheControl: 'no-store',          // per-call override
      contentType: 'text/plain',
    });
  });

  it('S3 store applies defaultPut cacheControl/acl on put()', async () => {
    const g = globalThis as any;
    g.Bun = g.Bun ?? {};
    const prev = g.Bun.S3Client;
    const writes: Array<{ key: string; opts: any }> = [];
    g.Bun.S3Client = class {
      constructor(_cfg: unknown) {}
      write = async (key: string, _body: unknown, opts: unknown) => { writes.push({ key, opts }); };
      file(_k: string) { return {}; }
      stat = async () => ({ size: 0 });
      list = async () => ({ contents: [] });
      delete = async () => {};
      presign = () => 'x';
    };
    try {
      const { createS3Store } = await import('../../src/storage/s3-store');
      const store = createS3Store({
        bucket: 'b', endpoint: 'https://e', accessKeyId: 'a', secretAccessKey: 's',
        defaultPut: { acl: 'public-read', cacheControl: 'public, max-age=600' },
      });
      await store.put('k', 'data');
      expect(writes[0].opts.acl).toBe('public-read');
      expect(writes[0].opts.cacheControl).toBe('public, max-age=600');
      // Per-call override beats the default.
      await store.put('k2', 'data', { cacheControl: 'no-store' });
      expect(writes[1].opts.cacheControl).toBe('no-store');
    } finally { g.Bun.S3Client = prev; }
  });

  it('R2/B2 constructors forward defaultPut to the underlying S3 store', async () => {
    const g = globalThis as any;
    g.Bun = g.Bun ?? {};
    const prev = g.Bun.S3Client;
    const writes: any[] = [];
    g.Bun.S3Client = class {
      constructor(_cfg: unknown) {}
      write = async (_k: string, _b: unknown, opts: unknown) => { writes.push(opts); };
      file() { return {}; }
      stat = async () => ({ size: 0 });
      list = async () => ({ contents: [] });
      delete = async () => {};
      presign = () => 'x';
    };
    try {
      const { createR2Store } = await import('../../src/storage/r2-store');
      const { createB2Store } = await import('../../src/storage/b2-store');
      const r2 = createR2Store({
        accountId: 'acct', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's',
        defaultPut: { cacheControl: 'public, max-age=1' },
      });
      await r2.put('k', 'd');
      expect(writes[0].cacheControl).toBe('public, max-age=1');
      const b2 = createB2Store({
        region: 'eu-central-003', bucket: 'b', keyId: 'a', applicationKey: 's',
        defaultPut: { acl: 'public-read' },
      });
      await b2.put('k', 'd');
      expect(writes[1].acl).toBe('public-read');
    } finally { g.Bun.S3Client = prev; }
  });
});

// ── database/backup #793/#795/#796 — pure helpers ─────────────────────────────

describe('database/backup helpers (#793/#795/#796)', () => {
  it('#795 checksum round-trips and verify catches corruption', async () => {
    const { computeBackupChecksum, verifyBackupChecksum } = await import('../../src/database/backup');
    const data = Buffer.from('SELECT 1;').toString('base64');
    const checksum = computeBackupChecksum(data);
    expect(verifyBackupChecksum({ data, metadata: { checksumSha256: checksum } })).toBe(true);
    // Corruption → mismatch.
    expect(verifyBackupChecksum({ data: data + 'X', metadata: { checksumSha256: checksum } })).toBe(false);
    // No recorded checksum → cannot fail (back-compat).
    expect(verifyBackupChecksum({ data, metadata: {} })).toBe(true);
    expect(verifyBackupChecksum({ data })).toBe(true);
  });

  it('#796 buildPsqlRestoreArgs always includes --single-transaction', async () => {
    const { buildPsqlRestoreArgs } = await import('../../src/database/backup');
    const remote = buildPsqlRestoreArgs(
      { host: 'db.neon.tech', port: '5432', user: 'u', database: 'd' }, false,
    );
    expect(remote).toContain('--single-transaction');
    expect(remote).toContain('--host=db.neon.tech');
    expect(remote).toContain('--port=5432');
    expect(remote).toContain('--username=u');
    expect(remote).toContain('d');
    // Local: no --host/--port (use socket), but still single-transaction.
    const local = buildPsqlRestoreArgs({ user: 'u', database: 'd' }, true);
    expect(local).toContain('--single-transaction');
    expect(local.some((a) => a.startsWith('--host'))).toBe(false);
  });

  it('#793 selectBranchesToPrune keeps newest N backups, ignores non-backup branches', async () => {
    const { selectBranchesToPrune } = await import('../../src/database/backup');
    const branches = [
      { id: 'main', name: 'main', createdAt: '2026-01-01T00:00:00Z' },          // not a backup
      { id: 'b1', name: 'backup-2026-01-01', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b2', name: 'backup-2026-02-01', createdAt: '2026-02-01T00:00:00Z' },
      { id: 'b3', name: 'backup-2026-03-01', createdAt: '2026-03-01T00:00:00Z' },
    ];
    // keep 2 newest backups (b3, b2) → prune b1.
    expect(selectBranchesToPrune(branches, 2)).toEqual(['b1']);
    // keep all → prune none.
    expect(selectBranchesToPrune(branches, 5)).toEqual([]);
    // keep 0 → prune all backups but never `main`.
    expect(selectBranchesToPrune(branches, 0).sort()).toEqual(['b1', 'b2', 'b3']);
  });
});

// ── backup-scheduler #789/#790 — honest naming + temp/final separation ────────

describe('backup-scheduler naming (#789/#790)', () => {
  it('#789 finalBackupName is honest about the format (not .tar.gz)', async () => {
    const { finalBackupName } = await import('../../src/backup-scheduler/index');
    const name = finalBackupName('2026-06-14T00-00-00-000Z');
    expect(name).toContain('backup-2026-06-14T00-00-00-000Z');
    expect(name.endsWith('.tar.gz')).toBe(false); // it's a dir of .gz, not a tarball
    expect(name.endsWith('.gzdir')).toBe(true);
  });

  it('#790 isFinalBackup accepts finalized dirs but rejects in-progress builds', async () => {
    const { isFinalBackup, inProgressBackupName, finalBackupName } = await import('../../src/backup-scheduler/index');
    const ts = '2026-06-14T00-00-00-000Z';
    expect(isFinalBackup(finalBackupName(ts))).toBe(true);
    expect(isFinalBackup(inProgressBackupName(ts))).toBe(false); // crashed/partial build
    expect(isFinalBackup('unrelated-dir')).toBe(false);
  });

  it('#790 in-progress and final prefixes are distinct', async () => {
    const { INPROGRESS_PREFIX, FINAL_PREFIX } = await import('../../src/backup-scheduler/index');
    expect(INPROGRESS_PREFIX).not.toBe(FINAL_PREFIX);
    expect(INPROGRESS_PREFIX.startsWith(FINAL_PREFIX)).toBe(false);
  });
});

// ── config-persistence #775 — single-pass default-app merge ───────────────────

describe('config-persistence mergeMissingDefaultApps (#775)', () => {
  it('appends only missing defaults by id and never replaces existing apps', async () => {
    const { mergeMissingDefaultApps } = await import('../../server/config-persistence');
    const apps: any[] = [{ id: 'a', name: 'A-custom' }];
    const defaults: any[] = [
      { id: 'a', name: 'A-default' }, // already present → must NOT overwrite
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ];
    const out = mergeMissingDefaultApps(apps, defaults);
    expect(out).toBe(apps); // mutates in place (existing call-site contract)
    expect(out.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(out.find((a) => a.id === 'a')!.name).toBe('A-custom'); // preserved
  });

  it('is idempotent — a second merge adds nothing', async () => {
    const { mergeMissingDefaultApps } = await import('../../server/config-persistence');
    const apps: any[] = [];
    const defaults: any[] = [{ id: 'x', name: 'X' }];
    mergeMissingDefaultApps(apps, defaults);
    mergeMissingDefaultApps(apps, defaults);
    expect(apps.map((a) => a.id)).toEqual(['x']);
  });
});
