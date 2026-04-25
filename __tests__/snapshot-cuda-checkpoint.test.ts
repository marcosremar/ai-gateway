/**
 * cuda-checkpoint integration — verifies the SSH command sequence emitted by
 * captureSnapshot / maybeRestoreSnapshot when `useCudaCheckpoint: true`.
 *
 * The goal of the assertions is NOT to snapshot every byte of every shell
 * string (brittle) but to lock in the critical ordering invariants:
 *   capture: cuda-checkpoint --toggle --pid <PID>  BEFORE  criu dump
 *   dump includes --tcp-established
 *   restore: cuda-checkpoint install probe → criu restore → cuda-checkpoint
 *            --toggle ... (on the restored PID)
 *   restore dump includes --tcp-established
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'snapshot-cuda-'));
process.env.HOME = TMP;

type ExecRec = { cmd: string; timeoutMs?: number };

function makeStubStore() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    put: async (key: string, body: Uint8Array | string | ArrayBuffer) => {
      const buf = typeof body === 'string'
        ? new TextEncoder().encode(body)
        : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
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

/** Build an ssh exec recorder whose responses are keyed off command substrings. */
function makeExecRecorder(
  responses: Array<{ match: (cmd: string) => boolean; stdout?: string; code?: number }>,
) {
  const log: ExecRec[] = [];
  const fn = async (_tgt: unknown, cmd: string, opts?: { timeoutMs?: number }) => {
    log.push({ cmd, timeoutMs: opts?.timeoutMs });
    for (const r of responses) {
      if (r.match(cmd)) {
        return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: '' };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { fn, log };
}

let mod: typeof import('../server/gpu-snapshot');

async function reload() {
  vi.resetModules();
  mod = await import('../server/gpu-snapshot');
}

describe('cuda-checkpoint integration', () => {
  beforeEach(async () => {
    await reload();
    mod._resetSnapshotStoreForTests();
  });

  afterEach(() => {
    mod._setSshExecForTests(null);
  });

  it('captureSnapshot emits cuda-checkpoint --toggle BEFORE criu dump and includes --tcp-established', async () => {
    const store = makeStubStore();
    mod._setSnapshotStoreForTests(store);

    const { fn, log } = makeExecRecorder([
      // precheck driver
      { match: (c) => c.includes('nvidia-smi'), stdout: '570.86.10\n' },
      // precheck capsh
      { match: (c) => c.includes('capsh'), stdout: '' },
      // cuda-checkpoint install probe: `-h` succeeds so no curl needed
      { match: (c) => c.includes('cuda-checkpoint -h'), stdout: 'ok\n' },
      // drain toggle
      { match: (c) => c.includes('cuda-checkpoint --toggle') && c.includes('--pid'), stdout: '' },
      // criu dump
      { match: (c) => c.includes('criu dump'), stdout: '' },
      // tar
      { match: (c) => c.startsWith('sudo tar'), stdout: '1048576\n' },
      // fetch tarball base64
      { match: (c) => c.includes('cat /tmp/snapshot.tar.zst'), stdout: Buffer.from('payload').toString('base64') },
    ]);
    mod._setSshExecForTests(fn);

    const res = await mod.captureSnapshot({
      deployId: 'd1',
      provider: 'hyperstack',
      ssh: { host: '1.2.3.4', port: 22 },
      imageRef: 'marcosremar/babelcast:latest',
      models: [],
      mainPid: 4242,
      useCudaCheckpoint: true,
    });
    expect(res.captured).toBe(true);

    const cmds = log.map((e) => e.cmd);
    const toggleIdx = cmds.findIndex((c) => c.includes('cuda-checkpoint --toggle') && c.includes('--pid 4242'));
    const dumpIdx = cmds.findIndex((c) => c.includes('criu dump'));
    expect(toggleIdx).toBeGreaterThanOrEqual(0);
    expect(dumpIdx).toBeGreaterThanOrEqual(0);
    expect(toggleIdx).toBeLessThan(dumpIdx);
    // Dump must carry --tcp-established (required when process has outbound TCP).
    expect(cmds[dumpIdx]).toContain('--tcp-established');
    // The install probe must have run before the drain toggle.
    const installIdx = cmds.findIndex((c) => c.includes('cuda-checkpoint -h'));
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeLessThan(toggleIdx);
  });

  it('captureSnapshot with useCudaCheckpoint=false does NOT invoke cuda-checkpoint (back-compat)', async () => {
    const store = makeStubStore();
    mod._setSnapshotStoreForTests(store);
    const { fn, log } = makeExecRecorder([
      { match: (c) => c.includes('nvidia-smi'), stdout: '570.1\n' },
      { match: (c) => c.includes('capsh'), stdout: '' },
      { match: (c) => c.includes('criu dump'), stdout: '' },
      { match: (c) => c.startsWith('sudo tar'), stdout: '1024\n' },
      { match: (c) => c.includes('cat /tmp/snapshot.tar.zst'), stdout: Buffer.from('x').toString('base64') },
    ]);
    mod._setSshExecForTests(fn);

    const res = await mod.captureSnapshot({
      deployId: 'd2',
      provider: 'hyperstack',
      ssh: { host: '1.2.3.4', port: 22 },
      imageRef: 'img:x',
      models: [],
      // useCudaCheckpoint omitted — defaults to false
    });
    expect(res.captured).toBe(true);
    expect(log.every((e) => !e.cmd.includes('cuda-checkpoint'))).toBe(true);
  });

  it('maybeRestoreSnapshot with useCudaCheckpoint emits install → criu restore → toggle on restored PID', async () => {
    const store = makeStubStore();
    mod._setSnapshotStoreForTests(store);
    // Seed a matching catalog entry and its blob.
    const imageHash = mod.hashImage('img:x');
    const modelHash = mod.hashModels([]);
    const r2Key = `snapshots/hyperstack/${imageHash}/${modelHash}-d570.tar.zst`;
    await store.put(r2Key, new Uint8Array([1, 2, 3]));
    await mod.appendCatalogEntry({
      imageHash, modelHash,
      provider: 'hyperstack',
      driverMajor: 570,
      r2Key,
      createdAt: Date.now(),
      sizeBytes: 3,
    });
    await mod._flushCatalogForTests();

    const { fn, log } = makeExecRecorder([
      { match: (c) => c.includes('cuda-checkpoint -h'), stdout: 'ok\n' },
      { match: (c) => c.includes('criu restore'), stdout: '' },
      { match: (c) => c.includes('cuda-checkpoint --toggle'), stdout: '' },
    ]);
    mod._setSshExecForTests(fn);

    const res = await mod.maybeRestoreSnapshot({
      provider: 'hyperstack',
      ssh: { host: '1.2.3.4', port: 22 },
      imageRef: 'img:x',
      models: [],
      useCudaCheckpoint: true,
    });
    expect(res.restored).toBe(true);

    const cmds = log.map((e) => e.cmd);
    const installIdx = cmds.findIndex((c) => c.includes('cuda-checkpoint -h'));
    const restoreIdx = cmds.findIndex((c) => c.includes('criu restore'));
    const toggleIdx = cmds.findIndex((c) => c.includes('cuda-checkpoint --toggle'));
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(restoreIdx).toBeGreaterThanOrEqual(0);
    expect(toggleIdx).toBeGreaterThanOrEqual(0);
    // Order: install → restore → toggle (post-restore re-materialize).
    expect(installIdx).toBeLessThan(restoreIdx);
    expect(restoreIdx).toBeLessThan(toggleIdx);
    // Restore must carry --tcp-established and emit a pidfile we can read for the toggle.
    expect(cmds[restoreIdx]).toContain('--tcp-established');
    expect(cmds[restoreIdx]).toContain('--pidfile');
    // Toggle command must read the new PID from the pidfile written by criu.
    expect(cmds[toggleIdx]).toContain('/tmp/snapshot.pid');
  });
});

// Cleanup temp dir on process exit
process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});
