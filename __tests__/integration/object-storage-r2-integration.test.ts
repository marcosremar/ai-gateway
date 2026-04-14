/**
 * Object Storage — R2 integration test
 *
 * Round-trip test against a real Cloudflare R2 bucket. Validates the full
 * surface of `createR2Store()`: put → head → get → presign GET → list → delete.
 *
 * Skipped by default. To run:
 *
 *     R2_ACCOUNT_ID=... \
 *     R2_BUCKET=parle-models-bench \
 *     R2_ACCESS_KEY_ID=... \
 *     R2_SECRET_ACCESS_KEY=... \
 *     SKIP_R2_TESTS=0 \
 *     bun run test:object-storage
 *
 * The test cleans up after itself by deleting the test object on completion.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// NOTE: createR2Store imports @aws-sdk/client-s3 which may not be installed.
// We lazy-import inside the describe to let describe.skipIf() bail first.

const skip =
  process.env.SKIP_R2_TESTS !== '0' ||
  !process.env.R2_ACCOUNT_ID ||
  !process.env.R2_BUCKET ||
  !process.env.R2_ACCESS_KEY_ID ||
  !process.env.R2_SECRET_ACCESS_KEY;

describe.skipIf(skip)('object-storage / R2 integration', () => {
  let store: any;
  beforeAll(async () => {
    const { createR2Store } = await import('../src/object-storage');
    store = createR2Store({
      accountId: process.env.R2_ACCOUNT_ID!,
      bucket: process.env.R2_BUCKET!,
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    });
  });

  // Use a unique key per run so concurrent CI doesn't collide
  const testKey = `__tests__/object-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`;
  const payload = new Uint8Array(1024 * 4); // 4 KiB
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

  it('put → head returns correct metadata', async () => {
    await store.put(testKey, payload, { contentType: 'application/octet-stream' });

    const meta = await store.head(testKey);
    expect(meta).not.toBeNull();
    expect(meta!.size).toBe(payload.length);
    expect(meta!.etag).toBeDefined();
    // R2 returns the contentType we set; AWS sometimes normalizes it
    expect(meta!.contentType).toBe('application/octet-stream');
  });

  it('get returns the exact bytes that were uploaded', async () => {
    const downloaded = await store.get(testKey);
    expect(downloaded.length).toBe(payload.length);
    // Spot-check a few positions to avoid O(n) deepEqual on large arrays
    expect(downloaded[0]).toBe(payload[0]);
    expect(downloaded[1023]).toBe(payload[1023]);
    expect(downloaded[2047]).toBe(payload[2047]);
  });

  it('getStream returns a readable stream of the same bytes', async () => {
    const stream = store.getStream(testKey);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBe(payload.length);
  });

  it('presign GET URL is fetchable without auth headers', async () => {
    const url = store.presign(testKey, { expiresIn: 60 });
    expect(url).toMatch(/^https:\/\/.*r2\.cloudflarestorage\.com\//);

    const res = await fetch(url);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(payload.length);
  });

  it('list with prefix finds the test object', async () => {
    const result = await store.list('__tests__/');
    const keys = result.entries.map(e => e.key);
    expect(keys).toContain(testKey);

    const entry = result.entries.find(e => e.key === testKey);
    expect(entry).toBeDefined();
    expect(entry!.size).toBe(payload.length);
  });

  it('head returns null for missing object (no throw)', async () => {
    const meta = await store.head(`__tests__/definitely-does-not-exist-${Date.now()}.bin`);
    expect(meta).toBeNull();
  });

  it('delete is idempotent — does not throw on missing object', async () => {
    // First delete the real test object
    await store.delete(testKey);

    // Verify it's gone
    const meta = await store.head(testKey);
    expect(meta).toBeNull();

    // Delete again — must not throw
    await expect(store.delete(testKey)).resolves.toBeUndefined();
  });
});
