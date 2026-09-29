import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveSnapshotStoreConfig,
  hashImage,
  hashModels,
  matchSnapshot,
  assertSafe,
  snapshotPreCheck,
  SNAPSHOT_MAX_AGE_MS,
  _setSshExecForTests,
  _setSnapshotStoreForTests,
  _resetSnapshotStoreForTests,
  captureSnapshot,
  maybeRestoreSnapshot,
  appendCatalogEntry,
  _flushCatalogForTests,
  _resetCatalogForTests,
  loadSnapshotCatalog,
  getSnapshotMetrics,
  type SnapshotCatalogEntry,
  type SshTarget,
} from '../../server/gpu-snapshot';

// ── resolveSnapshotStoreConfig ───────────────────────────────────────────────

describe('resolveSnapshotStoreConfig', () => {
  it('returns disabled when no bucket env vars set', () => {
    const cfg = resolveSnapshotStoreConfig({});
    expect(cfg.kind).toBe('disabled');
  });

  it('returns hyperstack-s3 with all required vars', () => {
    const cfg = resolveSnapshotStoreConfig({
      HYPERSTACK_SNAPSHOTS_BUCKET: 'hs-bucket',
      HYPERSTACK_SNAPSHOTS_ENDPOINT: 'https://object.ca-1.hyperstack.cloud',
      HYPERSTACK_SNAPSHOTS_ACCESS_KEY: 'ak',
      HYPERSTACK_SNAPSHOTS_SECRET_KEY: 'sk',
    });
    expect(cfg.kind).toBe('hyperstack-s3');
    if (cfg.kind === 'hyperstack-s3') {
      expect(cfg.bucket).toBe('hs-bucket');
      expect(cfg.region).toBe('CANADA-1');
    }
  });

  it('uses custom region for hyperstack-s3 when provided', () => {
    const cfg = resolveSnapshotStoreConfig({
      HYPERSTACK_SNAPSHOTS_BUCKET: 'b',
      HYPERSTACK_SNAPSHOTS_ENDPOINT: 'https://ep',
      HYPERSTACK_SNAPSHOTS_ACCESS_KEY: 'ak',
      HYPERSTACK_SNAPSHOTS_SECRET_KEY: 'sk',
      HYPERSTACK_SNAPSHOTS_REGION: 'EU-1',
    });
    expect(cfg.kind).toBe('hyperstack-s3');
    if (cfg.kind === 'hyperstack-s3') expect(cfg.region).toBe('EU-1');
  });

  it('returns disabled when hyperstack bucket set but credentials missing', () => {
    const cfg = resolveSnapshotStoreConfig({
      HYPERSTACK_SNAPSHOTS_BUCKET: 'b',
    });
    expect(cfg.kind).toBe('disabled');
    if (cfg.kind === 'disabled') {
      expect(cfg.reason).toContain('HYPERSTACK_SNAPSHOTS_BUCKET');
      expect(cfg.reason).toContain('missing');
    }
  });

  it('returns disabled when R2 bucket set but credentials missing', () => {
    const cfg = resolveSnapshotStoreConfig({ R2_SNAPSHOTS_BUCKET: 'b' });
    expect(cfg.kind).toBe('disabled');
    if (cfg.kind === 'disabled') expect(cfg.reason).toContain('ACCESS_KEY');
  });

  it('returns r2 when endpoint is empty (no endpoint)', () => {
    const cfg = resolveSnapshotStoreConfig({
      R2_SNAPSHOTS_BUCKET: 'my-bucket',
      R2_SNAPSHOTS_ACCESS_KEY: 'ak',
      R2_SNAPSHOTS_SECRET_KEY: 'sk',
      R2_ACCOUNT_ID: 'acct123',
    });
    expect(cfg.kind).toBe('r2');
    if (cfg.kind === 'r2') {
      expect(cfg.bucket).toBe('my-bucket');
      expect(cfg.accountId).toBe('acct123');
    }
  });

  it('returns r2 when endpoint matches r2.cloudflarestorage.com', () => {
    const cfg = resolveSnapshotStoreConfig({
      R2_SNAPSHOTS_BUCKET: 'b',
      R2_SNAPSHOTS_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      R2_SNAPSHOTS_ACCESS_KEY: 'ak',
      R2_SNAPSHOTS_SECRET_KEY: 'sk',
    });
    expect(cfg.kind).toBe('r2');
    if (cfg.kind === 'r2') expect(cfg.accountId).toBe('acct');
  });

  it('returns s3 for non-R2 endpoint', () => {
    const cfg = resolveSnapshotStoreConfig({
      R2_SNAPSHOTS_BUCKET: 'b',
      R2_SNAPSHOTS_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
      R2_SNAPSHOTS_ACCESS_KEY: 'ak',
      R2_SNAPSHOTS_SECRET_KEY: 'sk',
    });
    expect(cfg.kind).toBe('s3');
    if (cfg.kind === 's3') {
      expect(cfg.region).toBe('auto');
      expect(cfg.endpoint).toBe('https://s3.us-east-1.amazonaws.com');
    }
  });

  it('uses custom region for s3', () => {
    const cfg = resolveSnapshotStoreConfig({
      R2_SNAPSHOTS_BUCKET: 'b',
      R2_SNAPSHOTS_ENDPOINT: 'https://minio.example.com',
      R2_SNAPSHOTS_ACCESS_KEY: 'ak',
      R2_SNAPSHOTS_SECRET_KEY: 'sk',
      R2_SNAPSHOTS_REGION: 'us-west-2',
    });
    expect(cfg.kind).toBe('s3');
    if (cfg.kind === 's3') expect(cfg.region).toBe('us-west-2');
  });

  it('prefers hyperstack over R2 when both are set', () => {
    const cfg = resolveSnapshotStoreConfig({
      HYPERSTACK_SNAPSHOTS_BUCKET: 'hs-b',
      HYPERSTACK_SNAPSHOTS_ENDPOINT: 'https://ep',
      HYPERSTACK_SNAPSHOTS_ACCESS_KEY: 'hak',
      HYPERSTACK_SNAPSHOTS_SECRET_KEY: 'hsk',
      R2_SNAPSHOTS_BUCKET: 'r2-b',
      R2_SNAPSHOTS_ACCESS_KEY: 'r2ak',
      R2_SNAPSHOTS_SECRET_KEY: 'r2sk',
    });
    expect(cfg.kind).toBe('hyperstack-s3');
  });
});

