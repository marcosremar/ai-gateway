import { describe, it, expect } from 'vitest';
import { resolveSnapshotStoreConfig } from '../server/gpu-snapshot';

describe('resolveSnapshotStoreConfig — Hyperstack Object Storage branch', () => {
  it('picks Hyperstack when HYPERSTACK_SNAPSHOTS_* are set (and ignores R2)', () => {
    const cfg = resolveSnapshotStoreConfig({
      HYPERSTACK_SNAPSHOTS_BUCKET: 'snaps',
      HYPERSTACK_SNAPSHOTS_ENDPOINT: 'https://s3.example.hyperstack.cloud',
      HYPERSTACK_SNAPSHOTS_ACCESS_KEY: 'k',
      HYPERSTACK_SNAPSHOTS_SECRET_KEY: 's',
      R2_SNAPSHOTS_BUCKET: 'should-be-ignored',
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      kind: 'hyperstack-s3',
      bucket: 'snaps',
      endpoint: 'https://s3.example.hyperstack.cloud',
      accessKeyId: 'k',
      secretAccessKey: 's',
      region: 'CANADA-1',
    });
  });

  it('respects explicit HYPERSTACK_SNAPSHOTS_REGION', () => {
    const cfg = resolveSnapshotStoreConfig({
      HYPERSTACK_SNAPSHOTS_BUCKET: 'snaps',
      HYPERSTACK_SNAPSHOTS_ENDPOINT: 'https://x',
      HYPERSTACK_SNAPSHOTS_ACCESS_KEY: 'k',
      HYPERSTACK_SNAPSHOTS_SECRET_KEY: 's',
      HYPERSTACK_SNAPSHOTS_REGION: 'NORWAY-1',
    } as NodeJS.ProcessEnv);
    expect(cfg.kind).toBe('hyperstack-s3');
    if (cfg.kind === 'hyperstack-s3') expect(cfg.region).toBe('NORWAY-1');
  });

  it('disables when Hyperstack bucket is set but endpoint/credentials are missing', () => {
    const cfg = resolveSnapshotStoreConfig({
      HYPERSTACK_SNAPSHOTS_BUCKET: 'snaps',
    } as NodeJS.ProcessEnv);
    expect(cfg.kind).toBe('disabled');
    if (cfg.kind === 'disabled') expect(cfg.reason).toMatch(/ENDPOINT\/ACCESS_KEY\/SECRET_KEY/);
  });

  it('falls back to R2 when Hyperstack vars are unset', () => {
    const cfg = resolveSnapshotStoreConfig({
      R2_SNAPSHOTS_BUCKET: 'r2-bucket',
      R2_SNAPSHOTS_ACCESS_KEY: 'ak',
      R2_SNAPSHOTS_SECRET_KEY: 'sk',
      R2_ACCOUNT_ID: 'acct',
    } as NodeJS.ProcessEnv);
    expect(cfg.kind).toBe('r2');
    if (cfg.kind === 'r2') {
      expect(cfg.bucket).toBe('r2-bucket');
      expect(cfg.accountId).toBe('acct');
    }
  });

  it('falls back to generic S3 when R2 endpoint is non-r2 (MinIO/Spaces)', () => {
    const cfg = resolveSnapshotStoreConfig({
      R2_SNAPSHOTS_BUCKET: 'spaces',
      R2_SNAPSHOTS_ENDPOINT: 'https://nyc3.digitaloceanspaces.com',
      R2_SNAPSHOTS_ACCESS_KEY: 'ak',
      R2_SNAPSHOTS_SECRET_KEY: 'sk',
    } as NodeJS.ProcessEnv);
    expect(cfg.kind).toBe('s3');
    if (cfg.kind === 's3') expect(cfg.endpoint).toContain('digitaloceanspaces');
  });

  it('returns disabled{no bucket} when nothing is configured', () => {
    const cfg = resolveSnapshotStoreConfig({} as NodeJS.ProcessEnv);
    expect(cfg.kind).toBe('disabled');
    if (cfg.kind === 'disabled') expect(cfg.reason).toBe('no bucket configured');
  });
});
