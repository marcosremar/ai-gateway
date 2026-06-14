/**
 * S3-compatible adapter for ObjectStore.
 *
 * Works with any S3-compatible service: AWS S3, Cloudflare R2, Backblaze B2,
 * MinIO, DigitalOcean Spaces, Wasabi, etc. Uses Bun's native `Bun.S3Client`
 * (no external SDK dependency).
 *
 * Convenience constructors for R2/B2 live in `r2-store.ts` and `b2-store.ts`.
 */

import type {
  ObjectStore,
  ObjectMetadata,
  PresignOptions,
  PutOptions,
  PutBody,
  ListOptions,
  ListResult,
  ListEntry,
} from './types';

/**
 * Auto-paginating async iterator over `list()` (#749). Standalone + dependency-
 * injected on the store's own `list` so it has no S3 SDK coupling and is unit-
 * testable against any `ObjectStore`-shaped fake. Stops when a page returns no
 * continuation token. Guards against a misbehaving backend that returns the
 * same token forever.
 */
export async function* listAllVia(
  listFn: (prefix?: string, opts?: ListOptions) => Promise<ListResult>,
  prefix?: string,
  pageSize = 1000,
): AsyncIterable<ListEntry> {
  let token: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const page: ListResult = await listFn(prefix, {
      limit: pageSize,
      ...(token ? { continuationToken: token } : {}),
    });
    for (const entry of page.entries) yield entry;
    token = page.nextContinuationToken;
    if (token) {
      if (seenTokens.has(token)) break; // backend not advancing — avoid infinite loop
      seenTokens.add(token);
    }
  } while (token);
}

/**
 * Broadened "object not found" detection (#753).
 *
 * The previous heuristic matched a fixed set of codes/names; some
 * S3-compatibles (B2/MinIO/Wasabi) surface 404s with different shapes, so a
 * genuinely-missing object could throw instead of returning null. We now treat
 * any 4xx-that-is-not-403 (auth) as not-found, plus the well-known codes.
 * Exported so callers (and tests) share one definition.
 */
export function isS3NotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; statusCode?: number; status?: number; name?: string };
  const status = e.statusCode ?? e.status;
  if (status === 404) return true;
  // Any client error other than 403 (forbidden) is treated as absence — a 403
  // is a real permission problem the caller must see, not a missing key.
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 403) return true;
  const code = e.code ?? e.name;
  return code === 'NotFound' || code === 'NoSuchKey' || code === 'NoSuchBucket';
}

/**
 * Retryable-transient classification for S3 ops (#755). 5xx and SlowDown/
 * throttling are transient; 4xx (except 429) are caller errors and must NOT be
 * retried (retrying a 404/403 just wastes time). Exported for unit testing.
 */
export function isRetryableS3Error(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; statusCode?: number; status?: number; name?: string };
  const status = e.statusCode ?? e.status;
  if (typeof status === 'number') {
    if (status >= 500) return true;
    if (status === 429) return true; // Too Many Requests
    return false;
  }
  const code = e.code ?? e.name;
  return code === 'SlowDown' || code === 'RequestTimeout' || code === 'InternalError' || code === 'ServiceUnavailable';
}

/**
 * Run an idempotent S3 op with bounded exponential backoff on transient
 * errors (#755). Non-retryable errors (4xx other than 429) surface immediately.
 * `sleep` is injectable so tests run instantly.
 */
export async function withS3Retry<T>(
  op: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let attempt = 0;
  for (;;) {
    try {
      return await op();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries || !isRetryableS3Error(err)) throw err;
      const cap = baseDelayMs * 2 ** (attempt - 1);
      await sleep(Math.floor(Math.random() * cap)); // full jitter
    }
  }
}

export interface S3StoreConfig {
  /** Bucket name. */
  bucket: string;
  /** Service endpoint URL, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  /** Access key ID. */
  accessKeyId: string;
  /** Secret access key. */
  secretAccessKey: string;
  /**
   * AWS-style region. R2 ignores this (use 'auto'); B2 needs the region
   * embedded in the endpoint hostname; AWS S3 needs the actual region.
   * Default: 'auto'.
   */
  region?: string;
  /** Optional session token for temporary credentials. */
  sessionToken?: string;
  /**
   * Default PUT options (#754) applied to every `put` unless overridden per
   * call. The R2/B2 convenience constructors use this to set a sensible
   * cache/ACL policy for CDN-served assets so repeat reads hit the edge.
   */
  defaultPut?: PutOptions;
  /**
   * Body size (bytes) at/above which `put` requests a multipart upload (#745).
   * Defaults to {@link DEFAULT_MULTIPART_THRESHOLD} (100MB). Bodies whose size
   * isn't known up front (streams) are left to the client's own default.
   */
  multipartThresholdBytes?: number;
}