// ── hashImage ────────────────────────────────────────────────────────────────

describe('hashImage', () => {
  it('returns a 16-char hex string', () => {
    const h = hashImage('myrepo/img:v1');
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same inputs', () => {
    expect(hashImage('repo/img:latest')).toBe(hashImage('repo/img:latest'));
    expect(hashImage('repo/img:v1', 'sha256:abc')).toBe(hashImage('repo/img:v1', 'sha256:abc'));
  });

  it('differs when digest changes', () => {
    expect(hashImage('img:v1', 'sha256:aaa')).not.toBe(hashImage('img:v1', 'sha256:bbb'));
  });

  it('differs when ref changes', () => {
    expect(hashImage('img:v1')).not.toBe(hashImage('img:v2'));
  });

  it('differs when digest is present vs absent', () => {
    expect(hashImage('img:v1')).not.toBe(hashImage('img:v1', 'sha256:abc'));
  });
});

// ── hashModels ───────────────────────────────────────────────────────────────

describe('hashModels', () => {
  it('returns a 16-char hex string', () => {
    const h = hashModels(['whisper-large-v3', 'gemma-7b']);
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    const models = ['stt-model', 'llm-model', 'tts-model'];
    expect(hashModels(models)).toBe(hashModels(models));
  });

  it('is order-insensitive (models are sorted before hashing)', () => {
    expect(hashModels(['a', 'b', 'c'])).toBe(hashModels(['c', 'a', 'b']));
  });

  it('differs when model set changes', () => {
    expect(hashModels(['a', 'b'])).not.toBe(hashModels(['a', 'c']));
  });

  it('handles empty model list', () => {
    const h = hashModels([]);
    expect(h).toHaveLength(16);
    expect(h).not.toBe(hashModels(['any-model']));
  });
});

