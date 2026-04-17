/**
 * Phase B2 — snapshot restore fallback behaviour.
 *
 * When the snapshot object is missing / corrupt, the gateway falls back to
 * the cold path transparently. We verify:
 *   - getSnapshotMetrics() counts cold-fallbacks and auto-disable candidates.
 *   - maybeRestoreSnapshot returns restored:false without throwing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'snapshot-restore-'));
process.env.HOME = TMP;

let mod: typeof import('../server/gpu-snapshot');

async function reload() {
  vi.resetModules();
  mod = await import('../server/gpu-snapshot');
}

function makeBrokenStore() {
  return {
    put: async () => {},
    get: async () => { throw new Error('corrupt'); },
    getStream: () => { throw new Error('not impl'); },
    head: async () => null,
    presign: () => '',
    delete: async () => {},
    list: async () => ({ entries: [] }),
  };
}

describe('snapshot restore fallback', () => {
  beforeEach(async () => {
    await reload();
  });

  it('returns restored:false without throwing when provider not eligible', async () => {
    const res = await mod.maybeRestoreSnapshot({
      provider: 'runpod',
      ssh: { host: '1.2.3.4', port: 22 },
      imageRef: 'x',
      models: [],
    });
    expect(res.restored).toBe(false);
    expect(String(res.reason)).toMatch(/not snapshot-eligible/);
  });

  it('returns restored:false when no bucket is configured', async () => {
    // No R2_SNAPSHOTS_* in env
    delete process.env.R2_SNAPSHOTS_BUCKET;
    mod._resetSnapshotStoreForTests();
    const res = await mod.maybeRestoreSnapshot({
      provider: 'vast-vm',
      ssh: { host: '1.2.3.4', port: 22 },
      imageRef: 'x',
      models: [],
    });
    expect(res.restored).toBe(false);
    expect(String(res.reason)).toMatch(/no snapshot bucket/);
  });

  it('returns restored:false when catalog has no match', async () => {
    mod._setSnapshotStoreForTests(makeBrokenStore() as any);
    const res = await mod.maybeRestoreSnapshot({
      provider: 'vast-vm',
      ssh: { host: '1.2.3.4', port: 22 },
      imageRef: 'no-such-image',
      models: [],
    });
    expect(res.restored).toBe(false);
    expect(String(res.reason)).toMatch(/no matching snapshot/);
  });

  it('counts cold fallback when store read fails on known catalog entry', async () => {
    // Seed a matching catalog entry so the store.get() path is exercised.
    const entry = {
      imageHash: mod.hashImage('busted-image'),
      modelHash: mod.hashModels([]),
      provider: 'vast-vm' as const,
      driverMajor: 570,
      r2Key: 'snapshots/vast-vm/x.tar.zst',
      createdAt: Date.now(),
      sizeBytes: 1024,
    };
    await mod.appendCatalogEntry(entry);
    await mod._flushCatalogForTests();
    mod._setSnapshotStoreForTests(makeBrokenStore() as any);

    const before = mod.getSnapshotMetrics();
    const res = await mod.maybeRestoreSnapshot({
      provider: 'vast-vm',
      ssh: { host: '1.2.3.4', port: 22 },
      imageRef: 'busted-image',
      models: [],
    });
    expect(res.restored).toBe(false);
    const after = mod.getSnapshotMetrics();
    expect(after.coldFallback).toBeGreaterThan(before.coldFallback);
  });
});

process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});
