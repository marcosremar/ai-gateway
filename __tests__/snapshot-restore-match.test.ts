/**
 * Phase B2 — snapshot restore catalog match.
 *
 * Verifies that when a recent snapshot exists in the catalog, matchSnapshot
 * returns it. Stale entries (>7 days) and provider/driver mismatches are
 * excluded.
 */
import { describe, it, expect } from 'vitest';
import {
  hashImage,
  hashModels,
  matchSnapshot,
  SNAPSHOT_MAX_AGE_MS,
  type SnapshotCatalogEntry,
} from '../server/gpu-snapshot';

function entry(partial: Partial<SnapshotCatalogEntry> = {}): SnapshotCatalogEntry {
  return {
    imageHash: hashImage('image:x'),
    modelHash: hashModels(['m1']),
    provider: 'vast-vm',
    driverMajor: 570,
    r2Key: 'snapshots/vast-vm/abc/m1-d570.tar.zst',
    createdAt: Date.now(),
    sizeBytes: 512 * 1024,
    ...partial,
  };
}

describe('matchSnapshot', () => {
  const key = {
    imageHash: hashImage('image:x'),
    modelHash: hashModels(['m1']),
    provider: 'vast-vm',
    driverMajor: 570,
  };

  it('returns a fresh entry matching all fields', () => {
    const catalog = [entry()];
    expect(matchSnapshot(catalog, key)).toEqual(catalog[0]);
  });

  it('accepts entries with higher driver major than requested', () => {
    const catalog = [entry({ driverMajor: 575 })];
    expect(matchSnapshot(catalog, key)).toEqual(catalog[0]);
  });

  it('rejects entries older than the max age threshold', () => {
    const stale = entry({ createdAt: Date.now() - SNAPSHOT_MAX_AGE_MS - 1 });
    expect(matchSnapshot([stale], key)).toBeNull();
  });

  it('rejects entries on a different provider', () => {
    const wrongProvider = entry({ provider: 'hyperstack' });
    expect(matchSnapshot([wrongProvider], key)).toBeNull();
  });

  it('rejects entries with lower driver major', () => {
    const lowDriver = entry({ driverMajor: 555 });
    expect(matchSnapshot([lowDriver], key)).toBeNull();
  });

  it('picks the first matching entry (insertion order)', () => {
    const a = entry({ r2Key: 'a' });
    const b = entry({ r2Key: 'b' });
    expect(matchSnapshot([a, b], key)).toBe(a);
  });

  it('returns null on empty catalog', () => {
    expect(matchSnapshot([], key)).toBeNull();
  });
});