// ── matchSnapshot ────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<SnapshotCatalogEntry> = {}): SnapshotCatalogEntry {
  return {
    imageHash: 'abc123',
    modelHash: 'def456',
    provider: 'vast-vm',
    driverMajor: 570,
    r2Key: 'snapshots/vast-vm/abc123/def456-d570.tar.zst',
    createdAt: Date.now() - 1000,
    sizeBytes: 1_000_000,
    ...overrides,
  };
}

describe('matchSnapshot', () => {
  it('returns matching entry', () => {
    const entry = makeEntry();
    const result = matchSnapshot([entry], {
      imageHash: 'abc123',
      modelHash: 'def456',
      provider: 'vast-vm',
      driverMajor: 570,
    });
    expect(result).toBe(entry);
  });

  it('returns null for empty catalog', () => {
    expect(matchSnapshot([], { imageHash: 'h', modelHash: 'm', provider: 'vast-vm', driverMajor: 570 })).toBeNull();
  });

  it('returns null when imageHash differs', () => {
    const entry = makeEntry({ imageHash: 'other' });
    expect(matchSnapshot([entry], { imageHash: 'abc123', modelHash: 'def456', provider: 'vast-vm', driverMajor: 570 })).toBeNull();
  });

  it('returns null when modelHash differs', () => {
    const entry = makeEntry({ modelHash: 'other' });
    expect(matchSnapshot([entry], { imageHash: 'abc123', modelHash: 'def456', provider: 'vast-vm', driverMajor: 570 })).toBeNull();
  });

  it('returns null when provider differs', () => {
    const entry = makeEntry({ provider: 'hyperstack' });
    expect(matchSnapshot([entry], { imageHash: 'abc123', modelHash: 'def456', provider: 'vast-vm', driverMajor: 570 })).toBeNull();
  });

  it('accepts entry with driverMajor >= requested', () => {
    const entry = makeEntry({ driverMajor: 575 });
    const result = matchSnapshot([entry], { imageHash: 'abc123', modelHash: 'def456', provider: 'vast-vm', driverMajor: 570 });
    expect(result).toBe(entry);
  });

  it('rejects entry with driverMajor < requested', () => {
    const entry = makeEntry({ driverMajor: 560 });
    expect(matchSnapshot([entry], { imageHash: 'abc123', modelHash: 'def456', provider: 'vast-vm', driverMajor: 570 })).toBeNull();
  });

  it('rejects entry older than SNAPSHOT_MAX_AGE_MS', () => {
    const staleEntry = makeEntry({ createdAt: Date.now() - SNAPSHOT_MAX_AGE_MS - 1 });
    expect(matchSnapshot([staleEntry], { imageHash: 'abc123', modelHash: 'def456', provider: 'vast-vm', driverMajor: 570 })).toBeNull();
  });

  it('accepts entry exactly within max age', () => {
    const now = Date.now();
    const freshEntry = makeEntry({ createdAt: now - SNAPSHOT_MAX_AGE_MS + 1000 });
    const result = matchSnapshot([freshEntry], { imageHash: 'abc123', modelHash: 'def456', provider: 'vast-vm', driverMajor: 570 }, now);
    expect(result).toBe(freshEntry);
  });

  it('returns the first match when multiple entries match', () => {
    const e1 = makeEntry({ r2Key: 'key-1' });
    const e2 = makeEntry({ r2Key: 'key-2' });
    expect(matchSnapshot([e1, e2], { imageHash: 'abc123', modelHash: 'def456', provider: 'vast-vm', driverMajor: 570 })).toBe(e1);
  });
});