/**
 * Merge per-call PutOptions over store defaults (#754). Per-call values win;
 * defaults fill the gaps. Pure → unit-testable.
 */
export function mergePutOptions(defaults?: PutOptions, opts?: PutOptions): PutOptions {
  return { ...(defaults ?? {}), ...(opts ?? {}) };
}

/** Default body size (bytes) above which a PUT should be multipart (#745). 100MB. */
export const DEFAULT_MULTIPART_THRESHOLD = 100 * 1024 * 1024;

/**
 * Decide whether a PUT of `sizeBytes` should use multipart upload (#745).
 *
 * A single PUT of a large body (model weights, recordings) must be fully
 * re-uploaded on a mid-transfer failure — wasted egress + retry cost. Multipart
 * uploads each part independently so only the failed part is retried. When the
 * size is unknown (streaming body, `undefined`) we cannot decide up front, so we
 * return false and leave it to the client. Pure → unit-testable.
 *
 * @param sizeBytes   known body size, or undefined when not determinable
 * @param thresholdBytes size at/above which multipart is used (default 100MB)
 */
export function shouldUseMultipart(
  sizeBytes: number | undefined,
  thresholdBytes: number = DEFAULT_MULTIPART_THRESHOLD,
): boolean {
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes)) return false;
  return sizeBytes >= thresholdBytes;
}

/**
 * Best-effort byte length of a PutBody when known synchronously (#745).
 * Strings, ArrayBuffers/views and Blobs expose a length/size; streams and
 * Response bodies do not, so they return undefined (caller can't pre-decide
 * multipart). Pure → unit-testable.
 */
export function putBodyByteLength(body: PutBody): number | undefined {
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  return undefined;
}

/**
 * Clamp a presign TTL and apply method-specific bounds (#752, #752).
 *
 * GET/HEAD/DELETE default to 1h; PUT (write) presigns default SHORTER (15 min)
 * because an open-ended write URL is a bigger exposure than a read URL. All
 * methods are clamped to [60s, 24h]. Pure → unit-testable.
 */
export function presignTtlSeconds(method: string, requested: number | undefined): number {
  const MIN_S = 60;
  const MAX_S = 24 * 3600;
  const def = method === 'PUT' ? 15 * 60 : 3600;
  const want = requested ?? def;
  return Math.min(Math.max(MIN_S, want), MAX_S);
}

/**
 * Create an ObjectStore backed by an S3-compatible service.
 *
 * The returned store is stateless beyond the underlying Bun.S3Client, so it
 * is safe to share across requests. Credentials are held only inside the
 * client; nothing is logged.
 */
