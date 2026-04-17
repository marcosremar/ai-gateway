/**
 * Phase B1 — snapshot capture path.
 *
 * Runs entirely in-memory: we stub the ObjectStore and the SSH layer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point HOME to a temp dir so catalog writes don't stomp on the real one.
const TMP = mkdtempSync(join(tmpdir(), 'snapshot-capture-'));
process.env.HOME = TMP;

let mod: typeof import('../server/gpu-snapshot');

async function reload() {
  vi.resetModules();
  mod = await import('../server/gpu-snapshot');
}

describe('snapshot capture', () => {
  beforeEach(async () => {
    await reload();
    mod._resetSnapshotStoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips capture on providers that are not snapshot-eligible', async () => {
    const store = makeStubStore();
    mod._setSnapshotStoreForTests(store);
    const precheckSpy = vi.spyOn(mod, 'snapshotPreCheck');
    // runpod is not snapshot-eligible — precheck should return ok:false.
    const res = await mod.captureSnapshot({
      deployId: 'd1',
      provider: 'runpod',
      ssh: { host: '1.2.3.4', port: 22 },
      imageRef: 'marcosremar/babelcast:latest',
      models: [],
    });
    expect(res.captured).toBe(false);
    expect(String(res.reason)).toMatch(/not snapshot-eligible/);
    // No upload should have happened.
    expect(store.objects.size).toBe(0);
  });

  it('catalog entries round-trip through loadSnapshotCatalog', async () => {
    const entry: Parameters<typeof mod.appendCatalogEntry>[0] = {
      imageHash: mod.hashImage('image:a'),
      modelHash: mod.hashModels(['m1']),
      provider: 'vast-vm',
      driverMajor: 570,
      r2Key: 'snapshots/vast-vm/abc/m1-d570.tar.zst',
      createdAt: Date.now(),
      sizeBytes: 1024,
    };
    await mod.appendCatalogEntry(entry);
    await mod._flushCatalogForTests();

    // Force fresh read from disk.
    const reloaded = await mod.loadSnapshotCatalog(true);
    expect(reloaded.length).toBe(1);
    expect(reloaded[0].r2Key).toBe(entry.r2Key);
  });

  it('refuses to shell-interpolate unsafe values', () => {
    expect(() => mod.assertSafe('abc.def', 'test')).not.toThrow();
    expect(() => mod.assertSafe('a; rm -rf /', 'test')).toThrow(/Unsafe value/);
  });
});

// ── Stub store ──────────────────────────────────────────────────────────────
function makeStubStore() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    put: async (key: string, body: Uint8Array | string | ArrayBuffer) => {
      const buf = typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
      objects.set(key, buf as Uint8Array);
    },
    get: async (key: string) => {
      const v = objects.get(key);
      if (!v) throw new Error(`missing ${key}`);
      return v;
    },
    getStream: () => { throw new Error('not implemented'); },
    head: async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length } : null),
    presign: () => 'https://stub',
    delete: async (key: string) => { objects.delete(key); },
    list: async () => ({ entries: [...objects.keys()].map((k) => ({ key: k, size: objects.get(k)!.length })) }),
  } as const;
}

// Cleanup temp dir on process exit
process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});