// ── assertSafe ───────────────────────────────────────────────────────────────

describe('assertSafe', () => {
  it('passes alphanumeric values', () => {
    expect(assertSafe('deploy123', 'deployId')).toBe('deploy123');
  });

  it('passes values with allowed special chars', () => {
    expect(assertSafe('host.example.com', 'host')).toBe('host.example.com');
    expect(assertSafe('192.168.1.1', 'host')).toBe('192.168.1.1');
    expect(assertSafe('user_name', 'user')).toBe('user_name');
    expect(assertSafe('/usr/local/bin', 'path')).toBe('/usr/local/bin');
    expect(assertSafe('v1.2.3+build', 'version')).toBe('v1.2.3+build');
    expect(assertSafe('key=value', 'param')).toBe('key=value');
    expect(assertSafe('user@host', 'addr')).toBe('user@host');
  });

  it('rejects values with shell-injection characters', () => {
    expect(() => assertSafe('hello world', 'field')).toThrow('[snapshot] Unsafe value for field');
    expect(() => assertSafe('name;cmd', 'field')).toThrow();
    expect(() => assertSafe('$(evil)', 'field')).toThrow();
    expect(() => assertSafe('a`b`c', 'field')).toThrow();
    expect(() => assertSafe('a|b', 'field')).toThrow();
    expect(() => assertSafe('a&&b', 'field')).toThrow();
    expect(() => assertSafe('a\nb', 'field')).toThrow();
    expect(() => assertSafe("a'b", 'field')).toThrow();
    expect(() => assertSafe('a"b', 'field')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => assertSafe('', 'field')).toThrow();
  });

  it('includes field name in error message', () => {
    expect(() => assertSafe('bad value', 'myField')).toThrow('myField');
  });
});

// ── snapshotPreCheck (via SSH mock) ──────────────────────────────────────────

const TARGET: SshTarget = { host: '10.0.0.1', port: 22 };

