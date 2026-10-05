import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { MAX_PACK_KEYS, PACK_CHUNK_BYTES, packFiles, unpackScript } from '../../../src/deployments/file-pack';

describe('file pack (Scaleway: 15 user_data keys per server, 127 998 bytes per key)', () => {
  it('18 voice clips (≈1.1 MB, regression 2026-10-04) fit in ≤ 14 keys of ≤ 120 000 bytes', () => {
    const files = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`ref-${i}`, new Uint8Array(60_000 + i * 1000).fill(i)]));
    const pack = packFiles(files);
    const sizes = Object.values(pack.chunks).map(c => c.length);
    expect(sizes.length).toBeLessThanOrEqual(MAX_PACK_KEYS);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PACK_CHUNK_BYTES);
  });

  it('the unpack script rebuilds every file byte for byte', () => {
    const files = { b: new Uint8Array([1, 2, 3]), a: new Uint8Array(250_000).map((_, i) => i % 251), c: new Uint8Array(0) };
    const pack = packFiles(files);
    const dir = mkdtempSync(join(tmpdir(), 'pack-'));
    try {
      for (const [key, bytes] of Object.entries(pack.chunks)) writeFileSync(join(dir, key), bytes);
      // Same script, with the metadata fetch replaced by a copy from `dir` and /srv/aigw by `dir/out`.
      const script = unpackScript({ chunkCount: Object.keys(pack.chunks).length, index: pack.index })
        .replace(/curl -sf --local-port 1-1024 http:\/\/169\.254\.42\.42\/user_data\/(\S+) -o (\S+)/g, `cp ${dir}/$1 $2`)
        .replaceAll('/srv/aigw', `${dir}/out`);
      execFileSync('bash', ['-c', `mkdir -p ${dir}/out && ${script.replace(/\n/g, ' && ')}`]);
      for (const [key, bytes] of Object.entries(files)) expect(new Uint8Array(readFileSync(join(dir, 'out/files', key)))).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses more than fits', () => {
    expect(() => packFiles({ a: new Uint8Array(MAX_PACK_KEYS * PACK_CHUNK_BYTES + 1) })).toThrow(/at most/);
  });
});
