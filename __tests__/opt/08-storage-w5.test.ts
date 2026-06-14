/**
 * Optimization tests — Storage, Database, State & Config, WAVE 5 (IDs 701-800).
 *
 * Fifth batch, disjoint from waves 1-4. Unit-only: no real DB, network, or S3 —
 * Prisma/pg/Bun.S3Client/user-profiles are mocked; filesystem tests redirect HOME
 * into os.tmpdir(). Relative imports throughout.
 *
 * Covered findings:
 *   - config-handlers:    #709 mergeEnvContent (pure munging) + atomicWriteEnv
 *                         (tmp+fsync+rename, no truncation of unrelated keys)
 *   - config-persistence: #773 isConfigCacheFresh (mtime-aware cache bust) +
 *                         invalidateConfigCache + out-of-band edit detection,
 *                         #774 getConfigDbSyncFailures counter on DB-sync failure
 *   - database/service:   #786 redactDatabaseUrl (pure credential redaction)
 *   - latency-db-migrate: #797 isMigrationComplete + migrationFlagPath (durable
 *                         marker independent of the rename)
 *   - s3-store:           #745 shouldUseMultipart / putBodyByteLength + partSize
 *                         hint on large put(), #752 presignTtlSeconds (shorter
 *                         default + clamp for PUT presigns)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── config-handlers #709 — .env merge + atomic write ──────────────────────────

describe('config-handlers mergeEnvContent + atomicWriteEnv (#709)', () => {
  it('mergeEnvContent replaces an existing key in place and preserves others', async () => {
    const { mergeEnvContent } = await import('../../server/config-handlers');
    const existing = 'KEEP_ME=alpha\nGROQ_API_KEY=old\nALSO_KEEP=beta\n';
    const out = mergeEnvContent(existing, { GROQ_API_KEY: 'new' });
    expect(out).toContain('KEEP_ME=alpha');   // unrelated key untouched
    expect(out).toContain('ALSO_KEEP=beta');  // unrelated key untouched
    expect(out).toContain('GROQ_API_KEY=new');
    expect(out).not.toContain('GROQ_API_KEY=old');
  });

  it('mergeEnvContent removes a key when its value is empty', async () => {
    const { mergeEnvContent } = await import('../../server/config-handlers');
    const out = mergeEnvContent('A=1\nGROQ_API_KEY=secret\nB=2\n', { GROQ_API_KEY: '' });
    expect(out).not.toMatch(/GROQ_API_KEY=/);
    expect(out).toContain('A=1');
    expect(out).toContain('B=2');
  });

  it('mergeEnvContent appends a new key and quotes values with spaces', async () => {
    const { mergeEnvContent } = await import('../../server/config-handlers');
    const out = mergeEnvContent('A=1\n', { OPENAI_API_KEY: 'has space' });
    expect(out).toContain('OPENAI_API_KEY="has space"');
    expect(out).toContain('A=1');
  });

  it('atomicWriteEnv writes via tmp+rename — final file has the new content, no .tmp left', async () => {
    const { atomicWriteEnv } = await import('../../server/config-handlers');
    const dir = mkdtempSync(join(tmpdir(), 'opt08w5-env-'));
    try {
      const envPath = join(dir, '.env');
      writeFileSync(envPath, 'OLD=1\n');
      atomicWriteEnv(envPath, 'NEW=2\nKEEP=3\n');
      expect(readFileSync(envPath, 'utf8')).toBe('NEW=2\nKEEP=3\n');
      expect(existsSync(envPath + '.tmp')).toBe(false); // tmp cleaned by rename
      // Mode is 0o600 (owner-only) for the secret file.
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── config-persistence #773 — mtime-aware cache bust ──────────────────────────

describe('config-persistence isConfigCacheFresh (#773)', () => {
  it('is stale once the TTL has elapsed regardless of mtime', async () => {
    const { isConfigCacheFresh } = await import('../../server/config-persistence');
    const now = 1_000_000;
    // cached 6s ago with TTL 5s → expired.
    expect(isConfigCacheFresh(now, now - 6_000, now - 6_000, now - 6_000, 5_000)).toBe(false);
  });

  it('is stale when the file mtime is newer than the cached mtime (out-of-band edit)', async () => {
    const { isConfigCacheFresh } = await import('../../server/config-persistence');
    const now = 1_000_000;
    // Fresh by time, but file changed after we cached → must re-read.
    expect(isConfigCacheFresh(now, now - 1_000, now - 2_000, now - 1_000, 5_000)).toBe(false);
  });

  it('is fresh when within TTL and the file is unchanged', async () => {
    const { isConfigCacheFresh } = await import('../../server/config-persistence');
    const now = 1_000_000;
    expect(isConfigCacheFresh(now, now - 1_000, now - 2_000, now - 2_000, 5_000)).toBe(true);
  });

  it('busts when the current mtime is null (file vanished / unstat-able)', async () => {
    const { isConfigCacheFresh } = await import('../../server/config-persistence');
    const now = 1_000_000;
    expect(isConfigCacheFresh(now, now - 1_000, now - 2_000, null, 5_000)).toBe(false);
  });
});

describe('config-persistence cache invalidation end-to-end (#773)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opt08w5-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('invalidateConfigCache forces the next load to re-read from disk', async () => {
    const mod = await import('../../server/config-persistence');
    const cfg = await mod.loadProviderConfig();
    cfg.idleTimeoutMin = 42;
    await mod.saveProviderConfig(cfg);
    // Cache now holds idleTimeoutMin=42.
    expect((await mod.loadProviderConfig()).idleTimeoutMin).toBe(42);

    // Rewrite the file out-of-band with a different value + bump mtime forward.
    const file = join(home, '.babelcast', 'provider-config.json');
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    onDisk.idleTimeoutMin = 7;
    writeFileSync(file, JSON.stringify(onDisk));
    const future = new Date(Date.now() + 10_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(file, future, future);

    // mtime check should bust the cache and pick up the new value.
    expect((await mod.loadProviderConfig()).idleTimeoutMin).toBe(7);

    // Explicit invalidation also works (defensive).
    mod.invalidateConfigCache();
    expect((await mod.loadProviderConfig()).idleTimeoutMin).toBe(7);
  });
});

// ── config-persistence #774 — DB-sync failure counter ─────────────────────────

describe('config-persistence getConfigDbSyncFailures (#774)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opt08w5-dbsync-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('counter is 0 with no authenticated user and increments when the DB sync rejects', async () => {
    // Force the user-DB sync to reject so the fire-and-forget catch path runs.
    vi.doMock('../../server/user-profiles', () => ({
      saveUserConfig: vi.fn(async () => { throw new Error('neon down'); }),
      getUserConfig: vi.fn(async () => null),
      initUserProfilesDb: vi.fn(async () => {}),
      seedDefaultUserAccount: vi.fn(async () => {}),
    }));
    const mod = await import('../../server/config-persistence');
    mod.__resetConfigDbSyncFailures();

    // No user key set → no DB sync attempted → counter stays 0.
    const cfg = await mod.loadProviderConfig();
    await mod.saveProviderConfig(cfg);
    await new Promise((r) => setTimeout(r, 0));
    expect(mod.getConfigDbSyncFailures()).toBe(0);

    // With an authenticated user, the rejecting saveUserConfig bumps the counter.
    mod.setCurrentUserApiKey('user-key');
    await mod.saveProviderConfig(cfg);
    // Allow the dynamic import + rejected promise microtasks to settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(mod.getConfigDbSyncFailures()).toBeGreaterThanOrEqual(1);

    mod.setCurrentUserApiKey(null);
  });
});

// ── database/service #786 — credential redaction ──────────────────────────────

describe('database/service redactDatabaseUrl (#786)', () => {
  it('masks password (even with literal @) and truncates username', async () => {
    const { redactDatabaseUrl } = await import('../../src/database/service');
    const out = redactDatabaseUrl('postgresql://myuser:p@ss@db.neon.tech:5432/main');
    expect(out).not.toContain('p@ss');     // password never leaks
    expect(out).toContain('***');           // masked
    expect(out).not.toContain('myuser');    // full username not present
    expect(out).toContain('db.neon.tech');  // host still visible for diagnostics
  });

  it('returns <unparseable> for malformed input and never throws', async () => {
    const { redactDatabaseUrl } = await import('../../src/database/service');
    expect(redactDatabaseUrl('not a url')).toBe('<unparseable>');
    expect(redactDatabaseUrl(undefined)).toBe('<unparseable>');
  });
});

// ── latency-db-migrate #797 — durable completion marker ───────────────────────

describe('latency-db-migrate durable marker (#797)', () => {
  it('isMigrationComplete is true if EITHER the renamed marker or the flag exists', async () => {
    const { isMigrationComplete } = await import('../../server/latency-db-migrate');
    expect(isMigrationComplete(false, false)).toBe(false); // neither → run
    expect(isMigrationComplete(true, false)).toBe(true);   // legacy rename present
    expect(isMigrationComplete(false, true)).toBe(true);   // durable flag present
    expect(isMigrationComplete(true, true)).toBe(true);
  });

  it('migrationFlagPath is a distinct sidecar next to the db file', async () => {
    const { migrationFlagPath } = await import('../../server/latency-db-migrate');
    const p = migrationFlagPath('/x/latency.db');
    expect(p).toBe('/x/latency.db.migrated.flag');
    expect(p).not.toBe('/x/latency.db.migrated'); // not the rename target
  });
});

// ── s3-store #745 — multipart threshold ───────────────────────────────────────

describe('s3-store multipart threshold (#745)', () => {
  it('shouldUseMultipart triggers only at/above the threshold; unknown size = false', async () => {
    const { shouldUseMultipart, DEFAULT_MULTIPART_THRESHOLD } = await import('../../src/storage/s3-store');
    expect(shouldUseMultipart(DEFAULT_MULTIPART_THRESHOLD)).toBe(true);
    expect(shouldUseMultipart(DEFAULT_MULTIPART_THRESHOLD - 1)).toBe(false);
    expect(shouldUseMultipart(undefined)).toBe(false); // streaming body, can't decide
    expect(shouldUseMultipart(10, 5)).toBe(true);       // custom threshold honored
  });

  it('putBodyByteLength measures strings/buffers and returns undefined for streams', async () => {
    const { putBodyByteLength } = await import('../../src/storage/s3-store');
    expect(putBodyByteLength('abc')).toBe(3);
    expect(putBodyByteLength(new Uint8Array(8))).toBe(8);
    expect(putBodyByteLength(new ArrayBuffer(4))).toBe(4);
    // A ReadableStream has no synchronous length.
    const stream = new ReadableStream<Uint8Array>();
    expect(putBodyByteLength(stream)).toBeUndefined();
  });

  it('put() adds a partSize hint only for large bodies, not small ones', async () => {
    const g = globalThis as any;
    g.Bun = g.Bun ?? {};
    const prev = g.Bun.S3Client;
    const writes: Array<{ key: string; opts: any }> = [];
    g.Bun.S3Client = class {
      constructor(_cfg: unknown) {}
      write = async (key: string, _body: unknown, opts: any) => { writes.push({ key, opts }); };
      file() { return {}; }
      stat = async () => ({ size: 0 });
      list = async () => ({ contents: [] });
      delete = async () => {};
      presign = () => 'x';
    };
    try {
      const { createS3Store } = await import('../../src/storage/s3-store');
      const store = createS3Store({
        bucket: 'b', endpoint: 'https://e', accessKeyId: 'a', secretAccessKey: 's',
        multipartThresholdBytes: 4, // tiny threshold so a 5-byte body is "large"
      });
      await store.put('small', 'ab');          // 2 bytes < 4 → single PUT
      await store.put('large', 'abcdef');      // 6 bytes ≥ 4 → multipart hint
      expect(writes[0].opts.partSize).toBeUndefined();
      expect(writes[1].opts.partSize).toBeGreaterThan(0);
    } finally { g.Bun.S3Client = prev; }
  });
});

// ── s3-store #752 — presign TTL bounds (shorter default for PUT) ───────────────

describe('s3-store presignTtlSeconds (#752)', () => {
  it('PUT presigns default shorter than GET and both clamp to [60s, 24h]', async () => {
    const { presignTtlSeconds } = await import('../../src/storage/s3-store');
    expect(presignTtlSeconds('GET', undefined)).toBe(3600);    // 1h read default
    expect(presignTtlSeconds('PUT', undefined)).toBe(15 * 60); // 15m write default
    // Over-cap requests clamp to 24h regardless of method.
    expect(presignTtlSeconds('PUT', 365 * 86400)).toBe(24 * 3600);
    expect(presignTtlSeconds('GET', 365 * 86400)).toBe(24 * 3600);
    // Under-floor clamps up to 60s.
    expect(presignTtlSeconds('GET', 5)).toBe(60);
  });

  it('presign() applies the PUT default through the store', async () => {
    const g = globalThis as any;
    g.Bun = g.Bun ?? {};
    const prev = g.Bun.S3Client;
    const calls: any[] = [];
    g.Bun.S3Client = class {
      constructor(_cfg: unknown) {}
      write = async () => {};
      file() { return {}; }
      stat = async () => ({ size: 0 });
      list = async () => ({ contents: [] });
      delete = async () => {};
      presign = (key: string, opts: any) => { calls.push({ key, opts }); return 'signed://' + key; };
    };
    try {
      const { createS3Store } = await import('../../src/storage/s3-store');
      const store = createS3Store({ bucket: 'b', endpoint: 'https://e', accessKeyId: 'a', secretAccessKey: 's' });
      store.presign('upload.bin', { method: 'PUT' });
      expect(calls[0].opts.method).toBe('PUT');
      expect(calls[0].opts.expiresIn).toBe(15 * 60); // shorter write default
      store.presign('read.bin'); // GET default
      expect(calls[1].opts.expiresIn).toBe(3600);
    } finally { g.Bun.S3Client = prev; }
  });
});