export function createS3Store(config: S3StoreConfig): ObjectStore {
  const client = new Bun.S3Client({
    bucket: config.bucket,
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region ?? 'auto',
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  });

  // #753: use the broadened, exported detector so all S3-compatibles' 404
  // shapes are handled consistently.
  const isNotFound = isS3NotFound;

  const store: ObjectStore = {
    async put(key: string, body: PutBody, opts?: PutOptions): Promise<void> {
      // #754: layer per-call options over the store's default PUT policy so
      // CDN-served buckets get cache/ACL headers without every caller repeating
      // them.
      const merged = mergePutOptions(config.defaultPut, opts);
      // #745: when the body is large enough (and its size is known up front),
      // hint a multipart upload so a mid-transfer failure only re-uploads the
      // failed part rather than the whole object. Bun.S3Client's write splits
      // into parts when given a `partSize`; smaller/unknown bodies use a single
      // PUT as before.
      const size = putBodyByteLength(body);
      const useMultipart = shouldUseMultipart(size, config.multipartThresholdBytes);
      await client.write(key, body as Parameters<typeof client.write>[1], {
        ...(merged.contentType ? { type: merged.contentType } : {}),
        ...(merged.contentEncoding ? { contentEncoding: merged.contentEncoding } : {}),
        ...(merged.acl ? { acl: merged.acl } : {}),
        ...(merged.cacheControl ? { cacheControl: merged.cacheControl } : {}),
        ...(useMultipart ? { partSize: 16 * 1024 * 1024 } : {}),
      } as Parameters<typeof client.write>[2]);
    },

    async get(key: string): Promise<Uint8Array> {
      // #755: GET is idempotent — retry transient 5xx/throttle.
      return withS3Retry(async () => {
        const buf = await client.file(key).arrayBuffer();
        return new Uint8Array(buf);
      });
    },

    async getRange(key: string, start: number, end?: number): Promise<Uint8Array> {
      // #747: ranged GET. Bun.S3Client exposes `slice(start, end)` on the file
      // handle (end exclusive) and/or accepts a `Range` header; prefer slice
      // when present. `end` here is INCLUSIVE (HTTP Range semantics) so convert
      // to slice's exclusive end.
      return withS3Retry(async () => {
        const file = client.file(key) as unknown as {
          slice?: (s: number, e?: number) => { arrayBuffer(): Promise<ArrayBuffer> };
          arrayBuffer(): Promise<ArrayBuffer>;
        };
        if (typeof file.slice === 'function') {
          const sliced = file.slice(start, end === undefined ? undefined : end + 1);
          return new Uint8Array(await sliced.arrayBuffer());
        }
        // Fallback: full fetch then slice client-side (still correct, less efficient).
        const buf = new Uint8Array(await file.arrayBuffer());
        return buf.subarray(start, end === undefined ? undefined : end + 1);
      });
    },

    getStream(key: string): ReadableStream<Uint8Array> {
      return client.file(key).stream();
    },

    async getStreamChecked(key: string): Promise<ReadableStream<Uint8Array> | null> {
      // #748: `getStream` returns a stream synchronously and only errors when
      // consumed, so a missing key surfaces inconsistently vs `head`/`get`.
      // Pre-`stat` so callers get an explicit null for absence (404) and a
      // thrown error only for real failures (e.g. 403).
      try {
        await withS3Retry(() => client.stat(key));
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      return client.file(key).stream();
    },

    async head(key: string): Promise<ObjectMetadata | null> {
      try {
        // #755: HEAD is idempotent — retry transient 5xx/throttle.
        const stat = await withS3Retry(() => client.stat(key));
        return {
          size: stat.size,
          etag: stat.etag,
          contentType: stat.type,
          lastModified: stat.lastModified,
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    presign(key: string, opts?: PresignOptions): string {
      // Reject path-traversal-shaped keys — caller may pass user-supplied
      // values; without this guard, `presign(req.query.key)` could mint a
      // signed URL for `../bucket-other/secret`.
      if (key.includes('..') || key.startsWith('/')) {
        throw new Error(`presign refuses suspicious key: ${key.slice(0, 80)}`);
      }
      // #752: clamp TTL to [60s, 24h] AND apply a shorter default for PUT
      // (write) presigns — an open-ended upload URL is a bigger exposure than a
      // read URL — so write presigns don't inherit the GET-oriented 1h default.
      const method = opts?.method ?? 'GET';
      const expiresIn = presignTtlSeconds(method, opts?.expiresIn);
      return client.presign(key, { expiresIn, method });
    },

    async delete(key: string): Promise<void> {
      try {
        await client.delete(key);
      } catch (err) {
        // Idempotent: missing object is not an error
        if (isNotFound(err)) return;
        throw err;
      }
    },

    async copy(srcKey: string, dstKey: string): Promise<void> {
      // #751: prefer a native server-side copy when the client exposes one so we
      // never round-trip the bytes through the gateway. Fall back to GET+PUT.
      const c = client as unknown as { copy?: (s: string, d: string) => Promise<unknown> };
      if (typeof c.copy === 'function') {
        await withS3Retry(() => c.copy!(srcKey, dstKey));
        return;
      }
      const bytes = await store.get(srcKey);
      await store.put(dstKey, bytes);
    },

    async deleteMany(keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      // #750: S3 DeleteObjects accepts up to 1000 keys per request. Bun.S3Client
      // exposes a batch `delete(string[])`; fall back to per-key deletes if a
      // particular runtime/version doesn't. Either way, missing keys are
      // ignored (idempotent).
      const CHUNK = 1000;
      const batchDelete = (client as unknown as { delete?: (k: string[]) => Promise<unknown> }).delete;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const chunk = keys.slice(i, i + CHUNK);
        try {
          if (typeof batchDelete === 'function') {
            await batchDelete.call(client, chunk);
          } else {
            await Promise.all(chunk.map((k) => store.delete(k)));
          }
        } catch (err) {
          if (isNotFound(err)) continue;
          throw err;
        }
      }
    },

    async list(prefix?: string, opts?: ListOptions): Promise<ListResult> {
      // #755: LIST is idempotent — retry transient 5xx/throttle.
      const result = await withS3Retry(() => client.list({
        ...(prefix ? { prefix } : {}),
        ...(opts?.limit ? { maxKeys: opts.limit } : {}),
        ...(opts?.continuationToken ? { continuationToken: opts.continuationToken } : {}),
      }));

      const entries = (result.contents ?? []).map(o => ({
        key: o.key,
        size: o.size ?? 0,
        ...(o.eTag ? { etag: o.eTag } : {}),
        ...(o.lastModified ? { lastModified: new Date(o.lastModified) } : {}),
      }));

      return {
        entries,
        ...(result.isTruncated && result.nextContinuationToken
          ? { nextContinuationToken: result.nextContinuationToken }
          : {}),
      };
    },

    listAll(prefix?: string, pageSize = 1000): AsyncIterable<ListEntry> {
      return listAllVia((p, o) => store.list(p, o), prefix, pageSize);
    },
  };

  return store;
}
