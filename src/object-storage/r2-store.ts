/**
 * Cloudflare R2 convenience constructor.
 *
 * R2 is S3-compatible, so this is a thin wrapper over `createS3Store` that
 * builds the endpoint URL from your account ID. R2 uses the special region
 * "auto" — the bucket is replicated across Cloudflare's global network and
 * the closest POP serves each request.
 *
 * Get your account ID from the Cloudflare dashboard → R2 Object Storage →
 * "Account details" pane (top right). Access keys are created under
 * "Manage R2 API Tokens".
 *
 * @example
 * import { createR2Store } from '@parle/ai-gateway/object-storage';
 *
 * const r2 = createR2Store({
 *   accountId: process.env.R2_ACCOUNT_ID!,
 *   bucket: 'my-bucket',
 *   accessKeyId: process.env.R2_ACCESS_KEY_ID!,
 *   secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
 * });
 *
 * await r2.put('hello.txt', 'world');
 * const url = r2.presign('hello.txt', { expiresIn: 600 });
 */

import type { ObjectStore } from './types';
import { createS3Store } from './s3-store';

export interface R2StoreConfig {
  /** Cloudflare account ID (32-char hex). */
  accountId: string;
  /** Bucket name. */
  bucket: string;
  /** R2 access key ID (from "Manage R2 API Tokens"). */
  accessKeyId: string;
  /** R2 secret access key. */
  secretAccessKey: string;
  /**
   * Override endpoint. Default: https://<accountId>.r2.cloudflarestorage.com
   * Useful for jurisdiction-specific endpoints (e.g. EU-only):
   *   https://<accountId>.eu.r2.cloudflarestorage.com
   */
  endpoint?: string;
}

export function createR2Store(config: R2StoreConfig): ObjectStore {
  return createS3Store({
    bucket: config.bucket,
    endpoint: config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: 'auto',
  });
}
