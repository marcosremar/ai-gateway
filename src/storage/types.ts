/**
 * ObjectStore — generic interface for binary blob storage.
 *
 * Distinct from `GatewayStorage` (in src/storage.ts), which is the state/settings
 * DI interface. ObjectStore is for files: model weights, recordings, exports, etc.
 *
 * Implementations: S3 (AWS, R2, B2, MinIO, DigitalOcean Spaces — all S3-compat).
 */

export interface ObjectMetadata {
  /** Object size in bytes. */
  size: number;
  /** ETag (often MD5 of contents, but not guaranteed for multipart uploads). */
  etag?: string;
  /** Content-Type header. */
  contentType?: string;
  /** Last modification timestamp. */
  lastModified?: Date;
}

export interface PutOptions {
  /** Content-Type header to store with the object. */
  contentType?: string;
  /** Content-Encoding header (e.g. "gzip"). */
  contentEncoding?: string;
  /** ACL — usually omit (private). Use "public-read" for CDN-served assets. */
  acl?: 'private' | 'public-read';
}

export interface PresignOptions {
  /** Seconds until the URL expires. Default: 3600 (1 hour). */
  expiresIn?: number;
  /** HTTP method allowed for the URL. Default: 'GET'. */
  method?: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
}

export interface ListOptions {
  /** Maximum number of entries to return. */
  limit?: number;
  /** Continue listing from this token (for pagination). */
  continuationToken?: string;
}

export interface ListEntry {
  key: string;
  size: number;
  etag?: string;
  lastModified?: Date;
}

export interface ListResult {
  entries: ListEntry[];
  /** Pagination token if there are more entries. Undefined when complete. */
  nextContinuationToken?: string;
}

/**
 * Body type accepted by `put()`. Mirrors what Bun.S3 accepts so adapters
 * don't have to do extra conversion for the common case.
 */
export type PutBody =
  | string
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | Response
  | ReadableStream<Uint8Array>;

export interface ObjectStore {
  /**
   * Upload data to a key. Overwrites existing object at the same key.
   */
  put(key: string, body: PutBody, opts?: PutOptions): Promise<void>;

  /**
   * Download an object as a Uint8Array. Throws if the object does not exist.
   * For large files (>100MB), prefer `getStream()` to avoid buffering.
   */
  get(key: string): Promise<Uint8Array>;

  /**
   * Download a byte RANGE of an object (#747).
   *
   * Issues a ranged GET (`Range: bytes=start-end`, inclusive end) so callers
   * doing resumable downloads or metadata-only sniffs (e.g. the GGUF magic in
   * the first bytes) transfer only what they need instead of the whole object.
   * `end` is inclusive; omit it to read from `start` to EOF.
   *
   * Optional so lightweight/partial implementations (test fakes) need not
   * provide it; the S3 adapter always does.
   */
  getRange?(key: string, start: number, end?: number): Promise<Uint8Array>;

  /**
   * Stream an object's bytes. Use this for large files (model weights,
   * recordings) to avoid buffering the whole thing in memory.
   */
  getStream(key: string): ReadableStream<Uint8Array>;

  /**
   * Get metadata for an object without fetching its contents.
   * Returns null if the object does not exist (does NOT throw on 404).
   */
  head(key: string): Promise<ObjectMetadata | null>;

  /**
   * Generate a presigned URL for the object.
   *
   * Returned synchronously because S3 presigning is a local HMAC operation
   * (no network round-trip). Adapters that need async signing should expose
   * a separate method.
   */
  presign(key: string, opts?: PresignOptions): string;

  /**
   * Server-side copy an object (#751).
   *
   * Uses S3 `CopyObject` so renaming/duplicating an object stays inside the
   * provider — no GET+PUT round-trip through the gateway (which would pay full
   * egress + ingress). Overwrites any object already at `dstKey`.
   *
   * Optional for the same reason as {@link getRange}; the S3 adapter always
   * provides it.
   */
  copy?(srcKey: string, dstKey: string): Promise<void>;

  /**
   * Delete an object. Idempotent — does not throw if the object is missing.
   */
  delete(key: string): Promise<void>;

  /**
   * Delete many objects in as few requests as possible (#750).
   *
   * S3 supports up to 1000 keys per `DeleteObjects` call, so deleting N keys
   * costs ceil(N/1000) requests instead of N. Idempotent — missing keys are
   * ignored. No-op for an empty array.
   *
   * Optional so lightweight/partial implementations (e.g. test fakes) need not
   * provide it; the S3 adapter always does. Callers should feature-detect or
   * fall back to looping `delete`.
   */
  deleteMany?(keys: string[]): Promise<void>;

  /**
   * List objects under an optional key prefix.
   *
   * Use `prefix` like a directory: `list('models/babelcast/')` returns all
   * objects whose keys begin with that string. Returns up to `opts.limit`
   * entries (default 1000, max 1000 per call). Use `nextContinuationToken`
   * from the result to paginate.
   */
  list(prefix?: string, opts?: ListOptions): Promise<ListResult>;

  /**
   * Auto-paginating async iterator over every object under `prefix` (#749).
   *
   * Yields entries one page at a time, transparently following
   * `nextContinuationToken`, so callers can `for await (... of store.listAll())`
   * without the common bug of processing only the first 1000 keys. Page size is
   * controlled by `pageSize` (default 1000).
   *
   * Optional for the same reason as {@link deleteMany}; the S3 adapter always
   * provides it. Use `listAllVia(store.list, prefix)` from `s3-store` when a
   * store does not implement it directly.
   */
  listAll?(prefix?: string, pageSize?: number): AsyncIterable<ListEntry>;
}