describe('snapshotPreCheck', () => {
  afterEach(() => _setSshExecForTests(null));

  it('rejects unsupported provider immediately', async () => {
    const result = await snapshotPreCheck(TARGET, 'runpod');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not snapshot-eligible');
  });

  it('rejects when nvidia-smi fails', async () => {
    _setSshExecForTests(async () => ({ code: 1, stdout: '', stderr: 'command not found' }));
    const result = await snapshotPreCheck(TARGET, 'vast-vm');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('nvidia-smi failed');
  });

  it('rejects when driver version is below 570', async () => {
    let call = 0;
    _setSshExecForTests(async () => {
      call++;
      if (call === 1) return { code: 0, stdout: '560.35.03\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const result = await snapshotPreCheck(TARGET, 'vast-vm');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('< 570');
    expect(result.driverMajor).toBe(560);
  });

  it('rejects when caps check fails', async () => {
    let call = 0;
    _setSshExecForTests(async () => {
      call++;
      if (call === 1) return { code: 0, stdout: '575.21.01\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'no capability' };
    });
    const result = await snapshotPreCheck(TARGET, 'vast-vm');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('CAP_CHECKPOINT_RESTORE');
  });

  it('returns ok=true with driverMajor when all checks pass', async () => {
    let call = 0;
    _setSshExecForTests(async () => {
      call++;
      if (call === 1) return { code: 0, stdout: '575.21.01\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const result = await snapshotPreCheck(TARGET, 'hyperstack');
    expect(result.ok).toBe(true);
    expect(result.driverMajor).toBe(575);
  });

  it('accepts driver version exactly at 570', async () => {
    let call = 0;
    _setSshExecForTests(async () => {
      call++;
      if (call === 1) return { code: 0, stdout: '570.00.00\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const result = await snapshotPreCheck(TARGET, 'vast-vm');
    expect(result.ok).toBe(true);
    expect(result.driverMajor).toBe(570);
  });
});

// ── captureSnapshot (via SSH + store mocks) ──────────────────────────────────

describe('captureSnapshot', () => {
  const putCalls: Array<{ key: string; size: number }> = [];

  beforeEach(() => {
    putCalls.length = 0;
    _resetSnapshotStoreForTests();
    _setSnapshotStoreForTests({
      put: async (key, buf) => { putCalls.push({ key, size: (buf as Buffer).length }); },
      get: async () => Buffer.alloc(0),
      delete: async () => {},
      list: async () => [],
    });
  });

  afterEach(() => {
    _setSshExecForTests(null);
    _setSnapshotStoreForTests(null);
    _resetSnapshotStoreForTests();
  });

  it('skips capture for unsupported provider', async () => {
    const result = await captureSnapshot({
      deployId: 'deploy-1',
      provider: 'runpod',
      ssh: TARGET,
      imageRef: 'img:v1',
      models: ['m1'],
    });
    expect(result.captured).toBe(false);
    expect(result.reason).toContain('not snapshot-eligible');
  });

  it('skips capture when precheck driver fails', async () => {
    _setSshExecForTests(async () => ({ code: 1, stdout: '', stderr: 'failed' }));
    const result = await captureSnapshot({
      deployId: 'deploy-1',
      provider: 'vast-vm',
      ssh: TARGET,
      imageRef: 'img:v1',
      models: [],
    });
    expect(result.captured).toBe(false);
  });

  it('captures successfully and uploads to store', async () => {
    const b64Payload = Buffer.from('fake-tarball').toString('base64');
    let call = 0;
    _setSshExecForTests(async (_t, cmd) => {
      call++;
      // driver check
      if (cmd.includes('nvidia-smi')) return { code: 0, stdout: '575.21.01\n', stderr: '' };
      // caps check
      if (cmd.includes('CAP_CHECKPOINT')) return { code: 0, stdout: '', stderr: '' };
      // criu dump
      if (cmd.includes('criu dump')) return { code: 0, stdout: '', stderr: '' };
      // tar + stat
      if (cmd.includes('tar --zstd')) return { code: 0, stdout: '1024\n', stderr: '' };
      // base64 fetch
      if (cmd.includes('base64')) return { code: 0, stdout: b64Payload + '\n', stderr: '' };
      // cleanup
      return { code: 0, stdout: '', stderr: '' };
    });

    const result = await captureSnapshot({
      deployId: 'deploy-abc',
      provider: 'vast-vm',
      ssh: TARGET,
      imageRef: 'myrepo/img:v1',
      models: ['whisper-large-v3'],
    });

    expect(result.captured).toBe(true);
    expect(result.entry).toBeDefined();
    expect(result.entry?.provider).toBe('vast-vm');
    expect(putCalls.length).toBe(1);
    expect(putCalls[0].key).toMatch(/^snapshots\/vast-vm\//);
  });

  it('returns captured=false when criu dump fails', async () => {
    _setSshExecForTests(async (_t, cmd) => {
      if (cmd.includes('nvidia-smi')) return { code: 0, stdout: '575.21.01\n', stderr: '' };
      if (cmd.includes('CAP_CHECKPOINT')) return { code: 0, stdout: '', stderr: '' };
      if (cmd.includes('criu dump')) return { code: 1, stdout: '', stderr: 'dump error' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const result = await captureSnapshot({
      deployId: 'd1',
      provider: 'vast-vm',
      ssh: TARGET,
      imageRef: 'img:v1',
      models: [],
    });
    expect(result.captured).toBe(false);
    expect(result.reason).toContain('criu dump');
  });
});

// ── maybeRestoreSnapshot ─────────────────────────────────────────────────────

describe('maybeRestoreSnapshot', () => {
  beforeEach(() => {
    _resetSnapshotStoreForTests();
  });

  afterEach(() => {
    _setSshExecForTests(null);
    _setSnapshotStoreForTests(null);
    _resetSnapshotStoreForTests();
  });

  it('skips restore for unsupported provider', async () => {
    const result = await maybeRestoreSnapshot({
      provider: 'runpod',
      ssh: TARGET,
      imageRef: 'img:v1',
      models: [],
    });
    expect(result.restored).toBe(false);
    expect(result.reason).toContain('not snapshot-eligible');
  });

  it('skips restore when no store configured', async () => {
    _setSnapshotStoreForTests(null);
    const result = await maybeRestoreSnapshot({
      provider: 'vast-vm',
      ssh: TARGET,
      imageRef: 'img:v1',
      models: [],
    });
    expect(result.restored).toBe(false);
    expect(result.reason).toContain('no snapshot bucket');
  });

  it('skips restore when no matching catalog entry', async () => {
    _setSnapshotStoreForTests({
      put: async () => {},
      get: async () => Buffer.alloc(0),
      delete: async () => {},
      list: async () => [],
    });
    // No catalog entry → matchSnapshot returns null
    const result = await maybeRestoreSnapshot({
      provider: 'vast-vm',
      ssh: TARGET,
      imageRef: 'img:v1',
      models: ['nonexistent-model'],
    });
    expect(result.restored).toBe(false);
    expect(result.reason).toContain('no matching snapshot');
  });
});

// ── appendCatalogEntry dedup + trim ──────────────────────────────────────────

describe('appendCatalogEntry — dedup and trim', () => {
  beforeEach(() => _resetCatalogForTests());
  afterEach(() => _resetCatalogForTests());

  it('replaces an entry with the same key fields', async () => {
    const e1 = makeEntry({ sizeBytes: 100, r2Key: 'old-key' });
    await appendCatalogEntry(e1);
    // flush to disk so the second call can load it back via forceReload
    await _flushCatalogForTests();

    const e2 = makeEntry({ sizeBytes: 200, r2Key: 'new-key' });
    await appendCatalogEntry(e2);

    // Read from in-memory cache (no forceReload) — cache is authoritative after append
    const catalog = await loadSnapshotCatalog();
    const matches = catalog.filter(
      (e) => e.imageHash === 'abc123' && e.modelHash === 'def456' && e.provider === 'vast-vm' && e.driverMajor === 570,
    );
    expect(matches.length).toBe(1);
    expect(matches[0].sizeBytes).toBe(200);
    expect(matches[0].r2Key).toBe('new-key');
  });

  it('keeps entries with different providers separate', async () => {
    const e1 = makeEntry({ provider: 'vast-vm' });
    await appendCatalogEntry(e1);
    await _flushCatalogForTests();

    const e2 = makeEntry({ provider: 'hyperstack' });
    await appendCatalogEntry(e2);

    const catalog = await loadSnapshotCatalog();
    const vastEntries = catalog.filter((e) => e.provider === 'vast-vm' && e.imageHash === 'abc123');
    const hsEntries = catalog.filter((e) => e.provider === 'hyperstack' && e.imageHash === 'abc123');
    expect(vastEntries.length).toBe(1);
    expect(hsEntries.length).toBe(1);
  });
});

// ── getSnapshotMetrics ───────────────────────────────────────────────────────

describe('getSnapshotMetrics', () => {
  it('returns a metrics object with expected fields', () => {
    const m = getSnapshotMetrics();
    expect(typeof m.captureOk).toBe('number');
    expect(typeof m.captureFail).toBe('number');
    expect(typeof m.restoreOk).toBe('number');
    expect(typeof m.restoreFail).toBe('number');
    expect(typeof m.restoreSkipped).toBe('number');
    expect(typeof m.coldFallback).toBe('number');
    expect(typeof m.autoDisableCount).toBe('number');
    expect(typeof m.lastRestoreDurationMs).toBe('number');
  });

  it('returns a copy (mutations do not affect internal state)', () => {
    const m1 = getSnapshotMetrics() as Record<string, number>;
    m1.captureOk = 99999;
    const m2 = getSnapshotMetrics();
    expect(m2.captureOk).not.toBe(99999);
  });
});
