/**
 * Scaleway limits user_data to 15 keys per server (cloud-init included) and 127 998 bytes per key. A deployment's
 * `files` are therefore packed: all files concatenated, cut into ≤ PACK_CHUNK_BYTES keys `aigw-pack-<n>`, and the
 * cloud-init carries a small index (key → offset, length) to rebuild them at `/srv/aigw/files/<key>` before the boot
 * script starts. Measured 2026-10-04: 18 voice clips + cloud-init → "User data keys are limited to 15 per server".
 */

export const PACK_CHUNK_BYTES = 120_000;
/** 15 keys per server minus the cloud-init. */
export const MAX_PACK_KEYS = 14;
export const MAX_PACKED_BYTES = PACK_CHUNK_BYTES * MAX_PACK_KEYS;

export interface FilePack {
  chunks: Record<string, Uint8Array>;
  /** key → [offset, length] in the concatenation. */
  index: Record<string, [number, number]>;
}

export function packFiles(files: Record<string, Uint8Array>): FilePack {
  const keys = Object.keys(files).sort();
  const index: Record<string, [number, number]> = {};
  let offset = 0;
  for (const key of keys) {
    index[key] = [offset, files[key].length];
    offset += files[key].length;
  }
  if (offset > MAX_PACKED_BYTES) throw new Error(`files total ${offset} bytes; at most ${MAX_PACKED_BYTES} fit in Scaleway user_data`);
  const all = Buffer.concat(keys.map(k => Buffer.from(files[k])));
  const chunks: Record<string, Uint8Array> = {};
  for (let i = 0, n = 0; i < all.length; i += PACK_CHUNK_BYTES, n++) {
    chunks[`aigw-pack-${n}`] = new Uint8Array(all.subarray(i, i + PACK_CHUNK_BYTES));
  }
  return { chunks, index };
}

/** Bash that fetches the chunks from the metadata service and rebuilds every file under /srv/aigw/files. */
export function unpackScript(pack: { chunkCount: number; index: Record<string, [number, number]> }): string {
  if (!pack.chunkCount) return '';
  const fetches = Array.from({ length: pack.chunkCount }, (_, n) =>
    `for i in 1 2 3 4 5; do curl -sf --local-port 1-1024 http://169.254.42.42/user_data/aigw-pack-${n} -o /srv/aigw/pack.${n} && break; sleep 3; done`);
  const parts = Array.from({ length: pack.chunkCount }, (_, n) => `/srv/aigw/pack.${n}`).join(' ');
  const splits = Object.entries(pack.index).map(([key, [off, len]]) =>
    `tail -c +${off + 1} /srv/aigw/pack.bin | head -c ${len} > /srv/aigw/files/${key}`);
  return ['mkdir -p /srv/aigw/files', ...fetches, `cat ${parts} > /srv/aigw/pack.bin`, ...splits, 'rm -f /srv/aigw/pack.*'].join('\n');
}
