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
} from './types';

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

  const isNotFound = (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; statusCode?: number; status?: number; name?: string };
    if (e.statusCode === 404 || e.status === 404) return true;
    if (e.code === 'NotFound' || e.code === 'NoSuchKey') return true;
    if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
    return false;
  };

  return {
    async put(key: string, body: PutBody, opts?: PutOptions): Promise<void> {
      await client.write(key, body as Parameters<typeof client.write>[1], {
        ...(opts?.contentType ? { type: opts.contentType } : {}),
        ...(opts?.contentEncoding ? { contentEncoding: opts.contentEncoding } : {}),
        ...(opts?.acl ? { acl: opts.acl } : {}),
      });
    },

    async get(key: string): Promise<Uint8Array> {
      const buf = await client.file(key).arrayBuffer();
      return new Uint8Array(buf);
    },

    getStream(key: string): ReadableStream<Uint8Array> {
      return client.file(key).stream();
    },

    async head(key: string): Promise<ObjectMetadata | null> {
      try {
        const stat = await client.stat(key);
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
      return client.presign(key, {
        expiresIn: opts?.expiresIn ?? 3600,
        method: opts?.method ?? 'GET',
      });
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

    async list(prefix?: string, opts?: ListOptions): Promise<ListResult> {
      const result = await client.list({
        ...(prefix ? { prefix } : {}),
        ...(opts?.limit ? { maxKeys: opts.limit } : {}),
        ...(opts?.continuationToken ? { continuationToken: opts.continuationToken } : {}),
      });

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
  };
}
